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
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[CentralSync] Lỗi push batch");
            }

            await Task.Delay(IntervalMs, stoppingToken);
        }
    }

    private async Task PushBatchAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var pending = await db.SyncQueues
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
                "Alert"          => "alerts",
                "SensorReading"  => "sensors",
                "DetectionEvent" => "events",
                _                => null
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
}
