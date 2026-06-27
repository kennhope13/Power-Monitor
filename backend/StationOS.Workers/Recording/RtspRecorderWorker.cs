// ============================================================
// RtspRecorderWorker — BackgroundService ghi buffer video 30s
// Phục vụ Module 4: NVR Rolling Buffer
// ============================================================

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Configuration;
using StationOS.Data;
using StationOS.Data.Entities;
using StationOS.Services.Security;
using System.Diagnostics;
using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using System.Text.Json;

using Microsoft.AspNetCore.Hosting;
using System.IO;

namespace StationOS.Workers.Recording;

public class RtspRecorderWorker : BackgroundService
{
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<RtspRecorderWorker> _logger;
    private readonly IWebHostEnvironment _env;
    private readonly string _bufferRoot;
    private readonly int _segmentSeconds;
    private readonly int _bufferSeconds;
    private readonly string _ffmpegPath;
    private readonly CredentialEncryptionService _crypto;

    private readonly ConcurrentDictionary<Guid, Process> _processes = new();

    public RtspRecorderWorker(
        IServiceProvider serviceProvider, 
        ILogger<RtspRecorderWorker> logger, 
        IConfiguration cfg,
        CredentialEncryptionService crypto,
        IWebHostEnvironment env)
    {
        _serviceProvider = serviceProvider;
        _logger = logger;
        _crypto = crypto;
        _env = env;
        
        // Cấu hình đường dẫn lưu buffer — Ưu tiên dùng WebRootPath để đồng bộ với API
        var webRoot = _env.WebRootPath ?? Path.Combine(_env.ContentRootPath, "wwwroot");
        var bufferSubDir = cfg["Recorder:BufferRoot"]?.Replace("wwwroot/", "") ?? "media/buffer";
        _bufferRoot = Path.IsPathRooted(bufferSubDir) ? bufferSubDir : Path.Combine(webRoot, bufferSubDir);
        
        _segmentSeconds = cfg.GetValue("Recorder:SegmentSeconds", 5);
        _bufferSeconds = cfg.GetValue("Recorder:BufferSeconds", 60);
        var rawFfmpeg = cfg["Media:FFmpegPath"] ?? "ffmpeg";
        if (rawFfmpeg == "ffmpeg")
        {
            var localFfmpeg = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, OperatingSystem.IsWindows() ? "ffmpeg.exe" : "ffmpeg");
            if (File.Exists(localFfmpeg))
            {
                _ffmpegPath = localFfmpeg;
            }
            else
            {
                _ffmpegPath = rawFfmpeg; // rely on system PATH
            }
        }
        else
        {
            _ffmpegPath = rawFfmpeg;
        }
        // Warn if executable cannot be found when not relying on PATH
        if (_ffmpegPath != "ffmpeg" && !File.Exists(_ffmpegPath))
        {
            _logger?.LogWarning("[NVR] ffmpeg executable not found at configured path: {Path}. Ensure ffmpeg is installed or bundled.", _ffmpegPath);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[NVR] Rolling Buffer Worker started. Root: {Root}", _bufferRoot);

        if (!Directory.Exists(_bufferRoot)) Directory.CreateDirectory(_bufferRoot);

        // Task chạy ngầm dọn dẹp file cũ
        var cleanupTask = Task.Run(async () => {
            while (!stoppingToken.IsCancellationRequested)
            {
                try { CleanupOldSegments(); }
                catch (Exception ex) { _logger.LogError(ex, "[NVR] Error during cleanup"); }
                await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
            }
        }, stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await SyncRecorderProcessesAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[NVR] Error syncing recorder processes");
            }

            // Kiểm tra và sync mỗi 10 giây
            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
        }

        StopAllProcesses();
    }

    private async Task SyncRecorderProcessesAsync(CancellationToken ct)
    {
        using var scope = _serviceProvider.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        // Chỉ ghi hình những camera đang hoạt động (không ở chế độ bảo trì)
        var cameras = await db.Devices
            .Where(d => d.Type.StartsWith("camera") && d.Status != "maintenance")
            .ToListAsync(ct);

        var activeIds = cameras.Select(c => c.Id).ToHashSet();

        // 1. Dừng các camera bị xóa hoặc chuyển sang bảo trì
        foreach (var id in _processes.Keys)
        {
            if (!activeIds.Contains(id))
            {
                StopProcess(id);
            }
        }

        // 2. Bắt đầu ghi hoặc restart nếu process bị chết
        foreach (var cam in cameras)
        {
            if (!_processes.TryGetValue(cam.Id, out var proc) || proc.HasExited)
            {
                if (proc != null && proc.HasExited)
                {
                    _logger.LogWarning("[NVR] Recorder for {Name} exited with code {Code}. Restarting...", cam.Name, proc.ExitCode);
                    _processes.TryRemove(cam.Id, out _);
                }
                
                StartProcess(cam);
            }
        }
    }

    private void StartProcess(Device cam)
    {
        var rtspUrl = GetRtspUrl(cam);
        if (string.IsNullOrEmpty(rtspUrl))
        {
            _logger.LogTrace("[NVR] Skipping {Name}: No RTSP URL found", cam.Name);
            return;
        }

        var camDir = Path.Combine(_bufferRoot, cam.Id.ToString());
        if (!Directory.Exists(camDir)) Directory.CreateDirectory(camDir);

        _logger.LogInformation("[NVR] Starting recorder for {Name} with URL: {Url}", cam.Name, rtspUrl);

        // Command FFmpeg để chia segment:
        // -rtsp_transport tcp: Dùng TCP cho ổn định
        // -i: Input RTSP
        // -c copy: Không transcode (tiết kiệm CPU)
        // -f segment: Chia file
        // -segment_time: Độ dài mỗi segment (5s)
        // -reset_timestamps 1: Reset timestamp mỗi file để trình phát không bị lệch
        // -strftime 1: Đặt tên file theo thời gian
        var args = $"-hide_banner -loglevel error -rtsp_transport tcp -i \"{rtspUrl}\" " +
                   $"-c copy -f segment -segment_time {_segmentSeconds} -segment_atclocktime 1 " +
                   $"-reset_timestamps 1 -strftime 1 \"{Path.Combine(camDir, "seg_%Y%m%d_%H%M%S.mp4")}\"";

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = _ffmpegPath,
                Arguments = args,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true
            };

            var proc = Process.Start(psi);
            if (proc != null)
            {
                _processes[cam.Id] = proc;
                _logger.LogInformation("[NVR] Started recording camera: {Name}", cam.Name);
                
                // Đọc lỗi từ ffmpeg (nếu có) để log
                _ = Task.Run(async () => {
                    var error = await proc.StandardError.ReadToEndAsync(CancellationToken.None);
                    if (!string.IsNullOrEmpty(error))
                        _logger.LogError("[NVR] FFmpeg Error ({Name}): {Msg}", cam.Name, error);
                });
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[NVR] Failed to start FFmpeg for {Name}", cam.Name);
        }
    }

    private void StopProcess(Guid id)
    {
        if (_processes.TryRemove(id, out var proc))
        {
            try
            {
                if (!proc.HasExited)
                {
                    proc.Kill();
                    _logger.LogInformation("[NVR] Stopped recording for camera: {Id}", id);
                }
            }
            catch (Exception ex) { _logger.LogError(ex, "[NVR] Error killing process {Id}", id); }
            finally { proc.Dispose(); }
        }
    }

    private void StopAllProcesses()
    {
        _logger.LogInformation("[NVR] Stopping all recorder processes...");
        foreach (var id in _processes.Keys) StopProcess(id);
    }

    private void CleanupOldSegments()
    {
        if (!Directory.Exists(_bufferRoot)) return;

        var now = DateTime.UtcNow;
        // Dọn dẹp các file cũ hơn ngưỡng buffer (cộng thêm 10s an toàn)
        var threshold = TimeSpan.FromSeconds(_bufferSeconds + 10);

        var dirs = Directory.GetDirectories(_bufferRoot);
        int deletedCount = 0;

        foreach (var camDir in dirs)
        {
            var files = Directory.GetFiles(camDir, "seg_*.mp4");
            foreach (var file in files)
            {
                var fi = new FileInfo(file);
                if (now - fi.LastWriteTimeUtc > threshold)
                {
                    try { fi.Delete(); deletedCount++; } catch { }
                }
            }
        }
        
        if (deletedCount > 0)
            _logger.LogDebug("[NVR] Cleaned up {Count} old segments", deletedCount);
    }

    private string? GetRtspUrl(Device cam)
    {
        try
        {
            var configJson = _crypto.DecryptPasswordInConfigJson(cam.Config);
            if (string.IsNullOrEmpty(configJson)) return null;

            using var doc = JsonDocument.Parse(configJson);
            var root = doc.RootElement;

            // 1. Ưu tiên dùng go2rtc proxy (localhost:8554) vì nó ổn định và đã được go2rtc duy trì kết nối
            string? go2rtcId = null;
            if (root.TryGetProperty("go2rtc_thermal", out var gTherm)) go2rtcId = gTherm.GetString();
            else if (root.TryGetProperty("go2rtc_optical", out var gOpt)) go2rtcId = gOpt.GetString();
            else if (root.TryGetProperty("go2rtc_id", out var gId)) go2rtcId = gId.GetString();

            if (!string.IsNullOrEmpty(go2rtcId)) {
                var proxyUrl = $"rtsp://localhost:8554/{go2rtcId}";
                _logger.LogInformation("[NVR] Using go2rtc proxy for {Name}: {Url}", cam.Name, proxyUrl);
                return proxyUrl;
            }

            // 2. Fallback sang RTSP trực tiếp nếu không có go2rtc config
            string? ip = root.TryGetProperty("ip", out var ipEl) ? ipEl.GetString() : null;
            string? user = root.TryGetProperty("username", out var userEl) ? userEl.GetString() : null;
            string? pass = root.TryGetProperty("password", out var passEl) ? passEl.GetString() : null;
            
            string? directPath = null;
            if (root.TryGetProperty("rtsp_thermal", out var therm)) directPath = therm.GetString();
            else if (root.TryGetProperty("rtsp_optical", out var opt)) directPath = opt.GetString();
            else if (root.TryGetProperty("rtsp_path", out var path)) directPath = path.GetString();

            if (!string.IsNullOrEmpty(ip) && !string.IsNullOrEmpty(user)) {
                var pathStr = directPath ?? "/Streaming/Channels/101";
                if (!pathStr.StartsWith("/")) pathStr = "/" + pathStr;
                return $"rtsp://{user}:{Uri.EscapeDataString(pass ?? "")}@{ip}:554{pathStr}";
            }
        }
        catch { }
        return null;
    }
}
