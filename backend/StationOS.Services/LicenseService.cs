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

    // In-memory session tracking: tokenHash → expiresAt
    private readonly ConcurrentDictionary<string, DateTime> _activeSessions = new();

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
        if (parts.Length != 4 && parts.Length != 7 && parts.Length != 9)
            return (false, "", 0, 0, 0, 0, 0, 0, default, "Định dạng key không hợp lệ (cần 4, 7 hoặc 9 phần)");

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
        else
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
    /// Gọi sau khi login thành công.
    /// Trả false nếu license valid mà đã đủ concurrent users.
    /// Nếu chưa có license thì vẫn cho vào (để admin kích hoạt).
    /// </summary>
    public async Task<(bool allowed, string reason)> TryAcquireSessionAsync(string tokenHash, DateTime expiresAt)
    {
        CleanExpiredSessions();

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var activeLicense = await db.Licenses
            .Where(l => l.IsActive)
            .OrderByDescending(l => l.ActivatedAt)
            .FirstOrDefaultAsync();

        if (activeLicense == null)
        {
            // No license in DB: Allow login but with "no_license" reason, limited to 1 user (SOLO trial limit)
            if (_activeSessions.Count >= 1 && !_activeSessions.ContainsKey(tokenHash))
            {
                return (false, "max_users");
            }
            _activeSessions[tokenHash] = expiresAt;
            return (true, "no_license");
        }

        var (valid, tier, maxUsers, maxDevices, maxCameras, maxRoiPoints, maxRoiRegions, maxPdRegions, expires, error) = ValidateKey(activeLicense.Key);

        if (!valid)
        {
            // Expired or invalid license: Allow login but with "expired" reason, limited to 1 user (SOLO grace limit)
            if (_activeSessions.Count >= 1 && !_activeSessions.ContainsKey(tokenHash))
            {
                return (false, "max_users");
            }
            _activeSessions[tokenHash] = expiresAt;
            return (true, "expired");
        }

        // Valid license: limit by tier's max users
        if (_activeSessions.Count >= maxUsers && !_activeSessions.ContainsKey(tokenHash))
        {
            return (false, "max_users");
        }

        _activeSessions[tokenHash] = expiresAt;
        return (true, "");
    }

    public void ReleaseSession(string tokenHash)
        => _activeSessions.TryRemove(tokenHash, out _);

    private void CleanExpiredSessions()
    {
        var now = DateTime.UtcNow;
        foreach (var kvp in _activeSessions)
            if (kvp.Value < now) _activeSessions.TryRemove(kvp.Key, out _);
    }
}

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
