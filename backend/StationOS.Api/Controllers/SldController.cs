// ============================================================
// SldController — Sơ đồ một sợi (Single Line Diagram)
// GET    /api/v1/sld/{stationId}          → SldFile active + SldPoints + devices chưa đặt
// POST   /api/v1/sld/{stationId}/upload   → Upload SVG (lưu vào wwwroot/sld/)
// POST   /api/v1/sld/{stationId}/points   → Tạo điểm mới (đặt thiết bị lên sơ đồ)
// PUT    /api/v1/sld/points/{id}           → Di chuyển / đổi label
// DELETE /api/v1/sld/points/{id}           → Xóa điểm khỏi sơ đồ
// ============================================================

using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using StationOS.Data;
using StationOS.Data.Entities;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1/sld")]
[Authorize]
public class SldController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IWebHostEnvironment _env;

    public SldController(AppDbContext db, IWebHostEnvironment env)
    {
        _db = db;
        _env = env;
    }

    // ── GET /api/v1/sld/{stationId} ──────────────────────────
    // Trả về: svgUrl, points (đã đặt), unpinned (chưa đặt)
    /// <summary>Lấy thông tin sơ đồ một sợi của trạm: file SVG, danh sách điểm đã đặt và thiết bị chưa đặt.</summary>
    /// <param name="stationId">ID của trạm.</param>
    /// <returns>svgUrl, version, danh sách points đã gắn thiết bị, và unpinned (chưa đặt lên sơ đồ).</returns>
    [HttpGet("{stationId:guid}")]
    public async Task<IActionResult> Get(Guid stationId)
    {
        // SldFile active của trạm (nếu có)
        var sldFile = await _db.SldFiles
            .Where(f => f.StationId == stationId && f.IsActive)
            .OrderByDescending(f => f.Version)
            .FirstOrDefaultAsync();

        // SldPoints của file này kèm thông tin device
        var points = new List<object>();
        var pinnedDeviceIds = new HashSet<Guid>();

        var sldFilePoints = new List<SldPoint>();
        if (sldFile != null)
        {
            sldFilePoints = await _db.SldPoints
                .Where(p => p.SldFileId == sldFile.Id)
                .Include(p => p.Device)
                .ToListAsync();

            foreach (var p in sldFilePoints)
            {
                if (p.DeviceId.HasValue) pinnedDeviceIds.Add(p.DeviceId.Value);
                points.Add(new
                {
                    p.Id, p.PointId, p.Label, p.X, p.Y, p.R,
                    p.DeviceId,
                    deviceName   = p.Device?.Name,
                    deviceType   = p.Device?.Type,
                    deviceStatus = p.Device?.Status,
                });
            }
        }

        // Thiết bị chưa được đặt lên sơ đồ
        var allDevices = await _db.Devices
            .Where(d => d.StationId == stationId)
            .ToListAsync();

        var unpinned = new List<object>();
        foreach (var d in allDevices)
        {
          if (d.Type == "plc_s7")
          {
            var hasUnifiedPin = sldFilePoints.Any(p => p.DeviceId == d.Id && p.PointId == d.Id.ToString());

            // 1. Unified PLC icon (shows all data)
            if (!hasUnifiedPin)
            {
              unpinned.Add(new { d.Id, name = $"{d.Name} (Tất cả)", d.Type, d.Status, sensorTag = (string?)null });
            }

            // 2. Specific sub-sensors — chỉ hiện nếu chưa pin "Tất cả"
            if (!hasUnifiedPin)
            {
              string[] plcTags = { "nhiet_do_pha_1", "nhiet_do_pha_2", "nhiet_do_pha_3", "phong_dien" };
              foreach (var tag in plcTags)
              {
                if (!sldFilePoints.Any(p => p.DeviceId == d.Id && p.PointId == tag))
                {
                  unpinned.Add(new { d.Id, name = $"{d.Name} ({tag.Replace("nhiet_do_", "").Replace("_", " ")})", d.Type, d.Status, sensorTag = tag });
                }
              }
            }
          }
          else
          {
            // Other devices: 1 point per device
            if (!pinnedDeviceIds.Contains(d.Id))
            {
              unpinned.Add(new { d.Id, d.Name, d.Type, d.Status, sensorTag = (string?)null });
            }
          }
        }

        // Nhúng version vào URL để browser cache đúng — mỗi lần upload mới URL thay đổi
        var svgUrlVersioned = sldFile?.SvgUrl != null
            ? $"{sldFile.SvgUrl}?v={sldFile.Version}"
            : null;

        return Ok(new
        {
            sldFileId = sldFile?.Id,
            svgUrl    = svgUrlVersioned,
            version   = sldFile?.Version ?? 0,
            points,
            unpinned,
        });
    }

    // ── POST /api/v1/sld/{stationId}/upload ──────────────────
    // Nhận: multipart/form-data field "file" (.svg)
    // Lưu vào wwwroot/sld/{stationId}.svg, trả về svgUrl
    /// <summary>Upload file SVG sơ đồ một sợi cho trạm. Tự động tạo phiên bản mới và sao chép các điểm từ bản cũ. Yêu cầu quyền admin hoặc manager.</summary>
    /// <param name="stationId">ID của trạm.</param>
    /// <param name="file">File SVG cần upload.</param>
    /// <returns>sldFileId, svgUrl có version cache-busting, và số version mới.</returns>
    [HttpPost("{stationId:guid}/upload")]
    [Authorize(Roles = "admin,manager")]
    public async Task<IActionResult> Upload(Guid stationId, IFormFile file)
    {
        if (file == null || file.Length == 0)
            return BadRequest(new { message = "Không có file" });

        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        if (ext != ".svg")
            return BadRequest(new { message = "Chỉ chấp nhận file .svg" });

        // Lưu file vào wwwroot/sld/
        var sldDir = Path.Combine(_env.WebRootPath, "sld");
        Directory.CreateDirectory(sldDir);

        var fileName = $"{stationId}.svg";
        var filePath = Path.Combine(sldDir, fileName);

        await using (var stream = System.IO.File.Create(filePath))
            await file.CopyToAsync(stream);

        var svgUrl = $"/sld/{fileName}";

        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        Guid? uid  = Guid.TryParse(userId, out var parsed) ? parsed : null;

        // Đánh dấu file cũ là inactive và lấy danh sách điểm cũ
        var oldFiles = await _db.SldFiles
            .Where(f => f.StationId == stationId && f.IsActive)
            .ToListAsync();
            
        var oldPoints = new List<SldPoint>();
        if (oldFiles.Any())
        {
            var oldActiveFile = oldFiles.OrderByDescending(f => f.Version).First();
            oldPoints = await _db.SldPoints.Where(p => p.SldFileId == oldActiveFile.Id).ToListAsync();
            
            foreach (var f in oldFiles) f.IsActive = false;
        }

        // Tạo SldFile mới
        var maxVersion = oldFiles.Any() ? oldFiles.Max(f => f.Version) : 0;
        var newFile = new SldFile
        {
            StationId  = stationId,
            Version    = maxVersion + 1,
            SvgUrl     = svgUrl,
            UploadedBy = uid,
            IsActive   = true,
        };
        _db.SldFiles.Add(newFile);
        
        // Copy các node cũ sang bản vẽ mới
        foreach(var oldPoint in oldPoints)
        {
            _db.SldPoints.Add(new SldPoint
            {
                SldFileId = newFile.Id,
                DeviceId  = oldPoint.DeviceId,
                PointId   = oldPoint.PointId,
                Label     = oldPoint.Label,
                X         = oldPoint.X,
                Y         = oldPoint.Y,
                R         = oldPoint.R
            });
        }
        
        await _db.SaveChangesAsync();

        return Ok(new { sldFileId = newFile.Id, svgUrl = $"{svgUrl}?v={newFile.Version}", version = newFile.Version });
    }

    // ── POST /api/v1/sld/{stationId}/points ──────────────────
    // Đặt thiết bị lên sơ đồ: tạo SldPoint mới
    /// <summary>Đặt thiết bị lên sơ đồ một sợi — tạo SldPoint mới. Yêu cầu quyền admin hoặc manager.</summary>
    /// <param name="stationId">ID của trạm.</param>
    /// <param name="req">Thông tin điểm: DeviceId, tọa độ X/Y, bán kính R, label và PointId tùy chọn.</param>
    /// <returns>Điểm vừa tạo kèm thông tin thiết bị liên kết.</returns>
    [HttpPost("{stationId:guid}/points")]
    [Authorize(Roles = "admin,manager")]
    public async Task<IActionResult> AddPoint(Guid stationId, [FromBody] AddPointRequest req)
    {
        // Lấy SldFile active (hoặc tạo placeholder nếu chưa upload SVG)
        var sldFile = await _db.SldFiles
            .Where(f => f.StationId == stationId && f.IsActive)
            .OrderByDescending(f => f.Version)
            .FirstOrDefaultAsync();

        if (sldFile == null)
        {
            // Tạo SldFile trống để có thể lưu điểm trước khi upload SVG
            sldFile = new SldFile
            {
                StationId = stationId,
                Version   = 1,
                IsActive  = true,
            };
            _db.SldFiles.Add(sldFile);
            await _db.SaveChangesAsync();
        }

        // Cho phép nhiều điểm nếu DeviceId giống nhau nhưng PointId khác nhau (như PLC có nhiều cảm biến)
        if (req.DeviceId.HasValue)
        {
            var pointIdToUse = req.PointId ?? req.DeviceId.Value.ToString();
            var existing = await _db.SldPoints
                .Where(p => p.SldFileId == sldFile.Id && p.DeviceId == req.DeviceId && p.PointId == pointIdToUse)
                .FirstOrDefaultAsync();
            if (existing != null) _db.SldPoints.Remove(existing);
        }

        var device = req.DeviceId.HasValue
            ? await _db.Devices.FindAsync(req.DeviceId.Value)
            : null;

        var point = new SldPoint
        {
            SldFileId = sldFile.Id,
            DeviceId  = req.DeviceId,
            PointId   = req.PointId ?? req.DeviceId?.ToString() ?? Guid.NewGuid().ToString(),
            Label     = req.Label ?? device?.Name ?? "Điểm",
            X         = req.X,
            Y         = req.Y,
            R         = req.R > 0 ? req.R : 10,
        };
        _db.SldPoints.Add(point);
        await _db.SaveChangesAsync();

        return Ok(new
        {
            point.Id, point.PointId, point.Label, point.X, point.Y, point.R,
            point.DeviceId,
            deviceName   = device?.Name,
            deviceType   = device?.Type,
            deviceStatus = device?.Status,
        });
    }

    // ── PUT /api/v1/sld/points/{id} ──────────────────────────
    // Di chuyển điểm hoặc đổi label / radius
    /// <summary>Cập nhật vị trí, bán kính hoặc nhãn của điểm trên sơ đồ. Yêu cầu quyền admin hoặc manager.</summary>
    /// <param name="id">ID của SldPoint.</param>
    /// <param name="req">Các trường cần cập nhật: X, Y, R, Label (tất cả tùy chọn).</param>
    /// <returns>Điểm đã cập nhật hoặc 404 nếu không tìm thấy.</returns>
    [HttpPut("points/{id:guid}")]
    [Authorize(Roles = "admin,manager")]
    public async Task<IActionResult> UpdatePoint(Guid id, [FromBody] UpdatePointRequest req)
    {
        var point = await _db.SldPoints.FindAsync(id);
        if (point == null) return NotFound();

        if (req.X.HasValue) point.X = req.X.Value;
        if (req.Y.HasValue) point.Y = req.Y.Value;
        if (req.R.HasValue) point.R = req.R.Value;
        if (req.Label != null) point.Label = req.Label;

        await _db.SaveChangesAsync();
        return Ok(new { point.Id, point.X, point.Y, point.R, point.Label });
    }

    // ── DELETE /api/v1/sld/points/{id} ───────────────────────
    // Xóa điểm → thiết bị quay lại danh sách unpinned
    /// <summary>Xóa điểm khỏi sơ đồ — thiết bị liên kết sẽ quay lại danh sách unpinned. Yêu cầu quyền admin hoặc manager.</summary>
    /// <param name="id">ID của SldPoint cần xóa.</param>
    /// <returns>Thông báo xóa thành công hoặc 404 nếu không tìm thấy.</returns>
    [HttpDelete("points/{id:guid}")]
    [Authorize(Roles = "admin,manager")]
    public async Task<IActionResult> DeletePoint(Guid id)
    {
        var point = await _db.SldPoints.FindAsync(id);
        if (point == null) return NotFound();
        _db.SldPoints.Remove(point);
        await _db.SaveChangesAsync();
        return Ok(new { message = "Đã xóa điểm khỏi sơ đồ" });
    }
}

// ── Request Models ─────────────────────────────────────────
public record AddPointRequest(
    Guid?  DeviceId,
    double X,
    double Y,
    double R = 10,
    string? Label = null,
    string? PointId = null
);

public record UpdatePointRequest(
    double? X,
    double? Y,
    double? R,
    string? Label
);
