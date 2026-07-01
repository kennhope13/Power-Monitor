// ============================================================
// ReportGeneratorService — Tạo PDF dùng QuestPDF
// Supports: daily | monthly | event
// ============================================================

using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;
using StationOS.Data;
using StationOS.Data.Entities;

namespace StationOS.Services.Reports;

public record ReportOptions(
    Guid StationId,
    string Type,           // daily | monthly | event
    DateTime PeriodFrom,
    DateTime PeriodTo,
    Guid? GeneratedBy = null);

public class ReportGeneratorService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IHostEnvironment     _env;

    public ReportGeneratorService(IServiceScopeFactory scopeFactory, IHostEnvironment env)
    {
        _scopeFactory = scopeFactory;
        _env = env;
    }

    public async Task<Report> GenerateAsync(ReportOptions opts)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        bool isFleet = opts.StationId == Guid.Empty;

        // ── Lấy dữ liệu ─────────────────────────────────────
        var station = isFleet ? null : await db.Stations.FindAsync(opts.StationId);
        var stationName = isFleet ? "Toàn hệ thống (Fleet Summary)" : (station?.Name ?? "Trạm biến áp");

        // Alerts trong kỳ
        var alertQuery = db.Alerts.AsQueryable();
        if (!isFleet) alertQuery = alertQuery.Where(a => a.StationId == opts.StationId);
        
        var alerts = await alertQuery
            .Where(a => a.TriggeredAt >= opts.PeriodFrom
                     && a.TriggeredAt <= opts.PeriodTo)
            .OrderByDescending(a => a.TriggeredAt)
            .Take(isFleet ? 200 : 100)
            .ToListAsync();

        // Sensor readings — lấy thống kê theo thiết bị và điểm đo
        var readingQuery = db.SensorReadings.AsQueryable();
        if (!isFleet) readingQuery = readingQuery.Where(r => r.StationId == opts.StationId);

        var readings = await readingQuery
            .Where(r => r.Time >= opts.PeriodFrom
                     && r.Time <= opts.PeriodTo)
            .ToListAsync();

        var readingStats = readings
            .GroupBy(r => new { r.DeviceId, r.PointId })
            .Select(g => new {
                g.Key.DeviceId,
                g.Key.PointId,
                Min     = g.Min(r => r.Value) ?? 0,
                Max     = g.Max(r => r.Value) ?? 0,
                Avg     = g.Average(r => r.Value) ?? 0,
                Count   = g.Count()
            })
            .OrderBy(s => s.DeviceId).ThenBy(s => s.PointId)
            .ToList();

        // Metadata để resolve tên thân thiện
        var devicesQuery = db.Devices.AsQueryable();
        if (!isFleet) devicesQuery = devicesQuery.Where(d => d.StationId == opts.StationId);
        var devices = await devicesQuery.ToDictionaryAsync(d => d.Id);

        var roiPoints = await db.RoiPoints.Where(r => devices.Keys.Contains(r.DeviceId)).ToListAsync();
        var boundaries = await db.Boundaries.Where(b => devices.Keys.Contains(b.DeviceId)).ToListAsync();

        // ── Tạo PDF ──────────────────────────────────────────
        var titleMap = new Dictionary<string, string>
        {
            ["daily"]   = isFleet ? "BÁO CÁO TỔNG HỢP HÀNG NGÀY" : "BÁO CÁO VẬN HÀNH HÀNG NGÀY",
            ["monthly"] = isFleet ? "BÁO CÁO TỔNG HỢP HÀNG THÁNG" : "BÁO CÁO VẬN HÀNH HÀNG THÁNG",
            ["event"]   = "BÁO CÁO SỰ CỐ TỔNG HỢP",
        };
        var title = titleMap.GetValueOrDefault(opts.Type, "BÁO CÁO VẬN HÀNH");
        var fmtDate = (DateTime d) => d.ToString("dd/MM/yyyy");
        var periodStr = opts.PeriodFrom.Date == opts.PeriodTo.Date
            ? fmtDate(opts.PeriodFrom)
            : $"{fmtDate(opts.PeriodFrom)} – {fmtDate(opts.PeriodTo)}";

        int alarmCount  = alerts.Count(a => a.Level == "alarm");
        int warnCount   = alerts.Count(a => a.Level == "warning");
        int closedCount = alerts.Count(a => a.Status == "closed");

        var doc = Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Size(PageSizes.A4);
                page.MarginHorizontal(1.5f, Unit.Centimetre);
                page.MarginVertical(1.2f, Unit.Centimetre);
                page.DefaultTextStyle(x => x.FontSize(9).FontFamily("Arial"));

                // ── HEADER ──────────────────────────────────
                page.Header().Column(col =>
                {
                    col.Item().Row(row =>
                    {
                        row.RelativeItem().Column(c =>
                        {
                            c.Item().Text("STATION MONITOR ENTERPRISE")
                                .Bold().FontSize(13).FontColor("#1a56db");
                            c.Item().Text(title).Bold().FontSize(10);
                            c.Item().PaddingTop(2).Text($"Trạm: {stationName}   |   Kỳ: {periodStr}")
                                .FontSize(8).FontColor("#6b7280");
                            c.Item().Text($"Tạo lúc: {DateTime.Now:dd/MM/yyyy HH:mm}")
                                .FontSize(7.5f).FontColor("#9ca3af");
                        });
                    });
                    col.Item().PaddingTop(6).LineHorizontal(2).LineColor("#1a56db");
                });

                // ── CONTENT ─────────────────────────────────
                page.Content().PaddingTop(10).Column(col =>
                {
                    // KPI row
                    col.Item().Row(row =>
                    {
                        KpiBox(row.RelativeItem(), "Tổng cảnh báo",    alerts.Count.ToString(), "#1a56db");
                        row.ConstantItem(6);
                        KpiBox(row.RelativeItem(), "Nguy cấp (Alarm)", alarmCount.ToString(),  "#e02424");
                        row.ConstantItem(6);
                        KpiBox(row.RelativeItem(), "Cảnh báo",         warnCount.ToString(),   "#d97706");
                        row.ConstantItem(6);
                        KpiBox(row.RelativeItem(), "Đã xử lý",         closedCount.ToString(), "#059669");
                    });

                    col.Item().PaddingTop(14);

                    // Thống kê sensor
                    if (readingStats.Count > 0)
                    {
                        col.Item().Text("THỐNG KÊ CẢM BIẾN").Bold().FontSize(9.5f).FontColor("#374151");
                        col.Item().PaddingTop(4).Table(table =>
                        {
                            table.ColumnsDefinition(cols =>
                            {
                                cols.RelativeColumn(3);
                                cols.RelativeColumn(1.5f);
                                cols.RelativeColumn(1.5f);
                                cols.RelativeColumn(1.5f);
                                cols.RelativeColumn(1.5f);
                            });

                            // Header
                            table.Header(header =>
                            {
                                foreach (var h in new[] { "Điểm đo", "Min", "Max", "Trung bình", "Số mẫu" })
                                    header.Cell().Background("#1a56db").Padding(5)
                                        .Text(h).FontColor("#ffffff").Bold().FontSize(8);
                            });

                            var pointLabels = new Dictionary<string, string>
                            {
                                ["nhiet_do_pha_1"] = "Nhiệt độ Pha 1",
                                ["temp_1"]         = "Nhiệt độ Pha 1",
                                ["nhiet_do_pha_2"] = "Nhiệt độ Pha 2",
                                ["temp_2"]         = "Nhiệt độ Pha 2",
                                ["nhiet_do_pha_3"] = "Nhiệt độ Pha 3",
                                ["temp_3"]         = "Nhiệt độ Pha 3",
                                ["phong_dien"]     = "Phóng điện PD",
                                ["pd"]             = "Phóng điện PD",
                                ["nhiet_do_pha_2_1"] = "Nhiệt độ Pha 1 (Bộ 2)",
                                ["nhiet_do_pha_2_2"] = "Nhiệt độ Pha 2 (Bộ 2)",
                                ["nhiet_do_pha_2_3"] = "Nhiệt độ Pha 3 (Bộ 2)",
                                ["phong_dien_2"]     = "Phóng điện PD 2",
                            };

                            bool alt = false;
                            foreach (var s in readingStats)
                            {
                                var bg = alt ? "#f9fafb" : "#ffffff";
                                
                                // Tìm tên thiết bị
                                devices.TryGetValue(s.DeviceId, out var dev);
                                var devName = dev?.Name ?? "Thiết bị lạ";

                                // Tìm tên điểm đo (ROI / Boundary / Static)
                                var pIdLower = s.PointId.ToLower();
                                var friendlyPointName = pointLabels.GetValueOrDefault(pIdLower, s.PointId);
                                
                                if (friendlyPointName == s.PointId)
                                {
                                    // Thử tìm trong ROI
                                    var roi = roiPoints.FirstOrDefault(r => r.DeviceId == s.DeviceId && 
                                        (r.PointId?.ToLower() == pIdLower || r.Id.ToString().ToLower() == pIdLower));
                                    if (roi != null) friendlyPointName = roi.Name;
                                    else
                                    {
                                        // Thử tìm trong Boundaries
                                        var bnd = boundaries.FirstOrDefault(b => b.DeviceId == s.DeviceId && 
                                            (b.Name.ToLower() == pIdLower || b.Id.ToString().ToLower() == pIdLower));
                                        if (bnd != null) friendlyPointName = bnd.Name;
                                    }
                                }

                                var fullLabel = $"{devName} - {friendlyPointName}";
                                if (fullLabel.Length > 40) fullLabel = fullLabel.Substring(0, 37) + "...";

                                table.Cell().Background(bg).Padding(4).Text(fullLabel).FontSize(7.5f);
                                table.Cell().Background(bg).Padding(4).AlignCenter().Text($"{FormatNum(s.Min)}").FontSize(7.5f);
                                table.Cell().Background(bg).Padding(4).AlignCenter().Text($"{FormatNum(s.Max)}").FontSize(7.5f);
                                table.Cell().Background(bg).Padding(4).AlignCenter().Text($"{FormatNum(s.Avg)}").FontSize(7.5f);
                                table.Cell().Background(bg).Padding(4).AlignCenter().Text(s.Count.ToString()).FontSize(7.5f);
                                alt = !alt;
                            }
                        });
                        col.Item().PaddingTop(14);
                    }

                    // Danh sách cảnh báo
                    if (alerts.Count > 0)
                    {
                        var shown = alerts.Take(30).ToList();
                        col.Item().Text($"DANH SÁCH CẢNH BÁO ({shown.Count}/{alerts.Count})")
                            .Bold().FontSize(9.5f).FontColor("#374151");
                        col.Item().PaddingTop(4).Table(table =>
                        {
                            table.ColumnsDefinition(cols =>
                            {
                                cols.RelativeColumn(2.5f);
                                cols.RelativeColumn(3);
                                cols.RelativeColumn(1.5f);
                                cols.RelativeColumn(1.5f);
                            });

                            table.Header(header =>
                            {
                                foreach (var h in new[] { "Thời gian", "Mô tả", "Cấp độ", "Trạng thái" })
                                    header.Cell().Background("#374151").Padding(5)
                                        .Text(h).FontColor("#ffffff").Bold().FontSize(8);
                            });

                            bool alt = false;
                            foreach (var a in shown)
                            {
                                var bg = alt ? "#f9fafb" : "#ffffff";
                                var lvlColor = a.Level == "alarm" ? "#e02424" : "#d97706";
                                table.Cell().Background(bg).Padding(4)
                                    .Text(a.TriggeredAt.ToString("dd/MM HH:mm:ss")).FontSize(7.5f);
                                table.Cell().Background(bg).Padding(4)
                                    .Text(a.Message ?? "").FontSize(7.5f);
                                table.Cell().Background(bg).Padding(4).AlignCenter()
                                    .Text(a.Level.ToUpper()).FontColor(lvlColor).Bold().FontSize(7.5f);
                                table.Cell().Background(bg).Padding(4).AlignCenter()
                                    .Text(a.Status).FontSize(7.5f);
                                alt = !alt;
                            }
                        });
                    }
                    else
                    {
                        col.Item().PaddingTop(10)
                            .Background("#f0fdf4").Padding(12)
                            .Text("✓ Không có cảnh báo nào trong kỳ báo cáo.")
                            .FontColor("#059669").FontSize(9);
                    }
                });

                // ── FOOTER ──────────────────────────────────
                page.Footer().Column(col =>
                {
                    col.Item().LineHorizontal(0.5f).LineColor("#e5e7eb");
                    col.Item().PaddingTop(4).Row(row =>
                    {
                        row.RelativeItem()
                            .Text("Station Monitor Enterprise  |  Báo cáo tự động")
                            .FontSize(7).FontColor("#9ca3af");
                        row.RelativeItem().AlignRight()
                            .Text(x =>
                            {
                                x.Span("Trang ").FontSize(7).FontColor("#9ca3af");
                                x.CurrentPageNumber().FontSize(7).FontColor("#9ca3af");
                                x.Span("/").FontSize(7).FontColor("#9ca3af");
                                x.TotalPages().FontSize(7).FontColor("#9ca3af");
                            });
                    });
                });
            });
        });

        // ── Lưu file ─────────────────────────────────────────
        var reportId = Guid.NewGuid();
        var reportsDir = Path.Combine(_env.ContentRootPath, "wwwroot", "reports");
        Directory.CreateDirectory(reportsDir);
        var fileName = $"{reportId}.pdf";
        var filePath = Path.Combine(reportsDir, fileName);
        doc.GeneratePdf(filePath);

        // ── Ghi vào DB ───────────────────────────────────────
        var report = new Report
        {
            Id          = reportId,
            StationId   = opts.StationId,
            Type        = opts.Type,
            PeriodFrom  = opts.PeriodFrom,
            PeriodTo    = opts.PeriodTo,
            FileUrl     = $"/reports/{fileName}",
            GeneratedBy = opts.GeneratedBy,
            GeneratedAt = DateTime.UtcNow,
        };
        db.Reports.Add(report);
        await db.SaveChangesAsync();
        return report;
    }

    // ── Helpers ──────────────────────────────────────────────
    private static string FormatNum(double val)
    {
        if (double.IsNaN(val) || double.IsInfinity(val)) return "0.0";
        // Nếu số quá lớn (rác), giới hạn hiển thị để tránh vỡ layout
        if (Math.Abs(val) > 1000000) return val.ToString("E1"); 
        return val.ToString("F1");
    }

    private static void KpiBox(IContainer container, string label, string value, string hexColor)
    {
        container
            .Border(1).BorderColor("#e5e7eb")
            .BorderLeft(3).BorderColor(hexColor)
            .Padding(8)
            .Column(c =>
            {
                c.Item().Text(label).FontSize(7).FontColor("#6b7280").Bold();
                c.Item().PaddingTop(3).Text(value).FontSize(20).Bold().FontColor(hexColor);
            });
    }
}
