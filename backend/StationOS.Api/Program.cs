// ============================================================
// Program.cs — Điểm khởi động ASP.NET Core API
// Phase 2: thêm SignalR, PlcPollingWorker, DeviceService
// Refactored using Extension Methods and added Swagger
// ============================================================

using Microsoft.AspNetCore.HttpOverrides;
using Hangfire;
using StationOS.Api.Hubs;
using StationOS.Api.Middleware;
using StationOS.Api.Extensions;
using StationOS.Services.Reports;
using StationOS.Workers.Polling;
using System.IO;

var envWebRoot = Environment.GetEnvironmentVariable("STATIONOS_WEBROOT");

var builderOptions = new WebApplicationOptions
{
    Args = args,
    WebRootPath = string.IsNullOrEmpty(envWebRoot) ? null : envWebRoot
};

// Helper to check if a directory is writable by attempting to create a temporary file
static bool IsDirectoryWritable(string path)
{
    try
    {
        var testFile = Path.Combine(path, ".__writetest.tmp");
        File.WriteAllText(testFile, "test");
        File.Delete(testFile);
        return true;
    }
    catch
    {
        return false;
    }
}

static void CopyDirectory(string sourceDir, string destDir)
{
    if (!Directory.Exists(sourceDir)) return;
    Directory.CreateDirectory(destDir);
    foreach (var file in Directory.GetFiles(sourceDir))
    {
        var destFile = Path.Combine(destDir, Path.GetFileName(file));
        File.Copy(file, destFile, true);
    }
    foreach (var dir in Directory.GetDirectories(sourceDir))
    {
        var destSubDir = Path.Combine(destDir, Path.GetFileName(dir));
        CopyDirectory(dir, destSubDir);
    }
}

var builder = WebApplication.CreateBuilder(builderOptions);

// Determine effective WebRootPath and ensure it is writable
var originalWebRoot = builder.Environment.WebRootPath ?? Path.Combine(builder.Environment.ContentRootPath, "wwwroot");
if (!IsDirectoryWritable(originalWebRoot))
{
    var fallbackWebRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Power-Monitor", "wwwroot");
    // Ensure fallback exists and copy default static assets
    CopyDirectory(originalWebRoot, fallbackWebRoot);
    builder.WebHost.UseWebRoot(fallbackWebRoot);
    Console.WriteLine($"[Startup] WebRootPath not writable. Redirected to writable location: {fallbackWebRoot}");
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

// Endpoint kiểm tra sức khỏe hệ thống (Docker Healthcheck)
app.MapGet("/health", () => Results.Ok(new { status = "ok", timestamp = DateTime.UtcNow }));

app.MapControllers();

// SignalR endpoint
app.MapHub<RealtimeHub>("/ws/realtime");

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

// ── Database & Seeding Startup Tasks ──────────────────────
await app.InitializeDatabaseAsync();

app.Run();
