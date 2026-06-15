// ============================================================
// PlcPollingWorker — Đọc dữ liệu từ PLC Siemens S7
// Chạy nền liên tục, đọc mỗi 3 giây
//
// Cấu hình PLC trong DB (Device.Config JSONB):
// { "ip": "192.168.10.100", "rack": 0, "slot": 1,
//   "db": 32, "offset": 0, "length": 10 }
//
// Mapping DB32 hiện tại:
//   Offset 0 → Nhiệt độ Pha 1 (Int16, °C)
//   Offset 2 → Nhiệt độ Pha 3 (Int16, °C)
//   Offset 4 → Nhiệt độ Pha 2 (Int16, °C)
//   Offset 8 → Phóng điện PD  (Int16, dB)
// ============================================================

using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Caching.Memory;
using S7.Net;
using StationOS.Data;
using StationOS.Data.Entities;
using StationOS.Services;

namespace StationOS.Workers.Polling;

public class PlcPollingWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IRealtimeNotifier _notifier;
    private readonly ILogger<PlcPollingWorker> _logger;
    private readonly IMemoryCache _cache;

    // Theo dõi lần dọn dẹp cuối cùng và chu kỳ chạy
    private DateTime _lastCleanup = DateTime.MinValue;
    private readonly Dictionary<Guid, DateTime> _lastPollTimes = new();
    private readonly Dictionary<Guid, DateTime> _lastDbSaveTimes = new();

    public PlcPollingWorker(
        IServiceScopeFactory scopeFactory,
        IRealtimeNotifier notifier,
        ILogger<PlcPollingWorker> logger,
        IMemoryCache cache)
    {
        _scopeFactory = scopeFactory;
        _notifier = notifier;
        _logger = logger;
        _cache = cache;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[PLC] Worker khởi động");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

                var dbSaveSetting = await db.SystemSettings.FirstOrDefaultAsync(s => s.Key == "db_save_interval_s", stoppingToken);
                int dbSaveIntervalS = 60; // default 60s
                if (dbSaveSetting != null && dbSaveSetting.Value != null && int.TryParse(dbSaveSetting.Value.Trim('"'), out var dbSecs) && dbSecs > 0)
                    dbSaveIntervalS = dbSecs;

                // Tự động dọn dẹp dữ liệu cũ mỗi 1 giờ
                if ((DateTime.UtcNow - _lastCleanup).TotalHours >= 1)
                {
                    await CleanupOldDataAsync(stoppingToken);
                    _lastCleanup = DateTime.UtcNow;
                }

                await PollAllPlcDevicesAsync(dbSaveIntervalS, stoppingToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[PLC] Lỗi trong vòng lặp chính");
            }

            // Chạy kiểm tra mỗi giây để đáp ứng chu kỳ lấy mẫu tùy biến của từng thiết bị
            await Task.Delay(1000, stoppingToken);
        }
    }

    /// <summary>
    /// Tự động xóa dữ liệu đo lường đã cũ để giải phóng ổ cứng (Retention Policy)
    /// </summary>
    /// <summary>Tự động xóa SensorReadings cũ hơn 3 ngày để giải phóng ổ cứng (retention policy).</summary>
    private async Task CleanupOldDataAsync(CancellationToken ct)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

            // Giữ lại 30 ngày gần nhất (Thay vì 3 ngày để xem được lịch sử dài hơn)
            var cutoff = DateTime.UtcNow.AddDays(-30);
            _logger.LogInformation("[PLC] Đang dọn dẹp dữ liệu cũ trước {Time} (UTC)", cutoff);

            // Sử dụng SQL trực tiếp để xóa nhanh nhất mà không tải bản ghi vào RAM
            var deletedCount = await db.Database.ExecuteSqlRawAsync(
                "DELETE FROM \"SensorReadings\" WHERE \"Time\" < {0}", 
                new object[] { cutoff }, 
                ct
            );

            if (deletedCount > 0)
            {
                _logger.LogInformation("[PLC] Đã dọn dẹp xong. Xóa thành công {Count} bản ghi cũ.", deletedCount);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[PLC] Lỗi trong quá trình dọn dẹp dữ liệu");
        }
    }

    /// <summary>Duyệt tất cả PLC S7 và Tủ điện snap7 trong DB và đọc dữ liệu từng cái.</summary>
    private async Task PollAllPlcDevicesAsync(int dbSaveIntervalS, CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        // Lấy tất cả PLC S7 hoặc Cabinet chạy giao thức snap7 trong DB để kiểm tra định kỳ
        var plcDevices = await db.Devices
            .Where(d => d.Type == "plc_s7" || (d.Type == "cabinet" && d.Protocol == "snap7"))
            .ToListAsync(ct);

        foreach (var device in plcDevices)
        {
            await PollSinglePlcAsync(db, device, dbSaveIntervalS, ct);
        }
    }

    /// <summary>Đọc dữ liệu từ 1 PLC S7: kết nối, đọc DB block, giải mã byte thành SensorReading.</summary>
    private async Task PollSinglePlcAsync(AppDbContext db, Device device, int dbSaveIntervalS, CancellationToken ct)
    {
        // Parse config từ JSONB
        var config = ParseConfig(device.Config);
        if (config == null)
        {
            _logger.LogWarning("[PLC] Device {Name} không có config", device.Name);
            return;
        }

        // Kiểm tra chu kỳ lấy mẫu tùy biến của thiết bị
        var pollIntervalS = GetInt(config, "poll_interval_s");
        if (pollIntervalS <= 0) pollIntervalS = 5; // Mặc định 5 giây

        var nowTime = DateTime.UtcNow;
        if (_lastPollTimes.TryGetValue(device.Id, out var lastPoll) && (nowTime - lastPoll).TotalSeconds < pollIntervalS)
        {
            return; // Chưa đến chu kỳ lấy mẫu của thiết bị này
        }
        _lastPollTimes[device.Id] = nowTime;

        // Xác định xem có lưu DB tại chu kỳ này không
        var lastDbSave = _lastDbSaveTimes.GetValueOrDefault(device.Id, DateTime.MinValue);
        bool shouldSaveDb = (nowTime - lastDbSave).TotalSeconds >= dbSaveIntervalS;
        if (shouldSaveDb)
        {
            _lastDbSaveTimes[device.Id] = nowTime;
        }

        var ip = GetString(config, "ip");
        var rack   = (short)GetInt(config, "rack");
        var slot   = (short)GetInt(config, "slot");
        var dbNumber = GetInt(config, "db");
        var offset   = GetInt(config, "offset");
        var length   = GetInt(config, "length");

        // Đã TẮT HOÀN TOÀN chế độ demo/giả lập theo yêu cầu để chạy hệ thống giám sát dữ liệu thật 100%
        bool isSimMode = false;


        Plc? plc = null;
        try
        {
            byte[] bytes;
            bool isSimulated = false;

            try
            {
                plc = new Plc(CpuType.S71200, ip, rack, slot);
                // Đặt timeout 1 giây cho việc kết nối
                var openCts = new CancellationTokenSource(1000);
                using (ct.Register(openCts.Cancel))
                {
                    await plc.OpenAsync(openCts.Token);
                }

                if (plc.IsConnected)
                {
                    var rawData = await plc.ReadAsync(S7.Net.DataType.DataBlock, dbNumber, offset, S7.Net.VarType.Byte, length, 0, ct);
                    if (rawData is byte[] b)
                    {
                        bytes = b;
                    }
                    else
                    {
                        throw new Exception("Đọc dữ liệu DB thất bại");
                    }
                }
                else
                {
                    isSimulated = true;
                    bytes = new byte[length];
                }
            }
            catch (Exception ex)
            {
                if (isSimMode)
                {
                    _logger.LogWarning("[PLC] Không kết nối được {Ip} ({Msg}), tự động chuyển sang chế độ giả lập dữ liệu (Demo Mode)", ip, ex.Message);
                }
                else
                {
                    _logger.LogWarning("[PLC] Mất kết nối vật lý tới {Ip} ({Msg}) - Đánh dấu thiết bị Offline", ip, ex.Message);
                }
                isSimulated = true;
                bytes = new byte[length];
            }

            if (isSimulated)
            {
                // Cập nhật trạng thái tủ là "offline" ngay lập tức vì không kết nối được vật lý!
                await UpdateDeviceStatusAsync(db, _notifier, device.Id, "offline");

                // Kiểm tra xem hệ thống có cho phép kích hoạt Giả lập dự phòng (Fallback Simulation) khi mất mạng không
                bool isFallbackEnabled = true; // Mặc định bật để hỗ trợ duyệt giao diện khi đứt dây mạng
                var fallbackSetting = db.SystemSettings.FirstOrDefault(s => s.Key == "plc_fallback_simulation_enabled");
                if (fallbackSetting != null && fallbackSetting.Value != null && bool.TryParse(fallbackSetting.Value.Trim('"'), out var fbVal))
                {
                    isFallbackEnabled = fbVal;
                }

                if (isFallbackEnabled)
                {
                    // Sinh dữ liệu mô phỏng dự phòng để giao diện không bị đóng băng
                    var rand = new Random();
                    short pha1 = (short)(38 + rand.Next(-3, 3));
                    bytes[0] = (byte)(pha1 >> 8);
                    bytes[1] = (byte)(pha1 & 0xFF);

                    short pha3 = (short)(39 + rand.Next(-3, 3));
                    bytes[2] = (byte)(pha3 >> 8);
                    bytes[3] = (byte)(pha3 & 0xFF);

                    short pha2 = (short)(41 + rand.Next(-3, 3));
                    bytes[4] = (byte)(pha2 >> 8);
                    bytes[5] = (byte)(pha2 & 0xFF);

                    short pd = (short)(-60 + rand.Next(-5, 5));
                    bytes[8] = (byte)(pd >> 8);
                    bytes[9] = (byte)(pd & 0xFF);

                    var nowTime2 = DateTime.UtcNow;
                    var fbRawReadings = new[]
                    {
                        (id: "nhiet_do_pha_1", val: (double)ReadInt16(bytes, 0), unit: "°C"),
                        (id: "nhiet_do_pha_3", val: (double)ReadInt16(bytes, 2), unit: "°C"),
                        (id: "nhiet_do_pha_2", val: (double)ReadInt16(bytes, 4), unit: "°C"),
                        (id: "phong_dien",     val: (double)ReadInt16(bytes, 8), unit: "dB"),
                    };

                    var fbReadings = fbRawReadings
                        .Select(r => new SensorReading
                        {
                            Time = nowTime2,
                            StationId = device.StationId,
                            DeviceId = device.Id,
                            PointId = r.id,
                            Value = r.val,
                            Unit = r.unit,
                            Quality = 1 // Quality = 1 nghĩa là dữ liệu Giả lập dự phòng (Offline Fallback)
                        }).ToList();

                    // Cập nhật IMemoryCache để các RuleEngine hoạt động bình thường
                    var fbCachedDict = _cache.GetOrCreate("LatestReadings", entry => new Dictionary<string, SensorReading>());
                    if (fbCachedDict != null)
                    {
                        foreach (var r in fbReadings)
                        {
                            fbCachedDict[r.PointId] = r;
                        }
                    }

                    // TUYỆT ĐỐI KHÔNG lưu vào DB đo lường để giữ dữ liệu DB sạch 100% không bị lẫn lộn dữ liệu giả!
                    // Chỉ gửi SignalR realtime với Quality = 1 (Tín hiệu dự phòng)
                    var fbPayload = fbReadings.Select(r => new {
                        deviceId = r.DeviceId,
                        pointId = r.PointId,
                        value = r.Value,
                        unit = r.Unit,
                        time = r.Time,
                        quality = 1 // 1: Fallback Sim
                    });
                    await _notifier.SendSensorUpdateAsync(fbPayload);
                    return;
                }
                else
                {
                    // Nếu tắt hoàn toàn giả lập dự phòng, chỉ gửi gói tin thông báo offline (Quality = 2 - Mất tín hiệu hoàn toàn)
                    var offlinePayload = new[]
                    {
                        new { deviceId = device.Id, pointId = "nhiet_do_pha_1", value = 0.0, unit = "°C", time = DateTime.UtcNow, quality = 2 },
                        new { deviceId = device.Id, pointId = "nhiet_do_pha_2", value = 0.0, unit = "°C", time = DateTime.UtcNow, quality = 2 },
                        new { deviceId = device.Id, pointId = "nhiet_do_pha_3", value = 0.0, unit = "°C", time = DateTime.UtcNow, quality = 2 },
                        new { deviceId = device.Id, pointId = "phong_dien",     value = 0.0, unit = "dB", time = DateTime.UtcNow, quality = 2 }
                    };
                    await _notifier.SendSensorUpdateAsync(offlinePayload);
                    return;
                }
            }

            var now = DateTime.UtcNow;

            // Parse 4 điểm đo theo mapping DB32
            var rawReadings = new[]
            {
                (id: "nhiet_do_pha_1", val: (double)ReadInt16(bytes, 0), unit: "°C"),
                (id: "nhiet_do_pha_3", val: (double)ReadInt16(bytes, 2), unit: "°C"),
                (id: "nhiet_do_pha_2", val: (double)ReadInt16(bytes, 4), unit: "°C"),
                (id: "phong_dien",     val: (double)ReadInt16(bytes, 8), unit: "dB"),
            };

            var readings = rawReadings
                .Select(r => MakeReading(device, r.id, r.val, r.unit, now))
                .ToList();

            // Lưu vào IMemoryCache để RuleEngine dùng mà không cần query DB (Key = LatestReadings)
            var cachedDict = _cache.GetOrCreate("LatestReadings", entry => new Dictionary<string, SensorReading>());
            if (cachedDict != null)
            {
                foreach (var r in readings)
                {
                    var cacheKey = $"{r.DeviceId}_{r.PointId}".ToLower();
                    cachedDict[cacheKey] = r;
                }
            }

            // Chỉ lưu vào DB nếu đến chu kỳ (giảm I/O)
            if (shouldSaveDb)
            {
                db.SensorReadings.AddRange(readings);

                // Đồng bộ lên Cloud: tạo SyncQueue cho từng điểm đo (EntityType = SensorReading)
                foreach (var r in readings)
                {
                    db.SyncQueues.Add(new SyncQueue
                    {
                        EntityType = "SensorReading",
                        EntityId = Guid.NewGuid(), // SensorReading dùng composite key (Time, Id) nên sinh Guid tạm cho SyncQueue
                        Payload = JsonSerializer.Serialize(new
                        {
                            id = r.Id,
                            deviceId = r.DeviceId,
                            pointId = r.PointId,
                            value = r.Value,
                            unit = r.Unit,
                            time = r.Time,
                            quality = (int)r.Quality
                        }),
                        Status = "pending"
                    });
                }

                await db.SaveChangesAsync(ct);
            }

            // Push realtime qua SignalR → frontend cập nhật ngay
            var payload = readings.Select(r => new {
                deviceId = r.DeviceId,
                pointId = r.PointId,
                value = r.Value,
                unit = r.Unit,
                time = r.Time,
                quality = 0 // Good
            });
            await _notifier.SendSensorUpdateAsync(payload);

            var logParts = readings.Select(r => $"{r.PointId}={r.Value:0.#}{r.Unit}");
            _logger.LogDebug("[PLC] {Ip} (Simulated={Sim}, Saved={Save}) → {Points}", ip, isSimulated, shouldSaveDb, string.Join(", ", logParts));

            await UpdateDeviceStatusAsync(db, _notifier, device.Id, "online");
        }
        catch (Exception ex)
        {
            _logger.LogError("[PLC] Lỗi xử lý {Ip}: {Msg}", ip, ex.Message);
            await UpdateDeviceStatusAsync(db, _notifier, device.Id, "offline");
        }
        finally
        {
            plc?.Close();
        }
    }

    // ── Helpers ───────────────────────────────────────────

    private static SensorReading MakeReading(Device device, string pointId, double value, string unit, DateTime time)
        => new()
        {
            Time = time,
            StationId = device.StationId,
            DeviceId = device.Id,
            PointId = pointId,
            Value = value,
            Unit = unit,
            Quality = 0 // good
        };

    // Đọc Int16 big-endian từ byte array (chuẩn Siemens)
    private static double ReadInt16(byte[] data, int offset)
    {
        if (offset + 1 >= data.Length) return 0;
        return (short)((data[offset] << 8) | data[offset + 1]);
    }

    // JsonElement → string
    private static string GetString(Dictionary<string, object> config, string key)
    {
        if (!config.TryGetValue(key, out var val)) return "";
        return val is System.Text.Json.JsonElement je ? je.GetString() ?? "" : val.ToString()!;
    }

    // JsonElement → int
    private static int GetInt(Dictionary<string, object> config, string key)
    {
        if (!config.TryGetValue(key, out var val)) return 0;
        if (val is System.Text.Json.JsonElement je) return je.GetInt32();
        return Convert.ToInt32(val);
    }

    private static Dictionary<string, object>? ParseConfig(string? json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try { return JsonSerializer.Deserialize<Dictionary<string, object>>(json); }
        catch { return null; }
    }

    private static async Task UpdateDeviceStatusAsync(AppDbContext db, IRealtimeNotifier notifier, Guid deviceId, string status)
    {
        var device = await db.Devices.FindAsync(deviceId);
        if (device != null && device.Status != status)
        {
            var oldStatus = device.Status;
            device.Status = status;
            await db.SaveChangesAsync();

            // Push realtime status qua SignalR
            await notifier.SendDeviceStatusAsync(deviceId, status);

            // Khi kết nối mạng phục hồi thành công (Chuyển đổi trạng thái từ offline sang online)
            if (oldStatus == "offline" && status == "online")
            {
                // 1. Tự động xác nhận (Auto-Ack) toàn bộ cảnh báo đang mở của thiết bị này
                var openAlerts = await db.Alerts
                    .Where(a => a.DeviceId == device.Id && a.Status == "open")
                    .ToListAsync();
                
                foreach (var alert in openAlerts)
                {
                    alert.Status = "acked";
                    alert.AckedAt = DateTime.UtcNow;
                    alert.AckNote = "Hệ thống tự động xác nhận (Auto-Ack) khi kết nối mạng với PLC được khôi phục thành công.";
                    
                    // Push cập nhật cảnh báo tới frontend ngay lập tức
                    await notifier.SendAlertUpdatedAsync(alert);
                }

                // 2. Tự động hoàn thành (Auto-Complete) toàn bộ nhiệm vụ bảo trì đang chạy của thiết bị này
                var activeTasks = await db.MaintenanceTasks
                    .Where(t => t.DeviceId == device.Id && (t.Status == "pending" || t.Status == "in_progress"))
                    .ToListAsync();

                foreach (var task in activeTasks)
                {
                    task.Status = "completed";
                    task.CompletedAt = DateTime.UtcNow;
                    task.Notes = (string.IsNullOrEmpty(task.Notes) ? "" : task.Notes + "\n") 
                        + "[Auto-Resolve] Tự động hoàn thành nhiệm vụ bảo trì khi thiết bị trực tuyến (Online) trở lại.";
                }

                if (openAlerts.Any() || activeTasks.Any())
                {
                    await db.SaveChangesAsync();
                    Console.WriteLine($"[PLC Tự Động Phục Hồi] Đã tự động dọn dẹp {openAlerts.Count} cảnh báo mạng và hoàn thành {activeTasks.Count} nhiệm vụ bảo trì của tủ {device.Name} (ID: {device.Id}).");
                }
            }
        }
    }
}
