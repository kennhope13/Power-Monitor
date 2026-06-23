using Microsoft.EntityFrameworkCore;
using StationOS.Data;
using StationOS.Services.Auth;
using StationOS.Services.Devices;

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

        // 1. Tạo extension TimescaleDB TRƯỚC khi migrate (cần thiết cho hypertable)
        try
        {
            await db.Database.ExecuteSqlRawAsync(@"CREATE EXTENSION IF NOT EXISTS timescaledb;");
        }
        catch (Exception ex)
        {
            // SQLite hoặc Postgres không có TimescaleDB → bỏ qua, dùng bảng thường
            Console.WriteLine($"[Startup] TimescaleDB extension không khả dụng (OK nếu là SQLite): {ex.Message}");
        }

        // 2. Chạy migration tạo schema
        db.Database.Migrate();

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

        var authService = services.GetRequiredService<AuthService>();
        await authService.SeedAdminIfNotExistsAsync();   // Chỉ giữ admin user — không seed thêm data nào
        // Tắt tính năng tự động tạo Rule mặc định
        // await SeedNetaRulesAsync(db);
        // await SeedTemperatureRulesAsync(db);
        // await SeedThermalPointsRulesAsync(db);
        

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
            }
        );
        await db.SaveChangesAsync();
    }

    // ── Seed trạm + thiết bị thật ────────────────────────────
    private static async Task SeedDefaultStationAsync(AppDbContext db)
    {
        // 1. Nếu có trạm cũ TBA-001 (từ bản backup), thực hiện đổi tên thành Trạm 110kV Long An
        var oldStation = await db.Stations.FirstOrDefaultAsync(s => s.Code == "TBA-001");
        if (oldStation != null)
        {
            oldStation.Name = "Trạm 110kV Long An";
            oldStation.Code = "TBA-LA01";
            oldStation.Location = """{"lat": 10.53, "lng": 106.41, "address": "Bến Lức, Long An"}""";
            await db.SaveChangesAsync();
            Console.WriteLine("[DbInitializer] Đã chuyển đổi trạm TBA-001 thành TBA-LA01 (Trạm 110kV Long An)");
        }

        // 2. Nếu không có trạm nào trong DB, seed đầy đủ từ đầu
        if (!await db.Stations.AnyAsync())
        {
            // 1. Trạm Long An (Có thiết bị kết nối)
            var laStation = new StationOS.Data.Entities.Station
            {
                Name = "Trạm 110kV Long An",
                Code = "TBA-LA01",
                Location = """{"lat": 10.53, "lng": 106.41, "address": "Bến Lức, Long An"}""",
                Status = "active"
            };
            db.Stations.Add(laStation);
            await db.SaveChangesAsync();

            // Thiết bị cho trạm Long An
            var plc = new StationOS.Data.Entities.Device
            {
                StationId = laStation.Id,
                Name = "Tủ 471",
                Type = "plc_s7",
                Protocol = "snap7",
                Config = """{"ip":"192.168.10.100","rack":0,"slot":1,"db":32,"offset":0,"length":10,"enableHealthScore":true}""",
                Status = "online"
            };
            var camDual = new StationOS.Data.Entities.Device
            {
                StationId = laStation.Id,
                Name = "HIKVISION – Dual Thermal & Optical",
                Type = "camera_dual",
                Protocol = "isapi",
                Config = """{"ip":"192.168.10.152","username":"admin","password":"Demo@2024","rtsp_optical":"/Streaming/Channels/101","go2rtc_optical":"cam_192_168_10_152_optical","rtsp_thermal":"/Streaming/Channels/201","go2rtc_thermal":"cam_192_168_10_152_thermal","ffmpeg_transcode":true}""",
                Status = "online"
            };
            var camPd = new StationOS.Data.Entities.Device
            {
                StationId = laStation.Id,
                Name = "HIKVISION – Phóng điện",
                Type = "camera_pd",
                Protocol = "isapi",
                Config = """{"ip":"192.168.10.153","username":"admin","password":"Demo@2024","rtsp_path":"/Streaming/Channels/101","go2rtc_id":"camera_192_168_10_153_pd"}""",
                Status = "online"
            };
            db.Devices.AddRange(plc, camDual, camPd);
            await db.SaveChangesAsync();
        }

        // 3. Đảm bảo các trạm con khác tồn tại
        if (!await db.Stations.AnyAsync(s => s.Code == "TBA-DT01"))
        {
            db.Stations.Add(new StationOS.Data.Entities.Station
            {
                Name = "Trạm 110kV Đồng Tháp",
                Code = "TBA-DT01",
                Location = """{"lat": 10.45, "lng": 105.63, "address": "Cao Lãnh, Đồng Tháp"}""",
                Status = "active"
            });
        }

        if (!await db.Stations.AnyAsync(s => s.Code == "TBA-VT01"))
        {
            var vtStation = new StationOS.Data.Entities.Station
            {
                Name = "Trạm 110kV Vũng Tàu",
                Code = "TBA-VT01",
                Location = """{"lat": 10.41, "lng": 107.13, "address": "Phú Mỹ, Bà Rịa - Vũng Tàu"}""",
                Status = "active"
            };
            db.Stations.Add(vtStation);
            await db.SaveChangesAsync();

            var mockPlcVt = new StationOS.Data.Entities.Device
            {
                StationId = vtStation.Id,
                Name = "Cổng Modbus Vũng Tàu",
                Type = "modbus_tcp",
                Protocol = "modbus_tcp",
                Config = "{}",
                Status = "offline"
            };
            db.Devices.Add(mockPlcVt);
            await db.SaveChangesAsync();

            var alertVt = new StationOS.Data.Entities.Alert
            {
                StationId = vtStation.Id,
                DeviceId = mockPlcVt.Id,
                Source = "system",
                Level = "warning",
                Status = "open",
                Message = "Mất kết nối thiết bị đo tại trạm Vũng Tàu",
                TriggeredAt = DateTime.UtcNow.AddHours(-1)
            };
            db.Alerts.Add(alertVt);
        }

        if (!await db.Stations.AnyAsync(s => s.Code == "TBA-TN01"))
        {
            db.Stations.Add(new StationOS.Data.Entities.Station
            {
                Name = "Trạm 110kV Tây Ninh",
                Code = "TBA-TN01",
                Location = """{"lat": 11.36, "lng": 106.11, "address": "Trảng Bàng, Tây Ninh"}""",
                Status = "active"
            });
        }

        if (!await db.Stations.AnyAsync(s => s.Code == "TBA-HCM01"))
        {
            db.Stations.Add(new StationOS.Data.Entities.Station
            {
                Name = "Trung tâm Giám sát Đa trạm (TP. HCM)",
                Code = "TBA-HCM01",
                Location = """{"lat": 10.7769, "lng": 106.7009, "address": "Quận 1, TP. Hồ Chí Minh"}""",
                Status = "active"
            });
        }

        await db.SaveChangesAsync();
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
}
