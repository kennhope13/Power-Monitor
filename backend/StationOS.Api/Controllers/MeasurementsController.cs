// ============================================================
// MeasurementsController — Lấy dữ liệu cảm biến
// GET /api/v1/points              — Giá trị tức thời toàn trạm
// GET /api/v1/history?device=&from=&to= — Lịch sử time-series
// ============================================================

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Caching.Memory;
using StationOS.Api.Hubs;
using StationOS.Data;
using StationOS.Data.Entities;
using System.Collections.Generic;
using System.Linq;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1")]
[Authorize]
public class MeasurementsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IHubContext<RealtimeHub> _hubContext;
    private readonly IConfiguration _config;
    private readonly IMemoryCache _cache;

    public MeasurementsController(AppDbContext db, IHubContext<RealtimeHub> hubContext, IConfiguration config, IMemoryCache cache)
    {
        _db = db;
        _hubContext = hubContext;
        _config = config;
        _cache = cache;
    }

    // Cho phép: localhost + Docker bridge (172.x) + Tailscale (100.x) + LAN config
    private bool IsTrustedInternal(string ip)
    {
        if (ip == "127.0.0.1" || ip == "::1" || ip.Contains("127.0.0.1")) return true;
        var extra = _config["Security:TrustedNetworks"] ?? "172.,100.";
        return extra.Split(',').Any(p => ip.StartsWith(p.Trim()));
    }

    /// <summary>
    /// Lấy giá trị mới nhất của tất cả điểm đo trong trạm (10 phút gần nhất)
    /// Dùng DISTINCT ON của PostgreSQL/TimescaleDB để tránh lỗi EF Core GroupBy
    /// Optimize: chỉ scan 10 phút dữ liệu gần nhất để tránh timeout khi bảng lớn
    /// </summary>
    [HttpGet("points")]
    public async Task<IActionResult> GetLatestPoints([FromQuery] Guid? stationId)
    {
        bool isFleet = !stationId.HasValue;
        Guid? targetStationId = stationId;

        // 2. Load danh sách thiết bị
        var deviceQuery = _db.Devices.AsQueryable();
        if (!isFleet) deviceQuery = deviceQuery.Where(d => d.StationId == stationId!.Value);
        var devices = await deviceQuery.ToListAsync();
        var deviceIds = devices.Select(d => d.Id).ToHashSet();

        var result = new List<object>();

        // 4. Ưu tiên lấy từ Cache nếu là trạm chính hoặc đang xem toàn hệ thống (Fleet)
        var cachedDict = _cache.Get("LatestReadings") as Dictionary<string, SensorReading> ?? new Dictionary<string, SensorReading>();
        var activeReadings = cachedDict.Values
            .Where(r => deviceIds.Contains(r.DeviceId))
            .ToList();

        if (activeReadings.Any())
        {
            foreach (var r in activeReadings)
            {
                result.Add(new
                {
                    deviceId = r.DeviceId,
                    pointId  = r.PointId,
                    value    = r.Value,
                    unit     = r.Unit ?? "°C",
                    quality  = r.Quality,
                    time     = r.Time
                });
            }
        }

        return Ok(result);
    }

    private void AddPointHelper(List<object> list, Guid deviceId, string pointId, double value, string unit, Dictionary<string, SldPoint>? sldPointsMap)
    {
        SldPoint? sp = null;
        if (sldPointsMap != null)
        {
            sldPointsMap.TryGetValue(pointId.ToUpper(), out sp);
        }
        list.Add(new
        {
            deviceId,
            pointId,
            value = Math.Round(value, 2),
            unit,
            quality = 0,
            time = DateTime.UtcNow,
            x = sp?.X,
            y = sp?.Y
        });
    }

    /// <summary>
    /// Xuất dữ liệu lịch sử nhiều điểm đo — cho XLSX export
    /// Trả về list { PointId, Time, Value } đã lọc theo khoảng thời gian
    /// intervalMinutes: gộp trung bình theo N phút (0 = raw, max 60)
    /// </summary>
    [HttpGet("history/bulk")]
    public async Task<IActionResult> GetHistoryBulk(
        [FromQuery] Guid? stationId,
        [FromQuery] DateTime from,
        [FromQuery] DateTime to,
        [FromQuery] string? pointIds = null,
        [FromQuery] int intervalMinutes = 5,
        [FromQuery] Guid? deviceId = null)
    {
        // Validate interval whitelist
        var allowedIntervals = new[] { 0, 1, 5, 10, 15, 30, 60 };
        if (!allowedIntervals.Contains(intervalMinutes)) intervalMinutes = 5;

        var query = _db.SensorReadings.AsQueryable();
        if (stationId.HasValue && stationId.Value != Guid.Empty)
            query = query.Where(r => r.StationId == stationId.Value);
        // Giới hạn range tối đa 90 ngày
        if ((to - from).TotalDays > 90) from = to.AddDays(-90);

        var selectedPoints = pointIds?.Split(',', StringSplitOptions.RemoveEmptyEntries).ToHashSet();
        string deviceFilter = deviceId.HasValue ? $"AND \"DeviceId\" = '{deviceId.Value}'" : "";
        string stationFilter = (stationId.HasValue && stationId.Value != Guid.Empty)
            ? $"AND \"StationId\" = '{stationId.Value}'"
            : "";

        var conn = _db.Database.GetDbConnection();
        await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();

        string sql;
        if (intervalMinutes <= 0)
        {
            // Raw data
            sql = $"""
                SELECT "PointId", "Time", "Value", "DeviceId"
                FROM "SensorReadings"
                WHERE "Time" >= '{from:yyyy-MM-ddTHH:mm:ss}'
                  AND "Time" <= '{to:yyyy-MM-ddTHH:mm:ss}'
                  {stationFilter}
                  {deviceFilter}
                ORDER BY "Time", "PointId"
                LIMIT 50000
                """;
        }
        else
        {
            // Time-bucket aggregation (TimescaleDB)
            sql = $"""
                SELECT "PointId",
                       time_bucket('{intervalMinutes} minutes', "Time") AS "Time",
                       AVG("Value")::float8 AS "Value",
                       "DeviceId"
                FROM "SensorReadings"
                WHERE "Time" >= '{from:yyyy-MM-ddTHH:mm:ss}'
                  AND "Time" <= '{to:yyyy-MM-ddTHH:mm:ss}'
                  {stationFilter}
                  {deviceFilter}
                GROUP BY "PointId", "DeviceId", time_bucket('{intervalMinutes} minutes', "Time")
                ORDER BY "Time", "PointId"
                """;
        }

        cmd.CommandText = sql;
        await using var reader = await cmd.ExecuteReaderAsync();

        var rows = new List<object>();
        while (await reader.ReadAsync())
        {
            var pid = reader.GetString(0);
            if (selectedPoints != null && !selectedPoints.Contains(pid)) continue;
            rows.Add(new
            {
                PointId  = pid,
                Time     = reader.GetDateTime(1),
                Value    = reader.GetDouble(2),
                DeviceId = reader.GetGuid(3)
            });
        }
        await conn.CloseAsync();
        return Ok(rows);
    }

    /// <summary>
    /// Lịch sử time-series của 1 điểm đo
    /// Dùng cho Analytics page và Alert detail chart
    /// </summary>
    [HttpGet("history")]
    public async Task<IActionResult> GetHistory(
        [FromQuery] Guid deviceId,
        [FromQuery] string pointId,
        [FromQuery] DateTime? from,
        [FromQuery] DateTime? to,
        [FromQuery] int limit = 500)
    {
        var fromTime = from ?? DateTime.UtcNow.AddHours(-6);
        var toTime = to ?? DateTime.UtcNow;

        var data = await _db.SensorReadings
            .Where(r => r.DeviceId == deviceId
                     && r.PointId == pointId
                     && r.Time >= fromTime
                     && r.Time <= toTime)
            .OrderBy(r => r.Time)
            .Take(limit)
            .Select(r => new { r.Time, r.Value, r.Quality })
            .ToListAsync();

        return Ok(data);
    }

    /// <summary>
    /// Xuất dữ liệu lịch sử dạng file CSV để tải về.
    /// Hỗ trợ lọc theo deviceId, pointId, stationId và khoảng thời gian.
    /// Tối đa 50.000 bản ghi mỗi lần xuất.
    /// </summary>
    // GET /api/v1/history/export?deviceId=&pointId=&from=&to= → CSV
    [HttpGet("history/export")]
    public async Task<IActionResult> ExportHistory(
        [FromQuery] Guid? deviceId,
        [FromQuery] string? pointId,
        [FromQuery] DateTime? from,
        [FromQuery] DateTime? to,
        [FromQuery] Guid? stationId)
    {
        var fromTime = from ?? DateTime.UtcNow.AddDays(-7);
        var toTime   = to   ?? DateTime.UtcNow;

        var q = _db.SensorReadings
            .Where(r => r.Time >= fromTime && r.Time <= toTime);
        if (deviceId.HasValue)              q = q.Where(r => r.DeviceId == deviceId.Value);
        if (!string.IsNullOrEmpty(pointId)) q = q.Where(r => r.PointId  == pointId);
        if (stationId.HasValue)             q = q.Where(r => r.StationId == stationId.Value);

        var data = await q.OrderBy(r => r.Time).Take(50000)
            .Select(r => new { r.Time, r.DeviceId, r.PointId, r.Value, r.Unit, r.Quality })
            .ToListAsync();

        var sb = new System.Text.StringBuilder();
        sb.AppendLine("Time,DeviceId,PointId,Value,Unit,Quality");
        foreach (var r in data)
            sb.AppendLine($"{r.Time:O},{r.DeviceId},{r.PointId},{r.Value?.ToString("F3") ?? ""},{r.Unit},{r.Quality}");

        var bytes = System.Text.Encoding.UTF8.GetPreamble()
            .Concat(System.Text.Encoding.UTF8.GetBytes(sb.ToString())).ToArray();
        return File(bytes, "text/csv", $"history_{DateTime.Now:yyyyMMdd_HHmm}.csv");
    }

    /// <summary>
    /// Tiếp nhận dữ liệu đo lường thô từ AI Engine (Localhost only)
    /// </summary>
    [HttpPost("measurements/ingest")]
    [AllowAnonymous]
    public async Task<IActionResult> IngestMeasurements([FromBody] List<IngestReadingDto> readings)
    {
        // Ghi log ra file để debug (Local path)
        var logFile = Path.Combine(AppContext.BaseDirectory, "api_debug.log");
        var logMsg = $"[{DateTime.Now:HH:mm:ss}] Ingest attempt from {Request.HttpContext.Connection.RemoteIpAddress}";
        try { System.IO.File.AppendAllText(logFile, logMsg + "\n"); } catch {}

        // Chế độ bảo mật: hỗ trợ IPv4, IPv6 local và IPv4-mapped IPv6
        var remoteIp = Request.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "";

        if (!IsTrustedInternal(remoteIp))
        {
            var err = $"[Ingest] Blocked unauthorized access from {remoteIp}";
            try { System.IO.File.AppendAllText(logFile, err + "\n"); } catch {}
            Console.WriteLine(err);
            return Unauthorized("Only localhost AI Engine can ingest raw data.");
        }

        if (readings == null || !readings.Any()) return BadRequest();

        var okMsg = $"[Ingest] Received {readings.Count} points for Device {readings[0].DeviceId}";
        try { System.IO.File.AppendAllText(logFile, okMsg + "\n"); } catch {}
        Console.WriteLine(okMsg);

        // Broadcast ngay lập tức qua SignalR để Dashboard cập nhật mượt mà
        await _hubContext.Clients.All.SendAsync("SensorUpdate", readings.Select(r => new {
            deviceId = r.DeviceId,
            pointId  = r.PointId,
            value    = r.Value,
            unit     = r.Unit ?? "°C",
            tx       = r.Tx,
            ty       = r.Ty,
            ox       = r.Ox,
            oy       = r.Oy,
            time     = DateTime.UtcNow
        }));

        // Lưu vào cache để phục vụ Rule Engine và kéo theo yêu cầu (Cập nhật: Có lưu vào DB theo chu kỳ 1 phút để xem lịch sử)
        try
        {
            var stationId = (await _db.Stations.FirstOrDefaultAsync())?.Id ?? Guid.Empty;
            var cachedDict = _cache.GetOrCreate("LatestReadings", entry => new Dictionary<string, SensorReading>());
            if (cachedDict == null) return BadRequest();
            
            // Throttling: Kiểm tra xem đã đến lúc lưu vào DB chưa (chu kỳ 1 phút/thiết bị)
            var firstDeviceId = readings.FirstOrDefault()?.DeviceId;
            if (firstDeviceId == null) return BadRequest();
            var throttleKey = $"last_db_save_{firstDeviceId}";
            bool shouldSaveDb = !_cache.TryGetValue(throttleKey, out DateTime lastSave) || (DateTime.UtcNow - lastSave).TotalMinutes >= 1;

            var readingsToSave = new List<SensorReading>();

            foreach (var r in readings)
            {
                var reading = new StationOS.Data.Entities.SensorReading
                {
                    StationId = stationId,
                    DeviceId  = r.DeviceId,
                    PointId   = r.PointId,
                    Value     = r.Value,
                    Unit      = r.Unit ?? "°C",
                    Time      = DateTime.UtcNow,
                    Quality   = 0
                };
                var cacheKey = $"{reading.DeviceId}_{reading.PointId}".ToLower();
                cachedDict[cacheKey] = reading;

                if (shouldSaveDb) readingsToSave.Add(reading);
            }

            if (shouldSaveDb && readingsToSave.Any())
            {
                _db.SensorReadings.AddRange(readingsToSave);
                
                // Đồng bộ lên Cloud
                foreach (var r in readingsToSave)
                {
                    _db.SyncQueues.Add(new SyncQueue
                    {
                        EntityType = "SensorReading",
                        EntityId = Guid.NewGuid(),
                        Payload = System.Text.Json.JsonSerializer.Serialize(new {
                            station_id = r.StationId,
                            device_id = r.DeviceId,
                            point_id = r.PointId,
                            value = r.Value,
                            unit = r.Unit,
                            time = r.Time,
                            quality = r.Quality
                        }),
                        Status = "pending"
                    });
                }

                await _db.SaveChangesAsync();
                _cache.Set(throttleKey, DateTime.UtcNow, TimeSpan.FromHours(1));
            }
        }
        catch { /* Bỏ qua lỗi cache/db */ }

        return Ok(new { success = true, count = readings.Count });
    }

    /// <summary>
    /// Tiếp nhận dữ liệu đo lường trực tiếp từ Tủ điện qua JSON (Hỗ trợ cả gửi đơn lẻ hoặc gửi gộp qua Gateway PLC)
    /// </summary>
    [HttpPost("measurements/cabinet-ingest")]
    [AllowAnonymous]
    public async Task<IActionResult> IngestCabinetMeasurement([FromBody] CabinetIngestDto payload)
    {
        if (payload == null)
            return BadRequest("Payload không hợp lệ.");

        var now = payload.Time ?? DateTime.UtcNow;
        var readingsToSave = new List<StationOS.Data.Entities.SensorReading>();
        var stationId = (await _db.Stations.FirstOrDefaultAsync())?.Id ?? Guid.Empty;

        // Load danh sách thiết bị loại cabinet/plc_s7 để tra cứu
        var devices = await _db.Devices
            .Where(d => d.Type == "cabinet" || d.Type == "plc_s7")
            .ToListAsync();

        if (payload.Cabinets != null && payload.Cabinets.Any() && !string.IsNullOrEmpty(payload.GatewayIp))
        {
            // CASE 1: Gửi gộp nhiều tủ qua 1 Gateway PLC
            var gatewayIp = payload.GatewayIp.Trim();
            foreach (var cab in payload.Cabinets)
            {
                if (string.IsNullOrEmpty(cab.CabinetCode)) continue;
                var code = cab.CabinetCode.Trim();
                
                // Tìm tủ điện khớp gateway_ip và cabinet_code trong Config
                var device = devices.FirstOrDefault(d => {
                    var cfg = TryParseConfig(d.Config);
                    return cfg.GetValueOrDefault("gateway_ip")?.ToString() == gatewayIp 
                        && cfg.GetValueOrDefault("cabinet_code")?.ToString() == code;
                });

                // Tự động đăng ký tủ điện mới của Gateway này nếu chưa tồn tại
                if (device == null)
                {
                    device = new StationOS.Data.Entities.Device
                    {
                        StationId = stationId,
                        Name = $"Tủ điện {code} ({gatewayIp})",
                        Type = "cabinet",
                        Protocol = "json",
                        Config = System.Text.Json.JsonSerializer.Serialize(new { gateway_ip = gatewayIp, cabinet_code = code }),
                        Status = "online"
                    };
                    _db.Devices.Add(device);
                    await _db.SaveChangesAsync();
                    devices.Add(device); // Đưa vào danh sách để tránh lặp
                    Console.WriteLine($"[Cabinet Ingest] Tự động đăng ký tủ {code} của Gateway {gatewayIp}");
                }

                readingsToSave.Add(new StationOS.Data.Entities.SensorReading { StationId = device.StationId, DeviceId = device.Id, PointId = "temp_1", Value = cab.Temp1, Unit = "°C", Time = now, Quality = 0 });
                readingsToSave.Add(new StationOS.Data.Entities.SensorReading { StationId = device.StationId, DeviceId = device.Id, PointId = "temp_2", Value = cab.Temp2, Unit = "°C", Time = now, Quality = 0 });
                readingsToSave.Add(new StationOS.Data.Entities.SensorReading { StationId = device.StationId, DeviceId = device.Id, PointId = "temp_3", Value = cab.Temp3, Unit = "°C", Time = now, Quality = 0 });
                readingsToSave.Add(new StationOS.Data.Entities.SensorReading { StationId = device.StationId, DeviceId = device.Id, PointId = "pd", Value = cab.Pd, Unit = "dB", Time = now, Quality = 0 });
            }
        }
        else if (!string.IsNullOrEmpty(payload.Ip))
        {
            // CASE 2: Tủ điện đơn lẻ tự gửi trực tiếp
            var ip = payload.Ip.Trim();
            var device = devices.FirstOrDefault(d => {
                var cfg = TryParseConfig(d.Config);
                return cfg.GetValueOrDefault("ip")?.ToString() == ip;
            });

            // Tự động đăng ký tủ đơn lẻ
            if (device == null)
            {
                device = new StationOS.Data.Entities.Device
                {
                    StationId = stationId,
                    Name = $"Tủ điện tự động ({ip})",
                    Type = "cabinet",
                    Protocol = "json",
                    Config = System.Text.Json.JsonSerializer.Serialize(new { ip }),
                    Status = "online"
                };
                _db.Devices.Add(device);
                await _db.SaveChangesAsync();
                Console.WriteLine($"[Cabinet Ingest] Tự động đăng ký tủ đơn lẻ: {device.Name}");
            }

            readingsToSave.Add(new StationOS.Data.Entities.SensorReading { StationId = device.StationId, DeviceId = device.Id, PointId = "temp_1", Value = payload.Temp1 ?? 0, Unit = "°C", Time = now, Quality = 0 });
            readingsToSave.Add(new StationOS.Data.Entities.SensorReading { StationId = device.StationId, DeviceId = device.Id, PointId = "temp_2", Value = payload.Temp2 ?? 0, Unit = "°C", Time = now, Quality = 0 });
            readingsToSave.Add(new StationOS.Data.Entities.SensorReading { StationId = device.StationId, DeviceId = device.Id, PointId = "temp_3", Value = payload.Temp3 ?? 0, Unit = "°C", Time = now, Quality = 0 });
            readingsToSave.Add(new StationOS.Data.Entities.SensorReading { StationId = device.StationId, DeviceId = device.Id, PointId = "pd", Value = payload.Pd ?? 0, Unit = "dB", Time = now, Quality = 0 });
        }
        else
        {
            return BadRequest("Payload thiếu thông tin định danh (Ip hoặc GatewayIp/Cabinets).");
        }

        // Lưu vào DB theo chu kỳ 1 phút để xem lịch sử, cập nhật cache và broadcast qua SignalR

        // Cập nhật IMemoryCache cho Rule Engine
        var cachedDict = _cache.GetOrCreate("LatestReadings", entry => new Dictionary<string, SensorReading>());
        if (cachedDict == null) return BadRequest();
        
        var dbReadings = new List<SensorReading>();
        foreach (var r in readingsToSave)
        {
            var cacheKey = $"{r.DeviceId}_{r.PointId}".ToLower();
            cachedDict[cacheKey] = r;

            // Throttling theo từng thiết bị (1 phút)
            var throttleKey = $"last_db_save_{r.DeviceId}";
            if (!_cache.TryGetValue(throttleKey, out DateTime lastSave) || (DateTime.UtcNow - lastSave).TotalMinutes >= 1)
            {
                dbReadings.Add(r);
                // Cập nhật mốc thời gian lưu ngay để tránh trùng lặp trong cùng một request gộp (Gateway)
                _cache.Set(throttleKey, DateTime.UtcNow, TimeSpan.FromMinutes(5));
            }
        }

        if (dbReadings.Any())
        {
            _db.SensorReadings.AddRange(dbReadings);
            
            // Đồng bộ lên Cloud
            foreach (var r in dbReadings)
            {
                _db.SyncQueues.Add(new SyncQueue
                {
                    EntityType = "SensorReading",
                    EntityId = Guid.NewGuid(),
                    Payload = System.Text.Json.JsonSerializer.Serialize(new {
                        station_id = r.StationId,
                        device_id = r.DeviceId,
                        point_id = r.PointId,
                        value = r.Value,
                        unit = r.Unit,
                        time = r.Time,
                        quality = r.Quality
                    }),
                    Status = "pending"
                });
            }
            await _db.SaveChangesAsync();
        }

        // Broadcast realtime qua SignalR Hub
        await _hubContext.Clients.All.SendAsync("SensorUpdate", readingsToSave.Select(r => new {
            deviceId = r.DeviceId,
            pointId  = r.PointId,
            value    = r.Value,
            unit     = r.Unit,
            time     = now
        }));

        Console.WriteLine($"[Cabinet Ingest] Xử lý thành công {readingsToSave.Count} điểm đo.");
        return Ok(new { success = true, count = readingsToSave.Count });
    }

    private static Dictionary<string, object?> TryParseConfig(string? json)
    {
        if (string.IsNullOrEmpty(json)) return [];
        try
        {
            return System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, object?>>(json) ?? [];
        }
        catch { return []; }
    }

    public class CabinetIngestDto
    {
        // Gửi đơn lẻ
        public string? Ip { get; set; }
        public double? Temp1 { get; set; }
        public double? Temp2 { get; set; }
        public double? Temp3 { get; set; }
        public double? Pd { get; set; }

        // Gửi gộp qua Gateway PLC
        public string? GatewayIp { get; set; }
        public List<CabinetPayload>? Cabinets { get; set; }

        public DateTime? Time { get; set; }
    }

    public class CabinetPayload
    {
        public string CabinetCode { get; set; } = string.Empty;
        public double Temp1 { get; set; }
        public double Temp2 { get; set; }
        public double Temp3 { get; set; }
        public double Pd { get; set; }
    }

    public class IngestReadingDto
    {
        public Guid DeviceId { get; set; }
        public string PointId { get; set; } = string.Empty;
        public double Value { get; set; }
        public string? Unit { get; set; }
        public double? Tx { get; set; }
        public double? Ty { get; set; }
        public double? Ox { get; set; }
        public double? Oy { get; set; }
    }
}
