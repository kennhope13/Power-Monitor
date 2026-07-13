// ============================================================
// AuditMiddleware — Tự động ghi AuditLog cho mọi thao tác
// POST/PUT/DELETE /api/v1/** → ghi vào bảng AuditLogs
// Bỏ qua: GET, auth/login, auth/refresh, ws/*
// ============================================================

using System.Security.Claims;
using System.Text;
using Microsoft.EntityFrameworkCore;
using StationOS.Data;
using StationOS.Data.Entities;

namespace StationOS.Api.Middleware;

public class AuditMiddleware
{
    private readonly RequestDelegate _next;

    public AuditMiddleware(RequestDelegate next) => _next = next;

    /// <summary>Xử lý request và tự động ghi AuditLog cho mọi thao tác thay đổi dữ liệu (POST/PUT/PATCH/DELETE) trên /api/v1/** sau khi response thành công.</summary>
    /// <param name="ctx">HttpContext của request hiện tại.</param>
    /// <param name="db">AppDbContext để ghi audit log vào database.</param>
    public async Task InvokeAsync(HttpContext ctx, AppDbContext db)
    {
        var method = ctx.Request.Method;
        var path   = ctx.Request.Path.Value ?? "";
        var requestBody = await ReadJsonRequestBodyAsync(ctx);

        var isWrite = IsWriteMethod(method);
        var entityType = ExtractEntityType(path);
        var entityId = ExtractEntityId(path);

        string? oldValue = null;

        // If it's update or delete, capture the old entity state before the pipeline runs
        if (isWrite && (method == "PUT" || method == "PATCH" || method == "DELETE") && entityId.HasValue && !string.IsNullOrEmpty(entityType))
        {
            try
            {
                object? oldEntity = entityType.ToLower() switch
                {
                    "device" => await db.Devices.AsNoTracking().FirstOrDefaultAsync(x => x.Id == entityId.Value),
                    "rule" => await db.Rules.AsNoTracking().FirstOrDefaultAsync(x => x.Id == entityId.Value),
                    "user" => await db.Users.AsNoTracking().FirstOrDefaultAsync(x => x.Id == entityId.Value),
                    "station" => await db.Stations.AsNoTracking().FirstOrDefaultAsync(x => x.Id == entityId.Value),
                    "boundary" => await db.Boundaries.AsNoTracking().FirstOrDefaultAsync(x => x.Id == entityId.Value),
                    "roi-point" or "roi-points" => await db.RoiPoints.AsNoTracking().FirstOrDefaultAsync(x => x.Id == entityId.Value),
                    _ => null
                };

                if (oldEntity != null)
                {
                    oldValue = System.Text.Json.JsonSerializer.Serialize(oldEntity, new System.Text.Json.JsonSerializerOptions
                    {
                        PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase
                    });
                }
            }
            catch
            {
                // Suppress database lookup errors
            }
        }

        await _next(ctx);

        // Chỉ ghi khi: là API call thay đổi dữ liệu, đã authen, thành công
        if (!isWrite) return;
        if (!path.StartsWith("/api/v1/")) return;
        if (path.Contains("/auth/")) return;
        
        // Bỏ qua các API tự động, dữ liệu lớn hoặc query runtime (tránh làm tràn ngập log)
        if (path.Contains("/measurements/ingest") ||
            path.Contains("/camera-webhook") ||
            path.Contains("/thermal/live-temps") ||
            path.StartsWith("/api/v1/ai-events", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        if (ctx.Response.StatusCode is < 200 or >= 300) return;
        if (ctx.User?.Identity?.IsAuthenticated != true) return;

        var userId    = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);
        var action    = method.ToLower() switch {
            "post"   => "create",
            "put"    => "update",
            "patch"  => "update",
            "delete" => "delete",
            _        => method.ToLower()
        };

        // Đặc biệt: ack / close alert
        if (path.Contains("/ack"))   action = "ack_alert";
        if (path.Contains("/close")) action = "close_alert";

        string? newValue = requestBody;

        // For updates, fetch the new entity state from DB to compare full objects
        if (action == "update" && entityId.HasValue && !string.IsNullOrEmpty(entityType))
        {
            try
            {
                object? newEntity = entityType.ToLower() switch
                {
                    "device" => await db.Devices.AsNoTracking().FirstOrDefaultAsync(x => x.Id == entityId.Value),
                    "rule" => await db.Rules.AsNoTracking().FirstOrDefaultAsync(x => x.Id == entityId.Value),
                    "user" => await db.Users.AsNoTracking().FirstOrDefaultAsync(x => x.Id == entityId.Value),
                    "station" => await db.Stations.AsNoTracking().FirstOrDefaultAsync(x => x.Id == entityId.Value),
                    "boundary" => await db.Boundaries.AsNoTracking().FirstOrDefaultAsync(x => x.Id == entityId.Value),
                    "roi-point" or "roi-points" => await db.RoiPoints.AsNoTracking().FirstOrDefaultAsync(x => x.Id == entityId.Value),
                    _ => null
                };

                if (newEntity != null)
                {
                    newValue = System.Text.Json.JsonSerializer.Serialize(newEntity, new System.Text.Json.JsonSerializerOptions
                    {
                        PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase
                    });
                }
            }
            catch
            {
                // Fallback to request body if DB fetch fails
            }
        }

        try
        {
            var log = new AuditLog
            {
                UserId     = Guid.TryParse(userId, out var uid) ? uid : null,
                Action     = action,
                EntityType = entityType,
                EntityId   = entityId,
                OldValue   = oldValue,
                NewValue   = newValue,
                IpAddress  = ctx.Connection.RemoteIpAddress?.ToString(),
            };
            db.AuditLogs.Add(log);

            // Đẩy lên trạm tổng qua SyncQueue
            db.SyncQueues.Add(new StationOS.Data.Entities.SyncQueue
            {
                EntityType = "AuditLog",
                EntityId   = log.Id,
                Payload    = System.Text.Json.JsonSerializer.Serialize(new {
                    log.Id, log.Action, log.EntityType, log.EntityId,
                    log.UserId, log.OldValue, log.NewValue, log.IpAddress,
                    Ts = log.Ts,
                }),
            });

            await db.SaveChangesAsync();
        }
        catch
        {
            // Không để audit lỗi phá vỡ response
        }
    }

    private static bool IsWriteMethod(string method) =>
        method is "POST" or "PUT" or "PATCH" or "DELETE";

    private static string? ExtractEntityType(string path)
    {
        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        string? rawType = null;

        // Tìm GUID cuối cùng để lấy loại đối tượng ngay trước nó
        for (var i = segments.Length - 1; i >= 0; i--)
        {
            if (Guid.TryParse(segments[i], out _))
            {
                if (i - 1 >= 0)
                {
                    rawType = segments[i - 1].ToLower();
                    break;
                }
            }
        }

        if (string.IsNullOrEmpty(rawType) && segments.Length >= 3)
        {
            rawType = segments[2].ToLower();
        }

        if (string.IsNullOrEmpty(rawType)) return null;

        return rawType switch
        {
            "devices" or "device" => "device",
            "rules" or "rule" => "rule",
            "users" or "user" => "user",
            "stations" or "station" => "station",
            "boundaries" or "boundary" => "boundary",
            "roi-points" or "roi-point" => "roi-point",
            _ => rawType.TrimEnd('s')
        };
    }

    private static Guid? ExtractEntityId(string path)
    {
        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        // Ưu tiên GUID cuối cùng để hỗ trợ route lồng nhau như /sld/points/{id}
        for (var i = segments.Length - 1; i >= 0; i--)
        {
            if (Guid.TryParse(segments[i], out var id))
                return id;
        }

        return null;
    }

    private static async Task<string?> ReadJsonRequestBodyAsync(HttpContext ctx)
    {
        var method = ctx.Request.Method;
        var path   = ctx.Request.Path.Value ?? "";
        var contentType = ctx.Request.ContentType ?? "";

        if (!IsWriteMethod(method)) return null;
        if (!path.StartsWith("/api/v1/")) return null;
        if (path.Contains("/auth/")) return null;

        // Bỏ qua các API tự động, dữ liệu lớn hoặc query runtime để tránh buffer tốn tài nguyên
        if (path.Contains("/measurements/ingest") ||
            path.Contains("/camera-webhook") ||
            path.Contains("/thermal/live-temps") ||
            path.StartsWith("/api/v1/ai-events", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        if (!contentType.Contains("application/json", StringComparison.OrdinalIgnoreCase)) return null;
        if (!ctx.Request.Body.CanRead) return null;

        ctx.Request.EnableBuffering();

        using var reader = new StreamReader(ctx.Request.Body, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
        var body = await reader.ReadToEndAsync();
        ctx.Request.Body.Position = 0;

        return string.IsNullOrWhiteSpace(body) ? null : body;
    }
}
