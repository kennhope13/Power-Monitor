using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

namespace StationOS.Services.Security;

public class InternalAuthService
{
    public const string HeaderName = "X-StationOS-Internal-Key";
    public const string InternalMachineClaim = "internal_machine";
    private const string DefaultSharedKey = "StationOS_Internal_LAN_2026";
    private const string DefaultTrustedNetworks = "127.,::1,10.,192.168.,172.16.,172.17.,172.18.,172.19.,172.20.,172.21.,172.22.,172.23.,172.24.,172.25.,172.26.,172.27.,172.28.,172.29.,172.30.,172.31.";

    private readonly IConfiguration _config;

    public InternalAuthService(IConfiguration config)
    {
        _config = config;
    }

    public void ApplyHeaders(HttpClient client)
    {
        client.DefaultRequestHeaders.Remove(HeaderName);
        client.DefaultRequestHeaders.Add(HeaderName, GetSharedKey());
    }

    public bool IsAuthorized(HttpContext ctx)
    {
        if (!ctx.Request.Headers.TryGetValue(HeaderName, out var provided))
            return false;

        var expected = GetSharedKey();
        if (string.IsNullOrWhiteSpace(expected) || provided.Count == 0)
            return false;

        if (!string.Equals(provided[0], expected, StringComparison.Ordinal))
            return false;

        return IsTrustedRemote(ctx.Connection.RemoteIpAddress?.ToString());
    }

    public ClaimsPrincipal CreatePrincipal()
    {
        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, "00000000-0000-0000-0000-000000000001"),
            new Claim(ClaimTypes.Name, "internal_machine"),
            new Claim(ClaimTypes.Role, "admin"),
            new Claim(InternalMachineClaim, "true"),
            new Claim("fullName", "Internal Machine Auth")
        };
        return new ClaimsPrincipal(new ClaimsIdentity(claims, "InternalMachine"));
    }

    public bool IsInternalMachine(ClaimsPrincipal? user)
        => user?.HasClaim(InternalMachineClaim, "true") == true;

    private string GetSharedKey()
        => _config["InternalAuth:SharedKey"] ?? DefaultSharedKey;

    private bool IsTrustedRemote(string? ip)
    {
        if (string.IsNullOrWhiteSpace(ip))
            return false;

        var prefixes = (_config["InternalAuth:TrustedNetworks"] ?? DefaultTrustedNetworks)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        return prefixes.Any(prefix => ip.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
    }
}
