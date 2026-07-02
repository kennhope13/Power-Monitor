import { useState, useEffect, useRef } from 'react';
import Chart from 'chart.js/auto';
import 'chartjs-adapter-date-fns';
import { stationApi, AlertItem, ReportItem } from '@/services/StationApiService';
import { fmtDateTime } from '@/utils/format';
import { confirmDialog } from '@/utils/confirm';
import { POINTS, ReportType } from '../types';
import DateRangeToolbar from '@/components/ui/DateRangeToolbar';

const resolveCssVar = (name: string, fallback: string) => {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
};

export default function ReportTab({ stationId }: { stationId: string }) {
  const chartInst = useRef<Chart | null>(null);
  const chartCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [type, setType] = useState<ReportType>('daily');
  const [timePreset, setTimePreset] = useState<'all' | 'today' | 'yesterday' | '7d' | '30d' | 'custom'>('custom');
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0] || '';
  });
  const [to, setTo] = useState(() => new Date().toISOString().split('T')[0] || '');

  const [opts, setOpts] = useState({ stats: true, trend: true, alerts: true, pd: true, sensor: true });

  const [generating, setGenerating] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [currentReportId, setCurrentReportId] = useState('');

  const [history, setHistory] = useState<ReportItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [cabinetList, setCabinetList] = useState<any[]>([]);

  useEffect(() => {
    const fetchMonitoringPoints = async () => {
      try {
        const [devs, latestPoints, scores] = await Promise.all([
          stationApi.getDevices(stationId),
          stationApi.getLatestPoints(stationId),
          stationApi.getHealthScores(stationId)
        ]);

        const filteredDevs = devs.filter(d => 
          d.type === 'plc_s7' || 
          d.type === 'cabinet' || 
          d.type === 'camera_pd' || 
          d.type === 'camera_thermal' || 
          d.type === 'camera_dual'
        );

        const list = filteredDevs.map(dev => {
          const hInfo = scores.find(s => s.deviceId.toLowerCase() === dev.id.toLowerCase()) || { score: 100, risk: 'good' };
          
          // Identify points for this device
          const devPoints = latestPoints.filter(p => p.deviceId.toLowerCase() === dev.id.toLowerCase());
          
          let t1Raw = devPoints.find(s => {
            const pid = s.pointId.toLowerCase();
            return pid === 'nhiet_do_pha_1' || pid === 'temp_1' || /^(?:p|d|điểm|diem)\s*1$/i.test(pid);
          })?.value;

          let t2Raw = devPoints.find(s => {
            const pid = s.pointId.toLowerCase();
            return pid === 'nhiet_do_pha_2' || pid === 'temp_2' || /^(?:p|d|điểm|diem)\s*2$/i.test(pid);
          })?.value;

          let t3Raw = devPoints.find(s => {
            const pid = s.pointId.toLowerCase();
            return pid === 'nhiet_do_pha_3' || pid === 'temp_3' || /^(?:p|d|điểm|diem)\s*3$/i.test(pid);
          })?.value;

          let pdVal = devPoints.find(s => s.pointId === 'phong_dien' || s.pointId === 'pd')?.value ?? null;

          const t1 = t1Raw !== undefined && t1Raw !== null ? Math.round(t1Raw * 10) / 10 : null;
          const t2 = t2Raw !== undefined && t2Raw !== null ? Math.round(t2Raw * 10) / 10 : null;
          const t3 = t3Raw !== undefined && t3Raw !== null ? Math.round(t3Raw * 10) / 10 : null;

          const tempMax = t1 !== null && t2 !== null && t3 !== null ? Math.max(t1, t2, t3) : (t1 !== null ? t1 : t2 !== null ? t2 : t3 !== null ? t3 : null);
          const healthStatus = hInfo.risk || (hInfo.score >= 80 ? 'good' : hInfo.score >= 50 ? 'warning' : 'danger');
          const pdLevel = pdVal == null ? 'low' : pdVal > 50 ? 'high' : pdVal > 20 ? 'medium' : 'low';

          return {
            id: dev.id,
            name: dev.name || 'Điểm giám sát',
            type: dev.type,
            t1,
            t2,
            t3,
            tempMax,
            pdCount: pdVal == null ? null : Math.round(pdVal),
            pdLevel,
            healthScore: hInfo.score,
            healthStatus,
            urgencyReason: tempMax !== null && tempMax > 60 ? `Nhiệt độ tăng cao đạt mức ${tempMax}°C` : 'Trạng thái hoạt động bình thường.',
            trendDirection: 'stable',
            trendRate: 0.0,
            forecastDays: null,
            t1AvgThisWeek: t1 !== null ? Math.round(t1) : null,
            t1AvgLastWeek: t1 !== null ? Math.round(t1) : null,
            recommendationLevel: tempMax !== null && tempMax > 80 ? 'urgent' : tempMax !== null && tempMax > 60 ? 'monitor' : 'ok',
            recommendation: tempMax !== null && tempMax > 80 ? 'Kiểm tra siết lại bu lông các tiếp điểm ngay lập tức!' : 'Tiếp tục theo dõi vận hành.'
          };
        });
        setCabinetList(list);
      } catch (err) {
        console.warn('[Report] Lỗi tải dữ liệu giám sát:', err);
      }
    };
    fetchMonitoringPoints();
  }, [stationId]);

  useEffect(() => {
    if (type === 'daily') {
      const d = new Date(); d.setDate(d.getDate() - 1);
      setFrom(d.toISOString().split('T')[0] || '');
      setTo(new Date().toISOString().split('T')[0] || '');
      setTimePreset('custom');
    } else if (type === 'monthly') {
      const d = new Date(); d.setMonth(d.getMonth() - 1);
      setFrom(d.toISOString().split('T')[0] || '');
      setTo(new Date().toISOString().split('T')[0] || '');
      setTimePreset('custom');
    }
  }, [type]);

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const reps = await stationApi.getReports(stationId || undefined);
      setHistory(reps);
    } catch {
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, [stationId]);

  const generateReport = async () => {
    if (!from || !to) { setErrorMsg('Chọn đầy đủ ngày'); return; }
    if (new Date(from) > new Date(to)) { setErrorMsg('Ngày bắt đầu phải trước ngày kết thúc'); return; }

    setGenerating(true);
    setErrorMsg('');
    setPreviewHtml('');
    setCurrentReportId('');
    if (chartInst.current) {
      chartInst.current.destroy();
      chartInst.current = null;
    }

    try {
      const [histRaw, alertsInRange, report] = await Promise.all([
        stationApi.getHistoryBulk(stationId, `${from}T00:00`, `${to}T23:59`, 60),
        stationApi.getAlerts(undefined, undefined, undefined, 500),
        stationApi.generateReport({ stationId: stationId || undefined, type, from: `${from}T00:00:00`, to: `${to}T23:59:59` }),
      ]);

      setCurrentReportId(report.id);

      const filteredAlerts = alertsInRange.filter((a: AlertItem) => {
        const t = new Date(a.triggeredAt).getTime();
        return t >= new Date(from).getTime() && t <= new Date(`${to}T23:59:59`).getTime();
      });

      const html = buildReportHtml(histRaw, filteredAlerts);
      setPreviewHtml(html);

      if (opts.trend) {
        setTimeout(() => {
          if (chartCanvasRef.current) {
            drawInlineChart(chartCanvasRef.current, histRaw);
          }
        }, 100);
      }

      loadHistory();
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const drawInlineChart = (canvas: HTMLCanvasElement, hist: Array<{ pointId: string; time: string; value: number }>) => {
    if (chartInst.current) { chartInst.current.destroy(); }
    
    const getMappedPhase = (pid: string): string | null => {
      const lower = pid.toLowerCase();
      if (lower === 'nhiet_do_pha_1' || lower === 'temp_1') return 'nhiet_do_pha_1';
      if (lower === 'nhiet_do_pha_2' || lower === 'temp_2') return 'nhiet_do_pha_2';
      if (lower === 'nhiet_do_pha_3' || lower === 'temp_3') return 'nhiet_do_pha_3';
      if (lower === 'phong_dien' || lower === 'pd') return 'phong_dien';
      const match = lower.match(/^(?:p|d|điểm|diem)\s*(\d+)$/i);
      if (match && match[1]) {
        const num = parseInt(match[1], 10);
        if (num === 1) return 'nhiet_do_pha_1';
        if (num === 2) return 'nhiet_do_pha_2';
        if (num === 3) return 'nhiet_do_pha_3';
      }
      return null;
    };

    const datasets = POINTS.map(p => ({
      label: `${p.label} (${p.unit})`,
      data: hist
        .filter(r => getMappedPhase(r.pointId) === p.id)
        .map(r => ({ x: new Date(r.time).getTime(), y: r.value })),
      borderColor: p.color,
      backgroundColor: 'transparent',
      borderWidth: 1.5, pointRadius: 0, tension: 0.3,
      yAxisID: p.id === 'phong_dien' ? 'yPd' : 'yTemp',
    }));

    const accentColor = resolveCssVar('--admin-accent', '#3b82f6');

    chartInst.current = new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { labels: { color: '#374151', boxWidth: 12, font: { size: 10 } } } },
        scales: {
          x: { type: 'time', time: { tooltipFormat: 'dd/MM HH:mm' }, ticks: { color: '#6b7280', maxTicksLimit: 8 }, grid: { color: '#f3f4f6' } },
          yTemp: { position: 'left', ticks: { color: accentColor }, grid: { color: '#f3f4f6' }, title: { display: true, text: '°C', color: '#6b7280', font: { size: 10 } } },
          yPd: { position: 'right', ticks: { color: '#a855f7' }, grid: { display: false }, title: { display: true, text: 'dB', color: '#6b7280', font: { size: 10 } } },
        },
      } as any,
    });
  };

  const buildReportHtml = (_hist: Array<{ pointId: string; time: string; value: number }>, rangeAlerts: AlertItem[]) => {
    const fmtDate = (s: string) => new Date(s).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const typeLabels: Record<string, string> = { daily: 'BÁO CÁO VẬN HÀNH HÀNG NGÀY', monthly: 'BÁO CÁO VẬN HÀNH HÀNG THÁNG', event: 'BÁO CÁO SỰ CỐ' };

    const alarmCount  = rangeAlerts.filter(a => a.level === 'alarm').length;
    const warnCount   = rangeAlerts.filter(a => a.level === 'warning').length;
    const closedCount = rangeAlerts.filter(a => a.status === 'closed').length;

    const dangerCabs  = cabinetList.filter(c => c.healthStatus === 'danger');
    const warningCabs = cabinetList.filter(c => c.healthStatus === 'warning');
    const goodCabs    = cabinetList.filter(c => c.healthStatus === 'good');

    const statusColor  = (s: string) => s === 'danger' ? '#e02424' : s === 'warning' ? '#d97706' : '#059669';
    const statusLabel  = (s: string) => s === 'danger' ? 'NGUY HIỂM' : s === 'warning' ? 'CẢNH BÁO' : 'BÌNH THƯỜNG';
    const trendArrow   = (d: string) => d === 'rising' ? '↑' : d === 'falling' ? '↓' : '→';
    const tempColor    = (t: number | null) => t !== null && t > 80 ? '#e02424' : t !== null && t > 60 ? '#d97706' : '#059669';
    const pdColor      = (l: string) => l === 'high' ? '#e02424' : l === 'medium' ? '#d97706' : '#059669';

    const sortedCabs = [...cabinetList].sort((a, b) => b.healthScore - a.healthScore);

    return `
      <div id="rp-html-preview" style="background:#fff;color:#111;padding:28px;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;max-width:900px;margin:0 auto;box-shadow:0 0 0 1px rgba(0,0,0,0.1);">

        <!-- HEADER -->
        <div style="border-bottom:3px solid #1a56db;padding-bottom:14px;margin-bottom:20px;">
          <div style="font-size:20px;font-weight:800;color:#1a56db;">STATION MONITOR ENTERPRISE</div>
          <div style="font-size:13px;font-weight:700;margin-top:4px;text-transform:uppercase;">${typeLabels[type] ?? type}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:6px;">
            Khoảng thời gian: <b>${fmtDate(from)}</b> – <b>${fmtDate(to)}</b>
            &nbsp;|&nbsp; Tạo lúc: ${fmtDateTime(new Date().toISOString())}
          </div>
        </div>

        ${opts.stats ? `
        <!-- TỔNG QUAN TRẠM -->
        <div style="margin-bottom:20px;">
          <div style="font-weight:700;font-size:11px;text-transform:uppercase;color:#374151;margin-bottom:10px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">
            TỔNG QUAN TRẠM — ${cabinetList.length} TỦ ĐIỆN
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px;">
            ${[
              { label: 'Tổng tủ điện',   value: cabinetList.length,   color: '#1a56db' },
              { label: 'Nguy hiểm',      value: dangerCabs.length,  color: '#e02424' },
              { label: 'Cảnh báo',       value: warningCabs.length, color: '#d97706' },
              { label: 'Bình thường',    value: goodCabs.length,    color: '#059669' },
            ].map(k => `
              <div style="border:1px solid #e5e7eb;border-left:4px solid ${k.color};padding:10px;">
                <div style="font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;">${k.label}</div>
                <div style="font-size:26px;font-weight:800;color:${k.color};margin-top:2px;">${k.value}</div>
              </div>
            `).join('')}
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">
            ${[
              { label: 'Tổng cảnh báo',  value: rangeAlerts.length, color: '#1a56db' },
              { label: 'Nguy cấp',       value: alarmCount,          color: '#e02424' },
              { label: 'Cảnh báo',       value: warnCount,           color: '#d97706' },
              { label: 'Đã xử lý',       value: closedCount,         color: '#059669' },
            ].map(k => `
              <div style="border:1px solid #e5e7eb;border-left:4px solid ${k.color};padding:10px;">
                <div style="font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;">${k.label}</div>
                <div style="font-size:26px;font-weight:800;color:${k.color};margin-top:2px;">${k.value}</div>
              </div>
            `).join('')}
          </div>
        </div>` : ''}

        ${opts.sensor ? `
        <!-- CHI TIẾT TỪNG TỦ ĐIỆN -->
        <div style="margin-bottom:20px;">
          <div style="font-weight:700;font-size:11px;text-transform:uppercase;color:#374151;margin-bottom:10px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">
            CHI TIẾT TỪNG TỦ ĐIỆN
          </div>
          ${sortedCabs.map(cab => `
            <div style="border:1px solid #e5e7eb;border-left:4px solid ${statusColor(cab.healthStatus)};margin-bottom:12px;padding:14px;">
              <!-- Cabinet header -->
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <div>
                  <span style="font-size:13px;font-weight:800;color:#111;">${cab.name}</span>
                  <span style="margin-left:10px;font-size:10px;font-weight:700;color:${statusColor(cab.healthStatus)};background:${statusColor(cab.healthStatus)}18;padding:2px 8px;border-radius:2px;">
                    ${statusLabel(cab.healthStatus)}
                  </span>
                </div>
                <div style="font-size:18px;font-weight:800;color:${statusColor(cab.healthStatus)};">
                  Sức khỏe: ${cab.healthScore}%
                </div>
              </div>

              <!-- Sensor grid -->
              <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px;">
                <div style="background:#f9fafb;padding:8px;border:1px solid #e5e7eb;">
                  <div style="font-size:9px;color:#6b7280;font-weight:700;text-transform:uppercase;">T1 (Pha A)</div>
                  <div style="font-size:18px;font-weight:800;color:${tempColor(cab.t1)};">${cab.t1 !== null ? `${cab.t1}°C` : '--'}</div>
                </div>
                <div style="background:#f9fafb;padding:8px;border:1px solid #e5e7eb;">
                  <div style="font-size:9px;color:#6b7280;font-weight:700;text-transform:uppercase;">T2 (Pha B)</div>
                  <div style="font-size:18px;font-weight:800;color:${tempColor(cab.t2)};">${cab.t2 !== null ? `${cab.t2}°C` : '--'}</div>
                </div>
                <div style="background:#f9fafb;padding:8px;border:1px solid #e5e7eb;">
                  <div style="font-size:9px;color:#6b7280;font-weight:700;text-transform:uppercase;">T3 (Pha C)</div>
                  <div style="font-size:18px;font-weight:800;color:${tempColor(cab.t3)};">${cab.t3 !== null ? `${cab.t3}°C` : '--'}</div>
                </div>
                <div style="background:#f9fafb;padding:8px;border:1px solid #e5e7eb;">
                  <div style="font-size:9px;color:#6b7280;font-weight:700;text-transform:uppercase;">Phóng điện PD</div>
                  <div style="font-size:18px;font-weight:800;color:${cab.pdCount == null ? '#6b7280' : pdColor(cab.pdLevel)};">${cab.pdCount == null ? '--' : `${cab.pdCount} xung`}</div>
                </div>
              </div>

              <!-- Trend & forecast row -->
              ${cab.tempMax !== null ? `
              <div style="display:flex;gap:16px;font-size:11px;color:#374151;margin-bottom:8px;">
                <span>
                  <b>Xu hướng:</b>
                  <span style="color:${cab.trendDirection === 'rising' ? '#e02424' : cab.trendDirection === 'falling' ? '#059669' : '#6b7280'};font-weight:700;">
                    ${trendArrow(cab.trendDirection)} ${cab.trendRate > 0 ? '+' : ''}${cab.trendRate}°C/ngày
                  </span>
                </span>
                <span>
                  <b>Dự báo vượt ngưỡng:</b>
                  <span style="font-weight:700;color:${cab.forecastDays !== null && cab.forecastDays <= 7 ? '#e02424' : '#6b7280'};">
                    ${cab.forecastDays !== null ? `~${cab.forecastDays} ngày` : 'An toàn'}
                  </span>
                </span>
                <span>
                  <b>So tuần trước — T1:</b>
                  <span style="font-weight:700;color:${(cab.t1AvgThisWeek && cab.t1AvgLastWeek && cab.t1AvgThisWeek > cab.t1AvgLastWeek) ? '#e02424' : '#059669'};">
                    ${cab.t1AvgThisWeek !== null && cab.t1AvgThisWeek !== undefined ? `${cab.t1AvgThisWeek}°C` : '--'} (tuần này) / ${cab.t1AvgLastWeek !== null && cab.t1AvgLastWeek !== undefined ? `${cab.t1AvgLastWeek}°C` : '--'} (tuần trước)
                  </span>
                </span>
              </div>
              ` : ''}

              <!-- Problem & recommendation -->
              <div style="font-size:11px;color:#374151;margin-bottom:4px;">
                <b>Tình trạng:</b> ${cab.urgencyReason}
              </div>
              <div style="font-size:11px;padding:8px;background:${cab.recommendationLevel === 'urgent' ? '#fef2f2' : cab.recommendationLevel === 'monitor' ? '#fffbeb' : '#f0fdf4'};border-left:3px solid ${cab.recommendationLevel === 'urgent' ? '#e02424' : cab.recommendationLevel === 'monitor' ? '#d97706' : '#059669'};">
                <b>Khuyến nghị:</b> ${cab.recommendation}
              </div>
            </div>
          `).join('')}
        </div>` : ''}

        ${opts.trend ? `
        <!-- BIỂU ĐỒ XU HƯỚNG -->
        <div style="margin-bottom:20px;">
          <div style="font-weight:700;font-size:11px;text-transform:uppercase;color:#374151;margin-bottom:8px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">
            BIỂU ĐỒ XU HƯỚNG NHIỆT ĐỘ & PHÓNG ĐIỆN
          </div>
          <div style="position:relative;height:200px;background:#f9fafb;border:1px solid #e5e7eb;">
            <canvas id="rp-inline-chart"></canvas>
          </div>
        </div>` : ''}

        ${opts.alerts && rangeAlerts.length > 0 ? `
        <!-- DANH SÁCH CẢNH BÁO -->
        <div style="margin-bottom:20px;">
          <div style="font-weight:700;font-size:11px;text-transform:uppercase;color:#374151;margin-bottom:8px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">
            DANH SÁCH CẢNH BÁO (${Math.min(rangeAlerts.length, 30)}/${rangeAlerts.length})
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:11px;">
            <thead>
              <tr style="background:#f3f4f6;">
                <th style="padding:6px 8px;text-align:left;border:1px solid #e5e7eb;">Thời gian</th>
                <th style="padding:6px 8px;text-align:left;border:1px solid #e5e7eb;">Mô tả</th>
                <th style="padding:6px 8px;text-align:center;border:1px solid #e5e7eb;">Cấp độ</th>
                <th style="padding:6px 8px;text-align:center;border:1px solid #e5e7eb;">Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              ${[...rangeAlerts]
                .sort((a, b) => new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime())
                .slice(0, 30)
                .map((a, i) => {
                  const isAlm = a.level === 'alarm';
                  const lc = isAlm ? '#e02424' : '#d97706';
                  const lb = isAlm ? '#fee2e2' : '#fef3c7';
                  return `<tr style="background:${i % 2 === 0 ? '#fff' : '#f9fafb'};">
                    <td style="padding:5px 8px;color:#6b7280;white-space:nowrap;border:1px solid #e5e7eb;">${fmtDateTime(a.triggeredAt)}</td>
                    <td style="padding:5px 8px;border:1px solid #e5e7eb;">${a.message || '—'}</td>
                    <td style="padding:5px 8px;text-align:center;border:1px solid #e5e7eb;">
                      <span style="background:${lb};color:${lc};padding:2px 8px;font-size:10px;font-weight:700;">${a.level.toUpperCase()}</span>
                    </td>
                    <td style="padding:5px 8px;text-align:center;color:#6b7280;border:1px solid #e5e7eb;">${a.status}</td>
                  </tr>`;
                }).join('')}
            </tbody>
          </table>
        </div>` : opts.alerts ? `
        <div style="padding:12px;background:#f0fdf4;margin-bottom:20px;color:#059669;font-weight:600;border-left:3px solid #059669;">
          Không có cảnh báo nào trong kỳ báo cáo.
        </div>` : ''}

        <!-- FOOTER -->
        <div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:10px;color:#9ca3af;text-align:center;">
          Báo cáo được tạo tự động bởi Station Monitor Enterprise — ${fmtDateTime(new Date().toISOString())}
        </div>
      </div>
    `;
  };

  const printReport = () => {
    if (!previewHtml) { alert('Tạo báo cáo trước'); return; }
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) return;
    
    // Create an offline copy of the chart for printing since canvas isn't serialized in outerHTML
    let html = previewHtml;
    if (chartInst.current && chartCanvasRef.current) {
      const img = chartInst.current.toBase64Image();
      html = html.replace('<canvas id="rp-inline-chart"></canvas>', `<img src="${img}" style="width:100%;height:100%;object-fit:contain;" />`);
    }

    win.document.write(`<!DOCTYPE html><html><head><title>Báo cáo Station Monitor</title><style>body { margin: 0; font-family: 'Segoe UI', Arial, sans-serif; } @media print { body { margin: 0; } }</style></head><body>${html}</body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 400);
  };

  const downloadServer = () => {
    if (!currentReportId) return;
    const typeNameMap: Record<string, string> = { daily: 'Ngay', monthly: 'Thang', event: 'SuCo' };
    const typeName = typeNameMap[type] || type;
    const url = stationApi.getDownloadUrl(currentReportId);
    const a = document.createElement('a');
    a.href = url;
    a.download = `BaoCao_${typeName}_${from}_den_${to}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const deleteReport = async (id: string) => {
    if (!await confirmDialog({ title: 'Xóa báo cáo', message: 'Xóa báo cáo này?', danger: true })) return;
    await stationApi.deleteReport(id).catch(() => {});
    loadHistory();
  };

  return (
    <div style={{ flex: 1, display: 'flex', gap: 8, overflow: 'hidden', height: '100%' }}>
      {/* Configuration Sidebar Card */}
      <div className="admin-card" style={{ width: 300, flexShrink: 0, background: 'var(--admin-card-bg, var(--admin-panel))', border: '1px solid var(--admin-border, var(--admin-border))', overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16, borderRadius: 0 }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--admin-text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em' }}>Cấu hình báo cáo</div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: '0.75rem', color: 'var(--admin-text-muted)', fontWeight: 600 }}>Loại báo cáo</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[
              { val: 'daily', icon: '', lbl: 'Báo cáo hàng ngày' },
              { val: 'monthly', icon: '', lbl: 'Báo cáo hàng tháng' },
              { val: 'event', icon: '', lbl: 'Báo cáo sự cố' }
            ].map(r => (
              <label key={r.val} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '8px 10px', borderRadius: 0, border: `1px solid ${type === r.val ? 'var(--admin-accent)' : 'var(--admin-border)'}`, background: type === r.val ? 'rgba(37,99,235,0.1)' : 'transparent', fontSize: '0.78rem', color: 'var(--admin-text-muted)' }}>
                <input type="radio" checked={type === r.val} onChange={() => setType(r.val as ReportType)} style={{ accentColor: 'var(--admin-accent)' }} />
                {r.icon} {r.lbl}
              </label>
            ))}
          </div>
        </div>

        <DateRangeToolbar
          label="LỌC NGÀY"
          preset={timePreset}
          from={from}
          to={to}
          onPresetChange={preset => {
            setTimePreset(preset);
            const now = new Date();
            const start = new Date();
            if (preset === 'today') {
              const d = now.toISOString().split('T')[0] || '';
              setFrom(d);
              setTo(d);
            } else if (preset === 'yesterday') {
              start.setDate(now.getDate() - 1);
              now.setDate(now.getDate() - 1);
              setFrom(start.toISOString().split('T')[0] || '');
              setTo(now.toISOString().split('T')[0] || '');
            } else if (preset === '7d') {
              start.setDate(now.getDate() - 7);
              setFrom(start.toISOString().split('T')[0] || '');
              setTo(now.toISOString().split('T')[0] || '');
            } else if (preset === '30d') {
              start.setDate(now.getDate() - 30);
              setFrom(start.toISOString().split('T')[0] || '');
              setTo(now.toISOString().split('T')[0] || '');
            } else if (preset === 'all') {
              setFrom('');
              setTo('');
            }
          }}
          onFromChange={setFrom}
          onToChange={setTo}
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: '0.75rem', color: 'var(--admin-text-muted)', fontWeight: 600 }}>Nội dung</label>
          {[
            { id: 'stats', lbl: 'Thống kê cảnh báo (KPI)' },
            { id: 'trend', lbl: 'Biểu đồ xu hướng nhiệt độ' },
            { id: 'alerts', lbl: 'Danh sách sự kiện' },
            { id: 'pd', lbl: 'Phân tích phóng điện PD' },
            { id: 'sensor', lbl: 'Bảng thống kê cảm biến' },
          ].map(opt => (
            <label key={opt.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.78rem', color: 'var(--admin-text-muted)', padding: '3px 0' }}>
              <input type="checkbox" checked={(opts as any)[opt.id]} onChange={e => setOpts({ ...opts, [opt.id]: e.target.checked })} style={{ accentColor: 'var(--admin-accent)' }} />
              {opt.lbl}
            </label>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
          <button onClick={generateReport} disabled={generating} style={{ padding: 10, background: 'var(--admin-accent)', border: 'none', borderRadius: 0, color: 'var(--admin-text)', fontSize: '0.8rem', fontWeight: 700, cursor: generating ? 'not-allowed' : 'pointer' }}>
            {generating ? '⏳ Đang tạo...' : 'Tạo báo cáo'}
          </button>
          <button onClick={downloadServer} disabled={!currentReportId} style={{ padding: 9, background: 'var(--admin-btn-secondary-bg)', border: '1px solid var(--admin-border)', borderRadius: 0, color: 'var(--admin-text-muted)', fontSize: '0.78rem', fontWeight: 700, cursor: currentReportId ? 'pointer' : 'not-allowed', opacity: currentReportId ? 1 : 0.5 }}>
            Tải PDF (từ server)
          </button>
          <button onClick={printReport} disabled={!previewHtml} style={{ padding: 9, background: 'var(--admin-btn-secondary-bg)', border: '1px solid var(--admin-border)', borderRadius: 0, color: 'var(--admin-text-muted)', fontSize: '0.78rem', fontWeight: 700, cursor: previewHtml ? 'pointer' : 'not-allowed', opacity: previewHtml ? 1 : 0.5 }}>
            In / Lưu PDF (trình duyệt)
          </button>
        </div>

        {errorMsg && <div style={{ fontSize: '0.7rem', color: 'var(--admin-danger)', padding: 10, background: 'var(--admin-panel)', borderRadius: 0, border: '1px solid var(--admin-border)' }}>{errorMsg}</div>}

        <div style={{ borderTop: '1px solid var(--admin-border)', paddingTop: 14 }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--admin-text-muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 10 }}>Lịch sử báo cáo</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
            {historyLoading ? <div style={{ fontSize: '0.72rem', color: 'var(--admin-border)' }}>Đang tải...</div> : history.length === 0 ? <div style={{ fontSize: '0.72rem', color: 'var(--admin-border)' }}>Chưa có báo cáo nào</div> : history.slice(0, 20).map(r => {
              const typeLabels: Record<string, string> = { daily: 'Hàng ngày', monthly: 'Hàng tháng', event: 'Sự cố' };
              const typeColors: Record<string, string> = { daily: 'var(--admin-accent)', monthly: 'var(--admin-success)', event: 'var(--admin-warning)' };
              const tFrom = r.periodFrom ? new Date(r.periodFrom).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }) : '';
              const tTo = r.periodTo ? new Date(r.periodTo).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }) : '';
              const color = typeColors[r.type] ?? 'var(--admin-text-muted)';
              return (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', background: 'var(--admin-panel)', borderRadius: 0, border: '1px solid var(--admin-border)' }}>
                  <span style={{ fontSize: '0.62rem', padding: '2px 6px', borderRadius: 0, background: `${color}22`, color: color, fontWeight: 700, whiteSpace: 'nowrap' }}>{typeLabels[r.type] ?? r.type}</span>
                  <span style={{ flex: 1, fontSize: '0.7rem', color: 'var(--admin-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tFrom}{tTo && tTo !== tFrom ? ' – ' + tTo : ''}</span>
                  {r.fileUrl && (
                    <button onClick={() => {
                      const typeFileMap: Record<string, string> = { daily: 'Ngay', monthly: 'Thang', event: 'SuCo' };
                      const typeFile = typeFileMap[r.type] || r.type;
                      const dateFrom = r.periodFrom ? new Date(r.periodFrom).toISOString().split('T')[0] : '';
                      const dateTo = r.periodTo ? new Date(r.periodTo).toISOString().split('T')[0] : '';
                      const url = stationApi.getDownloadUrl(r.id);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `BaoCao_${typeFile}_${dateFrom}${dateTo && dateTo !== dateFrom ? '_den_' + dateTo : ''}.pdf`;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                    }} style={{ padding: '2px 7px', background: 'var(--admin-btn-secondary-bg)', border: '1px solid var(--admin-accent)', borderRadius: 0, color: 'var(--admin-btn-secondary-text)', fontSize: '0.65rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>⬇</button>
                  )}
                  <button onClick={() => deleteReport(r.id)} style={{ padding: '2px 7px', background: 'transparent', border: '1px solid var(--admin-border)', borderRadius: 0, color: 'var(--admin-text-muted)', fontSize: '0.65rem', cursor: 'pointer' }}>🗑</button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Preview Section Card */}
      <div className="admin-card" style={{ flex: 1, overflow: 'auto', padding: '24px 28px', background: 'var(--admin-panel)', border: '1px solid var(--admin-border, var(--admin-border))', borderRadius: 0 }}>
        {previewHtml ? (
          <div dangerouslySetInnerHTML={{ __html: previewHtml }}></div>
        ) : generating ? (
          <div style={{ minHeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
            <span style={{ fontSize: '2rem', marginBottom: 12 }}>⏳</span>
            <span style={{ color: 'var(--admin-text-muted)', fontSize: '0.85rem' }}>Đang tổng hợp dữ liệu và tạo báo cáo...</span>
          </div>
        ) : (
          <div style={{ minHeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
            <span style={{ fontSize: '3rem', opacity: 0.15 }}></span>
            <span style={{ color: 'var(--admin-border)', fontSize: '0.85rem' }}>Nhấn "Tạo báo cáo" để xem trước</span>
          </div>
        )}
      </div>

      {/* Hidden canvas for chart generation if needed inside dangerouslySetInnerHTML */}
      <div style={{ display: 'none' }}><canvas ref={chartCanvasRef} id="rp-inline-chart"></canvas></div>
    </div>
  );
}
