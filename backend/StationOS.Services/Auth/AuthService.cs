// ============================================================
// AuthService — Xử lý đăng nhập và tạo JWT token
// Dùng: BCrypt để hash/verify password
//        System.IdentityModel.Tokens.Jwt để tạo token
// Ghi: LoginLog mỗi lần đăng nhập thành công
// ============================================================

using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.IdentityModel.Tokens;
using StationOS.Data;
using StationOS.Data.Entities;

namespace StationOS.Services.Auth;

public class AuthService
{
    private readonly AppDbContext _db;
    private readonly IConfiguration _config;

    public AuthService(AppDbContext db, IConfiguration config)
    {
        _db = db;
        _config = config;
    }

    /// <summary>
    /// Đăng nhập: kiểm tra username/password → trả JWT + refreshToken
    /// Trả null nếu sai thông tin hoặc tài khoản bị vô hiệu
    /// </summary>
    public async Task<(string token, string refreshToken, User user, string sessionId)?> LoginAsync(string username, string password)
    {
        // Tìm user active trong DB
        var user = await _db.Users
            .FirstOrDefaultAsync(u => u.Username == username && u.IsActive);

        // BCrypt.Verify so sánh password nhập với hash trong DB
        if (user == null || !BCrypt.Net.BCrypt.Verify(password, user.PasswordHash))
            return null;

        var sessionId = Guid.NewGuid().ToString();
        var token = GenerateJwt(user, sessionId);
        var refreshToken = GenerateRefreshToken();

        // Update last login timestamp
        user.LastLoginAt = DateTime.UtcNow;

        // Ghi log đăng nhập vào bảng LoginLogs
        _db.LoginLogs.Add(new LoginLog
        {
            UserId = user.Id,
            Username = user.Username,
            Action = "login"
        });
        await _db.SaveChangesAsync();

        return (token, refreshToken, user, sessionId);
    }

    /// <summary>
    /// Đổi password user — verify password cũ + set hash mới + clear MustChangePassword.
    /// Validate password mạnh (tối thiểu 12 ký tự, có HOA, thường, số, ký tự đặc biệt).
    /// </summary>
    public async Task<(bool ok, string? error)> ChangePasswordAsync(Guid userId, string oldPassword, string newPassword)
    {
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == userId);
        if (user == null) return (false, "Không tìm thấy người dùng");

        if (!BCrypt.Net.BCrypt.Verify(oldPassword, user.PasswordHash))
            return (false, "Mật khẩu cũ không chính xác");

        // Validate strength - Cấp độ sản xuất (min 12 ký tự, HOA, thường, số, ký tự đặc biệt)
        if (newPassword.Length < 12)
            return (false, "Mật khẩu mới phải có độ dài tối thiểu 12 ký tự");
        if (!newPassword.Any(char.IsUpper))
            return (false, "Mật khẩu mới phải chứa ít nhất 1 chữ cái viết HOA");
        if (!newPassword.Any(char.IsLower))
            return (false, "Mật khẩu mới phải chứa ít nhất 1 chữ cái viết thường");
        if (!newPassword.Any(char.IsDigit))
            return (false, "Mật khẩu mới phải chứa ít nhất 1 chữ số");
        if (!newPassword.Any(c => !char.IsLetterOrDigit(c)))
            return (false, "Mật khẩu mới phải chứa ít nhất 1 ký tự đặc biệt (ví dụ: @, #, $, ...)");
        if (newPassword == oldPassword)
            return (false, "Mật khẩu mới không được trùng với mật khẩu cũ");

        user.PasswordHash = BCrypt.Net.BCrypt.HashPassword(newPassword, workFactor: 12);
        user.MustChangePassword = false;
        user.LastPasswordChangedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return (true, null);
    }

    /// <summary>
    /// Tạo JWT token chứa: userId, username, role, fullName
    /// Hết hạn sau ExpiryMinutes phút (config trong appsettings.json)
    /// </summary>
    public string GenerateJwt(User user, string sessionId)
    {
        var key = new SymmetricSecurityKey(
            Encoding.UTF8.GetBytes(_config["Jwt:Key"]!));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var claims = new List<Claim>
        {
            new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new Claim(ClaimTypes.Name, user.Username),
            new Claim(ClaimTypes.Role, user.Role),
            new Claim("fullName", user.FullName ?? user.Username),
            new Claim("sessionId", sessionId)
        };

        if (user.StationIds != null && user.StationIds.Length > 0)
        {
            claims.Add(new Claim("isRestricted", "true"));
            claims.Add(new Claim("stationIds", string.Join(",", user.StationIds)));
        }

        var token = new JwtSecurityToken(
            issuer: _config["Jwt:Issuer"],
            audience: _config["Jwt:Audience"],
            claims: claims,
            expires: DateTime.UtcNow.AddMinutes(
                int.Parse(_config["Jwt:ExpiryMinutes"]!)),
            signingCredentials: creds);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    /// <summary>
    /// Tạo refresh token ngẫu nhiên 64 bytes (base64)
    /// TODO: lưu vào DB để validate khi refresh
    /// </summary>
    public static string GenerateRefreshToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(64);
        return Convert.ToBase64String(bytes);
    }

    /// <summary>
    /// Seed tài khoản admin mặc định nếu bảng Users còn trống
    /// Chạy 1 lần khi khởi động lần đầu
    /// Tài khoản: admin / Admin@123
    /// </summary>
    public async Task SeedAdminIfNotExistsAsync()
    {
        // 1. Upsert stationadmin (Trạm con)
        var admin = await _db.Users.FirstOrDefaultAsync(u => u.Username == "stationadmin");
        if (admin == null)
        {
            admin = new User { Username = "stationadmin", Role = "admin" };
            _db.Users.Add(admin);
        }
        admin.PasswordHash = BCrypt.Net.BCrypt.HashPassword("Station@123", workFactor: 12);
        admin.FullName = "Quản trị viên";
        admin.Email = "admin@StationOS.vn";
        admin.IsActive = true;
        admin.MustChangePassword = false;

        // 2. Upsert multi (Đa trạm)
        var multi = await _db.Users.FirstOrDefaultAsync(u => u.Username == "multi");
        if (multi == null)
        {
            multi = new User { Username = "multi", Role = "admin" };
            _db.Users.Add(multi);
        }
        multi.PasswordHash = BCrypt.Net.BCrypt.HashPassword("Demo@2024", workFactor: 12);
        multi.FullName = "Quản trị viên Đa trạm";
        multi.Email = "multi@StationOS.vn";
        multi.IsActive = true;
        multi.MustChangePassword = false;

        // Xóa tài khoản admin cũ nếu có để tránh nhầm lẫn
        var oldAdmin = await _db.Users.FirstOrDefaultAsync(u => u.Username == "admin");
        if (oldAdmin != null)
        {
            _db.Users.Remove(oldAdmin);
        }

        await _db.SaveChangesAsync();
    }
}
