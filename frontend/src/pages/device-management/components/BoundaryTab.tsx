// ============================================================
// BoundaryTab.tsx — Quản lý vùng Polygon (PD, ROI, Intrusion)
// Phục vụ Module 8: Frontend wire into module mới
// ============================================================

import { useState, useRef, useEffect, useCallback } from 'react';
import { CameraDevice, Boundary, stationApi } from '@/services/StationApiService';
import { Plus, Trash2, Save, X } from 'lucide-react';
import { API_BASE_URL } from '@/utils/env';
import { confirmDialog } from '@/utils/confirm';

type Props = { cameras: CameraDevice[]; initialCamera?: CameraDevice | null };

export default function BoundaryTab({ cameras, initialCamera }: Props) {
  const [cam, setCam] = useState<CameraDevice | null>(initialCamera ?? null);
  const [boundaries, setBoundaries] = useState<Boundary[]>([]);
  const [_loading, setLoading] = useState(false);
  
  // Trạng thái vẽ
  const [isDrawing, setIsDrawing] = useState(false);
  const [draftVertices, setDraftVertices] = useState<[number, number][]>([]);
  const [mousePos, setMousePos] = useState<[number, number] | null>(null);
  
  // Trạng thái edit
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({ name: '', type: 'pd', severity: 'warning' });

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const loadBoundaries = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const data = await stationApi.getBoundaries(id);
      setBoundaries(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (cam) loadBoundaries(cam.id);
  }, [cam, loadBoundaries]);

  // ── Drawing Logic ──────────────────────────────────────────

  const getPos = (e: React.MouseEvent | MouseEvent): [number, number] | null => {
    if (!containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isDrawing) return;
    const pos = getPos(e);
    if (pos) setDraftVertices([...draftVertices, pos]);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing) return;
    setMousePos(getPos(e));
  };

  const finishDrawing = () => {
    if (draftVertices.length < 3) {
      alert('Vùng phải có ít nhất 3 điểm.');
      return;
    }
    setIsDrawing(false);
    setEditingId('__new__');
    setFormData({ name: `Vùng mới ${boundaries.length + 1}`, type: 'pd', severity: 'warning' });
  };

  const cancelDrawing = () => {
    setIsDrawing(false);
    setDraftVertices([]);
    setMousePos(null);
  };

  // ── Render Loop ───────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      const w = canvas.width = canvas.clientWidth;
      const h = canvas.height = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);

      // 1. Vẽ các vùng đã lưu
      boundaries.forEach(b => {
        const poly: [number, number][] = typeof b.polygon === 'string' ? JSON.parse(b.polygon) : b.polygon;
        if (!poly || poly.length < 2) return;
        const startPt = poly[0];
        if (!startPt) return;

        ctx.beginPath();
        ctx.moveTo(startPt[0] * w, startPt[1] * h);
        for (let i = 1; i < poly.length; i++) {
          const pt = poly[i];
          if (pt) ctx.lineTo(pt[0] * w, pt[1] * h);
        }
        ctx.closePath();

        const color = b.severityLevel === 'alarm' ? 'rgba(239, 68, 68, 0.4)' : 'rgba(245, 158, 11, 0.4)';
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = b.severityLevel === 'alarm' ? '#ef4444' : '#f59e0b';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Label
        ctx.fillStyle = '#fff';
        ctx.font = '10px Inter, sans-serif';
        ctx.fillText(b.name.replace(/Vùng\s*/g, 'V'), startPt[0] * w, startPt[1] * h - 5);
      });

      // 2. Vẽ vùng đang vẽ (draft)
      if (draftVertices.length > 0) {
        const startPt = draftVertices[0];
        if (startPt) {
          ctx.beginPath();
          ctx.moveTo(startPt[0] * w, startPt[1] * h);
          for (let i = 1; i < draftVertices.length; i++) {
            const pt = draftVertices[i];
            if (pt) ctx.lineTo(pt[0] * w, pt[1] * h);
          }
          
          if (mousePos && isDrawing) {
            ctx.lineTo(mousePos[0] * w, mousePos[1] * h);
          }
          
          ctx.strokeStyle = '#3b82f6';
          ctx.setLineDash([5, 5]);
          ctx.stroke();
          ctx.setLineDash([]);

          // Vẽ các điểm nút
          draftVertices.forEach(v => {
            ctx.fillStyle = '#3b82f6';
            ctx.beginPath();
            ctx.arc(v[0] * w, v[1] * h, 4, 0, Math.PI * 2);
            ctx.fill();
          });
        }
      }
    };

    render();
    const timer = setInterval(render, 100);
    return () => clearInterval(timer);
  }, [boundaries, draftVertices, mousePos, isDrawing]);

  // ── CRUD Actions ──────────────────────────────────────────

  const handleSave = async () => {
    if (!cam) return;
    try {
      const payload = {
        name: formData.name,
        type: formData.type,
        polygon: JSON.stringify(draftVertices),
        severityLevel: formData.severity as 'info' | 'warning' | 'alarm',
        enabled: true
      };

      if (editingId === '__new__') {
        await stationApi.createBoundary(cam.id, payload);
      } else if (editingId) {
        await stationApi.updateBoundary(editingId, payload);
      }

      setEditingId(null);
      setDraftVertices([]);
      loadBoundaries(cam.id);
    } catch (e) {
      alert('Lỗi khi lưu vùng');
    }
  };

  const handleDelete = async (id: string) => {
    if (!await confirmDialog({ title: 'Xóa vùng', message: 'Bạn có chắc chắn muốn xóa vùng này?', confirmText: 'Xóa', danger: true })) return;
    try {
      await stationApi.deleteBoundary(id);
      if (cam) loadBoundaries(cam.id);
    } catch (e) {
      alert('Lỗi khi xóa');
    }
  };

  return (
    <div style={{ display:'flex', flex:1, gap:8, overflow:'hidden', minHeight:0 }}>
      {/* Sidebar: Camera & Boundaries List */}
      <div className="admin-card" style={{ width:260, flexShrink:0, display:'flex', flexDirection:'column', padding:0, overflow:'hidden' }}>
        <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--admin-border)', fontSize:'.7rem', fontWeight:800, color:'var(--admin-text-muted)' }}>
          CAMERA & VÙNG GIÁM SÁT
        </div>
        <div style={{ padding: 10 }}>
          <select className="admin-input" style={{ width: '100%' }} value={cam?.id} onChange={e => setCam(cameras.find(c => c.id === e.target.value) || null)}>
            <option value="">Chọn Camera...</option>
            {cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div style={{ flex:1, overflowY:'auto', borderTop:'1px solid var(--admin-border)' }}>
          {boundaries.length === 0 ? (
            <div style={{ padding:20, textAlign:'center', fontSize:'.8rem', color:'var(--admin-text-muted)' }}>Chưa có vùng nào.</div>
          ) : (
            boundaries.map(b => (
              <div key={b.id} className="list-item" style={{ padding:10, borderBottom:'1px solid var(--admin-border)', display:'flex', alignItems:'center', gap:8 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:'.85rem', fontWeight:700 }}>{b.name.replace(/Vùng\s*/g, 'V')}</div>
                  <div style={{ fontSize:'.7rem', color:'var(--admin-text-muted)' }}>{b.type.toUpperCase()} • {b.severityLevel}</div>
                </div>
                <button className="btn-icon" onClick={() => handleDelete(b.id)}><Trash2 size={14}/></button>
              </div>
            ))
          )}
        </div>

        {cam && !isDrawing && !editingId && (
          <div style={{ padding:10 }}>
            <button className="btn-industrial btn-primary" style={{ width:'100%' }} onClick={() => setIsDrawing(true)}>
              <Plus size={16} style={{ marginRight: 4 }}/> VẼ VÙNG MỚI
            </button>
          </div>
        )}
      </div>

      {/* Main Area: Canvas drawing */}
      <div className="admin-card" style={{ flex:1, padding:0, position:'relative', background:'#000', overflow:'hidden' }}>
        {cam ? (
          <div ref={containerRef} style={{ width:'100%', height:'100%', position:'relative' }} 
               onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}>
            
            {/* Live stream background (mock for now or real) */}
            <img 
              src={`${API_BASE_URL}/api/v1/devices/${cam.id}/snapshot?_t=${Date.now()}`}
              style={{ width:'100%', height:'100%', objectFit:'contain' }}
              alt="Live"
            />

            <canvas ref={canvasRef} style={{ position:'absolute', top:0, left:0, width:'100%', height:'100%', cursor: isDrawing ? 'crosshair' : 'default' }} />

            {/* Drawing Toolbar Overlay */}
            {isDrawing && (
              <div style={{ position:'absolute', top:10, left:10, background:'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)', padding:'8px 12px', borderRadius:4, display:'flex', gap:10, alignItems:'center', border:'1px solid #3b82f6', boxShadow:'0 4px 20px rgba(0,0,0,0.5)' }}>
                <span style={{ fontSize:'.8rem', color:'#3b82f6', fontWeight:700 }}>ĐANG VẼ POLYGON ({draftVertices.length} điểm)</span>
                <button className="btn-industrial btn-primary" onClick={finishDrawing} disabled={draftVertices.length < 3}>XÁC NHẬN</button>
                <button className="btn-industrial" onClick={cancelDrawing}>HỦY</button>
                <div style={{ fontSize:'.7rem', opacity:.7 }}>Click để thêm điểm, Enter/Click nút để xong</div>
              </div>
            )}

            {/* Editing Form Overlay */}
            {editingId && (
              <div style={{ position:'absolute', bottom:20, right:20, width:280, background:'var(--admin-panel)', border:'1px solid var(--admin-border)', padding:16, boxShadow:'0 10px 25px rgba(0,0,0,0.5)', borderRadius: 4 }}>
                <div style={{ fontSize:'.85rem', fontWeight:800, marginBottom:12, color:'var(--admin-accent)', letterSpacing: '.5px' }}>THÔNG TIN VÙNG</div>
                <div style={{ marginBottom:10 }}>
                  <label style={{ display:'block', fontSize:'.7rem', marginBottom:4, opacity:.7, fontWeight: 700 }}>TÊN VÙNG</label>
                  <input className="form-input" style={{ width:'100%' }} value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:16 }}>
                  <div>
                    <label style={{ display:'block', fontSize:'.7rem', marginBottom:4, opacity:.7, fontWeight: 700 }}>LOẠI</label>
                    <select className="form-select" style={{ width:'100%', padding: '4px 8px' }} value={formData.type} onChange={e => setFormData({...formData, type: e.target.value})}>
                      <option value="pd">Phóng điện</option>
                      <option value="intrusion">Xâm nhập</option>
                      <option value="roi">Nhiệt (ROI)</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display:'block', fontSize:'.7rem', marginBottom:4, opacity:.7, fontWeight: 700 }}>MỨC ĐỘ</label>
                    <select className="form-select" style={{ width:'100%', padding: '4px 8px' }} value={formData.severity} onChange={e => setFormData({...formData, severity: e.target.value})}>
                      <option value="warning">Cảnh báo</option>
                      <option value="alarm">Báo động</option>
                    </select>
                  </div>
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <button className="btn-industrial btn-primary" style={{ flex:1 }} onClick={handleSave}><Save size={14} style={{ marginRight: 4 }}/> LƯU</button>
                  <button className="btn-industrial" onClick={() => setEditingId(null)}><X size={14} style={{ marginRight: 4 }}/> HỦY</button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:'var(--admin-text-muted)' }}>
            Chọn camera để cấu hình vùng giám sát.
          </div>
        )}
      </div>
    </div>
  );
}
