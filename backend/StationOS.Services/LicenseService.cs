// ============================================================
// LicenseService — Quản lý license key và concurrent sessions
// Key format: {TIER}-{YYMMDD}-{NONCE4}-{HMAC8}
//   TIER: SOLO (1 user) | TEAM (5 users) | ENT (unlimited)
//   Example: SOLO-270101-A3F7-1B2C3D4E
// ============================================================

using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using StationOS.Data;
using StationOS.Data.Entities;

namespace StationOS.Services;

public class LicenseService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly string _vendorSecret;

    // In-memory session tracking: sessionId -> ActiveSessionInfo
    private readonly ConcurrentDictionary<string, ActiveSessionInfo> _activeSessions = new();

    public LicenseService(IServiceScopeFactory scopeFactory, IConfiguration config)
    {
        _scopeFactory = scopeFactory;
        _vendorSecret = Environment.GetEnvironmentVariable("STATIONOS_VENDOR_SECRET") 
                        ?? config["License:VendorSecret"] 
                        ?? throw new InvalidOperationException("Khóa bí mật nhà cung cấp (VendorSecret) chưa được cấu hình. Vui lòng thiết lập biến môi trường STATIONOS_VENDOR_SECRET.");
    }

    // ── Key validation ─────────────────────────────────────────

    public (bool valid, string tier, int maxUsers, int maxDevices, int maxCameras, int maxRoiPoints, int maxRoiRegions, int maxPdRegions, DateTime expires, string error) ValidateKey(string key)
    {
        var parts = key.ToUpper().Trim().Split('-');
        if (parts.Length != 4 && parts.Length != 5 && parts.Length != 7 && parts.Length != 9 && parts.Length != 10)
            return (false, "", 0, 0, 0, 0, 0, 0, default, "Định dạng key không hợp lệ (cần 4, 5, 7, 9 hoặc 10 phần)");

        var tier   = parts[0];
        var expire = parts[1];
        
        string nonce;
        string hmacIn;
        int maxDevices;
        int maxCameras;
        int maxRoiPoints;
        int maxRoiRegions;
        int maxPdRegions;

        var maxUsers = tier switch
        {
            "SOLO" => 1,
            "TEAM" => 1,
            "ENT"  => 999,
            _ => 1
        };

        if (parts.Length == 4)
        {
            nonce = parts[2];
            hmacIn = parts[3];

            maxDevices = tier switch
            {
                "SOLO" => 10,
                "TEAM" => 30,
                "ENT"  => 999,
                _ => 5
            };
            maxCameras = tier switch
            {
                "SOLO" => 10,
                "TEAM" => 30,
                "ENT"  => 999,
                _ => 5
            };
            maxRoiPoints = tier switch
            {
                "SOLO" => 30,
                "TEAM" => 100,
                "ENT"  => 999,
                _ => 10
            };
            maxRoiRegions = tier switch
            {
                "SOLO" => 10,
                "TEAM" => 30,
                "ENT"  => 999,
                _ => 5
            };
            maxPdRegions = tier switch
            {
                "SOLO" => 10,
                "TEAM" => 30,
                "ENT"  => 999,
                _ => 5
            };

            var payload4  = $"{tier}-{expire}-{nonce}";
            var expected4 = ComputeHmac8(payload4);
            if (hmacIn != expected4)
                return (false, "", 0, 0, 0, 0, 0, 0, default, "Chữ ký không hợp lệ — key bị sai hoặc giả mạo");
        }
        else if (parts.Length == 5) // TIER-EXPIRE-maxUsers-NONCE-HMAC8
        {
            if (!int.TryParse(parts[2], out var parsedUsers))
                return (false, "", 0, 0, 0, 0, 0, 0, default, "Số người dùng phải là số nguyên");

            maxUsers = parsedUsers;
            nonce    = parts[3];
            hmacIn   = parts[4];

            // Device/camera limits follow tier defaults
            maxDevices = maxCameras = tier switch { "SOLO" => 10, "TEAM" => 30, "ENT" => 999, _ => 5 };
            maxRoiPoints = tier switch { "SOLO" => 30, "TEAM" => 100, "ENT" => 999, _ => 10 };
            maxRoiRegions = maxPdRegions = tier switch { "SOLO" => 10, "TEAM" => 30, "ENT" => 999, _ => 5 };

            var payload5  = $"{tier}-{expire}-{parsedUsers}-{nonce}";
            var expected5 = ComputeHmac8(payload5);
            if (hmacIn != expected5)
                return (false, "", 0, 0, 0, 0, 0, 0, default, "Chữ ký không hợp lệ — key bị sai hoặc giả mạo");
        }
        else if (parts.Length == 7)
        {
            if (!int.TryParse(parts[2], out maxDevices) ||
                !int.TryParse(parts[3], out maxCameras) ||
                !int.TryParse(parts[4], out maxRoiPoints))
            {
                return (false, "", 0, 0, 0, 0, 0, 0, default, "Thông số giới hạn thiết bị/camera/điểm nhiệt phải là số nguyên");
            }

            maxRoiRegions = maxRoiPoints;
            maxPdRegions = maxRoiPoints;

            nonce = parts[5];
            hmacIn = parts[6];

            var payload7  = $"{tier}-{expire}-{maxDevices}-{maxCameras}-{maxRoiPoints}-{nonce}";
            var expected7 = ComputeHmac8(payload7);
            if (hmacIn != expected7)
                return (false, "", 0, 0, 0, 0, 0, 0, default, "Chữ ký không hợp lệ — key bị sai hoặc giả mạo");
        }
        else if (parts.Length == 9)
        {
            if (!int.TryParse(parts[2], out maxDevices) ||
                !int.TryParse(parts[3], out maxCameras) ||
                !int.TryParse(parts[4], out maxRoiPoints) ||
                !int.TryParse(parts[5], out maxRoiRegions) ||
                !int.TryParse(parts[6], out maxPdRegions))
            {
                return (false, "", 0, 0, 0, 0, 0, 0, default, "Thông số giới hạn thiết bị/camera/điểm nhiệt/vùng nhiệt/vùng phóng điện phải là số nguyên");
            }

            nonce = parts[7];
            hmacIn = parts[8];

            var payload9  = $"{tier}-{expire}-{maxDevices}-{maxCameras}-{maxRoiPoints}-{maxRoiRegions}-{maxPdRegions}-{nonce}";
            var expected9 = ComputeHmac8(payload9);
            if (hmacIn != expected9)
                return (false, "", 0, 0, 0, 0, 0, 0, default, "Chữ ký không hợp lệ — key bị sai hoặc giả mạo");
        }
        else // 10 parts: TIER(0)-EXPIRE(1)-maxUsers(2)-maxDevices(3)-maxCameras(4)-maxRoiPoints(5)-maxRoiRegions(6)-maxPdRegions(7)-NONCE(8)-HMAC8(9)
        {
            if (!int.TryParse(parts[2], out var parsedMaxUsers) ||
                !int.TryParse(parts[3], out maxDevices) ||
                !int.TryParse(parts[4], out maxCameras) ||
                !int.TryParse(parts[5], out maxRoiPoints) ||
                !int.TryParse(parts[6], out maxRoiRegions) ||
                !int.TryParse(parts[7], out maxPdRegions))
            {
                return (false, "", 0, 0, 0, 0, 0, 0, default, "Thông số giới hạn người dùng/thiết bị/camera/điểm nhiệt/vùng nhiệt/vùng phóng điện phải là số nguyên");
            }

            maxUsers = parsedMaxUsers;
            nonce    = parts[8];
            hmacIn   = parts[9];

            var payload10 = $"{tier}-{expire}-{parsedMaxUsers}-{maxDevices}-{maxCameras}-{maxRoiPoints}-{maxRoiRegions}-{maxPdRegions}-{nonce}";
            var expected10 = ComputeHmac8(payload10);
            if (hmacIn != expected10)
                return (false, "", 0, 0, 0, 0, 0, 0, default, "Chữ ký không hợp lệ — key bị sai hoặc giả mạo");
        }

        if (expire.Length != 6 ||
            !DateTime.TryParseExact("20" + expire, "yyyyMMdd",
                null, System.Globalization.DateTimeStyles.None, out var expiresAt))
            return (false, "", 0, 0, 0, 0, 0, 0, default, "Ngày hết hạn không đúng định dạng YYMMDD");

        if (nonce.Length != 4)
            return (false, "", 0, 0, 0, 0, 0, 0, default, "Nonce phải là 4 ký tự hex");

        var expiresUtc = DateTime.SpecifyKind(expiresAt, DateTimeKind.Utc);
        if (DateTime.UtcNow > expiresUtc)
            return (false, tier.ToLower(), maxUsers, maxDevices, maxCameras, maxRoiPoints, maxRoiRegions, maxPdRegions, expiresUtc, "License đã hết hạn");

        return (true, tier.ToLower(), maxUsers, maxDevices, maxCameras, maxRoiPoints, maxRoiRegions, maxPdRegions, expiresUtc, "");
    }

    private string ComputeHmac8(string payload)
    {
        var key  = Encoding.UTF8.GetBytes(_vendorSecret);
        var data = Encoding.UTF8.GetBytes(payload);
        var hash = HMACSHA256.HashData(key, data);
        return Convert.ToHexString(hash)[..8];
    }

    // ── Activate ───────────────────────────────────────────────

    public async Task<(bool success, string error)> ActivateAsync(string key)
    {
        var (valid, tier, maxUsers, maxDevices, maxCameras, maxRoiPoints, maxRoiRegions, maxPdRegions, expiresAt, error) = ValidateKey(key);
        if (!valid) return (false, error);

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        // Deactivate any existing license
        var existing = await db.Licenses.Where(l => l.IsActive).ToListAsync();
        foreach (var l in existing) l.IsActive = false;

        db.Licenses.Add(new License
        {
            Key         = key.ToUpper().Trim(),
            Tier        = tier,
            MaxUsers    = maxUsers,
            ExpiresAt   = expiresAt,
            ActivatedAt = DateTime.UtcNow,
            IsActive    = true
        });

        await db.SaveChangesAsync();
        return (true, "");
    }

    // ── Status ─────────────────────────────────────────────────

    public async Task<LicenseStatusDto?> GetStatusAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var activeLicense = await db.Licenses
            .Where(l => l.IsActive)
            .OrderByDescending(l => l.ActivatedAt)
            .FirstOrDefaultAsync();

        if (activeLicense == null)
            return null;

        var (valid, tier, maxUsers, maxDevices, maxCameras, maxRoiPoints, maxRoiRegions, maxPdRegions, expiresAt, error) = ValidateKey(activeLicense.Key);

        return new LicenseStatusDto(
            tier,
            maxUsers,
            maxDevices,
            maxCameras,
            maxRoiPoints,
            maxRoiRegions,
            maxPdRegions,
            expiresAt,
            activeLicense.ActivatedAt,
            _activeSessions.Count,
            valid
        );
    }

    // ── Session tracking ───────────────────────────────────────

    /// <summary>
    /// Đăng ký/cập nhật phiên hoạt động từ Middleware JWT
    /// </summary>
    public void RegisterActiveSession(string sessionId, string userId, DateTime expiresAt)
    {
        CleanExpiredSessions();
        bool isBypass = false;
        if (_activeSessions.TryGetValue(sessionId, out var existing))
        {
            isBypass = existing.IsBypass;
        }
        else
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var user = db.Users.FirstOrDefault(u => u.Id == Guid.Parse(userId));
            isBypass = user != null && (user.Username == "multi" || user.Role == "admin");
        }
        _activeSessions[sessionId] = new ActiveSessionInfo(userId, expiresAt, isBypass);
    }

    /// <summary>
    /// Gọi sau khi login thành công.
    /// Trả false nếu license valid mà đã đủ concurrent users.
    /// Nếu chưa có license thì vẫn cho vào (để admin kích hoạt).
    /// </summary>
    public async Task<(bool allowed, string reason)> TryAcquireSessionAsync(string sessionId, string userId, DateTime expiresAt)
    {
        CleanExpiredSessions();

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == Guid.Parse(userId));
        bool isBypass = user != null && (user.Username == "multi" || user.Role == "admin");

        var activeLicense = await db.Licenses
            .Where(l => l.IsActive)
            .OrderByDescending(l => l.ActivatedAt)
            .FirstOrDefaultAsync();

        int maxUsers = 1;
        bool hasLicense = false;
        bool valid = false;

        if (activeLicense != null)
        {
            var valResult = ValidateKey(activeLicense.Key);
            valid = valResult.valid;
            maxUsers = valResult.maxUsers;
            hasLicense = true;
        }

        string reason = "";
        if (!hasLicense) reason = "no_license";
        else if (!valid) reason = "expired";

        // Check if this specific session is already registered
        if (_activeSessions.ContainsKey(sessionId))
        {
            _activeSessions[sessionId] = new ActiveSessionInfo(userId, expiresAt, isBypass);
            return (true, reason);
        }

        // Nếu là tài khoản trạm tổng (multi) hoặc admin thì cho qua không giới hạn
        if (isBypass)
        {
            _activeSessions[sessionId] = new ActiveSessionInfo(userId, expiresAt, isBypass);
            return (true, reason);
        }

        // Không giới hạn phiên đăng nhập đồng thời ở trạm
        _activeSessions[sessionId] = new ActiveSessionInfo(userId, expiresAt, isBypass);
        return (true, reason);
    }

    public void ReleaseSession(string sessionId)
        => _activeSessions.TryRemove(sessionId, out _);

    public bool IsSessionActive(string sessionId)
    {
        CleanExpiredSessions();
        return _activeSessions.ContainsKey(sessionId);
    }

    public bool TryRegisterOnRequest(string sessionId, string userId, DateTime expiresAt)
    {
        CleanExpiredSessions();

        bool isBypass = false;
        int maxUsers = 1;
        using (var scope = _scopeFactory.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var user = db.Users.FirstOrDefault(u => u.Id == Guid.Parse(userId));
            isBypass = user != null && (user.Username == "multi" || user.Role == "admin");

            var activeLicense = db.Licenses.FirstOrDefault(l => l.IsActive);
            if (activeLicense != null)
            {
                var valResult = ValidateKey(activeLicense.Key);
                if (valResult.valid) maxUsers = valResult.maxUsers;
            }
        }

        // Nếu là trạm tổng (multi) hoặc admin thì luôn cho qua
        if (isBypass)
        {
            _activeSessions[sessionId] = new ActiveSessionInfo(userId, expiresAt, isBypass);
            return true;
        }

        // Không giới hạn phiên đăng nhập đồng thời ở trạm
        _activeSessions[sessionId] = new ActiveSessionInfo(userId, expiresAt, isBypass);
        return true;
    }

    // ── Utility ───────────────────────────────────────────────
    
    /// <summary>
    /// Remove all license entries from the database. Use with caution; intended for resetting license tokens.
    /// </summary>
    public async Task ClearAllLicensesAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.Licenses.RemoveRange(db.Licenses);
        await db.SaveChangesAsync();
    }

    private void CleanExpiredSessions()
    {
        var now = DateTime.UtcNow;
        foreach (var kvp in _activeSessions)
            if (kvp.Value.ExpiresAt < now) _activeSessions.TryRemove(kvp.Key, out _);
    }

    public object GetActiveSessionsForDebug()
    {
        return _activeSessions.Select(x => new {
            SessionId = x.Key,
            UserId = x.Value.UserId,
            ExpiresAt = x.Value.ExpiresAt,
            IsBypass = x.Value.IsBypass
        }).ToList();
    }
}

public record ActiveSessionInfo(string UserId, DateTime ExpiresAt, bool IsBypass = false);

public record LicenseStatusDto(
    string Tier,
    int MaxUsers,
    int MaxDevices,
    int MaxCameras,
    int MaxRoiPoints,
    int MaxRoiRegions,
    int MaxPdRegions,
    DateTime ExpiresAt,
    DateTime ActivatedAt,
    int ActiveSessions,
    bool IsValid
);
