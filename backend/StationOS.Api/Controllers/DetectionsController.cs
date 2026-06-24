// ============================================================
// DetectionsController — Lấy danh sách camera detection events
// GET /api/v1/detections
// GET /api/v1/detections/{id}
// ============================================================

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using StationOS.Data;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1/detections")]
[Authorize]
public class DetectionsController : ControllerBase
{
    private readonly AppDbContext _db;
    public DetectionsController(AppDbContext db) => _db = db;

    /// <summary>Lấy danh sách sự kiện phát hiện từ camera (AI detection events).</summary>
    /// <param name="deviceId">Lọc theo camera.</param>
    /// <param name="type">Lọc theo loại phát hiện.</param>
    /// <param name="from">Từ thời điểm.</param>
    /// <param name="to">Đến thời điểm.</param>
    /// <param name="limit">Số lượng tối đa (max 500).</param>
    /// <returns>Danh sách detection event kèm tên camera.</returns>
    // GET /api/v1/detections?deviceId=&type=&from=&to=&limit=100
    [ResponseCache(Duration = 30, Location = ResponseCacheLocation.Any)]
    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] Guid?   deviceId,
        [FromQuery] string? type,
        [FromQuery] DateTime? from,
        [FromQuery] DateTime? to,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 50)
    {
        var q = _db.DetectionEvents
            .AsNoTracking()
            .Include(e => e.Camera)
            .AsQueryable();

        if (deviceId.HasValue)           q = q.Where(e => e.CameraId == deviceId);
        if (!string.IsNullOrEmpty(type)) q = q.Where(e => e.DetectionType == type);
        if (from.HasValue)               q = q.Where(e => e.DetectedAt >= from.Value);
        if (to.HasValue)                 q = q.Where(e => e.DetectedAt <= to.Value);

        var events = await q
            .OrderByDescending(e => e.DetectedAt)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(e => new
            {
                e.Id,
                e.CameraId,
                cameraName    = e.Camera != null ? e.Camera.Name : null,
                e.DetectionType,
                e.DetectedAt,
                e.MaxTemp,
                e.AffectedZone,
                e.AlertId,
                e.Metadata,
            })
            .ToListAsync();

        return Ok(events);
    }

    /// <summary>Lấy chi tiết 1 sự kiện phát hiện theo ID.</summary>
    /// <param name="id">Detection event ID.</param>
    /// <returns>Chi tiết event kèm tên camera hoặc 404.</returns>
    // GET /api/v1/detections/{id}
    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id)
    {
        var e = await _db.DetectionEvents
            .Include(e => e.Camera)
            .Where(e => e.Id == id)
            .Select(e => new
            {
                e.Id, e.CameraId,
                cameraName    = e.Camera != null ? e.Camera.Name : null,
                e.DetectionType, e.DetectedAt,
                e.MaxTemp, e.AffectedZone, e.AlertId, e.Metadata,
            })
            .FirstOrDefaultAsync();

        if (e == null) return NotFound();
        return Ok(e);
    }
}
