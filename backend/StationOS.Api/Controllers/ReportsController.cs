// ============================================================
// ReportsController
// POST /api/v1/reports/generate   — Tạo báo cáo PDF ngay
// GET  /api/v1/reports            — Danh sách báo cáo
// GET  /api/v1/reports/{id}/download — Tải file PDF
// DELETE /api/v1/reports/{id}     — Xóa báo cáo
// ============================================================

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using StationOS.Data;
using StationOS.Services.Reports;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1/reports")]
[Authorize]
public class ReportsController : ControllerBase
{
    private readonly AppDbContext           _db;
    private readonly ReportGeneratorService _generator;
    private readonly IWebHostEnvironment    _env;

    public ReportsController(AppDbContext db, ReportGeneratorService generator, IWebHostEnvironment env)
    {
        _db        = db;
        _generator = generator;
        _env       = env;
    }

    // ── Tạo báo cáo ─────────────────────────────────────────
    /// <summary>Tạo báo cáo PDF ngay lập tức theo loại (daily, monthly, event) và khoảng thời gian.</summary>
    /// <param name="req">Tham số báo cáo: stationId, type, from, to.</param>
    /// <returns>Thông tin báo cáo vừa tạo kèm đường dẫn file PDF.</returns>
    [HttpPost("generate")]
    public async Task<IActionResult> Generate([FromBody] GenerateRequest req)
    {
        if (req.From >= req.To)
            return BadRequest("from phải trước to");

        var validTypes = new[] { "daily", "monthly", "event" };
        if (!validTypes.Contains(req.Type))
            return BadRequest($"type phải là: {string.Join(", ", validTypes)}");

        // Lấy userId từ JWT
        var userIdStr = User.FindFirst("sub")?.Value ?? User.FindFirst("nameid")?.Value;
        Guid? userId  = Guid.TryParse(userIdStr, out var uid) ? uid : null;

        var opts   = new ReportOptions(req.StationId, req.Type, req.From, req.To, userId);
        var report = await _generator.GenerateAsync(opts);

        // Đẩy lên trạm tổng
        _db.SyncQueues.Add(new StationOS.Data.Entities.SyncQueue
        {
            EntityType = "Report",
            EntityId   = report.Id,
            Payload    = System.Text.Json.JsonSerializer.Serialize(MapReport(report)),
        });
        await _db.SaveChangesAsync();

        return Ok(MapReport(report));
    }

    // ── Danh sách báo cáo ───────────────────────────────────
    /// <summary>Lấy danh sách báo cáo đã tạo, sắp xếp theo thời gian mới nhất.</summary>
    /// <param name="stationId">Lọc theo trạm (tùy chọn).</param>
    /// <param name="limit">Số lượng tối đa trả về (mặc định 50).</param>
    /// <returns>Danh sách báo cáo.</returns>
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] Guid? stationId, [FromQuery] int limit = 50)
    {
        var q = _db.Reports.AsQueryable();
        if (stationId.HasValue) q = q.Where(r => r.StationId == stationId);

        var reports = await q
            .OrderByDescending(r => r.GeneratedAt)
            .Take(limit)
            .ToListAsync();

        return Ok(reports.Select(MapReport));
    }

    // ── Tải file PDF ────────────────────────────────────────
    /// <summary>Tải xuống file PDF của báo cáo.</summary>
    /// <param name="id">ID của báo cáo.</param>
    /// <returns>File PDF với tên theo loại và kỳ báo cáo, hoặc 404 nếu không tìm thấy.</returns>
    [HttpGet("{id:guid}/download")]
    public async Task<IActionResult> Download(Guid id)
    {
        var report = await _db.Reports.FindAsync(id);
        if (report == null || report.FileUrl == null)
            return NotFound("Báo cáo không tồn tại hoặc chưa có file");

        var filePath = Path.Combine(_env.WebRootPath ?? Path.Combine(_env.ContentRootPath, "wwwroot"), report.FileUrl.TrimStart('/'));
        if (!System.IO.File.Exists(filePath))
            return NotFound("File PDF không tìm thấy trên máy chủ");

        var typeLabels = new Dictionary<string, string>
        {
            ["daily"]   = "BaoCao_Ngay",
            ["monthly"] = "BaoCao_Thang",
            ["event"]   = "BaoCao_SuCo",
        };
        var prefix   = typeLabels.GetValueOrDefault(report.Type, "BaoCao");
        var period   = report.PeriodFrom.HasValue
            ? report.PeriodFrom.Value.ToString("yyyyMMdd")
            : report.GeneratedAt.ToString("yyyyMMdd");
        var fileName = $"{prefix}_{period}.pdf";

        var bytes = await System.IO.File.ReadAllBytesAsync(filePath);
        return File(bytes, "application/pdf", fileName);
    }

    // ── Xóa báo cáo ─────────────────────────────────────────
    /// <summary>Xóa báo cáo và file PDF tương ứng. Yêu cầu quyền admin hoặc manager.</summary>
    /// <param name="id">ID của báo cáo cần xóa.</param>
    /// <returns>204 NoContent nếu thành công hoặc 404 nếu không tìm thấy.</returns>
    [HttpDelete("{id:guid}")]
    [Authorize(Roles = "admin,manager")]
    public async Task<IActionResult> Delete(Guid id)
    {
        var report = await _db.Reports.FindAsync(id);
        if (report == null) return NotFound();

        // Xóa file
        if (report.FileUrl != null)
        {
            var filePath = Path.Combine(_env.WebRootPath, report.FileUrl.TrimStart('/'));
            var wwwRoot = _env.WebRootPath ?? Path.Combine(_env.ContentRootPath, "wwwroot");
        filePath = Path.Combine(wwwRoot, report.FileUrl!.TrimStart('/'));
        if (System.IO.File.Exists(filePath)) System.IO.File.Delete(filePath);
        }

        _db.Reports.Remove(report);
        await _db.SaveChangesAsync();
        return NoContent();
    }

    private static object MapReport(StationOS.Data.Entities.Report r) => new
    {
        r.Id,
        r.StationId,
        r.Type,
        r.PeriodFrom,
        r.PeriodTo,
        r.FileUrl,
        r.GeneratedBy,
        r.GeneratedAt,
    };
}

public record GenerateRequest(
    Guid     StationId,
    string   Type,
    DateTime From,
    DateTime To);
