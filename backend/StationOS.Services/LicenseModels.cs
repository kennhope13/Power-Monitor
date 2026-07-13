using System.Text.Json.Serialization;

namespace StationOS.Services;

public enum LicenseSourceKind
{
    None,
    File,
    Legacy
}

public enum LicenseStateKind
{
    Missing,
    Active,
    Expired,
    Invalid,
    HardwareMismatch,
    AddonRejected
}

public enum LicenseFileKind
{
    Base,
    Addon
}

public enum LicenseSignatureKind
{
    RsaSha256,
    HmacSha256
}

public sealed record LicenseLimits(
    int MaxUsers,
    int MaxDevices,
    int MaxCameras,
    int MaxSensors,
    int MaxRoiPoints,
    int MaxRoiRegions,
    int MaxPdRegions)
{
    public static LicenseLimits Zero { get; } = new(0, 0, 0, 0, 0, 0, 0);

    public static LicenseLimits Trial { get; } = new(1, 5, 5, 5, 5, 5, 5);

    public static LicenseLimits operator +(LicenseLimits a, LicenseLimits b) =>
        new(
            Math.Max(0, a.MaxUsers + b.MaxUsers),
            Math.Max(0, a.MaxDevices + b.MaxDevices),
            Math.Max(0, a.MaxCameras + b.MaxCameras),
            Math.Max(0, a.MaxSensors + b.MaxSensors),
            Math.Max(0, a.MaxRoiPoints + b.MaxRoiPoints),
            Math.Max(0, a.MaxRoiRegions + b.MaxRoiRegions),
            Math.Max(0, a.MaxPdRegions + b.MaxPdRegions)
        );
}

public sealed record HardwareFingerprintData(
    string Fingerprint,
    string? CpuId,
    string? MainboardUuid,
    string? DiskSerial,
    string MachineName,
    string Platform,
    string? MachineGuid,
    IReadOnlyList<string> PhysicalMacs);

public sealed record LicenseHardwareBinding(
    string? Fingerprint,
    string? CpuId,
    string? MainboardUuid,
    string? DiskSerial,
    string? MachineName,
    string? Platform,
    string? MachineGuid,
    [property: System.Text.Json.Serialization.JsonPropertyName("physicalMacs")] IReadOnlyList<string>? PhysicalMacs,
    [property: System.Text.Json.Serialization.JsonPropertyName("macAddress")] string? MacAddress);

public sealed record LicenseSignatureBlock(
    string Algorithm,
    string Value,
    string? KeyId = null);

public sealed record LicensePayload(
    int Version,
    string LicenseType,
    string LicenseId,
    string? AddonId,
    string Tier,
    string? Customer,
    DateTime IssuedAt,
    DateTime ExpiresAt,
    LicenseHardwareBinding Hardware,
    LicenseLimits Limits);

public sealed record LicenseEnvelope(
    LicensePayload Payload,
    LicenseSignatureBlock Signature,
    bool IsFlatFormat = false);

public sealed record LicenseImportResult(
    bool Success,
    string Message,
    string? SavedFile,
    string? LicenseId = null,
    string? AddonId = null,
    string? Tier = null,
    string? State = null);

public sealed record LicenseRequestInfo(
    string Fingerprint,
    string MachineName,
    string Platform,
    string? CpuId,
    string? MainboardUuid,
    string? DiskSerial,
    IReadOnlyList<string> PhysicalMacs,
    string LicenseDirectory,
    DateTime RequestedAtUtc);

public sealed record LicenseValidationResult(
    bool Valid,
    string Source,
    string State,
    string Message,
    string? Tier,
    string? LicenseId,
    string? AddonId,
    string? HardwareFingerprint,
    DateTime? ExpiresAt,
    LicenseLimits? Limits,
    LicenseFileKind? Kind);

public sealed record LicenseStatusDto(
    string Tier,
    int MaxUsers,
    int MaxDevices,
    int MaxCameras,
    int MaxSensors,
    int MaxRoiPoints,
    int MaxRoiRegions,
    int MaxPdRegions,
    int CurrentStations,
    int CurrentCameras,
    int CurrentSensors,
    DateTime ExpiresAt,
    DateTime ActivatedAt,
    int ActiveSessions,
    bool IsValid,
    string Source,
    string State,
    string Message,
    int AddonCount,
    string? BaseLicenseId,
    string? HardwareFingerprint);

internal sealed record LegacyLicenseRecord(
    string Key,
    string Tier,
    LicenseLimits Limits,
    DateTime ExpiresAt,
    DateTime ActivatedAt);

internal sealed record ActiveSessionInfo(string UserId, DateTime ExpiresAt, bool IsBypass = false);
