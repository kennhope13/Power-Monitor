// ============================================================
// RuleEvaluationWorker — Đánh giá Rules sau mỗi PLC poll
// Chạy nền, kiểm tra mỗi 5 giây
//
// Condition JSONB format (extended):
//   {
//     "point": "nhiet_do_pha_1",
//     "op": ">",
//     "value": 80,
//     "clearValue": 77,        // optional: ngưỡng tắt alert (hysteresis), default = value - 3
//     "cooldownMin": 5,        // optional: phút không tạo alert mới sau khi close, default = 5
//     "confirmReadings": 3     // optional: số lần liên tiếp vượt ngưỡng trước khi trigger, default = 1
//   }
//
// Actions JSONB format:
//   [{ "type": "alert",       "level": "warning" }]
//   [{ "type": "alert",       "level": "alarm"   }]
//   [{ "type": "health",      "penalty": 15      }]
//   [{ "type": "maintenance", "taskType": "repair", "scheduledInDays": 45 }]
// ============================================================

using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StationOS.Data;
using StationOS.Data.Entities;
using StationOS.Services.Camera;
using StationOS.Services;

namespace StationOS.Workers.Polling;

public class RuleEvaluationWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IRealtimeNotifier _notifier;
    private readonly ILogger<RuleEvaluationWorker> _logger;

    private const int CheckIntervalMs = 5000; // 5 giây / lần check

    // In-memory state: confirmCount và cooldownUntil per stateKey (ruleId + deviceId)
    private readonly Dictionary<string, int>      _confirmCounts  = new();
    private readonly Dictionary<string, DateTime> _cooldownUntil  = new();

    // Global confirm threshold từ Settings (camera_filter_time_s / 5s)
    private int _globalConfirmReadings = 2; // mặc định ~10 giây

    public RuleEvaluationWorker(
        IServiceScopeFactory scopeFactory,
        IRealtimeNotifier notifier,
        ILogger<RuleEvaluationWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _notifier = notifier;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[Rules] Worker khởi động");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await EvaluateAllRulesAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[Rules] Lỗi đánh giá rules");
            }

            await Task.Delay(CheckIntervalMs, stoppingToken);
        }
    }

    /// <summary>Duyệt tất cả rule enabled, đọc latest readings từ cache và đánh giá từng rule.</summary>
    private async Task EvaluateAllRulesAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        // Đọc setting camera_filter_time_s để tính confirmReadings mặc định
        var filterSetting = await db.SystemSettings
            .FirstOrDefaultAsync(s => s.Key == "camera_filter_time_s", ct);
        if (filterSetting?.Value != null && int.TryParse(filterSetting.Value.Trim('"'), out var secs) && secs > 0)
            _globalConfirmReadings = Math.Max(1, (int)Math.Round(secs / (CheckIntervalMs / 1000.0)));

        var rules = await db.Rules.Where(r => r.Enabled).ToListAsync(ct);
        
        // ── BỔ SUNG: Đọc cả các Vùng PD (Boundaries) để đánh giá như Rules ──
        var pdBoundaries = await db.Boundaries
            .Include(b => b.Device)
            .Where(b => b.Type == "pd" && b.Enabled)
            .ToListAsync(ct);

        if (rules.Count == 0 && pdBoundaries.Count == 0) return;

        var cache = scope.ServiceProvider.GetRequiredService<Microsoft.Extensions.Caching.Memory.IMemoryCache>();
        Dictionary<string, SensorReading>? latestReadings;
        if (!Microsoft.Extensions.Caching.Memory.CacheExtensions.TryGetValue<Dictionary<string, SensorReading>>(
                cache, "LatestReadings", out latestReadings) || latestReadings == null)
        {
            latestReadings = new Dictionary<string, SensorReading>();
        }

        // 1. Đánh giá Rules chuẩn
        foreach (var rule in rules)
        {
            await EvaluateRuleAsync(scope.ServiceProvider, db, rule, latestReadings, ct);
        }

        // 2. Đánh giá các Vùng PD
        foreach (var b in pdBoundaries)
        {
            await EvaluatePdBoundaryAsync(scope.ServiceProvider, db, b, latestReadings, ct);
        }
    }

    private async Task EvaluatePdBoundaryAsync(
        IServiceProvider services,
        AppDbContext db,
        Boundary b,
        Dictionary<string, SensorReading> latestReadings,
        CancellationToken ct)
    {
        try 
        {
            // 1. Kiểm tra Hotspot AI trong cache (điều kiện VÀ)
            var cache = services.GetRequiredService<Microsoft.Extensions.Caching.Memory.IMemoryCache>();
            bool hasHotspot = cache.TryGetValue($"hotspot_{b.DeviceId}_{b.Name}", out _) || 
                              cache.TryGetValue($"hotspot_{b.DeviceId}_pd", out _);
            
            if (!hasHotspot) return;

            // 2. Kiểm tra chỉ số dB
            if (!latestReadings.TryGetValue(b.Name, out var reading) && 
                !latestReadings.TryGetValue(b.Id.ToString(), out reading) &&
                !latestReadings.TryGetValue("pd", out reading)) return;
            
            if (reading.Value == null) return;
            var currentValue = reading.Value.Value;

            // 3. Parse ngưỡng
            var t = JsonSerializer.Deserialize<JsonElement>(b.ThresholdsJson ?? "{}");
            double warnLimit = t.TryGetProperty("warn", out var w) ? w.GetDouble() : 20;
            double alarmLimit = t.TryGetProperty("alarm", out var al) ? al.GetDouble() : 35;
            string fullName = t.TryGetProperty("fullName", out var fn) ? fn.GetString() ?? b.Name : b.Name;

            bool alarmTriggered = currentValue >= alarmLimit;
            bool warningTriggered = currentValue >= warnLimit && !alarmTriggered;
            bool triggered = alarmTriggered || warningTriggered;
            
            if (!triggered) return; // Nếu âm thanh chưa vượt ngưỡng thì cũng chưa báo

            string level = alarmTriggered ? "alarm" : "warning";
            
            // Giả lập Rule object
            var virtualRule = new Rule
            {
                Id = b.Id,
                Name = $"PD: {fullName}",
                StationId = b.Device?.StationId ?? Guid.Empty,
                DeviceId = b.DeviceId,
                Actions = $"[{{\"type\":\"alert\",\"level\":\"{level}\"}}]"
            };

            await HandleAlertActionAsync(services, db, virtualRule, reading, b.Name, ">=", 
                                         alarmTriggered ? alarmLimit : warnLimit, 
                                         (alarmTriggered ? alarmLimit : warnLimit) - 2, 
                                         5, 1, currentValue, 
                                         true, level, ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[PD Rules] Lỗi đánh giá vùng {name}", b.Name);
        }
    }

    /// <summary>Đánh giá 1 rule: kiểm tra điều kiện, dual threshold, xử lý alert + maintenance.</summary>
    private async Task EvaluateRuleAsync(
        IServiceProvider services,
        AppDbContext db,
        Rule rule,
        Dictionary<string, SensorReading> latestReadings,
        CancellationToken ct)
    {
        var hasAlert = RuleEvaluator.HasAlertAction(rule.Actions);
        var hasMaint = RuleEvaluator.HasMaintenanceAction(rule.Actions);
        // Rule chỉ có health action → HealthScoreWorker xử lý, không cần xử lý ở đây
        if (!hasAlert && !hasMaint) return;

        var condition = RuleEvaluator.ParseConditionExtended(rule.Condition);
        if (condition == null) return;

        var (pointId, op, threshold, warningValue, clearValue, cooldownMin, confirmReadingsFromRule) = condition.Value;
        // Nếu rule không tự set confirmReadings (=1 mặc định từ ParseConditionExtended),
        // dùng giá trị global từ setting camera_filter_time_s
        var confirmReadings = confirmReadingsFromRule > 1 ? confirmReadingsFromRule : _globalConfirmReadings;

        // Tìm tất cả các readings tương ứng với pointId này
        var targetReadings = new List<SensorReading>();
        if (rule.DeviceId.HasValue && rule.DeviceId.Value != Guid.Empty)
        {
            var key = $"{rule.DeviceId.Value}_{pointId}".ToLower();
            if (latestReadings.TryGetValue(key, out var r))
            {
                targetReadings.Add(r);
            }
            else if ((latestReadings.TryGetValue(pointId, out r) || latestReadings.TryGetValue(pointId.ToLower(), out r)) && 
                     (r.DeviceId == rule.DeviceId.Value || r.DeviceId == Guid.Empty))
            {
                targetReadings.Add(r);
            }
        }
        else
        {
            // Rule toàn cục: quét tất cả readings có PointId trùng khớp
            var suffix = $"_{pointId}".ToLower();
            foreach (var kvp in latestReadings)
            {
                if (kvp.Key.Equals(pointId, StringComparison.OrdinalIgnoreCase) || kvp.Key.EndsWith(suffix))
                {
                    targetReadings.Add(kvp.Value);
                }
            }
        }

        foreach (var reading in targetReadings)
        {
            if (reading.Value == null) continue;

            var currentValue = reading.Value.Value;

            // Dual threshold: alarm > pre_alarm. Xác định level thực tế bị vượt.
            bool alarmTriggered   = RuleEvaluator.Evaluate(currentValue, op, threshold);
            bool warningTriggered = warningValue.HasValue &&
                                    RuleEvaluator.Evaluate(currentValue, op, warningValue.Value) &&
                                    !alarmTriggered;

            string? levelOverride = alarmTriggered ? "alarm" : (warningTriggered ? "warning" : null);
            double  activeThreshold = (warningTriggered && warningValue.HasValue) ? warningValue.Value : threshold;
            bool    triggered       = alarmTriggered || warningTriggered;

            if (hasAlert)
                await HandleAlertActionAsync(services, db, rule, reading, pointId, op, activeThreshold, clearValue,
                                             cooldownMin, confirmReadings, currentValue, triggered, levelOverride, ct);

            if (hasMaint && triggered)
                await HandleMaintenanceActionAsync(db, rule, pointId, currentValue, reading, ct);
        }
    }

    // ── Xử lý action type=alert ────────────────────────────────────────────
    private async Task HandleAlertActionAsync(
        IServiceProvider services, AppDbContext db, Rule rule, SensorReading reading,
        string pointId, string op, double threshold, double clearValue,
        int cooldownMin, int confirmReadings,
        double currentValue, bool triggered, string? levelOverride, CancellationToken ct)
    {
        var deviceId = reading.DeviceId;
        var stateKey = $"{rule.Id}_{deviceId}".ToLower();
        var targetDevice = await db.Devices.AsNoTracking().FirstOrDefaultAsync(d => d.Id == deviceId, ct);
        var deviceName = targetDevice?.Name ?? "Tủ điện";

        // ── Lấy alert đang open cho rule này và thiết bị này ──────────────────
        var openAlert = await db.Alerts
            .Where(a => a.RuleId == rule.Id && a.DeviceId == deviceId && a.Status == "open")
            .FirstOrDefaultAsync(ct);

        // ── Auto-close nếu giá trị xuống dưới clearValue ──────
        if (openAlert != null && !triggered)
        {
            var belowClear = RuleEvaluator.EvaluateClear(currentValue, op, clearValue);
            if (belowClear)
            {
                openAlert.Status   = "closed";
                openAlert.ClosedAt = DateTime.UtcNow;
                db.AlertHistories.Add(new AlertHistory
                {
                    AlertId = openAlert.Id,
                    Status  = "auto_closed",
                    Note    = $"Tự động đóng: {pointId} = {currentValue:F1} (dưới ngưỡng phục hồi {clearValue:F1})",
                });
                await db.SaveChangesAsync(ct);
                _cooldownUntil[stateKey] = DateTime.UtcNow.AddMinutes(cooldownMin);
                _confirmCounts[stateKey] = 0;
                _logger.LogInformation("[Rules] Auto-close alert {id} for device {devId}: {pt}={val}", openAlert.Id, deviceId, pointId, currentValue);
            }
            return;
        }

        if (!triggered) { _confirmCounts[stateKey] = 0; return; }
        if (openAlert != null)
        {
            var currentTargetLevel = levelOverride ?? RuleEvaluator.ParseAlertLevel(rule.Actions);
            // Nếu cảnh báo cũ đang là warning nhưng giá trị hiện tại đạt mức báo động (alarm/danger)
            if (openAlert.Level == "warning" && (currentTargetLevel == "alarm" || currentTargetLevel == "danger"))
            {
                openAlert.Level = currentTargetLevel;
                openAlert.Message = $"[{deviceName} - {rule.Name}] {pointId} = {currentValue:F1} {op} {threshold} (Nâng cấp lên Báo động)";
                openAlert.Value = currentValue;
                openAlert.TriggeredAt = DateTime.UtcNow;

                db.AlertHistories.Add(new AlertHistory
                {
                    AlertId = openAlert.Id,
                    Status  = "upgraded",
                    Note    = $"Nâng cấp cấp độ lên {currentTargetLevel}: {openAlert.Message}",
                });

                await db.SaveChangesAsync(ct);

                // Phát đi thông báo mới để kích hoạt popup báo động ở client
                await _notifier.SendAlertAsync(new {
                    id = openAlert.Id, level = openAlert.Level, status = openAlert.Status,
                    message = openAlert.Message, value = openAlert.Value,
                    source = openAlert.Source,
                    triggeredAt = openAlert.TriggeredAt, ruleId = openAlert.RuleId, deviceId = openAlert.DeviceId,
                    imageUrl = openAlert.ImageUrl, thumbnailUrl = openAlert.ThumbnailUrl, videoUrl = openAlert.VideoUrl,
                });
            }
            return;
        }

        if (_cooldownUntil.TryGetValue(stateKey, out var until) && DateTime.UtcNow < until)
        {
            _logger.LogDebug("[Rules] Rule {id} for device {devId} đang trong cooldown tới {until}", rule.Id, deviceId, until);
            return;
        }

        _confirmCounts.TryGetValue(stateKey, out var count);
        count++;
        _confirmCounts[stateKey] = count;
        if (count < confirmReadings)
        {
            _logger.LogDebug("[Rules] Rule {id} for device {devId}: {count}/{need} readings", rule.Id, deviceId, count, confirmReadings);
            return;
        }

        _confirmCounts[stateKey] = 0;

        var level = levelOverride ?? RuleEvaluator.ParseAlertLevel(rule.Actions);

        // Tự động đóng các cảnh báo (warning) khác đang mở của cùng thiết bị này nếu đây là báo động (alarm)
        if (level == "alarm" || level == "danger")
        {
            var openWarnings = await db.Alerts
                .Where(a => a.DeviceId == deviceId && a.Status == "open" && a.Level == "warning")
                .ToListAsync(ct);
            foreach (var w in openWarnings)
            {
                w.Status = "closed";
                w.ClosedAt = DateTime.UtcNow;
                db.AlertHistories.Add(new AlertHistory
                {
                    AlertId = w.Id,
                    Status  = "auto_closed",
                    Note    = $"Tự động đóng do có báo động mới cấp độ cao hơn: {rule.Name}",
                });
                await _notifier.SendAlertUpdatedAsync(new { id = w.Id, status = w.Status, deviceId = w.DeviceId, level = w.Level });
            }
        }

        var alert = new Alert
        {
            StationId   = rule.StationId,
            DeviceId    = deviceId,
            RuleId      = rule.Id,
            Source      = "rule_engine",
            Level       = level,
            Status      = "open",
            Message     = $"[{deviceName} - {rule.Name}] {pointId} = {currentValue:F1} {op} {threshold}",
            Value       = currentValue,
            TriggeredAt = DateTime.UtcNow,
        };

        db.Alerts.Add(alert);
        db.RuleTriggerLogs.Add(new RuleTriggerLog
        {
            RuleId            = rule.Id,
            DeviceId          = deviceId,
            StationId         = rule.StationId,
            ConditionSnapshot = rule.Condition,
            ValueAtTrigger    = currentValue,
            AlertId           = alert.Id,
        });
        db.AlertHistories.Add(new AlertHistory
        {
            AlertId = alert.Id, Status = "triggered", Note = alert.Message,
        });
        db.SyncQueues.Add(new StationOS.Data.Entities.SyncQueue
        {
            EntityType = "Alert",
            EntityId   = alert.Id,
            Payload    = JsonSerializer.Serialize(new
            {
                id = alert.Id, station_id = alert.StationId, device_id = alert.DeviceId,
                rule_id = alert.RuleId, source = alert.Source, level = alert.Level,
                status = alert.Status, message = alert.Message, value = alert.Value,
                triggered_at = alert.TriggeredAt,
            }),
            Status = "pending",
        });

        await db.SaveChangesAsync(ct);

        DetectionEvent? detectionEvent = null;
        try
        {
            var evidenceSvc = services.GetRequiredService<ThermalEvidenceService>();
            var evidence = await evidenceSvc.CaptureForAlertAsync(db, rule.StationId, ct);
            if (evidence != null)
            {
                alert.ImageUrl = evidence.ImageUrl;
                alert.ThumbnailUrl = evidence.ThumbnailUrl;
                alert.VideoUrl = evidence.VideoUrl;

                detectionEvent = new DetectionEvent
                {
                    StationId = rule.StationId,
                    CameraId = evidence.Camera.Id,
                    Source = "rule_engine",
                    DetectionType = "thermal_hotspot",
                    Severity = alert.Level,
                    Message = alert.Message,
                    DetectedAt = alert.TriggeredAt,
                    MaxTemp = (float?)currentValue,
                    AlertId = alert.Id,
                    Metadata = JsonSerializer.Serialize(new
                    {
                        snapshotUrl = evidence.ImageUrl,
                        thumbnailUrl = evidence.ThumbnailUrl,
                        videoUrl = evidence.VideoUrl,
                        pointId,
                        ruleName = rule.Name,
                        cameraName = evidence.Camera.Name,
                    }),
                };
                db.DetectionEvents.Add(detectionEvent);
                await db.SaveChangesAsync(ct);

                alert.DetectionId = detectionEvent.Id;
                await db.SaveChangesAsync(ct);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Rules] Khong tao duoc bang chung media cho alert {AlertId}", alert.Id);
        }

        _logger.LogWarning("[Rules] Alert [{Level}] ({confirmReadings} readings): {Msg}", level, confirmReadings, alert.Message);

        var enableEmailSetting = await db.SystemSettings.FirstOrDefaultAsync(s => s.Key == "enable_alert_email", ct);
        var enableEmail = enableEmailSetting?.Value?.Trim('"') != "false";

        if (enableEmail)
        {
            var emailSetting = await db.SystemSettings.FirstOrDefaultAsync(s => s.Key == "alert_email", ct);
            var toEmail = emailSetting?.Value?.Trim('"');
            if (!string.IsNullOrWhiteSpace(toEmail))
            {
                var emailSvc = services.GetRequiredService<EmailNotifyService>();
                var device   = alert.DeviceId.HasValue
                    ? await db.Devices.FindAsync(new object[] { alert.DeviceId.Value }, ct)
                    : null;
                _ = emailSvc.SendAlertEmailAsync(
                    toEmail, alert.Level, alert.Message ?? "",
                    device?.Name ?? "Không rõ", alert.Value,
                    alert.Message?.Contains("°C") == true ? "°C" : "dB"
                ).ContinueWith(_ => { });
            }
        }

        var enableSmsSetting = await db.SystemSettings.FirstOrDefaultAsync(s => s.Key == "enable_alert_sms", ct);
        var enableSms = enableSmsSetting?.Value?.Trim('"') == "true";

        if (enableSms)
        {
            var phoneSetting = await db.SystemSettings.FirstOrDefaultAsync(s => s.Key == "alert_phone", ct);
            var toPhone = phoneSetting?.Value?.Trim('"');
            if (!string.IsNullOrWhiteSpace(toPhone))
            {
                _logger.LogInformation("[SMS] (Simulation) Sending SMS alert to {Phone}: {Message}", toPhone, alert.Message);
                db.NotifyLogs.Add(new NotifyLog
                {
                    AlertId   = alert.Id,
                    Channel   = "sms",
                    Recipient = toPhone,
                    Status    = "sent",
                    SentAt    = DateTime.UtcNow
                });
                await db.SaveChangesAsync(ct);
            }
        }

        await _notifier.SendAlertAsync(new {
            id = alert.Id, level = alert.Level, status = alert.Status,
            message = alert.Message, value = alert.Value,
            source = alert.Source,
            triggeredAt = alert.TriggeredAt, ruleId = alert.RuleId, deviceId = alert.DeviceId,
            imageUrl = alert.ImageUrl, thumbnailUrl = alert.ThumbnailUrl, videoUrl = alert.VideoUrl,
        });

        if (detectionEvent != null)
        {
            await _notifier.SendCameraEventAsync(new
            {
                id = detectionEvent.Id,
                cameraId = detectionEvent.CameraId,
                cameraName = (await db.Devices.Where(d => d.Id == detectionEvent.CameraId).Select(d => d.Name).FirstOrDefaultAsync(ct)) ?? "Camera nhiet",
                detectionType = detectionEvent.DetectionType,
                detectedAt = detectionEvent.DetectedAt,
                maxTemp = detectionEvent.MaxTemp,
                alertId = detectionEvent.AlertId,
                metadata = detectionEvent.Metadata,
            });
        }
    }

    // ── Xử lý action type=maintenance ─────────────────────────────────────
    private async Task HandleMaintenanceActionAsync(
        AppDbContext db, Rule rule, string pointId, double currentValue,
        SensorReading reading, CancellationToken ct)
    {
        var maint = RuleEvaluator.ParseMaintenanceAction(rule.Actions);
        if (maint == null) return;
        var (taskType, scheduledInDays) = maint.Value;

        // Dedup: không tạo lại nếu đã có task pending/in_progress cho rule này
        var marker = $"[RULE:{rule.Id}]";
        var exists = await db.MaintenanceTasks.AnyAsync(t =>
            t.Notes != null && t.Notes.Contains(marker) &&
            (t.Status == "pending" || t.Status == "in_progress"), ct);
        if (exists) return;

        var device = rule.DeviceId.HasValue
            ? await db.Devices.FindAsync(new object[] { rule.DeviceId.Value }, ct)
            : null;

        var task = new MaintenanceTask
        {
            StationId     = rule.StationId,
            DeviceId      = rule.DeviceId,
            Title         = $"[{rule.Name}] {pointId} = {currentValue:F1}",
            Type          = taskType,
            ScheduledDate = DateTime.UtcNow.AddDays(scheduledInDays),
            Status        = "pending",
            Notes         = $"Tự động tạo bởi Rule Engine.\n" +
                            $"Rule: {rule.Name}\n" +
                            $"Giá trị tại thời điểm trigger: {pointId} = {currentValue:F1}\n" +
                            $"Thiết bị: {device?.Name ?? "Không rõ"}\n" +
                            marker,
        };
        db.MaintenanceTasks.Add(task);
        await db.SaveChangesAsync(ct);

        _logger.LogWarning("[Rules] Maintenance task tạo: [{rule}] → {type} in {days} ngày", rule.Name, taskType, scheduledInDays);
    }

    private static (string point, string op, double value)? ParseCondition(string json)
        => RuleEvaluator.ParseCondition(json);

    private static string ParseAlertLevel(string actionsJson)
        => RuleEvaluator.ParseAlertLevel(actionsJson);
}
