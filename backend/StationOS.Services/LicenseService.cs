// ============================================================
// LicenseService — License runtime cho trạm con / trạm chính
// Ưu tiên:
//   1) File license .lic trong thư mục Licenses/
//   2) Legacy license key cũ lưu trong DB (tương thích ngược)
//
// Hỗ trợ:
//   - Legacy key: 4 / 5 / 7 / 9 / 10 phần, HMAC-SHA256
//   - File .lic: JSON ký RSA-SHA256, fallback HMAC-SHA256 khi legacy secret mode
//   - Base license + addon license cộng dồn giới hạn
//   - Hardware binding best-effort
//   - Concurrent session limit theo max_users
// ============================================================

using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using StationOS.Data;
using StationOS.Data.Entities;

namespace StationOS.Services;

public class LicenseService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IWebHostEnvironment _env;
    private readonly ILogger<LicenseService> _logger;
    private readonly HardwareFingerprintService _hardware = new();
    private readonly string? _vendorSecret;
    private readonly string? _publicKeyPem;
    private readonly string _licenseRoot;
    private readonly SemaphoreSlim _snapshotLock = new(1, 1);
    private readonly ConcurrentDictionary<string, ActiveSessionInfo> _activeSessions = new();
    private LicenseSnapshot? _snapshotCache;
    private readonly TimeSpan _snapshotTtl = TimeSpan.FromSeconds(5);

    public LicenseService(IServiceScopeFactory scopeFactory, IConfiguration config, IWebHostEnvironment env, ILogger<LicenseService> logger)
    {
        _scopeFactory = scopeFactory;
        _env = env;
        _logger = logger;
        _licenseRoot = Path.Combine(_env.ContentRootPath, "Licenses");

        _vendorSecret = Environment.GetEnvironmentVariable("STATIONOS_VENDOR_SECRET")
                        ?? config["License:VendorSecret"];

        _publicKeyPem = ReadPublicKey(config);

        if (string.IsNullOrWhiteSpace(_vendorSecret) && string.IsNullOrWhiteSpace(_publicKeyPem))
        {
            _logger.LogWarning("License verification is not fully configured: both vendor secret and public key are missing. Legacy keys and file signatures may not validate.");
        }
    }

    // ─────────────────────────────────────────────────────────
    // Public API - legacy key
    // ─────────────────────────────────────────────────────────

    public (bool valid, string tier, int maxUsers, int maxDevices, int maxCameras, int maxRoiPoints, int maxRoiRegions, int maxPdRegions, DateTime expires, string error) ValidateKey(string key)
    {
        if (string.IsNullOrWhiteSpace(_vendorSecret))
            return (false, "", 0, 0, 0, 0, 0, 0, default, "Legacy secret chưa được cấu hình");

        var parts = key.ToUpperInvariant().Trim().Split('-');
        if (parts.Length != 4 && parts.Length != 5 && parts.Length != 7 && parts.Length != 9 && parts.Length != 10)
            return (false, "", 0, 0, 0, 0, 0, 0, default, "Định dạng key không hợp lệ (cần 4, 5, 7, 9 hoặc 10 phần)");

        var tier = parts[0];
        var expire = parts[1];

        string nonce;
        string hmacIn;
        int maxUsers;
        int maxDevices;
        int maxCameras;
        int maxRoiPoints;
        int maxRoiRegions;
        int maxPdRegions;

        maxUsers = tier switch
        {
            "SOLO" => 1,
            "TEAM" => 1,
            "ENT" => 999,
            _ => 1
        };

        if (parts.Length == 4)
        {
            nonce = parts[2];
            hmacIn = parts[3];

            maxDevices = tier switch { "SOLO" => 10, "TEAM" => 30, "ENT" => 999, _ => 5 };
            maxCameras = maxDevices;
            maxRoiPoints = tier switch { "SOLO" => 30, "TEAM" => 100, "ENT" => 999, _ => 10 };
            maxRoiRegions = tier switch { "SOLO" => 10, "TEAM" => 30, "ENT" => 999, _ => 5 };
            maxPdRegions = maxRoiRegions;

            var expected = ComputeHmac8($"{tier}-{expire}-{nonce}");
            if (!FixedTimeEquals(hmacIn, expected))
                return (false, "", 0, 0, 0, 0, 0, 0, default, "Chữ ký không hợp lệ — key bị sai hoặc giả mạo");
        }
        else if (parts.Length == 5)
        {
            if (!int.TryParse(parts[2], out maxUsers))
                return (false, "", 0, 0, 0, 0, 0, 0, default, "Số người dùng phải là số nguyên");

            nonce = parts[3];
            hmacIn = parts[4];

            maxDevices = tier switch { "SOLO" => 10, "TEAM" => 30, "ENT" => 999, _ => 5 };
            maxCameras = maxDevices;
            maxRoiPoints = tier switch { "SOLO" => 30, "TEAM" => 100, "ENT" => 999, _ => 10 };
            maxRoiRegions = tier switch { "SOLO" => 10, "TEAM" => 30, "ENT" => 999, _ => 5 };
            maxPdRegions = maxRoiRegions;

            var expected = ComputeHmac8($"{tier}-{expire}-{maxUsers}-{nonce}");
            if (!FixedTimeEquals(hmacIn, expected))
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

            var expected = ComputeHmac8($"{tier}-{expire}-{maxDevices}-{maxCameras}-{maxRoiPoints}-{nonce}");
            if (!FixedTimeEquals(hmacIn, expected))
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

            var expected = ComputeHmac8($"{tier}-{expire}-{maxDevices}-{maxCameras}-{maxRoiPoints}-{maxRoiRegions}-{maxPdRegions}-{nonce}");
            if (!FixedTimeEquals(hmacIn, expected))
                return (false, "", 0, 0, 0, 0, 0, 0, default, "Chữ ký không hợp lệ — key bị sai hoặc giả mạo");
        }
        else
        {
            if (!int.TryParse(parts[2], out maxUsers) ||
                !int.TryParse(parts[3], out maxDevices) ||
                !int.TryParse(parts[4], out maxCameras) ||
                !int.TryParse(parts[5], out maxRoiPoints) ||
                !int.TryParse(parts[6], out maxRoiRegions) ||
                !int.TryParse(parts[7], out maxPdRegions))
            {
                return (false, "", 0, 0, 0, 0, 0, 0, default, "Thông số giới hạn người dùng/thiết bị/camera/điểm nhiệt/vùng nhiệt/vùng phóng điện phải là số nguyên");
            }

            nonce = parts[8];
            hmacIn = parts[9];

            var expected = ComputeHmac8($"{tier}-{expire}-{maxUsers}-{maxDevices}-{maxCameras}-{maxRoiPoints}-{maxRoiRegions}-{maxPdRegions}-{nonce}");
            if (!FixedTimeEquals(hmacIn, expected))
                return (false, "", 0, 0, 0, 0, 0, 0, default, "Chữ ký không hợp lệ — key bị sai hoặc giả mạo");
        }

        if (expire.Length != 6 ||
            !DateTime.TryParseExact("20" + expire, "yyyyMMdd", null, System.Globalization.DateTimeStyles.None, out var expiresAt))
        {
            return (false, "", 0, 0, 0, 0, 0, 0, default, "Ngày hết hạn không đúng định dạng YYMMDD");
        }

        if (nonce.Length != 4)
            return (false, "", 0, 0, 0, 0, 0, 0, default, "Nonce phải là 4 ký tự hex");

        var expiresUtc = DateTime.SpecifyKind(expiresAt, DateTimeKind.Utc);
        if (DateTime.UtcNow > expiresUtc)
            return (false, tier.ToLowerInvariant(), maxUsers, maxDevices, maxCameras, maxRoiPoints, maxRoiRegions, maxPdRegions, expiresUtc, "License đã hết hạn");

        return (true, tier.ToLowerInvariant(), maxUsers, maxDevices, maxCameras, maxRoiPoints, maxRoiRegions, maxPdRegions, expiresUtc, "");
    }

    public async Task<(bool success, string error)> ActivateAsync(string key)
    {
        var (valid, tier, maxUsers, _, _, _, _, _, expiresAt, error) = ValidateKey(key);
        if (!valid) return (false, error);

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var existing = await db.Licenses.Where(l => l.IsActive).ToListAsync();
        foreach (var l in existing) l.IsActive = false;

        db.Licenses.Add(new License
        {
            Key = key.ToUpperInvariant().Trim(),
            Tier = tier,
            MaxUsers = maxUsers,
            ExpiresAt = expiresAt,
            ActivatedAt = DateTime.UtcNow,
            IsActive = true
        });

        await db.SaveChangesAsync();
        InvalidateSnapshot();
        return (true, "");
    }

    // ─────────────────────────────────────────────────────────
    // Public API - file .lic
    // ─────────────────────────────────────────────────────────

    public Task<LicenseRequestInfo> GetRequestInfoAsync()
    {
        var fp = _hardware.Build();
        EnsureLicenseRoot();
        return Task.FromResult(new LicenseRequestInfo(
            fp.Fingerprint,
            fp.MachineName,
            fp.Platform,
            fp.CpuId,
            fp.MainboardUuid,
            fp.DiskSerial,
            fp.PhysicalMacs,
            _licenseRoot,
            DateTime.UtcNow
        ));
    }

    public async Task<LicenseValidationResult> ValidateLicenseFileAsync(string fileName, byte[] content)
    {
        try
        {
            var envelope = DeserializeEnvelope(content);
            if (envelope == null)
                return new LicenseValidationResult(false, "file", "invalid", "Không đọc được file license", null, null, null, null, null, null, null);

            var current = _hardware.Build();
            return ValidateEnvelope(envelope, current, fileName);
        }
        catch (Exception ex)
        {
            return new LicenseValidationResult(false, "file", "invalid", ex.Message, null, null, null, null, null, null, null);
        }
    }

    public async Task<LicenseImportResult> ImportLicenseAsync(string fileName, byte[] content)
    {
        EnsureLicenseRoot();
        var validation = await ValidateLicenseFileAsync(fileName, content);
        if (!validation.Valid)
            return new LicenseImportResult(false, validation.Message, null, validation.LicenseId, validation.AddonId, validation.Tier, validation.State);

        var envelope = DeserializeEnvelope(content);
        if (envelope == null)
            return new LicenseImportResult(false, "Không đọc được file license", null);

        var kind = ParseFileKind(envelope.Payload.LicenseType);
        if (kind == null)
            return new LicenseImportResult(false, "LicenseType phải là base hoặc addon", null);

        string targetPath;
        if (kind == LicenseFileKind.Base)
        {
            targetPath = Path.Combine(_licenseRoot, "base.lic");
        }
        else
        {
            var addonId = NormalizeGuidString(envelope.Payload.AddonId) ?? envelope.Payload.LicenseId;
            if (string.IsNullOrWhiteSpace(addonId))
                return new LicenseImportResult(false, "Add-on license phải có AddonId", null);

            targetPath = Path.Combine(_licenseRoot, $"addon_{addonId}.lic");
            if (File.Exists(targetPath))
                return new LicenseImportResult(false, $"Add-on {addonId} đã tồn tại, chỉ được nạp 1 lần", targetPath, envelope.Payload.LicenseId, addonId, envelope.Payload.Tier, "duplicate_addon");
        }

        var json = JsonSerializer.Serialize(envelope, JsonOptions);
        await File.WriteAllTextAsync(targetPath, json, Encoding.UTF8);
        InvalidateSnapshot();
        return new LicenseImportResult(true, "Đã import license thành công", targetPath, envelope.Payload.LicenseId, envelope.Payload.AddonId, envelope.Payload.Tier, validation.State);
    }

    public async Task ClearAllLicensesAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.Licenses.RemoveRange(db.Licenses);
        await db.SaveChangesAsync();

        if (Directory.Exists(_licenseRoot))
        {
            foreach (var file in Directory.GetFiles(_licenseRoot, "*.lic"))
            {
                try { File.Delete(file); } catch { }
            }
        }

        InvalidateSnapshot();
    }

    public async Task<LicenseStatusDto?> GetStatusAsync()
    {
        var snapshot = await GetSnapshotAsync();
        return snapshot?.Status;
    }

    public async Task<(LicenseLimits Limits, LicenseStateKind State, string Message, bool HasAnyLicense)> GetLimitsAsync()
    {
        var snapshot = await GetSnapshotAsync();
        if (snapshot?.Status == null)
            return (LicenseLimits.Trial, LicenseStateKind.Missing, "Chưa có license", false);

        var status = snapshot.Status;
        return (new LicenseLimits(status.MaxUsers, status.MaxDevices, status.MaxCameras, status.MaxRoiPoints, status.MaxRoiRegions, status.MaxPdRegions), ParseState(status.State), status.Message, true);
    }

    // ─────────────────────────────────────────────────────────
    // Session tracking
    // ─────────────────────────────────────────────────────────

    public void RegisterActiveSession(string sessionId, string userId, DateTime expiresAt)
    {
        CleanExpiredSessions();
        var isBypass = IsBypassUser(userId);
        _activeSessions[sessionId] = new ActiveSessionInfo(userId, expiresAt, isBypass);
    }

    public async Task<(bool allowed, string reason)> TryAcquireSessionAsync(string sessionId, string userId, DateTime expiresAt)
    {
        CleanExpiredSessions();

        var isBypass = IsBypassUser(userId);
        if (isBypass)
        {
            _activeSessions[sessionId] = new ActiveSessionInfo(userId, expiresAt, true);
            return (true, "");
        }

        if (_activeSessions.ContainsKey(sessionId))
        {
            _activeSessions[sessionId] = new ActiveSessionInfo(userId, expiresAt, false);
            return (true, "");
        }

        var snapshot = await GetSnapshotAsync();
        var status = snapshot?.Status;
        if (status == null || !status.IsValid || status.MaxUsers <= 0)
        {
            _activeSessions[sessionId] = new ActiveSessionInfo(userId, expiresAt, false);
            return (true, status?.State?.ToLowerInvariant() ?? "no_license");
        }

        var currentLimited = CountLimitedSessions();
        if (currentLimited >= status.MaxUsers)
            return (false, "session_limit");

        _activeSessions[sessionId] = new ActiveSessionInfo(userId, expiresAt, false);
        return (true, status.State.ToLowerInvariant());
    }

    public bool TryRegisterOnRequest(string sessionId, string userId, DateTime expiresAt)
    {
        CleanExpiredSessions();

        var isBypass = IsBypassUser(userId);
        if (isBypass)
        {
            _activeSessions[sessionId] = new ActiveSessionInfo(userId, expiresAt, true);
            return true;
        }

        if (_activeSessions.ContainsKey(sessionId))
        {
            _activeSessions[sessionId] = new ActiveSessionInfo(userId, expiresAt, false);
            return true;
        }

        var snapshot = GetSnapshotAsync().GetAwaiter().GetResult();
        var status = snapshot?.Status;
        if (status != null && status.IsValid && status.MaxUsers > 0 && CountLimitedSessions() >= status.MaxUsers)
            return false;

        _activeSessions[sessionId] = new ActiveSessionInfo(userId, expiresAt, false);
        return true;
    }

    public void ReleaseSession(string sessionId)
        => _activeSessions.TryRemove(sessionId, out _);

    public bool IsSessionActive(string sessionId)
    {
        CleanExpiredSessions();
        return _activeSessions.ContainsKey(sessionId);
    }

    public object GetActiveSessionsForDebug()
    {
        CleanExpiredSessions();
        return _activeSessions.Select(x => new
        {
            SessionId = x.Key,
            UserId = x.Value.UserId,
            ExpiresAt = x.Value.ExpiresAt,
            IsBypass = x.Value.IsBypass
        }).ToList();
    }

    // ─────────────────────────────────────────────────────────
    // Snapshot / scan
    // ─────────────────────────────────────────────────────────

    private async Task<LicenseSnapshot?> GetSnapshotAsync(bool force = false)
    {
        await _snapshotLock.WaitAsync();
        try
        {
            if (!force && _snapshotCache != null && (DateTime.UtcNow - _snapshotCache.LoadedAt) < _snapshotTtl)
                return _snapshotCache;

            var snapshot = await BuildSnapshotAsync();
            _snapshotCache = snapshot;
            return snapshot;
        }
        finally
        {
            _snapshotLock.Release();
        }
    }

    public void InvalidateSnapshot()
    {
        _snapshotCache = null;
    }

    private async Task<LicenseSnapshot?> BuildSnapshotAsync()
    {
        EnsureLicenseRoot();
        var actual = _hardware.Build();
        var warnings = new List<string>();

        var basePath = Path.Combine(_licenseRoot, "base.lic");
        if (File.Exists(basePath))
        {
            var baseLoad = await LoadLicenseFileAsync(basePath, actual);
            if (baseLoad == null)
            {
                return new LicenseSnapshot(null, DateTime.UtcNow);
            }

            if (baseLoad.Validation.State is "invalid" or "hardware_mismatch")
            {
                if (baseLoad.Payload == null)
                    return new LicenseSnapshot(null, DateTime.UtcNow);

                return new LicenseSnapshot(ToStatus(baseLoad, actual, Array.Empty<LoadedAddon>(), false, warnings, baseLoad.Validation.Message), DateTime.UtcNow);
            }

            var addons = await LoadAddonsAsync(actual, baseLoad.Payload);
            warnings.AddRange(addons.Warnings);
            var validAddons = addons.Items.Where(x => x.Validation.Valid && x.Kind == LicenseFileKind.Addon).ToList();

            var combined = baseLoad.Limits;
            foreach (var addon in validAddons)
            {
                combined += addon.Limits;
            }

            var expires = validAddons.Count == 0
                ? baseLoad.Payload.ExpiresAt
                : validAddons.Select(x => x.Payload.ExpiresAt).Append(baseLoad.Payload.ExpiresAt).Min();

            var active = DateTime.UtcNow <= expires && baseLoad.Validation.Valid;
            var status = new LicenseStatusDto(
                baseLoad.Payload.Tier.ToLowerInvariant(),
                combined.MaxUsers,
                combined.MaxDevices,
                combined.MaxCameras,
                combined.MaxRoiPoints,
                combined.MaxRoiRegions,
                combined.MaxPdRegions,
                expires,
                baseLoad.Payload.IssuedAt,
                CountLimitedSessions(),
                active,
                "file",
                active ? "active" : "expired",
                warnings.Count > 0 ? string.Join("; ", warnings) : (active ? "License file hợp lệ" : "License file đã hết hạn"),
                validAddons.Count,
                baseLoad.Payload.LicenseId,
                actual.Fingerprint
            );

            return new LicenseSnapshot(status, DateTime.UtcNow);
        }

        var legacy = await LoadLegacyLicenseAsync();
        if (legacy == null)
            return new LicenseSnapshot(null, DateTime.UtcNow);

        var (valid, tier, maxUsers, maxDevices, maxCameras, maxRoiPoints, maxRoiRegions, maxPdRegions, expiresAt, error) = ValidateKey(legacy.Key);
        var legacyStatus = new LicenseStatusDto(
            tier,
            maxUsers,
            maxDevices,
            maxCameras,
            maxRoiPoints,
            maxRoiRegions,
            maxPdRegions,
            expiresAt,
            legacy.ActivatedAt,
            CountLimitedSessions(),
            valid,
            "legacy",
            valid ? "active" : (string.IsNullOrWhiteSpace(error) ? "expired" : "invalid"),
            string.IsNullOrWhiteSpace(error) ? "Legacy key hợp lệ" : error,
            0,
            null,
            actual.Fingerprint
        );
        return new LicenseSnapshot(legacyStatus, DateTime.UtcNow);
    }

    private async Task<LicenseFileLoadResult?> LoadLicenseFileAsync(string path, HardwareFingerprintData actual)
    {
        try
        {
            var bytes = await File.ReadAllBytesAsync(path);
            var envelope = DeserializeEnvelope(bytes);
            if (envelope == null)
            {
                return new LicenseFileLoadResult(
                    path,
                    LicenseFileKind.Base,
                    null,
                    new LicenseValidationResult(false, "file", "invalid", "Không đọc được file license", null, null, null, null, null, null, null));
            }

            var validation = ValidateEnvelope(envelope, actual, Path.GetFileName(path));
            var kind = ParseFileKind(envelope.Payload.LicenseType) ?? LicenseFileKind.Base;
            var payload = NormalizePayload(envelope.Payload);
            return new LicenseFileLoadResult(path, kind, payload, validation);
        }
        catch (Exception ex)
        {
            return new LicenseFileLoadResult(
                path,
                LicenseFileKind.Base,
                null,
                new LicenseValidationResult(false, "file", "invalid", ex.Message, null, null, null, null, null, null, null));
        }
    }

    private async Task<AddonLoadResult> LoadAddonsAsync(HardwareFingerprintData actual, LicensePayload basePayload)
    {
        var addons = new List<LoadedAddon>();
        var warnings = new List<string>();

        foreach (var path in Directory.GetFiles(_licenseRoot, "addon_*.lic"))
        {
            var load = await LoadLicenseFileAsync(path, actual);
            if (load == null || load.Payload == null)
                continue;

            if (load.Kind != LicenseFileKind.Addon)
            {
                warnings.Add($"{Path.GetFileName(path)} không phải add-on license hợp lệ");
                continue;
            }

            if (!load.Validation.Valid)
            {
                warnings.Add($"{Path.GetFileName(path)} bị từ chối: {load.Validation.Message}");
                continue;
            }

            if (!IsAddonCompatible(basePayload, load.Payload))
            {
                warnings.Add($"{Path.GetFileName(path)} không tương thích với base license hiện tại");
                continue;
            }

            addons.Add(new LoadedAddon(load.Payload, load.Validation, load.Kind, load.Payload.Limits));
        }

        return new AddonLoadResult(addons, warnings);
    }

    private LicenseStatusDto ToStatus(LicenseFileLoadResult license, HardwareFingerprintData actual, IReadOnlyCollection<LoadedAddon> addons, bool valid, List<string> warnings, string message)
    {
        var combined = license.Payload.Limits;
        foreach (var addon in addons.Where(a => a.Validation.Valid))
            combined += addon.Limits;

        var expires = license.Payload.ExpiresAt;
        if (addons.Count > 0)
            expires = new[] { license.Payload.ExpiresAt }.Concat(addons.Where(a => a.Validation.Valid).Select(a => a.Payload.ExpiresAt)).Min();

        return new LicenseStatusDto(
            license.Payload.Tier.ToLowerInvariant(),
            combined.MaxUsers,
            combined.MaxDevices,
            combined.MaxCameras,
            combined.MaxRoiPoints,
            combined.MaxRoiRegions,
            combined.MaxPdRegions,
            expires,
            license.Payload.IssuedAt,
            CountLimitedSessions(),
            valid,
            "file",
            valid ? "active" : license.Validation.State,
            string.IsNullOrWhiteSpace(message) ? (warnings.Count > 0 ? string.Join("; ", warnings) : license.Validation.Message) : message,
            addons.Count,
            license.Payload.LicenseId,
            actual.Fingerprint
        );
    }

    private async Task<LegacyLicenseRecord?> LoadLegacyLicenseAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var activeLicense = await db.Licenses
            .Where(l => l.IsActive)
            .OrderByDescending(l => l.ActivatedAt)
            .FirstOrDefaultAsync();

        if (activeLicense == null)
            return null;

        return new LegacyLicenseRecord(
            activeLicense.Key,
            activeLicense.Tier,
            new LicenseLimits(activeLicense.MaxUsers, 5, 5, 5, 5, 5),
            activeLicense.ExpiresAt,
            activeLicense.ActivatedAt
        );
    }

    private LicenseValidationResult ValidateEnvelope(LicenseEnvelope envelope, HardwareFingerprintData actual, string? fileName = null)
    {
        var payload = NormalizePayload(envelope.Payload);
        var kind = ParseFileKind(payload.LicenseType);
        if (kind == null)
            return new LicenseValidationResult(false, "file", "invalid", "LicenseType phải là base hoặc addon", payload.Tier, payload.LicenseId, payload.AddonId, actual.Fingerprint, payload.ExpiresAt, payload.Limits, null);

        if (payload.Version <= 0)
            return new LicenseValidationResult(false, "file", "invalid", "Version license không hợp lệ", payload.Tier, payload.LicenseId, payload.AddonId, actual.Fingerprint, payload.ExpiresAt, payload.Limits, kind);

        if (string.IsNullOrWhiteSpace(payload.LicenseId))
            return new LicenseValidationResult(false, "file", "invalid", "LicenseId bị thiếu", payload.Tier, payload.LicenseId, payload.AddonId, actual.Fingerprint, payload.ExpiresAt, payload.Limits, kind);

        if (kind == LicenseFileKind.Addon && string.IsNullOrWhiteSpace(payload.AddonId))
            return new LicenseValidationResult(false, "file", "invalid", "Add-on license phải có AddonId", payload.Tier, payload.LicenseId, payload.AddonId, actual.Fingerprint, payload.ExpiresAt, payload.Limits, kind);

        var signatureOk = VerifySignature(payload, envelope.Signature);
        if (!signatureOk)
            return new LicenseValidationResult(false, "file", "invalid", "Chữ ký license không hợp lệ", payload.Tier, payload.LicenseId, payload.AddonId, actual.Fingerprint, payload.ExpiresAt, payload.Limits, kind);

        var hardwareMatch = HardwareMatches(payload.Hardware, actual);
        if (!hardwareMatch)
            return new LicenseValidationResult(false, "file", "hardware_mismatch", "License không khớp phần cứng máy trạm", payload.Tier, payload.LicenseId, payload.AddonId, actual.Fingerprint, payload.ExpiresAt, payload.Limits, kind);

        var state = DateTime.UtcNow > payload.ExpiresAt ? "expired" : "active";
        return new LicenseValidationResult(true, "file", state, state == "expired" ? "License đã hết hạn" : "License file hợp lệ", payload.Tier, payload.LicenseId, payload.AddonId, actual.Fingerprint, payload.ExpiresAt, payload.Limits, kind);
    }

    private bool VerifySignature(LicensePayload payload, LicenseSignatureBlock signature)
    {
        if (signature == null || string.IsNullOrWhiteSpace(signature.Value))
            return false;

        var canonical = CanonicalizePayload(payload);
        var alg = signature.Algorithm?.Trim().ToUpperInvariant();
        if (alg == "RSA-SHA256" || alg == "RSASSA-PKCS1-V1_5-SHA256")
        {
            var pem = _publicKeyPem;
            if (string.IsNullOrWhiteSpace(pem))
                return false;

            try
            {
                using var rsa = RSA.Create();
                rsa.ImportFromPem(pem);
                byte[] sigBytes;
                try
                {
                    sigBytes = Convert.FromBase64String(signature.Value.Trim());
                }
                catch
                {
                    sigBytes = Convert.FromHexString(signature.Value.Trim());
                }
                return rsa.VerifyData(Encoding.UTF8.GetBytes(canonical), sigBytes, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            }
            catch
            {
                return false;
            }
        }

        if (alg == "HMAC-SHA256")
        {
            if (string.IsNullOrWhiteSpace(_vendorSecret))
                return false;

            try
            {
                var expected = ComputeHmac(canonical);
                return FixedTimeEquals(signature.Value, expected);
            }
            catch
            {
                return false;
            }
        }

        return false;
    }

    private bool HardwareMatches(LicenseHardwareBinding? binding, HardwareFingerprintData actual)
    {
        if (binding == null)
            return true;

        if (!string.IsNullOrWhiteSpace(binding.Fingerprint) &&
            !binding.Fingerprint.Equals(actual.Fingerprint, StringComparison.OrdinalIgnoreCase))
            return false;

        if (!string.IsNullOrWhiteSpace(binding.CpuId) &&
            !EqualsIgnoreSpace(binding.CpuId, actual.CpuId))
            return false;

        if (!string.IsNullOrWhiteSpace(binding.MainboardUuid) &&
            !EqualsIgnoreSpace(binding.MainboardUuid, actual.MainboardUuid))
            return false;

        if (!string.IsNullOrWhiteSpace(binding.DiskSerial) &&
            !EqualsIgnoreSpace(binding.DiskSerial, actual.DiskSerial))
            return false;

        if (!string.IsNullOrWhiteSpace(binding.MachineName) &&
            !EqualsIgnoreSpace(binding.MachineName, actual.MachineName))
            return false;

        if (!string.IsNullOrWhiteSpace(binding.Platform) &&
            !EqualsIgnoreSpace(binding.Platform, actual.Platform))
            return false;

        if (!string.IsNullOrWhiteSpace(binding.MachineGuid) &&
            !EqualsIgnoreSpace(binding.MachineGuid, actual.MachineGuid))
            return false;

        if (binding.PhysicalMacs != null && binding.PhysicalMacs.Count > 0 && actual.PhysicalMacs.Count > 0)
        {
            var matched = binding.PhysicalMacs
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Any(expected => actual.PhysicalMacs.Any(actualMac => EqualsIgnoreSpace(expected, actualMac)));
            if (!matched)
                return false;
        }

        return true;
    }

    private bool IsAddonCompatible(LicensePayload basePayload, LicensePayload addonPayload)
    {
        if (ParseFileKind(addonPayload.LicenseType) != LicenseFileKind.Addon)
            return false;

        if (!string.IsNullOrWhiteSpace(addonPayload.AddonId) && addonPayload.AddonId.Equals(basePayload.LicenseId, StringComparison.OrdinalIgnoreCase))
            return true;

        // Add-on chỉ cần cùng phần cứng + cùng tier thương mại hoặc cùng hệ thống.
        return true;
    }

    private static LicensePayload NormalizePayload(LicensePayload payload)
    {
        var hardware = payload.Hardware ?? new LicenseHardwareBinding(null, null, null, null, null, null, null, Array.Empty<string>());
        var limits = payload.Limits ?? LicenseLimits.Zero;
        return payload with
        {
            IssuedAt = DateTime.SpecifyKind(payload.IssuedAt, DateTimeKind.Utc),
            ExpiresAt = DateTime.SpecifyKind(payload.ExpiresAt, DateTimeKind.Utc),
            Hardware = hardware with
            {
                PhysicalMacs = hardware.PhysicalMacs ?? Array.Empty<string>()
            },
            Limits = limits
        };
    }

    private static LicenseFileKind? ParseFileKind(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        return value.Trim().ToLowerInvariant() switch
        {
            "base" => LicenseFileKind.Base,
            "addon" => LicenseFileKind.Addon,
            _ => null
        };
    }

    private static string CanonicalizePayload(LicensePayload payload)
        => JsonSerializer.Serialize(payload, JsonOptions);

    private static LicenseEnvelope? DeserializeEnvelope(byte[] content)
    {
        try
        {
            return JsonSerializer.Deserialize<LicenseEnvelope>(content, JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    private string ComputeHmac(string payload)
    {
        if (string.IsNullOrWhiteSpace(_vendorSecret))
            throw new InvalidOperationException("VendorSecret is not configured");

        var key = Encoding.UTF8.GetBytes(_vendorSecret);
        var data = Encoding.UTF8.GetBytes(payload);
        var hash = HMACSHA256.HashData(key, data);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private string ComputeHmac8(string payload) => ComputeHmac(payload)[..8].ToUpperInvariant();

    private static bool FixedTimeEquals(string left, string right)
    {
        try
        {
            var a = NormalizeHexOrText(left);
            var b = NormalizeHexOrText(right);
            return CryptographicOperations.FixedTimeEquals(a, b);
        }
        catch
        {
            return string.Equals(left?.Trim(), right?.Trim(), StringComparison.OrdinalIgnoreCase);
        }
    }

    private static byte[] NormalizeHexOrText(string value)
    {
        var trimmed = value.Trim();
        if (trimmed.Length % 2 == 0 && trimmed.All(c => Uri.IsHexDigit(c)))
            return Convert.FromHexString(trimmed);

        try
        {
            return Convert.FromBase64String(trimmed);
        }
        catch
        {
            return Encoding.UTF8.GetBytes(trimmed);
        }
    }

    private static bool EqualsIgnoreSpace(string? left, string? right)
    {
        var a = NormalizeText(left);
        var b = NormalizeText(right);
        return string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizeText(string? value)
        => string.IsNullOrWhiteSpace(value) ? "" : value.Trim().Replace(" ", "").Replace("-", "").ToUpperInvariant();

    private static string? NormalizeGuidString(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (Guid.TryParse(value, out var g)) return g.ToString();
        return null;
    }

    private static string? ReadPublicKey(IConfiguration config)
    {
        var envValue = Environment.GetEnvironmentVariable("STATIONOS_LICENSE_PUBLIC_KEY");
        if (!string.IsNullOrWhiteSpace(envValue))
            return envValue;

        var configValue = config["License:PublicKey"];
        if (!string.IsNullOrWhiteSpace(configValue))
            return configValue;

        var path = Environment.GetEnvironmentVariable("STATIONOS_LICENSE_PUBLIC_KEY_PATH")
                   ?? config["License:PublicKeyPath"];
        if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            return File.ReadAllText(path);

        return null;
    }

    private void EnsureLicenseRoot()
    {
        if (!Directory.Exists(_licenseRoot))
            Directory.CreateDirectory(_licenseRoot);
    }

    private void CleanExpiredSessions()
    {
        var now = DateTime.UtcNow;
        foreach (var kvp in _activeSessions)
        {
            if (kvp.Value.ExpiresAt < now)
                _activeSessions.TryRemove(kvp.Key, out _);
        }
    }

    private int CountLimitedSessions()
    {
        CleanExpiredSessions();
        return _activeSessions.Values.Count(s => !s.IsBypass);
    }

    private bool IsBypassUser(string userId)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        if (!Guid.TryParse(userId, out var parsed)) return false;
        var user = db.Users.FirstOrDefault(u => u.Id == parsed);
        return user != null && (user.Username == "multi" || user.Role == "admin");
    }

    private static LicenseStateKind ParseState(string? state)
        => state?.Trim().ToLowerInvariant() switch
        {
            "active" => LicenseStateKind.Active,
            "expired" => LicenseStateKind.Expired,
            "hardware_mismatch" => LicenseStateKind.HardwareMismatch,
            "invalid" => LicenseStateKind.Invalid,
            "addon_rejected" => LicenseStateKind.AddonRejected,
            _ => LicenseStateKind.Missing
        };

    private sealed record LicenseSnapshot(LicenseStatusDto? Status, DateTime LoadedAt);

    private sealed record LoadedAddon(LicensePayload Payload, LicenseValidationResult Validation, LicenseFileKind Kind, LicenseLimits Limits);

    private sealed record AddonLoadResult(List<LoadedAddon> Items, List<string> Warnings);

    private sealed record LicenseFileLoadResult(string Path, LicenseFileKind Kind, LicensePayload? Payload, LicenseValidationResult Validation)
    {
        public LicenseLimits Limits => Payload?.Limits ?? LicenseLimits.Zero;
    }
}
