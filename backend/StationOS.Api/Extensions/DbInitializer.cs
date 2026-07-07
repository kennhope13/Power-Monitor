using Microsoft.EntityFrameworkCore;
using StationOS.Data;
using StationOS.Services.Auth;
using StationOS.Services.Devices;
using StationOS.Services;

namespace StationOS.Api.Extensions;

public static class DbInitializer
{
    /// <summary>Khởi tạo cơ sở dữ liệu khi ứng dụng khởi động: tạo extension TimescaleDB, chạy migration, chuyển SensorReadings thành hypertable, seed admin và trạm mặc định, đồng bộ camera lên go2rtc.</summary>
    /// <param name="app">WebApplication instance để lấy service provider.</param>
    public static async Task InitializeDatabaseAsync(this WebApplication app)
    {
        using var scope = app.Services.CreateScope();
        var services = scope.ServiceProvider;
        var db = services.GetRequiredService<AppDbContext>();

        // Chờ PostgreSQL khởi động xong và Migration thành công (retry tối đa 30 giây — PG portable trên Windows cần thời gian)
        for (int i = 0; i < 30; i++)
        {
            try
            {
                // Kiểm tra xem database cũ (tạo bằng EnsureCreated) đã tồn tại chưa nhưng thiếu bảng lịch sử Migration
                var conn = db.Database.GetDbConnection();
                if (conn.State != System.Data.ConnectionState.Open) conn.Open();
                
                using var checkCmd = conn.CreateCommand();
                checkCmd.CommandText = "SELECT 1 FROM information_schema.tables WHERE table_name = 'AiModelVersions'";
                var tableExists = checkCmd.ExecuteScalar() != null;
                
                checkCmd.CommandText = "SELECT 1 FROM information_schema.tables WHERE table_name = '__EFMigrationsHistory'";
                var historyExists = checkCmd.ExecuteScalar() != null;
                
                if (tableExists && !historyExists)
                {
                    Console.WriteLine("[Startup] Phát hiện Database cũ (tạo bằng EnsureCreated). Khởi tạo lịch sử Migration để tránh xung đột...");
                    using var insertCmd = conn.CreateCommand();
                    insertCmd.CommandText = @"
                        CREATE TABLE IF NOT EXISTS ""__EFMigrationsHistory"" (
                            ""MigrationId"" character varying(150) NOT NULL,
                            ""ProductVersion"" character varying(32) NOT NULL,
                            CONSTRAINT ""PK___EFMigrationsHistory"" PRIMARY KEY (""MigrationId"")
                        );
                        INSERT INTO ""__EFMigrationsHistory"" (""MigrationId"", ""ProductVersion"")
                        VALUES 
                        ('20260402153855_InitialCreate', '8.0.0'),
                        ('20260405043130_AddMaintenanceTask', '8.0.0'),
                        ('20260408104000_AddViewRotationToSldFile', '8.0.0'),
                        ('20260415000000_AddRuleSetField', '8.0.0'),
                        ('20260416171424_AddMediaToAlerts', '8.0.0'),
                        ('20260507034433_AddLicense', '8.0.0'),
                        ('20260518000000_AddDeviceCapabilities', '8.0.0'),
                        ('20260518113459_AddSensorReadingIndexes', '8.0.0'),
                        ('20260524100920_AddBoundary', '8.0.0'),
                        ('20260526154303_AddUserMustChangePassword', '8.0.0'),
                        ('20260527024248_AddRoiPoints', '8.0.0'),
                        ('20260527024627_RenameRoiPointColumns', '8.0.0'),
                        ('20260527030342_RevertToTxTy', '8.0.0'),
                        ('20260530100337_AddDetectionEventNewColumns', '8.0.0'),
                        ('20260605041729_AddAlertPointId', '8.0.0'),
                        ('20260703072551_AddPermissionsToUser', '8.0.0')
                        ON CONFLICT DO NOTHING;
                    ";
                    insertCmd.ExecuteNonQuery();
                    Console.WriteLine("[Startup] Đã chèn lịch sử Migration thành công.");
                }

                // Đảm bảo database tồn tại trước khi migrate (đã được tạo bởi main.cjs, Migrate sẽ tự chạy script)
                db.Database.Migrate();
                break; // Thành công thì thoát vòng lặp
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Startup] Lỗi kết nối / Migrate DB. Đợi Database sẵn sàng... ({i + 1}/30): {ex.Message}");
                if (i == 29) throw; // Lần cuối cùng thì ném lỗi ra
                await Task.Delay(1000);
            }
        }

        // Force UTF8 client encoding (phòng khi Windows PG dùng WIN1252 mặc định)
        try
        {
            await db.Database.ExecuteSqlRawAsync(@"SET client_encoding = 'UTF8';");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Startup] Không thể set client_encoding: {ex.Message}");
        }

        // 1. Tạo extension TimescaleDB (cần thiết cho hypertable) - CHẠY SAU KHI ĐÃ CÓ DATABASE
        try
        {
            await db.Database.ExecuteSqlRawAsync(@"CREATE EXTENSION IF NOT EXISTS timescaledb;");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Startup] TimescaleDB extension không khả dụng: {ex.Message}");
        }

        // 3. Biến SensorReadings thành hypertable (sau khi table đã được tạo)
        try
        {
            await db.Database.ExecuteSqlRawAsync(
                @"SELECT create_hypertable('""SensorReadings""', 'Time', if_not_exists => TRUE, migrate_data => TRUE);");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Startup] Không convert SensorReadings sang hypertable (OK nếu không phải TimescaleDB): {ex.Message}");
        }

        // Đảm bảo các cột được thêm vào kể cả khi migration đã bị đánh dấu "applied" mà DDL chưa chạy
        await db.Database.ExecuteSqlRawAsync(@"ALTER TABLE ""Rules"" ADD COLUMN IF NOT EXISTS ""RuleSet"" text;");

        // Reset SyncQueue items bị lỗi để gửi lại lên trạm tổng khi restart
        await db.Database.ExecuteSqlRawAsync(@"UPDATE ""SyncQueues"" SET ""Status"" = 'pending', ""RetryCount"" = 0 WHERE ""Status"" = 'failed'");

        // Reset Report/MaintenanceTask/AuditLog đã ghi ""sent"" nhưng ingest endpoint có thể đã thay đổi
        await db.Database.ExecuteSqlRawAsync(@"UPDATE ""SyncQueues"" SET ""Status"" = 'pending', ""RetryCount"" = 0 WHERE ""Status"" = 'sent' AND ""EntityType"" IN ('Report', 'MaintenanceTask', 'AuditLog')");

        // Backfill MaintenanceTasks và Reports chưa có trong SyncQueue
        await BackfillSyncQueueAsync(db);

        await SeedDefaultStationAsync(db);
        await MigrateS7DevicesAsync(db);
        await SeedDefaultSldAsync(db);


        var authService = services.GetRequiredService<AuthService>();
        await authService.SeedAdminIfNotExistsAsync();   // Chỉ giữ admin user — không seed thêm data nào
        // Tắt tính năng tự động tạo Rule mặc định
        // await SeedNetaRulesAsync(db);
        // await SeedTemperatureRulesAsync(db);
        // await SeedThermalPointsRulesAsync(db);

        try
        {
            var licenseService = services.GetRequiredService<LicenseService>();
            await licenseService.GetStatusAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Startup] Không thể warm-up license cache: {ex.Message}");
        }
        

        // Sync tất cả camera trong DB lên go2rtc (phòng khi go2rtc restart)
        try
        {
            var deviceService = services.GetRequiredService<DeviceService>();
            var cameras = await db.Devices.Where(d => d.Type.StartsWith("camera")).ToListAsync();
            await deviceService.SyncAllCamerasToGo2RtcAsync(cameras);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Startup] Lỗi đồng bộ camera lên go2rtc: {ex.Message}");
        }
    }

    // ── Seed rules NETA MTS 2023 ────────────────────────────
    private static async Task SeedNetaRulesAsync(AppDbContext db)
    {
        if (await db.Rules.AnyAsync(r => r.Name.StartsWith("NETA"))) return;

        var station = await db.Stations.FirstOrDefaultAsync();
        if (station == null) return;

        db.Rules.AddRange(
            new StationOS.Data.Entities.Rule
            {
                StationId = station.Id,
                Name      = "NETA Monitor — Phóng điện",
                RuleSet   = "Tủ 471",
                Condition = """{"point":"phong_dien","op":">","value":-37}""",
                Actions   = """[{"type":"health","penalty":5},{"type":"maintenance","taskType":"inspection","scheduledInDays":180}]""",
                Enabled   = true,
            },
            new StationOS.Data.Entities.Rule
            {
                StationId = station.Id,
                Name      = "NETA Warning — Phóng điện",
                RuleSet   = "Tủ 471",
                Condition = """{"point":"phong_dien","op":">","value":-27}""",
                Actions   = """[{"type":"health","penalty":15},{"type":"maintenance","taskType":"repair","scheduledInDays":45}]""",
                Enabled   = true,
            },
            new StationOS.Data.Entities.Rule
            {
                StationId = station.Id,
                Name      = "NETA Critical — Phóng điện",
                RuleSet   = "Tủ 471",
                Condition = """{"point":"phong_dien","op":">","value":-20}""",
                Actions   = """[{"type":"health","penalty":30},{"type":"maintenance","taskType":"repair","scheduledInDays":3}]""",
                Enabled   = true,
            },
            new StationOS.Data.Entities.Rule
            {
                StationId = station.Id,
                Name      = "NETA Monitor — Phóng điện 2",
                RuleSet   = "Tủ 471",
                Condition = """{"point":"phong_dien_2","op":">","value":-37}""",
                Actions   = """[{"type":"health","penalty":5},{"type":"maintenance","taskType":"inspection","scheduledInDays":180}]""",
                Enabled   = true,
            },
            new StationOS.Data.Entities.Rule
            {
                StationId = station.Id,
                Name      = "NETA Warning — Phóng điện 2",
                RuleSet   = "Tủ 471",
                Condition = """{"point":"phong_dien_2","op":">","value":-27}""",
                Actions   = """[{"type":"health","penalty":15},{"type":"maintenance","taskType":"repair","scheduledInDays":45}]""",
                Enabled   = true,
            },
            new StationOS.Data.Entities.Rule
            {
                StationId = station.Id,
                Name      = "NETA Critical — Phóng điện 2",
                RuleSet   = "Tủ 471",
                Condition = """{"point":"phong_dien_2","op":">","value":-20}""",
                Actions   = """[{"type":"health","penalty":30},{"type":"maintenance","taskType":"repair","scheduledInDays":3}]""",
                Enabled   = true,
            }
        );
        await db.SaveChangesAsync();
    }

    // ── Seed trạm + thiết bị thật ────────────────────────────
    private static async Task SeedDefaultStationAsync(AppDbContext db)
    {
        // 1. Nếu có trạm cũ TBA-001 (từ bản backup), thực hiện đổi tên thành Trạm Mặc Định
        var oldStation = await db.Stations.FirstOrDefaultAsync(s => s.Code == "TBA-001");
        if (oldStation != null)
        {
            oldStation.Name = "Trạm Mặc Định";
            oldStation.Code = "TBA-DEFAULT";
            oldStation.Location = """{"lat": 21.0285, "lng": 105.8542, "address": "Hà Nội, Việt Nam"}""";
            await db.SaveChangesAsync();
            Console.WriteLine("[DbInitializer] Đã chuyển đổi trạm TBA-001 thành TBA-DEFAULT");
        }

        // 2. Nếu không có trạm nào trong DB, tạo một trạm trống mặc định
        if (!await db.Stations.AnyAsync())
        {
            var defaultStation = new StationOS.Data.Entities.Station
            {
                Name = "Trạm Mặc Định",
                Code = "TBA-DEFAULT",
                Location = """{"lat": 21.0285, "lng": 105.8542, "address": "Hà Nội, Việt Nam"}""",
                Status = "active"
            };
            db.Stations.Add(defaultStation);
            await db.SaveChangesAsync();
        }
    }

    // ── Seed rules nhiệt độ 3 pha ────────────────────────────────
    private static async Task SeedTemperatureRulesAsync(AppDbContext db)
    {
        if (await db.Rules.AnyAsync(r => r.Name.StartsWith("Nhiệt độ"))) return;

        var station = await db.Stations.FirstOrDefaultAsync();
        if (station == null) return;

        var phases = new[]
        {
            ("nhiet_do_pha_1", "Pha 1"),
            ("nhiet_do_pha_2", "Pha 2"),
            ("nhiet_do_pha_3", "Pha 3"),
            ("nhiet_do_pha_2_1", "Pha 1 (Bộ 2)"),
            ("nhiet_do_pha_2_2", "Pha 2 (Bộ 2)"),
            ("nhiet_do_pha_2_3", "Pha 3 (Bộ 2)"),
        };

        foreach (var (pointId, label) in phases)
        {
            // Warning ≥50°C: kiểm tra, lên lịch bảo trì 30 ngày
            db.Rules.Add(new StationOS.Data.Entities.Rule
            {
                StationId = station.Id,
                Name      = $"Nhiệt độ {label} — Kiểm tra (≥50°C)",
                RuleSet   = "Tủ 471",
                Condition = System.Text.Json.JsonSerializer.Serialize(
                    new { point = pointId, op = ">=", value = 50, clearValue = 47 }),
                Actions   = """[{"type":"alert","level":"warning"},{"type":"maintenance","taskType":"inspection","scheduledInDays":30}]""",
                Enabled   = true,
            });

            // Alarm ≥65°C: nguy hiểm, sửa trong 3 ngày
            db.Rules.Add(new StationOS.Data.Entities.Rule
            {
                StationId = station.Id,
                Name      = $"Nhiệt độ {label} — Nguy hiểm (≥65°C)",
                RuleSet   = "Tủ 471",
                Condition = System.Text.Json.JsonSerializer.Serialize(
                    new { point = pointId, op = ">=", value = 65, clearValue = 62 }),
                Actions   = """[{"type":"alert","level":"alarm"},{"type":"maintenance","taskType":"repair","scheduledInDays":3}]""",
                Enabled   = true,
            });
        }
        await db.SaveChangesAsync();
        Console.WriteLine("[Startup] Đã seed 6 rules nhiệt độ 3 pha (50°C warning, 65°C alarm)");
    }

    // ── Fix go2rtc_id sai cho Camera 153 (chạy 1 lần) ──────────
    private static async Task FixCamera153Go2rtcIdAsync(AppDbContext db)
    {
        var allPdCams = await db.Devices
            .Where(d => d.Type == "camera_pd")
            .ToListAsync();

        var cams = allPdCams
            .Where(d => d.Config != null && d.Config.Contains("hikvision_main"))
            .ToList();

        foreach (var cam in cams)
        {
            try
            {
                var cfg = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, object>>(cam.Config!)!;
                cfg["go2rtc_id"] = "camera_153_pd";
                cam.Config = System.Text.Json.JsonSerializer.Serialize(cfg);
                Console.WriteLine($"[Startup] Fixed {cam.Name}: go2rtc_id hikvision_main → camera_153_pd");
            }
            catch { }
        }

        if (cams.Count > 0)
            await db.SaveChangesAsync();
    }

    // ── Đổi tên PLC thành "Tủ 471" (chạy 1 lần) ────────────────
    private static async Task FixPlcNameAsync(AppDbContext db)
    {
        var oldNames = new[] { "PLC S7-1200 – Cảm biến nhiệt & PD", "PLC S7-1200 — Tủ 471" };
        var plc = await db.Devices
            .FirstOrDefaultAsync(d => d.Type == "plc_s7" && oldNames.Contains(d.Name));
        if (plc == null) return;

        plc.Name = "Tủ 471";
        await db.SaveChangesAsync();
        Console.WriteLine($"[Startup] Đã đổi tên PLC → \"Tủ 471\"");
    }

    private static async Task FixUngroupedRulesAsync(AppDbContext db)
    {
        var oldNames = new[] { (string?)null, "Tủ 471 — CBM", "Tủ 471 - CBM", "Tu 471" };
        var toFix = await db.Rules.Where(r => oldNames.Contains(r.RuleSet)).ToListAsync();
        if (toFix.Count == 0) return;

        foreach (var r in toFix) r.RuleSet = "Tủ 471";
        await db.SaveChangesAsync();
        Console.WriteLine($"[Startup] Normalized RuleSet cho {toFix.Count} rule → \"Tủ 471\"");
    }

    // ── Seed 20 rules nhiệt độ cho Camera 152 (P1 -> P20) ─────
    private static async Task SeedThermalPointsRulesAsync(AppDbContext db)
    {
        if (await db.Rules.AnyAsync(r => r.RuleSet == "Các điểm đo của cam nhiệt")) return;

        var station = await db.Stations.FirstOrDefaultAsync();
        if (station == null) return;

        var thermalCam = await db.Devices.FirstOrDefaultAsync(d => d.Type == "camera_dual");

        for (int i = 1; i <= 20; i++)
        {
            db.Rules.Add(new StationOS.Data.Entities.Rule
            {
                StationId = station.Id,
                DeviceId  = thermalCam?.Id,
                Name      = $"Cảnh báo điểm P{i}",
                RuleSet   = "Các điểm đo của cam nhiệt",
                Condition = System.Text.Json.JsonSerializer.Serialize(new { 
                    point = $"P{i}", 
                    op = ">=", 
                    pre_alarm = 50, 
                    alarm = 70,
                    type = "analog"
                }),
                Actions   = """[{"type":"alert","level":"hybrid"}]""",
                Enabled   = true,
            });
        }
        await db.SaveChangesAsync();
        Console.WriteLine("[Startup] Đã seed 20 rules nhiệt độ camera (P1-P20)");
    }

    private static async Task BackfillSyncQueueAsync(AppDbContext db)
    {
        var syncedList = await db.SyncQueues
            .Where(q => q.EntityType == "MaintenanceTask" || q.EntityType == "Report")
            .Select(q => q.EntityId)
            .ToListAsync();
        var syncedIds = syncedList.ToHashSet();

        var maintenanceTasks = await db.MaintenanceTasks
            .Where(t => !syncedIds.Contains(t.Id))
            .ToListAsync();

        foreach (var t in maintenanceTasks)
        {
            db.SyncQueues.Add(new StationOS.Data.Entities.SyncQueue
            {
                EntityType = "MaintenanceTask",
                EntityId   = t.Id,
                Payload    = System.Text.Json.JsonSerializer.Serialize(new {
                    t.Id, t.StationId, t.DeviceId, t.Title, t.Type,
                    t.ScheduledDate, t.AssignedTo, t.Notes, t.Status,
                    t.CreatedAt, t.CompletedAt,
                }),
            });
        }

        var reports = await db.Reports
            .Where(r => !syncedIds.Contains(r.Id))
            .ToListAsync();

        foreach (var r in reports)
        {
            db.SyncQueues.Add(new StationOS.Data.Entities.SyncQueue
            {
                EntityType = "Report",
                EntityId   = r.Id,
                Payload    = System.Text.Json.JsonSerializer.Serialize(new {
                    r.Id, r.StationId, r.Type, r.PeriodFrom, r.PeriodTo,
                    r.FileUrl, r.GeneratedBy, r.GeneratedAt,
                }),
            });
        }

        int total = maintenanceTasks.Count + reports.Count;
        if (total > 0)
        {
            await db.SaveChangesAsync();
            Console.WriteLine($"[Startup] Backfill SyncQueue: {maintenanceTasks.Count} maintenance tasks, {reports.Count} reports");
        }
    }

    private static async Task MigrateS7DevicesAsync(AppDbContext db)
    {
        // 1. Rename legacy names for "Tủ 471" and update config offsets
        var legacyNames1 = new[] { 
            "Tủ 471 - Bộ 1", 
            "PLC S7-1200 – Cảm biến nhiệt và PD", 
            "PLC S7-1200 – Cảm biến nhiệt & PD", 
            "PLC S7-1200 — Tủ 471" 
        };
        var plc1 = await db.Devices.FirstOrDefaultAsync(d => d.Type == "plc_s7" && (d.Name == "Tủ 471" || legacyNames1.Contains(d.Name)));
        if (plc1 != null)
        {
            plc1.Name = "Tủ 471";
            plc1.Config = """{"ip":"192.168.10.100","rack":0,"slot":1,"db":32,"offset":0,"length":28,"t1_offset":0,"t2_offset":2,"t3_offset":4,"pd_offset":14,"eppc_offset":12,"indi_offset":18,"enableHealthScore":true}""";
            await db.SaveChangesAsync();
            Console.WriteLine("[Migrate] Đã cập nhật/đồng bộ Tủ 471");
        }

        // 2. Rename legacy names for "Tủ 473" and update config offsets
        var legacyNames2 = new[] { "Tủ 471 - Bộ 2", "Tủ 473" };
        var plc2 = await db.Devices.FirstOrDefaultAsync(d => d.Type == "plc_s7" && legacyNames2.Contains(d.Name));
        if (plc2 != null)
        {
            plc2.Name = "Tủ 473";
            plc2.Config = """{"ip":"192.168.10.100","rack":0,"slot":1,"db":32,"offset":0,"length":28,"t1_offset":6,"t2_offset":8,"t3_offset":10,"pd_offset":22,"eppc_offset":20,"indi_offset":26,"enableHealthScore":true}""";
            await db.SaveChangesAsync();
            Console.WriteLine("[Migrate] Đã cập nhật/đồng bộ Tủ 473");
        }

        // 3. Ensure both devices exist in the DB and are configured correctly
        var finalPlc1 = await db.Devices.FirstOrDefaultAsync(d => d.Type == "plc_s7" && d.Name == "Tủ 471");
        if (finalPlc1 != null)
        {
            finalPlc1.Config = """{"ip":"192.168.10.100","rack":0,"slot":1,"db":32,"offset":0,"length":28,"t1_offset":0,"t2_offset":2,"t3_offset":4,"pd_offset":14,"eppc_offset":12,"indi_offset":18,"enableHealthScore":true}""";
            await db.SaveChangesAsync();
        }

        var finalPlc2 = await db.Devices.FirstOrDefaultAsync(d => d.Type == "plc_s7" && d.Name == "Tủ 473");
        if (finalPlc2 == null && finalPlc1 != null)
        {
            finalPlc2 = new StationOS.Data.Entities.Device
            {
                StationId = finalPlc1.StationId,
                Name = "Tủ 473",
                Type = "plc_s7",
                Protocol = "snap7",
                Config = """{"ip":"192.168.10.100","rack":0,"slot":1,"db":32,"offset":0,"length":28,"t1_offset":6,"t2_offset":8,"t3_offset":10,"pd_offset":22,"eppc_offset":20,"indi_offset":26,"enableHealthScore":true}""",
                Status = "online"
            };
            db.Devices.Add(finalPlc2);
            await db.SaveChangesAsync();
            Console.WriteLine("[Migrate] Đã khởi tạo Tủ 473 trong DB");
        }
        else if (finalPlc2 != null)
        {
            finalPlc2.Config = """{"ip":"192.168.10.100","rack":0,"slot":1,"db":32,"offset":0,"length":28,"t1_offset":6,"t2_offset":8,"t3_offset":10,"pd_offset":22,"eppc_offset":20,"indi_offset":26,"enableHealthScore":true}""";
            await db.SaveChangesAsync();
        }

        // 3b. Cập nhật config cho devices đã tồn tại (thêm eppc_offset, indi_offset, tăng length)
        var existingPlcs = await db.Devices.Where(d => d.Type == "plc_s7").ToListAsync();
        foreach (var dev in existingPlcs)
        {
            if (dev.Name.IndexOf("471", StringComparison.Ordinal) >= 0)
                dev.Config = """{"ip":"192.168.10.100","rack":0,"slot":1,"db":32,"offset":0,"length":28,"t1_offset":0,"t2_offset":2,"t3_offset":4,"pd_offset":14,"eppc_offset":12,"indi_offset":18,"enableHealthScore":true}""";
            else if (dev.Name.IndexOf("473", StringComparison.Ordinal) >= 0)
                dev.Config = """{"ip":"192.168.10.100","rack":0,"slot":1,"db":32,"offset":0,"length":28,"t1_offset":6,"t2_offset":8,"t3_offset":10,"pd_offset":22,"eppc_offset":20,"indi_offset":26,"enableHealthScore":true}""";
        }
        await db.SaveChangesAsync();

        // 4. Migrate existing S7 rules to use correct RuleSets and generic point IDs
        // Query devices SAU khi đã rename xong ở trên
        var allPlcDevs = await db.Devices.Where(d => d.Type == "plc_s7").ToListAsync();
        var plcDev1 = allPlcDevs.FirstOrDefault(d => d.Name.IndexOf("471", StringComparison.Ordinal) >= 0);
        var plcDev2 = allPlcDevs.FirstOrDefault(d => d.Name.IndexOf("473", StringComparison.Ordinal) >= 0);
        Console.WriteLine($"[Migrate] plcDev1='{plcDev1?.Name}' ({plcDev1?.Id}), plcDev2='{plcDev2?.Name}' ({plcDev2?.Id})");

        var rules = await db.Rules.ToListAsync();

        foreach (var rule in rules)
        {
            if (rule.RuleSet == "Tủ 471 - Bộ 1")
            {
                rule.RuleSet = "Tủ 471";
            }
            else if (rule.RuleSet == "Tủ 471 - Bộ 2")
            {
                rule.RuleSet = "Tủ 473";
            }

            // Đổi tên hiển thị "(Bộ 2)" → "Tủ 473"
            if (rule.Name != null && rule.Name.Contains("Bộ 2"))
                rule.Name = rule.Name.Replace("Bộ 2", "Tủ 473");

            // Identify rules targeting Tủ 473 (Bộ 2) by checking points or name
            if (rule.Condition != null && (
                rule.Condition.Contains("nhiet_do_pha_2_1") ||
                rule.Condition.Contains("nhiet_do_pha_2_2") ||
                rule.Condition.Contains("nhiet_do_pha_2_3") ||
                rule.Condition.Contains("phong_dien_2") ||
                rule.Condition.Contains("bo2") ||
                (rule.Name != null && rule.Name.Contains("Tủ 473"))
            ))
            {
                rule.RuleSet = "Tủ 473";
                rule.Condition = rule.Condition
                    .Replace("nhiet_do_pha_2_1", "nhiet_do_pha_1")
                    .Replace("nhiet_do_pha_2_2", "nhiet_do_pha_2")
                    .Replace("nhiet_do_pha_2_3", "nhiet_do_pha_3")
                    .Replace("phong_dien_2", "phong_dien")
                    .Replace("nhiet_do_pha_1_bo2", "nhiet_do_pha_1")
                    .Replace("nhiet_do_pha_2_bo2", "nhiet_do_pha_2")
                    .Replace("nhiet_do_pha_3_bo2", "nhiet_do_pha_3")
                    .Replace("phong_dien_bo2", "phong_dien");
            }
            else if (rule.RuleSet == "Tủ 471" || (rule.Condition != null && (
                rule.Condition.Contains("bo1") || 
                (rule.Name != null && rule.Name.Contains("Bộ 1"))
            )))
            {
                rule.RuleSet = "Tủ 471";
                if (rule.Condition != null)
                {
                    rule.Condition = rule.Condition
                        .Replace("nhiet_do_pha_1_bo1", "nhiet_do_pha_1")
                        .Replace("nhiet_do_pha_2_bo1", "nhiet_do_pha_2")
                        .Replace("nhiet_do_pha_3_bo1", "nhiet_do_pha_3")
                        .Replace("phong_dien_bo1", "phong_dien");
                }
            }

            // Gán/sửa DeviceId theo RuleSet (kể cả khi đang trỏ sai thiết bị)
            if (rule.RuleSet == "Tủ 473" && plcDev2 != null && rule.DeviceId != plcDev2.Id)
            {
                rule.DeviceId = plcDev2.Id;
                Console.WriteLine($"[Migrate] Rule '{rule.Name}' → DeviceId Tủ 473 ({plcDev2.Id})");
            }
            else if (rule.RuleSet == "Tủ 471" && plcDev1 != null && rule.DeviceId != plcDev1.Id)
            {
                rule.DeviceId = plcDev1.Id;
                Console.WriteLine($"[Migrate] Rule '{rule.Name}' → DeviceId Tủ 471 ({plcDev1.Id})");
            }
        }
        await db.SaveChangesAsync();
        Console.WriteLine($"[Migrate] Hoàn tất migrate rules. plcDev1={plcDev1?.Id} plcDev2={plcDev2?.Id}");
    }

    private static async Task SeedDefaultSldAsync(AppDbContext db)
    {
        // Find the station (TBA-LA01 or TBA-TA01 or any station)
        var station = await db.Stations.FirstOrDefaultAsync(s => s.Code == "TBA-LA01" || s.Code == "TBA-TA01") 
                      ?? await db.Stations.FirstOrDefaultAsync();
        
        if (station == null)
        {
            Console.WriteLine("[SeedSLD] Không tìm thấy trạm nào để seed SLD");
            return;
        }

        // Check if active SldFile already exists
        var activeSld = await db.SldFiles.FirstOrDefaultAsync(f => f.StationId == station.Id && f.IsActive);
        if (activeSld == null)
        {
            activeSld = new StationOS.Data.Entities.SldFile
            {
                Id = Guid.Parse("12f06284-49c5-439f-8d9d-b085e22be720"),
                StationId = station.Id,
                Version = 1,
                SvgUrl = "/sld/7497ff6f-28c2-47a5-ba28-6b15f8a84c9c.svg",
                IsActive = true,
                UploadedAt = DateTime.UtcNow
            };
            db.SldFiles.Add(activeSld);
            await db.SaveChangesAsync();
            Console.WriteLine($"[SeedSLD] Đã khởi tạo SldFile mẫu cho trạm {station.Name}");
        }

        // Find devices
        var devices = await db.Devices.Where(d => d.StationId == station.Id).ToListAsync();
        var plc1 = devices.FirstOrDefault(d => d.Type == "plc_s7" && d.Name == "Tủ 471");
        var plc2 = devices.FirstOrDefault(d => d.Type == "plc_s7" && d.Name == "Tủ 473");
        var camNormal = devices.FirstOrDefault(d => d.Type == "camera_dual" && d.Name.Contains("Ngoài trời"));
        var camPd = devices.FirstOrDefault(d => d.Type == "camera_pd");
        
        // Fallbacks
        if (plc1 == null) plc1 = devices.FirstOrDefault(d => d.Type == "plc_s7" && d.Name.Contains("471"));
        if (plc2 == null) plc2 = devices.FirstOrDefault(d => d.Type == "plc_s7" && d.Name.Contains("473"));
        if (camNormal == null) camNormal = devices.FirstOrDefault(d => d.Type == "camera_dual");
        if (camPd == null) camPd = devices.FirstOrDefault(d => d.Type == "camera_pd");

        var existingPoints = await db.SldPoints.Where(p => p.SldFileId == activeSld.Id).ToListAsync();

        // Seed 1 point per PLC — tooltip sẽ hiển thị tất cả sensor khi hover
        if (plc1 != null)
        {
            AddPointIfNotExist(db, existingPoints, activeSld.Id, plc1.Id, plc1.Id.ToString(), plc1.Name, 549.0, 300.0, 1.0);
        }

        if (plc2 != null)
        {
            AddPointIfNotExist(db, existingPoints, activeSld.Id, plc2.Id, plc2.Id.ToString(), plc2.Name, 589.0, 300.0, 1.0);
        }

        await db.SaveChangesAsync();
    }

    private static void AddPointIfNotExist(
        AppDbContext db,
        List<StationOS.Data.Entities.SldPoint> existingPoints,
        Guid sldFileId,
        Guid deviceId,
        string pointId,
        string label,
        double x,
        double y,
        double r)
    {
        var exists = existingPoints.Any(p => 
            p.DeviceId == deviceId && 
            p.PointId.ToLower() == pointId.ToLower());

        if (!exists)
        {
            var p = new StationOS.Data.Entities.SldPoint
            {
                Id = Guid.NewGuid(),
                SldFileId = sldFileId,
                DeviceId = deviceId,
                PointId = pointId,
                Label = label,
                X = x,
                Y = y,
                R = r
            };
            db.SldPoints.Add(p);
            Console.WriteLine($"[SeedSLD] Đã thêm điểm: {pointId} cho thiết bị {deviceId}");
        }
    }
}
