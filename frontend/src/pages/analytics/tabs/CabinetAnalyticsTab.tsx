import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RotateCw } from 'lucide-react';
import Chart from 'chart.js/auto';
import { getCSSColor } from '@/utils/theme-colors';
import { stationApi } from '@/services/StationApiService';
import * as XLSX from 'xlsx';

const SC = { good: '#10B981', warning: '#F59E0B', danger: '#EF4444' } as const;

interface HistoryPoint {
  time: number; // timestamp ms
  value: number;
}

interface TempChartProps {
  t1: HistoryPoint[];
  t2: HistoryPoint[];
  t3: HistoryPoint[];
}

function TempChart({ t1, t2, t3 }: TempChartProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const inst = useRef<Chart | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    inst.current?.destroy();

    const fmt = (ts: number) => {
      const d = new Date(ts);
      return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }) + ' ' + d.getHours().toString().padStart(2, '0') + ':00';
    };

    inst.current = new Chart(ref.current, {
      type: 'line',
      data: {
        labels: t1.map(p => fmt(p.time)),
        datasets: [
          { label: 'T1', data: t1.map(p => p.value), borderColor: '#3B82F6', borderWidth: 2, pointRadius: 0, tension: 0.3 },
          { label: 'T2', data: t2.map(p => p.value), borderColor: '#10B981', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
          { label: 'T3', data: t3.map(p => p.value), borderColor: '#F59E0B', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
          { label: 'Ngưỡng cảnh báo (60°C)', data: t1.map(() => 60), borderColor: '#F59E0B55', borderWidth: 1, borderDash: [4, 4], pointRadius: 0 } as any,
          { label: 'Ngưỡng nguy hiểm (80°C)', data: t1.map(() => 80), borderColor: '#EF444455', borderWidth: 1, borderDash: [4, 4], pointRadius: 0 } as any,
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: getCSSColor('--admin-text-muted'), boxWidth: 10, usePointStyle: true, font: { size: 10 } } },
          tooltip: { backgroundColor: getCSSColor('--admin-panel'), titleColor: getCSSColor('--admin-text'), bodyColor: getCSSColor('--admin-text-muted'), borderColor: getCSSColor('--admin-border'), borderWidth: 1 },
        },
        scales: {
          x: { grid: { color: getCSSColor('--admin-border') }, ticks: { color: getCSSColor('--admin-text-muted'), font: { size: 9 }, maxTicksLimit: 10 } },
          y: { grid: { color: getCSSColor('--admin-border') }, ticks: { color: getCSSColor('--admin-text-muted'), font: { size: 9 }, callback: (v: any) => `${v}°C` }, suggestedMin: 20, suggestedMax: 100 },
        },
      },
    });

    return () => inst.current?.destroy();
  }, [t1, t2, t3]);

  return <canvas ref={ref} style={{ width: '100%', height: '100%' }} />;
}

interface PdChartProps {
  pd: HistoryPoint[];
}

function PdChart({ pd }: PdChartProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const inst = useRef<Chart | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    inst.current?.destroy();

    const fmt = (ts: number) => new Date(ts).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });

    inst.current = new Chart(ref.current, {
      type: 'bar',
      data: {
        labels: pd.map(p => fmt(p.time)),
        datasets: [{
          label: 'Mức độ PD (dB)',
          data: pd.map(p => p.value),
          backgroundColor: pd.map(p => p.value > 50 ? '#EF444470' : p.value > 20 ? '#F59E0B70' : '#10B98170'),
          borderColor: pd.map(p => p.value > 50 ? '#EF4444' : p.value > 20 ? '#F59E0B' : '#10B981'),
          borderWidth: 1,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: getCSSColor('--admin-panel'), titleColor: getCSSColor('--admin-text'), bodyColor: getCSSColor('--admin-text-muted'), borderColor: getCSSColor('--admin-border'), borderWidth: 1 },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: getCSSColor('--admin-text-muted'), font: { size: 9 }, maxTicksLimit: 10 } },
          y: { grid: { color: getCSSColor('--admin-border') }, ticks: { color: getCSSColor('--admin-text-muted'), font: { size: 9 } } },
        },
      },
    });

    return () => inst.current?.destroy();
  }, [pd]);

  return <canvas ref={ref} style={{ width: '100%', height: '100%' }} />;
}

interface CabinetSummary {
  id: string;
  name: string;
  status: string;
  t1: number | null;
  t2: number | null;
  t3: number | null;
  tempMax: number | null;
  pdCount: number | null;
  pdLevel: 'low' | 'medium' | 'high';
  healthScore: number;
  healthStatus: 'good' | 'warning' | 'danger';
  alarmCount: number;
  warningCount: number;
}

interface ExportFns { xlsx: () => void; csv: () => void; pdf: () => void; }

interface CabinetAnalyticsTabProps {
  fromDate: string;
  toDate: string;
  registerExport?: (fns: ExportFns | null) => void;
}

export default function CabinetAnalyticsTab({ fromDate, toDate, registerExport }: CabinetAnalyticsTabProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const cabParam = searchParams.get('cabinet');
  const [selectedId, setSelectedId] = useState<string | null>(cabParam);
  
  const [devices, setDevices] = useState<any[]>([]);
  const [latestPoints, setLatestPoints] = useState<any[]>([]);
  const [healthScores, setHealthScores] = useState<Record<string, { score: number; risk: string; alarmCount?: number; warningCount?: number }>>({});
  
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  
  const [t1Hist, setT1Hist] = useState<HistoryPoint[]>([]);
  const [t2Hist, setT2Hist] = useState<HistoryPoint[]>([]);
  const [t3Hist, setT3Hist] = useState<HistoryPoint[]>([]);
  const [pdHist, setPdHist] = useState<HistoryPoint[]>([]);

  const buildExportRows = () => {
    const fmt = (ms: number) => new Date(ms).toLocaleString('sv').replace('T', ' ');
    const map1 = new Map(t1Hist.map(p => [p.time, p.value]));
    const map2 = new Map(t2Hist.map(p => [p.time, p.value]));
    const map3 = new Map(t3Hist.map(p => [p.time, p.value]));
    const mapPd = new Map(pdHist.map(p => [p.time, p.value]));
    const times = [...new Set([...map1.keys(), ...map2.keys(), ...map3.keys(), ...mapPd.keys()])].sort();
    return times.map(ts => ({
      'Thoi gian': fmt(ts),
      'T1 (oC)': map1.has(ts) ? Number(map1.get(ts)).toFixed(1) : '',
      'T2 (oC)': map2.has(ts) ? Number(map2.get(ts)).toFixed(1) : '',
      'T3 (oC)': map3.has(ts) ? Number(map3.get(ts)).toFixed(1) : '',
      'PD (xung)': mapPd.has(ts) ? String(mapPd.get(ts)) : '',
    }));
  };

  const CAB_HEADERS = ['Thoi gian', 'T1 (oC)', 'T2 (oC)', 'T3 (oC)', 'PD (xung)'];

  useEffect(() => {
    if (!registerExport || !selectedId) { registerExport?.(null); return; }
    const fname = `Phan_tich_tu_dien_${new Date().toISOString().slice(0, 10)}`;
    const xlsx = () => {
      const rows = buildExportRows();
      const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{}]);
      ws['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }];
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Tu dien');
      XLSX.writeFile(wb, `${fname}.xlsx`);
    };
    const csv = () => {
      const rows = buildExportRows();
      const text = [CAB_HEADERS.join(','), ...rows.map(r => CAB_HEADERS.map(h => `"${(r[h as keyof typeof r] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8;' }));
      a.download = `${fname}.csv`; a.click();
    };
    const pdf = () => {
      const rows = buildExportRows();
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Phân tích tủ điện</title>
<style>body{font-family:Arial,'Segoe UI',sans-serif;font-size:9pt;margin:20px}h1{font-size:13pt;font-weight:900;letter-spacing:2px;margin-bottom:4px}.sub{font-size:8pt;color:#555;margin-bottom:12px}table{width:100%;border-collapse:collapse}th{background:#1e293b;color:#fff;padding:5px 6px;font-size:7.5pt;text-align:left;border:1px solid #334155}td{border:1px solid #cbd5e1;padding:3px 6px;font-size:7.5pt}tr:nth-child(even) td{background:#f8fafc}@page{size:A4 landscape;margin:12mm}</style>
</head><body>
<h1>PHÂN TÍCH TỦ ĐIỆN</h1>
<div class="sub">Xuất ngày ${new Date().toISOString().slice(0,10)} — ${rows.length} dòng</div>
<table><thead><tr>${CAB_HEADERS.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
<tbody>${rows.map(r=>`<tr>${CAB_HEADERS.map(h=>`<td>${r[h as keyof typeof r]??''}</td>`).join('')}</tr>`).join('')}</tbody>
</table></body></html>`;
      const win = window.open('', '_blank');
      if (win) { win.document.write(html); win.document.close(); win.focus(); win.print(); }
    };
    registerExport({ xlsx, csv, pdf });
    return () => registerExport(null);
  }, [selectedId, t1Hist, t2Hist, t3Hist, pdHist, registerExport]);

  // Sync selectedId with URL parameter if it changes
  useEffect(() => {
    if (cabParam) {
      setSelectedId(cabParam);
    }
  }, [cabParam]);

  // Sync URL parameter if selectedId changes
  const handleSelectId = (id: string | null) => {
    setSelectedId(id);
    if (id) {
      setSearchParams({ cabinet: id });
    } else {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('cabinet');
      setSearchParams(nextParams);
    }
  };

  // Tự động tải danh sách thiết bị tủ điện từ Backend
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const stationId = await stationApi.getFirstStationId();
        if (!stationId) {
          setLoading(false);
          return;
        }
        const [devs, points, scores] = await Promise.all([
          stationApi.getDevices(stationId),
          stationApi.getLatestPoints(stationId),
          stationApi.getHealthScores(stationId)
        ]);
        
        const cabinetDevs = devs.filter(d => d.type === 'plc_s7' || d.type === 'cabinet');
        setDevices(cabinetDevs);
        setLatestPoints(points);
        
        const scoreMap: Record<string, { score: number; risk: string; alarmCount?: number; warningCount?: number }> = {};
        scores.forEach(s => {
          scoreMap[s.deviceId.toLowerCase()] = {
            score: s.score,
            risk: s.risk || (s.score >= 80 ? 'good' : s.score >= 50 ? 'warning' : 'danger'),
            alarmCount: s.alarmCount,
            warningCount: s.warningCount,
          };
        });
        setHealthScores(scoreMap);

        if (cabinetDevs.length > 0 && !selectedId) {
          const firstCab = cabinetDevs[0];
          if (firstCab) {
            setSelectedId(firstCab.id);
          }
        }
      } catch (err) {
        console.error('[Analytics] Lỗi nạp thiết bị:', err);
      } finally {
        setLoading(false);
      }
    };
    
    fetchData();
  }, []);

  // Xử lý nạp dữ liệu lịch sử time-series thực tế từ database
  useEffect(() => {
    if (!selectedId) return;
    
    const fetchHistory = async () => {
      try {
        setHistoryLoading(true);
        const stationId = await stationApi.getFirstStationId();
        if (!stationId) return;

        const now = new Date();
        const to = toDate ? new Date(`${toDate}T23:59:59`) : now;
        const from = fromDate ? new Date(`${fromDate}T00:00:00`) : new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const diffDays = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86400000) + 1);
        const interval = diffDays <= 7 ? 60 : diffDays <= 30 ? 240 : 720;

        const pointIdsToFetch = ['nhiet_do_pha_1', 'nhiet_do_pha_2', 'nhiet_do_pha_3', 'temp_1', 'temp_2', 'temp_3', 'phong_dien', 'pd'];

        const hist = await stationApi.getHistoryBulk(
          stationId,
          from.toISOString(),
          to.toISOString(),
          interval,
          pointIdsToFetch,
          selectedId
        );

        // Phân tách các điểm đo
        const t1Data: HistoryPoint[] = [];
        const t2Data: HistoryPoint[] = [];
        const t3Data: HistoryPoint[] = [];
        const pdData: HistoryPoint[] = [];

        hist.forEach((h: any) => {
          const tMs = new Date(h.time).getTime();
          const val = h.value ?? 0;
          const pid = h.pointId.toLowerCase();

          if (pid === 'nhiet_do_pha_1' || pid === 'temp_1') {
            t1Data.push({ time: tMs, value: val });
          } else if (pid === 'nhiet_do_pha_2' || pid === 'temp_2') {
            t2Data.push({ time: tMs, value: val });
          } else if (pid === 'nhiet_do_pha_3' || pid === 'temp_3') {
            t3Data.push({ time: tMs, value: val });
          } else if (pid === 'phong_dien' || pid === 'pd') {
            pdData.push({ time: tMs, value: val });
          }
        });

        // Sắp xếp tăng dần theo thời gian
        const sortFn = (a: HistoryPoint, b: HistoryPoint) => a.time - b.time;
        setT1Hist(t1Data.sort(sortFn));
        setT2Hist(t2Data.sort(sortFn));
        setT3Hist(t3Data.sort(sortFn));
        setPdHist(pdData.sort(sortFn));
      } catch (err) {
        console.warn('[Analytics] Lỗi tải lịch sử đo lường:', err);
      } finally {
        setHistoryLoading(false);
      }
    };

    fetchHistory();
  }, [selectedId, fromDate, toDate]);

  const cabinetList = useMemo<CabinetSummary[]>(() => {
    const list: CabinetSummary[] = [];
    devices.forEach(cab => {
      const deviceId = cab.id.toLowerCase();
      const hInfo = healthScores[deviceId] || { score: 100, risk: 'good' };
      const cabPoints = latestPoints.filter(s => (s.deviceId || '').toLowerCase() === deviceId);
      const t1Raw = cabPoints.find(s => s.pointId === 'nhiet_do_pha_1' || s.pointId === 'temp_1')?.value;
      const t2Raw = cabPoints.find(s => s.pointId === 'nhiet_do_pha_2' || s.pointId === 'temp_2')?.value;
      const t3Raw = cabPoints.find(s => s.pointId === 'nhiet_do_pha_3' || s.pointId === 'temp_3')?.value;
      const pdVal = cabPoints.find(s => s.pointId === 'phong_dien' || s.pointId === 'pd')?.value ?? null;

      const t1 = t1Raw !== undefined && t1Raw !== null ? Math.round(t1Raw * 10) / 10 : null;
      const t2 = t2Raw !== undefined && t2Raw !== null ? Math.round(t2Raw * 10) / 10 : null;
      const t3 = t3Raw !== undefined && t3Raw !== null ? Math.round(t3Raw * 10) / 10 : null;

      const healthStatus = hInfo.risk as 'good' | 'warning' | 'danger';
      const tempMax = t1 !== null && t2 !== null && t3 !== null ? Math.max(t1, t2, t3) : null;
      
      const pdLevel = pdVal == null
        ? 'low'
        : pdVal < 0
          ? (pdVal > -20 ? 'high' : pdVal > -27 ? 'medium' : 'low')
          : (pdVal > 50 ? 'high' : pdVal > 20 ? 'medium' : 'low');

      list.push({
        id: cab.id,
        name: cab.name || 'Tủ điện',
        status: cab.status || 'unknown',
        t1,
        t2,
        t3,
        tempMax,
        pdCount: pdVal == null ? null : Math.round(pdVal),
        pdLevel,
        healthScore: hInfo.score,
        healthStatus,
        alarmCount: hInfo.alarmCount ?? 0,
        warningCount: hInfo.warningCount ?? 0,
      });
    });
    return list;
  }, [devices, latestPoints, healthScores]);

  const selectedKey = selectedId?.toLowerCase() ?? null;
  const selected = selectedKey ? cabinetList.find(c => c.id.toLowerCase() === selectedKey) ?? null : null;

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--admin-text-muted)', fontSize: '0.85rem' }}>
        ⏳ Đang đồng bộ dữ liệu từ trạm...
      </div>
    );
  }

  if (cabinetList.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--admin-text-muted)', fontSize: '0.85rem' }}>
        ⚠️ Không có dữ liệu tủ điện. Hãy cấu hình thiết bị trước.
      </div>
    );
  }

  const tColor = (t: number | null) =>
    t === null ? '#6B7280' : t > 80 ? '#EF4444' : t > 60 ? '#F59E0B' : '#10B981';

  return (
    <>
    <div style={{ display: 'flex', height: '100%', gap: 12, overflow: 'hidden' }}>

      {/* ── SIDEBAR ── */}
      <div style={{ width: 300, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--admin-border)', background: 'var(--admin-layer-1)', flexShrink: 0 }}>
          <span style={{ fontSize: '.6rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '.5px' }}>DANH SÁCH TỦ ĐIỆN</span>
        </div>

        {/* Column headers */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 52px 52px 52px', gap: 0, padding: '5px 12px', background: 'var(--admin-layer-2)', borderBottom: '1px solid var(--admin-border)', flexShrink: 0 }}>
          {['TỦ ĐIỆN', 'SK', 'T MAX', 'PD'].map((h, i) => (
            <span key={h} style={{ fontSize: '.52rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '.4px', textAlign: i > 0 ? 'right' : 'left' }}>{h}</span>
          ))}
        </div>

        {/* Cabinet rows */}
        <div className="cabinet-sidebar-scroll" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {cabinetList.map(cab => {
            const isOffline = cab.status === 'offline';
            const color = isOffline ? '#6B7280' : SC[cab.healthStatus];
            const isActive = selectedKey === cab.id.toLowerCase();
            const pdColor = cab.pdLevel === 'high' ? '#EF4444' : cab.pdLevel === 'medium' ? '#F59E0B' : '#10B981';

            return (
              <div key={cab.id}
                onClick={() => handleSelectId(isActive ? null : cab.id)}
                style={{
                  display: 'grid', gridTemplateColumns: '1fr 52px 52px 52px', gap: 0,
                  padding: '9px 12px', cursor: 'pointer',
                  borderBottom: '1px solid var(--admin-border-light)',
                  borderLeft: `3px solid ${isActive ? color : 'transparent'}`,
                  background: isActive ? `${color}10` : 'transparent',
                  opacity: isOffline ? 0.65 : 1,
                  transition: 'background .12s',
                  alignItems: 'center',
                }}
                onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--admin-hover)'; }}
                onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <div style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: '.75rem', fontWeight: 700, color: isActive ? color : 'var(--admin-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cab.name}</span>
                </div>
                <span
                  style={{ fontSize: '.72rem', fontWeight: 800, color: isOffline ? '#6B7280' : color, fontFamily: 'Consolas,monospace', textAlign: 'right', cursor: 'help' }}
                  title={isOffline ? 'Thiết bị ngoại tuyến' : (cab.alarmCount > 0 || cab.warningCount > 0)
                    ? `${cab.alarmCount} alarm đang mở × 25đ = -${cab.alarmCount * 25}\n${cab.warningCount} warning × 10đ = -${cab.warningCount * 10}\nTổng trừ: ${cab.alarmCount * 25 + cab.warningCount * 10}đ`
                    : `Sức khỏe tốt — không có cảnh báo nào`}
                >
                  {isOffline ? '--' : `${cab.healthScore}%`}
                </span>
                <span style={{ fontSize: '.72rem', fontWeight: 800, color: tColor(cab.tempMax), fontFamily: 'Consolas,monospace', textAlign: 'right' }}>
                  {cab.tempMax !== null && !isOffline ? `${cab.tempMax}°` : '--'}
                </span>
                <span style={{ fontSize: '.72rem', fontWeight: 800, color: isOffline ? '#6B7280' : pdColor, fontFamily: 'Consolas,monospace', textAlign: 'right' }}>
                  {isOffline || cab.pdCount === null ? '--' : cab.pdCount}
                </span>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--admin-border)', background: 'var(--admin-layer-2)', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.56rem', fontFamily: 'Consolas,monospace' }}>
            <span style={{ color: 'var(--admin-text-muted)', fontWeight: 600 }}>TỔNG TỦ:</span>
            <span style={{ color: 'var(--admin-text)', fontWeight: 800 }}>{cabinetList.length}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.56rem', fontFamily: 'Consolas,monospace', marginTop: 3 }}>
            <span style={{ color: 'var(--admin-text-muted)', fontWeight: 600 }}>OFFLINE:</span>
            <span style={{ color: cabinetList.filter(c => c.status === 'offline').length > 0 ? '#EF4444' : '#10B981', fontWeight: 800 }}>
              {cabinetList.filter(c => c.status === 'offline').length}
            </span>
          </div>
        </div>
      </div>

      {/* ── MAIN AREA ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, height: '100%', overflow: 'hidden' }}>

        {selected ? (
          <>
            {/* Charts area */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflow: 'hidden' }}>

              {/* Temp chart */}
              <div style={{ flex: 3, background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', padding: '16px 20px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ marginBottom: 10, textAlign: 'center' }}>
                  <span style={{ fontSize: '.62rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '.8px' }}>
                    BIỂU ĐỒ NHIỆT ĐỘ TIẾP ĐIỂM (T1 / T2 / T3)
                  </span>
                </div>
                <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
                  {historyLoading ? (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-muted)', fontSize: '.72rem', gap: 8 }}>
                      <RotateCw size={16} className="cabinet-spin" /> Đang nạp lịch sử...
                    </div>
                  ) : t1Hist.length === 0 ? (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-muted)', fontSize: '.72rem' }}>
                      Chưa có dữ liệu nhiệt độ trong khoảng thời gian này
                    </div>
                  ) : (
                    <TempChart t1={t1Hist} t2={t2Hist} t3={t3Hist} />
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginTop: 10, justifyContent: 'center', borderTop: '1px solid var(--admin-border-light)', paddingTop: 10 }}>
                  {[{ color: '#3B82F6', label: 'T1' }, { color: '#10B981', label: 'T2' }, { color: '#F59E0B', label: 'T3' }].map(l => (
                    <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 20, height: 2, background: l.color }} />
                      <span style={{ fontSize: '.6rem', fontWeight: 700, color: 'var(--admin-text-muted)', letterSpacing: '.5px' }}>{l.label}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 20, height: 0, borderBottom: '2px dashed #F59E0B55' }} />
                    <span style={{ fontSize: '.6rem', fontWeight: 700, color: 'var(--admin-text-muted)', letterSpacing: '.5px' }}>60°C CẢNH BÁO</span>
                  </div>
                </div>
              </div>

              {/* PD chart */}
              <div style={{ flex: 2, background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', padding: '16px 20px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ marginBottom: 10, textAlign: 'center' }}>
                  <span style={{ fontSize: '.62rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '.8px' }}>
                    HOẠT ĐỘNG PHÓNG ĐIỆN PD (LỊCH SỬ)
                  </span>
                </div>
                <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
                  {historyLoading ? (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-muted)', fontSize: '.72rem', gap: 8 }}>
                      <RotateCw size={16} className="cabinet-spin" /> Đang nạp...
                    </div>
                  ) : pdHist.length === 0 ? (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-muted)', fontSize: '.72rem' }}>
                      Chưa có dữ liệu phóng điện trong khoảng thời gian này
                    </div>
                  ) : (
                    <PdChart pd={pdHist} />
                  )}
                </div>
              </div>
            </div>

            {/* Status bar */}
            <div style={{ background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', padding: '10px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <div>
                  <div style={{ fontSize: '.58rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '.8px' }}>TỦ ĐANG XEM</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                    <span style={{ fontSize: '.95rem', fontWeight: 800, color: 'var(--admin-text)', fontFamily: 'Consolas,monospace' }}>{selected.name}</span>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: selected.status === 'offline' ? '#6B7280' : SC[selected.healthStatus] }} />
                    {selected.status === 'offline' && <span style={{ fontSize: '.62rem', fontWeight: 800, color: '#EF4444' }}>MẤT KẾT NỐI</span>}
                  </div>
                </div>
                {selected.healthScore < 100 && (selected.alarmCount > 0 || selected.warningCount > 0) && (
                  <button
                    className="btn-industrial"
                    style={{ height: 26, padding: '0 10px', fontSize: '.65rem', fontWeight: 700, color: '#F59E0B', borderColor: '#F59E0B50' }}
                    title={`${selected.alarmCount} alarm × 25đ + ${selected.warningCount} warning × 10đ = SK mất ${selected.alarmCount * 25 + selected.warningCount * 10}đ`}
                    onClick={async () => {
                      if (!confirm(`Đóng tất cả ${selected.alarmCount + selected.warningCount} cảnh báo đang mở của "${selected.name}"?\nSức khỏe sẽ được tính lại.`)) return;
                      try {
                        const { apiFetch } = await import('@/services/api/BaseApiService');
                        await (apiFetch as any)(`/alerts/close-device/${selected.id}`, { method: 'POST' });
                        window.location.reload();
                      } catch { alert('Lỗi khi đóng cảnh báo.'); }
                    }}
                  >
                    ⚠ {selected.alarmCount + selected.warningCount} CẢNH BÁO — ĐÓng tất cả
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 20 }}>
                {[
                  { label: 'T1', val: selected.t1 !== null ? `${selected.t1}°C` : '--', color: tColor(selected.t1) },
                  { label: 'T2', val: selected.t2 !== null ? `${selected.t2}°C` : '--', color: tColor(selected.t2) },
                  { label: 'T3', val: selected.t3 !== null ? `${selected.t3}°C` : '--', color: tColor(selected.t3) },
                  { label: 'SỨC KHỎE', val: selected.status === 'offline' ? '--' : `${selected.healthScore}%`, color: selected.status === 'offline' ? '#6B7280' : SC[selected.healthStatus] },
                  { label: 'PD/24H', val: selected.status === 'offline' || selected.pdCount === null ? '--' : String(selected.pdCount), color: selected.pdCount === null ? '#6B7280' : selected.pdLevel === 'high' ? '#EF4444' : selected.pdLevel === 'medium' ? '#F59E0B' : '#10B981' },
                ].map(m => (
                  <div key={m.label} style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '.52rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '.4px' }}>{m.label}</div>
                    <div style={{ fontSize: '.85rem', fontWeight: 800, color: m.color, fontFamily: 'Consolas,monospace', marginTop: 2 }}>{m.val}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: 'var(--admin-text-muted)', background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)' }}>
            <span style={{ fontSize: '.72rem', fontFamily: 'Consolas,monospace', fontWeight: 700 }}>← Nhấn vào một tủ để xem biểu đồ chi tiết</span>
          </div>
        )}
      </div>
    </div>

    <style dangerouslySetInnerHTML={{ __html: `
      .cabinet-spin { animation: cabinet-spin-kf 1.2s linear infinite; }
      @keyframes cabinet-spin-kf { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      .cabinet-sidebar-scroll::-webkit-scrollbar { width: 8px; }
      .cabinet-sidebar-scroll::-webkit-scrollbar-track { background: rgba(0,0,0,.3); }
      .cabinet-sidebar-scroll::-webkit-scrollbar-thumb { background: #10B981; border-radius: 3px; border: 2px solid #000; }
      .cabinet-sidebar-scroll::-webkit-scrollbar-thumb:hover { background: #34D399; }
      .cabinet-sidebar-scroll { scrollbar-width: auto; scrollbar-color: #10B981 rgba(0,0,0,.3); }
    ` }} />
    </>
  );
}
