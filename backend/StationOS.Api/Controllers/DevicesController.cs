// ============================================================
// DevicesController — Quản lý thiết bị (PLC, Camera, Sensor...)
//
// Camera type is AUTO-DETECTED via ISAPI when adding a Hikvision
// camera — no need to specify type manually.
// POST /api/v1/devices/discover — probe IP, return capabilities
// ============================================================

using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using StationOS.Data;
using StationOS.Data.Entities;
using StationOS.Services;
using StationOS.Services.Camera;
using StationOS.Services.Devices;
using StationOS.Services.Security;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1")]
[Authorize]
public class DevicesController : ControllerBase
{
    private static readonly System.Threading.SemaphoreSlim _deviceLock = new System.Threading.SemaphoreSlim(1, 1);
    private readonly AppDbContext _db;
    private readonly DeviceService _deviceService;
    private readonly PermissionService _permissions;
    private readonly IConfiguration _config;
    private readonly HikvisionIsapiService _isapi;
    private readonly CredentialEncryptionService _crypto;
    private readonly AutoDiscoveryService _autoDiscovery;
    private readonly IHttpClientFactory _http;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly LicenseService _license;

    public DevicesController(AppDbContext db, DeviceService deviceService, PermissionService permissions,
                             IConfiguration config, HikvisionIsapiService isapi, CredentialEncryptionService crypto,
                             AutoDiscoveryService autoDiscovery, IHttpClientFactory http, IServiceScopeFactory scopeFactory,
                             LicenseService license)
    {
        _db = db;
        _deviceService = deviceService;
        _permissions = permissions;
        _config = config;
        _isapi = isapi;
        _crypto = crypto;
        _autoDiscovery = autoDiscovery;
        _http = http;
        _scopeFactory = scopeFactory;
        _license = license;
    }

    /// <summary>
    /// Xóa toàn bộ điểm đo nhiệt độ (RoiPoints) và vùng nhiệt (Boundaries loại roi) trong database.
    /// </summary>
    [HttpPost("devices/clear-thermal-database")]
    [AllowAnonymous]
    public async Task<IActionResult> ClearAllThermalData()
    {
        try
        {
            _db.RoiPoints.RemoveRange(_db.RoiPoints);
            var rois = _db.Boundaries.Where(b => b.Type == "roi");
            _db.Boundaries.RemoveRange(rois);
            await _db.SaveChangesAsync();
            return Ok(new { success = true, message = "Đã xóa toàn bộ điểm đo nhiệt độ và vùng nhiệt trong database thành công!" });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { success = false, error = ex.Message });
        }
    }

    private bool IsTrustedInternal(string? ip)
    {
        if (ip == null) return false;
        if (ip == "127.0.0.1" || ip == "::1" || ip.Contains("127.0.0.1")) return true;
        var extra = _config["Security:TrustedNetworks"] ?? "172.,100.";
        return extra.Split(',').Any(p => ip.StartsWith(p.Trim()));
    }

    /// <summary>
    /// Lấy danh sách toàn bộ thiết bị (Hỗ trợ AI Engine tự nhận diện ID)
    /// </summary>
    [HttpGet("devices")]
    [AllowAnonymous]
    public async Task<IActionResult> GetAll()
    {
        var remoteIp = Request.HttpContext.Connection.RemoteIpAddress?.ToString();
        if (!IsTrustedInternal(remoteIp) && !User.Identity!.IsAuthenticated)
            return Unauthorized();

        var raw = await _db.Devices
            .Select(d => new { d.Id, d.Name, d.Type, d.Config, d.Status })
            .ToListAsync();
        var isTrusted = IsTrustedInternal(remoteIp);
        var devices = raw.Select(d => new {
            d.Id, d.Name, d.Type, d.Status,
            Config = isTrusted
                ? _crypto.DecryptPasswordInConfigJson(d.Config)
                : _crypto.RedactPasswordInConfigJson(d.Config),
        });
        return Ok(devices);
    }

    /// <summary>
    /// Lấy danh sách thiết bị theo trạm
    /// Query: ?type=camera để lọc theo loại
    /// </summary>
    [HttpGet("stations/{stationId}/devices")]
    public async Task<IActionResult> GetByStation(Guid stationId, [FromQuery] string? type)
    {
        // Kiểm tra operator có được xem trạm này không
        var allowed = await _permissions.GetAllowedStationIdsAsync();
        if (allowed != null && !allowed.Contains(stationId))
            return Forbid();

        var query = _db.Devices.Where(d => d.StationId == stationId);
        if (!string.IsNullOrEmpty(type))
            query = query.Where(d => d.Type.Contains(type));

        var raw = await query
            .OrderBy(d => d.Type).ThenBy(d => d.Name)
            .Select(d => new {
                d.Id, d.Name, d.Type, d.Protocol,
                d.Config, d.Status, d.CreatedAt
            }).ToListAsync();

        var devices = raw.Select(d => new {
            d.Id, d.Name, d.Type, d.Protocol, d.Status, d.CreatedAt,
            Config = _crypto.RedactPasswordInConfigJson(d.Config),
        });
        return Ok(devices);
    }

    /// <summary>
    /// Probe một IP để phát hiện capabilities của thiết bị Hikvision.
    /// Body: { ip, username, password }
    /// </summary>
    [HttpPost("devices/discover")]
    public async Task<IActionResult> Discover([FromBody] DiscoverRequest req)
    {
        var caps = await _isapi.DiscoverCapabilitiesAsync(req.Ip, req.Username, req.Password);
        if (caps == null)
            return NotFound(new { error = "Không kết nối được hoặc không phải thiết bị Hikvision" });
        return Ok(caps);
    }

    /// <summary>
    /// Tự động cấu hình TẤT CẢ luồng cho một camera Hikvision theo IP.
    /// - Detect capabilities qua ISAPI
    /// - Tạo camera_cctv (kênh 101) luôn luôn
    /// - Nếu HasThermal → tạo thêm camera_thermal (kênh 201)
    /// - Nếu SubType == "pd" → tạo camera_pd thay vì camera_cctv
    /// Body: { stationId, ip, username, password, namePrefix? }
    /// </summary>
    [HttpPost("devices/auto-configure")]
    public async Task<IActionResult> AutoConfigure([FromBody] AutoConfigureRequest req)
    {
        await _deviceLock.WaitAsync();
        try
        {
            // Kiểm tra giới hạn camera theo license trước khi cấu hình tự động
            var licenseStatus = await _license.GetStatusAsync();
            var maxCams = licenseStatus != null ? licenseStatus.MaxCameras : 5;

            var currentCams = await _db.Devices.CountAsync(d => d.Type.StartsWith("camera"));
            if (currentCams >= maxCams)
            {
                return BadRequest(new { message = $"Số lượng camera đã đạt giới hạn tối đa ({maxCams} camera). Vui lòng nâng cấp license key để tiếp tục." });
            }

            var caps = await _isapi.DiscoverCapabilitiesAsync(req.Ip, req.Username, req.Password);
            if (caps == null)
                return NotFound(new { error = "Không kết nối được hoặc không phải thiết bị Hikvision ISAPI" });

            var prefix    = req.NamePrefix?.Trim() ?? caps.Model.Replace(" ", "_").ToUpperInvariant();
            var ipTag     = req.Ip.Replace(".", "_");
            var created   = new List<object>();
            var capsJson  = System.Text.Json.JsonSerializer.Serialize(caps,
                new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase });

            async Task<Device> AddCameraAsync(string type, string name, string rtspPath, string go2rtcId)
            {
                var cfgObj = new
                {
                    ip       = req.Ip,
                    username = req.Username,
                    password = req.Password,
                    rtsp_path = rtspPath,
                    go2rtc_id = go2rtcId,
                };
                var device = new Device
                {
                    StationId    = req.StationId,
                    Name         = name,
                    Type         = type,
                    Protocol     = "isapi",
                    Config       = System.Text.Json.JsonSerializer.Serialize(cfgObj),
                    Capabilities = capsJson,
                    Status       = "online",
                };
                _db.Devices.Add(device);
                await _db.SaveChangesAsync();
                await _deviceService.RegisterCameraStreamAsync(device);
                return device;
            }

            if (caps.SubType == "pd")
            {
                // Camera chuyên phóng điện — chỉ 1 luồng optical
                var d = await AddCameraAsync("camera_pd", $"{prefix} – Phóng điện", "/Streaming/Channels/101", $"camera_{ipTag}_pd");
                // Áp config chuẩn StationOS cho cam PD ngay sau khi tạo
                var pdOk = await _isapi.ApplyDefaultPdConfigAsync(req.Ip, req.Username, req.Password);
                created.Add(new { d.Id, d.Name, d.Type, streamId = $"camera_{ipTag}_pd", configApplied = pdOk });
            }
            else
            {
                if (caps.HasThermal)
                {
                    // Camera có cả ảnh nhiệt và quang học → tạo duy nhất 1 thiết bị camera_dual
                    var cfgObj = new
                    {
                        ip = req.Ip,
                        username = req.Username,
                        password = req.Password,
                        rtsp_optical = "/Streaming/Channels/101",
                        go2rtc_optical = $"cam_{ipTag}_optical",
                        rtsp_thermal = "/Streaming/Channels/201",
                        go2rtc_thermal = $"cam_{ipTag}_thermal"
                    };
                    var device = new Device
                    {
                        StationId    = req.StationId,
                        Name         = $"{prefix} – Dual Thermal & Optical",
                        Type         = "camera_dual",
                        Protocol     = "isapi",
                        Config       = System.Text.Json.JsonSerializer.Serialize(cfgObj),
                        Capabilities = capsJson,
                        Status       = "online",
                    };
                    _db.Devices.Add(device);
                    await _db.SaveChangesAsync();
                    await _deviceService.RegisterCameraStreamAsync(device);
                    created.Add(new { device.Id, device.Name, device.Type, streamId = $"cam_{ipTag}_optical, cam_{ipTag}_thermal" });
                }
                else
                {
                    // Camera thường — chỉ 1 luồng quang học
                    var optical = await AddCameraAsync("camera_cctv", $"{prefix} – Quan sát thường", "/Streaming/Channels/101", $"camera_{ipTag}_normal");
                    created.Add(new { optical.Id, optical.Name, optical.Type, streamId = $"camera_{ipTag}_normal" });
                }
            }

            return Ok(new { created, capabilities = caps });
        }
        finally
        {
            _deviceLock.Release();
        }
    }

    /// <summary>
    /// Thêm thiết bị mới vào trạm.
    /// Camera Hikvision: nếu có ip+username+password trong config thì tự động
    /// phát hiện capabilities qua ISAPI và đặt Type = camera_{subtype}.
    /// PLC / Modbus: cần truyền Type thủ công.
    /// </summary>
    [HttpPost("devices")]
    public async Task<IActionResult> Create([FromBody] CreateDeviceRequest req)
    {
        await _deviceLock.WaitAsync();
        try
        {
            // Kiểm tra giới hạn trạm con theo license
            var licenseStatus = await _license.GetStatusAsync();
            var (maxNonCams, maxCams, maxRoiPoints) = licenseStatus != null
                ? (licenseStatus.MaxDevices, licenseStatus.MaxCameras, licenseStatus.MaxRoiPoints)
                : (5, 5, 10);

            if (req.Type.StartsWith("camera"))
            {
                var cameraCount = await _db.Devices.CountAsync(d => d.Type.StartsWith("camera"));
                if (cameraCount >= maxCams)
                {
                    return BadRequest(new { message = $"Số lượng camera đã đạt giới hạn tối đa ({maxCams} camera). Vui lòng nâng cấp license key để tiếp tục." });
                }
            }
            else
            {
                var deviceCount = await _db.Devices.CountAsync(d => !d.Type.StartsWith("camera"));
                if (deviceCount >= maxNonCams)
                {
                    return BadRequest(new { message = $"Số lượng thiết bị đã đạt giới hạn tối đa ({maxNonCams} thiết bị). Vui lòng nâng cấp license key để tiếp tục." });
                }
            }

            // Tôn trọng loại thiết bị user chọn — không tự override.
            // Capabilities chỉ probe để LƯU vào DB (xem được ở UI), không sửa req.Type.
            string? capsJson = null;
            if (req.Type.StartsWith("camera"))
            {
                var cfg = TryParseConfig(req.Config);
                var ip       = cfg.GetValueOrDefault("ip") as string;
                var username = cfg.GetValueOrDefault("username") as string ?? "admin";
                var password = cfg.GetValueOrDefault("password") as string ?? "";

                if (!string.IsNullOrEmpty(ip))
                {
                    var caps = await _isapi.DiscoverCapabilitiesAsync(ip, username, password);
                    if (caps != null)
                        capsJson = JsonSerializer.Serialize(caps, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
                }
            }

            var device = new Device
            {
                StationId    = req.StationId,
                Name         = req.Name,
                Type         = req.Type,
                Protocol     = req.Protocol ?? (req.Type.StartsWith("camera") ? "isapi" : null),
                // Encrypt password trước khi save DB (idempotent — không re-encrypt nếu đã có prefix)
                Config       = _crypto.EncryptPasswordInConfigJson(req.Config),
                Capabilities = capsJson,
                Status       = "online"
            };
            _db.Devices.Add(device);
            await _db.SaveChangesAsync();

            // Camera → đăng ký stream với go2rtc. Pass DECRYPTED config để build RTSP URL đúng.
            if (device.Type.StartsWith("camera") && req.Config != null)
            {
                var deviceForStream = new Device {
                    Id = device.Id, Name = device.Name, Type = device.Type,
                    Config = _crypto.DecryptPasswordInConfigJson(device.Config),
                };
                await _deviceService.RegisterCameraStreamAsync(deviceForStream);
            }

            // PD camera → tự động apply config siêu âm chuẩn StationOS
            if (device.Type == "camera_pd")
            {
                var cfg2 = TryParseConfig(req.Config);
                var ip2   = cfg2.GetValueOrDefault("ip")       as string;
                var u2    = cfg2.GetValueOrDefault("username") as string ?? "admin";
                var p2    = cfg2.GetValueOrDefault("password") as string ?? "";
                if (!string.IsNullOrEmpty(ip2))
                    _ = _isapi.ApplyDefaultPdConfigAsync(ip2, u2, p2); // fire-and-forget
            }

            return CreatedAtAction(nameof(GetById), new { id = device.Id }, device);
        }
        finally
        {
            _deviceLock.Release();
        }
    }

    private static Dictionary<string, object?> TryParseConfig(string? json)
    {
        if (string.IsNullOrEmpty(json)) return [];
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, object?>>(json) ?? [];
        }
        catch { return []; }
    }

    /// <summary>
    /// Nếu user gửi password="***" (redacted) → giữ password cũ.
    /// Ngược lại dùng password mới user gửi.
    /// Áp dụng cho cả password / api_key / secret.
    /// </summary>
    private string MergeConfigKeepOldPasswordIfRedacted(string? oldConfig, string newConfig)
    {
        try
        {
            using var oldDoc = JsonDocument.Parse(string.IsNullOrEmpty(oldConfig) ? "{}" : oldConfig);
            using var newDoc = JsonDocument.Parse(newConfig);
            var oldDecrypted = _crypto.DecryptPasswordInConfigJson(oldConfig);
            using var oldPlainDoc = JsonDocument.Parse(string.IsNullOrEmpty(oldDecrypted) ? "{}" : oldDecrypted);

            var result = new Dictionary<string, object?>();
            string[] secretKeys = ["password", "api_key", "secret"];

            foreach (var p in newDoc.RootElement.EnumerateObject())
            {
                var valStr = p.Value.GetString();
                if (secretKeys.Contains(p.Name.ToLowerInvariant()) &&
                    p.Value.ValueKind == JsonValueKind.String &&
                    !string.IsNullOrEmpty(valStr) &&
                    valStr.All(c => c == '*'))
                {
                    // Keep old plain password
                    if (oldPlainDoc.RootElement.TryGetProperty(p.Name, out var oldVal) &&
                        oldVal.ValueKind == JsonValueKind.String)
                        result[p.Name] = oldVal.GetString();
                    // else: bỏ qua (không có password cũ)
                }
                else
                {
                    result[p.Name] = p.Value.ValueKind == JsonValueKind.String
                        ? p.Value.GetString()
                        : JsonSerializer.Deserialize<object>(p.Value.GetRawText());
                }
            }
            return JsonSerializer.Serialize(result);
        }
        catch { return newConfig; }
    }

    /// <summary>
    /// Lấy chi tiết 1 thiết bị theo ID.
    /// Trusted IP (localhost/LAN nội bộ) nhận config đầy đủ; các IP khác nhận config đã ẩn mật khẩu.
    /// </summary>
    [HttpGet("devices/{id}")]
    [AllowAnonymous]
    public async Task<IActionResult> GetById(Guid id)
    {
        var remoteIp = Request.HttpContext.Connection.RemoteIpAddress?.ToString();
        if (!IsTrustedInternal(remoteIp) && !User.Identity!.IsAuthenticated)
            return Unauthorized();

        var d = await _db.Devices.FindAsync(id);
        if (d == null) return NotFound();

        var isTrusted = IsTrustedInternal(remoteIp);
        return Ok(new {
            d.Id, d.Name, d.Type, d.Protocol, d.Status, d.CreatedAt,
            d.Capabilities, d.StationId,
            Config = isTrusted
                ? _crypto.DecryptPasswordInConfigJson(d.Config)
                : _crypto.RedactPasswordInConfigJson(d.Config),
        });
    }

    /// <summary>
    /// Sửa cấu hình thiết bị (IP, tên, config...)
    /// </summary>
    [HttpPut("devices/{id}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateDeviceRequest req)
    {
        var device = await _db.Devices.FindAsync(id);
        if (device == null) return NotFound();

        device.Name = req.Name ?? device.Name;
        if (req.Config != null)
        {
            // Nếu FE gửi config với password="***" → giữ password cũ (user không đổi)
            // Nếu password mới thật → encrypt rồi save
            var merged = MergeConfigKeepOldPasswordIfRedacted(device.Config, req.Config);
            device.Config = _crypto.EncryptPasswordInConfigJson(merged);
        }
        device.Status = req.Status ?? device.Status;
        await _db.SaveChangesAsync();

        // Nếu là camera → re-register stream với go2rtc sau khi cập nhật config
        if (device.Type.StartsWith("camera"))
            await _deviceService.RegisterCameraStreamAsync(device);

        return Ok(device);
    }

    /// <summary>
    /// Lấy credentials đã giải mã (username + password) của thiết bị.
    /// CHỈ Admin/Manager được phép gọi endpoint này.
    /// </summary>
    [HttpGet("devices/{id}/credentials")]
    [Authorize(Roles = "admin,manager")]
    public async Task<IActionResult> GetCredentials(Guid id)
    {
        var device = await _db.Devices.FindAsync(id);
        if (device == null) return NotFound();

        try
        {
            using var doc = JsonDocument.Parse(device.Config ?? "{}");
            var root = doc.RootElement;
            var username = root.TryGetProperty("username", out var userEl) ? userEl.GetString() : "admin";
            var rawPass = root.TryGetProperty("password", out var passEl) ? passEl.GetString() : "";
            var password = _crypto.Decrypt(rawPass);

            return Ok(new { username, password });
        }
        catch { return BadRequest("Không thể đọc cấu hình thiết bị."); }
    }

    /// <summary>
    /// Xóa thiết bị — nếu là camera thì xóa stream khỏi go2rtc
    /// </summary>
    [HttpDelete("devices/{id}")]
    public async Task<IActionResult> Delete(Guid id)
    {
        var device = await _db.Devices.FindAsync(id);
        if (device == null) return NotFound();

        // 1. Nếu là camera → hủy đăng ký stream với go2rtc
        if (device.Type.StartsWith("camera"))
            await _deviceService.UnregisterCameraStreamAsync(device);

        // 2. Dọn dẹp thủ công tất cả dữ liệu liên quan để tránh lỗi hypertable hoặc constraint
        var boundaries = _db.Boundaries.Where(x => x.DeviceId == id);
        _db.Boundaries.RemoveRange(boundaries);

        var rules = _db.Rules.Where(x => x.DeviceId == id);
        _db.Rules.RemoveRange(rules);

        var sensorReadings = _db.SensorReadings.Where(x => x.DeviceId == id);
        _db.SensorReadings.RemoveRange(sensorReadings);

        var alerts = _db.Alerts.Where(x => x.DeviceId == id);
        _db.Alerts.RemoveRange(alerts);

        var sldPoints = _db.SldPoints.Where(x => x.DeviceId == id);
        _db.SldPoints.RemoveRange(sldPoints);

        var maintenanceTasks = _db.MaintenanceTasks.Where(x => x.DeviceId == id);
        _db.MaintenanceTasks.RemoveRange(maintenanceTasks);

        var ruleTriggerLogs = _db.RuleTriggerLogs.Where(x => x.DeviceId == id);
        _db.RuleTriggerLogs.RemoveRange(ruleTriggerLogs);

        // 3. Xóa thiết bị chính
        _db.Devices.Remove(device);
        await _db.SaveChangesAsync();

        return NoContent();
    }

    /// <summary>
    /// Test kết nối thiết bị — kiểm tra có ping được không
    /// </summary>
    [HttpPost("devices/{id}/test")]
    public async Task<IActionResult> TestConnection(Guid id)
    {
        var device = await _db.Devices.FindAsync(id);
        if (device == null) return NotFound();

        var result = await _deviceService.TestConnectionAsync(device);
        return Ok(new { success = result.Success, message = result.Message, latencyMs = result.LatencyMs });
    }

    // ── ROI Points ────────────────────────────────────────────

    /// <summary>
    /// Lấy danh sách điểm ROI (điểm đo nhiệt độ) được cấu hình trên camera nhiệt.
    /// </summary>
    [HttpGet("devices/{deviceId}/roi-points")]
    [AllowAnonymous]
    public async Task<IActionResult> GetRoiPoints(Guid deviceId)
    {
        var remoteIp = Request.HttpContext.Connection.RemoteIpAddress?.ToString();
        if (!IsTrustedInternal(remoteIp) && !User.Identity!.IsAuthenticated)
            return Unauthorized();

        var points = await _db.RoiPoints
            .Where(r => r.DeviceId == deviceId)
            .OrderBy(r => r.CreatedAt)
            .ToListAsync();
        return Ok(points);
    }

    /// <summary>
    /// Thêm điểm ROI mới cho camera nhiệt. Sau khi tạo, tự động đồng bộ cấu hình sang AI Engine.
    /// </summary>
    [HttpPost("devices/{deviceId}/roi-points")]
    public async Task<IActionResult> CreateRoiPoint(Guid deviceId, [FromBody] RoiPointRequest req)
    {
        // Kiểm tra giới hạn số điểm nhiệt theo license
        var licenseStatus = await _license.GetStatusAsync();
        var maxRoiPoints = licenseStatus != null ? licenseStatus.MaxRoiPoints : 10;

        var currentPointsCount = await _db.RoiPoints.CountAsync();
        if (currentPointsCount >= maxRoiPoints)
        {
            return BadRequest(new { message = $"Tổng số lượng điểm nhiệt trong hệ thống đã đạt giới hạn tối đa ({maxRoiPoints} điểm). Vui lòng nâng cấp license key để tiếp tục." });
        }

        string? assignedPointId = req.PointId;
        if (string.IsNullOrEmpty(assignedPointId))
        {
            // 1. Cố gắng trích xuất số từ tên điểm (ví dụ: "Điểm 4" -> 4 -> "P4")
            var match = System.Text.RegularExpressions.Regex.Match(req.Name ?? "", @"\d+");
            if (match.Success && int.TryParse(match.Value, out int num))
            {
                assignedPointId = $"P{num}";
            }
            else
            {
                // 2. Nếu không có số, tự động lấy chỉ số nhỏ nhất còn trống bắt đầu từ 1
                var existingPoints = await _db.RoiPoints
                    .Where(r => r.DeviceId == deviceId)
                    .ToListAsync();
                
                var usedIndices = new HashSet<int>();
                foreach (var ep in existingPoints)
                {
                    if (!string.IsNullOrEmpty(ep.PointId) && ep.PointId.StartsWith("P"))
                    {
                        if (int.TryParse(ep.PointId.Substring(1), out int val))
                            usedIndices.Add(val);
                    }
                    else if (!string.IsNullOrEmpty(ep.Name))
                    {
                        var m = System.Text.RegularExpressions.Regex.Match(ep.Name, @"\d+");
                        if (m.Success && int.TryParse(m.Value, out int val))
                            usedIndices.Add(val);
                    }
                }

                int firstAvailable = 1;
                while (usedIndices.Contains(firstAvailable)) firstAvailable++;
                assignedPointId = $"P{firstAvailable}";
            }
        }

        var point = new RoiPoint
        {
            DeviceId = deviceId,
            Name = req.Name ?? string.Empty,
            Tx = req.Tx,
            Ty = req.Ty,
            Ox = req.Ox ?? req.Tx,
            Oy = req.Oy ?? req.Ty,
            PointId = assignedPointId ?? string.Empty,
            Color = req.Color,
            SortOrder = req.SortOrder,
            PreAlarmThreshold = req.PreAlarmThreshold ?? 50.0f,
            AlarmThreshold = req.AlarmThreshold ?? 70.0f,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };
        _db.RoiPoints.Add(point);
        await _db.SaveChangesAsync();

        _ = SyncThermalPointsToAIEngineAsync(deviceId);

        return Ok(point);
    }

    /// <summary>
    /// Cập nhật tọa độ, tên hoặc ngưỡng cảnh báo của điểm ROI. Sau khi sửa, tự động đồng bộ sang AI Engine.
    /// </summary>
    [HttpPut("devices/{deviceId}/roi-points/{id}")]
    public async Task<IActionResult> UpdateRoiPoint(Guid deviceId, Guid id, [FromBody] RoiPointRequest req)
    {
        var point = await _db.RoiPoints.FirstOrDefaultAsync(r => r.Id == id && r.DeviceId == deviceId);
        if (point == null) return NotFound();

        if (!string.IsNullOrEmpty(req.Name)) point.Name = req.Name;
        if (req.Tx > 0) point.Tx = req.Tx;
        if (req.Ty > 0) point.Ty = req.Ty;
        if (req.Ox.HasValue) point.Ox = req.Ox.Value;
        if (req.Oy.HasValue) point.Oy = req.Oy.Value;
        if (req.PreAlarmThreshold.HasValue) point.PreAlarmThreshold = req.PreAlarmThreshold.Value;
        if (req.AlarmThreshold.HasValue) point.AlarmThreshold = req.AlarmThreshold.Value;
        if (req.PointId != null) point.PointId = req.PointId;
        if (req.Color != null) point.Color = req.Color;
        if (req.SortOrder > 0) point.SortOrder = req.SortOrder;
        
        point.UpdatedAt = DateTime.UtcNow;

        await _db.SaveChangesAsync();

        _ = SyncThermalPointsToAIEngineAsync(deviceId);

        return Ok(point);
    }

    /// <summary>
    /// Xóa điểm ROI khỏi camera. Sau khi xóa, tự động đồng bộ lại cấu hình sang AI Engine.
    /// </summary>
    [HttpDelete("devices/{deviceId}/roi-points/{id}")]
    public async Task<IActionResult> DeleteRoiPoint(Guid deviceId, Guid id)
    {
        var point = await _db.RoiPoints.FirstOrDefaultAsync(r => r.Id == id && r.DeviceId == deviceId);
        if (point == null) return NotFound();

        _db.RoiPoints.Remove(point);
        await _db.SaveChangesAsync();

        _ = SyncThermalPointsToAIEngineAsync(deviceId);

        return NoContent();
    }

    private async Task SyncThermalPointsToAIEngineAsync(Guid deviceId)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var scopedService = scope.ServiceProvider.GetRequiredService<DeviceService>();
            await scopedService.SyncThermalConfigToAIEngineAsync(deviceId);
        }
        catch (Exception)
        {
            // Fail silently or log if possible to prevent background thread crash
        }
    }

    /// <summary>
    /// Query nhiệt độ tức thời tại các tọa độ — proxy tới AI Engine.
    /// Frontend gọi endpoint này, Backend lấy credentials từ DB rồi forward.
    /// </summary>
    [HttpPost("devices/{deviceId}/thermal/live-temps")]
    public async Task<IActionResult> LiveTemps(Guid deviceId, [FromBody] LiveTempsRequest req)
    {
        var device = await _db.Devices.FindAsync(deviceId);
        if (device == null) return NotFound();

        // Parse config JSON trực tiếp
        string ip = "", username = "admin", password = "";
        double focalOptical = 0;
        double focalThermal = 0;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(device.Config ?? "{}");
            var root = doc.RootElement;
            ip       = root.TryGetProperty("ip",       out var ipEl)   ? ipEl.GetString()   ?? "" : "";
            username = root.TryGetProperty("username", out var userEl) ? userEl.GetString() ?? "admin" : "admin";
            var rawPass = root.TryGetProperty("password", out var passEl) ? passEl.GetString() ?? "" : "";
            try { password = _crypto.Decrypt(rawPass); } catch { password = rawPass; }

            if (root.TryGetProperty("focal_length_optical", out var foEl))
            {
                if (foEl.ValueKind == System.Text.Json.JsonValueKind.Number && foEl.TryGetDouble(out var foVal)) focalOptical = foVal;
                else if (foEl.ValueKind == System.Text.Json.JsonValueKind.String && double.TryParse(foEl.GetString(), out var foSVal)) focalOptical = foSVal;
            }
            if (root.TryGetProperty("focal_length_thermal", out var ftEl))
            {
                if (ftEl.ValueKind == System.Text.Json.JsonValueKind.Number && ftEl.TryGetDouble(out var ftVal)) focalThermal = ftVal;
                else if (ftEl.ValueKind == System.Text.Json.JsonValueKind.String && double.TryParse(ftEl.GetString(), out var ftSVal)) focalThermal = ftSVal;
            }
        }
        catch { }

        if (string.IsNullOrEmpty(ip))
            return BadRequest(new { error = "device_no_ip" });

        try
        {
            using var client = _http.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(5);
            // Dùng anonymous object với lowercase field names để khớp Pydantic AI Engine
            var payload = System.Text.Json.JsonSerializer.Serialize(new
            {
                camera_ip = ip,
                username  = username,
                password  = password,
                focal_length_optical = focalOptical,
                focal_length_thermal = focalThermal,
                points = (req.Points ?? new List<LiveTempPoint>())
                    .Select(p => new { id = p.Id, x = p.X, y = p.Y }).ToList(),
                rois = (req.Rois ?? new List<LiveTempRoi>())
                    .Select(r => new { id = r.Id, x1 = r.X1, y1 = r.Y1, x2 = r.X2, y2 = r.Y2 }).ToList(),
            });
            var content = new StringContent(payload, System.Text.Encoding.UTF8, "application/json");
            var resp = await client.PostAsync("http://127.0.0.1:8100/thermal/query-temps", content);
            var body = await resp.Content.ReadAsStringAsync();
            return Content(body, "application/json");
        }
        catch (Exception ex)
        {
            return StatusCode(503, new { error = "ai_engine_unreachable", detail = ex.Message });
        }
    }

    public record LiveTempPoint(string Id, double X, double Y);
    public record LiveTempRoi(string Id, double X1, double Y1, double X2, double Y2);
    public record LiveTempsRequest(List<LiveTempPoint>? Points, List<LiveTempRoi>? Rois);

    private static string GetStringValue(Dictionary<string, object?> dict, string key, string defaultValue = "")
    {
        if (!dict.TryGetValue(key, out var val) || val == null)
            return defaultValue;

        if (val is JsonElement elem)
        {
            if (elem.ValueKind == JsonValueKind.String)
                return elem.GetString() ?? defaultValue;
            return elem.GetRawText()?.Trim('"') ?? defaultValue;
        }

        return val.ToString() ?? defaultValue;
    }

    /// <summary>
    /// Lấy toàn bộ dữ liệu liên quan đến một thiết bị: điểm ROI, rules, cảnh báo gần đây, boundaries và công việc bảo trì.
    /// </summary>
    [HttpGet("devices/{id:guid}/related")]
    public async Task<IActionResult> GetRelated(Guid id)
    {
        var device = await _db.Devices.FindAsync(id);
        if (device == null) return NotFound();

        // 1. Cấu hình điểm đo (sensors) từ Device.Config hoặc từ RoiPoints nếu là camera
        var roiPoints = await _db.RoiPoints.Where(r => r.DeviceId == id).ToListAsync();
        
        // 2. Rules liên quan đến thiết bị này (hoặc trạm của nó)
        var rules = await _db.Rules
            .Where(r => r.StationId == device.StationId && (r.RuleSet == device.Name || r.RuleSet == "Global"))
            .ToListAsync();

        // 3. Alerts gần đây
        var alerts = await _db.Alerts
            .Where(a => a.DeviceId == id)
            .OrderByDescending(a => a.TriggeredAt)
            .Take(10)
            .ToListAsync();

        // 4. Boundaries (PD/ROI)
        var boundaries = await _db.Boundaries
            .Where(b => b.DeviceId == id)
            .ToListAsync();

        // 5. Công việc bảo trì
        var maintenance = await _db.MaintenanceTasks
            .Where(m => m.DeviceId == id && m.Status != "completed")
            .ToListAsync();

        return Ok(new
        {
            device = new { device.Id, device.Name, device.Type, device.Status },
            roiPoints,
            rules,
            recentAlerts = alerts,
            boundaries,
            maintenance
        });
    }

    /// <summary>
    /// Lấy thông tin mapping vùng quang học (VisibleValidRect) trong ảnh nhiệt Hikvision.
    /// Dùng để căn chỉnh overlay giữa luồng nhiệt và luồng quang học trên frontend.
    /// Trả về mặc định { x, y, width, height } nếu camera không hỗ trợ.
    /// </summary>
    [HttpGet("devices/{deviceId}/thermal-mapping")]
    public async Task<IActionResult> GetThermalMapping(Guid deviceId)
    {
        var device = await _db.Devices.FindAsync(deviceId);
        if (device == null) return NotFound();

        var cfg = TryParseConfig(device.Config);
        var ip = GetStringValue(cfg, "ip");
        var username = GetStringValue(cfg, "username", "admin");
        var password = "";
        var rawPassword = GetStringValue(cfg, "password");
        if (!string.IsNullOrEmpty(rawPassword))
        {
            try { password = _crypto.Decrypt(rawPassword); }
            catch { password = rawPassword; }
        }

        Console.WriteLine($"[DEBUG-DECRYPT] IP: {ip}, User: {username}, Decrypted Password: {password}, Raw Password: {rawPassword}");

        var mappingJson = await _isapi.GetThermalMappingAsync(ip, username, password);
        if (string.IsNullOrEmpty(mappingJson))
        {
            // Trả về default mapping nếu camera không hỗ trợ hoặc lỗi
            return Ok(new { x = 0.2, y = 0.084, width = 0.63, height = 0.841 });
        }

        try
        {
            using var doc = JsonDocument.Parse(mappingJson);
            if (doc.RootElement.TryGetProperty("JpegPictureWithAppendData", out var appendData) &&
                appendData.TryGetProperty("VisibleValidRect", out var rect))
            {
                return Ok(new {
                    x = double.Parse(rect.GetProperty("x").ToString()),
                    y = double.Parse(rect.GetProperty("y").ToString()),
                    width = double.Parse(rect.GetProperty("width").ToString()),
                    height = double.Parse(rect.GetProperty("height").ToString())
                });
            }
        }
        catch { }

        return Ok(new { x = 0.2, y = 0.084, width = 0.63, height = 0.841 });
    }

    /// <summary>
    /// Quét LAN để tìm thiết bị mới (camera, PLC...)
    /// Query: ?subnet=192.168.10 để quét subnet cụ thể
    /// </summary>
    [HttpGet("devices/scan")]
    [AllowAnonymous]
    public async Task<IActionResult> ScanLan([FromQuery] string subnet = "192.168.10")
    {
        var found = await _autoDiscovery.ScanSubnetAsync(subnet);
        return Ok(found);
    }
}

public record CreateDeviceRequest(
    Guid StationId,
    string Name,
    string Type,        // camera | plc_s7 | modbus_tcp — camera subtype auto-detected via ISAPI
    string? Protocol,
    string? Config      // JSONB: { ip, username, password, rtsp_path, go2rtc_id, ... }
);

public record UpdateDeviceRequest(
    string? Name,
    string? Config,
    string? Status
);

public record DiscoverRequest(string Ip, string Username, string Password);
public record AutoConfigureRequest(Guid StationId, string Ip, string Username, string Password, string? NamePrefix);

public record RoiPointRequest(
    string Name,
    float Tx,
    float Ty,
    float? Ox = null,
    float? Oy = null,
    string? PointId = null,
    string? Color = null,
    int SortOrder = 0,
    float? PreAlarmThreshold = 50.0f,
    float? AlarmThreshold = 70.0f
);
