using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using StationOS.Data;

namespace StationOS.Api.Middleware;

// Khi env=Development và request chưa có Authorization header → tự gán admin claims.
// Mục đích: dev khỏi phải login lại liên tục khi đang xây tính năng.
// Production KHÔNG đăng ký middleware này → [Authorize] hoạt động bình thường.
public class DevAutoAuthMiddleware
{
    private readonly RequestDelegate _next;

    public DevAutoAuthMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext ctx, AppDbContext db)
    {
        if (!ctx.Request.Headers.ContainsKey("Authorization") &&
            (ctx.User?.Identity?.IsAuthenticated != true))
        {
            var admin = await db.Users
                .Where(u => (u.Username == "stationadmin" || u.Username == "admin") && u.IsActive)
                .Select(u => new { u.Id, u.Username, u.Role, u.FullName })
                .FirstOrDefaultAsync();

            if (admin != null)
            {
                var claims = new[]
                {
                    new Claim(ClaimTypes.NameIdentifier, admin.Id.ToString()),
                    new Claim(ClaimTypes.Name, admin.Username),
                    new Claim(ClaimTypes.Role, admin.Role),
                    new Claim("fullName", admin.FullName ?? "")
                };
                ctx.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "DevAutoAuth"));
            }
        }
        await _next(ctx);
    }
}
