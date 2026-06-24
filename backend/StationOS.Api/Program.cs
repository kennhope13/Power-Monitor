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

var builder = WebApplication.CreateBuilder(args);

// ── Register Services via Extension Method ───────────────
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
