// ============================================================
// BoundariesController — Vẽ vùng polygon trên camera
// Dùng cho:
//   - PD detection: blob siêu âm trong vùng nào → tag tên vùng
//   - Intrusion: object crossing
//   - ROI: vùng quan tâm thermal
//
// Endpoints:
//   GET    /api/v1/devices/{deviceId}/boundaries
//   POST   /api/v1/devices/{deviceId}/boundaries
//   PUT    /api/v1/boundaries/{id}
//   DELETE /api/v1/boundaries/{id}
//   GET    /api/v1/boundaries/{id}   — chi tiết 1 boundary
// ============================================================

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using StationOS.Data;
using StationOS.Data.Entities;
using StationOS.Services;
using StationOS.Services.Devices;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1")]
public class BoundariesController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _permissions;
    private readonly IRealtimeNotifier _notifier;
    private readonly DeviceService _deviceService;
    private readonly LicenseService _license;

    public BoundariesController(AppDbContext db, PermissionService permissions, IRealtimeNotifier notifier, DeviceService deviceService, LicenseService license)
    {
        _db = db;
        _permissions = permissions;
        _notifier = notifier;
        _deviceService = deviceService;
        _license = license;
    }

    /// <summary>Lấy danh sách vùng polygon đã định nghĩa trên camera.</summary>
    [HttpGet("devices/{deviceId:guid}/boundaries")]
    [AllowAnonymous]  // AI Engine cần đọc khi khởi động
    public async Task<IActionResult> GetByDevice(Guid deviceId, [FromQuery] string? type)
    {
        var query = _db.Boundaries.Where(b => b.DeviceId == deviceId);
        if (!string.IsNullOrEmpty(type))
            query = query.Where(b => b.Type == type);

        var items = await query
            .OrderBy(b => b.Name)
            .Select(b => new {
                b.Id, b.DeviceId, b.Name, b.Type,
                Polygon       = b.PolygonJson,
                Thresholds    = b.ThresholdsJson,
                b.SeverityLevel, b.Enabled,
                b.CreatedAt, b.UpdatedAt
            })
            .ToListAsync();

        return Ok(items);
    }

    /// <summary>Chi tiết 1 boundary.</summary>
    [HttpGet("boundaries/{id:guid}")]
    [AllowAnonymous]
    public async Task<IActionResult> GetById(Guid id)
    {
        var b = await _db.Boundaries.FindAsync(id);
        if (b == null) return NotFound();
        return Ok(new {
            b.Id, b.DeviceId, b.Name, b.Type,
            Polygon       = b.PolygonJson,
            Thresholds    = b.ThresholdsJson,
            b.SeverityLevel, b.Enabled,
            b.CreatedAt, b.UpdatedAt
        });
    }

    /// <summary>Tạo boundary mới cho camera. Auto-save từ FE (vẽ xong là gửi).</summary>
    [HttpPost("devices/{deviceId:guid}/boundaries")]
    [Authorize]
    public async Task<IActionResult> Create(Guid deviceId, [FromBody] BoundaryRequest req)
    {
        var device = await _db.Devices.FindAsync(deviceId);
        if (device == null) return NotFound(new { error = "Không tìm thấy thiết bị" });

        if (string.IsNullOrWhiteSpace(req.Name))
            return BadRequest(new { error = "Tên không được rỗng" });
        if (string.IsNullOrWhiteSpace(req.Polygon) || req.Polygon == "[]")
            return BadRequest(new { error = "Polygon không hợp lệ" });

        var licenseStatus = await _license.GetStatusAsync();
        var boundaryType = string.IsNullOrEmpty(req.Type) ? "pd" : req.Type.ToLower();

        if (boundaryType == "roi")
        {
            var maxRoiRegions = licenseStatus != null ? licenseStatus.MaxRoiRegions : 5;
            var currentRoiRegions = await _db.Boundaries.CountAsync(x => x.Type == "roi");
            if (currentRoiRegions >= maxRoiRegions)
            {
                return BadRequest(new { error = $"Số lượng vùng nhiệt đã đạt giới hạn tối đa ({maxRoiRegions} vùng). Vui lòng nâng cấp license key để tiếp tục." });
            }
        }
        else if (boundaryType == "pd")
        {
            var maxPdRegions = licenseStatus != null ? licenseStatus.MaxPdRegions : 5;
            var currentPdRegions = await _db.Boundaries.CountAsync(x => x.Type == "pd");
            if (currentPdRegions >= maxPdRegions)
            {
                return BadRequest(new { error = $"Số lượng vùng phóng điện đã đạt giới hạn tối đa ({maxPdRegions} vùng). Vui lòng nâng cấp license key để tiếp tục." });
            }
        }

        var b = new Boundary
        {
            DeviceId       = deviceId,
            Name           = req.Name.Trim(),
            Type           = string.IsNullOrEmpty(req.Type) ? "pd" : req.Type,
            PolygonJson    = req.Polygon,
            ThresholdsJson = req.Thresholds,
            SeverityLevel  = req.SeverityLevel ?? "warning",
            Enabled        = req.Enabled ?? true,
        };
        _db.Boundaries.Add(b);
        await _db.SaveChangesAsync();

        // Push SignalR để AI Engine + UI khác biết
        await _notifier.SendCameraEventAsync(new {
            type     = "BoundaryCreated",
            deviceId = deviceId,
            boundary = new { b.Id, b.Name, b.Type, polygon = b.PolygonJson }
        });

        if (b.Type == "roi")
        {
            await _deviceService.SyncThermalConfigToAIEngineAsync(deviceId);
        }

        return CreatedAtAction(nameof(GetById), new { id = b.Id }, new {
            b.Id, b.DeviceId, b.Name, b.Type,
            Polygon       = b.PolygonJson,
            Thresholds    = b.ThresholdsJson,
            b.SeverityLevel, b.Enabled,
            b.CreatedAt, b.UpdatedAt
        });
    }

    /// <summary>Sửa boundary (tên, polygon, ngưỡng, enable/disable).</summary>
    [HttpPut("boundaries/{id:guid}")]
    [Authorize]
    public async Task<IActionResult> Update(Guid id, [FromBody] BoundaryRequest req)
    {
        var b = await _db.Boundaries.FindAsync(id);
        if (b == null) return NotFound();

        if (!string.IsNullOrWhiteSpace(req.Name))            b.Name = req.Name.Trim();
        if (!string.IsNullOrWhiteSpace(req.Type))            b.Type = req.Type;
        if (!string.IsNullOrWhiteSpace(req.Polygon))         b.PolygonJson = req.Polygon;
        if (req.Thresholds != null)                          b.ThresholdsJson = req.Thresholds;
        if (!string.IsNullOrWhiteSpace(req.SeverityLevel))   b.SeverityLevel = req.SeverityLevel;
        if (req.Enabled.HasValue)                            b.Enabled = req.Enabled.Value;
        b.UpdatedAt = DateTime.UtcNow;

        await _db.SaveChangesAsync();

        await _notifier.SendCameraEventAsync(new {
            type     = "BoundaryUpdated",
            deviceId = b.DeviceId,
            boundary = new { b.Id, b.Name, b.Type, polygon = b.PolygonJson }
        });

        if (b.Type == "roi")
        {
            await _deviceService.SyncThermalConfigToAIEngineAsync(b.DeviceId);
        }

        return Ok(new {
            b.Id, b.DeviceId, b.Name, b.Type,
            Polygon       = b.PolygonJson,
            Thresholds    = b.ThresholdsJson,
            b.SeverityLevel, b.Enabled, b.UpdatedAt
        });
    }

    /// <summary>Xóa boundary.</summary>
    [HttpDelete("boundaries/{id:guid}")]
    [Authorize]
    public async Task<IActionResult> Delete(Guid id)
    {
        var b = await _db.Boundaries.FindAsync(id);
        if (b == null) return NotFound();

        var deviceId = b.DeviceId;
        var wasRoi = b.Type == "roi";

        // Gỡ FK trước khi xóa: set BoundaryId = null cho các bản ghi liên quan
        await _db.DetectionEvents
            .Where(e => e.BoundaryId == id)
            .ExecuteUpdateAsync(s => s.SetProperty(e => e.BoundaryId, (Guid?)null));
        await _db.Alerts
            .Where(a => a.BoundaryId == id)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.BoundaryId, (Guid?)null));

        _db.Boundaries.Remove(b);
        await _db.SaveChangesAsync();

        await _notifier.SendCameraEventAsync(new {
            type     = "BoundaryDeleted",
            deviceId = deviceId,
            boundary = new { Id = id }
        });

        if (wasRoi)
        {
            await _deviceService.SyncThermalConfigToAIEngineAsync(deviceId);
        }

        return NoContent();
    }
}

public record BoundaryRequest(
    string Name,
    string? Type,                // pd | intrusion | roi
    string Polygon,              // JSON array [[x,y]...]
    string? Thresholds,          // JSON
    string? SeverityLevel,       // info | warning | alarm
    bool? Enabled
);
