// ============================================================
// AnalyticsController — API phân tích xu hướng + sức khỏe
// GET /api/v1/analytics/health  — Điểm sức khỏe thiết bị
// GET /api/v1/analytics/trend   — Slope xu hướng 7 ngày
// ============================================================

using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using StationOS.Data;
using StationOS.Workers.Polling;

namespace StationOS.Api.Controllers;

[ApiController]
[Route("api/v1/analytics")]
[Authorize]
public class AnalyticsController : ControllerBase
{
    private readonly AppDbContext       _db;
    private readonly HealthScoreWorker  _healthWorker;

    public AnalyticsController(AppDbContext db, HealthScoreWorker healthWorker)
    {
        _db           = db;
        _healthWorker = healthWorker;
    }

    /// <summary>
    /// Lấy điểm sức khỏe (health score) và mức rủi ro của từng thiết bị.
    /// Dữ liệu được tính toán bởi HealthScoreWorker và lưu trong SystemSettings.
    /// Query: ?stationId= để lọc theo trạm.
    /// </summary>
    // ── GET /api/v1/analytics/health?stationId= ──────────────
    [HttpGet("health")]
    public async Task<IActionResult> GetHealth([FromQuery] Guid? stationId)
    {
        var devicesQ = _db.Devices.AsQueryable();
        if (stationId.HasValue) devicesQ = devicesQ.Where(d => d.StationId == stationId);
        var devices = await devicesQ.ToListAsync();

        var result = new List<object>();
        foreach (var d in devices)
        {
            var key     = $"health_{d.Id}";
            var setting = await _db.SystemSettings
                .FirstOrDefaultAsync(s => s.StationId == d.StationId && s.Key == key);

            int    score        = 100;
            string risk         = "good";
            int    alarmCount   = 0;
            int    warningCount = 0;
            DateTime? ts        = null;

            if (setting is not null)
            {
                try
                {
                    var obj = JsonSerializer.Deserialize<JsonElement>(setting.Value);
                    if (obj.TryGetProperty("score",        out var s2)) score        = s2.GetInt32();
                    if (obj.TryGetProperty("risk",         out var r2)) risk         = r2.GetString() ?? "good";
                    if (obj.TryGetProperty("alarmCount",   out var a2)) alarmCount   = a2.GetInt32();
                    if (obj.TryGetProperty("warningCount", out var w2)) warningCount = w2.GetInt32();
                    if (obj.TryGetProperty("ts",           out var t2) &&
                        t2.TryGetDateTime(out var dt)) ts = dt;
                }
                catch { /* keep defaults */ }
            }

            result.Add(new
            {
                deviceId     = d.Id,
                deviceName   = d.Name,
                deviceType   = d.Type,
                status       = d.Status,
                score,
                risk,
                alarmCount,
                warningCount,
                ts,
            });
        }

        return Ok(result);
    }

    /// <summary>
    /// Tính xu hướng (slope) của từng điểm đo trong N ngày gần đây.
    /// Trả về: slopePerDay, trend (rising/falling/stable), latestValue, unit.
    /// Query: ?stationId=&days=7 (tối đa 30 ngày).
    /// </summary>
    // ── GET /api/v1/analytics/trend?stationId=&days=7 ────────
    [HttpGet("trend")]
    public async Task<IActionResult> GetTrend(
        [FromQuery] Guid? stationId,
        [FromQuery] int   days = 7)
    {
        days = Math.Clamp(days, 1, 30);
        var since = DateTime.UtcNow.AddDays(-days);

        var query = _db.SensorReadings.Where(r => r.Time >= since);
        if (stationId.HasValue) query = query.Where(r => r.StationId == stationId);

        var readings = await query
            .OrderBy(r => r.DeviceId).ThenBy(r => r.PointId).ThenBy(r => r.Time)
            .Select(r => new { r.DeviceId, r.PointId, r.Time, r.Value, r.StationId })
            .ToListAsync();

        var labelMap = new Dictionary<string, string>
        {
            ["nhiet_do_pha_1"] = "Nhiệt độ Pha 1",
            ["nhiet_do_pha_2"] = "Nhiệt độ Pha 2",
            ["nhiet_do_pha_3"] = "Nhiệt độ Pha 3",
            ["phong_dien"]     = "Phóng điện (PD)",
            ["nhiet_do_pha_2_1"] = "Nhiệt độ Pha 1 (Bộ 2)",
            ["nhiet_do_pha_2_2"] = "Nhiệt độ Pha 2 (Bộ 2)",
            ["nhiet_do_pha_2_3"] = "Nhiệt độ Pha 3 (Bộ 2)",
            ["phong_dien_2"]     = "Phóng điện (PD 2)",
        };

        var result = new List<object>();
        var groups = readings
            .Where(r => r.Value.HasValue)
            .GroupBy(r => new { r.DeviceId, r.PointId });

        foreach (var g in groups)
        {
            var items = g.ToList();
            if (items.Count < 5) continue;

            var t0   = items[0].Time;
            var xs   = items.Select(x => (x.Time - t0).TotalHours).ToArray();
            var ys   = items.Select(x => x.Value!.Value).ToArray();
            var slopePerhour = LinearSlope(xs, ys);
            var slopePerDay  = Math.Round(slopePerhour * 24, 4);

            var pointIdLower = g.Key.PointId.ToLower();
            var isTemp = pointIdLower.Contains("nhiet") || pointIdLower.Contains("temp") || pointIdLower.StartsWith("p");
            var trend  = slopePerDay > (isTemp ? 0.5 : 0.3) ? "rising" :
                         slopePerDay < -(isTemp ? 0.3 : 0.2) ? "falling" : "stable";

            string label = g.Key.PointId;
            if (labelMap.ContainsKey(g.Key.PointId))
            {
                label = labelMap[g.Key.PointId];
            }
            else
            {
                var formatted = label.Replace("nhiet_do_", "Nhiệt độ ").Replace("_", " ");
                label = System.Text.RegularExpressions.Regex.Replace(formatted, @"\b[a-z]", m => m.Value.ToUpper());
            }

            var unit = isTemp ? "°C" : (pointIdLower.Contains("pd") || pointIdLower.Contains("dien") ? "dB" : "");

            result.Add(new
            {
                deviceId    = g.Key.DeviceId,
                pointId     = g.Key.PointId,
                label,
                slopePerDay,
                trend,
                sampleCount = items.Count,
                latestValue = Math.Round(ys.Last(), 2),
                unit,
            });
        }

        return Ok(result);
    }

    /// <summary>
    /// Xóa toàn bộ zone states và health score cũ, sau đó tính lại ngay lập tức trong background.
    /// Chỉ admin và manager. Query: ?deviceId= để giới hạn cho 1 thiết bị.
    /// </summary>
    // ── POST /api/v1/analytics/health/recalculate ────────────
    // Xóa zone states cũ + tính lại điểm sức khỏe ngay lập tức
    [HttpPost("health/recalculate")]
    [Authorize(Roles = "admin,manager")]
    public async Task<IActionResult> Recalculate([FromQuery] Guid? deviceId)
    {
        // Xóa zone states (bắt đầu lại từ 0 ngày trong vùng)
        var zoneQuery = _db.SystemSettings.Where(s => s.Key.StartsWith("zonest_"));
        if (deviceId.HasValue)
            zoneQuery = zoneQuery.Where(s => s.Key.Contains(deviceId.Value.ToString()));
        var zoneStates = await zoneQuery.ToListAsync();
        _db.SystemSettings.RemoveRange(zoneStates);

        // Xóa health score cũ (để UI không hiển thị số cũ trong khi đang tính)
        var healthQuery = _db.SystemSettings.Where(s => s.Key.StartsWith("health_"));
        if (deviceId.HasValue)
            healthQuery = healthQuery.Where(s => s.Key == $"health_{deviceId.Value}");
        var healthSettings = await healthQuery.ToListAsync();
        _db.SystemSettings.RemoveRange(healthSettings);

        await _db.SaveChangesAsync();

        // Tính lại ngay (chạy trong background để không block HTTP response)
        _ = Task.Run(() => _healthWorker.RecalculateNowAsync());

        return Ok(new
        {
            message        = "Đang tính lại điểm sức khỏe...",
            clearedZones   = zoneStates.Count,
            clearedScores  = healthSettings.Count,
        });
    }

    private static double LinearSlope(double[] xs, double[] ys)
    {
        int n = xs.Length;
        double sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        for (int i = 0; i < n; i++)
        {
            sumX  += xs[i]; sumY  += ys[i];
            sumXY += xs[i] * ys[i];
            sumX2 += xs[i] * xs[i];
        }
        var denom = n * sumX2 - sumX * sumX;
        return denom == 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
    }
}
