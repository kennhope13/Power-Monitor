// ============================================================
// StorageController — Quản lý lưu trữ video/ảnh bằng chứng
// Routes:
//   GET  /api/v1/storage/info    — Thông tin ổ đĩa + số file media
//   POST /api/v1/storage/cleanup — Xóa file cũ hơn video_retention_days ngày
// ============================================================

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using StationOS.Data;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1/storage")]
[Authorize(Roles = "admin")]
public class StorageController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IWebHostEnvironment _env;
    private readonly ILogger<StorageController> _logger;

    public StorageController(AppDbContext db, IWebHostEnvironment env, ILogger<StorageController> logger)
    {
        _db = db;
        _env = env;
        _logger = logger;
    }

    /// <summary>Trả về thông tin ổ đĩa và số lượng file media hiện tại.</summary>
    [HttpGet("info")]
    public IActionResult GetInfo()
    {
        var rootPath = _env.WebRootPath ?? Path.Combine(_env.ContentRootPath, "wwwroot");
        var mediaPath = Path.Combine(rootPath, "media");

        var drives = DriveInfo.GetDrives()
            .Where(d => d.IsReady && d.DriveType == DriveType.Fixed && !d.Name.StartsWith("/snap", StringComparison.OrdinalIgnoreCase))
            .Select(d => new {
                drive = d.Name,
                totalGb = Math.Round(d.TotalSize / 1_073_741_824.0, 1),
                freeGb = Math.Round(d.AvailableFreeSpace / 1_073_741_824.0, 1),
                freePercent = Math.Round(d.TotalSize > 0 ? (double)d.AvailableFreeSpace / d.TotalSize * 100 : 100, 1),
            }).ToList();

        long mediaBytes = 0;
        int fileCount = 0;
        if (Directory.Exists(mediaPath))
        {
            var files = Directory.GetFiles(mediaPath, "*.*", SearchOption.AllDirectories);
            fileCount = files.Length;
            mediaBytes = files.Sum(f => new FileInfo(f).Length);
        }

        return Ok(new {
            drives,
            mediaFiles = fileCount,
            mediaSizeMb = Math.Round(mediaBytes / 1_048_576.0, 1),
        });
    }

    /// <summary>
    /// Xóa file media (ảnh + video) cũ hơn video_retention_days ngày.
    /// Mặc định 30 ngày nếu chưa cấu hình.
    /// Ưu tiên xóa file cũ nhất trước (FIFO).
    /// </summary>
    [HttpPost("cleanup")]
    public async Task<IActionResult> Cleanup()
    {
        var station = await _db.Stations.FirstOrDefaultAsync();
        int retentionDays = 30;

        if (station != null)
        {
            var setting = await _db.SystemSettings
                .FirstOrDefaultAsync(s => s.StationId == station.Id && s.Key == "video_retention_days");
            if (setting != null && int.TryParse(setting.Value.Trim('"'), out var parsed))
                retentionDays = parsed;
        }

        var rootPath = _env.WebRootPath ?? Path.Combine(_env.ContentRootPath, "wwwroot");
        var mediaPath = Path.Combine(rootPath, "media");

        int deletedFiles = 0;
        long freedBytes = 0;
        var cutoff = DateTime.UtcNow.AddDays(-retentionDays);

        if (Directory.Exists(mediaPath))
        {
            // Sắp xếp file cũ nhất trước (FIFO)
            var oldFiles = Directory.GetFiles(mediaPath, "*.*", SearchOption.AllDirectories)
                .Select(f => new FileInfo(f))
                .Where(f => f.CreationTimeUtc < cutoff)
                .OrderBy(f => f.CreationTimeUtc)
                .ToList();

            foreach (var file in oldFiles)
            {
                try
                {
                    var sizeBytes = file.Length;
                    file.Delete();
                    deletedFiles++;
                    freedBytes += sizeBytes;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning("[StorageCleanup] Không xóa được {File}: {Err}", file.FullName, ex.Message);
                }
            }

            // Xóa thư mục con rỗng
            foreach (var dir in Directory.GetDirectories(mediaPath, "*", SearchOption.AllDirectories).OrderByDescending(d => d.Length))
            {
                try
                {
                    if (Directory.Exists(dir) && !Directory.EnumerateFileSystemEntries(dir).Any())
                        Directory.Delete(dir);
                }
                catch { }
            }
        }

        // Đồng bộ DB: xóa record MediaFile cũ hơn cutoff
        if (station != null)
        {
            var oldRecords = await _db.MediaFiles
                .Where(m => m.CreatedAt < cutoff)
                .ToListAsync();
            _db.MediaFiles.RemoveRange(oldRecords);
            await _db.SaveChangesAsync();
        }

        _logger.LogInformation("[StorageCleanup] Đã xóa {Count} file, giải phóng {Mb:F1} MB (retention={Days} ngày)",
            deletedFiles, freedBytes / 1_048_576.0, retentionDays);

        return Ok(new {
            deletedFiles,
            freedMb = Math.Round(freedBytes / 1_048_576.0, 1),
            retentionDays,
        });
    }
}
