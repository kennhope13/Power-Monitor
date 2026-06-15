// ============================================================
// LicenseController — Quản lý license key
// GET  /api/v1/license/status   — public, trả về trạng thái
// POST /api/v1/license/activate — yêu cầu admin JWT
// POST /api/v1/license/validate — public, kiểm tra key (không kích hoạt)
// ============================================================

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using StationOS.Services;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1/license")]
public class LicenseController : ControllerBase
{
    private readonly LicenseService _license;

    public LicenseController(LicenseService license) => _license = license;

    /// <summary>Lấy trạng thái license hiện tại: tier, số người dùng tối đa, ngày hết hạn, số phiên đang hoạt động.</summary>
    /// <returns>Thông tin license đang kích hoạt hoặc activated = false nếu chưa kích hoạt.</returns>
    [HttpGet("status")]
    public async Task<IActionResult> Status()
    {
        var status = await _license.GetStatusAsync();
        if (status == null)
            return Ok(new { activated = false });

        return Ok(new
        {
            activated      = true,
            tier           = status.Tier,
            maxUsers       = status.MaxUsers,
            maxDevices     = status.MaxDevices,
            maxCameras     = status.MaxCameras,
            maxRoiPoints   = status.MaxRoiPoints,
            maxRoiRegions  = status.MaxRoiRegions,
            maxPdRegions   = status.MaxPdRegions,
            expiresAt      = status.ExpiresAt,
            activatedAt    = status.ActivatedAt,
            activeSessions = status.ActiveSessions,
            isValid        = status.IsValid,
            daysRemaining  = (int)(status.ExpiresAt - DateTime.UtcNow).TotalDays
        });
    }

    /// <summary>Kích hoạt license key cho hệ thống. Yêu cầu quyền admin.</summary>
    /// <param name="req">License key cần kích hoạt.</param>
    /// <returns>Thông báo kích hoạt thành công hoặc lỗi nếu key không hợp lệ.</returns>
    [Authorize(Roles = "admin")]
    [HttpPost("activate")]
    public async Task<IActionResult> Activate([FromBody] LicenseKeyRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Key))
            return BadRequest(new { message = "Thiếu license key" });

        var (success, error) = await _license.ActivateAsync(req.Key);
        if (!success)
            return BadRequest(new { message = error });

        return Ok(new { message = "Kích hoạt license thành công" });
    }

    /// <summary>Kiểm tra tính hợp lệ của license key mà không kích hoạt. Trả về tier, maxUsers, ngày hết hạn nếu hợp lệ.</summary>
    /// <param name="req">License key cần kiểm tra.</param>
    /// <returns>Kết quả kiểm tra: valid, tier, maxUsers, expiresAt, daysRemaining.</returns>
    [HttpPost("validate")]
    public IActionResult Validate([FromBody] LicenseKeyRequest req)
    {
        var (valid, tier, maxUsers, maxDevices, maxCameras, maxRoiPoints, maxRoiRegions, maxPdRegions, expiresAt, error) = _license.ValidateKey(req.Key ?? "");
        if (!valid)
            return BadRequest(new { valid = false, message = error });

        return Ok(new
        {
            valid,
            tier,
            maxUsers,
            maxDevices,
            maxCameras,
            maxRoiPoints = maxRoiPoints,
            maxRoiRegions = maxRoiRegions,
            maxPdRegions = maxPdRegions,
            expiresAt,
            daysRemaining = (int)(expiresAt - DateTime.UtcNow).TotalDays
        });
    }
}

public record LicenseKeyRequest(string? Key);
