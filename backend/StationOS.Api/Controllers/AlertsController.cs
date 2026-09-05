// ============================================================
// AlertsController — Danh sách + ACK + Close alert
// GET /api/v1/alerts
// POST /api/v1/alerts/{id}/ack
// POST /api/v1/alerts/{id}/close
// ============================================================

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using System.Net.Http;
using System.Net.Http.Json;
using StationOS.Data;
using StationOS.Data.Entities;
using StationOS.Services;
using StationOS.Workers.Polling;
using System.Security.Claims;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1/alerts")]
[Authorize]
public class AlertsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _permissions;
    private readonly IRealtimeNotifier _notifier;
    private readonly IConfiguration _config;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly HealthScoreWorker _healthWorker;

    public AlertsController(
        AppDbContext db,
        PermissionService permissions,
        IRealtimeNotifier notifier,
        IConfiguration config,
        IHttpClientFactory httpClientFactory,
        HealthScoreWorker healthWorker)
    {
        _db = db;
        _permissions = permissions;
        _notifier = notifier;
        _config = config;
        _httpClientFactory = httpClientFactory;
        _healthWorker = healthWorker;
    }

    /// <summary>
    /// Gửi một cảnh báo test qua SignalR để kiểm tra kết nối realtime.
    /// Endpoint công khai — không yêu cầu xác thực.
    /// </summary>
    // GET /api/v1/alerts/test
    [HttpGet("test")]
    [AllowAnonymous] // Cho phép test nhanh không cần token
    public async Task<IActionResult> Test()
    {
        var testAlert = new
        {
            Id = Guid.NewGuid(),
            Level = "alarm",
            Message = "🚨 THÔNG BÁO TEST: Phát hiện xâm nhập tại khu vực Trạm chính!",
            TriggeredAt = DateTime.UtcNow
        };

        await _notifier.SendAlertAsync(testAlert);
        return Ok(new { success = true, message = "Đã gửi thông báo test tới SignalR", alert = testAlert });
    }

    /// <summary>
    /// Lấy danh sách cảnh báo. Operator chỉ thấy cảnh báo thuộc trạm được phân quyền.
    /// Hỗ trợ lọc theo trạng thái (open/acked/closed) và khoảng thời gian.
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetAll(
        [FromQuery] string? status,
        [FromQuery] DateTime? from,
        [FromQuery] DateTime? to,
        [FromQuery] Guid? deviceId,
        [FromQuery] int pageSize = 200,
        [FromQuery] int limit = 0)
    {
        var take = limit > 0 ? limit : (pageSize > 0 ? pageSize : 200);
        var q = _db.Alerts.AsQueryable();

        var allowed = await _permissions.GetAllowedStationIdsAsync();
        if (allowed != null) q = q.Where(a => allowed.Contains(a.StationId));

        if (!string.IsNullOrEmpty(status))
            q = q.Where(a => a.Status == status);

        if (deviceId.HasValue)
            q = q.Where(a => a.DeviceId == deviceId.Value);

        if (from.HasValue) q = q.Where(a => a.TriggeredAt >= from.Value);
        if (to.HasValue)   q = q.Where(a => a.TriggeredAt <= to.Value);

        var alertsRaw = await q
            .OrderByDescending(a => a.TriggeredAt)
            .Take(take)
            .GroupJoin(
                _db.DetectionEvents,
                a => a.Id,
                e => e.AlertId,
                (a, events) => new { Alert = a, Detection = events.FirstOrDefault() }
            )
            .Select(x => new {
                x.Alert.Id, x.Alert.Source, x.Alert.Level, x.Alert.Status,
                x.Alert.Message, x.Alert.Value,
                x.Alert.DeviceId, x.Alert.RuleId,
                x.Alert.StationId,
                x.Alert.TriggeredAt, x.Alert.AckedAt, x.Alert.ClosedAt,
                x.Alert.AckNote,
                x.Alert.ImageUrl, x.Alert.VideoUrl, x.Alert.ThumbnailUrl,
                metadata = x.Detection != null ? x.Detection.Metadata : null
            })
            .ToListAsync();

        // Lấy tên trạm để trả về cho frontend trạm tổng
        var stationIds = alertsRaw.Select(a => a.StationId).Distinct().ToList();
        var stationNames = await _db.Stations
            .Where(s => stationIds.Contains(s.Id))
            .ToDictionaryAsync(s => s.Id, s => s.Name);

        var alerts = alertsRaw.Select(x => new {
            x.Id, x.Source, x.Level, x.Status,
            x.Message, x.Value,
            x.DeviceId, x.RuleId,
            x.StationId,
            stationName = stationNames.TryGetValue(x.StationId, out var sn) ? sn : null,
            x.TriggeredAt, x.AckedAt, x.ClosedAt,
            x.AckNote,
            x.ImageUrl, x.VideoUrl, x.ThumbnailUrl,
            x.metadata
        });

        return Ok(alerts);
    }

    /// <summary>
    /// Lấy chi tiết 1 cảnh báo kèm lịch sử thay đổi trạng thái (AlertHistory).
    /// </summary>
    // GET /api/v1/alerts/{id}
    [HttpGet("{id:guid}")]
    public async Task<IActionResult> GetById(Guid id)
    {
        try 
        {
            var alertData = await _db.Alerts
                .Where(a => a.Id == id)
                .GroupJoin(
                    _db.DetectionEvents,
                    a => a.Id,
                    e => e.AlertId,
                    (a, events) => new { Alert = a, Detection = events.FirstOrDefault() }
                )
                .FirstOrDefaultAsync();

            if (alertData == null) return NotFound();

            var history = await _db.AlertHistories
                .Where(h => h.AlertId == id)
                .OrderBy(h => h.ChangedAt)
                .Select(h => new { h.Status, h.ChangedAt, h.Note, h.ChangedBy })
                .ToListAsync();

            var stationName2 = await _db.Stations
                .Where(s => s.Id == alertData.Alert.StationId)
                .Select(s => s.Name)
                .FirstOrDefaultAsync();

            return Ok(new {
                alertData.Alert.Id, alertData.Alert.Source, alertData.Alert.Level, alertData.Alert.Status,
                alertData.Alert.Message, alertData.Alert.Value,
                alertData.Alert.DeviceId, alertData.Alert.RuleId,
                alertData.Alert.StationId,
                stationName = stationName2,
                alertData.Alert.TriggeredAt, alertData.Alert.AckedAt, alertData.Alert.ClosedAt, alertData.Alert.AckNote,
                alertData.Alert.ImageUrl, alertData.Alert.VideoUrl, alertData.Alert.ThumbnailUrl,
                metadata = alertData.Detection?.Metadata,
                History = history
            });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { error = "Lỗi truy vấn dữ liệu chi tiết", message = ex.Message });
        }
    }

    /// <summary>
    /// Xác nhận đã nhận (ACK) cảnh báo. Chỉ áp dụng cho cảnh báo đang ở trạng thái "open".
    /// Body: { note: string } — ghi chú tùy chọn.
    /// </summary>
    // POST /api/v1/alerts/{id}/ack
    [HttpPost("{id:guid}/ack")]
    public async Task<IActionResult> Ack(Guid id, [FromBody] AckRequest? req)
    {
        var alert = await _db.Alerts.FindAsync(id);
        if (alert == null) return NotFound();
        if (alert.Status != "open") return BadRequest("Alert không ở trạng thái open");

        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        Guid? uid = Guid.TryParse(userId, out var parsed) ? parsed : null;

        alert.Status  = "acked";
        alert.AckedAt = DateTime.UtcNow;
        alert.AckNote = req?.Note;
        alert.AckedBy = uid;

        // Ghi AlertHistory
        _db.AlertHistories.Add(new AlertHistory
        {
            AlertId   = alert.Id,
            Status    = "acked",
            ChangedBy = uid,
            Note      = req?.Note,
        });

        await _db.SaveChangesAsync();
        await _notifier.SendAlertUpdatedAsync(new { alert.Id, alert.Status, alert.DeviceId, alert.Level });
        return Ok(new { alert.Id, alert.Status, alert.AckedAt });
    }

    /// <summary>
    /// Đóng cảnh báo — chuyển trạng thái sang "closed" và ghi AlertHistory.
    /// Broadcast trạng thái mới qua SignalR.
    /// </summary>
    // POST /api/v1/alerts/{id}/close
    [HttpPost("{id:guid}/close")]
    public async Task<IActionResult> Close(Guid id)
    {
        var alert = await _db.Alerts.FindAsync(id);
        if (alert == null) return NotFound();

        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        Guid? uid = Guid.TryParse(userId, out var parsed) ? parsed : null;

        alert.Status   = "closed";
        alert.ClosedAt = DateTime.UtcNow;

        // Ghi AlertHistory
        _db.AlertHistories.Add(new AlertHistory
        {
            AlertId   = alert.Id,
            Status    = "closed",
            ChangedBy = uid,
        });

        await _db.SaveChangesAsync();
        await _notifier.SendAlertUpdatedAsync(new { alert.Id, alert.Status, alert.DeviceId, alert.Level });
        return Ok(new { alert.Id, alert.Status, alert.ClosedAt });
    }

    /// <summary>
    /// Đóng hàng loạt tất cả alert open/acked của 1 thiết bị.
    /// POST /api/v1/alerts/close-device/{deviceId}
    /// </summary>
    [HttpPost("close-device/{deviceId:guid}")]
    [Authorize(Roles = "admin,manager")]
    public async Task<IActionResult> CloseAllForDevice(Guid deviceId)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        Guid? uid = Guid.TryParse(userId, out var parsed) ? parsed : null;
        var now = DateTime.UtcNow;

        var alerts = await _db.Alerts
            .Where(a => a.DeviceId == deviceId && (a.Status == "open" || a.Status == "acked"))
            .ToListAsync();

        foreach (var a in alerts)
        {
            a.Status   = "closed";
            a.ClosedAt = now;
            _db.AlertHistories.Add(new AlertHistory
            {
                AlertId   = a.Id,
                Status    = "closed",
                ChangedBy = uid,
                Note      = "Đóng hàng loạt bởi người dùng",
            });
        }

        await _db.SaveChangesAsync();

        // Trigger tính lại health score ngay
        _ = _healthWorker.RecalculateNowAsync();

        return Ok(new { closed = alerts.Count, deviceId });
    }

    /// <summary>
    /// Xuất danh sách cảnh báo ra file CSV để tải về.
    /// Hỗ trợ lọc theo trạng thái và khoảng thời gian.
    /// </summary>
    // GET /api/v1/alerts/export?status=&from=&to= → CSV
    [HttpGet("export")]
    public async Task<IActionResult> Export(
        [FromQuery] string? status,
        [FromQuery] DateTime? from,
        [FromQuery] DateTime? to)
    {
        var q = _db.Alerts.AsQueryable();
        if (!string.IsNullOrEmpty(status)) q = q.Where(a => a.Status == status);
        if (from.HasValue) q = q.Where(a => a.TriggeredAt >= from.Value);
        if (to.HasValue)   q = q.Where(a => a.TriggeredAt <= to.Value);
        var alerts = await q.OrderByDescending(a => a.TriggeredAt).ToListAsync();

        // Lấy tên thiết bị
        var deviceIds = alerts.Where(a => a.DeviceId.HasValue).Select(a => a.DeviceId!.Value).Distinct().ToList();
        var deviceNames = await _db.Devices
            .Where(d => deviceIds.Contains(d.Id))
            .ToDictionaryAsync(d => d.Id, d => d.Name);

        var sb = new System.Text.StringBuilder();
        sb.AppendLine("STT,Thời gian,Trạm,Thiết bị,Nguồn,Mức độ,Trạng thái,Điểm,Giá trị,Nội dung");
        
        int stt = 1;
        foreach (var a in alerts)
        {
            var devName = a.DeviceId.HasValue && deviceNames.TryGetValue(a.DeviceId.Value, out var n) ? n : "";
            
            // Map labels to match frontend
            var levelStr = a.Level?.ToLower() switch { 
                "alarm" => "Báo động", 
                "warning" => "Cảnh báo", 
                "info" => "Thông tin", 
                _ => a.Level 
            };
            
            var statusStr = a.Status?.ToLower() switch { 
                "open" => "Chưa xử lý", 
                "acked" => "Đang xử lý", 
                "closed" => "Đã xử lý", 
                _ => a.Status 
            };
            
            var timeStr = a.TriggeredAt.ToString("dd/MM/yyyy HH:mm:ss");

            sb.AppendLine(string.Join(",",
                stt++,
                Esc(timeStr),
                Esc(a.StationId.ToString()),
                Esc(devName),
                Esc(a.Source ?? ""),
                Esc(levelStr ?? ""),
                Esc(statusStr ?? ""),
                Esc(a.PointId ?? ""),
                Esc(a.Value?.ToString("F2") ?? ""),
                Esc(a.Message ?? "")
            ));
        }

        var bytes = System.Text.Encoding.UTF8.GetPreamble()
            .Concat(System.Text.Encoding.UTF8.GetBytes(sb.ToString())).ToArray();
        return File(bytes, "text/csv", $"alerts_{DateTime.Now:yyyyMMdd_HHmm}.csv");
    }

    /// <summary>
    /// Gửi cảnh báo thủ công lên trạm tổng.
    /// </summary>
    // POST /api/v1/alerts/{id}/send-central
    [HttpPost("{id:guid}/send-central")]
    public async Task<IActionResult> SendToCentral(Guid id)
    {
        var alert = await _db.Alerts.FindAsync(id);
        if (alert == null) return NotFound();

        var centralUrl = _config["CentralServer"]?.TrimEnd('/');
        var stationId = _config["StationId"];

        if (string.IsNullOrEmpty(centralUrl))
        {
            return BadRequest(new { error = "Trạm chưa được cấu hình địa chỉ Trạm tổng (CentralServer trong appsettings.json)." });
        }

        if (string.IsNullOrEmpty(stationId))
        {
            return BadRequest(new { error = "Trạm chưa được cấu hình StationId." });
        }

        try
        {
            var client = _httpClientFactory.CreateClient();
            client.DefaultRequestHeaders.Add("X-Station-Id", stationId);
            client.Timeout = TimeSpan.FromSeconds(15);

            var payload = new[]
            {
                new
                {
                    id = alert.Id,
                    station_id = alert.StationId,
                    device_id = alert.DeviceId,
                    rule_id = alert.RuleId,
                    source = alert.Source,
                    level = alert.Level,
                    status = alert.Status,
                    message = alert.Message,
                    value = alert.Value,
                    triggered_at = alert.TriggeredAt,
                    image_url = alert.ImageUrl,
                    thumbnail_url = alert.ThumbnailUrl,
                    video_url = alert.VideoUrl
                }
            };

            var url = $"{centralUrl}/api/v1/ingest/alerts";
            var response = await client.PostAsJsonAsync(url, payload);

            if (response.IsSuccessStatusCode)
            {
                return Ok(new { success = true, message = "Gửi cảnh báo lên trạm tổng thành công." });
            }
            else
            {
                var body = await response.Content.ReadAsStringAsync();
                return StatusCode((int)response.StatusCode, new { error = "Lỗi phản hồi từ trạm tổng", details = body });
            }
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { error = "Không thể kết nối đến trạm tổng", details = ex.Message });
        }
    }

    private static string Esc(string? v) =>
        v == null ? "" : $"\"{v.Replace("\"", "\"\"")}\"";
}

public class AckRequest
{
    public string? Note { get; set; }
}
