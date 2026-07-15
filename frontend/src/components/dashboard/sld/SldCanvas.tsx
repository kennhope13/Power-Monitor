import React, { useRef, useState, useEffect, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react';
import { stationApi } from '@/services/StationApiService';
import { SldPoint, SensorPoint, Rule } from '@/types/api.types';
import { API_BASE_URL } from '@/utils/env';

interface SldCanvasProps {
  stationId: string;
  editMode?: boolean;
  showLabels?: boolean;
  colorMatrix?: string;
  sensors?: SensorPoint[];
  rules?: Rule[];
  sensorThresholds?: Record<string, { warn: number | null; alarm: number | null }>;
  selectedNodeId?: string;
  onNodeSelect?: (point: SldPoint | null) => void;
  onPointsChanged?: () => void;
  onNodeDropped?: (x: number, y: number, deviceId: string, deviceName: string, pointId?: string) => void;
}

export interface SldCanvasRef {
  fitView: () => void;
  rotateView: () => void;
  reloadData: () => void;
  getPoints: () => SldPoint[];
  applyGlobalBadge: (cfg: BadgeConfig) => void;
  applyGlobalRadius: (radius: number) => Promise<void>;
  getNodeBadgeConfig: (id: string) => BadgeConfig;
  saveNodeConfig: (id: string, radius: number, badgeCfg: BadgeConfig, label?: string) => Promise<void>;
  deleteNode: (id: string) => Promise<void>;
}

export interface BadgeConfig {
  pos: 'top' | 'bottom' | 'left' | 'right';
  size: number;
  color: string;
}

const DEFAULT_BADGE: BadgeConfig = { pos: 'top', size: 9, color: '#34d399' };
const BADGE_COLORS = ['#34d399', '#60a5fa', '#facc15', '#f87171', '#e2e8f0', '#a78bfa'];
const SLD_W = 792;
const SLD_H = 612;

/**
 * Canvas hiển thị sơ đồ nhất tuyến (SLD) tương tác: zoom/pan/rotate bằng chuột,
 * vẽ điểm đo lên SVG nền, hiển thị giá trị cảm biến realtime qua badge và
 * hỗ trợ kéo thả thiết bị vào sơ đồ khi ở chế độ chỉnh sửa.
 * Expose API ra ngoài qua forwardRef (fitView, rotateView, deleteNode, ...).
 */
const DARK_MATRIX = '-0.161 0 0 0 0.220  -0.651 0 0 0 0.741  -0.808 0 0 0 0.973  0 0 0 1 0';
const LIGHT_MATRIX = '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0';
const SLD_TOP_OFFSET = 80;

function getTheme() { return document.documentElement.dataset.theme || 'dark'; }

const SldCanvas = forwardRef<SldCanvasRef, SldCanvasProps>(
  ({ stationId, editMode = false, showLabels = false, colorMatrix, sensors = [], rules = [], sensorThresholds = {}, selectedNodeId, onNodeSelect, onPointsChanged, onNodeDropped }, ref) => {
    const viewportRef = useRef<HTMLDivElement>(null);

    const [transform, setTransform] = useState({ vs: 1, vx: 0, vy: 0, vr: 0 });
    const [points, setPoints] = useState<SldPoint[]>([]);
    const [svgUrl, setSvgUrl] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [themeId, setThemeId] = useState(getTheme);

    useEffect(() => {
      const h = (e: Event) => setThemeId((e as CustomEvent).detail?.theme || getTheme());
      window.addEventListener('theme-changed', h);
      return () => window.removeEventListener('theme-changed', h);
    }, []);

    const [badgeCfgs, setBadgeCfgs] = useState<Record<string, BadgeConfig>>(() => {
      try { return JSON.parse(localStorage.getItem(`sld_badge_${stationId}`) || '{}'); } catch { return {}; }
    });

    const sensorMap = useMemo(() => {
      const m = new Map<string, SensorPoint>();
      sensors.forEach(s => {
        const key = `${s.deviceId?.toLowerCase()}|${s.pointId?.toLowerCase()}`;
        m.set(key, s);
      });
      return m;
    }, [sensors]);

    const transformRef = useRef(transform);
    const pointsRef = useRef<SldPoint[]>([]);
    const badgeCfgsRef = useRef(badgeCfgs);
    const stationIdRef = useRef(stationId);
    useEffect(() => { transformRef.current = transform; }, [transform]);
    useEffect(() => { pointsRef.current = points; }, [points]);
    useEffect(() => { badgeCfgsRef.current = badgeCfgs; }, [badgeCfgs]);
    useEffect(() => { stationIdRef.current = stationId; }, [stationId]);

    const isPanning = useRef(false);
    const startPan = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
    const draggingPointId = useRef<string | null>(null);
    const mouseDownScreen = useRef({ x: 0, y: 0 });

    useEffect(() => { if (!editMode) onNodeSelect?.(null); }, [editMode]);

    /** Tải dữ liệu SLD (điểm và URL ảnh SVG) từ API, phục hồi góc xoay đã lưu. */
    const loadData = useCallback(async () => {
      if (!stationId) return;
      try {
        const data = await stationApi.getSld(stationId);
        // Bỏ node trùng deviceId — giữ cái đầu tiên (thêm sớm nhất)
        const seen = new Set<string>();
        const deduped = (data.points || []).filter(p => {
          const key = p.deviceId?.toLowerCase();
          if (!key) return true;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        setPoints(deduped);
        setSvgUrl(data.svgUrl ?? null);
        // Phục hồi góc xoay đã lưu trong localStorage
        const localVr = localStorage.getItem(`sld_vr_${stationId}`);
        if (localVr) setTransform(prev => ({ ...prev, vr: parseInt(localVr) }));
      } catch (err) { console.error('[SldCanvas] Lỗi load SLD:', err); }
    }, [stationId]);

    useEffect(() => { loadData(); }, [loadData]);

    /** Tính tỉ lệ và vị trí để canvas vừa khít với viewport, canh giữa. */
    const fitView = useCallback(() => {
      if (!viewportRef.current) return;
      const r = viewportRef.current.getBoundingClientRect();
      const s = Math.min(r.width / SLD_W, r.height / SLD_H) * 1.02;
      setTransform(prev => ({ ...prev, vs: s, vx: (r.width - SLD_W * s) / 2, vy: (r.height - SLD_H * s) / 2 }));
    }, []);

    useEffect(() => { const t = setTimeout(fitView, 100); return () => clearTimeout(t); }, [fitView]);

    /** Lưu cấu hình badge vào state và đồng bộ sang localStorage. */
    const writeBadgeCfgs = (next: Record<string, BadgeConfig>) => {
      setBadgeCfgs(next);
      localStorage.setItem(`sld_badge_${stationIdRef.current}`, JSON.stringify(next));
    };

    useImperativeHandle(ref, () => ({
      fitView,
      rotateView: () => setTransform(prev => {
        const nr = (prev.vr + 90) % 360;
        localStorage.setItem(`sld_vr_${stationId}`, nr.toString());
        return { ...prev, vr: nr };
      }),
      reloadData: loadData,
      getPoints: () => pointsRef.current,
      getNodeBadgeConfig: (id) => ({ ...DEFAULT_BADGE, ...(badgeCfgsRef.current[id] || {}) }),
      applyGlobalBadge: (cfg) => {
        const next: Record<string, BadgeConfig> = {};
        pointsRef.current.forEach(p => { next[p.id] = cfg; });
        writeBadgeCfgs(next);
      },
      applyGlobalRadius: async (radius: number) => {
        if (radius < 1 || radius > 60) return;
        const promises = pointsRef.current.map(p => 
          stationApi.updateSldPoint(p.id, { x: p.x, y: p.y, r: radius })
        );
        await Promise.all(promises);
        setPoints(prev => prev.map(p => ({ ...p, r: radius })));
        onPointsChanged?.();
      },
      saveNodeConfig: async (id, radius, badgeCfg, label) => {
        // Update local state immediately
        setPoints(prev => prev.map(pt => pt.id === id ? { ...pt, r: radius, ...(label !== undefined && { label }) } : pt));
        
        const p = pointsRef.current.find(pt => pt.id === id);
        if (p && radius >= 1 && radius <= 60 && (radius !== p.r || label !== p.label)) {
          await stationApi.updateSldPoint(id, { x: p.x, y: p.y, r: radius, label: label });
        }
        writeBadgeCfgs({ ...badgeCfgsRef.current, [id]: badgeCfg });
      },
      deleteNode: async (id) => {
        await stationApi.deleteSldPoint(id);
        setPoints(prev => prev.filter(p => p.id !== id));
        onPointsChanged?.();
      },
    }));

    /**
     * Chuyển tọa độ không gian SLD (có tính xoay) sang tọa độ màn hình pixel
     * để hiển thị tooltip tại đúng vị trí node.
     */
    const toScreenPos = (sldX: number, sldY: number, t: typeof transform) => {
      const rad = (t.vr * Math.PI) / 180;
      const cx = SLD_W / 2, cy = SLD_H / 2;
      // Xoay điểm quanh tâm SLD rồi áp tỉ lệ + offset viewport
      const rx = Math.cos(rad) * (sldX - cx) - Math.sin(rad) * (sldY - cy) + cx;
      const ry = Math.sin(rad) * (sldX - cx) + Math.cos(rad) * (sldY - cy) + cy;
      return { sx: rx * t.vs + t.vx, sy: ry * t.vs + t.vy };
    };

    /** Tìm node gần nhất tại vị trí chuột trên viewport để hover ổn định dù SVG bị rotate/scale. */
    const hitTestPointAtScreenPos = (clientX: number, clientY: number) => {
      if (!viewportRef.current) return null;
      const r = viewportRef.current.getBoundingClientRect();
      const x = clientX - r.left;
      const y = clientY - r.top;

      let bestId: string | null = null;
      let bestDist = Infinity;

      for (const p of pointsRef.current) {
        const isCam = p.deviceType?.startsWith('camera');
        const baseR = isCam ? Math.max(p.r ?? 8, 5) : (p.r ?? 8);
        const hitR = Math.max(baseR * transformRef.current.vs * 2.2, 20);
        const { sx, sy } = toScreenPos(p.x, p.y, transformRef.current);
        const dist = Math.hypot(x - sx, y - sy);
        if (dist <= hitR && dist < bestDist) {
          bestId = p.id;
          bestDist = dist;
        }
      }

      return bestId;
    };

    const handleViewportMouseMove = (e: React.MouseEvent) => {
      if (editMode || draggingPointId.current || isPanning.current) return;
      const nextId = hitTestPointAtScreenPos(e.clientX, e.clientY);
      setHoveredNodeId(prev => (prev === nextId ? prev : nextId));
    };

    useEffect(() => {
      const onMove = (e: MouseEvent) => {
        if (draggingPointId.current && viewportRef.current) {
          const r = viewportRef.current.getBoundingClientRect();
          const t = transformRef.current;
          setPoints(prev => prev.map(p =>
            p.id === draggingPointId.current
              ? { ...p, x: (e.clientX - r.left - t.vx) / t.vs, y: (e.clientY - r.top - t.vy) / t.vs }
              : p
          ));
          return;
        }
        if (!isPanning.current) return;
        setTransform(prev => ({
          ...prev,
          vx: startPan.current.vx + (e.clientX - startPan.current.x),
          vy: startPan.current.vy + (e.clientY - startPan.current.y),
        }));
      };

      const onUp = (e: MouseEvent) => {
        if (draggingPointId.current) {
          const p = pointsRef.current.find(pt => pt.id === draggingPointId.current);
          if (p) {
            const dx = e.clientX - mouseDownScreen.current.x;
            const dy = e.clientY - mouseDownScreen.current.y;
            if (dx * dx + dy * dy < 16) {
              // Click → chọn node, hiện setting bên panel phải
              onNodeSelect?.(p);
            } else {
              stationApi.updateSldPoint(p.id, { x: Math.round(p.x), y: Math.round(p.y) })
                .then(() => onPointsChanged?.()).catch(console.error);
            }
          }
          draggingPointId.current = null;
          return;
        }
        isPanning.current = false;
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    }, []);

    /** Bắt đầu kéo node (editMode) hoặc pan canvas khi nhấn chuột xuống. */
    const handleMouseDown = (e: React.MouseEvent) => {
      if (editMode) {
        const pointEl = (e.target as Element).closest('g.sld-point-g');
        if (pointEl) {
          const id = pointEl.getAttribute('data-point-id');
          if (id) { draggingPointId.current = id; mouseDownScreen.current = { x: e.clientX, y: e.clientY }; return; }
        }
        onNodeSelect?.(null);
      }
      isPanning.current = true;
      startPan.current = { x: e.clientX, y: e.clientY, vx: transform.vx, vy: transform.vy };
    };

    /** Zoom in/out vào vị trí con trỏ chuột bằng scroll wheel (giới hạn 0.2x–10x). */
    const handleWheel = (e: React.WheelEvent) => {
      e.preventDefault();
      if (!viewportRef.current) return;
      const r = viewportRef.current.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      let ns = transform.vs * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
      ns = Math.min(10, Math.max(0.2, ns));
      // Giữ điểm dưới con trỏ cố định khi zoom
      setTransform(prev => ({ ...prev, vs: ns, vx: cx - (cx - prev.vx) * (ns / prev.vs), vy: cy - (cy - prev.vy) * (ns / prev.vs) }));
    };

    /** Cho phép drop thiết bị vào canvas khi ở chế độ chỉnh sửa. */
    const handleDragOver = (e: React.DragEvent) => { if (!editMode) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };

    /** Xử lý thả thiết bị từ panel vào canvas — chuyển tọa độ màn hình sang tọa độ SLD. */
    const handleDrop = (e: React.DragEvent) => {
      if (!editMode || !viewportRef.current) return;
      e.preventDefault();
      const deviceId = e.dataTransfer.getData('device_id');
      const deviceName = e.dataTransfer.getData('device_name');
      if (!deviceId) return;
      const r = viewportRef.current.getBoundingClientRect();
      const t = transformRef.current;
      const baseX = Math.round((e.clientX - r.left - t.vx) / t.vs);
      const baseY = Math.round((e.clientY - r.top - t.vy) / t.vs);
      // Luôn tạo 1 node duy nhất per device (không tách ra từng sensor)
      onNodeDropped?.(baseX, baseY, deviceId, deviceName, deviceId);
    };

    /**
     * Trả về màu điểm node theo loại thiết bị và trạng thái kết nối.
     * Camera → xanh accent, offline → đỏ, online → xanh success.
     */
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // Tính level trực tiếp từ sensor value + rule config — không qua DB alert.
    // Mỗi lần sensor hoặc rules thay đổi → recompute ngay lập tức.
    const dotLevelByPoint = useMemo(() => {
      const map = new Map<string, 'alarm' | 'warning'>();

      for (const rule of rules) {
        if (!rule.enabled || !rule.deviceId) continue;
        let cond: any;
        try { cond = JSON.parse(rule.condition); } catch { continue; }

        const pointId: string = cond.point;
        const op: string     = cond.op ?? '>';
        const alarm: number | null  = cond.alarm  != null ? Number(cond.alarm)     : null;
        const preAlarm: number | null = cond.pre_alarm != null ? Number(cond.pre_alarm) : null;
        if (!pointId) continue;

        const key = `${rule.deviceId.toLowerCase()}|${pointId.toLowerCase()}`;
        const sKey = `${rule.deviceId.toLowerCase()}|${pointId.toLowerCase()}`;
        const sensor = sensorMap.get(sKey);
        if (!sensor || sensor.value == null || sensor.quality !== 0) continue;
        const val = sensor.value;

        const evaluate = (v: number, o: string, t: number) => {
          if (o === '>')  return v > t;
          if (o === '>=') return v >= t;
          if (o === '<')  return v < t;
          if (o === '<=') return v <= t;
          if (o === '==') return Math.abs(v - t) < 0.001;
          return false;
        };

        const alarmHit   = alarm   != null && evaluate(val, op, alarm);
        const warningHit = preAlarm != null && evaluate(val, op, preAlarm) && !alarmHit;

        if (alarmHit) {
          map.set(key, 'alarm');
        } else if (warningHit && map.get(key) !== 'alarm') {
          map.set(key, 'warning');
        }
      }
      return map;
    }, [rules, sensorMap]);

    const getThresholdLevel = (deviceId?: string, pointId?: string, value?: number): 'alarm' | 'warning' | undefined => {
      if (!deviceId || !pointId || value == null) return undefined;
      const deviceKey = deviceId.toLowerCase();
      const rawKey = pointId.toLowerCase().trim();
      const suffixKey = rawKey.includes('_') ? rawKey.split('_').pop() || rawKey : rawKey;
      const candidates = [
        `${deviceKey}|${rawKey}`,
        `${deviceKey}|${suffixKey}`,
        `${deviceId}_${pointId}`.toLowerCase(),
      ];
      let cfg: { warn: number | null; alarm: number | null } | undefined;
      for (const key of candidates) {
        cfg = sensorThresholds[key];
        if (cfg) break;
      }
      if (!cfg) return undefined;
      if (cfg.alarm !== null && value >= cfg.alarm) return 'alarm';
      if (cfg.warn !== null && value >= cfg.warn) return 'warning';
      return undefined;
    };

    const getDotLevel = (deviceId?: string, pointId?: string, value?: number) => {
      if (!deviceId || !pointId) return undefined;
      return getThresholdLevel(deviceId, pointId, value) || dotLevelByPoint.get(`${deviceId.toLowerCase()}|${pointId.toLowerCase()}`);
    };

    /** Tìm trạng thái worst-case cho toàn bộ device (duyệt tất cả sensor points). */
    const getDeviceWorstLevel = (deviceId?: string): 'alarm' | 'warning' | undefined => {
      if (!deviceId) return undefined;
      const prefix = deviceId.toLowerCase() + '|';
      let worst: 'alarm' | 'warning' | undefined;
      dotLevelByPoint.forEach((level, key) => {
        if (!key.startsWith(prefix)) return;
        if (UUID_RE.test(key.slice(prefix.length))) return;
        if (level === 'alarm') worst = 'alarm';
        else if (level === 'warning' && worst !== 'alarm') worst = 'warning';
      });
      // Ngưỡng từ tab thiết bị (camera ROI) — chỉ áp dụng cho đúng thiết bị, bỏ zone UUID
      sensorMap.forEach(sensor => {
        if (!sensor.deviceId || sensor.deviceId.toLowerCase() !== deviceId) return;
        if (UUID_RE.test(sensor.pointId)) return;
        const level = getThresholdLevel(sensor.deviceId, sensor.pointId, sensor.value);
        if (level === 'alarm') worst = 'alarm';
        else if (level === 'warning' && worst !== 'alarm') worst = 'warning';
      });
      return worst;
    };

    const getDotColor = (type?: string, _status?: string, deviceId?: string, _pointId?: string) => {
      if (type?.startsWith('camera')) {
        // Camera: chỉ dùng ngưỡng ROI cấu hình trực tiếp, không qua rule system (P1-P20 seeded rules)
        let worst: 'alarm' | 'warning' | undefined;
        const did = deviceId?.toLowerCase();
        if (did) {
          sensorMap.forEach(sensor => {
            if (!sensor.deviceId || sensor.deviceId.toLowerCase() !== did) return;
            if (UUID_RE.test(sensor.pointId)) return;
            const lv = getThresholdLevel(sensor.deviceId, sensor.pointId, sensor.value);
            if (lv === 'alarm') worst = 'alarm';
            else if (lv === 'warning' && worst !== 'alarm') worst = 'warning';
          });
        }
        if (worst === 'alarm')   return 'var(--admin-danger)';
        if (worst === 'warning') return 'var(--admin-warning)';
        return 'var(--admin-accent)';
      }
      const deviceLevel = getDeviceWorstLevel(deviceId);
      if (deviceLevel === 'alarm')   return 'var(--admin-danger)';
      if (deviceLevel === 'warning') return 'var(--admin-warning)';
      return 'var(--admin-success)';
    };

    /**
     * Tính offset (bx, by) pixel cho badge giá trị của node
     * dựa trên vị trí (top/bottom/left/right), tỉ lệ zoom và kích thước badge.
     */
    const getBadgeOffset = (pos: BadgeConfig['pos'], vs: number, r: number, bw: number, bh: number) => {
      const c = r * vs + 2;
      switch (pos) {
        case 'bottom': return { bx: 0, by: c + bh / 2 };
        case 'left':   return { bx: -(c + bw / 2 + 2), by: 0 };
        case 'right':  return { bx: c + bw / 2 + 2, by: 0 };
        default:       return { bx: 0, by: -(c + bh / 2) };
      }
    };

    /** Lấy tất cả sensor readings cho 1 device */
    const getDeviceSensors = (deviceId?: string): SensorPoint[] => {
      if (!deviceId) return [];
      const prefix = deviceId.toLowerCase() + '|';
      const result: SensorPoint[] = [];
      sensorMap.forEach((sensor, key) => {
        if (key.startsWith(prefix)) result.push(sensor);
      });
      return result;
    };

    /** Render tooltip nổi hiển thị TẤT CẢ sensor readings của thiết bị khi hover. */
    const renderTooltip = () => {
      if (!hoveredNodeId || editMode) return null;
      const p = points.find(pt => pt.id === hoveredNodeId);
      if (!p) return null;
      const pointName = `${p.label || ''} ${p.deviceName || ''}`.toLowerCase();
      const isCamera = p.deviceType?.startsWith('camera')
        || /camera|hikvision|quang học/.test(pointName);
      if (isCamera) return null;
      
      const allDeviceSensors = getDeviceSensors(p.deviceId);
      const { sx, sy } = toScreenPos(p.x, p.y, transform);

      const TYPE_VI: Record<string, string> = {
        camera_dual: 'Camera Kép', camera_thermal: 'Camera Nhiệt',
        camera_cctv: 'Camera CCTV', camera_pd: 'Camera PD',
        cabinet: 'Tủ điện', plc_s7: 'PLC S7', sensor_temp: 'Cảm biến nhiệt',
      };
      const typeLabel = TYPE_VI[p.deviceType ?? ''] || p.deviceType || 'Thiết bị';
      const nameLabel = p.label || p.deviceName || '';

      // Short-ID pattern: "D1", "D2", "P1", "P2" — 1-2 ký tự + chữ số
      const SHORT_ID_RE = /^[A-Za-z]{1,2}\d*$/;
      const dedupeCamera = (sensors: SensorPoint[]): SensorPoint[] => {
        // Bỏ UUID (zone) và short-ID nếu đã có bản dài hơn với cùng value
        const longNames = new Set(sensors.filter(s => !UUID_RE.test(s.pointId) && !SHORT_ID_RE.test(s.pointId)).map(s => s.pointId));
        return sensors.filter(s => {
          if (UUID_RE.test(s.pointId)) return false;
          if (SHORT_ID_RE.test(s.pointId) && longNames.size > 0) return false;
          return true;
        });
      };
      const deviceSensors = p.deviceType?.startsWith('camera')
        ? dedupeCamera(allDeviceSensors)
        : allDeviceSensors;

      return (
        <div style={{
          position: 'fixed', top: sy + 15, left: sx + 15, zIndex: 100,
          background: 'var(--admin-overlay)', backdropFilter: 'blur(8px)',
          border: '1px solid var(--admin-accent)', borderRadius: 4, padding: '8px 12px',
          boxShadow: 'var(--admin-shadow)', pointerEvents: 'none',
          animation: 'tooltipFadeIn 0.15s ease-out', minWidth: 140
        }}>
          <div style={{ fontSize: '.6rem', color: 'var(--admin-text-muted)', fontWeight: 800, textTransform: 'uppercase', marginBottom: 2 }}>{typeLabel}</div>
          {nameLabel && <div style={{ fontSize: '.8rem', fontWeight: 700, color: 'var(--admin-text)', marginBottom: 4 }}>{nameLabel}</div>}
          <div style={{ height: 1, background: 'var(--admin-border-light)', margin: '4px 0' }} />
          {deviceSensors.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {deviceSensors.map(s => {
                const isOffline = s.quality === 2;
                const isCamSensor = !!(p.deviceType?.startsWith('camera') || s.unit === '°C' || s.unit === '℃');
                // Camera/nhiệt: dùng ngưỡng ROI trực tiếp (không qua rule system chung)
                const level = isOffline ? undefined
                  : isCamSensor
                    ? getThresholdLevel(p.deviceId, s.pointId, s.value)
                    : getDotLevel(p.deviceId, s.pointId, s.value);
                const indiColor = s.value === 0 ? 'var(--admin-accent)' : s.value === 1 ? 'var(--admin-warning)' : 'var(--admin-danger)';
                const indiLabel = s.value === 0 ? 'Bình thường' : s.value === 1 ? 'Cảnh báo' : 'Báo động';
                const color = isOffline ? 'var(--admin-text-muted)' : s.pointId === 'pd_indi' ? indiColor : level === 'alarm' ? 'var(--admin-danger)' : level === 'warning' ? 'var(--admin-warning)' : 'var(--admin-success)';
                const valStr = isOffline ? '---'
                  : s.pointId === 'pd_indi' ? indiLabel
                  : `${Math.round(s.value * 10) / 10}${s.unit || ''}`;
                return (
                  <div key={s.pointId} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <span style={{ fontSize: '.65rem', color: 'var(--admin-text-muted)', fontWeight: 600 }}>{s.pointId.replace(/_/g, ' ')}</span>
                    <span style={{ fontSize: '.7rem', fontWeight: 800, color, fontFamily: 'Consolas, monospace' }}>{valStr}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ fontSize: '.7rem', color: 'var(--admin-text-muted)' }}>Chưa có dữ liệu</div>
          )}
          {p.deviceStatus === 'offline' && <div style={{ fontSize: '.6rem', color: 'var(--admin-danger)', marginTop: 4, fontWeight: 700 }}>⚠️ NGOẠI TUYẾN</div>}
        </div>
      );
    };

    return (
      <div id="sldViewport" ref={viewportRef}
        onMouseDown={handleMouseDown} onMouseMove={handleViewportMouseMove} onMouseLeave={() => setHoveredNodeId(null)} onWheel={handleWheel} onDragOver={handleDragOver} onDrop={handleDrop}
        style={{ position: 'absolute', top: SLD_TOP_OFFSET, left: 0, right: 0, bottom: 0, overflow: 'hidden', cursor: 'grab', backgroundColor: 'var(--admin-bg)', willChange: 'transform' }}
      >
        <svg id="sld-canvas" style={{ width: '100%', height: '100%', display: 'block', backgroundColor: 'var(--admin-bg)' }} xmlns="http://www.w3.org/2000/svg"
          shapeRendering="crispEdges" textRendering="geometricPrecision">
          <defs>
            <filter id="sld-color-filter" colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
              <feColorMatrix id="sld-color-matrix" type="matrix" values={colorMatrix || (['light','soft-light','silver'].includes(themeId) ? LIGHT_MATRIX : DARK_MATRIX)} />
            </filter>
          </defs>
          <g id="sld-world" transform={`translate(${Math.round(transform.vx)},${Math.round(transform.vy)}) scale(${transform.vs}) rotate(${transform.vr}, ${SLD_W / 2}, ${SLD_H / 2})`}>
            <g id="sld-bg">
              <rect width={SLD_W} height={SLD_H} fill="none" />
              {svgUrl ? (
                <image href={svgUrl.startsWith('/sld/') ? `${API_BASE_URL}${svgUrl}` : svgUrl}
                  x="0" y="0" width={SLD_W} height={SLD_H} preserveAspectRatio="xMidYMid meet"
                  filter="url(#sld-color-filter)"
                  style={{ imageRendering: 'crisp-edges' } as React.CSSProperties} />
              ) : (
                <text x={SLD_W / 2} y={SLD_H / 2} textAnchor="middle" fill="var(--admin-border)" fontSize="18" fontFamily="sans-serif">
                  Chưa có sơ đồ — Bật "Chỉnh sơ đồ" và upload file SVG
                </text>
              )}
            </g>
            <g id="dash-dots">
              {points.map(p => {
                const deviceSensors = getDeviceSensors(p.deviceId);
                const cfg = { ...DEFAULT_BADGE, ...(badgeCfgs[p.id] || {}) };
                const isCam = p.deviceType?.startsWith('camera');
                const camTypeLabel = isCam
                  ? ({ camera_thermal: 'Nhiệt', camera_pd: 'PD', camera_dual: 'Kép', camera_optical: 'Thường' }[p.deviceType ?? ''] ?? 'Cam')
                  : null;
                const label = p.label || (isCam ? camTypeLabel! : deviceSensors.length > 0 ? `${deviceSensors.length} điểm` : '--');
                const r = isCam ? Math.max(p.r, 5) : p.r;
                const bh = cfg.size + 6;
                const bw = Math.max(bh * 2, label.length * cfg.size * 0.62 + 10);
                const badgeR = isCam ? r * 0.65 : p.r;
                const { bx, by } = getBadgeOffset(cfg.pos, transform.vs, badgeR, bw, bh);
                const isSelected = selectedNodeId === p.id;
                const dotColor = getDotColor(p.deviceType, p.deviceStatus, p.deviceId, p.pointId);
                const isAlerted = dotColor !== 'var(--admin-success)' && dotColor !== 'var(--admin-accent)';
                const badgeTextColor = isAlerted
                  ? dotColor
                  : deviceSensors.length > 0 ? cfg.color : (['light','soft-light','silver'].includes(themeId) ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.55)');
                const pid = (p.pointId || '').toLowerCase();
                const isThermal = pid.includes('nhiet_do') || pid.startsWith('temp');
                const isPd = pid === 'phong_dien' || pid === 'pd' || (pid.startsWith('pd') && !isThermal);
                const isPlcAll = p.deviceType === 'plc_s7' && (pid === (p.deviceId || '').toLowerCase());
                const pulsing = !isCam && getDeviceWorstLevel(p.deviceId);
                // Màu icon cố định — không trùng với màu vàng/cam của sơ đồ
                const iconColor = isAlerted ? dotColor
                  : isCam ? '#60a5fa'
                  : isThermal ? '#f87171'
                  : isPd ? '#a78bfa'
                  : isPlcAll ? '#34d399'
                  : dotColor;
                const hitR = Math.max(r * 2.5, 14);
                return (
                  <g key={p.id} className="sld-point-g" data-point-id={p.id}
                    transform={`rotate(${-transform.vr}, ${p.x}, ${p.y})`}
                    style={{ cursor: editMode ? 'move' : 'pointer' }}
                    onMouseEnter={() => setHoveredNodeId(p.id)}
                  >
                    {/* Hit circle: onMouseMove dùng distance để tìm đúng node gần nhất, bất kể z-order */}
                    <circle cx={p.x} cy={p.y} r={hitR} fill="rgba(0,0,0,0.001)"
                      onMouseMove={editMode ? undefined : (e) => {
                        const nextId = hitTestPointAtScreenPos(e.clientX, e.clientY);
                        setHoveredNodeId(prev => prev === nextId ? prev : nextId);
                      }}
                    />
                    {isCam ? (
                      /* ── CAMERA icon (outline) ── */
                      <g>
                        <g transform={`translate(${p.x - r * 0.72}, ${p.y - r * 0.5}) scale(${r / 7})`}>
                          <rect x="0" y="1.5" width="9" height="6" rx="1"
                            fill="none" stroke={iconColor} strokeWidth={isSelected ? 1.8 : 1} />
                          <polygon points="9,3 12,1.5 12,7.5 9,6"
                            fill="none" stroke={iconColor} strokeWidth={isSelected ? 1.8 : 1} strokeLinejoin="round" />
                        </g>
                      </g>
                    ) : isThermal ? (
                      /* ── THERMAL icon (outline nhiệt kế) ── */
                      <g style={pulsing ? { animation: 'sldDotPulse 1.2s ease-in-out infinite' } : undefined}>
                        <rect x={p.x - r * 0.18} y={p.y - r * 0.85} width={r * 0.36} height={r * 0.8} rx={r * 0.18}
                          fill="none" stroke={iconColor} strokeWidth={isSelected ? 1.8 : 1} />
                        <circle cx={p.x} cy={p.y + r * 0.22} r={r * 0.4}
                          fill="none" stroke={iconColor} strokeWidth={isSelected ? 1.8 : 1} />
                      </g>
                    ) : isPd ? (
                      /* ── PD icon (outline tia sét) ── */
                      <g style={pulsing ? { animation: 'sldDotPulse 1.2s ease-in-out infinite' } : undefined}>
                        <polygon
                          points={`${p.x + r * 0.25},${p.y - r} ${p.x - r * 0.15},${p.y + r * 0.05} ${p.x + r * 0.15},${p.y + r * 0.05} ${p.x - r * 0.25},${p.y + r}`}
                          fill="none" stroke={iconColor} strokeWidth={isSelected ? 1.8 : 1} strokeLinejoin="round" />
                      </g>
                    ) : isPlcAll ? (
                      /* ── PLC chip icon (outline) ── */
                      <g style={pulsing ? { animation: 'sldDotPulse 1.2s ease-in-out infinite' } : undefined}>
                        <rect x={p.x - r} y={p.y - r} width={r * 2} height={r * 2} rx={r * 0.2}
                          fill="none" stroke={iconColor} strokeWidth={isSelected ? 1.8 : 1} />
                        {([-0.4, 0.4] as number[]).flatMap(dy => ([-0.4, 0.4] as number[]).map(dx => (
                          <circle key={`${dx},${dy}`} cx={p.x + r * dx} cy={p.y + r * dy} r={r * 0.15}
                            fill="none" stroke={iconColor} strokeWidth={0.8} />
                        )))}
                      </g>
                    ) : (
                      /* ── DEFAULT dot (outline) ── */
                      <circle cx={p.x} cy={p.y} r={r}
                        fill="none" stroke={iconColor} strokeWidth={isSelected ? 2 : 1}
                        style={pulsing ? { animation: 'sldDotPulse 1.2s ease-in-out infinite' } : undefined}
                      />
                    )}
                    {showLabels && p.label && (
                      <text x={p.x} y={p.y - r - 3} textAnchor="middle" fontSize="7" fontFamily="sans-serif"
                        fontWeight="700" fill={iconColor} style={{ pointerEvents: 'none' }}>
                        {p.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </g>
        </svg>

        {renderTooltip()}

        <style>{`
          @keyframes tooltipFadeIn {
            from { opacity: 0; transform: translateY(5px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes sldDotPulse {
            0%, 100% { opacity: 0.9; }
            50% { opacity: 0.35; }
          }
        `}</style>
      </div>
    );
  }
);

export { DEFAULT_BADGE, BADGE_COLORS };
export default SldCanvas;
