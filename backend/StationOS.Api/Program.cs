// ============================================================
// Program.cs — Điểm khởi động ASP.NET Core API
// Phase 2: thêm SignalR, PlcPollingWorker, DeviceService
// Refactored using Extension Methods and added Swagger
// ============================================================

using Microsoft.AspNetCore.HttpOverrides;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using StationOS.Api.Hubs;
using StationOS.Api.Middleware;
using StationOS.Api.Extensions;
using StationOS.Data;
using StationOS.Services.Reports;
using StationOS.Workers.Polling;

WebApplicationBuilder builder;
var customWebRoot = Environment.GetEnvironmentVariable("STATIONOS_WEB_ROOT");
if (!string.IsNullOrEmpty(customWebRoot))
{
    if (!Directory.Exists(customWebRoot))
    {
        Directory.CreateDirectory(customWebRoot);
    }
    
    // Ensure all required folders are present
    var subdirs = new[] {
        Path.Combine(customWebRoot, "media"),
        Path.Combine(customWebRoot, "media", "buffer"),
        Path.Combine(customWebRoot, "media", "recordings"),
        Path.Combine(customWebRoot, "media", "detections"),
        Path.Combine(customWebRoot, "media", "videos"),
        Path.Combine(customWebRoot, "reports"),
        Path.Combine(customWebRoot, "sld")
    };
    foreach (var dir in subdirs)
    {
        if (!Directory.Exists(dir))
        {
            Directory.CreateDirectory(dir);
        }
    }

    builder = WebApplication.CreateBuilder(new WebApplicationOptions
    {
        Args = args,
        WebRootPath = customWebRoot
    });
}
else
{
    builder = WebApplication.CreateBuilder(args);
}


// ── Register Services via Extension Method ───────────────
builder.Services.AddStationOSServices(builder.Configuration);
builder.Services.AddResponseCompression();
builder.Services.AddResponseCaching();

// ── Cấu hình ForwardedHeaders chống IP Spoofing qua Reverse Proxy ──
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    options.KnownNetworks.Clear();
    options.KnownProxies.Clear();
});

// ── CORS ──────────────────────────────────────────────────
// AllowCredentials() bắt buộc để SignalR hoạt động
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.SetIsOriginAllowed(_ => true)
              .AllowAnyMethod()
              .AllowAnyHeader()
              .AllowCredentials());
});

var app = builder.Build();

// ── Global Exception Handler ──────────────────────────────
app.UseExceptionHandler(errorApp =>
{
    errorApp.Run(async ctx =>
    {
        ctx.Response.StatusCode = 500;
        ctx.Response.ContentType = "application/json";
        var error = new { error = "Lỗi hệ thống nội bộ", traceId = ctx.TraceIdentifier };
        await ctx.Response.WriteAsJsonAsync(error);
    });
});

// ── Chống IP Spoofing qua Reverse Proxy ──────────────────
// PHẢI đặt đầu tiên để nhận diện IP thật của client
app.UseForwardedHeaders();
app.UseResponseCompression();
app.UseResponseCaching();


// Serve static files (SVG diagrams) từ wwwroot/
app.UseStaticFiles();

// ── Swagger UI ────────────────────────────────────────────
app.UseSwagger();
app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/swagger/v1/swagger.json", "StationOS API v1");
    c.RoutePrefix = "swagger"; // Truy cập tại: http://localhost:PORT/swagger
});

app.UseCors();
app.UseRateLimiter();          // Rate limit: phải nằm SAU UseCors, TRƯỚC UseAuth
app.UseAuthentication();
// Dev only: auto-gán admin claims khi request không có Authorization header → khỏi login lại liên tục
// if (app.Environment.IsDevelopment())
//     app.UseMiddleware<StationOS.Api.Middleware.DevAutoAuthMiddleware>();
app.UseAuthorization();
app.UseMiddleware<AuditMiddleware>(); // Ghi audit log tự động

// ── Cờ sẵn sàng: /health chỉ trả 200 SAU KHI DB đã migrate xong ──
var isReady = false;

// Endpoint kiểm tra sức khỏe hệ thống (Docker Healthcheck + Electron waitForServer)
// Trả 503 khi DB chưa migrate xong hoặc PostgreSQL đã rớt sau startup.
app.MapGet("/health", async (IServiceProvider services, CancellationToken ct) =>
{
    if (!isReady)
    {
        return Results.StatusCode(503);
    }

    try
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var dbOk = await db.Database.CanConnectAsync(ct);
        return dbOk
            ? (IResult)Results.Ok(new { status = "ok", database = "ok", timestamp = DateTime.UtcNow })
            : Results.StatusCode(503);
    }
    catch
    {
        return Results.StatusCode(503);
    }
});

app.MapControllers();

// SignalR endpoint
app.MapHub<RealtimeHub>("/ws/realtime");

// ── Database & Seeding Startup Tasks ──────────────────────
// PHẢI chạy trước Hangfire vì Hangfire sẽ cố gắng connect để tạo bảng ngay khi UseHangfireDashboard/RecurringJob.AddOrUpdate được gọi
await app.InitializeDatabaseAsync();

// ── Đánh dấu backend đã sẵn sàng phục vụ request ──
isReady = true;
Console.WriteLine("[Startup] Backend đã sẵn sàng phục vụ request.");

// Hangfire dashboard bảo mật với HangfireAuthorizationFilter
app.UseHangfireDashboard("/hangfire", new DashboardOptions
{
    Authorization = new[] { new HangfireAuthorizationFilter() }
});

// Đăng ký recurring job: tạo báo cáo ngày lúc 00:05 hàng ngày
RecurringJob.AddOrUpdate<ReportSchedulerWorker>(
    "daily-report",
    worker => worker.GenerateDailyAsync(),
    "5 0 * * *");  // 00:05 mỗi ngày

app.Run();
