// ============================================================
// DeviceService — Xử lý kết nối thiết bị
// - Test kết nối (ping + protocol check)
// - Quét LAN tìm thiết bị mới
// - Đăng ký/xóa camera stream với go2rtc
// ============================================================

using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Http.Json;
using System.Net.NetworkInformation;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using StationOS.Data.Entities;
using StationOS.Services.Security;

namespace StationOS.Services.Devices;

public class DeviceService
{
    private readonly IHttpClientFactory _http;
    private readonly IConfiguration _config;
    private readonly ILogger<DeviceService> _logger;
    private readonly CredentialEncryptionService _crypto;
    private readonly IServiceScopeFactory _scopeFactory;

    // go2rtc REST API mặc định chạy tại port 1984
    private string Go2RtcUrl => _config["Go2Rtc:ApiUrl"] ?? "http://127.0.0.1:1984";

    public DeviceService(IHttpClientFactory http, IConfiguration config, ILogger<DeviceService> logger, CredentialEncryptionService crypto, IServiceScopeFactory scopeFactory)
    {
        _http = http;
        _config = config;
        _logger = logger;
        _crypto = crypto;
        _scopeFactory = scopeFactory;
    }

    /// <summary>
    /// Test kết nối thiết bị bằng ICMP ping
    /// Với PLC S7: thêm kiểm tra port 102 (S7comm)
    /// Với Camera: kiểm tra port 554 (RTSP)
    /// </summary>
    public async Task<TestResult> TestConnectionAsync(Device device)
    {
        var config = ParseConfig(device.Config);
        var ip = config?.GetValueOrDefault("ip")?.ToString();
        if (string.IsNullOrEmpty(ip))
            return new TestResult(false, "Thiết bị không có cấu hình IP", 0);

        try
        {
            var sw = Stopwatch.StartNew();
            var ping = new Ping();
            var reply = await ping.SendPingAsync(ip, 2000);
            sw.Stop();

            if (reply.Status != IPStatus.Success)
                return new TestResult(false, $"Ping thất bại: {reply.Status}", 0);

            // Kiểm tra port đặc trưng theo loại thiết bị
            if (device.Type == "plc_s7")
            {
                var portOk = await CheckPortAsync(ip, 102); // S7comm port
                if (!portOk)
                    return new TestResult(false, $"Ping OK nhưng port S7 (102) không phản hồi", (int)sw.ElapsedMilliseconds);
            }
            else if (device.Type.StartsWith("camera"))
            {
                var portOk = await CheckPortAsync(ip, 554); // RTSP port
                if (!portOk)
                    return new TestResult(false, $"Ping OK nhưng port RTSP (554) không phản hồi", (int)sw.ElapsedMilliseconds);
            }

            return new TestResult(true, $"Kết nối thành công", (int)sw.ElapsedMilliseconds);
        }
        catch (Exception ex)
        {
            return new TestResult(false, $"Lỗi: {ex.Message}", 0);
        }
    }

    /// <summary>
    /// Quét subnet tìm thiết bị đang online
    /// Ví dụ: subnet = "192.168.10" → quét 192.168.10.1 đến .254
    /// Trả về danh sách IP đang phản hồi ping
    /// </summary>
    public async Task<List<ScannedDevice>> ScanLanAsync(string subnet)
    {
        var results = new List<ScannedDevice>();
        var tasks = new List<Task>();

        for (int i = 1; i <= 254; i++)
        {
            var ip = $"{subnet}.{i}";
            tasks.Add(Task.Run(async () =>
            {
                try
                {
                    var ping = new Ping();
                    var reply = await ping.SendPingAsync(ip, 500);
                    if (reply.Status == IPStatus.Success)
                    {
                        // Đoán loại thiết bị theo port
                        var type = await GuessDeviceTypeAsync(ip);
                        lock (results)
                        {
                            results.Add(new ScannedDevice(ip, type, (int)reply.RoundtripTime));
                        }
                    }
                }
                catch { }
            }));
        }

        await Task.WhenAll(tasks);
        return results.OrderBy(r => r.Ip).ToList();
    }

    /// <summary>
    /// Đăng ký camera stream với go2rtc API
    /// go2rtc sẽ kết nối RTSP và chuẩn bị stream cho frontend
    /// Với Hikvision /Channels/101: tự động đăng ký thêm sub-stream /Channels/102
    /// </summary>
    public async Task RegisterCameraStreamAsync(Device device)
    {
        var config = ParseConfig(device.Config);
        if (config == null) return;

        var ip       = config.GetValueOrDefault("ip")?.ToString();
        var username = config.GetValueOrDefault("username")?.ToString() ?? "admin";
        var rawPassword = config.GetValueOrDefault("password")?.ToString() ?? "admin";
        var password = _crypto.Decrypt(rawPassword);
        var encodedPassword = Uri.EscapeDataString(password);

        try
        {
            var client = _http.CreateClient();

            // Bước 1: Lấy streams hiện tại từ go2rtc
            var existingStreams = new Dictionary<string, string>();
            try
            {
                var getRes = await client.GetAsync($"{Go2RtcUrl}/api/streams");
                if (getRes.IsSuccessStatusCode)
                {
                    var json = await getRes.Content.ReadAsStringAsync();
                    var parsed = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json);
                    if (parsed != null)
                    {
                        foreach (var kv in parsed)
                        {
                            if (kv.Value.TryGetProperty("producers", out var producers) &&
                                producers.GetArrayLength() > 0 &&
                                producers[0].TryGetProperty("url", out var urlEl))
                            {
                                existingStreams[kv.Key] = urlEl.GetString()!;
                            }
                        }
                    }
                }
            }
            catch { /* go2rtc chưa sẵn sàng, bỏ qua */ }

            // Nếu camera config có "ffmpeg_transcode": true → wrap URL để transcode H265→H264 qua FFmpeg
            // Cần thiết khi camera phát H265/HEVC vì WebRTC browsers không hỗ trợ H265 natively
            var useFfmpeg = config.GetValueOrDefault("ffmpeg_transcode") is bool b && b
                         || config.GetValueOrDefault("ffmpeg_transcode")?.ToString()?.ToLower() == "true";

            string WrapStream(string rtspUrl) =>
                useFfmpeg ? $"ffmpeg:{rtspUrl}#video=h264" : rtspUrl;

            if (device.Type == "camera_dual")
            {
                // Đăng ký cả 2 luồng: quang học và nhiệt
                var opticalPath = config.GetValueOrDefault("rtsp_optical")?.ToString() ?? "/Streaming/Channels/101";
                var opticalId   = config.GetValueOrDefault("go2rtc_optical")?.ToString() ?? $"cam_{ip?.Replace(".", "_")}_optical";
                var thermalPath = config.GetValueOrDefault("rtsp_thermal")?.ToString() ?? "/Streaming/Channels/201";
                var thermalId   = config.GetValueOrDefault("go2rtc_thermal")?.ToString() ?? $"cam_{ip?.Replace(".", "_")}_thermal";

                var rtspOpticalUrl = $"rtsp://{username}:{encodedPassword}@{ip}:554{opticalPath}";
                var rtspThermalUrl = $"rtsp://{username}:{encodedPassword}@{ip}:554{thermalPath}";

                existingStreams[opticalId] = rtspOpticalUrl;
                existingStreams[thermalId] = WrapStream(rtspThermalUrl);

                // Thêm sub-stream cho luồng quang học nếu có
                var subOpticalPath = DeriveHikvisionSubPath(opticalPath);
                if (subOpticalPath != null)
                {
                    var subOpticalId = opticalId + "_sub";
                    existingStreams[subOpticalId] = $"rtsp://{username}:{encodedPassword}@{ip}:554{subOpticalPath}";
                }

                _logger.LogInformation("[go2rtc] Đăng ký camera_dual: {OptId} ({OptPath}) + {ThId} ({ThPath}){Ffmpeg}",
                    opticalId, opticalPath, thermalId, thermalPath, useFfmpeg ? " [ffmpeg transcode]" : "");
            }
            else if (device.Type == "camera_thermal")
            {
                // Dùng rtsp_thermal hoặc rtsp_path (tương thích cả 2 cách đặt config)
                var thermalPath = config.GetValueOrDefault("rtsp_thermal")?.ToString()
                               ?? config.GetValueOrDefault("rtsp_path")?.ToString()
                               ?? "/Streaming/Channels/201";
                // Dùng go2rtc_thermal hoặc go2rtc_id (tương thích cả 2 cách đặt config)
                var thermalId   = config.GetValueOrDefault("go2rtc_thermal")?.ToString()
                               ?? config.GetValueOrDefault("go2rtc_id")?.ToString()
                               ?? $"cam_{ip?.Replace(".", "_")}_thermal";
                var rtspThermalUrl = $"rtsp://{username}:{encodedPassword}@{ip}:554{thermalPath}";

                existingStreams[thermalId] = WrapStream(rtspThermalUrl);

                _logger.LogInformation("[go2rtc] Đăng ký camera_thermal: {ThId} ({ThPath}){Ffmpeg}",
                    thermalId, thermalPath, useFfmpeg ? " [ffmpeg transcode]" : "");
            }
            else
            {
                var rtspPath = config.GetValueOrDefault("rtsp_path")?.ToString() ?? "/stream1";
                var streamId = config.GetValueOrDefault("go2rtc_id")?.ToString() ?? device.Id.ToString()[..8];
                var rtspUrl = $"rtsp://{username}:{encodedPassword}@{ip}:554{rtspPath}";

                existingStreams[streamId] = WrapStream(rtspUrl);

                var subRtspPath = DeriveHikvisionSubPath(rtspPath);
                if (subRtspPath != null)
                {
                    var subStreamId = streamId + "_sub";
                    existingStreams[subStreamId] = $"rtsp://{username}:{encodedPassword}@{ip}:554{subRtspPath}";
                }

                _logger.LogInformation("[go2rtc] Đăng ký stream {StreamId} -> {RtspPath}{Ffmpeg}",
                    streamId, rtspPath, useFfmpeg ? " [ffmpeg transcode]" : "");
            }

            // Bước 3: DELETE rồi PUT lại để đảm bảo credentials cũ được ghi đè
            int registered = 0, failed = 0;
            foreach (var kv in existingStreams)
            {
                try
                {
                    // Xóa stream cũ trước (bỏ qua lỗi nếu chưa tồn tại)
                    await client.DeleteAsync($"{Go2RtcUrl}/api/streams?name={Uri.EscapeDataString(kv.Key)}");
                    await Task.Delay(50);
                    // Đăng ký lại với URL mới (đúng mật khẩu)
                    var url = $"{Go2RtcUrl}/api/streams?name={Uri.EscapeDataString(kv.Key)}&src={Uri.EscapeDataString(kv.Value)}";
                    var resp = await client.PutAsync(url, null);
                    if (resp.IsSuccessStatusCode) registered++;
                    else
                    {
                        failed++;
                        _logger.LogWarning("[go2rtc] Đăng ký {Name} thất bại: {Status}", kv.Key, resp.StatusCode);
                    }
                }
                catch (Exception inner)
                {
                    failed++;
                    _logger.LogWarning("[go2rtc] Lỗi PUT {Name}: {Msg}", kv.Key, inner.Message);
                }
            }
            _logger.LogInformation("[go2rtc] Sync xong {Reg} streams ({Failed} fail)", registered, failed);
        }
        catch (Exception ex)
        {
            _logger.LogWarning("[go2rtc] Không đăng ký được stream: {Msg}", ex.Message);
        }
    }

    /// <summary>
    /// Sync toàn bộ camera từ DB lên go2rtc khi backend khởi động
    /// Gọi từ Program.cs sau khi migrate
    /// </summary>
    public async Task SyncAllCamerasToGo2RtcAsync(IEnumerable<Device> cameras)
    {
        foreach (var cam in cameras.Where(c => c.Type.StartsWith("camera")))
        {
            await RegisterCameraStreamAsync(cam);
            await Task.Delay(100); // tránh flood go2rtc
        }
        _logger.LogInformation("[go2rtc] Đã sync {Count} camera streams", cameras.Count(c => c.Type.StartsWith("camera")));
    }

    /// <summary>
    /// Xóa camera stream khỏi go2rtc khi xóa thiết bị
    /// Cũng xóa sub-stream nếu có
    /// </summary>
    public async Task UnregisterCameraStreamAsync(Device device)
    {
        var config = ParseConfig(device.Config);
        if (config == null) return;
        try
        {
            var client = _http.CreateClient();
            if (device.Type == "camera_dual")
            {
                var opticalId = config.GetValueOrDefault("go2rtc_optical")?.ToString() ?? $"cam_{config.GetValueOrDefault("ip")?.ToString()?.Replace(".", "_")}_optical";
                var thermalId = config.GetValueOrDefault("go2rtc_thermal")?.ToString() ?? $"cam_{config.GetValueOrDefault("ip")?.ToString()?.Replace(".", "_")}_thermal";

                await client.DeleteAsync($"{Go2RtcUrl}/api/streams?src={opticalId}");
                await client.DeleteAsync($"{Go2RtcUrl}/api/streams?src={opticalId}_sub");
                await client.DeleteAsync($"{Go2RtcUrl}/api/streams?src={thermalId}");
                _logger.LogInformation("[go2rtc] Đã xóa camera_dual streams: {OptId}, {ThId}", opticalId, thermalId);
            }
            else if (device.Type == "camera_thermal")
            {
                var thermalId = config.GetValueOrDefault("go2rtc_thermal")?.ToString() ?? $"cam_{config.GetValueOrDefault("ip")?.ToString()?.Replace(".", "_")}_thermal";

                await client.DeleteAsync($"{Go2RtcUrl}/api/streams?src={thermalId}");
                await client.DeleteAsync($"{Go2RtcUrl}/api/streams?src={thermalId}_sub");
                _logger.LogInformation("[go2rtc] Đã xóa camera_thermal stream: {ThId}", thermalId);
            }
            else
            {
                var streamId = config.GetValueOrDefault("go2rtc_id")?.ToString()
                               ?? device.Id.ToString()[..8];
                var rtspPath = config?.GetValueOrDefault("rtsp_path")?.ToString();

                await client.DeleteAsync($"{Go2RtcUrl}/api/streams?src={streamId}");
                _logger.LogInformation("[go2rtc] Đã xóa stream {StreamId}", streamId);

                // Xóa sub-stream nếu camera có /Channels/101
                if (rtspPath != null && DeriveHikvisionSubPath(rtspPath) != null)
                {
                    var subStreamId = streamId + "_sub";
                    await client.DeleteAsync($"{Go2RtcUrl}/api/streams?src={subStreamId}");
                    _logger.LogInformation("[go2rtc] Đã xóa sub-stream {SubStreamId}", subStreamId);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning("[go2rtc] Không xóa được stream: {Msg}", ex.Message);
        }
    }

    /// <summary>
    /// Đồng bộ cả ROI points và boundaries (zones) sang AI Engine.
    /// </summary>
    public async Task SyncThermalConfigToAIEngineAsync(Guid deviceId)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<Data.AppDbContext>();

            var device = await db.Devices.FindAsync(deviceId);
            if (device == null || (!device.Type.Equals("camera_dual", StringComparison.OrdinalIgnoreCase) && !device.Type.Equals("camera_thermal", StringComparison.OrdinalIgnoreCase)))
                return;

            var points = await db.RoiPoints
                .Where(r => r.DeviceId == deviceId)
                .OrderBy(r => r.CreatedAt)
                .ToListAsync();

            var boundaries = await db.Boundaries
                .Where(b => b.DeviceId == deviceId && b.Type == "roi")
                .ToListAsync();

            var configDict = ParseConfig(device.Config) ?? [];
            var ip = configDict.GetValueOrDefault("ip")?.ToString() ?? "";
            var username = configDict.GetValueOrDefault("username")?.ToString() ?? "admin";
            var password = "";
            var rawPassword = configDict.GetValueOrDefault("password")?.ToString();
            if (!string.IsNullOrEmpty(rawPassword))
            {
                try { password = _crypto.Decrypt(rawPassword); }
                catch { password = rawPassword; }
            }

            var streamId = configDict.GetValueOrDefault("go2rtc_thermal")?.ToString();
            if (string.IsNullOrEmpty(streamId))
            {
                streamId = configDict.GetValueOrDefault("go2rtc_id")?.ToString();
            }

            if (string.IsNullOrEmpty(streamId))
                return;

            var jetsonIp = configDict.GetValueOrDefault("jetson_ip")?.ToString();

            var zonesList = new List<object>();
            foreach (var b in boundaries)
            {
                var thresholds = new Dictionary<string, object>();
                if (!string.IsNullOrEmpty(b.ThresholdsJson))
                {
                    try { thresholds = JsonSerializer.Deserialize<Dictionary<string, object>>(b.ThresholdsJson) ?? []; } catch {}
                }

                double alarmVal = 70.0;
                double warningVal = 50.0;
                if (thresholds.TryGetValue("alarm", out var aVal) && aVal != null)
                {
                    try { alarmVal = Convert.ToDouble(aVal.ToString()); } catch {}
                }
                if (thresholds.TryGetValue("warning", out var wVal) && wVal != null)
                {
                    try { warningVal = Convert.ToDouble(wVal.ToString()); } catch {}
                }

                double[][] poly = [];
                try { poly = JsonSerializer.Deserialize<double[][]>(b.PolygonJson ?? "[]") ?? []; } catch {}

                zonesList.Add(new
                {
                    id = b.Id.ToString(),
                    polygon = poly,
                    pre_alarm = warningVal,
                    alarm = alarmVal,
                    label = b.Name ?? ""
                });
            }

            var payload = new
            {
                stream_id = streamId,
                device_id = deviceId.ToString(),
                camera_ip = ip,
                username = username,
                password = password,
                points = points.Select((p, idx) => new
                {
                    id = !string.IsNullOrEmpty(p.PointId) ? p.PointId : 
                         (System.Text.RegularExpressions.Regex.IsMatch(p.Name ?? "", @"\d+") ? 
                          $"P{System.Text.RegularExpressions.Regex.Match(p.Name ?? "", @"\d+").Value}" : 
                          $"P{idx + 1}"),
                    x = p.Tx,
                    y = p.Ty,
                    pre_alarm = (double)p.PreAlarmThreshold,
                    alarm = (double)p.AlarmThreshold,
                    label = p.Name ?? ""
                }).ToList(),
                zones = zonesList
            };

            using var client = _http.CreateClient();
            var json = JsonSerializer.Serialize(payload);
            var content = new System.Net.Http.StringContent(json, System.Text.Encoding.UTF8, "application/json");
            
            // 1. Đồng bộ sang AI Engine cục bộ trên PC (cổng 8100) để huấn luyện dự báo
            var resp = await client.PostAsync("http://127.0.0.1:8100/api/v1/config/thermal", content);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning($"[SyncThermalConfigToAIEngineAsync] AI Engine returned status {resp.StatusCode} for device {deviceId}");
            }
            else
            {
                _logger.LogInformation($"[SyncThermalConfigToAIEngineAsync] Successfully synchronized {points.Count} points and {boundaries.Count} zones for device {deviceId}");
            }

            // 2. Tự động đồng bộ trực tiếp sang Jetson Orin Nano qua mạng (IP lấy từ config camera)
            if (!string.IsNullOrEmpty(jetsonIp))
            {
                try
                {
                    var jetsonUrl = $"http://{jetsonIp}:8080/config/thermal";
                    using var cts = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(2));
                    var jetsonResp = await client.PostAsync(jetsonUrl, content, cts.Token);
                    if (jetsonResp.IsSuccessStatusCode)
                    {
                        _logger.LogInformation($"[SyncThermalConfigToAIEngineAsync] Successfully forwarded configuration to Jetson at {jetsonIp}:8080 for device {deviceId}");
                    }
                    else
                    {
                        _logger.LogWarning($"[SyncThermalConfigToAIEngineAsync] Jetson at {jetsonIp} returned status {jetsonResp.StatusCode} for device {deviceId}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError($"[SyncThermalConfigToAIEngineAsync] Error forwarding configuration to Jetson at {jetsonIp}: {ex.Message}");
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError($"[SyncThermalConfigToAIEngineAsync] Error synchronizing device {deviceId}: {ex.Message}");
        }
    }

    // ── Private helpers ───────────────────────────────────

    private static Dictionary<string, object>? ParseConfig(string? json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try { return JsonSerializer.Deserialize<Dictionary<string, object>>(json); }
        catch { return null; }
    }

    private static async Task<bool> CheckPortAsync(string ip, int port)
    {
        try
        {
            using var tcp = new System.Net.Sockets.TcpClient();
            var cts = new CancellationTokenSource(1000);
            await tcp.ConnectAsync(ip, port, cts.Token);
            return true;
        }
        catch { return false; }
    }

    private async Task<string> GuessDeviceTypeAsync(string ip)
    {
        // Port 102 → PLC S7, Port 554 → Camera RTSP, Port 502 → Modbus
        if (await CheckPortAsync(ip, 102)) return "plc_s7";
        if (await CheckPortAsync(ip, 554)) return "camera";
        if (await CheckPortAsync(ip, 502)) return "modbus_tcp";
        return "unknown";
    }

    /// <summary>
    /// Tự sinh sub-stream path cho Hikvision:
    ///   /Streaming/Channels/101 → /Streaming/Channels/102
    ///   /Streaming/Channels/201 → null (thermal, không có sub)
    /// </summary>
    private static string? DeriveHikvisionSubPath(string rtspPath)
    {
        var m = System.Text.RegularExpressions.Regex.Match(
            rtspPath, @"^(.*?/Channels/)(\d+)(.*)$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        if (!int.TryParse(m.Groups[2].Value, out var ch)) return null;
        if (ch % 100 != 1) return null;  // Chỉ main stream (x01: 101, 301, ...)
        if (ch / 100 >= 2) return null;  // Bỏ thermal channel 201+
        return m.Groups[1].Value + (ch + 1) + m.Groups[3].Value;
    }
}

public record TestResult(bool Success, string Message, int LatencyMs);
public record ScannedDevice(string Ip, string GuessedType, int PingMs);
