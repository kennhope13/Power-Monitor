// ============================================================
// AuthController — REST API xác thực người dùng
// Routes:
//   POST /api/v1/auth/login   — Đăng nhập → JWT (8h)
//   POST /api/v1/auth/refresh — Refresh token
//   GET  /api/v1/auth/me      — Thông tin user hiện tại (cần JWT)
// ============================================================

using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using StationOS.Data;
using StationOS.Data.Entities;
using StationOS.Services;
using StationOS.Services.Auth;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1/auth")]
public class AuthController : ControllerBase
{
    private readonly AuthService _auth;
    private readonly AppDbContext _db;
    private readonly LicenseService _license;

    public AuthController(AuthService auth, AppDbContext db, LicenseService license)
    {
        _auth    = auth;
        _db      = db;
        _license = license;
    }

    /// <summary>
    /// Đăng nhập bằng username/password
    /// Trả về: JWT token (8h), refresh token, thông tin user
    /// Lỗi 401: sai thông tin hoặc tài khoản bị khóa
    /// </summary>
    [HttpPost("login")]
    [EnableRateLimiting("login")]  // 5 attempts/min/IP — chống brute force
    public async Task<IActionResult> Login([FromBody] LoginRequest req)
    {
        var result = await _auth.LoginAsync(req.Username, req.Password);
        if (result == null)
            return Unauthorized(new { message = "Tên đăng nhập hoặc mật khẩu không đúng" });

        var (token, refreshToken, user, sessionId) = result.Value;

        // Kiểm tra license: giới hạn concurrent users
        var jwtExpiry  = DateTime.UtcNow.AddDays(3650);
        var (allowed, reason) = await _license.TryAcquireSessionAsync(sessionId, user.Id.ToString(), jwtExpiry);
        if (!allowed)
            return StatusCode(403, new { message = "Đã đạt giới hạn thiết bị đăng nhập đồng thời. Vui lòng cập nhật License Key mới để sử dụng thêm thiết bị." });

        // Lưu refresh token vào SystemSettings (đơn giản, không cần bảng riêng)
        await SaveRefreshTokenAsync(user.Id, refreshToken, sessionId);

        return Ok(new
        {
            token,
            refreshToken,
            licenseReason = reason, // "no_license" | "expired" | ""
            mustChangePassword = user.MustChangePassword, // FE chuyển sang trang đổi password
            user = new
            {
                id = user.Id,
                username = user.Username,
                fullName = user.FullName,
                role = user.Role,
                email = user.Email
            }
        });
    }

    /// <summary>
    /// Đổi password user hiện tại.
    /// Body: { oldPassword, newPassword }
    /// </summary>
    [HttpPost("change-password")]
    [Authorize]
    public async Task<IActionResult> ChangePassword([FromBody] SelfChangePasswordRequest req)
    {
        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (!Guid.TryParse(userIdClaim, out var userId))
            return Unauthorized();

        var (ok, error) = await _auth.ChangePasswordAsync(userId, req.OldPassword, req.NewPassword);
        if (!ok) return BadRequest(new { message = error });
        return Ok(new { message = "Đổi mật khẩu thành công" });
    }

    /// <summary>
    /// Refresh JWT token bằng refresh token
    /// Nhận: { refreshToken: string }
    /// Trả về: JWT mới + refresh token mới
    /// </summary>
    [HttpPost("refresh")]
    public async Task<IActionResult> Refresh([FromBody] RefreshRequest req)
    {
        if (string.IsNullOrEmpty(req.RefreshToken))
            return BadRequest(new { message = "Thiếu refresh token" });

        // Tìm user có refresh token này trong SystemSettings (key: refresh_token_{userId})
        var settings = await _db.SystemSettings
            .Where(s => s.Key.StartsWith("refresh_token_"))
            .ToListAsync();

        // Unwrap JSON value
        static string UnwrapJson(string val)
        {
            if (val.StartsWith("\"") && val.EndsWith("\"") && val.Length >= 2)
                return val[1..^1];
            return val;
        }

        RefreshTokenData? matchedToken = null;
        SystemSettings? match = null;
        foreach (var s in settings)
        {
            try
            {
                var data = System.Text.Json.JsonSerializer.Deserialize<RefreshTokenData>(s.Value);
                if (data != null && data.RefreshToken == req.RefreshToken)
                {
                    matchedToken = data;
                    match = s;
                    break;
                }
            }
            catch
            {
                var unwrapped = UnwrapJson(s.Value);
                if (unwrapped == req.RefreshToken)
                {
                    matchedToken = new RefreshTokenData { RefreshToken = unwrapped, SessionId = Guid.NewGuid().ToString() };
                    match = s;
                    break;
                }
            }
        }

        if (match == null || matchedToken == null)
            return Unauthorized(new { message = "Refresh token không hợp lệ hoặc đã hết hạn" });

        var user = await _db.Users.FindAsync(match.UpdatedBy);
        if (user == null || !user.IsActive)
            return Unauthorized(new { message = "Tài khoản không tồn tại hoặc bị vô hiệu hóa" });

        // Verify that the session is still active/allowed
        var sessionId = matchedToken.SessionId;
        if (!_license.IsSessionActive(sessionId))
        {
            // Try to register it (if server restarted or if there's room)
            var registered = _license.TryRegisterOnRequest(sessionId, user.Id.ToString(), DateTime.UtcNow.AddDays(3650));
            if (!registered)
            {
                return Unauthorized(new { message = "Phiên hoạt động đã bị đăng xuất từ thiết bị khác" });
            }
        }

        // Issue new tokens
        var newToken = _auth.GenerateJwt(user, sessionId);
        var newRefreshToken = AuthService.GenerateRefreshToken();
        await SaveRefreshTokenAsync(user.Id, newRefreshToken, sessionId);

        return Ok(new
        {
            token = newToken,
            refreshToken = newRefreshToken,
            user = new
            {
                id = user.Id,
                username = user.Username,
                fullName = user.FullName,
                role = user.Role,
                email = user.Email
            }
        });
    }

    /// <summary>
    /// Lấy thông tin user hiện tại từ JWT token
    /// Yêu cầu: Header Authorization: Bearer {token}
    /// </summary>
    [Authorize]
    [HttpGet("me")]
    public IActionResult Me()
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        var username = User.FindFirstValue(ClaimTypes.Name);
        var role = User.FindFirstValue(ClaimTypes.Role);
        var fullName = User.FindFirstValue("fullName");

        return Ok(new { userId, username, role, fullName });
    }

    /// <summary>
    /// Đăng xuất — hủy bỏ phiên hoạt động trên server
    /// Yêu cầu: Header Authorization: Bearer {token}
    /// </summary>
    [Authorize]
    [HttpPost("logout")]
    public async Task<IActionResult> Logout()
    {
        var sessionId = User.FindFirst("sessionId")?.Value;
        if (string.IsNullOrEmpty(sessionId))
        {
            var rawToken = Request.Headers["Authorization"].ToString().Replace("Bearer ", "").Trim();
            if (!string.IsNullOrEmpty(rawToken))
            {
                var hashBytes = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(rawToken));
                sessionId = "legacy_" + Convert.ToHexString(hashBytes)[..16];
            }
        }

        if (!string.IsNullOrEmpty(sessionId))
        {
            _license.ReleaseSession(sessionId);
        }

        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (!string.IsNullOrEmpty(userId))
        {
            var station = await _db.Stations.FirstOrDefaultAsync();
            if (station != null)
            {
                var key = $"refresh_token_{userId}";
                var existing = await _db.SystemSettings
                    .FirstOrDefaultAsync(s => s.StationId == station.Id && s.Key == key);
                if (existing != null)
                {
                    _db.SystemSettings.Remove(existing);
                    await _db.SaveChangesAsync();
                }
            }
        }

        return Ok(new { message = "Đăng xuất thành công" });
    }

    // ── Helpers ──────────────────────────────────────────────
    private async Task SaveRefreshTokenAsync(Guid userId, string token, string sessionId)
    {
        // Lưu refresh token trong SystemSettings với key riêng mỗi user
        // Dùng station ID thật để không vi phạm FK constraint
        var station = await _db.Stations.FirstOrDefaultAsync();
        if (station == null) return; // Chưa có station — bỏ qua

        var key = $"refresh_token_{userId}";
        var data = new RefreshTokenData { RefreshToken = token, SessionId = sessionId };
        var jsonValue = System.Text.Json.JsonSerializer.Serialize(data);

        var existing = await _db.SystemSettings
            .FirstOrDefaultAsync(s => s.StationId == station.Id && s.Key == key);

        if (existing == null)
        {
            _db.SystemSettings.Add(new SystemSettings
            {
                StationId = station.Id,
                Key       = key,
                Value     = jsonValue,
                UpdatedBy = userId,
                UpdatedAt = DateTime.UtcNow
            });
        }
        else
        {
            existing.Value     = jsonValue;
            existing.UpdatedBy = userId;
            existing.UpdatedAt = DateTime.UtcNow;
        }

        await _db.SaveChangesAsync();
    }
}

public class RefreshTokenData
{
    public string RefreshToken { get; set; } = "";
    public string SessionId { get; set; } = "";
}

// ── Request Models ────────────────────────────────────────
public record LoginRequest(string Username, string Password);
public record RefreshRequest(string RefreshToken);
public record SelfChangePasswordRequest(string OldPassword, string NewPassword);
