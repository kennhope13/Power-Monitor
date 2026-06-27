// ============================================================
// StationsController — CRUD trạm biến áp
// GET    /api/v1/stations        — Danh sách trạm
// GET    /api/v1/stations/{id}   — Chi tiết 1 trạm
// POST   /api/v1/stations        — Tạo trạm mới (Admin)
// PUT    /api/v1/stations/{id}   — Cập nhật trạm (Admin)
// DELETE /api/v1/stations/{id}   — Xóa trạm (Admin)
// ============================================================

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using StationOS.Data;
using StationOS.Data.Entities;
using StationOS.Services;

using System.Net.Http;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1/stations")]
[Authorize]
public class StationsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly PermissionService _permissions;
    private readonly IHttpClientFactory _httpClientFactory;
    public StationsController(AppDbContext db, PermissionService permissions, IHttpClientFactory httpClientFactory)
    {
        _db = db;
        _permissions = permissions;
        _httpClientFactory = httpClientFactory;
    }

    /// <summary>Lấy danh sách trạm biến áp. Operator chỉ thấy trạm được phân quyền.</summary>
    /// <returns>Danh sách trạm (id, name, code, location, status, createdAt).</returns>
    [HttpGet]
    public async Task<IActionResult> GetAll()
    {
        var allowed = await _permissions.GetAllowedStationIdsAsync();
        var q = _db.Stations.AsQueryable();
        if (allowed != null) q = q.Where(s => allowed.Contains(s.Id));

        var stations = await q
            .OrderBy(s => s.Name)
            .Select(s => new {
                s.Id, s.Name, s.Code, s.Location, s.Status, s.CreatedAt
            }).ToListAsync();
        return Ok(stations);
    }

    /// <summary>Lấy chi tiết 1 trạm theo ID.</summary>
    /// <param name="id">Station ID.</param>
    /// <returns>Đối tượng Station hoặc 404.</returns>
    [HttpGet("{id:guid}")]
    public async Task<IActionResult> GetById(Guid id)
    {
        var s = await _db.Stations.FindAsync(id);
        if (s == null) return NotFound();
        return Ok(s);
    }

    /// <summary>Tạo trạm mới. Chỉ admin.</summary>
    /// <param name="req">Thông tin trạm (name, code, location).</param>
    /// <returns>Station vừa tạo với status 201 Created.</returns>
    [HttpPost]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> Create([FromBody] StationRequest req)
    {
        var station = new Station
        {
            Name     = req.Name,
            Code     = req.Code,
            Location = req.Location,
            Status   = "active"
        };
        _db.Stations.Add(station);
        await _db.SaveChangesAsync();
        return CreatedAtAction(nameof(GetById), new { id = station.Id }, station);
    }

    /// <summary>Cập nhật thông tin trạm. Chỉ admin.</summary>
    /// <param name="id">Station ID.</param>
    /// <param name="req">Thông tin cần cập nhật.</param>
    /// <returns>Station đã cập nhật.</returns>
    [HttpPut("{id:guid}")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> Update(Guid id, [FromBody] StationRequest req)
    {
        var station = await _db.Stations.FindAsync(id);
        if (station == null) return NotFound();

        station.Name     = req.Name;
        station.Code     = req.Code;
        station.Location = req.Location;
        if (!string.IsNullOrWhiteSpace(req.Status))
            station.Status = req.Status;

        await _db.SaveChangesAsync();
        return Ok(station);
    }

    /// <summary>Xóa trạm. Chỉ admin, và chỉ khi trạm không còn thiết bị nào.</summary>
    /// <param name="id">Station ID.</param>
    /// <returns>204 NoContent hoặc 400 nếu còn thiết bị.</returns>
    [HttpDelete("{id:guid}")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> Delete(Guid id)
    {
        var station = await _db.Stations.FindAsync(id);
        if (station == null) return NotFound();

        // Kiểm tra xem có thiết bị nào thuộc trạm này không
        var hasDevices = await _db.Devices.AnyAsync(d => d.StationId == id);
        if (hasDevices)
            return BadRequest(new { message = "Không thể xóa trạm đang có thiết bị. Xóa thiết bị trước." });

        _db.Stations.Remove(station);
        await _db.SaveChangesAsync();
        return NoContent();
    }

    private async Task<IActionResult> ProxyToLocalAiEngineAsync(string subPath, string? queryString = null)
    {
        try
        {
            using var client = _httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(10);

            var url = $"http://127.0.0.1:8100{subPath}";
            if (!string.IsNullOrEmpty(queryString))
            {
                url += queryString;
            }

            var resp = await client.GetAsync(url);
            var body = await resp.Content.ReadAsStringAsync();
            return Content(body, "application/json");
        }
        catch (Exception ex)
        {
            return StatusCode(503, new { error = "ai_engine_unreachable", detail = ex.Message });
        }
    }

    [HttpGet("local-prediction-history")]
    public async Task<IActionResult> GetLocalPredictionHistory()
    {
        return await ProxyToLocalAiEngineAsync("/api/prediction/history", Request.QueryString.Value);
    }

    [HttpGet("local-latest-prediction")]
    public async Task<IActionResult> GetLocalLatestPrediction()
    {
        return await ProxyToLocalAiEngineAsync("/api/latest-prediction", Request.QueryString.Value);
    }

    [HttpGet("local-training-status")]
    public async Task<IActionResult> GetLocalTrainingStatus()
    {
        return await ProxyToLocalAiEngineAsync("/api/training-status", Request.QueryString.Value);
    }

    [HttpGet("local-prediction-config")]
    public async Task<IActionResult> GetLocalPredictionConfig()
    {
        return await ProxyToLocalAiEngineAsync("/api/config", Request.QueryString.Value);
    }
}

/// <summary>Request DTO cho tạo/cập nhật trạm.</summary>
/// <param name="Name">Tên trạm (bắt buộc).</param>
/// <param name="Code">Mã trạm.</param>
/// <param name="Location">Vị trí dạng JSON {"lat","lng","address"}.</param>
/// <param name="Status">Trạng thái: active | inactive | maintenance.</param>
public record StationRequest(string Name, string? Code, string? Location, string? Status);
