using Microsoft.AspNetCore.Mvc;
using StationOS.Services;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1/dashboard")]
public class DashboardController : ControllerBase
{
    private readonly LicenseService _license;

    public DashboardController(LicenseService license) => _license = license;

    /// <summary>
    /// Return combined data needed for the initial dashboard load: license status, limits and active session count.
    /// Cached for 30 seconds via ResponseCache middleware.
    /// </summary>
    [ResponseCache(Duration = 30, Location = ResponseCacheLocation.Any)]
    [HttpGet("init")]
    public async Task<IActionResult> Init()
    {
        var status = await _license.GetStatusAsync();
        if (status == null)
        {
            return Ok(new { activated = false });
        }

        var result = new
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
            daysRemaining = (int)(status.ExpiresAt - DateTime.UtcNow).TotalDays
        };
        return Ok(result);
    }
}
