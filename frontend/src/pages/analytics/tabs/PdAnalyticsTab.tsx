import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import Chart from 'chart.js/auto';
import { getCSSColor } from '@/utils/theme-colors';
import { GO2RTC_URL, API_BASE_URL, AI_ENGINE_URL } from '@/utils/env';
import { authService } from '@/services/AuthService';
import { stationApi, Device } from '@/services/StationApiService';
import { getRealtimeHub, startRealtimeHub } from '@/services/realtime.service';
import { RotateCw, Zap } from 'lucide-react';
import ToolbarSelect from '@/components/ui/ToolbarSelect';
import * as XLSX from 'xlsx';

interface ExportFns { xlsx: () => void; csv: () => void; pdf: () => void; }

interface PdAnalyticsTabProps {
  fromDate: string;
  toDate: string;
  registerExport?: (fns: ExportFns | null) => void;
}

export default function PdAnalyticsTab({ fromDate, toDate, registerExport }: PdAnalyticsTabProps) {
  const [cameras, setCameras] = useState<Device[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  
  const [aiStats, setAiStats] = useState<{ db?: number | null, hz?: number | null, active_boundary?: string | null }>({});
  const [eventHistory, setEventHistory] = useState<any[]>([]);
  const [boundaries, setBoundaries] = useState<any[]>([]);

  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInst = useRef<Chart | null>(null);

  const streamUrl = useMemo(() => {
    if (!selectedCamera) return '';
    const go2rtcId = selectedCamera.config?.go2rtc_id || `cam_${(selectedCamera.config?.ip || '').replace(/\./g, '_')}_pd`;
    return go2rtcId ? `/camera-stream.html?src=${encodeURIComponent(go2rtcId)}&mode=webrtc,mse&go2rtc=${GO2RTC_URL}` : '';
  }, [selectedCamera]);

  // Load PD cameras
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
          const pdDevs = devs.filter(d => d.type === 'camera_pd' || d.type === 'cabinet');
          setCameras(pdDevs);
          if (pdDevs.length > 0) setSelectedCamera(pdDevs[0] ?? null);
        }
      } catch (err) {
        console.error('[PD Analytics] Error loading cameras:', err);
      } finally {
        setLoading(false);
      }
    };
    initData();
  }, []);

  // Fetch boundaries and initial history (detections)
  const getEventLevel = useCallback((db: number, boundaries: any[], activeBoundaryName?: string | null) => {
    let warnDb = 20, alarmDb = 45;
    const region = boundaries.find(b => b.name === activeBoundaryName) || boundaries[0];
    if (region) {
      try {
        const t = JSON.parse(region.thresholds || '{}');
        warnDb = t.warn || t.warning || 20;
        alarmDb = t.alarm || 45;
      } catch {}
    }
    if (db >= alarmDb) return 'alarm';
    if (db >= warnDb) return 'warning';
    return 'event'; // "Vượt ngưỡng" nhưng chưa tới mức cảnh báo
  }, []);

  const loadHistory = useCallback(async (camId: string, currentBoundaries: any[]) => {
    try {
      const params = new URLSearchParams({
        deviceId: camId,
        type: 'partial_discharge',
        limit: '200',
      });
      if (fromDate) params.set('from', `${fromDate}T00:00:00`);
      if (toDate) params.set('to', `${toDate}T23:59:59`);
      const data = await stationApi.getDetections(params.toString());
      // Map to consistent format
      setEventHistory(data.reverse().map((d: any) => {
        const db = d.maxTemp || 0;
        return {
          id: d.id,
          time: new Date(d.detectedAt).toLocaleTimeString('vi-VN', { hour12: false }),
          db: db,
          level: getEventLevel(db, currentBoundaries, d.affectedZone)
        };
      }));
    } catch {
      setEventHistory([]);
    }
  }, [getEventLevel, fromDate, toDate]);

  useEffect(() => {
    if (!selectedCamera) return;
    stationApi.getBoundaries(selectedCamera.id, 'pd')
      .then(bs => {
        setBoundaries(bs);
        loadHistory(selectedCamera.id, bs);
      })
      .catch(() => setBoundaries([]));
  }, [selectedCamera, loadHistory]);

  // Poll real-time PD state for the big number only
  useEffect(() => {
    if (!selectedCamera) return;
    let timer: any;
    const fetchStats = async () => {
      try {
        const token = authService.getToken() || '';
        const backend = API_BASE_URL.replace('/api/v1', '');
        const res = await fetch(`${AI_ENGINE_URL}/pd-monitor/${selectedCamera.id}/state?token=${token}&backend=${backend}`);
        if (res.ok) {
          const data = await res.json();
          setAiStats({
            db: data.db,
            hz: data.hz,
            active_boundary: data.active_boundary,
          });
        }
      } catch (err) {}
      timer = setTimeout(fetchStats, 800);
    };
    fetchStats();
    return () => clearTimeout(timer);
  }, [selectedCamera]);

  // SignalR for real-time history updates
  useEffect(() => {
    if (!selectedCamera) return;
    const hub = getRealtimeHub();
    
    hub.on('CameraEvent', (evt: any) => {
      if (evt.cameraId === selectedCamera.id && evt.detectionType === 'partial_discharge') {
        const now = new Date(evt.detectedAt).toLocaleTimeString('vi-VN', { hour12: false });
        const db = evt.maxTemp || 0;
        const level = getEventLevel(db, boundaries, evt.affectedZone);

        setEventHistory(prev => {
          // Avoid duplicate events if pushed too fast
          if (prev.length > 0 && prev[prev.length - 1].id === evt.id) return prev;
          const next = [...prev, {
            id: evt.id,
            time: now,
            db: db,
            level: level
          }];
          if (next.length > 50) next.shift();
          return next;
        });
      }
    });

    startRealtimeHub().catch(() => {});
    return () => { hub.off('CameraEvent'); };
  }, [selectedCamera, boundaries, getEventLevel]);

  // Render Chart (Bar chart for events)
  useEffect(() => {
    if (!chartRef.current) return;
    chartInst.current?.destroy();

    const xLabels = eventHistory.map(h => h.time);
    const yData = eventHistory.map(h => h.db);
    
    const getLevelColor = (level: string, alpha = 1) => {
      if (level === 'alarm') return `rgba(239, 68, 68, ${alpha})`; // Red
      if (level === 'warning') return `rgba(245, 158, 11, ${alpha})`; // Amber
      return `rgba(59, 130, 246, ${alpha})`; // Blue for "vượt ngưỡng" (event)
    };

    const bgColors = eventHistory.map(h => getLevelColor(h.level, 0.7));
    const borderColors = eventHistory.map(h => getLevelColor(h.level, 1));

    chartInst.current = new Chart(chartRef.current, {
      type: 'bar',
      data: {
        labels: xLabels,
        datasets: [
          {
            label: 'Cường độ PD (dB)',
            data: yData,
            backgroundColor: bgColors,
            borderColor: borderColors,
            borderWidth: 1,
            borderRadius: 2,
            barThickness: 'flex',
            maxBarThickness: 30
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: getCSSColor('--admin-panel'),
            titleColor: getCSSColor('--admin-text'),
            bodyColor: '#fff',
            borderColor: getCSSColor('--admin-border'),
            borderWidth: 1,
            callbacks: {
              label: (context: any) => {
                const h = eventHistory[context.dataIndex];
                const levelName = h.level === 'alarm' ? 'BÁO ĐỘNG' : h.level === 'warning' ? 'CẢNH BÁO' : 'VƯỢT NGƯỠNG';
                return `${levelName}: ${context.parsed.y.toFixed(1)} dB`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: getCSSColor('--admin-text-muted'), font: { size: 9, family: 'Consolas' } }
          },
          y: {
            grid: { color: getCSSColor('--admin-border'), borderDash: [2, 2] } as any,
            ticks: { color: getCSSColor('--admin-text-muted'), font: { size: 9, family: 'Consolas' } },
            title: { display: true, text: 'dB', color: 'rgba(255,255,255,0.3)', font: { size: 10 } },
            suggestedMin: 0,
            suggestedMax: 60
          }
        }
      }
    });

    return () => chartInst.current?.destroy();
  }, [eventHistory]);

  useEffect(() => {
    if (!registerExport || cameras.length === 0) return;
    const headers = ['Thoi gian', 'Muc (dB)', 'Cap do'];
    const fname = `Phan_tich_phong_dien_${new Date().toISOString().slice(0, 10)}`;
    const getRows = () => eventHistory.map(h => ({ 'Thoi gian': h.time, 'Muc (dB)': String(Number(h.db ?? 0).toFixed(1)), 'Cap do': h.level ?? '' }));
    const xlsx = () => {
      const rows = getRows();
      const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ 'Thoi gian': '', 'Muc (dB)': '', 'Cap do': '' }]);
      ws['!cols'] = [{ wch: 20 }, { wch: 12 }, { wch: 12 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Phong dien');
      XLSX.writeFile(wb, `${fname}.xlsx`);
    };
    const csv = () => {
      const rows = getRows();
      const text = [headers.join(','), ...rows.map(r => headers.map(h => `"${(r[h as keyof typeof r] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8;' }));
      a.download = `${fname}.csv`; a.click();
    };
    const pdf = () => {
      const rows = getRows();
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Phóng điện cục bộ</title>
<style>body{font-family:Arial,'Segoe UI',sans-serif;font-size:9pt;margin:20px}h1{font-size:13pt;font-weight:900;letter-spacing:2px;margin-bottom:4px}.sub{font-size:8pt;color:#555;margin-bottom:12px}table{width:100%;border-collapse:collapse}th{background:#1e293b;color:#fff;padding:5px 6px;font-size:7.5pt;text-align:left;border:1px solid #334155}td{border:1px solid #cbd5e1;padding:3px 6px;font-size:7.5pt}tr:nth-child(even) td{background:#f8fafc}@page{size:A4 portrait;margin:12mm}</style>
</head><body>
<h1>DỮ LIỆU PHÓNG ĐIỆN CỤC BỘ</h1>
<div class="sub">Xuất ngày ${new Date().toISOString().slice(0,10)} — ${rows.length} dòng</div>
<table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
<tbody>${rows.map(r=>`<tr>${headers.map(h=>`<td>${r[h as keyof typeof r]??''}</td>`).join('')}</tr>`).join('')}</tbody>
</table></body></html>`;
      const win = window.open('', '_blank');
      if (win) { win.document.write(html); win.document.close(); win.focus(); win.print(); }
    };
    registerExport({ xlsx, csv, pdf });
    return () => registerExport(null);
  }, [cameras, eventHistory, registerExport]);

  if (loading) return (
    <div style={{ display: 'flex', flex: 1, height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-muted)', gap: 10, background: 'var(--admin-card-bg)', borderRadius: 0, border: '1px solid var(--admin-border)' }}>
      <RotateCw size={18} className="animate-spin" color="var(--admin-accent)" />
      <span style={{ fontSize: '.8rem', fontFamily: 'monospace' }}>ĐANG TẢI DỮ LIỆU...</span>
      <style>{`.animate-spin { animation: spin 1.2s linear infinite; } @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'stretch', gap: 12, height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {/* SIDEBAR */}
      <div style={{ width: 340, minWidth: 340, display: 'flex', flexDirection: 'column', gap: 12, flexShrink: 0, minHeight: 0 }}>
        {/* Stream Card */}
        <div style={{ background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', borderRadius: 0, overflow: 'hidden', flexShrink: 0 }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--admin-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--admin-layer-1)' }}>
            <span style={{ fontSize: '.6rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>LUỒNG PD TRỰC TIẾP</span>
            {cameras.length > 0 && (
              <ToolbarSelect
                value={selectedCamera?.id || ''}
                onChange={(id) => setSelectedCamera(cameras.find(c => c.id === id) || null)}
                options={cameras.map(c => ({ value: c.id, label: c.name }))}
                width={160}
              />
            )}
          </div>
          <div style={{ aspectRatio: '16/9', background: '#000', position: 'relative', overflow: 'hidden' }}>
             {streamUrl ? (
               <>
                 <iframe src={streamUrl} style={{ width: '100%', height: '100%', border: 'none' }} allow="autoplay; fullscreen" />
                 
                 {/* BOUNDARY OVERLAY */}
                 <div style={{ position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none' }}>
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                      {boundaries.map(b => {
                        let poly: [number, number][] = [];
                        try { poly = JSON.parse(b.polygon); } catch { return null; }
                        if (poly.length < 2) return null;
                        
                        const isActive = aiStats.active_boundary === b.name;
                        const color = isActive ? '#ef4444' : '#10b981';
                        const points = poly.map(p => `${p[0] * 100},${p[1] * 100}`).join(' ');

                        return (
                          <polygon
                            key={b.id}
                            points={points}
                            fill={isActive ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.05)'}
                            stroke={color}
                            strokeWidth={isActive ? 3 : 1.5}
                            vectorEffect="non-scaling-stroke"
                          />
                        );
                      })}
                    </svg>
                    
                    {/* LABELS */}
                    {boundaries.map(b => {
                        let poly: [number, number][] = [];
                        try { poly = JSON.parse(b.polygon); } catch { return null; }
                        if (poly.length === 0) return null;
                        
                        const isActive = aiStats.active_boundary === b.name;
                        const color = isActive ? '#ef4444' : '#10b981';
                        
                        // Calculate center
                        const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length * 100;
                        const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length * 100;

                        return (
                          <div key={b.id} style={{ 
                            position: 'absolute', left: `${cx}%`, top: `${cy}%`,
                            transform: 'translate(-50%, -50%)',
                            background: 'rgba(13,17,23,0.9)', padding: '1px 4px', borderRadius: 2,
                            color: '#fff', fontSize: 8, fontWeight: 700, pointerEvents: 'none',
                            border: isActive ? `1px solid ${color}` : '1px solid rgba(255,255,255,0.15)',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0,
                            boxShadow: isActive ? `0 0 4px ${color}44` : 'none',
                            zIndex: isActive ? 20 : 10,
                            transition: 'all 0.3s ease'
                          }}>
                            <div style={{ opacity: 0.85, fontSize: 8 }}>
                              {isActive && <span style={{ marginRight: 2 }}>⚡</span>}{b.name}
                            </div>
                            <div style={{ 
                              color: isActive ? color : 'rgba(255,255,255,0.7)', 
                              fontSize: '9px', 
                              fontFamily: 'monospace', 
                              borderTop: '1px solid rgba(255,255,255,0.1)', 
                              paddingTop: 0, 
                              marginTop: 0, 
                              fontWeight: 800 
                            }}>
                              {aiStats.db != null ? `${aiStats.db.toFixed(1)} dB` : '-- dB'}
                            </div>
                          </div>
                        );
                    })}
                 </div>
               </>
             ) : (
               <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-muted)', fontSize: '.65rem' }}>KHÔNG CÓ LUỒNG</div>
             )}
          </div>
        </div>

        {/* Stats Card */}
        <div style={{ flex: 1, background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', borderRadius: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--admin-border)', background: 'var(--admin-layer-1)', fontSize: '.65rem', fontWeight: 800, color: 'var(--admin-text-muted)' }}>CHỈ SỐ THỰC TẾ</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 4, padding: '6px 12px', background: 'var(--admin-layer-2)', borderBottom: '1px solid var(--admin-border)', fontSize: '.52rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>
            <span>ĐỐI TƯỢNG</span> <span style={{ textAlign: 'right' }}>LIVE (dB)</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 10, borderBottom: '1px dashed var(--admin-border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.75rem', fontWeight: 700, color: 'var(--admin-text)' }}>
                <Zap size={14} style={{ color: 'var(--admin-accent)' }} /> Hiện tại
              </div>
              <div style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--admin-accent)', fontFamily: 'var(--font-mono)' }}>
                {aiStats.db != null ? aiStats.db.toFixed(1) : '--'} <span style={{fontSize:10}}>dB</span>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ background: 'rgba(0,0,0,0.1)', padding: '8px', borderRadius: 4, border: '1px solid var(--admin-border)' }}>
                <div style={{ fontSize: '9px', color: 'var(--admin-text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>Đỉnh (Peak)</div>
                <div style={{ fontSize: '1rem', fontWeight: 800, color: '#fff' }}>
                  {eventHistory.length > 0 ? Math.max(...eventHistory.map(h => h.db)).toFixed(1) : '--'}
                </div>
              </div>
              <div style={{ background: 'rgba(0,0,0,0.1)', padding: '8px', borderRadius: 4, border: '1px solid var(--admin-border)' }}>
                <div style={{ fontSize: '9px', color: 'var(--admin-text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>Số cảnh báo</div>
                <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--admin-warning)' }}>
                  {eventHistory.length}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* MAIN AREA */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, minWidth: 0 }}>
        
        {/* Chart Card */}
        <div style={{ flex: 1, background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', borderRadius: 0, padding: '20px', display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ fontSize: '.62rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '.8px', textAlign: 'center' }}>
              PHÂN TÍCH TẦN SUẤT VÀ CƯỜNG ĐỘ PHÓNG ĐIỆN
            </div>
          </div>
          <div style={{ flex: 1, position: 'relative' }}>
            <canvas ref={chartRef} />
          </div>
        </div>

        {/* Status Card */}
        <div style={{ background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', borderRadius: 0, padding: '12px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '.58rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '.8px' }}>LỊCH SỬ CẢNH BÁO</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <span style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--admin-text)' }}>GHI LẠI CÁC LẦN CẢNH BÁO</span>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--admin-accent)', animation: 'pulse 2s infinite' }} />
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '.58rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>TRẠNG THÁI GHI</div>
            <div style={{ fontSize: '.85rem', fontWeight: 700, color: 'var(--admin-accent)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>Chỉ ghi khi có cảnh báo</div>
          </div>
        </div>
      </div>
      
    </div>
  );
}
