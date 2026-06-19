// ============================================================
// UsersController — Quản lý tài khoản người dùng
// Routes:
//   GET    /api/v1/users          — Danh sách users (admin only)
//   POST   /api/v1/users          — Tạo user mới (admin only)
//   PUT    /api/v1/users/{id}     — Sửa thông tin (admin only)
//   POST   /api/v1/users/{id}/change-password — Đổi mật khẩu
//   DELETE /api/v1/users/{id}     — Vô hiệu hóa (admin only)
//
// Restricted admin (admin + StationIds):
//   - Chỉ thấy/quản lý user thuộc trạm mình phụ trách
//   - Không tạo được global admin (admin không có StationIds)
//   - Không đụng được user ngoài scope trạm
// ============================================================

using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using StationOS.Data;
using StationOS.Data.Entities;
using Microsoft.AspNetCore.SignalR;
using StationOS.Api.Hubs;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1/users")]
[Authorize]
public class UsersController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IHubContext<RealtimeHub> _hubContext;

    public UsersController(AppDbContext db, IHubContext<RealtimeHub> hubContext)
    {
        _db = db;
        _hubContext = hubContext;
    }

    // Lấy danh sách StationId mà caller được phép quản lý. null = không giới hạn.
    private (bool isRestricted, Guid[]? stationIds) GetCallerScope()
    {
        var isRestricted = User.FindFirstValue("isRestricted") == "true";
        if (!isRestricted) return (false, null);
        var raw = User.FindFirstValue("stationIds") ?? "";
        var ids = raw.Split(',', StringSplitOptions.RemoveEmptyEntries)
                     .Select(s => Guid.TryParse(s, out var g) ? g : (Guid?)null)
                     .Where(g => g.HasValue).Select(g => g!.Value).ToArray();
        return (true, ids.Length > 0 ? ids : null);
    }

    // Kiểm tra user B có nằm trong scope của restricted admin không.
    // Một user thuộc scope nếu StationIds của B giao khác rỗng với stationIds của caller.
    private static bool UserInScope(Guid[]? targetStationIds, Guid[] callerStationIds)
    {
        if (targetStationIds == null || targetStationIds.Length == 0) return false;
        return targetStationIds.Any(id => callerStationIds.Contains(id));
    }

    /// <summary>Danh sách users. Restricted admin chỉ thấy user thuộc trạm của mình.</summary>
    [HttpGet]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> GetAll()
    {
        var (isRestricted, callerStationIds) = GetCallerScope();

        var query = _db.Users.OrderByDescending(u => u.CreatedAt);
        var all = await query.Select(u => new
        {
            u.Id, u.Username, u.FullName, u.Email,
            u.Role, u.IsActive, u.StationIds, u.CreatedAt
        }).ToListAsync();

        if (isRestricted && callerStationIds != null)
        {
            all = all.Where(u => UserInScope(u.StationIds, callerStationIds)).ToList();
        }

        return Ok(all);
    }

    /// <summary>Tạo user mới. Restricted admin không tạo được global admin và chỉ gán trạm trong scope.</summary>
    [HttpPost]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> Create([FromBody] CreateUserRequest req)
    {
        var (isRestricted, callerStationIds) = GetCallerScope();

        if (await _db.Users.AnyAsync(u => u.Username == req.Username))
            return BadRequest(new { message = $"Tên đăng nhập '{req.Username}' đã tồn tại" });

        if (string.IsNullOrWhiteSpace(req.Password) || req.Password.Length < 6)
            return BadRequest(new { message = "Mật khẩu phải ít nhất 6 ký tự" });

        var validRoles = new[] { "operator", "manager", "admin" };
        var role = req.Role?.ToLower() ?? "operator";
        if (!validRoles.Contains(role))
            return BadRequest(new { message = "Vai trò không hợp lệ (operator|manager|admin)" });

        var stationIds = req.StationIds;

        if (isRestricted && callerStationIds != null)
        {
            // Restricted admin không được tạo global admin (admin không có station)
            if (role == "admin" && (stationIds == null || stationIds.Length == 0))
                return Forbid();

            // Buộc StationIds phải là subset của caller's stations
            if (stationIds != null && stationIds.Length > 0)
                stationIds = stationIds.Intersect(callerStationIds).ToArray();
            else
                stationIds = callerStationIds; // Mặc định gán trạm của caller
        }

        var user = new User
        {
            Username     = req.Username.Trim(),
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(req.Password),
            FullName     = req.FullName?.Trim(),
            Email        = req.Email?.Trim(),
            Role         = role,
            IsActive     = true,
            StationIds   = stationIds
        };

        _db.Users.Add(user);
        await _db.SaveChangesAsync();

        return Ok(new
        {
            user.Id, user.Username, user.FullName,
            user.Email, user.Role, user.IsActive, user.StationIds, user.CreatedAt
        });
    }

    /// <summary>Sửa thông tin user. Restricted admin chỉ sửa user trong scope trạm.</summary>
    [HttpPut("{id:guid}")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateUserRequest req)
    {
        var (isRestricted, callerStationIds) = GetCallerScope();

        var user = await _db.Users.FindAsync(id);
        if (user == null) return NotFound(new { message = "Không tìm thấy người dùng" });

        if (isRestricted && callerStationIds != null && !UserInScope(user.StationIds, callerStationIds))
            return Forbid();

        if (req.FullName != null) user.FullName = req.FullName.Trim();
        if (req.Email    != null) user.Email    = req.Email.Trim();
        if (req.Role     != null)
        {
            var validRoles = new[] { "operator", "manager", "admin" };
            if (!validRoles.Contains(req.Role.ToLower()))
                return BadRequest(new { message = "Vai trò không hợp lệ" });

            // Restricted admin không được nâng user thành global admin
            if (isRestricted && req.Role.ToLower() == "admin" &&
                (user.StationIds == null || user.StationIds.Length == 0))
                return Forbid();

            user.Role = req.Role.ToLower();
        }
        if (req.IsActive.HasValue) user.IsActive = req.IsActive.Value;
        if (req.StationIds != null)
        {
            var newIds = req.StationIds;
            // Restricted admin chỉ gán trạm trong scope của mình
            if (isRestricted && callerStationIds != null)
                newIds = newIds.Intersect(callerStationIds).ToArray();
            user.StationIds = newIds;
        }

        await _db.SaveChangesAsync();
        await _hubContext.Clients.All.SendAsync("UserStatusChange", new { username = user.Username, status = "updated", ts = DateTime.UtcNow });

        return Ok(new
        {
            user.Id, user.Username, user.FullName,
            user.Email, user.Role, user.IsActive, user.StationIds, user.CreatedAt
        });
    }

    /// <summary>
    /// Đổi mật khẩu:
    ///   Admin → có thể đổi bất kỳ user nào (trong scope nếu restricted)
    ///   User thường → chỉ đổi của mình + cần cung cấp old password
    /// </summary>
    [HttpPost("{id:guid}/change-password")]
    public async Task<IActionResult> ChangePassword(Guid id, [FromBody] ChangePasswordRequest req)
    {
        var currentUserId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        var currentRole   = User.FindFirstValue(ClaimTypes.Role);
        var isAdmin       = currentRole == "admin";

        if (!isAdmin && currentUserId != id.ToString())
            return Forbid();

        var user = await _db.Users.FindAsync(id);
        if (user == null) return NotFound(new { message = "Không tìm thấy người dùng" });

        // Restricted admin chỉ đổi mật khẩu user trong scope
        if (isAdmin && currentUserId != id.ToString())
        {
            var (isRestricted, callerStationIds) = GetCallerScope();
            if (isRestricted && callerStationIds != null && !UserInScope(user.StationIds, callerStationIds))
                return Forbid();
        }

        if (!isAdmin)
        {
            if (string.IsNullOrEmpty(req.OldPassword))
                return BadRequest(new { message = "Cần cung cấp mật khẩu cũ" });
            if (!BCrypt.Net.BCrypt.Verify(req.OldPassword, user.PasswordHash))
                return BadRequest(new { message = "Mật khẩu cũ không đúng" });
        }

        if (string.IsNullOrWhiteSpace(req.NewPassword) || req.NewPassword.Length < 6)
            return BadRequest(new { message = "Mật khẩu mới phải ít nhất 6 ký tự" });

        user.PasswordHash = BCrypt.Net.BCrypt.HashPassword(req.NewPassword);
        await _db.SaveChangesAsync();

        return Ok(new { message = "Đổi mật khẩu thành công" });
    }

    /// <summary>Vô hiệu hóa user. Restricted admin chỉ vô hiệu user trong scope trạm.</summary>
    [HttpDelete("{id:guid}")]
    [Authorize(Roles = "admin")]
    public async Task<IActionResult> Deactivate(Guid id)
    {
        var currentUserId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (currentUserId == id.ToString())
            return BadRequest(new { message = "Không thể vô hiệu hóa tài khoản của chính mình" });

        var (isRestricted, callerStationIds) = GetCallerScope();

        var user = await _db.Users.FindAsync(id);
        if (user == null) return NotFound(new { message = "Không tìm thấy người dùng" });

        if (isRestricted && callerStationIds != null && !UserInScope(user.StationIds, callerStationIds))
            return Forbid();

        if (!user.IsActive)
            return BadRequest(new { message = "Tài khoản đã bị vô hiệu hóa" });

        user.IsActive = false;
        await _db.SaveChangesAsync();
        await _hubContext.Clients.All.SendAsync("UserStatusChange", new { username = user.Username, status = "deactivated", ts = DateTime.UtcNow });

        return Ok(new { message = $"Đã vô hiệu hóa tài khoản '{user.Username}'" });
    }
}

// ── Request Models ─────────────────────────────────────────
public record CreateUserRequest(
    string Username,
    string Password,
    string? FullName,
    string? Email,
    string? Role,
    Guid[]? StationIds
);

public record UpdateUserRequest(
    string? FullName,
    string? Email,
    string? Role,
    bool?   IsActive,
    Guid[]? StationIds
);

public record ChangePasswordRequest(
    string? OldPassword,  // Bắt buộc nếu không phải admin
    string  NewPassword
);
