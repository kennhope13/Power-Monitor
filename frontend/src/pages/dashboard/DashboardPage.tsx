// ============================================================
// DashboardPage.tsx — Trang tổng quan chính
// Hiển thị: Sơ đồ một sợi (SLD) + KPI + Camera + Cảnh báo
// Nhận cập nhật realtime qua SignalR (SensorUpdate, AlertNew, AlertUpdated)
// ============================================================

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SensorPoint, stationApi, Rule } from '@/services/StationApiService';
import { useStationStore, useDeviceStore, useAlertStore, useSensorStore } from '@/store';
import { ALERT_STATUS, DEVICE_STATUS } from '@/types/enums';
import { useRealtime } from '@/hooks/useRealtime';
import { DEV_PLC_S7, DEV_CAM_TYPES } from '@/constants/devices';
import type { AlertItem } from '@/types/api.types';

import SldCanvas, { SldCanvasRef } from '@/components/dashboard/sld/SldCanvas';
import SldEditPanel from '@/components/dashboard/sld/SldEditPanel';
import DashboardToolbar from '@/components/dashboard/toolbar/DashboardToolbar';
import CameraLiveViewer from '@/components/dashboard/camera/CameraLiveViewer';
import AlertPanel from '@/components/dashboard/alerts/AlertPanel';
import { confirmDialog } from '@/utils/confirm';

/**
 * Trang tổng quan chính — hiển thị SLD, KPI, camera live và cảnh báo.
 * Nhận cập nhật realtime qua SignalR và tự động resolve stationId từ URL hoặc API.
 */
export default function DashboardPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Ưu tiên stationId từ URL (?stationId=...), nếu không có thì thử stationCode, cuối cùng fetch trạm đầu tiên
  const [stationId, setStationId] = useState(searchParams.get('stationId') ?? '');
  const [stationName, setStationName] = useState(searchParams.get('stationName') ?? '');
  const urlStationCode = searchParams.get('stationCode') ?? '';
  const [isEditMode, setIsEditMode] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [filters, setFilters] = useState({ thermal: true, pd: true, camera: true });


  const [dashboardCam, setDashboardCam] = useState<string>(() => {
    return localStorage.getItem('dashboard_selected_cam') || '';
  });

  const sldRef = useRef<SldCanvasRef>(null);
  const [selectedNode, setSelectedNode] = useState<any | null>(null);
  const [selectedCabinet, setSelectedCabinet] = useState<any | null>(null);
  const [sldColorMatrix, setSldColorMatrix] = useState<string | undefined>(undefined);
  const [sldRefreshTick, setSldRefreshTick] = useState(0);
  const [rules, setRules] = useState<Rule[]>([]);
  const [sensorThresholds, setSensorThresholds] = useState<Record<string, { warn: number | null; alarm: number | null }>>({});
  const [unpinnedCount, setUnpinnedCount] = useState(0);
  const [pointNamesMap, setPointNamesMap] = useState<Record<string, string>>({});
  const sldFallbackTriedRef = useRef<string | null>(null);

  // ── Global stores ─────────────────────────────────────────────
  const stations = useStationStore(s => s.stations);
  const fetchStations = useStationStore(s => s.fetch);
  const getFirstStationId = useStationStore(s => s.getFirstStationId);
  const viewingStationId = useStationStore(s => s.viewingStationId);
  const setViewingStation = useStationStore(s => s.setViewingStation);

  // Lấy map gốc rồi useMemo derive ra array — tránh infinite re-render do `?? []` tạo ref mới
  const devicesByStation = useDeviceStore(s => s.devicesByStation);
  const fetchDevices = useDeviceStore(s => s.fetch);
  const devices = useMemo(() => stationId ? (devicesByStation[stationId] ?? []) : [], [stationId, devicesByStation]);

  const alertsByFilter = useAlertStore(s => s.alertsByFilter);
  const fetchAlerts = useAlertStore(s => s.fetch);
  const invalidateAlerts = useAlertStore(s => s.invalidate);
  const alerts = useMemo(() => alertsByFilter[ALERT_STATUS.OPEN] ?? [], [alertsByFilter]);

  const pointsByStation = useSensorStore(s => s.pointsByStation);
  const fetchSensors = useSensorStore(s => s.fetch);
  const sensors = useMemo(() => stationId ? (pointsByStation[stationId] ?? []) : [], [stationId, pointsByStation]);

  // ── Derived data ──────────────────────────────────────────────
  const plcOnline = useMemo(
    () => devices.some(d => d.type === DEV_PLC_S7 && d.status === DEVICE_STATUS.ONLINE),
    [devices]
  );



  const liveCameraSrc = useMemo(() => {
    const cam = devices.find(d => DEV_CAM_TYPES.some(t => d.type?.includes(t)));
    if (!cam) return undefined;
    const cfg = (cam as any).config || {};
    return (cfg.go2rtc_optical || cfg.go2rtc_id || cfg.go2rtc_thermal) as string | undefined;
  }, [devices]);

  const refreshDashboardData = useCallback(() => {
    if (!stationId) return;
    fetchSensors(stationId);
    fetchDevices(stationId);
    fetchAlerts(ALERT_STATUS.OPEN);
    stationApi.getRules()
      .then(allRules => {
        const sid = stationId.toLowerCase();
        setRules(allRules.filter(r => (r.stationId || '').toLowerCase() === sid));
      })
      .catch(() => setRules([]));

    stationApi.getSld(stationId)
      .then(async data => {
        if (data.svgUrl) {
          setUnpinnedCount(data.unpinned?.length || 0);
          return;
        }

        // Nếu trạm hiện tại chưa có SLD active, tự dò trạm khác có sơ đồ
        if (sldFallbackTriedRef.current === stationId) return;
        sldFallbackTriedRef.current = stationId;

        const stationList = stations.length > 0 ? stations : await fetchStations();
        const otherStations = stationList.filter(s => s.id !== stationId);

        for (const s of otherStations) {
          try {
            const candidate = await stationApi.getSld(s.id);
            if (!candidate.svgUrl) continue;

            setStationId(s.id);
            setStationName(s.name);
            localStorage.setItem('selected_station_id', s.id);
            setUnpinnedCount(candidate.unpinned?.length || 0);
            return;
          } catch {
            continue;
          }
        }
      })
      .catch(() => {});
  }, [stationId, fetchSensors, fetchDevices, fetchAlerts, fetchStations, stations]);


  // ── Resolve stationId nếu chưa có ──────────────────────────────
  useEffect(() => {
    // Set default SLD color to Safety Orange (#f59e0b) to match Industrial interface
    handleColorChange('#f59e0b');

    if (stationId) {
      localStorage.setItem('selected_station_id', stationId);
      return;
    }

    // Nếu có stationCode từ URL, tìm station tương ứng theo code
    if (urlStationCode) {
      fetchStations().then(() => {
        const found = useStationStore.getState().stations.find(
          (s: any) => s.code?.toLowerCase() === urlStationCode.toLowerCase()
        );
        if (found) {
          setStationId(found.id);
          setStationName(found.name);
          localStorage.setItem('selected_station_id', found.id);
        }
      }).catch(() => {});
      return;
    }

    getFirstStationId().then(id => { 
      if (id) {
        setStationId(id);
        localStorage.setItem('selected_station_id', id);
      } 
    }).catch(() => { });
  }, [stationId, urlStationCode, getFirstStationId, fetchStations]);

  /** Lưu camera đang chọn vào state và localStorage để giữ lại sau khi tải lại trang. */
  const handleCamChange = (srcId: string) => {
    setDashboardCam(srcId);
    localStorage.setItem('dashboard_selected_cam', srcId);
  };

  // ── Resolve stationName ────────────────────────────────────────
  useEffect(() => {
    if (!stationId || stationName) return;
    fetchStations().then(() => {
      const found = stations.find(s => s.id === stationId);
      if (found) setStationName(found.name);
    }).catch(() => { });
  }, [stationId, stationName, fetchStations, stations]);

  // ── Fetch data khi stationId thay đổi ─────────────────────────
  useEffect(() => {
    refreshDashboardData();
  }, [stationId, refreshDashboardData, sldRefreshTick]);

  useEffect(() => {
    const onFocus = () => refreshDashboardData();
    const onVis = () => {
      if (document.visibilityState === 'visible') refreshDashboardData();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refreshDashboardData]);

  // Fetch friendly names for points (Thermal ROI & PD Regions)
  useEffect(() => {
    if (!stationId || devices.length === 0) return;
    const cams = devices.filter(d => DEV_CAM_TYPES.some(t => d.type?.includes(t)));
    if (cams.length === 0) return;

    const fetchAllNames = async () => {
      const newMap: Record<string, string> = {};
      const nextThresholds: Record<string, { warn: number | null; alarm: number | null }> = {};
      const setThresholdCfg = (
        deviceId: string,
        cfg: { warn: number | null; alarm: number | null },
        aliases: Array<string | null | undefined>
      ) => {
        aliases.forEach(alias => {
          const normalized = (alias || '').trim().toLowerCase();
          if (!normalized) return;
          nextThresholds[`${deviceId}|${normalized}`] = cfg;
        });
      };
      await Promise.all(cams.map(async (cam) => {
        try {
          const [pts, rois] = await Promise.all([
            stationApi.getRoiPoints(cam.id).catch(() => []),
            stationApi.getBoundaries(cam.id).catch(() => [])
          ]);
          pts.forEach(p => {
            if (p.pointId) newMap[`${cam.id}_${p.pointId}`.toUpperCase()] = p.label || p.name || '';
            const cfg = {
              warn: p.warningThreshold || p.preAlarmThreshold || null,
              alarm: p.alarmThreshold || null,
            };
            setThresholdCfg(cam.id, cfg, [p.pointId, p.name, p.label, p.id]);
          });
          rois.forEach(r => {
            let descriptiveName = r.name;
            try {
              const t = JSON.parse(r.thresholds || '{}');
              if (t.fullName) descriptiveName = t.fullName;
              const cfg = {
                warn: t.warning || t.preAlarm || null,
                alarm: t.alarm || null,
              };
              setThresholdCfg(cam.id, cfg, [r.name, r.id, t.fullName]);
            } catch {}
            
            newMap[`${cam.id}_${r.id}`.toUpperCase()] = descriptiveName;
            newMap[`${cam.id}_${r.name}`.toUpperCase()] = descriptiveName;
          });
        } catch {}
      }));
      setPointNamesMap(newMap);
      setSensorThresholds(nextThresholds);
    };
    fetchAllNames();
  }, [stationId, devices]);

  // Keep track of the last seen alert ID to detect when a new alert actually arrives
  const lastAlertIdRef = useRef<string>('');

  useEffect(() => {
    const first = alerts[0];
    if (!first) return;

    let newestAlert: AlertItem = first;
    for (let i = 1; i < alerts.length; i++) {
      const item = alerts[i];
      if (item && new Date(item.triggeredAt).getTime() > new Date(newestAlert.triggeredAt).getTime()) {
        newestAlert = item;
      }
    }

    if (newestAlert.id !== lastAlertIdRef.current) {
      if (devices.length === 0) return; // Đợi danh sách thiết bị tải xong
      lastAlertIdRef.current = newestAlert.id;
      const streamId = findCameraStreamForDevice(newestAlert, devices);
      if (streamId) {
        handleCamChange(streamId);
      }
    }
  }, [alerts, devices]);

  // ── Realtime cập nhật ─────────────────────────────────────────
  useRealtime({
    onSensorUpdate: (data: SensorPoint[]) => {
      // Cập nhật cache sensor (merge từng point)
      useSensorStore.setState(s => {
        if (!stationId) return s;
        const current = s.pointsByStation[stationId] ?? [];
        const updated = [...current];
        data.forEach(d => {
          const idx = updated.findIndex(p => p.pointId === d.pointId && p.deviceId === d.deviceId);
          if (idx >= 0) updated[idx] = d; else updated.push(d);
        });
        return {
          ...s,
          pointsByStation: { ...s.pointsByStation, [stationId]: updated },
        };
      });
    },
    onAlertNew: () => { invalidateAlerts(ALERT_STATUS.OPEN); fetchAlerts(ALERT_STATUS.OPEN, true); },
    onAlertUpdated: () => { invalidateAlerts(ALERT_STATUS.OPEN); fetchAlerts(ALERT_STATUS.OPEN, true); },
  }, [stationId]);

  // Fit sơ đồ SLD vừa khung nhìn
  const handleFit = () => sldRef.current?.fitView();
  // Xoay sơ đồ SLD 90 độ
  const handleRotate = () => sldRef.current?.rotateView();

  useEffect(() => {
    if (!isEditMode || !selectedNode) return;

    const handleKeyDown = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTypingField = tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
      if (isTypingField) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;

      const name = selectedNode.label || selectedNode.pointId || 'Node';
      if (!await confirmDialog({ title: 'Xóa node', message: `Xóa node "${name}"?`, confirmText: 'Xóa', danger: true })) return;

      try {
        await sldRef.current?.deleteNode(selectedNode.id);
        setSelectedNode(null);
        setSldRefreshTick(t => t + 1);
      } catch (err) {
        console.error('[DashboardPage] Delete selected node failed:', err);
        alert('Xóa node thất bại');
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isEditMode, selectedNode]);

  /** Chuyển mã màu hex thành feColorMatrix SVG để tô màu lại sơ đồ SLD. */
  const handleColorChange = (hex: string) => {
    const R = parseInt(hex.slice(1, 3), 16) / 255;
    const G = parseInt(hex.slice(3, 5), 16) / 255;
    const B = parseInt(hex.slice(5, 7), 16) / 255;
    const BG = { R: 0.059, G: 0.090, B: 0.165 };
    const m = [BG.R - R, 0, 0, 0, R, 0, BG.G - G, 0, 0, G, 0, 0, BG.B - B, 0, B, 0, 0, 0, 1, 0].join(' ');
    setSldColorMatrix(m);
  };

  const camOptionsGroups = useMemo(() => {
    const groups: Record<string, { id: string, label: string, title: string }[]> = { 'Khác': [] };
    const cameras = devices.filter(d => DEV_CAM_TYPES.some(t => d.type?.includes(t)))
      .filter(cam => cam.type !== 'camera_pd' && !cam.name.toUpperCase().includes('PD') && !cam.name.toUpperCase().includes('PHÓNG ĐIỆN'));
    const nameCounts = cameras.reduce<Record<string, number>>((acc, cam) => {
      const key = cam.name.trim().toLowerCase();
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const shortId = (id?: string) => (id ? id.slice(-4).toUpperCase() : '');
    const shortText = (text: string, max = 22) => {
      const cleaned = text.replace(/\s+/g, ' ').trim();
      return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
    };
    cameras.forEach(cam => {
      // Bỏ qua hoàn toàn các camera chuyên đo phóng điện (PD)
      const cfg = (cam as any).config || {};
      const zone = cfg.zone?.trim() || 'Khác';
      if (!groups[zone]) groups[zone] = [];
      const duplicateName = (nameCounts[cam.name.trim().toLowerCase()] || 0) > 1;
      const kindLabel = cam.type === 'camera_dual'
        ? null
        : cam.type === 'camera_thermal'
          ? 'Nhiệt'
          : 'Quang';

      if (cam.type === 'camera_dual') {
        const fullBase = duplicateName ? `${cam.name} · ${zone}` : cam.name;
        if (cfg.go2rtc_optical) {
          const title = `${fullBase} (Quang)${duplicateName ? ` · ${shortId(cfg.go2rtc_optical)}` : ''}`;
          groups[zone].push({ id: cfg.go2rtc_optical, label: shortText(title), title });
        }
        if (cfg.go2rtc_thermal) {
          const title = `${fullBase} (Nhiệt)${duplicateName ? ` · ${shortId(cfg.go2rtc_thermal)}` : ''}`;
          groups[zone].push({ id: cfg.go2rtc_thermal, label: shortText(title), title });
        }
      } else {
        const streamId = cfg.go2rtc_id || cfg.go2rtc_thermal || cfg.go2rtc_optical;
        if (streamId) {
          const baseLabel = duplicateName ? `${cam.name} · ${zone}` : cam.name;
          const title = duplicateName || kindLabel ? `${baseLabel}${kindLabel ? ` (${kindLabel})` : ''}${duplicateName ? ` · ${shortId(streamId)}` : ''}` : cam.name;
          groups[zone].push({
            id: streamId,
            label: shortText(title),
            title,
          });
        }
      }
    });
    return groups;
  }, [devices]);

  const activeCameraSrc = useMemo(() => {
    const validCameraIds = Object.values(camOptionsGroups).flat().map(opt => opt.id);
    const desired = dashboardCam || liveCameraSrc || '';
    if (validCameraIds.includes(desired)) return desired;
    return validCameraIds[0] || '';
  }, [camOptionsGroups, dashboardCam, liveCameraSrc]);

  const activeCamHasAlert = useMemo(() => {
    return alerts.some(alert => findCameraStreamForDevice(alert, devices) === activeCameraSrc);
  }, [alerts, devices, activeCameraSrc]);


  return (
    <div className="dashboard-page new-dash-theme" style={{ position: 'relative', overflow: 'hidden', height: '100%', background: 'var(--admin-bg)' }}>

      <SldCanvas
        ref={sldRef}
        stationId={stationId}
        editMode={isEditMode}
        showLabels={showLabels}
        colorMatrix={sldColorMatrix}
        sensors={sensors}
        rules={rules}
        sensorThresholds={sensorThresholds}
        selectedNodeId={selectedNode?.id}
        onNodeSelect={(point) => {
          setSelectedNode(point);
          if (!point) { setSelectedCabinet(null); return; }
          const dev = devices.find(d => d.id.toLowerCase() === (point.deviceId ?? '').toLowerCase());
          if (!dev) return;
          if (point.deviceType?.startsWith('camera')) {
            const cfg = (dev as any).config || {};
            const streamId = cfg.go2rtc_optical || cfg.go2rtc_id || cfg.go2rtc_thermal;
            if (streamId) handleCamChange(streamId);
            setSelectedCabinet(null);
          } else if (dev.type === DEV_PLC_S7 || dev.type === 'cabinet') {
            setSelectedCabinet(dev);
          } else {
            setSelectedCabinet(null);
          }
        }}
        onNodeDropped={async (x, y, deviceId, _deviceName, pointId) => {
          try {
            const dev = devices.find(d => d.id.toLowerCase() === deviceId.toLowerCase());
            const isCam = dev && DEV_CAM_TYPES.some(t => dev.type?.includes(t));
            // Ngăn thêm trùng: nếu thiết bị đã có node trên sơ đồ thì bỏ qua
            const existing = sldRef.current?.getPoints() ?? [];
            if (existing.some(p => p.deviceId?.toLowerCase() === deviceId.toLowerCase())) return;
            const newNode = await stationApi.addSldPoint(stationId, {
              x, y, r: isCam ? 10 : 8,
              label: '',
              deviceId: deviceId,
              pointId: pointId
            });
            sldRef.current?.reloadData();
            setSelectedNode(newNode); // Tự động chọn để user có thể nhập tên ngay
            setSldRefreshTick(t => t + 1); // Trigger SldEditPanel refresh
          } catch (e: any) {
            console.error('Lỗi khi thả node:', e);
            alert(`Lỗi khi thêm node: ${e.message || e}`);
          }
        }}
      />

      <DashboardToolbar
        stationName={stationName || 'StationOS'}
        showStationName={false}
        isEditMode={isEditMode}
        onToggleEditMode={() => setIsEditMode(!isEditMode)}
        showLabels={showLabels}
        onToggleLabels={() => setShowLabels(!showLabels)}
        onFit={handleFit}
        onRotate={handleRotate}
        onColorChange={handleColorChange}
        filters={filters}
        onFilterChange={setFilters}
        unpinnedCount={unpinnedCount}
      />


      {/* Panel chi tiết tủ điện — góc trên trái khi click node PLC */}
      {!isEditMode && selectedCabinet && (() => {
        const cabSensors = sensors.filter(s => s.deviceId.toLowerCase() === selectedCabinet.id.toLowerCase());
        const getSensor = (ids: string[]) => cabSensors.find(s => ids.includes(s.pointId));
        const t1Sensor = getSensor(['nhiet_do_pha_1', 'temp_1']);
        const t2Sensor = getSensor(['nhiet_do_pha_2', 'temp_2']);
        const t3Sensor = getSensor(['nhiet_do_pha_3', 'temp_3']);
        const pdSensor = getSensor(['phong_dien', 'pd']);
        // quality=0: thật | quality=1: simulation cũ (bỏ qua) | quality=2: offline
        const sensorVal = (s: typeof t1Sensor) =>
          (!s || s.quality !== 0 || s.value == null) ? undefined : (s.value as number);
        const t1 = sensorVal(t1Sensor);
        const t2 = sensorVal(t2Sensor);
        const t3 = sensorVal(t3Sensor);
        const pd = sensorVal(pdSensor);
        const isOffline = selectedCabinet.status === 'offline';
        const fmt = (v: number | undefined) => v !== undefined ? `${Math.round(v * 10) / 10}` : '---';
        const fmtPd = (v: number | undefined) => v === undefined ? '---' : `${Math.round(v)}`;
        const normalize = (id?: string) => (id || '').trim().toLowerCase();
        const evaluate = (v: number, op: string, t: number) => {
          if (op === '>') return v > t;
          if (op === '>=') return v >= t;
          if (op === '<') return v < t;
          if (op === '<=') return v <= t;
          if (op === '==') return Math.abs(v - t) < 0.001;
          return false;
        };
        const getCabinetThresholdLevel = (pointId?: string, value?: number): 'alarm' | 'warning' | undefined => {
          if (!pointId || value == null) return undefined;
          const deviceId = selectedCabinet.id.toLowerCase();
          const pid = normalize(pointId);
          const suffix = pid.includes('_') ? pid.split('_').pop() || pid : pid;
          let worst: 'alarm' | 'warning' | undefined;
          for (const rule of rules) {
            if (!rule.enabled || !rule.deviceId || rule.deviceId.toLowerCase() !== deviceId) continue;
            let cond: any;
            try { cond = JSON.parse(rule.condition); } catch { continue; }
            const rulePoint = normalize(cond.point);
            if (!rulePoint || (rulePoint !== pid && rulePoint !== suffix)) continue;

            // Format mới: alarm/pre_alarm trực tiếp
            let alarmVal: number | null = cond.alarm != null ? Number(cond.alarm) : null;
            let warnVal: number | null = cond.pre_alarm != null ? Number(cond.pre_alarm) : null;
            // Format cũ: value + actions.level
            if (alarmVal == null && warnVal == null && cond.value != null) {
              let acts: any[] = [];
              try { acts = JSON.parse(rule.actions || '[]'); } catch { /* */ }
              const alert = acts.find((a: any) => a.type === 'alert' && a.level);
              if (alert?.level === 'alarm') alarmVal = Number(cond.value);
              else if (alert?.level === 'warning') warnVal = Number(cond.value);
            }
            if (alarmVal == null && warnVal == null) continue;

            // Đánh giá từng rule độc lập (nhất quán với dotLevelByPoint trong SldCanvas)
            const op = cond.op ?? '>';
            const alarmHit = alarmVal != null && evaluate(value, op, alarmVal);
            const warnHit  = warnVal  != null && evaluate(value, op, warnVal);
            if (alarmHit) { worst = 'alarm'; break; }
            if (warnHit && worst !== 'alarm') worst = 'warning';
          }
          return worst;
        };
        const tempColor = (pointId: string, v: number | undefined) => {
          if (v === undefined) return 'var(--admin-text-muted)';
          const level = getCabinetThresholdLevel(pointId, v);
          if (level === 'alarm') return 'var(--admin-danger)';
          if (level === 'warning') return 'var(--admin-warning)';
          return 'var(--admin-success)';
        };
        const pdColor = (pointId: string, v: number | undefined) => {
          if (v === undefined) return 'var(--admin-text-muted)';
          const level = getCabinetThresholdLevel(pointId, v);
          if (level === 'alarm') return 'var(--admin-danger)';
          if (level === 'warning') return 'var(--admin-warning)';
          return 'var(--admin-success)';
        };
        const extraColor = (s: typeof cabSensors[0]) => {
          if (s.quality !== 0 || s.value == null) return 'var(--admin-text-muted)';
          if (s.pointId === 'pd_indi') return s.value === 0 ? 'var(--admin-success)' : s.value === 1 ? 'var(--admin-warning)' : 'var(--admin-danger)';
          const level = getCabinetThresholdLevel(s.pointId, s.value);
          if (level === 'alarm') return 'var(--admin-danger)';
          if (level === 'warning') return 'var(--admin-warning)';
          return 'var(--admin-success)';
        };
        const extraLabel = (s: typeof cabSensors[0]) => {
          if (s.quality !== 0 || s.value == null) return '---';
          if (s.pointId === 'pd_indi') return s.value === 0 ? 'Bình thường' : s.value === 1 ? 'Cảnh báo' : 'Báo động';
          return `${Math.round(s.value * 10) / 10}${s.unit || ''}`;
        };
        const extras = cabSensors.filter(s => !['nhiet_do_pha_1','nhiet_do_pha_2','nhiet_do_pha_3','temp_1','temp_2','temp_3','phong_dien','pd'].includes(s.pointId));
        return (
          <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 30, width: 230,
            background: 'var(--admin-overlay)', backdropFilter: 'blur(12px)',
            border: '1px solid var(--admin-border)', boxShadow: 'var(--admin-shadow)' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--admin-border-light)', background: 'var(--admin-hover)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 6, height: 6, borderRadius: 0, background: isOffline ? 'var(--admin-danger)' : 'var(--admin-success)', display: 'inline-block', flexShrink: 0 }} />
                <span style={{ fontSize: '0.68rem', fontWeight: 800, color: 'var(--admin-text)', letterSpacing: '.3px' }}>{selectedCabinet.name}</span>
              </div>
              <button onClick={() => { setSelectedCabinet(null); setSelectedNode(null); }}
                style={{ background: 'none', border: 'none', color: 'var(--admin-text-muted)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '0 2px' }}>✕</button>
            </div>
            {/* Pha A B C + PD */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 4, padding: '8px 10px', borderBottom: extras.length > 0 ? '1px solid var(--admin-border-light)' : 'none' }}>
              {[['PHA A', fmt(t1), '°C', tempColor('nhiet_do_pha_1', t1)], ['PHA B', fmt(t2), '°C', tempColor('nhiet_do_pha_2', t2)], ['PHA C', fmt(t3), '°C', tempColor('nhiet_do_pha_3', t3)], ['P.ĐIỆN', fmtPd(pd), pd !== undefined ? 'dB' : '', pdColor('phong_dien', pd)]].map(([label, val, unit, color]) => (
                <div key={label as string} style={{ background: 'rgba(255,255,255,0.04)', padding: '4px 3px', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.44rem', color: 'var(--admin-text-muted)', fontWeight: 700, marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: '0.65rem', fontWeight: 800, color: color as string, fontFamily: 'Consolas,monospace', lineHeight: 1 }}>
                    {isOffline ? '--' : val as string}<span style={{ fontSize: '0.48rem', opacity: 0.7 }}>{!isOffline && (val as string) !== '--' ? unit : ''}</span>
                  </div>
                </div>
              ))}
            </div>
            {/* Các sensor còn lại */}
            {extras.length > 0 && (
              <div style={{ padding: '4px 0', maxHeight: 160, overflowY: 'auto' }}>
                {extras.map((s, i) => (
                  <div key={s.pointId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 10px', borderBottom: i < extras.length - 1 ? '1px solid var(--admin-border-light)' : 'none' }}>
                    <span style={{ fontSize: '0.65rem', color: 'var(--admin-text-muted)' }}>
                      {{ pd_eppc: 'PD EPPC', pd_indi: 'PD Chỉ báo' }[s.pointId] ?? s.pointId.replace(/_/g, ' ')}
                    </span>
                    <span style={{ fontSize: '0.7rem', fontWeight: 700, color: extraColor(s), fontFamily: 'Consolas,monospace' }}>
                      {extraLabel(s)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {isEditMode ? (
        <SldEditPanel
          stationId={stationId}
          sldRef={sldRef}
          refreshTick={sldRefreshTick}
          selectedNode={selectedNode}
          onClearSelection={() => setSelectedNode(null)}
          onDone={() => setIsEditMode(false)}
        />
      ) : (
        <div
          id="floatRightCol"
          style={{
            position: 'absolute', top: 10, right: 10, bottom: 0, zIndex: 30,
            width: 'auto',
            display: 'flex', flexDirection: 'column', gap: 8, overflow: 'visible',
            alignItems: 'flex-end',
            justifyContent: 'flex-start'
          }}
        >
          <div style={{ width: 120, display: 'flex', flexDirection: 'column', minHeight: 0, flex: '0 1 auto' }}>
            <AlertPanel
              alerts={alerts}
              onAlertClick={(alert) => {
                const streamId = findCameraStreamForDevice(alert, devices);
                if (streamId) {
                  handleCamChange(streamId);
                }
              }}
            />
          </div>
          <div style={{ flex: '0 0 auto', width: 220 }}>
            <CameraLiveViewer
              cameraSrc={activeCameraSrc}
              hasAlert={activeCamHasAlert}
              headerAddon={
                <select
                  style={{ fontSize: '0.55rem', padding: '1px 4px', background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', borderRadius: 0, minWidth: 150, maxWidth: 220, cursor: 'pointer', outline: 'none' }}
                  value={activeCameraSrc}
                  onChange={e => handleCamChange(e.target.value)}
                >
                  {Object.entries(camOptionsGroups).map(([zone, opts]) => (
                    opts.length > 0 ? (
                      <optgroup key={zone} label={zone}>
                        {opts.map(opt => <option key={opt.id} value={opt.id} title={opt.title}>{opt.label}</option>)}
                      </optgroup>
                    ) : null
                  ))}
                </select>
              }
            />
          </div>
        </div>
      )}

    </div>
  );
}

/**
 * Tìm stream camera tương ứng với thiết bị hoặc tủ điện bị cảnh báo.
 */
function findCameraStreamForDevice(alert: AlertItem, devicesList: any[]) {
  const deviceId = alert.deviceId;
  if (!deviceId || !devicesList) return null;
  const devIdLower = deviceId.toLowerCase();

  // Helper chọn stream tối ưu dựa trên loại cảnh báo
  const selectStream = (cfg: any) => {
    const msgLower = (alert.message || '').toLowerCase();
    const isThermalAlert = msgLower.includes('nhiệt') || 
                           msgLower.includes('nhiet') || 
                           msgLower.includes('roi') ||
                           msgLower.includes('thermal') ||
                           msgLower.includes('quá nhiệt') ||
                           msgLower.includes('qua nhiet') ||
                           msgLower.includes('temp');
    if (isThermalAlert && cfg.go2rtc_thermal) {
      return cfg.go2rtc_thermal;
    }
    return cfg.go2rtc_optical || cfg.go2rtc_id || cfg.go2rtc_thermal || null;
  };

  // 1. Nếu thiết bị cảnh báo chính là một camera
  const camera = devicesList.find(d => d.id.toLowerCase() === devIdLower);
  if (camera) {
    return selectStream(camera.config || {});
  }

  // 2. Nếu thiết bị cảnh báo được liên kết cabinetId với một camera
  const linkedCamera = devicesList.find(d => {
    const cfg = d.config || {};
    return cfg.cabinetId && cfg.cabinetId.toLowerCase() === devIdLower;
  });
  if (linkedCamera) {
    return selectStream(linkedCamera.config || {});
  }

  // 3. Fallback: Nếu thiết bị cảnh báo chia sẻ chung vùng (zone) với một camera
  const alertingDevice = devicesList.find(d => d.id.toLowerCase() === devIdLower);
  if (alertingDevice) {
    const devZone = alertingDevice.config?.zone;
    if (devZone) {
      const devZoneLower = devZone.trim().toLowerCase();
      const zoneCamera = devicesList.find(d => {
        if (d.id.toLowerCase() === devIdLower) return false;
        const isCam = DEV_CAM_TYPES.some(t => d.type?.includes(t));
        if (!isCam) return false;
        const camZone = d.config?.zone;
        return camZone && camZone.trim().toLowerCase() === devZoneLower;
      });
      if (zoneCamera) {
        return selectStream(zoneCamera.config || {});
      }
    }
  }

  return null;
}
