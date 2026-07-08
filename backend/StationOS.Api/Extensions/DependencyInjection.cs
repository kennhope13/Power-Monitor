using System.Text;
using System.Threading.RateLimiting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Builder;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Microsoft.OpenApi.Models;
using Hangfire;
using Hangfire.PostgreSql;
using StationOS.Data;
using StationOS.Services;
using StationOS.Services.Auth;
using StationOS.Services.Camera;
using StationOS.Services.Devices;
using StationOS.Services.DeviceHandlers;
using StationOS.Services.Security;
using StationOS.Services.Reports;
using StationOS.Workers.Polling;
using StationOS.Api.Hubs;

namespace StationOS.Api.Extensions;

public static class DependencyInjection
{
    /// <summary>Đăng ký toàn bộ dịch vụ của StationOS vào DI container: database, Hangfire, authentication JWT, SignalR, rate limiting, Swagger và tất cả background workers.</summary>
    /// <param name="services">IServiceCollection để đăng ký dịch vụ.</param>
    /// <param name="configuration">Cấu hình ứng dụng (appsettings.json).</param>
    /// <returns>IServiceCollection để hỗ trợ method chaining.</returns>
    public static IServiceCollection AddStationOSServices(this IServiceCollection services, IConfiguration configuration)
    {
        // ── QuestPDF license ──────────────────────────────────────
        QuestPDF.Settings.License = QuestPDF.Infrastructure.LicenseType.Community;

        // ── Database ──────────────────────────────────────────────
        services.AddDbContext<AppDbContext>(options =>
            options.UseNpgsql(configuration.GetConnectionString("Default")));

        // ── Forwarded Headers (Chống IP Spoofing qua Reverse Proxy) ──
        services.Configure<ForwardedHeadersOptions>(options =>
        {
            options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
            options.KnownNetworks.Clear();
            options.KnownProxies.Clear();
        });

        // ── Hangfire ──────────────────────────────────────────────
        services.AddHangfire(config =>
            config.UsePostgreSqlStorage(c =>
                c.UseNpgsqlConnection(configuration.GetConnectionString("Default"))));
        services.AddHangfireServer();

        // ── Services ──────────────────────────────────────────────
        services.AddHttpContextAccessor();
        services.AddMemoryCache(); // Đăng ký In-Memory Cache
        services.AddScoped<AuthService>();
        services.AddScoped<EmailNotifyService>();
        services.AddScoped<PermissionService>();
        services.AddScoped<DeviceService>();
        services.AddScoped<ReportGeneratorService>();
        services.AddScoped<ReportSchedulerWorker>();
        services.AddHttpClient(); // cho DeviceService gọi go2rtc API
        services.AddSingleton<IRealtimeNotifier, SignalRNotifier>(); // SignalR push
        services.AddScoped<OnvifService>();
        services.AddScoped<HikvisionIsapiService>();
        services.AddScoped<ThermalEvidenceService>();
        services.AddScoped<AutoDiscoveryService>();
        services.AddScoped<ProtocolConnectionTester>();
        services.AddScoped<SupabaseService>();
        services.AddScoped<StationOS.Services.Recording.EventRecordingService>();
        services.AddSingleton<LicenseService>();          // License key + concurrent sessions
        services.AddSingleton<CredentialEncryptionService>(); // AES-256-GCM cho device password

        // ── Background Workers ────────────────────────────────────
        services.AddHostedService<PlcPollingWorker>();
        services.AddHostedService<RuleEvaluationWorker>();
        services.AddHostedService<MaintenanceReminderWorker>();
        
        // HealthScoreWorker: Đăng ký singleton để AnalyticsController có thể trigger recalculate thủ công
        services.AddSingleton<HealthScoreWorker>();
        services.AddHostedService(sp => sp.GetRequiredService<HealthScoreWorker>());
        
        services.AddHostedService<StorageMonitorWorker>();
        services.AddHostedService<ModbusTcpWorker>();
        services.AddHostedService<ModbusRtuWorker>();
        services.AddHostedService<MqttSubscriberWorker>();
        services.AddHostedService<Iec104Worker>();
        services.AddHostedService<CloudSyncWorker>();
        services.AddHostedService<CentralSyncWorker>();
        services.AddHostedService<DeviceHealthCheckWorker>();
        services.AddHostedService<StationOS.Workers.Recording.RtspRecorderWorker>();

        // ── Device Handlers (plugin pattern) ──────────────────────
        // Mỗi loại thiết bị có handler riêng. Registry tự dispatch theo device.Type.
        services.AddScoped<IDeviceHandler, PlcS7Handler>();
        services.AddScoped<IDeviceHandler, ModbusTcpHandler>();
        services.AddScoped<IDeviceHandler, ModbusRtuHandler>();
        services.AddScoped<IDeviceHandler, MqttHandler>();
        services.AddScoped<IDeviceHandler, Iec104Handler>();
        services.AddScoped<IDeviceHandler, GenericCameraHandler>();
        services.AddScoped<DeviceHandlerRegistry>();

        // ── SignalR ───────────────────────────────────────────────
        services.AddSignalR().AddJsonProtocol(options => {
            options.PayloadSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
        });

        // ── JWT Authentication ────────────────────────────────────
        var jwtKey = configuration["Jwt:Key"]!;
        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
            .AddJwtBearer(options =>
            {
                var signingKeys = new List<SecurityKey>
                {
                    new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
                    new SymmetricSecurityKey(Encoding.UTF8.GetBytes("StationOS_SuperSecret_Key_2026_ChangeInProduction!")),
                    new SymmetricSecurityKey(Encoding.UTF8.GetBytes("StationMonitor_SuperSecret_Key_2026_ChangeInProduction!")),
                    new SymmetricSecurityKey(Encoding.UTF8.GetBytes("CHANGE_ME_min_32_chars_random_secret_key"))
                };

                options.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuer = true,
                    ValidateAudience = true,
                    ValidateLifetime = false,
                    ValidateIssuerSigningKey = true,
                    ValidIssuers = new[] { configuration["Jwt:Issuer"], "StationOS", "StationMonitor" },
                    ValidAudiences = new[] { configuration["Jwt:Audience"], "StationOSApp", "StationMonitorApp" },
                    IssuerSigningKeys = signingKeys
                };
                
                // SignalR và download endpoint cần đọc token từ query string
                options.Events = new JwtBearerEvents
                {
                    OnMessageReceived = ctx =>
                    {
                        var token = ctx.Request.Query["access_token"];
                        if (!string.IsNullOrEmpty(token) && (
                            ctx.HttpContext.Request.Path.StartsWithSegments("/ws") ||
                            ctx.HttpContext.Request.Path.StartsWithSegments("/api/v1/reports")))
                            ctx.Token = token;
                        return Task.CompletedTask;
                    },
                    OnTokenValidated = async ctx =>
                    {
                        var sessionId = ctx.Principal?.FindFirst("sessionId")?.Value;
                        var userId = ctx.Principal?.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
                        
                        if (string.IsNullOrEmpty(sessionId) && !string.IsNullOrEmpty(userId))
                        {
                            var jwtToken = ctx.SecurityToken as System.IdentityModel.Tokens.Jwt.JwtSecurityToken;
                            var rawToken = jwtToken?.RawData;
                            if (!string.IsNullOrEmpty(rawToken))
                            {
                                var hashBytes = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(rawToken));
                                sessionId = "legacy_" + Convert.ToHexString(hashBytes)[..16];
                            }
                            else
                            {
                                sessionId = "legacy_" + userId;
                            }
                        }

                        if (!string.IsNullOrEmpty(sessionId) && !string.IsNullOrEmpty(userId))
                        {
                            var licenseService = ctx.HttpContext.RequestServices.GetRequiredService<LicenseService>();
                            var expiresAt = ctx.SecurityToken?.ValidTo ?? DateTime.UtcNow.AddDays(3650);
                            
                            if (!licenseService.IsSessionActive(sessionId))
                            {
                                bool registered = await licenseService.TryRegisterOnRequestAsync(sessionId, userId, expiresAt);
                                if (!registered)
                                {
                                    ctx.Fail("Session is no longer active (kicked out or limit exceeded)");
                                    return;
                                }
                            }
                            else
                            {
                                licenseService.RegisterActiveSession(sessionId, userId, expiresAt);
                            }
                        }
                    }
                };
            });

        services.AddAuthorization();
        services.AddControllers();

        // ── Rate Limiting ─────────────────────────────────────────
        // Chống brute force: login + auth endpoints giới hạn theo IP.
        // Webhook (camera/sensor push) limit cao hơn vì traffic IoT.
        services.AddRateLimiter(opt =>
        {
            opt.RejectionStatusCode = 429;

            // Login: 5 lần thất bại / 1 phút / IP, sliding window
            opt.AddPolicy("login", httpContext =>
                RateLimitPartition.GetSlidingWindowLimiter(
                    partitionKey: httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                    factory: _ => new SlidingWindowRateLimiterOptions
                    {
                        PermitLimit = 5,
                        Window = TimeSpan.FromMinutes(1),
                        SegmentsPerWindow = 4,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            // Webhook IoT: 100 req/s/IP (camera push event nhiều)
            opt.AddPolicy("webhook", httpContext =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 100,
                        Window = TimeSpan.FromSeconds(1),
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 20,
                    }));

            // Default cho mọi endpoint khác: 60 req/s/IP — phòng DDoS nhẹ
            opt.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(httpContext =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 60,
                        Window = TimeSpan.FromSeconds(1),
                        QueueLimit = 10,
                    }));
        });

        // ── Swagger / OpenAPI với JWT Support ──────────────────────
        services.AddEndpointsApiExplorer();
        services.AddSwaggerGen(c =>
        {
            c.SwaggerDoc("v1", new OpenApiInfo { Title = "StationOS API", Version = "v1" });
            c.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
            {
                Description = "JWT Authorization header using the Bearer scheme. Example: \"Authorization: Bearer {token}\"",
                Name = "Authorization",
                In = ParameterLocation.Header,
                Type = SecuritySchemeType.ApiKey,
                Scheme = "Bearer"
            });
            c.AddSecurityRequirement(new OpenApiSecurityRequirement
            {
                {
                    new OpenApiSecurityScheme
                    {
                        Reference = new OpenApiReference
                        {
                            Type = ReferenceType.SecurityScheme,
                            Id = "Bearer"
                        }
                    },
                    Array.Empty<string>()
                }
            });
        });

        return services;
    }
}
