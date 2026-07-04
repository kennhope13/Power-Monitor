// ============================================================
// LicenseController — Quản lý license key + file .lic
// GET  /api/v1/license/status    — trạng thái hiện tại
// GET  /api/v1/license/limits    — giới hạn hiện tại
// GET  /api/v1/license/request   — fingerprint máy trạm
// POST /api/v1/license/activate  — kích hoạt legacy key
// POST /api/v1/license/validate  — kiểm tra legacy key hoặc file .lic
// POST /api/v1/license/import    — import file .lic
// ============================================================

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using StationOS.Services;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1/license")]
public class LicenseController : ControllerBase
{
    private readonly LicenseService _license;

    public LicenseController(LicenseService license) => _license = license;

    [ResponseCache(Duration = 30, Location = ResponseCacheLocation.Any)]
    [HttpGet("status")]
    public async Task<IActionResult> Status()
    {
        var status = await _license.GetStatusAsync();
        if (status == null)
            return Ok(new { activated = false, state = "missing", message = "Chưa có license" });

        return Ok(new
        {
            activated = true,
            tier = status.Tier,
            maxUsers = status.MaxUsers,
            maxDevices = status.MaxDevices,
            maxCameras = status.MaxCameras,
            maxRoiPoints = status.MaxRoiPoints,
            maxRoiRegions = status.MaxRoiRegions,
            maxPdRegions = status.MaxPdRegions,
            expiresAt = status.ExpiresAt,
            activatedAt = status.ActivatedAt,
            activeSessions = status.ActiveSessions,
            isValid = status.IsValid,
            daysRemaining = (int)(status.ExpiresAt - DateTime.UtcNow).TotalDays,
            source = status.Source,
            state = status.State,
            message = status.Message,
            addonCount = status.AddonCount,
            baseLicenseId = status.BaseLicenseId,
            hardwareFingerprint = status.HardwareFingerprint
        });
    }

    [ResponseCache(Duration = 30, Location = ResponseCacheLocation.Any)]
    [HttpGet("limits")]
    public async Task<IActionResult> Limits()
    {
        var status = await _license.GetStatusAsync();
        if (status == null)
            return Ok(new { activated = false, state = "missing", message = "Chưa có license" });

        return Ok(new
        {
            activated = true,
            maxUsers = status.MaxUsers,
            maxDevices = status.MaxDevices,
            maxCameras = status.MaxCameras,
            maxRoiPoints = status.MaxRoiPoints,
            maxRoiRegions = status.MaxRoiRegions,
            maxPdRegions = status.MaxPdRegions,
            expiresAt = status.ExpiresAt,
            isValid = status.IsValid,
            daysRemaining = (int)(status.ExpiresAt - DateTime.UtcNow).TotalDays,
            source = status.Source,
            state = status.State,
            message = status.Message,
            addonCount = status.AddonCount
        });
    }

    [HttpGet("request")]
    public async Task<IActionResult> RequestInfo()
    {
        var request = await _license.GetRequestInfoAsync();
        return Ok(request);
    }

    [HttpGet("sessions")]
    public IActionResult Sessions()
    {
        return Ok(_license.GetActiveSessionsForDebug());
    }

    [Authorize(Roles = "admin")]
    [HttpPost("activate")]
    public async Task<IActionResult> Activate([FromBody] LicenseKeyRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Key))
            return BadRequest(new { message = "Thiếu license key" });

        var (success, error) = await _license.ActivateAsync(req.Key);
        if (!success)
            return BadRequest(new { message = error });

        return Ok(new { message = "Kích hoạt license thành công", activated = true });
    }

    [HttpPost("validate")]
    public async Task<IActionResult> Validate()
    {
        if (Request.HasFormContentType)
        {
            var form = await Request.ReadFormAsync();
            var file = form.Files.GetFile("file") ?? form.Files.FirstOrDefault();
            if (file == null || file.Length == 0)
                return BadRequest(new { valid = false, message = "Thiếu file license .lic" });

            await using var ms = new MemoryStream();
            await file.CopyToAsync(ms);
            var result = await _license.ValidateLicenseFileAsync(file.FileName, ms.ToArray());
            if (!result.Valid)
                return BadRequest(new
                {
                    valid = false,
                    source = result.Source,
                    state = result.State,
                    message = result.Message,
                    kind = result.Kind,
                    licenseId = result.LicenseId,
                    addonId = result.AddonId,
                    hardwareFingerprint = result.HardwareFingerprint
                });

            return Ok(new
            {
                valid = true,
                source = result.Source,
                state = result.State,
                message = result.Message,
                tier = result.Tier,
                maxUsers = result.Limits?.MaxUsers ?? 0,
                maxDevices = result.Limits?.MaxDevices ?? 0,
                maxCameras = result.Limits?.MaxCameras ?? 0,
                maxRoiPoints = result.Limits?.MaxRoiPoints ?? 0,
                maxRoiRegions = result.Limits?.MaxRoiRegions ?? 0,
                maxPdRegions = result.Limits?.MaxPdRegions ?? 0,
                expiresAt = result.ExpiresAt,
                kind = result.Kind,
                licenseId = result.LicenseId,
                addonId = result.AddonId,
                hardwareFingerprint = result.HardwareFingerprint
            });
        }

        var req = await Request.ReadFromJsonAsync<LicenseKeyRequest>() ?? new LicenseKeyRequest(null);
        var (valid, tier, maxUsers, maxDevices, maxCameras, maxRoiPoints, maxRoiRegions, maxPdRegions, expiresAt, error) = _license.ValidateKey(req.Key ?? "");
        if (!valid)
            return BadRequest(new { valid = false, source = "legacy", message = error });

        return Ok(new
        {
            valid = true,
            source = "legacy",
            state = expiresAt < DateTime.UtcNow ? "expired" : "active",
            message = expiresAt < DateTime.UtcNow ? "License đã hết hạn" : "Legacy key hợp lệ",
            tier,
            maxUsers,
            maxDevices,
            maxCameras,
            maxRoiPoints,
            maxRoiRegions,
            maxPdRegions,
            expiresAt,
            daysRemaining = (int)(expiresAt - DateTime.UtcNow).TotalDays
        });
    }

    [Authorize(Roles = "admin")]
    [HttpPost("import")]
    [Consumes("multipart/form-data")]
    public async Task<IActionResult> Import([FromForm] IFormFile? file)
    {
        if (file == null || file.Length == 0)
            return BadRequest(new { message = "Thiếu file license .lic" });

        await using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        var result = await _license.ImportLicenseAsync(file.FileName, ms.ToArray());
        if (!result.Success)
            return BadRequest(new
            {
                message = result.Message,
                state = result.State,
                licenseId = result.LicenseId,
                addonId = result.AddonId,
                tier = result.Tier
            });

        return Ok(new
        {
            message = result.Message,
            savedFile = result.SavedFile,
            licenseId = result.LicenseId,
            addonId = result.AddonId,
            tier = result.Tier,
            state = result.State
        });
    }

    [Authorize(Roles = "admin")]
    [HttpDelete("clear")]
    public async Task<IActionResult> ClearAll()
    {
        await _license.ClearAllLicensesAsync();
        return Ok(new { message = "Đã xoá toàn bộ license. Hệ thống sẵn sàng để kích hoạt giftcode mới." });
    }
}

public record LicenseKeyRequest(string? Key);
