// ============================================================
// DashboardPage.tsx — Trang tổng quan chính
// Hiển thị: Sơ đồ một sợi (SLD) + KPI + Camera + Cảnh báo
// Nhận cập nhật realtime qua SignalR (SensorUpdate, AlertNew, AlertUpdated)
// ============================================================

import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SensorPoint, stationApi } from '@/services/StationApiService';
import { useStationStore, useDeviceStore, useAlertStore, useSensorStore } from '@/store';
import { ALERT_STATUS, DEVICE_STATUS } from '@/types/enums';
import { useRealtime } from '@/hooks/useRealtime';
import { PT_PD } from '@/constants/points';
import { DEV_PLC_S7, DEV_CAM_TYPES } from '@/constants/devices';
import type { AlertItem } from '@/types/api.types';

import SldCanvas, { SldCanvasRef } from '@/components/dashboard/sld/SldCanvas';
import SldEditPanel from '@/components/dashboard/sld/SldEditPanel';
import KpiCards from '@/components/dashboard/kpi/KpiCards';
import CameraGrid, { CameraSensor } from '@/components/dashboard/camera/CameraGrid';
import DashboardToolbar from '@/components/dashboard/toolbar/DashboardToolbar';
import CameraLiveViewer from '@/components/dashboard/camera/CameraLiveViewer';
import AlertPanel from '@/components/dashboard/alerts/AlertPanel';

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
  const [sldColorMatrix, setSldColorMatrix] = useState<string | undefined>(undefined);
  const [sldRefreshTick, setSldRefreshTick] = useState(0);
  const [unpinnedCount, setUnpinnedCount] = useState(0);
  const [pointNamesMap, setPointNamesMap] = useState<Record<string, string>>({});

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

  const camAlertsCount = useMemo(() => {
    const camDeviceIds = new Set(devices
      .filter(d => DEV_CAM_TYPES.some(t => d.type?.includes(t)))
      .map(d => d.id.toLowerCase()));

    return alerts.filter(a => {
      if (a.status !== ALERT_STATUS.OPEN && a.status !== ALERT_STATUS.ACKED) return false;
      const did = (a.deviceId || '').toLowerCase();
      // Nếu alert thuộc về device là camera -> đếm vào camAlertsCount
      return camDeviceIds.has(did);
    }).length;
  }, [alerts, devices]);


  const liveCameraSrc = useMemo(() => {
    const cam = devices.find(d => DEV_CAM_TYPES.some(t => d.type?.includes(t)));
    if (!cam) return undefined;
    const cfg = (cam as any).config || {};
    return (cfg.go2rtc_optical || cfg.go2rtc_id || cfg.go2rtc_thermal) as string | undefined;
  }, [devices]);


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
    if (!stationId) return;
    fetchSensors(stationId);
    fetchDevices(stationId);
    fetchAlerts(ALERT_STATUS.OPEN);

    // Fetch SLD status to show unpinned badge
    stationApi.getSld(stationId).then(data => {
      setUnpinnedCount(data.unpinned?.length || 0);
    }).catch(() => {});
  }, [stationId, fetchSensors, fetchDevices, fetchAlerts, sldRefreshTick]);

  // Fetch friendly names for points (Thermal ROI & PD Regions)
  useEffect(() => {
    if (!stationId || devices.length === 0) return;
    const cams = devices.filter(d => DEV_CAM_TYPES.some(t => d.type?.includes(t)));
    if (cams.length === 0) return;

    const fetchAllNames = async () => {
      const newMap: Record<string, string> = {};
      await Promise.all(cams.map(async (cam) => {
        try {
          const [pts, rois] = await Promise.all([
            stationApi.getRoiPoints(cam.id).catch(() => []),
            stationApi.getBoundaries(cam.id).catch(() => [])
          ]);
          pts.forEach(p => {
            if (p.pointId) newMap[`${cam.id}_${p.pointId}`.toUpperCase()] = p.label || p.name || '';
          });
          rois.forEach(r => {
            let descriptiveName = r.name;
            try {
              const t = JSON.parse(r.thresholds || '{}');
              if (t.fullName) descriptiveName = t.fullName;
            } catch {}
            
            newMap[`${cam.id}_${r.id}`.toUpperCase()] = descriptiveName;
            newMap[`${cam.id}_${r.name}`.toUpperCase()] = descriptiveName;
          });
        } catch {}
      }));
      setPointNamesMap(newMap);
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
    const groups: Record<string, { id: string, label: string }[]> = { 'Khác': [] };
    devices.filter(d => DEV_CAM_TYPES.some(t => d.type?.includes(t))).forEach(cam => {
      // Bỏ qua hoàn toàn các camera chuyên đo phóng điện (PD)
      if (cam.type === 'camera_pd' || cam.name.toUpperCase().includes('PD') || cam.name.toUpperCase().includes('PHÓNG ĐIỆN')) return;

      const cfg = (cam as any).config || {};
      const zone = cfg.zone?.trim() || 'Khác';
      if (!groups[zone]) groups[zone] = [];

      if (cam.type === 'camera_dual') {
        if (cfg.go2rtc_optical) groups[zone].push({ id: cfg.go2rtc_optical, label: `${cam.name} (Quang)` });
        if (cfg.go2rtc_thermal) groups[zone].push({ id: cfg.go2rtc_thermal, label: `${cam.name} (Nhiệt)` });
      } else {
        const streamId = cfg.go2rtc_id || cfg.go2rtc_thermal || cfg.go2rtc_optical;
        if (streamId) groups[zone].push({ id: streamId, label: cam.name });
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

  const cameraSensors: CameraSensor[] = useMemo(() => {
    const activeCamDevice = devices.find(d => {
      const cfg = (d as any).config || {};
      return cfg.go2rtc_optical === activeCameraSrc || 
             cfg.go2rtc_thermal === activeCameraSrc || 
             cfg.go2rtc_id === activeCameraSrc;
    });

    const result: CameraSensor[] = [];

    // 1. Thêm các điểm đo của camera đang chọn
    if (activeCamDevice) {
      sensors
        .filter(s => s.deviceId.toLowerCase() === activeCamDevice.id.toLowerCase())
        .forEach(s => {
          const rawPid = s.pointId.toUpperCase();
          const uniqueKey = `${s.deviceId}_${rawPid}`.toUpperCase();
          result.push({
            pid: uniqueKey,
            value: s.value,
            unit: s.unit,
            deviceName: activeCamDevice.name || '',
            pointName: pointNamesMap[uniqueKey]
          });
        });
    }

    // 2. Thêm TẤT CẢ các điểm đo Phóng điện (PD) từ toàn bộ trạm (nếu chưa có)
    // Để mục ĐIỂM PHÓNG ĐIỆN luôn hiển thị cảnh báo dù đang xem camera nào
    sensors.forEach(s => {
      const rawPid = s.pointId.toUpperCase();
      const dev = devices.find(d => d.id.toLowerCase() === s.deviceId.toLowerCase());
      const devName = dev?.name || '';
      
      const isPd = rawPid === PT_PD.toUpperCase() || 
                   rawPid === 'PD' ||
                   rawPid.startsWith('PD_') || 
                   rawPid.includes('_PD') ||
                   rawPid.includes('PHONG_DIEN') ||
                   dev?.type === 'camera_pd' ||
                   devName.toUpperCase().includes('PD') ||
                   devName.toUpperCase().includes('PHÓNG ĐIỆN');

      if (isPd) {
        const uniquePid = `${s.deviceId}_${rawPid}`.toUpperCase();
        if (!result.some(r => r.pid === uniquePid)) {

          result.push({
            pid: uniquePid,
            value: s.value,
            unit: s.unit,
            deviceName: devName,
            pointName: pointNamesMap[uniquePid]
          });
        }
      }
    });

    return result;
  }, [sensors, devices, activeCameraSrc, pointNamesMap]);

  return (
    <div className="dashboard-page new-dash-theme" style={{ position: 'relative', overflow: 'hidden', height: '100%', background: 'var(--admin-bg)' }}>

      <SldCanvas
        ref={sldRef}
        stationId={stationId}
        editMode={isEditMode}
        showLabels={showLabels}
        colorMatrix={sldColorMatrix}
        sensors={sensors}
        selectedNodeId={selectedNode?.id}
        onNodeSelect={setSelectedNode}
        onNodeDropped={async (x, y, deviceId, _deviceName, pointId) => {
          try {
            const newNode = await stationApi.addSldPoint(stationId, {
              x, y, r: 8,
              label: '', // Để trống để user tự nhập tên theo ý muốn
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

      {/* Left column: KPI + camera grid — ẩn khi đang chỉnh sơ đồ */}
      {!isEditMode && (
        <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 30, width: '20%', minWidth: 220, maxWidth: 270, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 'calc(100% - 50px)', overflowY: 'auto' }}>
          <KpiCards plcOnline={plcOnline} devices={devices} sensors={sensors} />
          <CameraGrid
              sensors={cameraSensors}
              alertsCount={camAlertsCount}
              camOptionsGroups={camOptionsGroups}
              activeCameraSrc={activeCameraSrc}
              onCamChange={handleCamChange}
            />
        </div>
      )}

      {isEditMode ? (
        <SldEditPanel
          stationId={stationId}
          sldRef={sldRef}
          refreshTick={sldRefreshTick}
          selectedNode={selectedNode}
          onClearSelection={() => setSelectedNode(null)}
        />
      ) : (
        <div
          id="floatRightCol"
          style={{
            position: 'absolute', top: 10, right: 10, bottom: 40, zIndex: 30,
            width: 'auto',
            display: 'flex', flexDirection: 'column', gap: 8, overflow: 'visible',
            alignItems: 'flex-end',
            justifyContent: 'space-between'
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
                  style={{ fontSize: '0.55rem', padding: '1px 4px', background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', borderRadius: 0, maxWidth: 100, cursor: 'pointer', outline: 'none' }}
                  value={activeCameraSrc}
                  onChange={e => handleCamChange(e.target.value)}
                >
                  {Object.entries(camOptionsGroups).map(([zone, opts]) => (
                    opts.length > 0 ? (
                      <optgroup key={zone} label={zone}>
                        {opts.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
                      </optgroup>
                    ) : null
                  ))}
                </select>
              }
            />
          </div>
        </div>
      )}

      <div
        style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 30,
          display: 'flex', gap: 24, padding: '4px 10px', fontSize: 10, color: 'var(--admin-text-muted)',
          background: 'var(--admin-overlay)', borderTop: '1px solid var(--admin-border-light)',
          backdropFilter: 'blur(6px)'
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
          <span style={{ width: 6, height: 6, background: plcOnline ? 'var(--admin-success)' : 'var(--admin-danger)', borderRadius: 0, display: 'inline-block' }}></span>
          PLC: {plcOnline ? 'Trực tuyến' : 'Ngoại tuyến'}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
          <span style={{ width: 6, height: 6, background: 'var(--admin-success)', borderRadius: 0, display: 'inline-block' }}></span>
          SignalR: Đã kết nối
        </span>
      </div>
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
