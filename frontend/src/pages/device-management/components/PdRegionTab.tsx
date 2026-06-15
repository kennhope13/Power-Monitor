// ============================================================
// PdRegionTab.tsx — Vẽ vùng Phóng điện (PD) trực tiếp trên WebRTC stream
// Refactored to match ThermalConfigTab style
// CRUD qua BoundaryService (Backend API) + notify AI Engine reload
// ============================================================

import { useState, useRef, useEffect, useCallback } from 'react';
import { CameraDevice, Boundary, stationApi } from '@/services/StationApiService';
import { Trash2, Save, X, Edit2 } from 'lucide-react';
import { authService } from '@/services/AuthService';
import { GO2RTC_URL, API_BASE_URL, AI_ENGINE_URL } from '@/utils/env';
import { confirmDialog } from '@/utils/confirm';

type Props = { 
  cameras: CameraDevice[]; 
  initialCamera: CameraDevice; 
  onBack?: () => void 
};

const EMPTY_FORM = {
  id: '', code: '', fullName: '',
  severity: 'warning' as 'warning' | 'alarm',
  strokeWidth: '2', labelPosition: 'bottom', fontSize: '14',
  warnDb: '20', alarmDb: '35',
  isNew: true, open: false
};

/** Thông báo AI Engine reload vùng PD — fire-and-forget */
const notifyAiEngine = async (deviceId: string, streamId: string) => {
  try {
    const token = authService.getToken() || '';
    const backend = API_BASE_URL.replace('/api/v1', '');
    const fetchUrl = `${AI_ENGINE_URL}/config/pd-regions?token=${token}&backend=${backend}`;
    await fetch(fetchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, stream_id: streamId })
    });
  } catch { /* ignore */ }
};

export default function PdRegionTab({ initialCamera: cam }: Props) {
  const [boundaries, setBoundaries] = useState<Boundary[]>([]);

  // Drawing State
  const [drawMode, setDrawMode] = useState<'none' | 'polygon'>('none');
  const [draftVertices, setDraftVertices] = useState<[number, number][]>([]);
  const [mousePos, setMousePos] = useState<[number, number] | null>(null);

  // Form State
  const [form, setForm] = useState(EMPTY_FORM);
  const [dragVertex, setDragVertex] = useState<number | null>(null);
  const [dragPoly, setDragPoly] = useState<boolean>(false);

  // Realtime State
  const [aiStats, setAiStats] = useState<{ 
    db?: number | null, 
    hz?: number | null, 
    active_boundary?: string | null,
    discharge_counts?: Record<string, number> | null
  }>({});

  const overlayRef = useRef<HTMLDivElement>(null);

  const loadBoundaries = useCallback(async (id: string) => {
    try {
      const data = await stationApi.getBoundaries(id, 'pd');
      setBoundaries(data);
    } catch (e) {
      console.error('[PdRegionTab] Load boundaries failed:', e);
    }
  }, []);

  useEffect(() => {
    if (cam) loadBoundaries(cam.id);
  }, [cam, loadBoundaries]);

  useEffect(() => {
    if (!cam) return;
    let timer: any;
    const fetchStats = async () => {
      try {
        const token = authService.getToken() || '';
        const backend = API_BASE_URL.replace('/api/v1', '');
        const fetchUrl = `${AI_ENGINE_URL}/pd-monitor/${cam.id}/state?token=${token}&backend=${backend}`;
        const res = await fetch(fetchUrl);
        if (res.ok) {
          const data = await res.json();
          setAiStats({
            db: data.db,
            hz: data.hz,
            active_boundary: data.active_boundary,
            discharge_counts: data.discharge_counts,
          });
        }
      } catch {}
      timer = setTimeout(fetchStats, 600);
    };
    fetchStats();
    return () => clearTimeout(timer);
  }, [cam]);

  const getPos = (e: React.MouseEvent): [number, number] | null => {
    if (!overlayRef.current) return null;
    const rect = overlayRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const pos = getPos(e);
    if (!pos) return;

    if (drawMode === 'polygon') {
      setDraftVertices(prev => [...prev, pos]);
      return;
    }

    if (form.open) {
      const radius = 0.03;
      for (let i = 0; i < draftVertices.length; i++) {
        const v = draftVertices[i];
        if (!v) continue;
        const dx = v[0] - pos[0], dy = v[1] - pos[1];
        if (dx*dx + dy*dy < radius*radius) {
          setDragVertex(i);
          return;
        }
      }
      const minX = Math.min(...draftVertices.map(v => v[0])), maxX = Math.max(...draftVertices.map(v => v[0]));
      const minY = Math.min(...draftVertices.map(v => v[1])), maxY = Math.max(...draftVertices.map(v => v[1]));
      if (pos[0] >= minX && pos[0] <= maxX && pos[1] >= minY && pos[1] <= maxY) {
        setDragPoly(true);
        setMousePos(pos);
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const pos = getPos(e);
    if (!pos) return;

    if (drawMode === 'polygon') {
      setMousePos(pos);
    } else if (form.open) {
      if (dragVertex !== null) {
        const newVertices = [...draftVertices];
        newVertices[dragVertex] = pos;
        setDraftVertices(newVertices);
      } else if (dragPoly && mousePos) {
        const dx = pos[0] - mousePos[0], dy = pos[1] - mousePos[1];
        setDraftVertices(draftVertices.map(v => [v[0] + dx, v[1] + dy] as [number, number]));
        setMousePos(pos);
      }
    }
  };

  const handleMouseUp = () => { setDragVertex(null); setDragPoly(false); };

  const startNewZone = () => {
    setDrawMode('polygon');
    setDraftVertices([]);
    setMousePos(null);
    setForm(EMPTY_FORM);
  };

  const finishPolygon = () => {
    if (draftVertices.length < 3) return;
    setDrawMode('none');
    setForm({
      ...EMPTY_FORM,
      open: true, isNew: true,
      code: `PD_${boundaries.length + 1}`,
      fullName: `Vùng PD ${boundaries.length + 1}`
    });
  };

  const cancelDrawing = () => {
    setDrawMode('none');
    setDraftVertices([]);
    setForm(EMPTY_FORM);
  };

  const handleSave = async () => {
    if (!cam || !form.code.trim()) return;
    
    const actionLabel = form.isNew ? 'Thêm mới' : 'Cập nhật';
    if (!await confirmDialog({
      title: `${actionLabel} vùng PD`,
      message: `Bạn có chắc chắn muốn ${actionLabel.toLowerCase()} vùng "${form.code}" không?`,
      confirmText: actionLabel
    })) return;

    try {
      const payload: Partial<Boundary> = {
        name: form.code.trim(),
        type: 'pd',
        polygon: JSON.stringify(draftVertices),
        thresholds: JSON.stringify({
          fullName: form.fullName.trim(),
          strokeWidth: form.strokeWidth,
          labelPos: form.labelPosition,
          fontSize: form.fontSize,
          warn: parseFloat(form.warnDb) || 20,
          alarm: parseFloat(form.alarmDb) || 35,
        }),
        severityLevel: form.severity,
        enabled: true,
      };

      if (form.isNew) {
        await stationApi.createBoundary(cam.id, payload);
      } else {
        await stationApi.updateBoundary(form.id, payload);
      }

      await notifyAiEngine(cam.id, cam.config?.go2rtc_id || '');
      setForm(EMPTY_FORM);
      setDraftVertices([]);
      loadBoundaries(cam.id);
    } catch (e: any) {
      console.error(e);
      alert(e.message || 'Lỗi khi lưu vùng PD');
    }
  };

  const handleDelete = async (b: Boundary) => {
    if (!await confirmDialog({
      title: 'Xóa vùng PD',
      message: `Xóa vùng "${b.name}"? Hệ thống sẽ ngừng giám sát phóng điện tại đây.`,
      confirmText: 'Xóa vùng',
      danger: true,
    })) return;
    try {
      await stationApi.deleteBoundary(b.id);
      await notifyAiEngine(cam.id, cam.config?.go2rtc_id || '');
      loadBoundaries(cam.id);
    } catch (e) { console.error(e); }
  };

  const openEdit = (b: Boundary) => {
    try {
      const poly = JSON.parse(b.polygon);
      let t: any = {};
      try { t = JSON.parse(b.thresholds || '{}'); } catch {}
      setDraftVertices(poly);
      setForm({
        id: b.id, open: true, isNew: false,
        code: b.name, fullName: t.fullName || b.name,
        severity: (b.severityLevel as any) || 'warning',
        strokeWidth: t.strokeWidth || '2',
        labelPosition: t.labelPos || 'bottom',
        fontSize: t.fontSize || '14',
        warnDb: String(t.warn || 20),
        alarmDb: String(t.alarm || 35),
      });
      setDrawMode('none');
    } catch { console.error('Failed to edit'); }
  };

  const go2rtcId = cam.config?.go2rtc_id || '';
  const streamUrl = go2rtcId ? `/camera-stream.html?src=${encodeURIComponent(go2rtcId)}&mode=webrtc,mse&go2rtc=${GO2RTC_URL}` : '';
  const toSvg = (vs: [number, number][]) => vs.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden', background:'var(--admin-bg)' }}>
      {/* ── Main area ── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', minWidth:0 }}>
        
        {/* Top Toolbar */}
        <div style={{ display:'flex', alignItems:'center', gap:16, padding:'6px 10px', background:'var(--admin-layer-1)', borderBottom:'1px solid var(--admin-border)', flexShrink:0 }}>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: '.7rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>
             PD - <span style={{ color: 'var(--admin-text)' }}>{cam.name}</span>
          </div>
        </div>

        {/* Video Area */}
        <div style={{ flex:1, position:'relative', background:'#000', overflow:'hidden' }}>
          {streamUrl ? (
            <iframe src={streamUrl} style={{ position:'absolute', inset:0, width:'100%', height:'100%', border:'none', pointerEvents:'none', zIndex:1 }} />
          ) : (
            <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:'#64748b' }}>Không có luồng Video</div>
          )}

          <div ref={overlayRef} style={{ position:'absolute', inset:0, zIndex:10, cursor: drawMode!=='none'?'crosshair':'default' }}
               onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}>
            
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position:'absolute', inset:0, width:'100%', height:'100%', overflow:'visible' }}>
              {/* Vùng đã lưu */}
              {boundaries.filter(b => b.id !== form.id).map(b => {
                let poly: any = []; try { poly = JSON.parse(b.polygon); } catch { return null; }
                const isActive = aiStats.active_boundary === b.name;
                const currentDb = isActive ? aiStats.db : null;

                let warnDb = 20, alarmDb = 35;
                try {
                  const t = JSON.parse(b.thresholds || '{}');
                  warnDb = t.warn || t.warning || 20;
                  alarmDb = t.alarm || 35;
                } catch {}

                const isAlarm = currentDb != null && currentDb >= alarmDb;
                const isWarning = currentDb != null && currentDb >= warnDb;
                const c = isActive ? (isAlarm ? '#ef4444' : isWarning ? '#fbbf24' : '#10b981') : '#10b981';

                return <polygon key={b.id} points={toSvg(poly)} fill={c+'10'} stroke={c} strokeWidth={isActive?3:1.5} vectorEffect="non-scaling-stroke" />;
              })}

              {/* Vùng đang vẽ/sửa */}
              {(drawMode==='polygon' || form.open) && draftVertices.length > 0 && (
                <>
                  <polygon points={toSvg([...draftVertices, ...(mousePos && drawMode==='polygon' ? [mousePos] : [])])} fill="rgba(0,255,0,0.08)" stroke="#00ff00" strokeWidth={2} strokeDasharray="4 2" vectorEffect="non-scaling-stroke" />
                  {draftVertices.map(([vx, vy], i) => <circle key={i} cx={vx*100} cy={vy*100} r="1.2" fill="#00ff00" stroke="#fff" strokeWidth={0.5} />)}
                </>
              )}
            </svg>

            {/* Labels */}
            {boundaries.filter(b => b.id !== form.id).map(b => {
              let poly: any = []; try { poly = JSON.parse(b.polygon); } catch { return null; }
              const cx = poly.reduce((s:any, p:any) => s + p[0], 0) / poly.length * 100;
              const cy = poly.reduce((s:any, p:any) => s + p[1], 0) / poly.length * 100;
              
              const isActive = aiStats.active_boundary === b.name;
              const currentDb = isActive ? aiStats.db : 0;

              // Lấy tên chi tiết từ thresholds
              let displayName = b.name;
              let warnDb = 20, alarmDb = 35;
              try {
                const t = JSON.parse(b.thresholds || '{}');
                if (t.fullName) displayName = t.fullName;
                warnDb = t.warn || t.warning || 20;
                alarmDb = t.alarm || 35;
              } catch {}

              const isAlarm = currentDb != null && currentDb >= alarmDb;
              const isWarning = currentDb != null && currentDb >= warnDb;
              const statusColor = isAlarm ? '#ef4444' : isWarning ? '#fbbf24' : '#10b981';

              const count = aiStats.discharge_counts?.[b.name] || 0;
              const displayDb = aiStats.db ?? null;
              const displayHz = aiStats.hz ?? null;

              return (
                <div key={b.id} style={{ 
                  position:'absolute', left:`${cx}%`, top:`${cy}%`, transform:'translate(-50%,-50%)', 
                  background:'rgba(10,14,20,0.88)', padding:'5px 8px', borderRadius: 3,
                  color:'#fff', pointerEvents:'none',
                  border: `1px solid ${isActive ? statusColor : 'rgba(255,255,255,0.2)'}`,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
                  boxShadow: isActive ? `0 0 10px ${statusColor}55` : 'none',
                  zIndex: isActive ? 20 : 10,
                  transition: 'all 0.3s ease',
                  minWidth: 70,
                }}>
                  {/* dB — số lớn */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
                    <span style={{
                      fontSize: isActive ? 20 : 14, fontWeight: 900, fontFamily: 'monospace', lineHeight: 1,
                      color: isActive ? statusColor : 'rgba(255,255,255,0.55)',
                    }}>
                      {displayDb != null ? displayDb.toFixed(1) : '--'}
                    </span>
                    <span style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.4)' }}>dB</span>
                  </div>
                  {/* Hz */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
                    <span style={{ fontSize: 10, fontWeight: 800, fontFamily: 'monospace', color: 'rgba(255,255,255,0.7)' }}>
                      {displayHz != null ? (displayHz / 1000).toFixed(1) : '--'}
                    </span>
                    <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.35)' }}>kHz</span>
                  </div>
                  {/* Tên vùng + số lần */}
                  <div style={{ fontSize: 8, opacity: 0.7, borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 2, marginTop: 1 }}>
                    {isActive && <span style={{ marginRight: 2 }}>⚡</span>}{displayName} ({count})
                  </div>
                </div>
              );
            })}
          </div>

          {/* Draw Mode Tooltip */}
          {drawMode === 'polygon' && (
            <div style={{ position:'absolute', top:12, left:12, zIndex:20, background:'rgba(0,0,0,0.85)', padding:'8px 12px', border:'1px solid #00ff00', borderRadius:4, display:'flex', gap:10, alignItems:'center' }}>
              <span style={{ color:'#00ff00', fontWeight:700, fontSize:'.75rem' }}>✦ ĐANG VẼ ĐA GIÁC ({draftVertices.length} điểm)</span>
              {draftVertices.length >= 3 && <button className="btn-industrial btn-primary btn-sm" onClick={finishPolygon}>✓ XONG</button>}
              <button className="btn-industrial btn-sm" onClick={cancelDrawing}>HỦY</button>
            </div>
          )}
        </div>
      </div>


      {/* ── Sidebar ── */}
      <div style={{ width:280, borderLeft:'1px solid var(--admin-border)', background:'var(--admin-layer-1)', display:'flex', flexDirection:'column', flexShrink:0 }}>
        {form.open ? (
          <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>
            <div style={{ padding:'12px', borderBottom:'1px solid var(--admin-border)', display:'flex', justifyContent:'space-between', alignItems:'center', fontWeight:800, fontSize:'.85rem' }}>
              <span>{form.isNew ? 'THÊM VÙNG PD' : 'SỬA VÙNG PD'}</span>
              <button className="btn-industrial btn-sm" onClick={()=>setForm(EMPTY_FORM)}><X size={12}/></button>
            </div>
            <div style={{ padding:14, display:'flex', flexDirection:'column', gap:12, overflowY:'auto' }}>
              <div className="form-group"><label>Mã vùng (Ký hiệu)</label><input className="form-input" value={form.code} onChange={e=>setForm(f=>({...f,code:e.target.value}))} autoFocus /></div>
              <div className="form-group"><label>Tên vùng (Chi tiết)</label><input className="form-input" value={form.fullName} onChange={e=>setForm(f=>({...f,fullName:e.target.value}))} /></div>
              
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                <div className="form-group"><label>Mức độ</label>
                  <select className="form-select" value={form.severity} onChange={e=>setForm(f=>({...f,severity:e.target.value as any}))}>
                    <option value="warning">Cảnh báo</option>
                    <option value="alarm">Báo động</option>
                  </select>
                </div>
                <div className="form-group"><label>Viền (px)</label>
                  <select className="form-select" value={form.strokeWidth} onChange={e=>setForm(f=>({...f,strokeWidth:e.target.value}))}>
                    <option value="1">1px</option>
                    <option value="2">2px</option>
                    <option value="3">3px</option>
                  </select>
                </div>
              </div>

              <div style={{ background:'rgba(239,68,68,0.05)', padding:12, border:'1px solid rgba(239,68,68,0.15)', borderRadius:4 }}>
                <div style={{ fontSize:'.65rem', fontWeight:800, color:'#ef4444', marginBottom:12, letterSpacing: '0.5px' }}>NGƯỠNG KÍCH HOẠT (dB)</div>
                <div style={{ display:'flex', flexDirection: 'column', gap:10 }}>
                  <div className="form-group" style={{ marginBottom:0 }}>
                    <label style={{fontSize:9, color: 'var(--admin-text-muted)'}}>CẢNH BÁO</label>
                    <div style={{ position: 'relative' }}>
                      <input type="number" className="form-input" style={{ paddingRight: 30 }} value={form.warnDb} onChange={e=>setForm(f=>({...f,warnDb:e.target.value}))}/>
                      <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 10, opacity: 0.5 }}>dB</span>
                    </div>
                  </div>
                  <div className="form-group" style={{ marginBottom:0 }}>
                    <label style={{fontSize:9, color: 'var(--admin-text-muted)'}}>BÁO ĐỘNG</label>
                    <div style={{ position: 'relative' }}>
                      <input type="number" className="form-input" style={{ paddingRight: 30 }} value={form.alarmDb} onChange={e=>setForm(f=>({...f,alarmDb:e.target.value}))}/>
                      <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 10, opacity: 0.5 }}>dB</span>
                    </div>
                  </div>
                </div>
                <div style={{ fontSize:10, marginTop:12, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.05)', color:'var(--admin-text-muted)' }}>
                  Giá trị hiện tại: <b style={{color:'var(--admin-accent)', fontFamily: 'monospace'}}>{aiStats.db?.toFixed(1) ?? '--'} dB</b>
                </div>
              </div>

              <div style={{ display:'flex', gap:10, marginTop:10 }}>
                <button className="btn-industrial" style={{ flex:1 }} onClick={()=>{ setForm(EMPTY_FORM); setDraftVertices([]); }}>Hủy</button>
                <button className="btn-industrial btn-primary" style={{ flex:1 }} onClick={handleSave}><Save size={14}/> Lưu</button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div style={{ padding:'12px', borderBottom:'1px solid var(--admin-border)', fontWeight:800, fontSize:'.7rem', color:'var(--admin-text-muted)', letterSpacing:'1px', textTransform: 'uppercase' }}>DANH SÁCH VÙNG PD ({boundaries.length})</div>
            
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--admin-border)' }}>
              <button 
                className="btn-industrial btn-primary" 
                style={{ width: '100%', fontSize: '.65rem', height: 28, fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase' }}
                onClick={startNewZone}
              >
                + Thêm vùng PD
              </button>
            </div>

            <div style={{ flex:1, overflowY:'auto' }}>
              {boundaries.length === 0 ? (
                <div style={{ padding:30, textAlign:'center', color:'var(--admin-text-muted)', fontSize:'.75rem' }}>Chưa có vùng PD nào</div>
              ) : [...boundaries].sort((a,b)=>a.name.localeCompare(b.name, undefined, {numeric:true})).map(b => {
                const isActive = aiStats.active_boundary === b.name;
                const c = isActive ? '#ef4444' : (b.severityLevel==='alarm'?'#f59e0b':'#10b981');
                return (
                  <div key={b.id} onClick={()=>openEdit(b)} style={{ padding:'10px 12px', borderBottom:'1px solid var(--admin-border)', display:'flex', alignItems:'center', gap:10, cursor:'pointer', background: isActive ? c+'08' : 'transparent', borderLeft: `3px solid ${isActive?c:'transparent'}` }}>
                    <div style={{ width:8, height:8, background:c, borderRadius:2 }} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:'.85rem', fontWeight:800, color:'var(--admin-text)' }}>{b.name}</div>
                      <div style={{ fontSize:'.65rem', color:c, fontWeight:700 }}>{b.severityLevel==='alarm'?'BÁO ĐỘNG':'CẢNH BÁO'}</div>
                    </div>
                    <div style={{ display:'flex', gap:4 }}>
                      <button className="btn-industrial btn-sm" style={{ padding:4 }} onClick={(e)=>{ e.stopPropagation(); openEdit(b); }}><Edit2 size={13}/></button>
                      <button className="btn-industrial btn-sm btn-danger" style={{ padding:4 }} onClick={(e)=>{ e.stopPropagation(); handleDelete(b); }}><Trash2 size={13}/></button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
