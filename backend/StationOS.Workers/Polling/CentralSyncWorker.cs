// ============================================================
// CentralSyncWorker — Đẩy dữ liệu từ trạm con lên trạm tổng
// Chỉ chạy khi env CentralServer được cấu hình.
// Đọc SyncQueue pending → POST lên /api/v1/ingest/* của trạm tổng.
// ============================================================

using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StationOS.Data;
using StationOS.Data.Entities;

namespace StationOS.Workers.Polling;

public class CentralSyncWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<CentralSyncWorker> _logger;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly string? _centralUrl;
    private readonly string? _stationId;
    private const int IntervalMs = 30_000; // 30 giây
    private const int BatchSize = 50;

    public CentralSyncWorker(
        IServiceScopeFactory scopeFactory,
        ILogger<CentralSyncWorker> logger,
        IHttpClientFactory httpClientFactory,
        IConfiguration configuration)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
        _httpClientFactory = httpClientFactory;
        _centralUrl = configuration["CentralServer"]?.TrimEnd('/');
        _stationId  = configuration["StationId"];
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (string.IsNullOrEmpty(_centralUrl))
        {
            _logger.LogInformation("[CentralSync] CentralServer chưa cấu hình — worker không chạy");
            return;
        }

        if (string.IsNullOrEmpty(_stationId))
        {
            _logger.LogWarning("[CentralSync] StationId chưa cấu hình — không thể xác thực với trạm tổng");
            return;
        }

        _logger.LogInformation("[CentralSync] Khởi động, trạm tổng: {Url}", _centralUrl);

        // Delay 60s sau startup để tránh race với migration và startup các service khác
        await Task.Delay(60_000, stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await PushBatchAsync(stoppingToken);
                await PushDevicesAsync(stoppingToken);
                await PullTasksAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[CentralSync] Lỗi sync");
            }

            await Task.Delay(IntervalMs, stoppingToken);
        }
    }

    private async Task PushBatchAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        // Ưu tiên Reports/AuditLog/MaintenanceTask/LoginLog trước, sensor readings sau
        var priorityTypes = new[] { "Report", "AuditLog", "MaintenanceTask", "LoginLog" };
        var highPriority = await db.SyncQueues
            .Where(q => q.Status == "pending" && q.RetryCount < 3 && priorityTypes.Contains(q.EntityType))
            .OrderBy(q => q.CreatedAt)
            .Take(BatchSize)
            .ToListAsync(ct);

        var pending = highPriority.Count > 0
            ? highPriority
            : await db.SyncQueues
                .Where(q => q.Status == "pending" && q.RetryCount < 3)
                .OrderBy(q => q.CreatedAt)
                .Take(BatchSize)
                .ToListAsync(ct);

        if (pending.Count == 0) return;

        _logger.LogInformation("[CentralSync] Push {Count} items lên trạm tổng", pending.Count);

        var client = _httpClientFactory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Station-Id", _stationId);
        client.Timeout = TimeSpan.FromSeconds(15);

        // Nhóm theo EntityType để gọi batch
        var groups = pending.GroupBy(q => q.EntityType);
        int successTotal = 0;

        foreach (var group in groups)
        {
            var endpoint = group.Key switch
            {
                "Alert"           => "alerts",
                "SensorReading"   => "sensors",
                "DetectionEvent"  => "events",
                "Report"          => "reports",
                "AuditLog"        => "audit-logs",
                "LoginLog"        => "login-logs",
                "MaintenanceTask" => "maintenance",
                _                 => null
            };

            if (endpoint == null)
            {
                // Entity type không hỗ trợ ingest → đánh dấu skip
                foreach (var item in group) { item.Status = "sent"; item.SentAt = DateTime.UtcNow; }
                successTotal += group.Count();
                continue;
            }

            var payloads = group
                .Select(q => JsonSerializer.Deserialize<object>(q.Payload))
                .Where(p => p != null)
                .ToList();

            try
            {
                var url = $"{_centralUrl}/api/v1/ingest/{endpoint}";
                var response = await client.PostAsJsonAsync(url, payloads, ct);

                if (response.IsSuccessStatusCode)
                {
                    foreach (var item in group) { item.Status = "sent"; item.SentAt = DateTime.UtcNow; }
                    successTotal += group.Count();
                    _logger.LogDebug("[CentralSync] {Type}: push {Count} items OK", group.Key, group.Count());
                }
                else
                {
                    var body = await response.Content.ReadAsStringAsync(ct);
                    _logger.LogWarning("[CentralSync] {Type}: HTTP {Status} — {Body}", group.Key, response.StatusCode, body);
                    foreach (var item in group) { item.RetryCount++; if (item.RetryCount >= 3) item.Status = "failed"; }
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[CentralSync] {Type}: lỗi kết nối trạm tổng", group.Key);
                foreach (var item in group) { item.RetryCount++; if (item.RetryCount >= 3) item.Status = "failed"; }
            }
        }

        await db.SaveChangesAsync(ct);
        _logger.LogInformation("[CentralSync] Hoàn thành: {Success}/{Total} items", successTotal, pending.Count);
    }

    /// <summary>Đẩy danh sách thiết bị của trạm con lên trạm tổng để hiển thị trong form giao việc.</summary>
    private async Task PushDevicesAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var devices = await db.Devices
            .AsNoTracking()
            .Select(d => new { id = d.Id.ToString(), name = d.Name, type = d.Type, status = d.Status })
            .ToListAsync(ct);

        if (devices.Count == 0) return;

        var client = _httpClientFactory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Station-Id", _stationId);
        client.Timeout = TimeSpan.FromSeconds(15);

        try
        {
            var url = $"{_centralUrl}/api/v1/ingest/devices";
            var resp = await client.PostAsJsonAsync(url, devices, ct);
            if (!resp.IsSuccessStatusCode)
                _logger.LogWarning("[CentralSync] PushDevices HTTP {Status}", resp.StatusCode);
            else
                _logger.LogInformation("[CentralSync] Đã push {Count} thiết bị lên trạm tổng", devices.Count);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[CentralSync] Lỗi push devices lên trạm tổng");
        }
    }

    /// <summary>Pull task bảo trì từ trạm tổng về trạm con (chiều trên xuống).</summary>
    private async Task PullTasksAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var client = _httpClientFactory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Station-Id", _stationId);
        client.Timeout = TimeSpan.FromSeconds(15);

        try
        {
            var url = $"{_centralUrl}/api/v1/ingest/tasks";
            var response = await client.GetAsync(url, ct);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("[CentralSync] Pull tasks HTTP {Status}", response.StatusCode);
                return;
            }

            var items = await response.Content.ReadFromJsonAsync<List<JsonElement>>(cancellationToken: ct);
            if (items == null || items.Count == 0) return;

            int created = 0;
            foreach (var elem in items)
            {
                if (!elem.TryGetProperty("Id", out var idEl) && !elem.TryGetProperty("id", out idEl)) continue;
                if (idEl.ValueKind != JsonValueKind.String || !idEl.TryGetGuid(out var id)) continue;

                // Bỏ qua nếu đã tồn tại
                if (await db.MaintenanceTasks.AnyAsync(t => t.Id == id, ct)) continue;

                static string? Str(JsonElement e, string name)
                {
                    if (e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String) return v.GetString();
                    var p = char.ToUpper(name[0]) + name[1..];
                    if (e.TryGetProperty(p, out var v2) && v2.ValueKind == JsonValueKind.String) return v2.GetString();
                    return null;
                }
                static bool TryDate(JsonElement e, string name, out DateTime result)
                {
                    if (e.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null && v.TryGetDateTime(out result)) return true;
                    var p = char.ToUpper(name[0]) + name[1..];
                    if (e.TryGetProperty(p, out var v2) && v2.ValueKind != JsonValueKind.Null && v2.TryGetDateTime(out result)) return true;
                    result = default; return false;
                }

                var task = new StationOS.Data.Entities.MaintenanceTask
                {
                    Id         = id,
                    Title      = Str(elem, "title")  ?? "(không có tiêu đề)",
                    Type       = Str(elem, "type")   ?? "inspection",
                    Status     = Str(elem, "status") ?? "pending",
                    AssignedTo = Str(elem, "assignedTo"),
                    Notes      = Str(elem, "notes"),
                };

                // StationId: lấy từ response hoặc dùng StationId của trạm con hiện tại
                if (elem.TryGetProperty("StationId", out var siEl) || elem.TryGetProperty("stationId", out siEl))
                    if (siEl.ValueKind == JsonValueKind.String && siEl.TryGetGuid(out var sId))
                        task.StationId = sId;
                else if (Guid.TryParse(_stationId, out var selfId))
                    task.StationId = selfId;

                if (TryDate(elem, "scheduledDate", out var sd)) task.ScheduledDate = sd;
                if (TryDate(elem, "createdAt",     out var ca)) task.CreatedAt     = ca;

                db.MaintenanceTasks.Add(task);
                created++;
            }

            if (created > 0)
            {
                await db.SaveChangesAsync(ct);
                _logger.LogInformation("[CentralSync] Pull được {Count} task bảo trì từ trạm tổng", created);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[CentralSync] Lỗi pull tasks từ trạm tổng");
        }
    }
}
