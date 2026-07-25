import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import Chart from 'chart.js/auto';
import { getCSSColor } from '@/utils/theme-colors';
import { AI_ENGINE_URL, GO2RTC_URL } from '@/utils/env';
import { stationApi } from '@/services/StationApiService';
import { RotateCw } from 'lucide-react';
import ToolbarSelect from '@/components/ui/ToolbarSelect';
import * as XLSX from 'xlsx';

interface HistoryPoint {
  timestamp: string;
  [key: string]: number | null | string;
}

interface ExportFns { xlsx: () => void; csv: () => void; pdf: () => void; }

interface ThermalForecastTabProps {
  fromDate: string;
  toDate: string;
  registerExport?: (fns: ExportFns | null) => void;
}

// Helper for natural sorting (Point 1, Point 2, Point 10)
const naturalSort = (a: string, b: string) => {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
};

export default function ThermalForecastTab({ fromDate, toDate, registerExport }: ThermalForecastTabProps) {
  const [cameras, setCameras] = useState<any[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<any>(null);
  const [modelStatus, setModelStatus] = useState({ status: 'Idle', last_updated: 'Chưa nhận dữ liệu từ Jetson', jetson_connected: false });
  const [targets, setTargets] = useState<string[]>([]);
  const [historyData, setHistoryData] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [chartLoading, setChartLoading] = useState(false);
  const [activeFilters, setActiveFilters] = useState<Record<string, boolean>>({});

  const [roiPoints, setRoiPoints] = useState<any[]>([]);
  const [boundaries, setBoundaries] = useState<any[]>([]);

  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInst = useRef<Chart | null>(null);

  // Robust Thermal Stream ID selection
  const thSrc = useMemo(() => {
    if (!selectedCamera) return null;
    const c = selectedCamera.config || {};
    return c.go2rtc_thermal || c.go2rtc_id || `cam_${(c.ip || '').replace(/\./g, '_')}_thermal`;
  }, [selectedCamera]);

  const isOutdoorThermalCamera = useMemo(() => {
    if (!selectedCamera) return false;
    const type = String(selectedCamera.type || '').toLowerCase();
    const mountType = String(selectedCamera.config?.mountType || '').toLowerCase();
    return (type === 'camera_thermal' || type === 'camera_dual') && mountType === 'outdoor';
  }, [selectedCamera]);

  const normalizeTargetKey = (s: string) => (s || '').normalize('NFC').toLowerCase().trim().replace(/[\s_]/g, '');
  const asciiTargetKey = (s: string) => normalizeTargetKey(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const canonicalTargetKey = (s: string) => asciiTargetKey(s).replace(/^(diem|point)/, '').replace(/^([dp])(?=\d)/, '');
  const formatPointLabel = (s: string) => {
    const raw = (s || '').trim();
    const noPrefix = raw.replace(/^(Điểm|Point|P|D)\s*/gi, '').replace(/^\s+|\s+$/g, '');
    if (!noPrefix) return raw;
    if (/^\d+$/.test(noPrefix)) return `Điểm ${noPrefix}`;
    return raw.startsWith('Điểm') ? raw : `Điểm ${noPrefix}`;
  };

  const visibleTargets = useMemo(() => {
    const seen = new Map<string, string>();
    targets.forEach(target => {
      const key = canonicalTargetKey(target);
      const current = seen.get(key);
      if (!current) {
        seen.set(key, target);
        return;
      }

      const currentScore = /diem|point|vung|zone/.test(asciiTargetKey(current)) ? 2 : 1;
      const nextScore = /diem|point|vung|zone/.test(asciiTargetKey(target)) ? 2 : 1;
      if (nextScore > currentScore || (nextScore === currentScore && target.length > current.length)) {
        seen.set(key, target);
      }
    });
    return [...seen.values()];
  }, [targets]);

  // Filter targets based on selected camera
  const filteredTargets = useMemo(() => {
    if (!selectedCamera || visibleTargets.length === 0) return [];
    const camTargetNames = new Set<string>();

    roiPoints.forEach(p => {
      if (p.name) camTargetNames.add(normalizeTargetKey(p.name));
      if (p.pointId) camTargetNames.add(normalizeTargetKey(p.pointId));
    });
    boundaries.forEach(b => {
      if (b.name) camTargetNames.add(normalizeTargetKey(b.name));
    });

    return visibleTargets.filter(t => {
      const nt = normalizeTargetKey(t);
      return camTargetNames.has(nt);
    });
  }, [selectedCamera, visibleTargets, roiPoints, boundaries]);

  // Derive timestamps for the footer
  const liveTime = useMemo(() => {
    if (historyData.length === 0 || visibleTargets.length === 0) return null;
    for (let i = historyData.length - 1; i >= 0; i--) {
      const item = historyData[i];
      const hasAnyActual = item ? visibleTargets.some(t => item[`${t}_actual`] !== null && item[`${t}_actual`] !== undefined && item[`${t}_actual`] !== '') : false;
      if (hasAnyActual && item) return item.timestamp;
    }
    return null;
  }, [historyData, visibleTargets]);

  const forecastTime = useMemo(() => {
    if (!modelStatus.jetson_connected) return null;
    if (historyData.length === 0 || visibleTargets.length === 0) return null;
    // Tìm mốc thời gian của dự báo mới nhất có dữ liệu (quét từ cuối lên)
    for (let i = historyData.length - 1; i >= 0; i--) {
      const item = historyData[i];
      if (item) {
        const hasAnyPred = visibleTargets.some(t => item[`${t}_pred`] !== null && item[`${t}_pred`] !== undefined && item[`${t}_pred`] !== '');
        if (hasAnyPred) {
          return item.timestamp;
        }
      }
    }
    return null;
  }, [historyData, visibleTargets, modelStatus.jetson_connected]);

  const buildDateList = (from: string, to: string) => {
    if (!from || !to) return [new Date().toISOString().split('T')[0] || ''];
    const start = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    if (start > end) return [to];
    const days: string[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      days.push(cursor.toISOString().split('T')[0] || '');
      cursor.setDate(cursor.getDate() + 1);
    }
    return days.filter(Boolean);
  };

  const updateStatusAndHistory = useCallback(async (showChartSpinner = true) => {
    try {
      if (showChartSpinner) setChartLoading(true);
      const devId = selectedCamera?.id || '';
      const [statusResp, configResp] = await Promise.all([
        fetch(`${AI_ENGINE_URL}/api/training-status?device_id=${devId}`),
        fetch(`${AI_ENGINE_URL}/api/config?device_id=${devId}`)
      ]);
      const statusData = await statusResp.json();
      const configData = await configResp.json();

      setModelStatus(statusData);
      
      const activeTargets = configData.targets || [];
      if (JSON.stringify(activeTargets) !== JSON.stringify(targets)) {
        setTargets(activeTargets);
        setActiveFilters(prev => {
          const updated = { ...prev };
          activeTargets.forEach((t: string, idx: number) => {
            if (updated[t] === undefined) {
              updated[t] = idx < 2; // Bật mặc định tối đa 2 targets đầu tiên để tránh chằng chịt
            }
          });
          return updated;
        });
      }

      const days = buildDateList(fromDate, toDate);
      const histories = await Promise.all(days.map(async date => {
        const resp = await fetch(`${AI_ENGINE_URL}/api/prediction/history?points=1440&date=${date}&device_id=${devId}`);
        const data = await resp.json();
        return data.success ? data.history : [];
      }));
      const merged = histories.flat().sort((a: any, b: any) => {
        const ta = new Date(a.full_ts || a.timestamp || 0).getTime();
        const tb = new Date(b.full_ts || b.timestamp || 0).getTime();
        return ta - tb;
      });
      setHistoryData(merged);
    } catch (err) {
      console.warn('[AI Forecast] Polling failed:', err);
    } finally {
      if (showChartSpinner) setChartLoading(false);
    }
  }, [selectedCamera, fromDate, toDate, targets]);

  // Fetch ROI Points & Boundaries
  useEffect(() => {
    if (!selectedCamera) return;
    const fetchOverlayData = async () => {
      try {
        const [pts, bounds] = await Promise.all([
          stationApi.getRoiPoints(selectedCamera.id),
          stationApi.getBoundaries(selectedCamera.id, 'roi')
        ]);
        setRoiPoints(pts);
        setBoundaries(bounds);
      } catch (err) {
        console.warn('[AI Forecast] Failed to fetch overlay metadata:', err);
      }
    };
    fetchOverlayData();
  }, [selectedCamera]);

  // Load cameras
  useEffect(() => {
    const initData = async () => {
      try {
        setLoading(true);
        const savedStationId = localStorage.getItem('selected_station_id');
        let activeStationId = savedStationId;
        if (!activeStationId) {
          const stations = await stationApi.getStations();
          activeStationId = stations[0]?.id ?? null;
        }

        if (activeStationId) {
          const devs = await stationApi.getDevices(activeStationId);
          const filtered = devs.filter(d => {
            const type = (d.type || '').toLowerCase().trim();
            const hasThermal = !!(d.config?.go2rtc_thermal || d.config?.rtsp_thermal);
            return type === 'camera_thermal' || type === 'camera_dual' || hasThermal;
          });
          setCameras(filtered);
          if (filtered.length > 0) {
            const thermalCam = filtered.find(c => c.name?.toLowerCase().includes('thermal') || c.config?.go2rtc_thermal);
            setSelectedCamera(thermalCam || filtered[0]);
          }
        }
      } catch (err) {
        console.error('[AI Forecast] Error loading configuration:', err);
      } finally {
        setLoading(false);
      }
    };
    initData();
  }, []);

  useEffect(() => {
    setTargets([]);
    setHistoryData([]);
    setRoiPoints([]);
    setBoundaries([]);
    setActiveFilters({});
  }, [selectedCamera?.id]);

  useEffect(() => {
    updateStatusAndHistory(true);
    const timer = setInterval(() => { updateStatusAndHistory(false); }, 10000);
    return () => clearInterval(timer);
  }, [selectedCamera?.id, fromDate, toDate]);

  // Chart Effect
  useEffect(() => {
    if (!chartRef.current || historyData.length === 0) return;
    chartInst.current?.destroy();
    const xLabels = historyData.map(h => {
      if (!h.full_ts) return h.timestamp;
      const parts = String(h.full_ts).split(' ');
      if (parts.length < 2) return h.timestamp;
      const datePart = parts[0];
      const timePart = parts[1];
      if (!datePart || !timePart) return h.timestamp;
      const dateParts = datePart.split('-');
      if (dateParts.length < 3) return h.timestamp;
      const year = dateParts[0];
      const month = dateParts[1];
      const day = dateParts[2];
      if (!year || !month || !day) return h.timestamp;
      const now = new Date();
      const isToday = now.getFullYear() === parseInt(year) && (now.getMonth() + 1) === parseInt(month) && now.getDate() === parseInt(day);
      return isToday ? timePart : `${day}/${month} ${timePart}`;
    });

    const targetColors = [
      { actual: '#3B82F6', pred: '#93C5FD' }, { actual: '#10B981', pred: '#6EE7B7' },
      { actual: '#F59E0B', pred: '#FCD34D' }, { actual: '#EF4444', pred: '#FCA5A5' },
      { actual: '#8B5CF6', pred: '#C4B5FD' }, { actual: '#EC4899', pred: '#FBCFE8' },
      { actual: '#14B8A6', pred: '#99F6E4' }, { actual: '#F97316', pred: '#FED7AA' },
    ];
    const datasets: any[] = [];
    let currentIdx = 0;
    if (historyData.length > 0 && visibleTargets.length > 0) {
      for (let i = historyData.length - 1; i >= 0; i--) {
        const item = historyData[i];
        if (item && !item.is_future && visibleTargets.some(t => item[`${t}_actual`] !== null)) {
          currentIdx = i; break;
        }
      }
    }

    visibleTargets.forEach((target, i) => {
      if (activeFilters[target] === false) return;
      const colors = targetColors[i % targetColors.length] || { actual: '#3B82F6', pred: '#93C5FD' };
      
      datasets.push({
        label: `${target} (Thực tế)`, 
        data: historyData.map(h => h[`${target}_actual`]), 
        borderColor: colors.actual, 
        borderWidth: 2,
        tension: 0.3, 
        pointRadius: 0, 
        pointHoverRadius: 4,
        pointBackgroundColor: colors.actual, 
        spanGaps: true, 
      });

      if (!isOutdoorThermalCamera && modelStatus.jetson_connected) {
        datasets.push({
          label: `${target} (Dự báo)`, 
          data: historyData.map(h => h[`${target}_pred`]), 
          borderColor: colors.pred, 
          borderWidth: 1.5,
          borderDash: [5, 5], 
          tension: 0.3, 
          pointRadius: 0, 
          spanGaps: true,
        });
      }
    });

    const currentLinePlugin = {
      id: 'currentLine',
      afterDraw: (chart: any) => {
        const ctx = chart.ctx; const xAxis = chart.scales.x; const yAxis = chart.scales.y;
        const xPos = xAxis.getPixelForTick(currentIdx); if (!xPos) return;
        ctx.save(); ctx.beginPath(); ctx.strokeStyle = '#ffff00'; ctx.lineWidth = 2; ctx.setLineDash([4, 2]);
        ctx.moveTo(xPos, yAxis.top); ctx.lineTo(xPos, yAxis.bottom); ctx.stroke();
        ctx.fillStyle = '#ffff00'; ctx.font = 'bold 11px monospace'; ctx.fillText('● HIỆN TẠI', xPos - 30, yAxis.top - 8); ctx.restore();
      }
    };

    chartInst.current = new Chart(chartRef.current, {
      type: 'line', data: { labels: xLabels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { backgroundColor: getCSSColor('--admin-panel'), titleColor: getCSSColor('--admin-text'), bodyColor: getCSSColor('--admin-text-muted'), borderColor: getCSSColor('--admin-border'), borderWidth: 1, callbacks: { label: (context: any) => ` ${context.dataset.label}: ${context.parsed.y?.toFixed(1)}°C` } } },
        scales: {
          x: {
            grid: { color: getCSSColor('--admin-border'), drawTicks: false },
            ticks: { color: getCSSColor('--admin-text-muted'), font: { size: 9, family: 'Consolas' }, autoSkip: true, maxRotation: 0, maxTicksLimit: 10 }
          },
          y: {
            grid: { color: getCSSColor('--admin-border') }, ticks: { color: getCSSColor('--admin-text-muted'), font: { size: 9, family: 'Consolas' }, callback: (v: any) => `${v}°C` },
            suggestedMin: 25, suggestedMax: 35
          }
        }
      },
      plugins: [currentLinePlugin]
    });
    return () => chartInst.current?.destroy();
  }, [historyData, visibleTargets, activeFilters, isOutdoorThermalCamera, modelStatus.jetson_connected]);

  const latestReadings = useMemo(() => {
    if (historyData.length === 0 || visibleTargets.length === 0) return {};
    const readings: Record<string, { actual: number; hasActual: boolean; pred: number; hasPred: boolean }> = {};
    const targetMap: Record<string, string> = {};
    visibleTargets.forEach(t => { targetMap[normalizeTargetKey(t)] = t; });


// Map each target to its latest reading
visibleTargets.forEach(t => {
  let actualVal: number | null = null;
  let currentIdx = historyData.length - 1;
  for (let i = historyData.length - 1; i >= 0; i--) {
    const item = historyData[i];
    if (item && item[`${t}_actual`] != null && item[`${t}_actual`] !== '') {
      actualVal = Number(item[`${t}_actual`]);
      currentIdx = i;
      break;
    }
  }
  let predVal: number | null = null;
  // Tìm giá trị dự báo mới nhất có trong lịch sử (quét từ cuối lên)
  for (let i = historyData.length - 1; i >= 0; i--) {
    const item = historyData[i];
    if (item && item[`${t}_pred`] != null && item[`${t}_pred`] !== '') {
      // Chỉ chấp nhận nếu dự báo nằm ở tương lai hoặc không cũ quá 10 phút so với thời điểm hiện tại
      if (i >= currentIdx - 10) {
        if (modelStatus.jetson_connected) predVal = Number(item[`${t}_pred`]);
      }
      break;
    }
  }
  readings[t] = { actual: actualVal ?? 0.0, hasActual: actualVal != null, pred: predVal ?? 0.0, hasPred: predVal != null };
});

    const aliasedReadings: Record<string, any> = { ...readings };
    roiPoints.forEach(p => {
       const np = normalizeTargetKey(p.name || '');
       const nid = normalizeTargetKey(p.pointId || '');
       const match = targetMap[np] || targetMap[nid];
       if (match && readings[match]) aliasedReadings[p.name || p.pointId] = readings[match];
    });
    boundaries.forEach(b => {
       const nb = normalizeTargetKey(b.name || '');
       const match = targetMap[nb];
       if (match && readings[match]) aliasedReadings[b.name] = readings[match];
    });

    return aliasedReadings;
  }, [historyData, visibleTargets, roiPoints, boundaries, modelStatus.jetson_connected]);

  useEffect(() => {
    if (!registerExport) return;
    if (historyData.length === 0) { registerExport(null); return; }

    const fmt = (v: any) => v != null && v !== '' ? Number(v).toFixed(1) : '';

    // Headers UTF-8 cho XLSX/CSV; ASCII cho PDF
    const hdrsUtf  = ['Thoi gian', ...targets.flatMap(t => [`${t} (thuc te)`, `${t} (du bao)`])];
    const hdrsPdf  = ['Thoi gian', ...targets.flatMap(t => [t + ' (TT)', t + ' (DB)'])];

    // Chỉ lấy dòng có ít nhất 1 giá trị thực tế
    const rows = historyData
      .filter(h => targets.some(t => h[`${t}_actual`] != null && h[`${t}_actual`] !== ''))
      .map(h => {
        const row: Record<string, string> = { 'Thoi gian': String(h.full_ts || h.timestamp) };
        targets.forEach(t => {
          row[`${t} (thuc te)`] = fmt(h[`${t}_actual`]);
          row[`${t} (du bao)`]  = fmt(h[`${t}_pred`]);
        });
        return row;
      });

    const fname = `Du_lieu_nhiet_do_${new Date().toISOString().slice(0, 10)}`;

    const xlsx = () => {
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = hdrsUtf.map(() => ({ wch: 16 }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Nhiet do');
      XLSX.writeFile(wb, `${fname}.xlsx`);
    };

    const csv = () => {
      const text = [hdrsUtf.join(','), ...rows.map(r => hdrsUtf.map(h => `"${(r[h] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8;' }));
      a.download = `${fname}.csv`; a.click();
    };

    const pdf = () => {
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Dữ liệu nhiệt độ</title>
<style>body{font-family:Arial,'Segoe UI',sans-serif;font-size:9pt;margin:20px}h1{font-size:13pt;font-weight:900;letter-spacing:2px;margin-bottom:4px}.sub{font-size:8pt;color:#555;margin-bottom:12px}table{width:100%;border-collapse:collapse}th{background:#1e293b;color:#fff;padding:5px 6px;font-size:7pt;text-align:left;border:1px solid #334155}td{border:1px solid #cbd5e1;padding:3px 6px;font-size:7pt}tr:nth-child(even) td{background:#f8fafc}@page{size:A4 landscape;margin:12mm}</style>
</head><body>
<h1>DỮ LIỆU NHIỆT ĐỘ</h1>
<div class="sub">Xuất ngày ${new Date().toISOString().slice(0,10)} — ${rows.length} dòng</div>
<table><thead><tr>${hdrsUtf.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
<tbody>${rows.map(r=>`<tr>${hdrsUtf.map(h=>`<td>${r[h]??''}</td>`).join('')}</tr>`).join('')}</tbody>
</table></body></html>`;
      const win = window.open('', '_blank');
      if (win) { win.document.write(html); win.document.close(); win.focus(); win.print(); }
    };

    registerExport({ xlsx, csv, pdf });
    return () => registerExport(null);
  }, [historyData, targets, registerExport]);

  const toggleFilter = (t: string) => setActiveFilters(prev => ({ ...prev, [t]: !prev[t] }));
  const metricGridCols = isOutdoorThermalCamera ? '1fr 60px' : '1fr 60px 60px';

  if (loading) return (
    <div style={{ display: 'flex', flex: 1, height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-muted)', gap: 10, background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)' }}>
      <RotateCw size={18} className="animate-spin" color="var(--admin-accent)" />
      <span style={{ fontSize: '.8rem', fontFamily: 'monospace' }}>ĐANG ĐỒNG BỘ CẤU HÌNH AI...</span>
      <style dangerouslySetInnerHTML={{ __html: `.animate-spin { animation: spin 1.2s linear infinite; } @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }` }} />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12, overflow: 'hidden' }}>
      
      <div style={{ display: 'flex', flex: 1, gap: 12, overflow: 'hidden', minHeight: 0 }}>
        {/* SIDEBAR */}
        <div style={{ width: 340, flexShrink: 0, height: '100%', display: 'grid', gridTemplateRows: 'auto 1fr', gap: 12, overflow: 'hidden', minHeight: 0 }}>
          
          {/* STREAM CARD */}
          <div style={{ background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', borderRadius: 0, overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--admin-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--admin-layer-1)' }}>
              <span style={{ fontSize: '.6rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>LUỒNG NHIỆT TRỰC TIẾP</span>
              {cameras.length > 1 && (
                <ToolbarSelect
                  value={selectedCamera?.id || ''}
                  onChange={(id) => setSelectedCamera(cameras.find(c => c.id === id))}
                  options={cameras.map(c => ({ value: c.id, label: c.name }))}
                  width={160}
                />
              )}
            </div>
            <div style={{ aspectRatio: '16/9', background: '#000', position: 'relative', overflow: 'hidden' }}>
              {thSrc ? (
                <>
                  <iframe src={`/camera-stream.html?src=${encodeURIComponent(thSrc)}&mode=webrtc&go2rtc=${encodeURIComponent(GO2RTC_URL)}`} style={{ width: '100%', height: '100%', border: 'none' }} />
                  <div style={{ position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none' }}>
                    {boundaries.map(b => {
                      const r = latestReadings[b.name] || { actual: 0, hasActual: false, pred: 0, hasPred: false };
                      let pts = []; try { pts = JSON.parse(b.polygon); } catch { return null; }
                      if (pts.length < 2) return null;
                      const x1 = Math.min(...pts.map((p: any) => p[0])), y1 = Math.min(...pts.map((p: any) => p[1]));
                      const x2 = Math.max(...pts.map((p: any) => p[0])), y2 = Math.max(...pts.map((p: any) => p[1]));
                      const cx = pts.reduce((s: any, p: any) => s + p[0], 0) / pts.length;
                      const cy = pts.reduce((s: any, p: any) => s + p[1], 0) / pts.length;
                      const temp = r.hasActual ? r.actual : 0; const color = temp >= 70 ? '#EF4444' : temp >= 50 ? '#F59E0B' : '#10B981';
                      return (
                        <div key={b.id}>
                          <div style={{ position: 'absolute', left: `${x1 * 100}%`, top: `${y1 * 100}%`, width: `${(x2 - x1) * 100}%`, height: `${(y2 - y1) * 100}%`, border: `1.5px solid ${color}`, background: `${color}11` }} />
                          <div style={{ position: 'absolute', left: `${cx * 100}%`, top: `${cy * 100}%`, transform: 'translate(-50%, -50%)', background: 'rgba(0,0,0,0.8)', padding: '2px 6px', borderRadius: 2, color: '#fff', fontSize: 9, whiteSpace: 'nowrap', display: 'flex', flexDirection: 'column', alignItems: 'center', zIndex: 12 }}>
                            <span style={{ fontWeight: 800, fontSize: 8, opacity: 0.8 }}>{b.name.replace(/Vùng\s*/gi, 'V').replace(/Zone\s*/gi, 'V')}</span>
                            <span style={{ fontWeight: 900, color }}>
                              {r.hasActual ? `${r.actual.toFixed(1)}°` : '--'}
                              {!isOutdoorThermalCamera && (
                                <> / <span style={{ color: 'var(--admin-accent)' }}>{r.hasPred ? `${r.pred.toFixed(1)}°` : '---'}</span></>
                              )}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                    {roiPoints.map(p => {
                      const r = latestReadings[p.name] || latestReadings[p.pointId] || { actual: 0, hasActual: false, pred: 0, hasPred: false };
                      const temp = r.hasActual ? r.actual : 0; const color = temp >= 70 ? '#EF4444' : temp >= 50 ? '#F59E0B' : '#10B981';
                      return (
                        <div key={p.id} style={{ position: 'absolute', left: `${p.tx * 100}%`, top: `${p.ty * 100}%`, transform: 'translate(-50%, -50%)' }}>
                          <div style={{ position: 'absolute', width: 14, height: 1.5, background: color, left: -7 }} /><div style={{ position: 'absolute', height: 14, width: 1.5, background: color, top: -7 }} />
                          <div style={{ position: 'absolute', left: 10, top: -10, background: 'rgba(0,0,0,0.75)', padding: '2px 5px', borderRadius: 0, display: 'flex', flexDirection: 'column', whiteSpace: 'nowrap' }}>
                             <span style={{ fontSize: 8, color: 'var(--admin-text-muted)', fontWeight: 700 }}>{formatPointLabel(p.pointId || p.name || '')}</span>
                             <span style={{ fontSize: 10, fontWeight: 800, color }}>
                               {r.hasActual ? `${r.actual.toFixed(1)}°` : '--'}
                               {!isOutdoorThermalCamera && (
                                 <> / <span style={{ color: 'var(--admin-accent)' }}>{r.hasPred ? `${r.pred.toFixed(1)}°` : '---'}</span></>
                               )}
                             </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-muted)', fontSize: '.65rem' }}>KHÔNG CÓ LUỒNG</div>}
            </div>
          </div>

          {/* STATS CARD */}
          <div style={{ flex: 1, background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', borderRadius: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--admin-border)', background: 'var(--admin-layer-1)', fontSize: '.6rem', fontWeight: 800, color: 'var(--admin-text-muted)' }}>CHỈ SỐ THỰC TẾ & AI DỰ BÁO</div>
            <div style={{ display: 'flex', gap: 10, padding: '6px 12px', background: 'var(--admin-layer-2)', borderBottom: '1px solid var(--admin-border)' }}>
              <button 
                onClick={() => {
                  const updated: Record<string, boolean> = {};
                  visibleTargets.forEach(t => updated[t] = true);
                  setActiveFilters(updated);
                }}
                style={{ background: 'transparent', border: 'none', color: 'var(--admin-accent)', fontSize: '.55rem', cursor: 'pointer', padding: 0, fontWeight: 800, letterSpacing: '0.3px' }}
              >
                CHỌN TẤT CẢ
              </button>
              <span style={{ color: 'var(--admin-border)', fontSize: '.55rem' }}>|</span>
              <button 
                onClick={() => {
                  const updated: Record<string, boolean> = {};
                  visibleTargets.forEach(t => updated[t] = false);
                  setActiveFilters(updated);
                }}
                style={{ background: 'transparent', border: 'none', color: 'var(--admin-text-muted)', fontSize: '.55rem', cursor: 'pointer', padding: 0, fontWeight: 800, letterSpacing: '0.3px' }}
              >
                BỎ CHỌN HẾT
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: metricGridCols, gap: 4, padding: '6px 12px', background: 'var(--admin-layer-2)', borderBottom: '1px solid var(--admin-border)', fontSize: '.52rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>
              <span>ĐỐI TƯỢNG</span> <span style={{ textAlign: 'right' }}>LIVE</span> {!isOutdoorThermalCamera && <span style={{ textAlign: 'right' }}>DỰ BÁO 5P</span>}
            </div>
            <div className="sidebar-scroll" style={{ flex: 1, overflowY: 'auto', padding: '4px 0', minHeight: 0 }}>
              <div style={{ padding: '8px 12px 4px 12px', fontSize: '.58rem', fontWeight: 800, color: 'var(--admin-accent)', textTransform: 'uppercase', letterSpacing: '.5px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div style={{ position: 'absolute', width: '100%', height: 1.5, background: 'var(--admin-accent)' }} /><div style={{ position: 'absolute', width: 1.5, height: '100%', background: 'var(--admin-accent)' }} /></div> ĐIỂM ĐO
              </div>
              {filteredTargets.filter(t => {
                const lt = t.toLowerCase();
                return lt.includes('điểm') || lt.includes('point') || lt.startsWith('d');
              }).sort(naturalSort).map(target => {
                const r = latestReadings[target]; const isChecked = activeFilters[target] !== false;
                const temp = r?.hasActual ? r.actual : 0; const statusColor = temp >= 70 ? '#EF4444' : temp >= 50 ? '#F59E0B' : '#10B981';
                const displayLabel = formatPointLabel(target);

                return (
                  <div key={target} onClick={() => toggleFilter(target)} style={{ display: 'grid', gridTemplateColumns: metricGridCols, gap: 4, padding: '8px 12px', borderBottom: '1px solid var(--admin-border-light)', cursor: 'pointer', background: isChecked ? 'transparent' : 'rgba(0,0,0,0.05)', opacity: isChecked ? 1 : 0.6 }}>
                    <div style={{ fontSize: '.75rem', fontWeight: 700, color: isChecked ? 'var(--admin-text)' : 'var(--admin-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 8 }}><div style={{ width: 10, height: 10, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><div style={{ position: 'absolute', width: '100%', height: 2, background: statusColor }} /><div style={{ position: 'absolute', width: 2, height: '100%', background: statusColor }} /></div>{displayLabel}</div>
                    <div style={{ fontSize: '.8rem', fontWeight: 800, color: r?.hasActual ? statusColor : 'var(--admin-text-muted)', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{r?.hasActual ? r.actual.toFixed(1) : '--'}°</div>
                    {!isOutdoorThermalCamera && (
                      <div style={{ fontSize: '.8rem', fontWeight: 800, color: r?.hasPred ? 'var(--admin-accent)' : 'var(--admin-text-muted)', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{r?.hasPred ? `${r.pred.toFixed(1)}°` : '---'}</div>
                    )}
                  </div>
                );
              })}
              <div style={{ padding: '16px 12px 4px 12px', fontSize: '.58rem', fontWeight: 800, color: '#8B5CF6', textTransform: 'uppercase', letterSpacing: '.5px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, border: '1.5px solid #8B5CF6' }} /> VÙNG ĐO (V)
              </div>
              {filteredTargets.filter(t => {
                const lt = t.toLowerCase();
                // Phân loại là Vùng nếu chứa chữ vùng, zone hoặc bắt đầu bằng v, hoặc đơn giản là KHÔNG phải Điểm
                return lt.includes('vùng') || lt.includes('zone') || lt.startsWith('v') || (!lt.includes('điểm') && !lt.includes('point') && !lt.startsWith('d'));
              }).sort(naturalSort).map(target => {
                const r = latestReadings[target]; const isChecked = activeFilters[target] !== false;
                const temp = r?.hasActual ? r.actual : 0; const statusColor = temp >= 70 ? '#EF4444' : temp >= 50 ? '#F59E0B' : '#10B981';

                let displayLabel = target;
                if (target.toLowerCase().includes('vùng')) displayLabel = target.replace(/vùng/gi, 'V').replace(/\s+/g, '');
                else if (target.toLowerCase().includes('zone')) displayLabel = target.replace(/zone/gi, 'V').replace(/\s+/g, '');

                return (
                  <div key={target} onClick={() => toggleFilter(target)} style={{ display: 'grid', gridTemplateColumns: metricGridCols, gap: 4, padding: '8px 12px', borderBottom: '1px solid var(--admin-border-light)', cursor: 'pointer', background: isChecked ? 'transparent' : 'rgba(0,0,0,0.05)', opacity: isChecked ? 1 : 0.6 }}>
                    <div style={{ fontSize: '.75rem', fontWeight: 700, color: isChecked ? 'var(--admin-text)' : 'var(--admin-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 8 }}><div style={{ width: 10, height: 10, border: `1.5px solid ${statusColor}`, flexShrink: 0 }} />{displayLabel}</div>
                    <div style={{ fontSize: '.8rem', fontWeight: 800, color: r?.hasActual ? statusColor : 'var(--admin-text-muted)', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{r?.hasActual ? r.actual.toFixed(1) : '--'}°</div>
                    {!isOutdoorThermalCamera && (
                      <div style={{ fontSize: '.8rem', fontWeight: 800, color: r?.hasPred ? 'var(--admin-accent)' : 'var(--admin-text-muted)', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{r?.hasPred ? `${r.pred.toFixed(1)}°` : '---'}</div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ padding: '8px 12px', background: 'var(--admin-layer-2)', borderTop: '1px solid var(--admin-border)', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.58rem', fontFamily: 'monospace' }}><span style={{ color: 'var(--admin-text-muted)', fontWeight: 600 }}>GIỜ THỰC TẾ:</span> <span style={{ color: 'var(--admin-success)', fontWeight: 800 }}>{liveTime || '--:--:--'}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.58rem', fontFamily: 'monospace' }}><span style={{ color: 'var(--admin-text-muted)', fontWeight: 600 }}>GIỜ DỰ BÁO:</span> <span style={{ color: 'var(--admin-accent)', fontWeight: 800 }}>{forecastTime || '--:--:--'}</span></div>
            </div>
          </div>
        </div>

        {/* MAIN AREA */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minWidth: 0 }}>
          <div style={{ flex: 1, background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', borderRadius: 0, padding: '20px', display: 'flex', flexDirection: 'column', position: 'relative' }}>
            <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'center' }}><div style={{ fontSize: '.62rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '.8px', textAlign: 'center' }}>BIỂU ĐỒ XU HƯỚNG NHIỆT ĐỘ THỜI GIAN THỰC (JETSON NANO AI ENGINE)</div></div>
            <div style={{ flex: 1, position: 'relative' }}>{chartLoading && (<div style={{ position: 'absolute', inset: 0, background: 'rgba(9, 14, 26, 0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10 }}><RotateCw className="animate-spin" size={24} color="var(--admin-accent)" /></div>)}<canvas ref={chartRef} /></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginTop: 12, justifyContent: 'center', borderTop: '1px solid var(--admin-border-light)', paddingTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div style={{ width: 24, height: 2, background: '#9CA3AF' }} /><span style={{ fontSize: '.6rem', fontWeight: 700, color: 'var(--admin-text-muted)', letterSpacing: '.5px' }}>THỰC TẾ (NÉT LIỀN)</span></div>
              {!isOutdoorThermalCamera && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div style={{ width: 24, height: 0, borderBottom: '2px dashed #9CA3AF' }} /><span style={{ fontSize: '.6rem', fontWeight: 700, color: 'var(--admin-text-muted)', letterSpacing: '.5px' }}>DỰ BÁO AI (NÉT ĐỨT)</span></div>
              )}
            </div>
          </div>
          <div style={{ background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', borderRadius: 0, padding: '12px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div><div style={{ fontSize: '.58rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '.8px' }}>TRẠNG THÁI HỆ THỐNG AI</div><div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}><span style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--admin-text)' }}>{modelStatus.status === 'Training' ? 'ĐANG TỰ HỌC (TRAINING)' : modelStatus.jetson_connected ? 'ĐANG GIÁM SÁT & DỰ BÁO' : 'JETSON TẠM THỜI MẤT KẾT NỐI'}</span><div style={{ width: 8, height: 8, borderRadius: '50%', background: modelStatus.status === 'Training' ? 'var(--admin-warning)' : modelStatus.jetson_connected ? 'var(--admin-success)' : 'var(--admin-danger, #EF4444)', animation: modelStatus.jetson_connected ? 'pulse 2s infinite' : 'none' }} /></div></div>
            <div style={{ textAlign: 'right' }}><div style={{ fontSize: '.58rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>CẬP NHẬT LẦN CUỐI</div><div style={{ fontSize: '.85rem', fontWeight: 700, color: 'var(--admin-text)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>{modelStatus.last_updated}</div></div>
          </div>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .animate-spin { animation: spin 1.2s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
        
        /* Custom Industrial Scrollbar - Force Visibility */
        .sidebar-scroll::-webkit-scrollbar { width: 10px; }
        .sidebar-scroll::-webkit-scrollbar-track { background: rgba(0,0,0,0.3); }
        .sidebar-scroll::-webkit-scrollbar-thumb { background: #f59e0b; border-radius: 4px; border: 2px solid #000; }
        .sidebar-scroll::-webkit-scrollbar-thumb:hover { background: #fbbf24; }
        .sidebar-scroll { scrollbar-width: auto; scrollbar-color: #f59e0b rgba(0,0,0,0.3); }
      ` }} />
    </div>
  );
}
