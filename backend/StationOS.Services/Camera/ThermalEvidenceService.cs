using System.Diagnostics;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using StationOS.Data;
using StationOS.Data.Entities;

namespace StationOS.Services.Camera;

public class ThermalEvidenceService
{
    private readonly IConfiguration _config;
    private readonly IWebHostEnvironment _env;
    private readonly HikvisionIsapiService _hikvision;
    private readonly ILogger<ThermalEvidenceService> _logger;
    private readonly IHttpClientFactory _http;

    private string Go2RtcApiUrl => _config["Go2Rtc:ApiUrl"] ?? "http://127.0.0.1:1984";
    private string Go2RtcRtspUrl => _config["Go2Rtc:RtspUrl"] ?? "rtsp://127.0.0.1:8554";
    private string FfmpegPath
    {
        get
        {
            var rawFfmpeg = _config["Media:FFmpegPath"] ?? "ffmpeg";
            if (rawFfmpeg == "ffmpeg")
            {
                var localFfmpeg = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, OperatingSystem.IsWindows() ? "ffmpeg.exe" : "ffmpeg");
                if (File.Exists(localFfmpeg))
                {
                    return localFfmpeg;
                }
            }
            return rawFfmpeg;
        }
    }
    private int ClipSeconds => int.TryParse(_config["Media:ClipSeconds"], out var secs) ? Math.Clamp(secs, 5, 30) : 12;

    public ThermalEvidenceService(
        IConfiguration config,
        IWebHostEnvironment env,
        HikvisionIsapiService hikvision,
        ILogger<ThermalEvidenceService> logger,
        IHttpClientFactory http)
    {
        _config = config;
        _env = env;
        _hikvision = hikvision;
        _logger = logger;
        _http = http;
    }

    public virtual async Task<ThermalEvidenceResult?> CaptureForAlertAsync(
        AppDbContext db,
        Guid stationId,
        CancellationToken ct)
    {
        var camera = await db.Devices
            .Where(d => d.StationId == stationId && d.Type == "camera_thermal")
            .OrderBy(d => d.Name)
            .FirstOrDefaultAsync(ct);

        if (camera == null)
        {
            _logger.LogWarning("[Evidence] Khong tim thay camera_thermal cho station {StationId}", stationId);
            return null;
        }

        var cfg = ParseConfig(camera.Config);
        if (cfg == null)
        {
            _logger.LogWarning("[Evidence] Camera {Camera} khong co config hop le", camera.Name);
            return new ThermalEvidenceResult(camera);
        }

        var streamId = GetCfg(cfg, "go2rtc_id");
        var ip = GetCfg(cfg, "ip");
        var user = GetCfg(cfg, "username") ?? "admin";
        var pass = GetCfg(cfg, "password") ?? "admin";
        var rtspPath = GetCfg(cfg, "rtsp_path") ?? "/Streaming/Channels/201";

        var mediaRoot = Path.Combine(_env.WebRootPath ?? Path.Combine(_env.ContentRootPath, "wwwroot"), "media");
        var detectionsDir = Path.Combine(mediaRoot, "detections");
        var videosDir = Path.Combine(mediaRoot, "videos");
        Directory.CreateDirectory(detectionsDir);
        Directory.CreateDirectory(videosDir);

        string? imageUrl = null;
        string? thumbUrl = null;
        string? videoUrl = null;

        var snapshotBytes = await TryGetSnapshotAsync(streamId, ip, user, pass, ct);
        if (snapshotBytes?.Length > 0)
        {
            var imageName = $"{Guid.NewGuid()}.jpg";
            var imagePath = Path.Combine(detectionsDir, imageName);
            await File.WriteAllBytesAsync(imagePath, snapshotBytes, ct);
            imageUrl = $"/media/detections/{imageName}";

            var thumbName = $"{Guid.NewGuid()}_thumb.jpg";
            var thumbPath = Path.Combine(detectionsDir, thumbName);
            await File.WriteAllBytesAsync(thumbPath, snapshotBytes, ct);
            thumbUrl = $"/media/detections/{thumbName}";
        }

        var durationSetting = await db.SystemSettings.FirstOrDefaultAsync(s => s.Key == "camera_record_duration_s", ct);
        int clipDuration = ClipSeconds;
        if (durationSetting != null && int.TryParse(durationSetting.Value.Trim('"'), out var pSecs) && pSecs > 0)
            clipDuration = pSecs;

        videoUrl = await TryRecordClipAsync(streamId, ip, user, pass, rtspPath, videosDir, clipDuration, ct);

        return new ThermalEvidenceResult(camera)
        {
            ImageUrl = imageUrl,
            ThumbnailUrl = thumbUrl ?? imageUrl,
            VideoUrl = videoUrl,
        };
    }

    private async Task<byte[]?> TryGetSnapshotAsync(
        string? streamId,
        string? ip,
        string user,
        string pass,
        CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(streamId))
        {
            try
            {
                var client = _http.CreateClient();
                using var res = await client.GetAsync($"{Go2RtcApiUrl}/api/frame.jpeg?src={Uri.EscapeDataString(streamId)}", ct);
                if (res.IsSuccessStatusCode)
                    return await res.Content.ReadAsByteArrayAsync(ct);
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "[Evidence] Snapshot qua go2rtc that bai cho stream {StreamId}", streamId);
            }
        }

        if (!string.IsNullOrWhiteSpace(ip))
            return await _hikvision.GetSnapshotAsync(ip, user, pass, channel: 2);

        return null;
    }

    public async Task<string?> TryRecordClipAsync(
        string? streamId,
        string? ip,
        string user,
        string pass,
        string rtspPath,
        string videosDir,
        int clipDuration,
        CancellationToken ct)
    {
        var input = BuildClipInput(streamId, ip, user, pass, rtspPath);
        if (string.IsNullOrWhiteSpace(input))
            return null;

        var fileName = $"{Guid.NewGuid()}.mp4";
        var outputPath = Path.Combine(videosDir, fileName);

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = FfmpegPath,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add("-y");
            psi.ArgumentList.Add("-rtsp_transport");
            psi.ArgumentList.Add("tcp");
            psi.ArgumentList.Add("-i");
            psi.ArgumentList.Add(input);
            psi.ArgumentList.Add("-t");
            psi.ArgumentList.Add(clipDuration.ToString());
            psi.ArgumentList.Add("-an");
            psi.ArgumentList.Add("-c:v");
            psi.ArgumentList.Add("libx264");
            psi.ArgumentList.Add("-preset");
            psi.ArgumentList.Add("ultrafast");
            psi.ArgumentList.Add("-movflags");
            psi.ArgumentList.Add("+faststart");
            psi.ArgumentList.Add(outputPath);

            using var process = Process.Start(psi);
            if (process == null)
                return null;

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(clipDuration + 15));
            await process.WaitForExitAsync(timeoutCts.Token);

            if (process.ExitCode == 0 && File.Exists(outputPath) && new FileInfo(outputPath).Length > 0)
                return $"/media/videos/{fileName}";

            var stderr = await process.StandardError.ReadToEndAsync(ct);
            _logger.LogWarning("[Evidence] ffmpeg that bai (exit={ExitCode}): {Error}", process.ExitCode, stderr);
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning("[Evidence] Ghi clip bi timeout");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Evidence] Khong ghi duoc clip");
        }

        TryDelete(outputPath);
        return null;
    }

    private string? BuildClipInput(string? streamId, string? ip, string user, string pass, string rtspPath)
    {
        // 1. Ưu tiên dùng go2rtc proxy (localhost:8554)
        if (!string.IsNullOrWhiteSpace(streamId))
            return $"rtsp://127.0.0.1:8554/{streamId}";

        // 2. Fallback sang RTSP trực tiếp
        if (string.IsNullOrWhiteSpace(ip))
            return null;

        if (!rtspPath.StartsWith("/")) rtspPath = "/" + rtspPath;
        return $"rtsp://{user}:{Uri.EscapeDataString(pass)}@{ip}:554{rtspPath}";
    }

    private static Dictionary<string, string>? ParseConfig(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            var raw = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json);
            return raw?.ToDictionary(kv => kv.Key, kv => kv.Value.ToString());
        }
        catch
        {
            return null;
        }
    }

    private static string? GetCfg(Dictionary<string, string> cfg, string key)
        => cfg.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value : null;

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch { }
    }
}

public class ThermalEvidenceResult
{
    public ThermalEvidenceResult(Device camera) => Camera = camera;

    public Device Camera { get; }
    public string? ImageUrl { get; init; }
    public string? ThumbnailUrl { get; init; }
    public string? VideoUrl { get; init; }
}
