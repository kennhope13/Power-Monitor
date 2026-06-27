// ============================================================
// PersonDetectionController — Nhận HTTP event từ Jetson Orin Nano
// POST /api/person-detection (AllowAnonymous)
// ============================================================

using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using StationOS.Data;
using StationOS.Data.Entities;
using StationOS.Services;
using System.Collections.Generic;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/person-detection")]
public class PersonDetectionController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IRealtimeNotifier _notifier;
    private readonly IWebHostEnvironment _env;
    private readonly ILogger<PersonDetectionController> _logger;
    private readonly string _rootPath;
    private readonly Microsoft.Extensions.DependencyInjection.IServiceScopeFactory _scopeFactory;

    public PersonDetectionController(
        AppDbContext db,
        IRealtimeNotifier notifier,
        IWebHostEnvironment env,
        ILogger<PersonDetectionController> logger,
        Microsoft.Extensions.DependencyInjection.IServiceScopeFactory scopeFactory)
    {
        _db = db;
        _notifier = notifier;
        _env = env;
        _logger = logger;
        _scopeFactory = scopeFactory;
        _rootPath = env.WebRootPath ?? Path.Combine(env.ContentRootPath, "wwwroot");
    }

    /// <summary>Nhận webhook sự kiện phát hiện người từ thiết bị Jetson Orin Nano. Lưu ảnh, tạo Alert, DetectionEvent và đẩy thông báo realtime qua SignalR.</summary>
    /// <param name="image">Ảnh chụp màn hình từ camera tại thời điểm phát hiện (multipart/form-data, tùy chọn).</param>
    /// <param name="video">Video clip sự kiện (multipart/form-data, tùy chọn).</param>
    /// <param name="metadata">JSON metadata: timestamp, camera_ip, person_count, alert_type, boxes (multipart/form-data).</param>
    /// <returns>Thông báo thành công kèm alertId, hoặc lỗi nếu metadata không hợp lệ.</returns>
    [HttpPost]
    [AllowAnonymous]
    public async Task<IActionResult> Receive([FromForm] IFormFile? image, [FromForm] IFormFile? video, [FromForm] string? metadata)
    {
        _logger.LogInformation("[PersonDetection] Nhận request webhook từ Jetson Orin Nano");

        if (string.IsNullOrWhiteSpace(metadata))
        {
            _logger.LogWarning("[PersonDetection] Thiếu phần dữ liệu metadata");
            return BadRequest("Metadata is required");
        }

        PersonDetectionMetadataDto? metadataDto = null;
        try
        {
            using var doc = JsonDocument.Parse(metadata);
            var root = doc.RootElement;

            metadataDto = new PersonDetectionMetadataDto
            {
                Timestamp = root.TryGetProperty("timestamp", out var ts) ? ts.GetString() ?? "" : "",
                Camera_Ip = root.TryGetProperty("camera_ip", out var ip) ? ip.GetString() ?? "" : "",
                Person_Count = root.TryGetProperty("person_count", out var pc) ? (pc.ValueKind == JsonValueKind.Number && pc.TryGetInt32(out var pVal) ? pVal : 0) : 0,
                Alert_Type = root.TryGetProperty("alert_type", out var at) ? at.GetString() ?? "person_detected" : "person_detected",
                Boxes = new List<BoundingBoxDto>()
            };

            if (root.TryGetProperty("boxes", out var boxesEl) && boxesEl.ValueKind == JsonValueKind.Array)
            {
                foreach (var boxItem in boxesEl.EnumerateArray())
                {
                    if (boxItem.ValueKind == JsonValueKind.Object)
                    {
                        var x1 = boxItem.TryGetProperty("x1", out var x1El) && x1El.TryGetSingle(out var x1Val) ? x1Val : 0f;
                        var y1 = boxItem.TryGetProperty("y1", out var y1El) && y1El.TryGetSingle(out var y1Val) ? y1Val : 0f;
                        var x2 = boxItem.TryGetProperty("x2", out var x2El) && x2El.TryGetSingle(out var x2Val) ? x2Val : 0f;
                        var y2 = boxItem.TryGetProperty("y2", out var y2El) && y2El.TryGetSingle(out var y2Val) ? y2Val : 0f;
                        var score = boxItem.TryGetProperty("score", out var scEl) && scEl.TryGetSingle(out var scVal) ? scVal : 0f;
                        metadataDto.Boxes.Add(new BoundingBoxDto { X1 = x1, Y1 = y1, X2 = x2, Y2 = y2, Score = score });
                    }
                    else if (boxItem.ValueKind == JsonValueKind.Array && boxItem.GetArrayLength() >= 5)
                    {
                        var x1 = boxItem[0].TryGetSingle(out var x1Val) ? x1Val : 0f;
                        var y1 = boxItem[1].TryGetSingle(out var y1Val) ? y1Val : 0f;
                        var x2 = boxItem[2].TryGetSingle(out var x2Val) ? x2Val : 0f;
                        var y2 = boxItem[3].TryGetSingle(out var y2Val) ? y2Val : 0f;
                        var score = boxItem[4].TryGetSingle(out var scVal) ? scVal : 0f;
                        metadataDto.Boxes.Add(new BoundingBoxDto { X1 = x1, Y1 = y1, X2 = x2, Y2 = y2, Score = score });
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[PersonDetection] Lỗi giải mã JSON metadata: {json}", metadata);
            return BadRequest("Invalid metadata JSON format");
        }

        if (metadataDto == null)
        {
            return BadRequest("Metadata could not be parsed");
        }

        // 1. Phân tích IP camera và thời gian
        var camIp = metadataDto.Camera_Ip;
        var alertType = metadataDto.Alert_Type ?? "person_detected";
        _logger.LogInformation("[PersonDetection] Camera IP: {ip}, Loại sự kiện: {type}", camIp, alertType);

        // 2. Xử lý tải lên Video (Cấu trúc 2)
        if (alertType == "person_detection_video")
        {
            if (video == null || video.Length == 0)
            {
                _logger.LogWarning("[PersonDetection] Thiếu file video trong request.");
                return BadRequest("Missing video file");
            }

            // Lưu video tạm
            string videosDir = Path.Combine(_rootPath, "media", "videos");
            if (!Directory.Exists(videosDir)) Directory.CreateDirectory(videosDir);

            var tempFname = $"{Guid.NewGuid()}_temp_{Path.GetFileName(video.FileName)}";
            var tempPath = Path.Combine(videosDir, tempFname);

            using (var stream = new FileStream(tempPath, FileMode.Create))
            {
                await video.CopyToAsync(stream);
            }

            // Chuyển mã (Transcode) sang H.264 để trình duyệt có thể đọc được
            var fname = $"{Guid.NewGuid()}_h264.mp4";
            var fullPath = Path.Combine(videosDir, fname);
            
            var ffmpegExe = "ffmpeg";
            var localFfmpeg = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, OperatingSystem.IsWindows() ? "ffmpeg.exe" : "ffmpeg");
            if (System.IO.File.Exists(localFfmpeg))
            {
                ffmpegExe = localFfmpeg;
            }

            try 
            {
                var psi = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = ffmpegExe,
                    Arguments = $"-y -i \"{tempPath}\" -c:v libx264 -preset fast -crf 28 -c:a aac -b:a 128k \"{fullPath}\"",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                using var process = System.Diagnostics.Process.Start(psi);
                if (process != null)
                {
                    await process.WaitForExitAsync();
                }
                
                // Xóa file tạm
                if (System.IO.File.Exists(tempPath)) System.IO.File.Delete(tempPath);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[PersonDetection] Lỗi khi transcode video sang H.264. Bỏ qua transcode.");
                // Fallback: Nếu ffmpeg lỗi, dùng luôn file gốc
                if (System.IO.File.Exists(tempPath)) System.IO.File.Move(tempPath, fullPath);
            }

            var videoUrl = $"/media/videos/{fname}";
            _logger.LogInformation("[PersonDetection] Đã lưu và xử lý video thành công: {path}", fullPath);

            // Tạo ảnh Thumbnail từ video
            string detectionsDir = Path.Combine(_rootPath, "media", "detections");
            if (!Directory.Exists(detectionsDir)) Directory.CreateDirectory(detectionsDir);

            var thumbFname = $"{Guid.NewGuid()}_thumb.jpg";
            var thumbFullPath = Path.Combine(detectionsDir, thumbFname);
            var thumbUrl = $"/media/detections/{thumbFname}";
            bool thumbCreated = false;

            try
            {
                var psiThumb = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = ffmpegExe,
                    Arguments = $"-y -i \"{fullPath}\" -ss 00:00:00.5 -vframes 1 \"{thumbFullPath}\"",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                using var processThumb = System.Diagnostics.Process.Start(psiThumb);
                if (processThumb != null)
                {
                    await processThumb.WaitForExitAsync();
                    if (System.IO.File.Exists(thumbFullPath))
                    {
                        thumbCreated = true;
                        _logger.LogInformation("[PersonDetection] Đã tạo thumbnail từ video thành công: {path}", thumbFullPath);
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[PersonDetection] Lỗi khi tạo thumbnail từ video");
            }

            // Tìm camera
            var cam = await FindCameraAsync(camIp);
            if (cam != null)
            {
                // Tìm Alert "open" gần nhất của camera này để gắn video vào
                var latestAlert = await _db.Alerts
                    .Where(a => a.DeviceId == cam.Id && a.Status == "open" && a.Source == "ai_detection")
                    .OrderByDescending(a => a.TriggeredAt)
                    .FirstOrDefaultAsync();

                if (latestAlert != null)
                {
                    latestAlert.VideoUrl = videoUrl;
                    if (string.IsNullOrEmpty(latestAlert.ThumbnailUrl) && thumbCreated)
                    {
                        latestAlert.ThumbnailUrl = thumbUrl;
                        latestAlert.ImageUrl = thumbUrl;
                    }
                    await _db.SaveChangesAsync();

                    // Đánh tín hiệu để giao diện biết có Video và Thumbnail
                    await _notifier.SendAlertUpdatedAsync(new { 
                        id = latestAlert.Id, 
                        videoUrl,
                        thumbnailUrl = latestAlert.ThumbnailUrl,
                        imageUrl = latestAlert.ImageUrl
                    });
                    _logger.LogInformation("[PersonDetection] Đã ghim video và thumbnail vào Alert {alertId}", latestAlert.Id);
                }
                else
                {
                     _logger.LogWarning("[PersonDetection] Không tìm thấy Alert mở gần nhất để ghim video cho camera {ip}", camIp);
                }
            }
            return Ok(new { success = true, message = "Successfully saved event video" });
        }

        // 3. Xử lý báo động tức thì (Cấu trúc 1)
        if (alertType != "person_detected")
        {
            return BadRequest($"Unknown alert_type: {alertType}");
        }

        DateTime detectedAt = DateTime.UtcNow;
        if (DateTime.TryParseExact(metadataDto.Timestamp, "yyyy-MM-dd HH:mm:ss",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeLocal, out var dt))
        {
            detectedAt = dt.ToUniversalTime();
        }
        else if (DateTime.TryParse(metadataDto.Timestamp, out var dt2))
        {
            detectedAt = dt2.ToUniversalTime();
        }

        var device = await FindCameraAsync(camIp);
        var stationId = device?.StationId ?? await FirstStationIdAsync();

        if (stationId == Guid.Empty)
        {
            _logger.LogError("[PersonDetection] Hệ thống chưa có Station nào. Không thể lưu sự kiện.");
            return StatusCode(500, new { error = "Hệ thống chưa được cấu hình Station" });
        }

        if (device == null)
        {
            _logger.LogWarning("[PersonDetection] Không tìm thấy camera khớp với IP: {ip}. Tìm camera bất kỳ của trạm để gán tạm.", camIp);
            device = await _db.Devices.FirstOrDefaultAsync(d => d.StationId == stationId && d.Type.StartsWith("camera"));
        }

        if (device == null)
        {
            _logger.LogError("[PersonDetection] Không tìm thấy bất kỳ camera nào trong hệ thống để gán sự kiện.");
            return StatusCode(500, new { error = "Không tìm thấy camera hợp lệ để lưu sự kiện" });
        }

        // Đảm bảo thư mục lưu trữ tồn tại và lưu ảnh
        string mediaRootDir = Path.Combine(_rootPath, "media");
        string detDir = Path.Combine(mediaRootDir, "detections");
        if (!Directory.Exists(detDir))
        {
            Directory.CreateDirectory(detDir);
        }

        string? imageUrl = null;
        if (image != null && image.Length > 0)
        {
            var fname = $"{Guid.NewGuid()}_{Path.GetFileName(image.FileName)}";
            if (!Path.HasExtension(fname)) fname += ".jpg";
            var fullPath = Path.Combine(detDir, fname);

            using (var stream = new FileStream(fullPath, FileMode.Create))
            {
                await image.CopyToAsync(stream);
            }
            imageUrl = $"/media/detections/{fname}";
            _logger.LogInformation("[PersonDetection] Đã lưu ảnh thành công: {path}", fullPath);
        }
        else
        {
            _logger.LogWarning("[PersonDetection] Request không chứa file ảnh hợp lệ");
        }

        // Tạo cảnh báo (Alert)
        var message = $"🚨 Phát hiện {metadataDto.Person_Count} người xâm nhập tại khu vực camera {(device?.Name ?? camIp)}!";
        var alert = new Alert
        {
            StationId = stationId,
            DeviceId = device?.Id,
            Source = "ai_detection",
            Level = "alarm", // Intrusion is alarm
            Status = "open",
            Message = message,
            Value = metadataDto.Person_Count,
            TriggeredAt = detectedAt,
            ImageUrl = imageUrl,
            ThumbnailUrl = imageUrl
        };
        _db.Alerts.Add(alert);

        // Lưu Alert History
        _db.AlertHistories.Add(new AlertHistory
        {
            AlertId = alert.Id,
            Status = "triggered",
            Note = alert.Message,
            ChangedAt = DateTime.UtcNow
        });

        // Tạo DetectionEvent
        var confidence = metadataDto.Boxes.Count > 0 ? metadataDto.Boxes.Max(b => b.Score) : 0f;
        var evt = new DetectionEvent
        {
            CameraId = device?.Id ?? Guid.Empty,
            StationId = stationId,
            Source = "yolo",
            DetectionType = "intrusion", // "intrusion" maps nicely on frontend
            Label = "person",
            Confidence = confidence,
            Severity = "alarm",
            Message = message,
            DetectedAt = detectedAt,
            BoundingBoxes = JsonSerializer.Serialize(metadataDto.Boxes),
            Metadata = metadata
        };
        _db.DetectionEvents.Add(evt);

        // Lưu thay đổi vào Database
        await _db.SaveChangesAsync();

        // Gán ngược AlertId cho DetectionEvent
        evt.AlertId = alert.Id;
        await _db.SaveChangesAsync();

        _logger.LogInformation("[PersonDetection] Đã lưu sự kiện thành công vào DB (AlertId: {alertId})", alert.Id);

        // Gửi tín hiệu Realtime qua SignalR
        try
        {
            var pushPayload = new
            {
                id = evt.Id,
                cameraId = evt.CameraId,
                cameraName = device?.Name ?? camIp,
                detectionType = "intrusion",
                detectedAt = evt.DetectedAt,
                snapshotUrl = imageUrl,
                alertLevel = "alarm",
                alertId = alert.Id,
            };
            await _notifier.SendCameraEventAsync(pushPayload);

            await _notifier.SendAlertAsync(new
            {
                id = alert.Id,
                level = alert.Level,
                status = alert.Status,
                message = alert.Message,
                source = alert.Source,
                triggeredAt = alert.TriggeredAt,
                deviceId = alert.DeviceId,
                thumbnailUrl = alert.ThumbnailUrl,
                imageUrl = alert.ImageUrl,
                videoUrl = alert.VideoUrl
            });
            _logger.LogInformation("[PersonDetection] Đã gửi thông báo realtime qua SignalR");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[PersonDetection] Lỗi khi gửi thông báo SignalR");
        }

        return Ok(new { success = true, alertId = alert.Id, message = "Successfully processed person detection event" });
    }

    private async Task<Device?> FindCameraAsync(string ip)
    {
        if (string.IsNullOrWhiteSpace(ip)) return null;
        var cams = await _db.Devices
            .Where(d => d.Type.StartsWith("camera") && d.Config != null)
            .ToListAsync();

        var matched = cams.Where(d =>
        {
            try
            {
                var cfg = JsonDocument.Parse(d.Config!).RootElement;
                return cfg.TryGetProperty("ip", out var el) && el.GetString() == ip;
            }
            catch { return false; }
        }).ToList();

        return matched.FirstOrDefault();
    }

    private async Task<Guid> FirstStationIdAsync()
    {
        var s = await _db.Stations.FirstOrDefaultAsync();
        return s?.Id ?? Guid.Empty;
    }
}

public class PersonDetectionMetadataDto
{
    public string Timestamp { get; set; } = string.Empty;
    public string Camera_Ip { get; set; } = string.Empty;
    public int Person_Count { get; set; }
    public string Alert_Type { get; set; } = "person_detected";
    public List<BoundingBoxDto> Boxes { get; set; } = new();
}

public class BoundingBoxDto
{
    public float X1 { get; set; }
    public float Y1 { get; set; }
    public float X2 { get; set; }
    public float Y2 { get; set; }
    public float Score { get; set; }
}
