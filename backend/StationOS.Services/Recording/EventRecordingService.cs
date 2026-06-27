// ============================================================
// EventRecordingService — Xây dựng video clip từ buffer khi event kết thúc
// Phục vụ Module 5: Event Clip Builder
// ============================================================

using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Configuration;
using StationOS.Data;
using StationOS.Data.Entities;
using Microsoft.EntityFrameworkCore;
using System.Diagnostics;
using System.Text.Json;

using Microsoft.AspNetCore.Hosting;

namespace StationOS.Services.Recording;

public class EventRecordingService
{
    private readonly AppDbContext _db;
    private readonly ILogger<EventRecordingService> _logger;
    private readonly IWebHostEnvironment _env;
    private readonly string _bufferRoot;
    private readonly string _recordingsRoot;
    private readonly string _ffmpegPath;

    public EventRecordingService(AppDbContext db, ILogger<EventRecordingService> logger, IConfiguration cfg, IWebHostEnvironment env)
    {
        _db = db;
        _logger = logger;
        _env = env;
        
        var webRoot = _env.WebRootPath ?? Path.Combine(_env.ContentRootPath, "wwwroot");

        var bufferSubDir = cfg["Recorder:BufferRoot"]?.Replace("wwwroot/", "") ?? "media/buffer";
        _bufferRoot = Path.IsPathRooted(bufferSubDir) ? bufferSubDir : Path.Combine(webRoot, bufferSubDir);
        
        var recSubDir = cfg["Recorder:RecordingsRoot"]?.Replace("wwwroot/", "") ?? "media/recordings";
        _recordingsRoot = Path.IsPathRooted(recSubDir) ? recSubDir : Path.Combine(webRoot, recSubDir);
        
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
                _ffmpegPath = rawFfmpeg;
            }
        }
        else
        {
            _ffmpegPath = rawFfmpeg;
        }
    }

    /// <summary>
    /// Xây dựng clip cho sự kiện: tìm các segment buffer quanh thời gian event và nối lại.
    /// </summary>
    public async Task BuildClipAsync(Guid eventId, DateTime? eventEndTime = null)
    {
        var evt = await _db.DetectionEvents
            .Include(e => e.Camera)
            .Include(e => e.Alert)
            .FirstOrDefaultAsync(e => e.Id == eventId);

        if (evt == null)
        {
            _logger.LogError("[ClipBuilder] Không tìm thấy event {Id}", eventId);
            return;
        }

        // Nếu là sự kiện tức thời, ta lấy 15s trước và 10s sau
        var start = evt.DetectedAt.AddSeconds(-15); 
        var end = eventEndTime ?? evt.DetectedAt.AddSeconds(10);
        
        _logger.LogInformation("[ClipBuilder] Đang tạo clip cho event {Id} ({Type}) từ {Start} đến {End}", 
            eventId, evt.DetectionType, start, end);

        var camDir = Path.Combine(_bufferRoot, evt.CameraId.ToString());
        if (!Directory.Exists(camDir))
        {
            _logger.LogWarning("[ClipBuilder] Không tìm thấy thư mục buffer cho camera {Id}", evt.CameraId);
            return;
        }

        // 1. Tìm các segment liên quan (mở rộng cửa sổ thời gian để chắc chắn không hụt)
        var segments = Directory.GetFiles(camDir, "seg_*.mp4")
            .Select(f => new FileInfo(f))
            .Where(fi => fi.LastWriteTimeUtc >= start.AddSeconds(-10) && fi.LastWriteTimeUtc <= end.AddSeconds(10))
            .OrderBy(fi => fi.Name)
            .ToList();

        if (segments.Count == 0)
        {
            _logger.LogWarning("[ClipBuilder] Không tìm thấy segment nào cho event {Id} trong khoảng {Start} - {End}", eventId, start, end);
            return;
        }

        // 2. Chuẩn bị thư mục output
        var monthDir = end.ToString("yyyy-MM");
        var outputDir = Path.Combine(_recordingsRoot, monthDir, eventId.ToString());
        if (!Directory.Exists(outputDir)) Directory.CreateDirectory(outputDir);

        var videoPath = Path.Combine(outputDir, "video.mp4");
        var listPath = Path.Combine(outputDir, "concat.txt");

        // 3. Tạo file list cho ffmpeg concat
        await File.WriteAllLinesAsync(listPath, segments.Select(s => $"file '{s.FullName}'"));

        // 4. Gọi FFmpeg concat
        // ffmpeg -f concat -safe 0 -i concat.txt -c copy video.mp4
        var args = $"-f concat -safe 0 -i \"{listPath}\" -c copy -y \"{videoPath}\"";
        
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

            using var proc = Process.Start(psi);
            if (proc != null)
            {
                var error = await proc.StandardError.ReadToEndAsync();
                await proc.WaitForExitAsync();

                if (proc.ExitCode != 0)
                {
                    _logger.LogError("[ClipBuilder] FFmpeg concat thất bại: {Msg}", error);
                    return;
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[ClipBuilder] Lỗi khi chạy FFmpeg concat");
            return;
        }

        // 5. Lưu Metadata & Config Snapshot
        await SaveMetadataAsync(evt, outputDir);

        // 6. Cập nhật MediaFile & DB
        var relativePath = Path.Combine("/media/recordings", monthDir, eventId.ToString(), "video.mp4").Replace("\\", "/");
        var media = new MediaFile
        {
            Id = Guid.NewGuid(),
            Path = relativePath,
            SizeBytes = new FileInfo(videoPath).Length,
            MimeType = "video/mp4",
            CameraId = evt.CameraId,
            CreatedAt = DateTime.UtcNow
        };
        _db.MediaFiles.Add(media);
        
        evt.MediaFileId = media.Id;
        if (evt.Alert != null)
        {
            evt.Alert.VideoUrl = relativePath;
        }

        await _db.SaveChangesAsync();
        _logger.LogInformation("[ClipBuilder] Đã tạo xong clip cho event {Id}: {Path}", eventId, relativePath);
        
        // Dọn dẹp file tạm
        try { File.Delete(listPath); } catch { }
    }

    private async Task SaveMetadataAsync(DetectionEvent evt, string outputDir)
    {
        var meta = new
        {
            evt.Id,
            evt.CameraId,
            cameraName = evt.Camera?.Name,
            evt.DetectionType,
            evt.Label,
            evt.Severity,
            evt.DetectedAt,
            evt.MaxTemp,
            evt.AffectedZone,
            evt.Metadata
        };
        await File.WriteAllTextAsync(Path.Combine(outputDir, "meta.json"), JsonSerializer.Serialize(meta, new JsonSerializerOptions { WriteIndented = true }));

        // Snapshot config (boundaries) tại thời điểm đó
        var boundaries = await _db.Boundaries
            .Where(b => b.DeviceId == evt.CameraId && b.Enabled)
            .ToListAsync();
        
        await File.WriteAllTextAsync(Path.Combine(outputDir, "config_snapshot.json"), JsonSerializer.Serialize(boundaries, new JsonSerializerOptions { WriteIndented = true }));
    }
}
