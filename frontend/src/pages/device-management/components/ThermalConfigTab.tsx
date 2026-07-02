import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Save, Trash2, Edit2, X } from 'lucide-react';
import { stationApi } from '../../../services/StationApiService';
import { CameraDevice } from '../../../types/api.types';
import { authService } from '../../../services/AuthService';
import { GO2RTC_URL } from '../../../utils/env';
import { createRealtimeHub } from '../../../services/realtime.service';
import { confirmDialog } from '@/utils/confirm';

type VVR = { x:number, y:number, width:number, height:number };

const EMPTY_FORM = {
  open: false, isNew: true, type: 'marker' as 'marker'|'roi',
  id: '', name: '', shortName: '',
  tx: '', ty: '', tx1: '', ty1: '', tx2: '', ty2: '',
  preAlarm: '50', alarm: '70', markerSize: '10', labelPos: 'top',
  fontSize: '11', borderWidth: '0.5'
};

const pct = (v:number) => `${(v*100).toFixed(2)}%`;
const clr = (t:number|null, w:number, a:number) => t==null?'#9ca3af':t>=a?'#ef4444':t>=w?'#f59e0b':'#10b981';

export default function ThermalConfigTab({ device: dev }: { device:CameraDevice, onBack?:()=>void, onConfigChange?:()=>void, loading?:boolean }) {
  const did = dev.id;
  const [markers, setMarkers] = useState<any[]>([]);
  const [rois, setRois] = useState<any[]>([]);
  const [selectedMarkerIds, setSelectedMarkerIds] = useState<string[]>([]);
  const [selectedRoiIds, setSelectedRoiIds] = useState<string[]>([]);
  const mksRef = useRef(markers); mksRef.current = markers;
  const roisRef = useRef(rois); roisRef.current = rois;
  const [vvr, setVvr] = useState<VVR>(() => {
    const cfg = dev.config || {};
    const focalOpt = cfg.focal_length_optical;
    const focalTh = cfg.focal_length_thermal;
    if (focalOpt != null && focalTh != null && Number(focalOpt) === Number(focalTh)) {
      return { x: 0, y: 0, width: 1, height: 1 };
    }
    return { x: 0.2, y: 0.084, width: 0.63, height: 0.841 };
  });
  
  const [viewMode, setViewMode] = useState<'op'|'th'>('op');
  const [drawMode, setDrawMode] = useState<'none'|'point'|'rect'>('none');
  const dragMkRef = useRef<string|null>(null);
  const [dragRoi, setDragRoi] = useState<{sx:number,sy:number,ex:number,ey:number}|null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [cursor, setCursor] = useState<{temp:number, px:number, py:number}|null>(null);
  const [hoverPos, setHoverPos] = useState<{nx:number,ny:number}|null>(null);

  const [activeSideTab, setActiveSideTab] = useState<'marker'|'roi'>('marker');
  const [showVvr, setShowVvr] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const cursorTimer = useRef<any>(null);


  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [overlayOpacity, setOverlayOpacity] = useState<number>(0);

  // Trạng thái nhấn kéo di chuyển (Pan)
  const isPanningRef = useRef<boolean>(false);
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const panStartXRef = useRef<number>(0);
  const panStartYRef = useRef<number>(0);
  const panScrollLeftRef = useRef<number>(0);
  const panScrollTopRef = useRef<number>(0);
  const panDraggedRef = useRef<boolean>(false);

  useEffect(() => {
    const wrap = containerRef.current;
    if (!wrap) return;

    const handleWheelRaw = (e: WheelEvent) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const contentX = (mouseX + wrap.scrollLeft) / (zoomLevel / 100);
      const contentY = (mouseY + wrap.scrollTop) / (zoomLevel / 100);

      const zoomStep = 10;
      const oldZoom = zoomLevel;
      let newZoom = oldZoom;
      if (e.deltaY < 0) {
        if (oldZoom < 300) {
          newZoom = oldZoom + zoomStep;
        }
      } else {
        if (oldZoom > 100) {
          newZoom = oldZoom - zoomStep;
        }
      }

      if (newZoom !== oldZoom) {
        setZoomLevel(newZoom);
        const zoomFactor = newZoom / oldZoom;
        
        requestAnimationFrame(() => {
          wrap.scrollLeft = contentX * zoomFactor - mouseX;
          wrap.scrollTop = contentY * zoomFactor - mouseY;
        });
      }
    };

    wrap.addEventListener('wheel', handleWheelRaw, { passive: false });
    return () => {
      wrap.removeEventListener('wheel', handleWheelRaw);
    };
  }, [zoomLevel]);

  const opSrc = dev.config?.go2rtc_optical || `cam_${(dev.config?.ip||'').replace(/\./g,'_')}_optical`;
  const thSrc = dev.config?.go2rtc_thermal || dev.config?.go2rtc_id || `cam_${(dev.config?.ip||'').replace(/\./g,'_')}_thermal`;

  const load = useCallback(async () => {
    try {
      const [pts, rjs] = await Promise.all([
        stationApi.getRoiPoints(did),
        stationApi.getBoundaries(did, 'roi')
      ]);
      setMarkers(prev => {
        const prevTemps: Record<string,number|null> = Object.fromEntries(prev.map(m=>[m.id, m.temp]));
        return pts.map(p => ({
          id:p.id, name:p.name, shortName:p.pointId,
          tx:p.tx||0.5, ty:p.ty||0.5, ox:p.ox||0.5, oy:p.oy||0.5,
          preAlarm:p.warningThreshold||50, alarm:p.alarmThreshold||70,
          markerSize:p.sortOrder||10, labelPos:(p as any).description||'top',
          temp: prevTemps[p.id] ?? null
        }));
      });
      setRois(prev => {
        const prevTemps: Record<string,number|null> = Object.fromEntries(prev.map(r=>[r.id, r.maxTemp]));
        return rjs.map(r => {
          let p:any=[]; try{ p=JSON.parse(r.polygon); }catch{}
          let t:any={}; try{ t=JSON.parse(r.thresholds||'{}'); }catch{}
          if(p.length<4) return null;
          const xs = p.map((x:any)=>x[0]), ys = p.map((x:any)=>x[1]);
          return {
            id:r.id, name:r.name,
            tx1:Math.min(...xs), ty1:Math.min(...ys), tx2:Math.max(...xs), ty2:Math.max(...ys),
            preAlarm:t.warning||t.preAlarm||50, alarm:t.alarm||70,
            maxTemp: prevTemps[r.id] ?? null,
            labelPos: t.labelPos || 'top', fontSize: t.fontSize || 11, borderWidth: t.borderWidth || 0.5
          };
        }).filter(Boolean);
      });
    } catch(e) {}
  }, [did]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const markerIds = new Set(markers.map(m => m.id));
    const roiIds = new Set(rois.map(r => r.id));
    setSelectedMarkerIds(prev => prev.filter(id => markerIds.has(id)));
    setSelectedRoiIds(prev => prev.filter(id => roiIds.has(id)));
  }, [markers, rois]);

  // Lắng nghe SignalR SensorUpdate — cùng nguồn với realtime page
  useEffect(() => {
    const hub = createRealtimeHub();
    hub.on('SensorUpdate', (data: any[]) => {
      if (!Array.isArray(data)) return;
      const mine = data.filter(d => d.deviceId === did || d.deviceId?.toLowerCase() === did.toLowerCase());
      if (!mine.length) return;
      setMarkers(prev => prev.map(m => {
        const upd = mine.find(u =>
          (u.pointId && (u.pointId === m.shortName || u.pointId === m.name)) ||
          (u.tx != null && Math.abs(u.tx - m.tx) < 0.002 && Math.abs(u.ty - m.ty) < 0.002)
        );
        return upd ? { ...m, temp: upd.value } : m;
      }));
      setRois(prev => prev.map(r => {
        const upd = mine.find(u => u.roiId === r.id || u.pointId === r.name);
        return upd?.max != null ? { ...r, maxTemp: upd.max } : r;
      }));
    });
    hub.start().catch(() => {});
    return () => { hub.stop(); };
  }, [did]);

  useEffect(() => {
    let timer:any;
    const poll = async () => {
      const mks = mksRef.current;
      const rs  = roisRef.current;
      if(mks.length===0 && rs.length===0 && !form.open) { timer = setTimeout(poll, 600); return; }
      try {
        const res = await fetch(`/api/v1/devices/${did}/thermal/live-temps`, {
          method:'POST',
          headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${authService.getToken()}` },
          body: JSON.stringify({
            points: [
              ...mks.map(m=>({ id:m.id, x:m.tx, y:m.ty })),
              ...(form.open && form.type==='marker' && form.tx ? [{ id:'__form__', x:parseFloat(form.tx), y:parseFloat(form.ty) }] : [])
            ],
            rois: rs.map(r=>({ id:r.id, x1:r.tx1, y1:r.ty1, x2:r.tx2, y2:r.ty2 })),
          }),
        });
        if(res.ok) {
          const d = await res.json();
          if(d.mapping) {
            const cfg = dev.config || {};
            const focalOpt = cfg.focal_length_optical;
            const focalTh = cfg.focal_length_thermal;
            if (focalOpt != null && focalTh != null && Number(focalOpt) === Number(focalTh)) {
              setVvr({ x: 0, y: 0, width: 1, height: 1 });
            } else {
              setVvr(d.mapping);
            }
          }
          if(d.temps)   setMarkers(prev => prev.map(m => { const t=d.temps.find((x:any)=>x.id===m.id); return t?.temp!=null?{...m,temp:t.temp}:m; }));
          if(d.rois)    setRois(prev => prev.map(r => { const t=d.rois.find((x:any)=>x.id===r.id); return t?{...r,maxTemp:t.max}:r; }));
        }
      } catch {}
      timer = setTimeout(poll, 600);
    };
    poll();
    return () => clearTimeout(timer);
  }, [did, form]);

  const syncAI = () => fetch(`/api/v1/devices/${did}/sync`, { method:'POST', headers:{Authorization:`Bearer ${authService.getToken()}`} }).catch(()=>{});

  const getPos = (e:React.MouseEvent): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [ Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)), Math.max(0,Math.min(1,(e.clientY-r.top)/r.height)) ];
  };

  const o2t = (ox:number, oy:number, v:VVR) => ({ tx: Math.max(0, Math.min(1, (ox-v.x)/v.width)), ty: Math.max(0, Math.min(1, (oy-v.y)/v.height)) });
  const t2o = (tx:number, ty:number, v:VVR) => ({ ox: Math.max(0, Math.min(1, tx*v.width+v.x)), oy: Math.max(0, Math.min(1, ty*v.height+v.y)) });

  const toThermal = (nx:number, ny:number): [number,number] => viewMode==='th' ? [nx,ny] : [o2t(nx,ny,vvr).tx, o2t(nx,ny,vvr).ty];

  const onDown = (e:React.MouseEvent) => {
    if(e.button!==0) return;

    const isDrawingRect = drawMode === 'rect' || (drawMode === 'none' && form.open && form.isNew && form.type === 'roi');
    const isDrawingPoint = drawMode === 'point';
    const isEditingMarker = dragMkRef.current !== null;

    if (!isDrawingRect && !isDrawingPoint && !isEditingMarker) {
      // Bắt đầu di chuyển (Pan)
      isPanningRef.current = true;
      setIsPanning(true);
      panDraggedRef.current = false;
      panStartXRef.current = e.clientX;
      panStartYRef.current = e.clientY;
      if (containerRef.current) {
        panScrollLeftRef.current = containerRef.current.scrollLeft;
        panScrollTopRef.current = containerRef.current.scrollTop;
      }
      return;
    }

    e.preventDefault();
    if(isDrawingRect) {
      const [nx,ny] = getPos(e);
      setDragRoi({ sx:nx, sy:ny, ex:nx, ey:ny });
    }
  };

  const onMove = (e:React.MouseEvent) => {
    const [nx,ny] = getPos(e);

    if (isPanningRef.current && containerRef.current) {
      const dx = e.clientX - panStartXRef.current;
      const dy = e.clientY - panStartYRef.current;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        panDraggedRef.current = true;
      }
      containerRef.current.scrollLeft = panScrollLeftRef.current - dx;
      containerRef.current.scrollTop = panScrollTopRef.current - dy;
      return;
    }

    if(drawMode === 'point') setHoverPos({nx,ny});
    else if(hoverPos) setHoverPos(null);
    if(dragRoi)   setDragRoi(p => p?{...p,ex:nx,ey:ny}:null);
    
    if(dragMkRef.current && drawMode === 'none') {
      const [tx,ty] = toThermal(nx,ny);
      const {ox,oy} = t2o(tx,ty,vvr);
      
      if (dragMkRef.current === '__new_marker__') {
        setForm(f => ({ ...f, tx: tx.toFixed(4), ty: ty.toFixed(4) }));
      } else {
        setMarkers(prev => prev.map(m => m.id===dragMkRef.current ? {...m,tx,ty,ox,oy} : m));
        // Cập nhật cả tọa độ trong form đang mở
        if (form.open && form.id === dragMkRef.current) {
          setForm(f => ({ ...f, tx: tx.toFixed(4), ty: ty.toFixed(4) }));
        }
      }
    }
    
    // Live Cursor query
    if(viewMode==='th' && !dragMkRef.current && !dragRoi && !isPanningRef.current) {
      if(cursorTimer.current) clearTimeout(cursorTimer.current);
      cursorTimer.current = setTimeout(async () => {
        try {
          const res = await fetch(`/api/v1/devices/${did}/thermal/live-temps`, {
            method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${authService.getToken()}` },
            body: JSON.stringify({ points:[{ id:'__cur__', x:nx, y:ny }], rois:[] }),
          });
          if(res.ok) { const d=await res.json(); const t=d.temps?.[0]; if(t?.temp!=null) setCursor({temp:t.temp,px:e.clientX,py:e.clientY}); }
        } catch {}
      }, 100);
    } else {
      setCursor(null);
    }
  };

  // Mở form để người dùng xác nhận trước khi lưu
  const autoPlaceMarker = (tx:number, ty:number) => {
    
    // Tìm chỉ số nhỏ nhất còn trống bắt đầu từ 1
    const usedIndices = new Set<number>();
    mksRef.current.forEach(m => {
      const match = m.name?.match(/\d+/) || m.shortName?.match(/\d+/);
      if (match) usedIndices.add(parseInt(match[0]));
    });
    
    let idx = 1;
    while (usedIndices.has(idx)) idx++;
    
    setForm({
      ...EMPTY_FORM,
      open: true, isNew: true, type: 'marker',
      name: `Điểm ${idx}`, shortName: `D${idx}`,
      tx: tx.toFixed(4), ty: ty.toFixed(4),
      preAlarm: '50', alarm: '70', markerSize: '10'
    });
    setDrawMode('none');
  };

  const autoPlaceRoi = (tx1:number,ty1:number,tx2:number,ty2:number) => {
    const usedIndices = new Set<number>();
    roisRef.current.forEach(r => {
      const match = r.name?.match(/\d+/);
      if (match) usedIndices.add(parseInt(match[0]));
    });
    
    let idx = 1;
    while (usedIndices.has(idx)) idx++;
    
    setForm({
      ...EMPTY_FORM,
      open: true, isNew: true, type: 'roi',
      name: `Vùng ${idx}`,
      tx1: tx1.toFixed(4), ty1: ty1.toFixed(4),
      tx2: tx2.toFixed(4), ty2: ty2.toFixed(4),
      preAlarm: '50', alarm: '70', labelPos: 'top'
    });
    setDrawMode('none');
  };

  const onUp = (e:React.MouseEvent) => {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      setIsPanning(false);
      return;
    }

    if(dragMkRef.current) {
      if (dragMkRef.current !== '__new_marker__') {
        const m = markers.find(x=>x.id===dragMkRef.current);
        if(m) stationApi.updateRoiPoint(did, m.id, { tx:m.tx, ty:m.ty, ox:m.ox, oy:m.oy, x:m.tx*100, y:m.ty*100 } as any).catch(()=>{});
        syncAI();
      }
      dragMkRef.current = null;
      return;
    }
    
    // Nếu form đang mở để thêm điểm mới, cho phép click để chọn lại vị trí
    if (drawMode === 'none' && form.open && form.isNew && form.type === 'marker') {
      const [nx,ny] = getPos(e);
      const [tx,ty] = toThermal(nx,ny);
      if(viewMode==='op' && (nx<vvr.x||nx>vvr.x+vvr.width||ny<vvr.y||ny>vvr.y+vvr.height)) return;
      setForm(f => ({ ...f, tx: tx.toFixed(4), ty: ty.toFixed(4) }));
      return;
    }

    if(drawMode === 'point') {
      const [nx,ny] = getPos(e);
      const [tx,ty] = toThermal(nx,ny);
      if(viewMode==='op' && (nx<vvr.x||nx>vvr.x+vvr.width||ny<vvr.y||ny>vvr.y+vvr.height)) return;
      setHoverPos(null);
      autoPlaceMarker(tx, ty);
      return;
    }
    if(dragRoi) {
      const {sx,sy,ex,ey} = dragRoi;
      setDragRoi(null);
      if(Math.abs(ex-sx)<0.02 || Math.abs(ey-sy)<0.02) return;
      let tx1=sx,ty1=sy,tx2=ex,ty2=ey;
      if(viewMode==='op'){const tl=o2t(sx,sy,vvr);const br=o2t(ex,ey,vvr);tx1=tl.tx;ty1=tl.ty;tx2=br.tx;ty2=br.ty;}
      
      if (form.open && form.isNew && form.type === 'roi') {
         // Cập nhật lại tọa độ nếu đang mở form thêm mới vùng
         setForm(f => ({ ...f, tx1: tx1.toFixed(4), ty1: ty1.toFixed(4), tx2: tx2.toFixed(4), ty2: ty2.toFixed(4) }));
      } else {
         autoPlaceRoi(tx1,ty1,tx2,ty2);
      }
    }
  };

  const saveForm = async () => {
    const isMarker = form.type === 'marker';
    const actionLabel = form.isNew ? 'Thêm mới' : 'Cập nhật';
    const typeLabel = isMarker ? 'điểm đo' : 'vùng đo';

    if (!await confirmDialog({
      title: `${actionLabel} ${typeLabel}`,
      message: `Bạn có chắc chắn muốn ${actionLabel.toLowerCase()} ${typeLabel} này không?`,
      confirmText: actionLabel
    })) return;

    try {
      if(isMarker) {
        const tx=parseFloat(form.tx), ty=parseFloat(form.ty);
        const {ox:cox,oy:coy}=t2o(tx,ty,vvr);
        const payload = {
          name:form.name, pointId:form.shortName, 
          tx, ty, ox:cox, oy:coy, x:tx*100, y:ty*100, 
          sortOrder:parseInt(form.markerSize)||10, 
          warningThreshold:parseFloat(form.preAlarm)||50, alarmThreshold:parseFloat(form.alarm)||70
        };

        if (form.isNew) {
          await stationApi.createRoiPoint(did, payload as any);
        } else {
          await stationApi.updateRoiPoint(did, form.id, payload as any);
        }
      } else {
        const tx1=parseFloat(form.tx1), ty1=parseFloat(form.ty1), tx2=parseFloat(form.tx2), ty2=parseFloat(form.ty2);
        const poly=JSON.stringify([[tx1,ty1],[tx2,ty1],[tx2,ty2],[tx1,ty2]]);
        const thresholds = JSON.stringify({
          warning:parseFloat(form.preAlarm), alarm:parseFloat(form.alarm), 
          labelPos:form.labelPos, fontSize:parseFloat(form.fontSize)||11, borderWidth:parseFloat(form.borderWidth)||0.5
        });

        if (form.isNew) {
          await stationApi.createBoundary(did, { name: form.name, type: 'roi', polygon: poly, thresholds, enabled: true, severityLevel: 'warning' } as any);
        } else {
          await stationApi.updateBoundary(form.id, { name: form.name, thresholds } as any);
        }
      }
      setForm(EMPTY_FORM);
      load(); // Reload data from DB
      syncAI();
    } catch(e) { alert("Lưu thất bại!"); }
  };

  const delMarker = async (id:string) => {
    try {
      if (await confirmDialog({ title: 'Xóa điểm đo', message: 'Bạn có chắc chắn muốn xóa điểm đo nhiệt này?', danger: true })) {
        await stationApi.deleteRoiPoint(did, id);
        await load();
        syncAI();
      }
    } catch (err: any) {
      console.error("[ThermalConfigTab] Delete marker failed:", err);
      alert("Xóa điểm đo thất bại: " + (err.message || err));
    }
  };
  const delRoi = async (id:string) => {
    try {
      if (await confirmDialog({ title: 'Xóa vùng đo', message: 'Bạn có chắc chắn muốn xóa vùng đo nhiệt này?', danger: true })) {
        await stationApi.deleteBoundary(id);
        await load();
        syncAI();
      }
    } catch (err: any) {
      console.error("[ThermalConfigTab] Delete ROI failed:", err);
      alert("Xóa vùng đo thất bại: " + (err.message || err));
    }
  };

  const toggleMarkerSelection = (id: string) => {
    setSelectedMarkerIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleRoiSelection = (id: string) => {
    setSelectedRoiIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const selectAllMarkers = () => {
    setSelectedMarkerIds(markers.map(m => m.id));
  };

  const selectAllRois = () => {
    setSelectedRoiIds(rois.map(r => r.id));
  };

  const bulkDeleteMarkers = async () => {
    if (selectedMarkerIds.length === 0) return;
    if (!await confirmDialog({
      title: 'Xóa hàng loạt điểm đo',
      message: `Xóa ${selectedMarkerIds.length} điểm đo đã chọn? Thao tác này không thể hoàn tác.`,
      confirmText: 'Xóa đã chọn',
      danger: true,
    })) return;

    try {
      await Promise.all(selectedMarkerIds.map(id => stationApi.deleteRoiPoint(did, id)));
      setSelectedMarkerIds([]);
      await load();
      syncAI();
    } catch (err: any) {
      console.error("[ThermalConfigTab] Bulk delete markers failed:", err);
      alert("Xóa hàng loạt điểm đo thất bại: " + (err.message || err));
    }
  };

  const bulkDeleteRois = async () => {
    if (selectedRoiIds.length === 0) return;
    if (!await confirmDialog({
      title: 'Xóa hàng loạt vùng đo',
      message: `Xóa ${selectedRoiIds.length} vùng đo đã chọn? Thao tác này không thể hoàn tác.`,
      confirmText: 'Xóa đã chọn',
      danger: true,
    })) return;

    try {
      await Promise.all(selectedRoiIds.map(id => stationApi.deleteBoundary(id)));
      setSelectedRoiIds([]);
      await load();
      syncAI();
    } catch (err: any) {
      console.error("[ThermalConfigTab] Bulk delete ROIs failed:", err);
      alert("Xóa hàng loạt vùng đo thất bại: " + (err.message || err));
    }
  };

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden', background:'var(--admin-bg)' }}>
      {/* ── Camera area ── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', minWidth:0 }}>

        {/* Toolbar & View Tabs */}
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'4px 10px', background:'var(--admin-layer-1)', borderBottom:'1px solid var(--admin-border)', flexShrink:0, minHeight:36 }}>

          <div style={{ display:'flex', border:'1px solid var(--admin-border)', overflow:'hidden', flexShrink:0 }}>
            <button
              className={`btn-industrial btn-sm ${viewMode==='op'?'btn-primary':''}`}
              style={{ border:'none', borderRadius:0, height:26, padding:'0 10px', fontSize:11, whiteSpace:'nowrap' }}
              onClick={() => setViewMode('op')}
            >
              QUANG HỌC
            </button>
            <button
              className={`btn-industrial btn-sm ${viewMode==='th'?'btn-primary':''}`}
              style={{ border:'none', borderLeft:'1px solid var(--admin-border)', borderRadius:0, height:26, padding:'0 10px', fontSize:11, whiteSpace:'nowrap' }}
              onClick={() => setViewMode('th')}
            >
              NHIỆT ĐỘ
            </button>
          </div>

          {viewMode === 'op' && (
            <button
              className="btn-industrial btn-sm"
              style={{ height:26, padding:'0 10px', fontSize:11, whiteSpace:'nowrap', flexShrink:0, background: showVvr ? 'var(--admin-accent)' : 'transparent', border:'1px solid var(--admin-border)', color: showVvr ? '#fff' : 'var(--admin-text-muted)' }}
              onClick={() => setShowVvr(v => !v)}
            >
              Khung VVR
            </button>
          )}

          <span style={{ marginLeft:'auto', fontSize:11, color:'var(--admin-text-muted)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', minWidth:0 }}>
            💡 Cuộn chuột phóng to · Giữ kéo để di chuyển
          </span>
          <span style={{ fontFamily:'monospace', fontSize:11, fontWeight:'bold', background:'var(--admin-layer-2)', padding:'2px 8px', border:'1px solid var(--admin-border)', flexShrink:0 }}>
            {zoomLevel}%
          </span>

        </div>

        {/* video-container — flex:1 fills remaining height; inner video div is vertically centered via margin:auto */}
        <div style={{ flex:1, display:'flex', flexDirection:'column', position:'relative', background:'#000', overflow:'auto' }} ref={containerRef}>
          <div style={{
            position:'relative',
            width:`${zoomLevel}%`,
            aspectRatio:'16/9',
            transformOrigin:'top left',
            marginTop:'auto',
            marginBottom:'auto',
            flexShrink:0
          }}>
            {/* Base stream */}
            {viewMode === 'op' && opSrc && (
              <iframe 
                src={`/camera-stream.html?src=${encodeURIComponent(opSrc)}&mode=webrtc,mse&go2rtc=${encodeURIComponent(GO2RTC_URL)}`} 
                style={{ position:'absolute', inset:0, width:'100%', height:'100%', border:'none', pointerEvents:'none', zIndex:1 }} 
              />
            )}
            {viewMode === 'th' && thSrc && (
              <iframe 
                src={`/camera-stream.html?src=${encodeURIComponent(thSrc)}&mode=webrtc,mse&go2rtc=${encodeURIComponent(GO2RTC_URL)}`} 
                style={{ position:'absolute', inset:0, width:'100%', height:'100%', border:'none', pointerEvents:'none', zIndex:1 }} 
              />
            )}

            {/* Overlay stream (blended) */}
            {viewMode === 'op' && thSrc && overlayOpacity > 0 && (
              <iframe 
                src={`/camera-stream.html?src=${encodeURIComponent(thSrc)}&mode=webrtc,mse&go2rtc=${encodeURIComponent(GO2RTC_URL)}`} 
                style={{ 
                  position:'absolute', 
                  inset:0, 
                  width:'100%', 
                  height:'100%', 
                  border:'none', 
                  pointerEvents:'none', 
                  zIndex:2, 
                  opacity: overlayOpacity / 100 
                }} 
              />
            )}
            {viewMode === 'th' && opSrc && overlayOpacity > 0 && (
              <iframe 
                src={`/camera-stream.html?src=${encodeURIComponent(opSrc)}&mode=webrtc,mse&go2rtc=${encodeURIComponent(GO2RTC_URL)}`} 
                style={{ 
                  position:'absolute', 
                  inset:0, 
                  width:'100%', 
                  height:'100%', 
                  border:'none', 
                  pointerEvents:'none', 
                  zIndex:2, 
                  opacity: overlayOpacity / 100 
                }} 
              />
            )}

            {/* Overlay boundaries */}
            {viewMode === 'op' && showVvr && (
              <div style={{ position:'absolute', left:pct(vvr.x), top:pct(vvr.y), width:pct(vvr.width), height:pct(vvr.height), border:'3px dashed rgba(0,0,0,0.85)', pointerEvents:'none', zIndex:5 }}>
                <div style={{ position:'absolute', top:-16, left:0, background:'rgba(0,0,0,0.55)', color:'#fff', fontSize:10, padding:'1px 4px' }}>VVR</div>
              </div>
            )}

            {/* Interactive Overlay */}
            <div style={{ position:'absolute', inset:0, zIndex:10, cursor: drawMode !== 'none' ? 'crosshair' : (isPanning ? 'grabbing' : 'grab') }}
                 onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp}
                 onMouseLeave={() => { setHoverPos(null); isPanningRef.current = false; setIsPanning(false); }}
                 onContextMenu={e => e.preventDefault()}>
              
              {/* Draw Rois */}
              {rois.map(r => {
                const nx1 = viewMode==='th' ? r.tx1 : t2o(r.tx1, r.ty1, vvr).ox;
                const ny1 = viewMode==='th' ? r.ty1 : t2o(r.tx1, r.ty1, vvr).oy;
                const nx2 = viewMode==='th' ? r.tx2 : t2o(r.tx2, r.ty2, vvr).ox;
                const ny2 = viewMode==='th' ? r.ty2 : t2o(r.tx2, r.ty2, vvr).oy;
                const c = clr(r.maxTemp, r.preAlarm, r.alarm);
                const lp = r.labelPos || 'top';
                const fs = r.fontSize || 11;
                const bw = r.borderWidth || 0.5;
                const labelStyle: React.CSSProperties =
                  lp === 'bottom' ? { top:'calc(100% + 3px)', left:0 } :
                  lp === 'left'   ? { top:'50%', right:'calc(100% + 3px)', transform:'translateY(-50%)' } :
                  lp === 'right'  ? { top:'50%', left:'calc(100% + 3px)', transform:'translateY(-50%)' } :
                                    { bottom:'calc(100% + 3px)', left:0 };
                return (
                  <div key={r.id} style={{ position:'absolute', left:pct(nx1), top:pct(ny1), width:pct(nx2-nx1), height:pct(ny2-ny1), border:`${bw}px solid ${c}`, background:c+'10' }}>
                    <div style={{ position:'absolute', ...labelStyle, background:'rgba(0,0,0,0.72)', padding:'1px 5px', borderRadius: 0, color:'#fff', fontSize:fs, fontFamily:'monospace', whiteSpace:'nowrap' }}>
                      <b>{r.name.replace(/Vùng\s*/g, 'V')}</b> <span style={{color:c}}>{r.maxTemp?.toFixed(1)??'--'}°C</span>
                    </div>
                  </div>
                );
              })}

              {/* Draw Markers */}
              {markers.map(m => {
                const { ox: dynOx, oy: dynOy } = t2o(m.tx, m.ty, vvr);
                const nx = viewMode==='th' ? m.tx : dynOx;
                const ny = viewMode==='th' ? m.ty : dynOy;
                const c = clr(m.temp, m.preAlarm, m.alarm);
                const armLen = m.markerSize || 10;
                const labelOffset = Math.round(armLen / 2) + 5;
                
                // Chỉ cho phép tương tác (kéo) nếu đang mở đúng form sửa cho điểm này
                const isBeingEdited = form.open && form.id === m.id;
                const canDrag = isBeingEdited && drawMode === 'none';

                return (
                  <div key={m.id} style={{ 
                    position:'absolute', left:pct(nx), top:pct(ny), transform:'translate(-50%,-50%)', 
                    cursor: canDrag ? 'move' : (drawMode !== 'none' ? 'crosshair' : 'default'), 
                    pointerEvents: (drawMode !== 'none' || canDrag) ? 'auto' : 'none' 
                  }}
                       onMouseDown={e=>{ if(canDrag && e.button===0){ e.stopPropagation(); dragMkRef.current = m.id; }}}>
                    {/* Ngang */}
                    <div style={{ position:'absolute', top:0, left:0, width:armLen, height:1.5, background:c, transform:'translate(-50%,-50%)', boxShadow:'0 0 3px rgba(0,0,0,.9)' }} />
                    {/* Dọc */}
                    <div style={{ position:'absolute', top:0, left:0, width:1.5, height:armLen, background:c, transform:'translate(-50%,-50%)', boxShadow:'0 0 3px rgba(0,0,0,.9)' }} />
                    {/* Hit area */}
                    <div style={{ position:'absolute', top:0, left:0, width:armLen, height:armLen, transform:'translate(-50%,-50%)' }} />
                    {/* Label: Mã + nhiệt độ */}
                    <div style={{ position:'absolute', top:0, left:labelOffset, transform:'translateY(-50%)', background:'rgba(8,8,12,.88)', borderRadius: 0, padding:'1px 6px', display:'flex', flexDirection:'column', alignItems:'flex-start', whiteSpace:'nowrap', pointerEvents:'none' }}>
                      <span style={{fontSize:10, color:'#94a3b8', lineHeight:1.3}}>{(m.shortName||m.name).replace(/Điểm\s*/gi, 'D').replace(/P\s*/g, 'D')}</span>
                      <span style={{fontSize:11, fontWeight:800, color:c, fontFamily:'monospace', lineHeight:1.3}}>{m.temp?.toFixed(1)??'--'}°C</span>
                    </div>
                  </div>
                );
              })}

              {/* Preview New Marker (Ghi chú: hiển thị ngay khi form thêm mới đang mở) */}
              {form.open && form.isNew && form.type === 'marker' ? (() => {
                 const tx = parseFloat(form.tx), ty = parseFloat(form.ty);
                 const {ox, oy} = viewMode === 'th' ? {ox:tx, oy:ty} : t2o(tx, ty, vvr);
                 const armLen = parseInt(form.markerSize) || 10;
                 return (
                  <div style={{ position:'absolute', left:pct(ox), top:pct(oy), transform:'translate(-50%,-50%)', zIndex:25, cursor: 'move', pointerEvents: 'auto' }}
                       onMouseDown={e=>{ if(e.button===0){ e.stopPropagation(); dragMkRef.current = '__new_marker__'; }}}>
                     <div style={{ position:'absolute', top:0, left:0, width:armLen, height:2, background:'var(--admin-accent)', transform:'translate(-50%,-50%)', boxShadow:'0 0 8px var(--admin-accent)', pointerEvents:'none' }} />
                     <div style={{ position:'absolute', top:0, left:0, width:2, height:armLen, background:'var(--admin-accent)', transform:'translate(-50%,-50%)', boxShadow:'0 0 8px var(--admin-accent)', pointerEvents:'none' }} />
                     {/* Hit area */}
                     <div style={{ position:'absolute', top:0, left:0, width:armLen, height:armLen, transform:'translate(-50%,-50%)' }} />
                     <div style={{ position:'absolute', top:0, left:Math.round(armLen/2)+5, transform:'translateY(-50%)', background:'var(--admin-accent)', color:'#fff', padding:'2px 8px', fontSize:10, fontWeight:800, whiteSpace:'nowrap', pointerEvents:'none' }}>
                        ĐANG THÊM: {form.name}
                     </div>
                  </div>
                 );
              })() : null}

              {/* Hover preview dấu + khi đang ở chế độ chấm điểm */}
              {drawMode==='point' && hoverPos && (
                <div style={{ position:'absolute', left:pct(hoverPos.nx), top:pct(hoverPos.ny), transform:'translate(-50%,-50%)', pointerEvents:'none', zIndex:20 }}>
                  <div style={{ position:'absolute', top:0, left:0, width:28, height:2, background:'#fff', transform:'translate(-50%,-50%)', opacity:.9, boxShadow:'0 0 5px rgba(0,0,0,1)' }} />
                  <div style={{ position:'absolute', top:0, left:0, width:2, height:28, background:'#fff', transform:'translate(-50%,-50%)', opacity:.9, boxShadow:'0 0 5px rgba(0,0,0,1)' }} />
                </div>
              )}

              {/* Instructions Overlay */}
              {drawMode === 'point' && (
                <div style={{ position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)', background: 'var(--admin-accent)', color: '#fff', padding: '8px 16px', borderRadius: 0, fontWeight: 800, fontSize: '.75rem', zIndex: 30, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', pointerEvents: 'none', border: '1px solid rgba(255,255,255,0.2)' }}>
                  📍 BẤM VÀO HÌNH ẢNH ĐỂ CHỌN VỊ TRÍ ĐIỂM ĐO
                </div>
              )}
              {drawMode === 'rect' && (
                <div style={{ position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)', background: 'var(--admin-accent)', color: '#fff', padding: '8px 16px', borderRadius: 0, fontWeight: 800, fontSize: '.75rem', zIndex: 30, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', pointerEvents: 'none', border: '1px solid rgba(255,255,255,0.2)' }}>
                  🟧 KÉO CHUỘT TRÊN HÌNH ẢNH ĐỂ VẼ VÙNG ĐO
                </div>
              )}

              {dragRoi ? (() => {
                const x1=Math.min(dragRoi.sx,dragRoi.ex), y1=Math.min(dragRoi.sy,dragRoi.ey);
                const x2=Math.max(dragRoi.sx,dragRoi.ex), y2=Math.max(dragRoi.sy,dragRoi.ey);
                return <div style={{ position:'absolute', left:pct(x1), top:pct(y1), width:pct(x2-x1), height:pct(y2-y1), border:'2px dashed #ff9900', background:'rgba(255,153,0,.06)', pointerEvents:'none' }} />;
              })() : null}

              {/* Preview New ROI (Ghi chú: hiển thị ngay khi form thêm mới đang mở) */}
              {form.open && form.isNew && form.type === 'roi' ? (() => {
                 const tx1 = parseFloat(form.tx1), ty1 = parseFloat(form.ty1), tx2 = parseFloat(form.tx2), ty2 = parseFloat(form.ty2);
                 const nx1 = viewMode==='th' ? tx1 : t2o(tx1, ty1, vvr).ox;
                 const ny1 = viewMode==='th' ? ty1 : t2o(tx1, ty1, vvr).oy;
                 const nx2 = viewMode==='th' ? tx2 : t2o(tx2, ty2, vvr).ox;
                 const ny2 = viewMode==='th' ? ty2 : t2o(tx2, ty2, vvr).oy;
                 return (
                  <div style={{ position:'absolute', left:pct(nx1), top:pct(ny1), width:pct(nx2-nx1), height:pct(ny2-ny1), border:'2px solid var(--admin-accent)', background:'rgba(59,130,246,0.1)', pointerEvents:'none', zIndex:25 }}>
                     <div style={{ position:'absolute', top:'-24px', left:0, background:'var(--admin-accent)', color:'#fff', padding:'2px 8px', fontSize:10, fontWeight:800, whiteSpace:'nowrap' }}>
                        ĐANG VẼ: {form.name}
                     </div>
                  </div>
                 );
              })() : null}

            </div>
          </div>

          {/* Live Cursor Temp overlay */}
          {cursor && viewMode==='th' && (
            <div style={{ position:'absolute', left:cursor.px+14, top:cursor.py, transform:'translateY(-50%)', pointerEvents:'none', background:'rgba(0,0,0,.88)', border:'1px solid rgba(255,255,255,.15)', borderRadius: 0, padding:'2px 8px', fontSize:11, fontFamily:'monospace', color:'#fff', whiteSpace:'nowrap', zIndex:20 }}>
              {cursor.temp.toFixed(1)}°C
            </div>
          )}

        </div>
      </div>

      {/* ── Config Sidebar ── */}
      <div style={{ width:260, borderLeft:'1px solid var(--admin-border)', background:'var(--admin-layer-1)', display:'flex', flexDirection:'column', flexShrink:0 }}>
        {form.open ? (
          <div style={{ display:'flex', flexDirection:'column', height:'100%', animation:'fadeIn .2s ease' }}>
            <div style={{ padding:'12px', borderBottom:'1px solid var(--admin-border)', display:'flex', justifyContent:'space-between', alignItems:'center', fontWeight:800, fontSize:'.85rem' }}>
              <span>{form.isNew ? 'Thêm mới' : 'Chỉnh sửa'} {form.type==='marker'?'điểm':'vùng'}</span>
              <button className="btn-industrial btn-sm" style={{ padding:'0 8px', height:22, borderRadius:0 }} onClick={()=>setForm(EMPTY_FORM)}><X size={12}/></button>
            </div>
            <div style={{ padding:14, display:'flex', flexDirection:'column', gap:12 }}>
              <div className="form-group" style={{ marginBottom: 0 }}><label>Tên thiết bị *</label><input className="form-input" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} autoFocus /></div>
              
              {form.type==='marker' && (
                <>
                  <div className="form-group" style={{ marginBottom: 0 }}><label>Mã định danh (ID)</label><input className="form-input" value={form.shortName} onChange={e=>setForm(f=>({...f,shortName:e.target.value}))} placeholder="VD: P1, P2..." /></div>
                  
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                    <div className="form-group" style={{ marginBottom: 0 }}><label>Cỡ dấu (+)</label><input className="form-input" type="number" min="10" max="60" step="2" value={form.markerSize} onChange={e=>setForm(f=>({...f,markerSize:e.target.value}))} /></div>
                    <div className="form-group" style={{ marginBottom: 0 }}><label>Vị trí nhãn</label>
                      <select className="form-input" value={form.labelPos} onChange={e=>setForm(f=>({...f,labelPos:e.target.value}))}>
                        <option value="top">Trên</option>
                        <option value="bottom">Dưới</option>
                        <option value="left">Trái</option>
                        <option value="right">Phải</option>
                      </select>
                    </div>
                  </div>

                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                    <div className="form-group" style={{ marginBottom: 0, minWidth: 0 }}><label style={{color:'var(--admin-warning)', fontSize:'.62rem'}}>Cảnh báo sớm</label><input className="form-input" style={{ padding:'8px 10px', width: '100%', boxSizing: 'border-box' }} type="number" value={form.preAlarm} onChange={e=>setForm(f=>({...f,preAlarm:e.target.value}))}/></div>
                    <div className="form-group" style={{ marginBottom: 0, minWidth: 0 }}><label style={{color:'var(--admin-danger)', fontSize:'.62rem'}}>Báo động</label><input className="form-input" style={{ padding:'8px 10px', width: '100%', boxSizing: 'border-box' }} type="number" value={form.alarm} onChange={e=>setForm(f=>({...f,alarm:e.target.value}))}/></div>
                  </div>
                </>
              )}

              {form.type==='roi' && (
                <>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                    <div className="form-group" style={{ marginBottom: 0, minWidth: 0 }}><label style={{color:'var(--admin-warning)', fontSize:'.62rem'}}>Cảnh báo sớm</label><input className="form-input" style={{ padding:'8px 10px', width: '100%', boxSizing: 'border-box' }} type="number" value={form.preAlarm} onChange={e=>setForm(f=>({...f,preAlarm:e.target.value}))}/></div>
                    <div className="form-group" style={{ marginBottom: 0, minWidth: 0 }}><label style={{color:'var(--admin-danger)', fontSize:'.62rem'}}>Báo động</label><input className="form-input" style={{ padding:'8px 10px', width: '100%', boxSizing: 'border-box' }} type="number" value={form.alarm} onChange={e=>setForm(f=>({...f,alarm:e.target.value}))}/></div>
                  </div>

                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label>Vị trí tên vùng</label>
                    <select className="form-input" value={form.labelPos} onChange={e=>setForm(f=>({...f,labelPos:e.target.value}))}>
                      <option value="top">Trên</option>
                      <option value="bottom">Dưới</option>
                      <option value="left">Trái</option>
                      <option value="right">Phải</option>
                    </select>
                  </div>

                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                    <div className="form-group" style={{ marginBottom: 0, minWidth: 0 }}>
                      <label>Cỡ chữ (px)</label>
                      <input className="form-input" style={{ padding:'8px 10px', width: '100%', boxSizing: 'border-box' }} type="number" min="8" max="24" step="1" value={form.fontSize} onChange={e=>setForm(f=>({...f,fontSize:e.target.value}))} />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0, minWidth: 0 }}>
                      <label>Viền (px)</label>
                      <input className="form-input" style={{ padding:'8px 10px', width: '100%', boxSizing: 'border-box' }} type="number" min="0.5" max="4" step="0.5" value={form.borderWidth} onChange={e=>setForm(f=>({...f,borderWidth:e.target.value}))} />
                    </div>
                  </div>
                </>
              )}
              <div style={{ display:'flex', gap:10, marginTop:6 }}>
                <button className="btn-industrial" style={{ flex:1, height:32, padding:'0 12px', background:'var(--admin-layer-3)', border:'1px solid var(--admin-border)', borderRadius:0, display:'flex', alignItems:'center', justifyContent:'center', gap:6, fontSize:'.8rem', fontWeight:600 }} onClick={()=>{ setForm(EMPTY_FORM); }}>
                  <X size={14}/> Hủy
                </button>
                <button className="btn-industrial" style={{ flex:1, height:32, padding:'0 12px', background:'var(--admin-accent)', border:'none', borderRadius:0, color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', gap:6, fontSize:'.8rem', fontWeight:700, boxShadow:'0 2px 4px rgba(0,0,0,0.1)' }} onClick={saveForm}>
                  <Save size={14}/> Lưu
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display:'flex', borderBottom:'1px solid var(--admin-border)', background:'var(--admin-layer-2)', padding:'4px' }}>
              <button 
                onClick={()=>setActiveSideTab('marker')}
                style={{ 
                  flex:1, padding:'6px', border:'none', fontSize:'.68rem', fontWeight:800, cursor:'pointer',
                  background: activeSideTab==='marker' ? 'var(--admin-accent)' : 'transparent',
                  color: activeSideTab==='marker' ? '#fff' : 'var(--admin-text-muted)',
                  textTransform:'uppercase'
                }}
              >
                Điểm đo ({markers.length})
              </button>
              <button 
                onClick={()=>setActiveSideTab('roi')}
                style={{ 
                  flex:1, padding:'6px', border:'none', fontSize:'.68rem', fontWeight:800, cursor:'pointer',
                  background: activeSideTab==='roi' ? 'var(--admin-accent)' : 'transparent',
                  color: activeSideTab==='roi' ? '#fff' : 'var(--admin-text-muted)',
                  textTransform:'uppercase'
                }}
              >
                Vùng đo ({rois.length})
              </button>
            </div>

            <div style={{ flex:1, overflowY:'auto' }}>
              {activeSideTab === 'marker' ? (
                <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>
                  <button className="btn-industrial" style={{ width:'100%', height:30, background:'rgba(59,130,246,0.1)', border:'1px dashed var(--admin-accent)', color:'var(--admin-accent)', fontWeight:800, fontSize:'.7rem' }} onClick={()=>setDrawMode(drawMode==='point'?'none':'point')}>
                    {drawMode==='point' ? 'HỦY CHẤM ĐIỂM' : '+ THÊM ĐIỂM ĐO'}
                  </button>
                  <div style={{ display:'flex', gap:6 }}>
                    <button
                      className="btn-industrial btn-sm"
                      style={{ flex:1, height:28, fontSize:'.68rem' }}
                      onClick={selectAllMarkers}
                      disabled={markers.length === 0}
                    >
                      Chọn tất cả
                    </button>
                    <button
                      className="btn-industrial btn-sm btn-danger"
                      style={{ flex:1, height:28, fontSize:'.68rem' }}
                      onClick={bulkDeleteMarkers}
                      disabled={selectedMarkerIds.length === 0}
                    >
                      Xóa đã chọn
                    </button>
                  </div>
                  {markers.map(m => (
                    <div key={m.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', background:'var(--admin-layer-2)', border:'1px solid var(--admin-border)', borderRadius:0 }}>
                      <input
                        type="checkbox"
                        checked={selectedMarkerIds.includes(m.id)}
                        onChange={() => toggleMarkerSelection(m.id)}
                        onClick={e => e.stopPropagation()}
                        style={{ accentColor: 'var(--admin-accent)', cursor: 'pointer' }}
                      />
                      <div style={{ width:8, height:8, borderRadius:'50%', background:clr(m.temp,m.preAlarm,m.alarm) }} />
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:'.75rem', fontWeight:700, color:'var(--admin-text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.name}</div>
                        <div style={{ fontSize:'.65rem', color:'var(--admin-text-muted)' }}>ID: {m.shortName}</div>
                      </div>
                      <div style={{ textAlign:'right', marginRight:4 }}>
                        <div style={{ fontSize:'.85rem', fontWeight:800, color:clr(m.temp,m.preAlarm,m.alarm), fontFamily:'monospace' }}>{m.temp?.toFixed(1)??'--'}°C</div>
                      </div>
                      <div style={{ display:'flex', gap:4 }}>
                        <button className="btn-industrial btn-sm" onClick={() => setForm({ ...EMPTY_FORM, open:true, isNew:false, id:m.id, name:m.name, shortName:m.shortName, tx:m.tx.toFixed(4), ty:m.ty.toFixed(4), preAlarm:m.preAlarm.toString(), alarm:m.alarm.toString(), markerSize:m.markerSize.toString(), labelPos:m.labelPos||'top', type:'marker' })}><Edit2 size={12}/></button>
                        <button className="btn-industrial btn-sm" style={{color:'var(--admin-danger)'}} onClick={()=>delMarker(m.id)}><Trash2 size={12}/></button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ padding:10, display:'flex', flexDirection:'column', gap:8 }}>
                  <button className="btn-industrial" style={{ width:'100%', height:30, background:'rgba(59,130,246,0.1)', border:'1px dashed var(--admin-accent)', color:'var(--admin-accent)', fontWeight:800, fontSize:'.7rem' }} onClick={()=>setDrawMode(drawMode==='rect'?'none':'rect')}>
                    {drawMode==='rect' ? 'HỦY VẼ VÙNG' : '⬜ VẼ VÙNG ĐO MỚI'}
                  </button>
                  <div style={{ display:'flex', gap:6 }}>
                    <button
                      className="btn-industrial btn-sm"
                      style={{ flex:1, height:28, fontSize:'.68rem' }}
                      onClick={selectAllRois}
                      disabled={rois.length === 0}
                    >
                      Chọn tất cả
                    </button>
                    <button
                      className="btn-industrial btn-sm btn-danger"
                      style={{ flex:1, height:28, fontSize:'.68rem' }}
                      onClick={bulkDeleteRois}
                      disabled={selectedRoiIds.length === 0}
                    >
                      Xóa đã chọn
                    </button>
                  </div>
                  {rois.map(r => {
                    const c = clr(r.maxTemp, r.preAlarm, r.alarm);
                    return (
                      <div key={r.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', background:'var(--admin-layer-2)', border:'1px solid var(--admin-border)', borderRadius:0 }}>
                        <input
                          type="checkbox"
                          checked={selectedRoiIds.includes(r.id)}
                          onChange={() => toggleRoiSelection(r.id)}
                          onClick={e => e.stopPropagation()}
                          style={{ accentColor: 'var(--admin-accent)', cursor: 'pointer' }}
                        />
                        <div style={{ width:8, height:8, background:c+'44', border:`1px solid ${c}` }} />
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:'.75rem', fontWeight:700, color:'var(--admin-text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.name}</div>
                          <div style={{ fontSize:'.65rem', color:'var(--admin-text-muted)' }}>Vùng đa giác</div>
                        </div>
                        <div style={{ textAlign:'right', marginRight:4 }}>
                          <div style={{ fontSize:'.85rem', fontWeight:800, color:c, fontFamily:'monospace' }}>{r.maxTemp?.toFixed(1)??'--'}°C</div>
                        </div>
                        <div style={{ display:'flex', gap:4 }}>
                          <button className="btn-industrial btn-sm" onClick={() => setForm({ ...EMPTY_FORM, open:true, isNew:false, id:r.id, name:r.name, tx1:r.tx1.toFixed(4), ty1:r.ty1.toFixed(4), tx2:r.tx2.toFixed(4), ty2:r.ty2.toFixed(4), preAlarm:r.preAlarm.toString(), alarm:r.alarm.toString(), labelPos:r.labelPos||'top', fontSize:r.fontSize.toString(), borderWidth:r.borderWidth.toString(), type:'roi' })}><Edit2 size={12}/></button>
                          <button className="btn-industrial btn-sm" style={{color:'var(--admin-danger)'}} onClick={()=>delRoi(r.id)}><Trash2 size={12}/></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity:0; transform:translateX(10px); } to { opacity:1; transform:translateX(0); } }
      `}</style>
    </div>
  );
}
