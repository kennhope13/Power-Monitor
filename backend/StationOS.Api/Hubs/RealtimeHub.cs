// ============================================================
// RealtimeHub — SignalR WebSocket Hub
// Client kết nối tới: ws://localhost:5056/ws/realtime
// Events server push:
//   "SensorUpdate" → [{pointId, value, unit, time}]
//   "AlertNew"     → {id, level, message}
//   "DeviceStatus" → {deviceId, status}
// ============================================================

using Microsoft.AspNetCore.SignalR;
using StationOS.Services;

namespace StationOS.Api.Hubs;

public class RealtimeHub : Hub
{
    private readonly LicenseService _license;

    public RealtimeHub(LicenseService license)
    {
        _license = license;
    }

    /// <summary>
    /// Được gọi khi client kết nối tới WebSocket hub.
    /// Dùng để log hoặc thêm client vào group nếu cần sau này.
    /// </summary>
    public override async Task OnConnectedAsync()
    {
        await base.OnConnectedAsync();
    }

    /// <summary>
    /// Được gọi khi client ngắt kết nối khỏi WebSocket hub.
    /// Dùng để dọn dẹp tài nguyên hoặc ghi log kết nối bị mất.
    /// </summary>
    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var sessionId = Context.User?.FindFirst("sessionId")?.Value;
        if (string.IsNullOrEmpty(sessionId))
        {
            var httpContext = Context.GetHttpContext();
            var rawToken = httpContext?.Request.Query["access_token"].ToString();
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

        await base.OnDisconnectedAsync(exception);
    }
}
