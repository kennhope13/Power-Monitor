// ============================================================
// RealtimeMonitorPage.tsx — Giám sát camera trực tiếp
// Phát stream qua go2rtc (WebRTC) — layout 1/4/9 camera
// Hiển thị sự kiện phát hiện AI (nhiệt, khói, xâm nhập, phóng điện)
// Panel phải: danh sách sự kiện theo thời gian, lọc theo loại/ngày
// ============================================================

import { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { Map as MapIcon, AlertTriangle, Activity, Server, CheckCircle, Video, Radio, ShieldCheck, Clock, Search, LayoutGrid, ChevronDown, ChevronLeft, ExternalLink, Trash2 } from 'lucide-react';
import ToolbarSelect from '@/components/ui/ToolbarSelect';
import { stationApi, CameraDevice, RoiPoint, Boundary } from '@/services/StationApiService';
import { GO2RTC_URL, AI_ENGINE_URL, API_BASE_URL } from '@/utils/env';
import { authService } from '@/services/AuthService';
import { getRealtimeHub, startRealtimeHub } from '@/services/realtime.service';
import { useAlertStore } from '@/store/alertStore';
import { useDeviceStore } from '@/store/deviceStore';
import { useStationStore } from '@/store/stationStore';
import { ALERT_STATUS } from '@/types/enums';
import { Device } from '@/types/api.types';
import './RealtimeMonitorPage.css';

/**
 * Trang giám sát camera trực tiếp — hiển thị lưới stream WebRTC với overlay nhiệt/PD,
 * bảng sự kiện AI theo thời gian thực và đồng hồ trạng thái thiết bị.
 */
export default function RealtimeMonitorPage() {
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [gridCols, setGridCols] = useState<number>(() => {
    const saved = localStorage.getItem('rtm_grid_cols');
    return saved ? parseInt(saved, 10) : 2;
  });
  const [gridRows, setGridRows] = useState<number>(() => {
    const saved = localStorage.getItem('rtm_grid_rows');
    return saved ? parseInt(saved, 10) : 2;
  });
  const gridSize = Math.max(gridCols, gridRows);
  const [selectedCellIdx, setSelectedCellIdx] = useState<number | null>(0);
  const [gridAssignments, setGridAssignments] = useState<Record<number, string | null>>({});
  const [presets, setPresets] = useState<{
    id: string;
    name: string;
    gridSize?: number;
    gridCols?: number;
    gridRows?: number;
    assignments: Record<number, string | null>;
  }[]>([]);
  const [presetInput, setPresetInput] = useState('');
  const [expandedProvinces, setExpandedProvinces] = useState<Record<string, boolean>>({});
  const [expandedStations, setExpandedStations] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const location = useLocation();
  const isPopout = new URLSearchParams(location.search).get('popout') === 'true';
  const [sidebarOpen, setSidebarOpen] = useState(!isPopout);

  // States for grid layout dropdown selector
  const [showGridDropdown, setShowGridDropdown] = useState(false);
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const [customCols, setCustomCols] = useState<string>('2');
  const [customRows, setCustomRows] = useState<string>('2');
  const dropdownRef = useRef<HTMLDivElement>(null);
  
  const [expandedCamId, setExpandedCamId] = useState<string | null>(null);
  
  // Realtime
  const [deviceStatus, setDeviceStatus] = useState<Record<string, string>>({});
  const [aiStatsMap, setAiStatsMap] = useState<Record<string, any>>({});

  // Lightbox
  const [lightbox, setLightbox] = useState<{ url: string, isVideo: boolean } | null>(null);

  // ROI Configuration & Readings
  const [roiBoundaries, setRoiBoundaries] = useState<Record<string, Boundary[]>>({});
  const [roiPoints, setRoiPoints] = useState<Record<string, RoiPoint[]>>({});
  const [roiReadings, setRoiReadings] = useState<Record<string, Record<string, number>>>({});
  const [forecastReadings, setForecastReadings] = useState<Record<string, Record<string, number>>>({});
  const [pdBoundaries, setPdBoundaries] = useState<Record<string, Boundary[]>>({});
  // VVR mapping cache per device: deviceId → {x, y, width, height}
  const [vvrCache, setVvrCache] = useState<Record<string, {x:number;y:number;width:number;height:number}>>({});

  // AI Stream Toggle State (mặc định tắt, dùng WebRTC + SVG overlay)
  const [aiStreamCells, setAiStreamCells] = useState<Record<string, boolean>>({});
  const [stationMenuOpen, setStationMenuOpen] = useState(false);
  const [stationSearch, setStationSearch] = useState('');
  const [stationMenuPos, setStationMenuPos] = useState({ top: 0, left: 0, width: 260 });
  const stationBtnRef = useRef<HTMLButtonElement>(null);

  // Device, Alert and Station stores
  const fetchDevices = useDeviceStore(s => s.fetch);
  const devicesByStation = useDeviceStore(s => s.devicesByStation);
  const devices = useMemo(() => Object.values(devicesByStation).flat() as Device[], [devicesByStation]);
  const fetchAlerts = useAlertStore(s => s.fetch);
  const getFirstStationId = useStationStore(s => s.getFirstStationId);
  const stations = useStationStore(s => s.stations);
  const alertsByFilter = useAlertStore(s => s.alertsByFilter);
  const alerts = alertsByFilter[ALERT_STATUS.OPEN] ?? [];

  const expandCameraVariants = (cams: CameraDevice[], stationName?: string) => {
    const initialStatus: Record<string, string> = {};
    cams.forEach(c => initialStatus[c.id.toLowerCase()] = (c.status || 'unknown').toLowerCase());

    const expandedCams: CameraDevice[] = [];
    cams.forEach(c => {
      const cfg = (c as any).config || {};
      const withStationMeta = { ...(c as any), stationName };
      if (c.type === 'camera_dual') {
        expandedCams.push({
          ...withStationMeta,
          id: `${c.id}_optical`,
          name: `${c.name} (Quang học)`,
          config: { ...cfg, go2rtc_id: cfg.go2rtc_optical || cfg.go2rtc_id }
        } as any);
        expandedCams.push({
          ...withStationMeta,
          id: `${c.id}_thermal`,
          name: `${c.name} (Nhiệt)`,
          config: { ...cfg, go2rtc_id: cfg.go2rtc_thermal || cfg.go2rtc_id }
        } as any);
      } else if (c.type === 'camera_thermal') {
        expandedCams.push({
          ...withStationMeta,
          name: c.name.includes('nhiệt') || c.name.includes('Nhiệt') ? c.name : `${c.name} (Nhiệt)`,
          config: { ...cfg, go2rtc_id: cfg.go2rtc_thermal || cfg.go2rtc_id }
        } as any);
      } else {
        expandedCams.push({
          ...withStationMeta,
          config: cfg
        } as any);
      }
    });

    return { expandedCams, initialStatus };
  };

  // 1. Initial Load: Fetch cameras once on mount
  useEffect(() => {
    const loadAllStationsCams = async () => {
      try {
        console.log(`[RealtimeMonitor] Fetching cameras for ${stations.length} stations:`, stations.map(s => s.name));
        const cameraResults = await Promise.all(
          stations.map(async station => {
            const cams = await stationApi.getCameras(station.id).catch(() => [] as CameraDevice[]);
            console.log(`[RealtimeMonitor] Station: ${station.name} (id: ${station.id}) fetched ${cams.length} cameras`);
            return { station, cams };
          })
        );
        
        console.log(`[RealtimeMonitor] Total camera results count: ${cameraResults.length}`);

        const mergedStatus: Record<string, string> = {};
        const mergedCams: CameraDevice[] = [];
        const thermalIds: string[] = [];

        cameraResults.forEach(({ station, cams }) => {
          console.log(`[RealtimeMonitor] Processing station: ${station.name}, found ${cams.length} cameras`);
          const { expandedCams, initialStatus } = expandCameraVariants(cams, station.name);
          Object.assign(mergedStatus, initialStatus);
          mergedCams.push(...expandedCams);
          thermalIds.push(...cams.filter(c => c.type === 'camera_thermal' || c.type === 'camera_dual').map(c => c.id));
        });

        console.log(`[RealtimeMonitor] Final merged camera count: ${mergedCams.length}`);

        setDeviceStatus(mergedStatus);
        setCameras(mergedCams);

        thermalIds.forEach(cid => {
          stationApi.getThermalMapping(cid).then(m => {
            if (m) setVvrCache(prev => ({ ...prev, [cid.toLowerCase()]: m }));
          }).catch(() => {});
        });
      } catch (err) {
        console.error(err);
      }
    };

    const loadCams = async (stationId: string) => {
      try {
        const cams = await stationApi.getCameras(stationId);
        const stationName = stations.find(s => s.id === stationId)?.name;
        const { expandedCams, initialStatus } = expandCameraVariants(cams, stationName);
        setDeviceStatus(initialStatus);
        setCameras(expandedCams);

        const thermalIds = cams.filter(c => c.type === 'camera_thermal' || c.type === 'camera_dual').map(c => c.id);
        thermalIds.forEach(cid => {
          stationApi.getThermalMapping(cid).then(m => {
            if (m) setVvrCache(prev => ({ ...prev, [cid.toLowerCase()]: m }));
          }).catch(() => {});
        });
      } catch (err) {
        console.error(err);
      }
    };

    const savedStationId = localStorage.getItem('selected_station_id');
    if (savedStationId) {
      fetchDevices(savedStationId);
      fetchAlerts(ALERT_STATUS.OPEN);
      loadCams(savedStationId);
    } else {
      getFirstStationId().then((id: string | null) => {
        if (id) {
          localStorage.setItem('selected_station_id', id);
          fetchDevices(id);
          fetchAlerts(ALERT_STATUS.OPEN);
          loadCams(id);
        }
      }).catch(() => {});
    }
    // Initial latest points
    stationApi.getLatestPoints().then(readings => {
      setRoiReadings(prev => {
        const next = { ...prev };
        readings.forEach(r => {
          const devId = r.deviceId?.toLowerCase();
          const ptId = r.pointId?.toLowerCase();
          if (!devId || !ptId) return;
          next[devId] = { ...(next[devId] || {}), [ptId]: r.value };
        });
        return next;
      });
    }).catch(console.error);
  }, [stations, fetchDevices, fetchAlerts, getFirstStationId]);

  // Load presets on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem('rtm_presets');
      if (stored) {
        setPresets(JSON.parse(stored));
      }
    } catch (e) {
      console.error('Failed to load presets', e);
    }
  }, []);

  // Check for preset query parameter to auto-load preset
  useEffect(() => {
    if (presets.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const presetId = params.get('preset');
    if (presetId) {
      const found = presets.find(p => p.id === presetId);
      if (found) {
        const cols = found.gridCols || found.gridSize || 2;
        const rows = found.gridRows || found.gridSize || 2;
        setGridCols(cols);
        setGridRows(rows);
        setGridAssignments(found.assignments);
        setSelectedCellIdx(0);
      }
    }
  }, [presets]);

  // Click outside to close dropdown hook
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowGridDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  // Auto assign cameras to grid cells on initial load
  useEffect(() => {
    if (cameras.length > 0 && Object.keys(gridAssignments).length === 0) {
      const initial: Record<number, string | null> = {};
      const count = gridCols * gridRows;
      for (let i = 0; i < count; i++) {
        const cam = cameras[i];
        if (cam) {
          initial[i] = cam.id;
        } else {
          initial[i] = null;
        }
      }
      setGridAssignments(initial);
    }
  }, [cameras, gridCols, gridRows]);

  // 2. Periodic ROI/PD Boundary Refresh
  useEffect(() => {
    if (cameras.length === 0) return;
    
    const fetchRoiConfig = () => {
      const baseCamIds = Array.from(new Set(cameras.map(c => c.id.replace(/_(optical|thermal)$/, ''))));
      Promise.all(
        baseCamIds.map(id =>
          Promise.all([
            stationApi.getBoundaries(id, 'roi').catch(() => []),
            stationApi.getRoiPoints(id).catch(() => []),
            stationApi.getBoundaries(id, 'pd').catch(() => []),
          ]).then(([boundaries, points, pdBounds]) => ({ id, boundaries, points, pdBounds }))
        )
      ).then(results => {
        const boundMap: Record<string, Boundary[]> = {};
        const pointMap: Record<string, RoiPoint[]> = {};
        const pdMap: Record<string, Boundary[]> = {};
        results.forEach(res => {
          const lowId = res.id.toLowerCase();
          boundMap[lowId] = res.boundaries;
          pointMap[lowId] = res.points;
          pdMap[lowId] = res.pdBounds;
        });
        setRoiBoundaries(boundMap);
        setRoiPoints(pointMap);
        setPdBoundaries(pdMap);
      }).catch(console.error);
    };

    fetchRoiConfig();
    const timer = setInterval(fetchRoiConfig, 5000);
    return () => clearInterval(timer);
  }, [cameras.length]); // Re-run if camera count changes

  // Dữ liệu nhiệt của AI Engine là nguồn đang dùng tại tab Phân tích. Đồng bộ nguồn này
  // sang Trực tiếp để camera vẫn có nhiệt độ/dự báo khi backend /points hoặc SignalR
  // chưa nhận được mẫu radiometric.
  useEffect(() => {
    const thermalIds = Array.from(new Set(
      cameras
        .filter(c => c.type === 'camera_thermal' || c.type === 'camera_dual' || c.id.endsWith('_thermal'))
        .map(c => c.id.replace(/_(optical|thermal)$/, '').toLowerCase())
    ));
    if (thermalIds.length === 0) return;

    const normalizeKey = (value: string) => (value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[\s_-]/g, '');
    const canonicalKey = (value: string) => normalizeKey(value)
      .replace(/^(diem|point|vung|zone)/, '')
      .replace(/^([dpv])(?=\d)/, '');

    let cancelled = false;
    const pollAiTemperatures = async () => {
      const results = await Promise.all(thermalIds.map(async deviceId => {
        try {
          const response = await fetch(`${AI_ENGINE_URL}/api/prediction/history?points=60&device_id=${encodeURIComponent(deviceId)}`);
          if (!response.ok) return null;
          const payload = await response.json();
          const history: any[] = Array.isArray(payload?.history) ? payload.history : [];
          const targets = new Set<string>();
          history.forEach(row => Object.keys(row || {}).forEach(key => {
            if (key.endsWith('_actual')) targets.add(key.slice(0, -7));
            if (key.endsWith('_pred')) targets.add(key.slice(0, -5));
          }));

          const actual: Record<string, number> = {};
          const forecast: Record<string, number> = {};
          targets.forEach(target => {
            const aliases = [target.toLowerCase(), normalizeKey(target), canonicalKey(target)];
            for (let i = history.length - 1; i >= 0; i--) {
              const rawValue = history[i]?.[`${target}_actual`];
              if (rawValue == null || rawValue === '') continue;
              const value = Number(rawValue);
              if (Number.isFinite(value)) { aliases.forEach(k => { if (k) actual[k] = value; }); break; }
            }
            for (let i = history.length - 1; i >= 0; i--) {
              const rawValue = history[i]?.[`${target}_pred`];
              if (rawValue == null || rawValue === '') continue;
              const value = Number(rawValue);
              if (Number.isFinite(value)) { aliases.forEach(k => { if (k) forecast[k] = value; }); break; }
            }
          });
          return { deviceId, actual, forecast };
        } catch {
          return null;
        }
      }));

      if (cancelled) return;
      setRoiReadings(prev => {
        const next = { ...prev };
        results.forEach(result => {
          if (!result) return;
          // SignalR giữ quyền ưu tiên; AI chỉ bổ sung các khóa còn thiếu.
          next[result.deviceId] = { ...result.actual, ...(next[result.deviceId] || {}) };
        });
        return next;
      });
      setForecastReadings(prev => {
        const next = { ...prev };
        results.forEach(result => { if (result) next[result.deviceId] = result.forecast; });
        return next;
      });
    };

    pollAiTemperatures();
    const timer = setInterval(pollAiTemperatures, 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [cameras]);

  // Đo trực tiếp từ camera radiometric, cùng endpoint với ThermalConfigTab.
  // Đây là nguồn nhiệt độ chính cho overlay; không phụ thuộc việc SignalR có phát mẫu hay không.
  useEffect(() => {
    const deviceIds = Array.from(new Set(cameras
      .filter(c => c.type === 'camera_thermal' || c.type === 'camera_dual' || c.id.endsWith('_thermal'))
      .map(c => c.id.replace(/_(optical|thermal)$/, '').toLowerCase())));
    if (deviceIds.length === 0) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const pollLiveTemps = async () => {
      await Promise.all(deviceIds.map(async deviceId => {
        const points = roiPoints[deviceId] || [];
        const boundaries = roiBoundaries[deviceId] || [];
        if (points.length === 0 && boundaries.length === 0) return;

        const rois = boundaries.flatMap(boundary => {
          try {
            const polygon: [number, number][] = JSON.parse(boundary.polygon);
            if (polygon.length === 0) return [];
            return [{
              id: boundary.id,
              x1: Math.min(...polygon.map(p => p[0])),
              y1: Math.min(...polygon.map(p => p[1])),
              x2: Math.max(...polygon.map(p => p[0])),
              y2: Math.max(...polygon.map(p => p[1])),
            }];
          } catch { return []; }
        });

        try {
          const response = await fetch(`/api/v1/devices/${deviceId}/thermal/live-temps`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(authService.getToken() ? { Authorization: `Bearer ${authService.getToken()}` } : {}),
            },
            body: JSON.stringify({
              points: points.map(point => ({
                id: point.id,
                x: point.tx ?? ((point.x ?? 50) / 100),
                y: point.ty ?? ((point.y ?? 50) / 100),
              })),
              rois,
            }),
          });
          if (!response.ok) return;
          const payload = await response.json();
          if (cancelled) return;

          setRoiReadings(prev => {
            const values = { ...(prev[deviceId] || {}) };
            (payload.temps || []).forEach((reading: any) => {
              if (reading.temp == null || reading.temp === '') return;
              const value = Number(reading.temp);
              if (!Number.isFinite(value)) return;
              const point = points.find(p => p.id === reading.id);
              [reading.id, point?.id, point?.pointId, point?.name, point?.label]
                .filter(Boolean)
                .forEach(key => { values[String(key).toLowerCase()] = value; });
            });
            (payload.rois || []).forEach((reading: any) => {
              if (reading.max == null || reading.max === '') return;
              const value = Number(reading.max);
              if (!Number.isFinite(value)) return;
              const boundary = boundaries.find(b => b.id === reading.id);
              [reading.id, boundary?.id, boundary?.name]
                .filter(Boolean)
                .forEach(key => { values[String(key).toLowerCase()] = value; });
            });
            return { ...prev, [deviceId]: values };
          });
        } catch { /* camera/AI tạm mất kết nối: giữ mẫu gần nhất */ }
      }));
      if (!cancelled) timer = setTimeout(pollLiveTemps, 1000);
    };

    pollLiveTemps();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [cameras, roiPoints, roiBoundaries]);

  // 3. AI State Polling (Fast sync for visual feedback)
  useEffect(() => {
    const pdCams = cameras.filter(c => c.type === 'camera_pd');
    if (pdCams.length === 0) return;

    const aiPollInterval = setInterval(async () => {
      const token = authService.getToken() || '';
      const backend = API_BASE_URL.replace('/api/v1', '');

      pdCams.forEach(async (cam) => {
        const baseId = cam.id.replace(/_(optical|thermal)$/, '').toLowerCase();
        try {
          const res = await fetch(`${AI_ENGINE_URL}/pd-monitor/${baseId}/state?token=${token}&backend=${backend}`);
          if (res.ok) {
            const data = await res.json();
            setAiStatsMap(prev => ({ ...prev, [baseId]: data }));
          }
        } catch {}
      });
    }, 800);

    return () => clearInterval(aiPollInterval);
  }, [cameras.length]); // Independent of ROI config sync

  // SignalR (Simplified: only local UI state, global alerts handled in AppShell)
  useEffect(() => {
    const hubConnection = getRealtimeHub();
    hubConnection.on('DeviceStatus', (data: { deviceId: string; status: string }) => {
      setDeviceStatus(prev => ({ ...prev, [data.deviceId.toLowerCase()]: data.status.toLowerCase() }));
    });
    
    hubConnection.on('SensorUpdate', (data: any[]) => {
      if (!Array.isArray(data)) return;
      setRoiReadings(prev => {
        const next = { ...prev };
        data.forEach(item => {
          const devId = item.deviceId?.toLowerCase();
          const ptId = item.pointId?.toLowerCase();
          if (!devId || !ptId) return;
          next[devId] = {
            ...(next[devId] || {}),
            [ptId]: item.value
          };
        });
        return next;
      });
    });

    startRealtimeHub().catch(() => {});
    return () => { 
      hubConnection.off('DeviceStatus');
      hubConnection.off('SensorUpdate');
    };
  }, []);

  // Helpers
  const isCentralFleetView = false;
  const stationCameraStats = useMemo(() => {
    const grouped = new Map<string, {
      stationId: string;
      stationName: string;
      total: number; online: number; offline: number;
      thermal: number; optical: number; pd: number; cctv: number;
      cameraNames: string[];
      alertCount: number;
      firstCam?: CameraDevice;
    }>();
    const seenBaseIds = new Set<string>();

    cameras.forEach(cam => {
      const baseId = cam.id.replace(/_(optical|thermal)$/, '').toLowerCase();
      if (seenBaseIds.has(baseId)) return;
      seenBaseIds.add(baseId);

      const stationName = ((cam as any).stationName as string | undefined) || 'Không rõ trạm';
      const stationId = stations.find(s => s.name === stationName)?.id || '';
      const key = stationName.toLowerCase();
      const status = deviceStatus[baseId] || 'unknown';
      const entry = grouped.get(key) || { stationId, stationName, total: 0, online: 0, offline: 0, thermal: 0, optical: 0, pd: 0, cctv: 0, cameraNames: [], alertCount: 0 };

      entry.total += 1;
      if (status === 'online') entry.online += 1;
      else entry.offline += 1;

      const t = cam.type || '';
      if (t === 'camera_thermal') entry.thermal += 1;
      else if (t === 'camera_pd') entry.pd += 1;
      else if (t === 'camera_dual') { entry.thermal += 1; entry.optical += 1; }
      else entry.cctv += 1;

      if (!entry.firstCam) entry.firstCam = cam;

      entry.cameraNames.push(cam.name.replace(/\s+\((Quang học|Nhiệt)\)$/i, ''));
      grouped.set(key, entry);
    });

    const result = [...grouped.values()];
    
    // Add missing stations
    stations.forEach(s => {
        if (!grouped.has(s.name.toLowerCase())) {
            result.push({
                stationId: s.id, stationName: s.name,
                total: 0, online: 0, offline: 0,
                thermal: 0, optical: 0, pd: 0, cctv: 0,
                cameraNames: [], alertCount: 0
            });
        }
    });

    result.sort((a, b) => a.stationName.localeCompare(b.stationName, 'vi'));
    result.forEach(entry => {
      entry.alertCount = alerts.filter(a => {
        const dev = devices.find(d => d.id.toLowerCase() === (typeof a.deviceId === 'string' ? a.deviceId.toLowerCase() : ''));
        if (!dev) return false;
        const st = stations.find(s => s.id === entry.stationId);
        return st && (dev as any).stationId === st.id;
      }).length;
    });
    return result;
  }, [cameras, deviceStatus, stations, alerts, devices]);

  const fleetSummary = useMemo(() => {
    const totalStations = stations.length;
    const totalCams = stationCameraStats.reduce((acc, s) => acc + s.total, 0);
    const onlineCams = stationCameraStats.reduce((acc, s) => acc + s.online, 0);
    const totalAlerts = alerts.length;
    const avgHealth = totalCams > 0 ? Math.round((onlineCams / totalCams) * 100) : 0;
    
    return { totalStations, totalCams, onlineCams, totalAlerts, avgHealth };
  }, [stationCameraStats, alerts, stations]);

  const filteredStationStats = useMemo(() => {
    if (!stationSearch) return stationCameraStats;
    const q = stationSearch.toLowerCase();
    return stationCameraStats.filter(s => s.stationName.toLowerCase().includes(q));
  }, [stationCameraStats, stationSearch]);

  /** Render các polygon SVG vùng ROI nhiệt lên overlay của ô camera. */
  const renderOverlayBoundaries = (cam: CameraDevice) => {
    let baseDeviceId = cam.id.replace(/_(optical|thermal)$/, '').toLowerCase();
    const isThermal = cam.id.endsWith('_thermal') || cam.type === 'camera_thermal';

    let targetCam = cam;
    if (!isThermal && cam.type !== 'camera_dual' && !cam.id.includes('_optical')) {
      const cfg = cam.config || {};
      if (cfg.ip) {
        const linkedThermal = devices.find(d => 
          (d.type === 'camera_thermal' || d.type === 'camera_dual') && 
          (d.config as any)?.ip === cfg.ip
        );
        if (linkedThermal) {
          baseDeviceId = linkedThermal.id.toLowerCase();
          targetCam = linkedThermal as any;
        }
      }
    }

    const boundaries = roiBoundaries[baseDeviceId] || [];
    const readings = roiReadings[baseDeviceId] || {};

    const cfg = targetCam.config || {};
    const focalOpt = cfg.focal_length_optical;
    const focalTh = cfg.focal_length_thermal;
    const isFocalEqual = focalOpt != null && focalTh != null && Number(focalOpt) === Number(focalTh);
    const vvrRaw = (cfg as any).visible_valid_rect;
    const vvr = isFocalEqual ? { x: 0, y: 0, width: 1, height: 1 } : (vvrCache[baseDeviceId]
      ?? (vvrRaw && typeof vvrRaw.x === 'number' ? vvrRaw : { x: 0.20, y: 0.084, width: 0.63, height: 0.841 }));

    return boundaries.map((b, index) => {
      let poly: [number, number][] = [];
      try { poly = JSON.parse(b.polygon); } catch { return null; }
      if (poly.length < 3) return null;

      const mappedPoly = poly.map(([txVal, tyVal]) => {
        let rx = txVal;
        let ry = tyVal;
        if (!isThermal) {
          rx = txVal * vvr.width + vvr.x;
          ry = tyVal * vvr.height + vvr.y;
        }
        return [rx, ry] as [number, number];
      });

      const pointsStr = mappedPoly.map(p => `${p[0] * 100},${p[1] * 100}`).join(' ');

      const lookupId = b.id.toLowerCase();
      const normalizedName = (b.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\s_-]/g, '');
      const canonicalName = normalizedName.replace(/^(diem|point|vung|zone)/, '').replace(/^([dpv])(?=\d)/, '');
      const temp = readings[lookupId] ?? 
                   (b.name ? readings[b.name.toLowerCase()] : undefined) ?? 
                   readings[`r${index + 1}`] ?? readings[normalizedName] ?? readings[canonicalName];

      let color = '#3b82f6';
      let warningTemp = 50, alarmTemp = 70, borderWidth = 0.5;
      if (b.thresholds) {
        try {
          const t = JSON.parse(b.thresholds);
          warningTemp = t.warning || 50;
          alarmTemp = t.alarm || 70;
          if (t.borderWidth) borderWidth = parseFloat(t.borderWidth) || 0.5;
        } catch {}
      }

      if (temp !== undefined) {
        if (temp >= alarmTemp) color = '#ef4444';
        else if (temp >= warningTemp) color = '#fbbf24';
      }

      return (
        <polygon
          key={b.id}
          points={pointsStr}
          fill={color + '12'}
          stroke={color}
          strokeWidth={borderWidth}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          opacity={0.9}
        />
      );
    });
  };

  /** Render nhãn tên vùng và nhiệt độ lên overlay dạng HTML div (hỗ trợ blur backdrop). */
  const renderOverlayLabels = (cam: CameraDevice) => {
    let baseDeviceId = cam.id.replace(/_(optical|thermal)$/, '').toLowerCase();
    const isThermal = cam.id.endsWith('_thermal') || cam.type === 'camera_thermal';

    let targetCam = cam;
    if (!isThermal && cam.type !== 'camera_dual' && !cam.id.includes('_optical')) {
      const cfg = cam.config || {};
      if (cfg.ip) {
        const linkedThermal = devices.find(d => 
          (d.type === 'camera_thermal' || d.type === 'camera_dual') && 
          (d.config as any)?.ip === cfg.ip
        );
        if (linkedThermal) {
          baseDeviceId = linkedThermal.id.toLowerCase();
          targetCam = linkedThermal as any;
        }
      }
    }

    const points = roiPoints[baseDeviceId] || [];
    const boundaries = roiBoundaries[baseDeviceId] || [];
    const readings = roiReadings[baseDeviceId] || {};
    const forecasts = forecastReadings[baseDeviceId] || {};
    const aiState = aiStatsMap[baseDeviceId] || {};

    const cfg = targetCam.config || {};
    const isOutdoorThermal = (targetCam.type === 'camera_thermal' || targetCam.type === 'camera_dual')
      && String((cfg as any).mountType || '').toLowerCase() === 'outdoor';
    const showPredValue = !isOutdoorThermal;
    const focalOpt = cfg.focal_length_optical;
    const focalTh = cfg.focal_length_thermal;
    const isFocalEqual = focalOpt != null && focalTh != null && Number(focalOpt) === Number(focalTh);
    const vvrRaw = (cfg as any).visible_valid_rect;
    const vvr = isFocalEqual ? { x: 0, y: 0, width: 1, height: 1 } : (vvrCache[baseDeviceId]
      ?? (vvrRaw && typeof vvrRaw.x === 'number' ? vvrRaw : { x: 0.20, y: 0.084, width: 0.63, height: 0.841 }));

    const labels: React.ReactNode[] = [];

    // 1. Boundary Labels
    boundaries.forEach((b, index) => {
      let poly: [number, number][] = [];
      try { poly = JSON.parse(b.polygon); } catch { return; }
      if (poly.length < 1) return;

      const firstPt = poly[0];
      if (!firstPt) return;
      let rx = firstPt[0];
      let ry = firstPt[1];
      if (!isThermal) {
        rx = rx * vvr.width + vvr.x;
        ry = ry * vvr.height + vvr.y;
      }

      const lookupId = b.id.toLowerCase();
      const normalizedName = (b.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\s_-]/g, '');
      const canonicalName = normalizedName.replace(/^(diem|point|vung|zone)/, '').replace(/^([dpv])(?=\d)/, '');
      const temp = readings[lookupId] ?? 
                   (b.name ? readings[b.name.toLowerCase()] : undefined) ?? 
                   readings[`r${index + 1}`] ?? readings[normalizedName] ?? readings[canonicalName];
      const predictedTemp = forecasts[normalizedName] ?? forecasts[canonicalName];
      
      let color = '#3b82f6';
      let warningTemp = 50, alarmTemp = 70;
      let fontSize = 14;
      let labelPos = 'top';
      if (b.thresholds) {
        try {
          const t = JSON.parse(b.thresholds);
          warningTemp = t.warning || 50; alarmTemp = t.alarm || 70;
          if (t.fontSize) fontSize = parseInt(t.fontSize) || 14;
          if (t.namePosition || t.labelPos) labelPos = t.namePosition || t.labelPos || 'top';
        } catch {}
      }
      if (temp !== undefined) {
        if (temp >= alarmTemp) color = '#ef4444';
        else if (temp >= warningTemp) color = '#fbbf24';
      }

      const labelTransform =
        labelPos === 'bottom' ? 'translate(-50%, 0)'    :
        labelPos === 'left'   ? 'translate(-100%, -50%)':
        labelPos === 'right'  ? 'translate(0, -50%)'    :
        /* top */               'translate(-50%, -100%)';
      labels.push(
        <div
          key={`label-b-${b.id}`}
          style={{
            position: 'absolute',
            left: `${rx * 100}%`,
            top: `${ry * 100}%`,
            transform: labelTransform,
            pointerEvents: 'none',
            zIndex: 10,
          }}
        >
          <div
            style={{
              background: 'rgba(13, 17, 23, 0.95)',
              backdropFilter: 'blur(4px)',
              border: `1px solid ${color}`,
              borderRadius: 3,
              padding: '1px 5px',
              fontSize: `${fontSize - 4}px`,
              color: '#fff',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              boxShadow: `0 2px 6px rgba(0,0,0,0.5), 0 0 6px ${color}33`,
              fontFamily: 'var(--font-mono)',
              animation: temp !== undefined ? 'pulse-subtle 2s infinite' : 'none'
            }}
          >
            <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{b.name.replace(/Vùng\s*/g, 'V')}</span>
            <span style={{ fontWeight: 800, color: color, fontSize: '9px', borderLeft: '1px solid rgba(255,255,255,0.15)', paddingLeft: 4 }}>
              {temp !== undefined ? `${temp.toFixed(1)}°C` : '--°C'}
            </span>
            {showPredValue && predictedTemp != null && (
              <span title="Nhiệt độ dự báo" style={{ fontWeight: 700, color: '#93c5fd', fontSize: '9px', borderLeft: '1px solid rgba(255,255,255,0.15)', paddingLeft: 4 }}>
                → {predictedTemp.toFixed(1)}°C
              </span>
            )}
          </div>
        </div>
      );
    });

    // 2. Điểm đo nhiệt — CSS crosshair y hệt ThermalConfigTab
    points.forEach((pt, index) => {
      // Chọn tọa độ theo loại camera: thermal dùng tx/ty, optical dùng ox/oy
      const txv = pt.tx ?? (pt.x !== undefined ? pt.x / 100 : 0);
      const tyv = pt.ty ?? (pt.y !== undefined ? pt.y / 100 : 0);
      let rx = txv, ry = tyv;
      if (!isThermal) {
        rx = txv * vvr.width + vvr.x;
        ry = tyv * vvr.height + vvr.y;
      }
      if (rx === 0 && ry === 0) return;

      // Tra nhiệt độ từ SignalR readings
      const pid = pt.pointId || '';
      const nm  = pt.name || pt.label || '';
      const fallbackP1 = `p${pt.sortOrder || (index + 1)}`;
      const normalizedAliases = [pid, nm, fallbackP1].filter(Boolean).map(value => value
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\s_-]/g, ''));
      const canonicalAliases = normalizedAliases.map(value => value
        .replace(/^(diem|point|vung|zone)/, '').replace(/^([dpv])(?=\d)/, ''));
      const temp =
        (pid ? readings[pid] ?? readings[pid.toLowerCase()] : undefined) ??
        (nm  ? readings[nm]  ?? readings[nm.toLowerCase()]  : undefined) ??
        readings[pt.id] ?? readings[pt.id.toLowerCase()] ??
        readings[fallbackP1] ??
        [...normalizedAliases, ...canonicalAliases].map(key => readings[key]).find(value => value != null);
      const predictedTemp = [...normalizedAliases, ...canonicalAliases]
        .map(key => forecasts[key]).find(value => value != null);

      const preAlarm = pt.preAlarmThreshold ?? 50;
      const alarmTh  = pt.alarmThreshold   ?? 70;
      const color = temp != null
        ? (temp >= alarmTh ? '#ef4444' : temp >= preAlarm ? '#f59e0b' : '#10b981')
        : '#10b981';

      const sz  = pt.sortOrder || 28;
      const lp  = (pt as any).description || 'top';
      const labelStyle: React.CSSProperties =
        lp === 'bottom' ? { top: '100%',  left: '50%', transform: 'translateX(-50%)', marginTop: 4 } :
        lp === 'left'   ? { right: '100%', top: '50%',  transform: 'translateY(-50%)', marginRight: 6 } :
        lp === 'right'  ? { left: '100%',  top: '50%',  transform: 'translateY(-50%)', marginLeft: 6  } :
        /* top */         { bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 4 };

      labels.push(
        <div key={`pt-${pt.id}`} style={{
          position: 'absolute',
          left: `${rx * 100}%`,
          top:  `${ry * 100}%`,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          zIndex: 11,
        }}>
          {/* CSS crosshair — y hệt ThermalConfigTab */}
          <div style={{ position: 'relative', width: sz, height: sz }}>
            <div style={{ position: 'absolute', top: '50%', left: 0, width: '100%', height: 1.5, background: color, transform: 'translateY(-50%)', boxShadow: '0 0 3px rgba(0,0,0,.9)' }} />
            <div style={{ position: 'absolute', left: '50%', top: 0, width: 1.5, height: '100%', background: color, transform: 'translateX(-50%)', boxShadow: '0 0 3px rgba(0,0,0,.9)' }} />
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 4, height: 4, borderRadius: '50%', background: '#fff', boxShadow: `0 0 4px ${color}` }} />
          </div>
          {/* Label badge — y hệt ThermalConfigTab */}
          <div style={{ position: 'absolute', ...labelStyle, background: 'rgba(8,8,8,.88)', border: `1px solid ${color}55`, borderRadius: 3, padding: '1px 6px', fontSize: 9, fontFamily: 'monospace', whiteSpace: 'nowrap', color: '#fff' }}>
             <span style={{ color: '#ccc' }}>{(pid || nm).replace(/^(Điểm|Point|P|D)\s*/gi, '').replace(/\s+/g, '')}</span>
            {temp != null && <span style={{ fontWeight: 800, color, marginLeft: 4 }}>{temp.toFixed(1)}°C</span>}
            {showPredValue && predictedTemp != null && (
              <span title="Nhiệt độ dự báo" style={{ fontWeight: 700, color: '#93c5fd', marginLeft: 4 }}>→ {predictedTemp.toFixed(1)}°C</span>
            )}
          </div>
        </div>
      );
    });

    // 3. PD Boundary Labels (Được hiển thị trực quan kèm chỉ số phóng điện dB)
    const pdList = pdBoundaries[baseDeviceId] || [];
    pdList.forEach(b => {
      let poly: [number, number][] = [];
      try { poly = JSON.parse(b.polygon); } catch { return; }
      if (poly.length < 1) return;

      const minX = Math.min(...poly.map(p => p[0]));
      const maxX = Math.max(...poly.map(p => p[0]));
      const minY = Math.min(...poly.map(p => p[1]));
      const maxY = Math.max(...poly.map(p => p[1]));
      const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
      const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;

      let rx = cx, ry = cy;
      let labelPos = 'bottom';
      let fontSize = 12;
      try {
        if (b.thresholds) {
          const t = JSON.parse(b.thresholds);
          if (t.labelPos) labelPos = t.labelPos;
          if (t.fontSize) fontSize = parseInt(t.fontSize) || 12;
        }
      } catch {}

      if (labelPos === 'top')         { ry = minY; }
      else if (labelPos === 'bottom') { ry = maxY; }
      else if (labelPos === 'left')   { rx = minX; }
      else if (labelPos === 'right')  { rx = maxX; }

      const lookupId = b.id.toLowerCase();
      
      const regionValue = readings[lookupId] ?? 
                          (b.name ? readings[b.name.toLowerCase()] : undefined) ??
                          readings[b.name];

      // Không mượn giá trị PD từ thiết bị khác nếu vùng này không có dữ liệu.
      const pdValue = regionValue !== undefined && regionValue !== 0 ? regionValue : undefined;
      const hasDischarge = pdValue !== undefined;

      // Xác định các ngưỡng cảnh báo/báo động động cho vùng này
      let warningDb = 20, alarmDb = 45;
      try {
        if (b.thresholds) {
          const t = JSON.parse(b.thresholds);
          warningDb = t.warn || t.warning || 20;
          alarmDb = t.alarm || 45;
        }
      } catch {}

      const isAlarm = hasDischarge && pdValue !== undefined && pdValue >= alarmDb;
      const isWarning = hasDischarge && pdValue !== undefined && pdValue >= warningDb;
      const isActive = aiState.active_boundary === b.name;
      const color = isAlarm ? '#ef4444' : (isActive || isWarning ? '#fbbf24' : '#10b981');

      const labelTransform =
        labelPos === 'bottom' ? 'translate(-50%, 0)'    :
        labelPos === 'left'   ? 'translate(-100%, -50%)':
        labelPos === 'right'  ? 'translate(0, -50%)'    :
        /* top */               'translate(-50%, -100%)';

      const liveDb = aiState.db;
      const liveHz = aiState.hz;

      labels.push(
        <div
          key={`label-pd-${b.id}`}
          style={{
            position: 'absolute',
            left: `${rx * 100}%`,
            top: `${ry * 100}%`,
            transform: labelTransform,
            pointerEvents: 'none',
            zIndex: 10,
          }}
        >
          <div
            style={{
              background: 'rgba(13, 17, 23, 0.95)',
              backdropFilter: 'blur(4px)',
              border: `1px solid ${color}`,
              borderRadius: 3,
              padding: '1px 5px',
              fontSize: `${fontSize - 2}px`,
              color: '#fff',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              boxShadow: `0 2px 6px rgba(0,0,0,0.5), 0 0 6px ${color}33`,
              fontFamily: 'var(--font-mono)',
              animation: isActive ? 'pulse-subtle 2s infinite' : 'none'
            }}
          >
            <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{b.name}</span>
            <span style={{ fontWeight: 800, color: color, fontSize: `${fontSize - 3}px`, borderLeft: '1px solid rgba(255,255,255,0.15)', paddingLeft: 4 }}>
              {liveDb != null ? `${liveDb.toFixed(1)} dB` : '-- dB'}
            </span>
            {showPredValue && (
              <span style={{ fontWeight: 600, color: 'rgba(255,255,255,0.6)', fontSize: `${fontSize - 4}px`, borderLeft: '1px solid rgba(255,255,255,0.15)', paddingLeft: 4 }}>
                {liveHz != null ? `${(liveHz / 1000).toFixed(1)} kHz` : '-- kHz'}
              </span>
            )}
          </div>
        </div>
      );
    });

    return labels;
  };

  /** Render các polygon SVG vùng PD (phóng điện) lên overlay. */
  const renderOverlayPdBoundaries = (cam: CameraDevice) => {
    const baseDeviceId = cam.id.replace(/_(optical|thermal)$/, '').toLowerCase();
    const boundaries = pdBoundaries[baseDeviceId] || [];
    const aiState = aiStatsMap[baseDeviceId] || {};

    return boundaries.map(b => {
      let poly: [number, number][] = [];
      try { poly = JSON.parse(b.polygon); } catch { return null; }
      if (poly.length < 3) return null;

      const pointsStr = poly.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');

      const isActive = aiState.active_boundary === b.name;
      const liveDb: number | null = aiState.db ?? null;

      let warnDb = 20, alarmDb = 35;
      try {
        const t = JSON.parse(b.thresholds || '{}');
        warnDb = t.warn || t.warning || 20;
        alarmDb = t.alarm || 35;
      } catch {}

      const isAlarm = liveDb != null && liveDb >= alarmDb;
      const isWarn  = liveDb != null && liveDb >= warnDb;
      const color = isAlarm ? '#ef4444' : (isWarn ? '#fbbf24' : '#10b981');

      return (
        <g key={b.id}>
          <polygon
            points={pointsStr}
            fill={`${color}${isActive ? '25' : '10'}`}
            stroke={color}
            strokeWidth={isActive ? 3 : 1.5}
            strokeDasharray={isActive ? 'none' : '4 2'}
            vectorEffect="non-scaling-stroke"
            opacity={0.9}
            style={{ transition: 'all 0.3s ease' }}
          />
        </g>
      );
    });
  };

  // Helper to extract province
  const getProvinceOfStation = (stationName: string) => {
    const st = stations.find(s => s.name.toLowerCase() === stationName.toLowerCase());
    if (st && st.location) {
      try {
        const loc = JSON.parse(st.location);
        if (loc.address) {
          const addr = loc.address.toLowerCase();
          if (addr.includes('hà nội') || addr.includes('ha noi')) return 'Hà Nội';
          if (addr.includes('hồ chí minh') || addr.includes('ho chi minh') || addr.includes('tphcm') || addr.includes('hcm')) return 'TP. Hồ Chí Minh';
          if (addr.includes('đà nẵng') || addr.includes('da nang')) return 'Đà Nẵng';
          if (addr.includes('hải phòng') || addr.includes('hai phong')) return 'Hải Phòng';
          if (addr.includes('cần thơ') || addr.includes('can tho')) return 'Cần Thơ';
          
          const parts = loc.address.split(',');
          if (parts.length > 0) {
            const last = parts[parts.length - 1].trim();
            if (last) return last;
          }
        }
      } catch (e) {}
    }
    if (stationName.toLowerCase().includes('hà nội') || stationName.toLowerCase().includes('hn')) return 'Hà Nội';
    if (stationName.toLowerCase().includes('hồ chí minh') || stationName.toLowerCase().includes('hcm')) return 'TP. Hồ Chí Minh';
    if (stationName.toLowerCase().includes('đà nẵng') || stationName.toLowerCase().includes('dn')) return 'Đà Nẵng';
    return 'Miền Bắc'; // Default region fallback
  };

  const filteredCameras = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();

    return cameras.filter(cam => {
      const stationName = (cam as any).stationName || 'Không rõ trạm';
      const province = getProvinceOfStation(stationName);

      return !q || 
        cam.name.toLowerCase().includes(q) || 
        stationName.toLowerCase().includes(q) || 
        province.toLowerCase().includes(q);
    });
  }, [cameras, searchQuery, stations]);

  const handleAssignCamera = (camId: string, idx: number) => {
    setGridAssignments(prev => ({
      ...prev,
      [idx]: camId
    }));
  };

  const changeGridSize = (cols: number, rows: number) => {
    setGridCols(cols);
    setGridRows(rows);
    localStorage.setItem('rtm_grid_cols', String(cols));
    localStorage.setItem('rtm_grid_rows', String(rows));
    if (selectedCellIdx !== null && selectedCellIdx >= cols * rows) {
      setSelectedCellIdx(0);
    }
  };



  const openPresetInPopout = (e: React.MouseEvent, presetId: string) => {
    e.stopPropagation();
    window.open(
      window.location.origin + `/realtime?popout=true&preset=${presetId}`,
      '_blank',
      'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no,titlebar=no'
    );
    setShowGridDropdown(false);
  };

  const handleSavePreset = () => {
    const name = presetInput.trim();
    if (!name) return;
    const newPreset = {
      id: `preset-${Date.now()}`,
      name,
      gridCols,
      gridRows,
      assignments: { ...gridAssignments }
    };
    const updated = [...presets, newPreset];
    setPresets(updated);
    localStorage.setItem('rtm_presets', JSON.stringify(updated));
    setPresetInput('');
  };

  const handleLoadPreset = (preset: typeof presets[0]) => {
    const cols = preset.gridCols || preset.gridSize || 2;
    const rows = preset.gridRows || preset.gridSize || 2;
    setGridCols(cols);
    setGridRows(rows);
    localStorage.setItem('rtm_grid_cols', String(cols));
    localStorage.setItem('rtm_grid_rows', String(rows));
    setGridAssignments(preset.assignments);
    setSelectedCellIdx(0);
  };

  const handleDeletePreset = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const updated = presets.filter(p => p.id !== id);
    setPresets(updated);
    localStorage.setItem('rtm_presets', JSON.stringify(updated));
  };

  const renderSidebar = () => {
    const handleDragStart = (e: React.DragEvent, camId: string) => {
      e.dataTransfer.setData('text/plain', camId);
    };

    const handleCameraClick = (camId: string) => {
      if (selectedCellIdx !== null) {
        handleAssignCamera(camId, selectedCellIdx);
        setSelectedCellIdx((selectedCellIdx + 1) % (gridCols * gridRows));
      } else {
        let targetIdx = 0;
        for (let i = 0; i < gridCols * gridRows; i++) {
          if (!gridAssignments[i]) {
            targetIdx = i;
            break;
          }
        }
        handleAssignCamera(camId, targetIdx);
      }
    };

    return (
      <div className="rtm-sidebar">
        <div className="rtm-sidebar-content" style={{ paddingTop: 10 }}>
          {filteredCameras.length === 0 ? (
            <div style={{ padding: 12, textAlign: 'center', color: 'var(--admin-text-muted)', fontSize: 11 }}>
              Không tìm thấy kết quả
            </div>
          ) : (
            filteredCameras.map(cam => {
              const stationName = (cam as any).stationName || 'Không rõ trạm';
              const baseId = cam.id.replace(/_(optical|thermal)$/, '').toLowerCase();
              const status = deviceStatus[baseId] || 'unknown';
              
              const getCamIcon = () => {
                if (cam.type === 'camera_pd') return '⚡';
                if (cam.type === 'camera_thermal' || cam.id.endsWith('_thermal')) return '🔥';
                return '📹';
              };

              return (
                <div
                  key={cam.id}
                  className={`rtm-tree-node rtm-camera-node ${status === 'offline' ? 'offline' : ''}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, cam.id)}
                  onClick={() => handleCameraClick(cam.id)}
                  title="Click để gán vào ô đã chọn hoặc kéo-thả vào ô lưới"
                >
                  <span>{getCamIcon()}</span>
                  <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', flex: 1 }} title={cam.name}>
                    {cam.name.replace(/^hikvision\s*[-–—_]*\s*/i, '').trim()}
                  </span>
                  <span className={`nvr-dot ${status}`} style={{ width: 6, height: 6, marginLeft: 'auto', flexShrink: 0 }} />
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  };

  /** Render một ô camera trong lưới NVR — bao gồm stream, overlay và HUD. */
  const renderCell = (cam: CameraDevice | undefined, idx: number) => {
    const ch = String(idx + 1).padStart(2, '0');
    const isSelected = selectedCellIdx === idx;
    
    const handleCellClick = () => {
      setSelectedCellIdx(idx);
    };

    const handleCellDrop = (e: React.DragEvent) => {
      e.preventDefault();
      const camId = e.dataTransfer.getData('text/plain');
      if (camId) {
        handleAssignCamera(camId, idx);
      }
    };

    const handleClearCell = (e: React.MouseEvent) => {
      e.stopPropagation();
      setGridAssignments(prev => ({
        ...prev,
        [idx]: null
      }));
    };

    if (!cam) {
      return (
        <div 
          key={`empty-${idx}`} 
          className={`nvr-cell ${isSelected ? 'selected-cell' : ''}`}
          onClick={handleCellClick}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleCellDrop}
        >
          <div className="nvr-cell-placeholder">
            <span style={{ fontSize: '24px', opacity: 0.35 }}>📹</span>
            <span className="nvr-cell-placeholder-txt">Kênh {ch} trống</span>
            <span className="nvr-cell-placeholder-sub">Kéo thả camera hoặc click chọn để gán</span>
          </div>
          <div className="nvr-ch">CH{ch}</div>
        </div>
      );
    }

    const cfg = (cam as any).config || {};
    const go2rtcId = cfg.go2rtc_id || '';
    if (!go2rtcId) {
      return (
        <div 
          key={cam.id} 
          className={`nvr-cell ${isSelected ? 'selected-cell' : ''}`}
          onClick={handleCellClick}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleCellDrop}
        >
          <div className="nvr-nosig">
            <span className="nvr-nosig-ico">⚠️</span>
            <span className="nvr-nosig-txt">Chưa cấu hình</span>
            <button 
              className="nvr-abtn nvr-abtn-clear" 
              style={{ marginTop: 8, pointerEvents: 'all' }} 
              onClick={handleClearCell}
            >
              Gỡ bỏ
            </button>
          </div>
          <div className="nvr-ch">CH{ch} · {cam.name}</div>
        </div>
      );
    }

    const isExpanded = expandedCamId === cam.id;
    const subId = cfg.go2rtc_sub_id || go2rtcId;
    const mainId = cfg.go2rtc_main_id || go2rtcId;
    const baseDeviceId = cam.id.replace(/_(optical|thermal)$/, '').toLowerCase();
    const cellBoundaries = roiBoundaries[baseDeviceId] || [];
    const cellPoints = roiPoints[baseDeviceId] || [];
    const activeId = isExpanded ? mainId : subId;
    const status = deviceStatus[baseDeviceId] || 'unknown';
    
    const isAI = !!aiStreamCells[cam.id];
    const isOptical = cam.id.endsWith('_optical');

    const hasAlert = alerts.some(alert => {
      const alertDevId = typeof alert.deviceId === 'string' ? alert.deviceId.toLowerCase() : '';
      if (!alertDevId) return false;
      const baseCamIdLower = cam.id.replace(/_(optical|thermal)$/, '').toLowerCase();

      if (alertDevId === baseCamIdLower) {
        const alertMsg = typeof alert.message === 'string' ? alert.message.toLowerCase() : '';
        const isThermalAlert = alertMsg.match(/nhiệt|nhiet|roi|thermal|quá nhiệt|qua nhiet|temp/);
        const isOpticalCell = cam.id.endsWith('_optical');
        const isThermalCell = cam.id.endsWith('_thermal');
        if (isThermalAlert && isOpticalCell) return false;
        if (!isThermalAlert && isThermalCell) return false;
        return true;
      }

      const origCam = devices.find((d: Device) => d.id.toLowerCase() === baseCamIdLower);
      if (origCam) {
        const camCfg = (origCam as any).config || {};
        const cabIdStr = typeof camCfg.cabinetId === 'string' ? camCfg.cabinetId.toLowerCase() : '';
        if (cabIdStr && cabIdStr === alertDevId) {
          const alertMsg = typeof alert.message === 'string' ? alert.message.toLowerCase() : '';
          const isThermalAlert = alertMsg.match(/nhiệt|nhiet|roi|thermal|quá nhiệt|qua nhiet|temp/);
          const isOpticalCell = cam.id.endsWith('_optical');
          const isThermalCell = cam.id.endsWith('_thermal');
          if (isThermalAlert && isOpticalCell) return false;
          if (!isThermalAlert && isThermalCell) return false;
          return true;
        }
        
        const camZone = typeof camCfg.zone === 'string' ? camCfg.zone.trim().toLowerCase() : '';
        if (camZone) {
          const alertDev = devices.find((d: Device) => d.id.toLowerCase() === alertDevId);
          const alertCfgZone = (alertDev?.config as any)?.zone;
          const alertDevZone = typeof alertCfgZone === 'string' ? alertCfgZone.trim().toLowerCase() : '';
          if (alertDevZone && alertDevZone === camZone) {
            const alertMsg = typeof alert.message === 'string' ? alert.message.toLowerCase() : '';
            const isThermalAlert = alertMsg.match(/nhiệt|nhiet|roi|thermal|quá nhiệt|qua nhiet|temp/);
            const isOpticalCell = cam.id.endsWith('_optical');
            const isThermalCell = cam.id.endsWith('_thermal');
            if (isThermalAlert && isOpticalCell) return false;
            if (!isThermalAlert && isThermalCell) return false;
            return true;
          }
        }
      }
      return false;
    });
    
    const rawStreamUrl = `/camera-stream.html?src=${encodeURIComponent(activeId)}&mode=webrtc,mse&go2rtc=${encodeURIComponent(GO2RTC_URL)}`;
    const aiStreamUrl = `${AI_ENGINE_URL}/stream/${activeId}`;

    const readings = roiReadings[baseDeviceId] || {};
    let maxTemp: number | undefined;
    Object.values(readings).forEach(val => {
      if (typeof val === 'number') {
        if (maxTemp === undefined || val > maxTemp) {
          maxTemp = val;
        }
      }
    });

    const isThermal = cam.id.endsWith('_thermal') || cam.type === 'camera_thermal';
    const isPd = cam.type === 'camera_pd';
    const aiState = aiStatsMap[baseDeviceId] || {};
    const pdDb = aiState.detection?.db ?? (typeof aiState.db === 'number' ? aiState.db : undefined);

    const overlayStats = (() => {
      if (isThermal && maxTemp !== undefined) {
        return `Max: ${maxTemp.toFixed(1)}°C`;
      }
      if (isPd && pdDb !== undefined) {
        return `${pdDb.toFixed(1)} dB`;
      }
      return null;
    })();

    return (
      <div 
        key={cam.id} 
        className={`nvr-cell ${isExpanded ? 'expanded' : ''} ${hasAlert ? 'alarm-triggered' : ''} ${isSelected ? 'selected-cell' : ''}`} 
        style={{ display: (expandedCamId && !isExpanded) ? 'none' : 'block' }}
        onDoubleClick={() => toggleExpand(cam.id)}
        onClick={handleCellClick}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleCellDrop}
      >
        <div className={`nvr-stream-wrapper ${isOptical ? 'nvr-sync-zoom' : ''}`}>
          {isAI ? (
            <img src={aiStreamUrl} alt={cam.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          ) : (
            <iframe 
              src={rawStreamUrl} 
              allow="autoplay; camera; microphone" 
              title={cam.name} 
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                border: 'none',
                pointerEvents: 'none',
                zIndex: 1
              }}
            />
          )}
          {!isAI && (
            <div 
              className="nvr-overlay"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                zIndex: 2
              }}
            >
              {(() => {
                const isThermalCell = cam.id.endsWith('_thermal') || cam.type === 'camera_thermal';
                if (isThermalCell) return null;

                let targetCam = cam;
                let targetBaseDeviceId = cam.id.replace(/_(optical|thermal)$/, '').toLowerCase();
                if (cam.type !== 'camera_dual' && !cam.id.includes('_optical')) {
                  const c = cam.config || {};
                  if (c.ip) {
                    const linkedThermal = devices.find(d => 
                      (d.type === 'camera_thermal' || d.type === 'camera_dual') && 
                      (d.config as any)?.ip === c.ip
                    );
                    if (linkedThermal) {
                      targetBaseDeviceId = linkedThermal.id.toLowerCase();
                      targetCam = linkedThermal as any;
                    } else {
                      return null;
                    }
                  } else {
                    return null;
                  }
                }

                const cfg = targetCam.config || {};
                const focalOpt = cfg.focal_length_optical;
                const focalTh = cfg.focal_length_thermal;
                const isFocalEqual = focalOpt != null && focalTh != null && Number(focalOpt) === Number(focalTh);
                const vvrRaw = (cfg as any).visible_valid_rect;
                const vvr = isFocalEqual ? { x: 0, y: 0, width: 1, height: 1 } : (vvrCache[targetBaseDeviceId]
                  ?? (vvrRaw && typeof vvrRaw.x === 'number' ? vvrRaw : { x: 0.20, y: 0.084, width: 0.63, height: 0.841 }));
                
                if (vvr.x === 0 && vvr.y === 0 && vvr.width === 1 && vvr.height === 1) return null;

                const pct = (val: number) => `${val * 100}%`;
                return (
                  <div style={{ position:'absolute', left:pct(vvr.x), top:pct(vvr.y), width:pct(vvr.width), height:pct(vvr.height), border:'1.5px dashed rgba(239, 68, 68, 0.55)', pointerEvents:'none', zIndex:5 }}>
                    <div style={{ position:'absolute', top:-16, left:4, color:'#ef4444', fontSize:9, fontWeight:600, opacity:0.9, background:'rgba(15,23,42,0.85)', border:'1px solid rgba(239,68,68,0.25)', padding:'1px 5px', borderRadius:2, whiteSpace:'nowrap' }}>Vùng ảnh nhiệt</div>
                  </div>
                );
              })()}
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  pointerEvents: 'none',
                  overflow: 'visible',
                  zIndex: 1
                }}
              >
                {renderOverlayBoundaries(cam)}
                {renderOverlayPdBoundaries(cam)}
                {(() => {
                  const baseId = cam.id.replace(/_(optical|thermal)$/, '').toLowerCase();
                  const det = aiStatsMap[baseId]?.detection;
                  if (!det) return null;
                  return (
                    <g transform={`translate(${det.x * 100}, ${det.y * 100})`}>
                      <circle r="2" fill="none" stroke="#fff" strokeWidth="0.5" />
                      <line x1="-2.5" y1="0" x2="2.5" y2="0" stroke="#ef4444" strokeWidth="0.6" />
                      <line x1="0" y1="-2.5" x2="0" y2="2.5" stroke="#ef4444" strokeWidth="0.6" />
                    </g>
                  );
                })()}
              </svg>
              {renderOverlayLabels(cam)}
            </div>
          )}
        </div>


        
        <div className="nvr-hud-t">
          <div className="nvr-cam-info">
            <span className={`nvr-dot ${status}`} />
            <span className="nvr-cname">CH{ch} · {cam.name}</span>
            {cellBoundaries.length > 0 && (
              <span style={{ 
                background: 'rgba(59, 130, 246, 0.2)', 
                color: '#3b82f6', 
                fontSize: '0.65rem', 
                padding: '1px 5.5px', 
                borderRadius: 3, 
                marginLeft: 8,
                fontWeight: 600,
                border: '1px solid rgba(59, 130, 246, 0.4)' 
              }}>
                Vùng nhiệt: {cellBoundaries.length}
              </span>
            )}
            {cellPoints.length > 0 && (
              <span style={{ 
                background: 'rgba(16, 185, 129, 0.2)', 
                color: '#10b981', 
                fontSize: '0.65rem', 
                padding: '1px 5.5px', 
                borderRadius: 3, 
                marginLeft: 8,
                fontWeight: 600,
                border: '1px solid rgba(16, 185, 129, 0.4)' 
              }}>
                Điểm nhiệt: {cellPoints.length}
              </span>
            )}
          </div>
          <div className="nvr-rec"><span className="nvr-recdot" />REC</div>
        </div>

        <div className="nvr-hud-b">
          <div className="nvr-acts">
            <button 
              className={`nvr-abtn ${isAI ? 'active' : ''}`} 
              title={isAI ? "Tắt luồng AI (Hiện luồng thô)" : "Bật luồng AI (Hiện bounding box/line/nhiệt độ từ OpenCV)"} 
              onClick={(e) => { e.stopPropagation(); setAiStreamCells(prev => ({ ...prev, [cam.id]: !prev[cam.id] })); }}
              style={{ color: isAI ? '#3b82f6' : 'inherit', fontSize: '9px', fontWeight: 'bold' }}
            >
              AI
            </button>
            <button 
              className="nvr-abtn" 
              title="Chụp ảnh" 
              onClick={(e) => { e.stopPropagation(); takeSnapshot(activeId); }}
            >
              📸
            </button>
            <button 
              className="nvr-abtn" 
              title="Xem toàn màn hình" 
              onClick={(e) => { e.stopPropagation(); toggleExpand(cam.id); }}
            >
              ⛶
            </button>
            <button 
              className="nvr-abtn nvr-abtn-clear" 
              title="Gỡ camera khỏi ô" 
              onClick={handleClearCell}
            >
              🗑️
            </button>
          </div>
        </div>
      </div>
    );
  };

  const toggleExpand = (camId: string) => {
    if (expandedCamId === camId) {
      setExpandedCamId(null);
    } else {
      setExpandedCamId(camId);
    }
  };

  const takeSnapshot = (srcId: string) => {
    const url = `${GO2RTC_URL}/api/frame.jpeg?src=${encodeURIComponent(srcId)}`;
    Object.assign(document.createElement('a'), { href: url, download: `snap_${Date.now()}.jpg`, target: '_blank' }).click();
  };

  const cellCount = gridCols * gridRows;

  return (
    <div className="rtm-page">

      {/* ── Toolbar ── */}
      {!isPopout && (
        <div className="page-toolbar-row dash-header">
          <div className="page-title-cell">
            <h2>GIÁM SÁT CAMERA TRỰC TIẾP</h2>
          </div>

          <div className="page-toolbar-group">
            {!isCentralFleetView && (
              <>
                {/* Single Unified Grid & Presets Dropdown */}
                <div style={{ position: 'relative' }} ref={dropdownRef}>
                  <button
                    className={`nvr-lb ${showGridDropdown ? 'active' : ''}`}
                    onClick={() => setShowGridDropdown(prev => !prev)}
                    title="Cấu hình bố cục & mẫu giám sát"
                    style={{ display: 'flex', alignItems: 'center', gap: 6, width: 'auto', padding: '0 12px', fontSize: 11, fontWeight: 700 }}
                  >
                    <LayoutGrid size={14} />
                    <span>BỐ CỤC ({gridCols}×{gridRows})</span>
                    <ChevronDown size={12} style={{ transform: showGridDropdown ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
                  </button>

                  {showGridDropdown && (
                    <div className="rtm-grid-dropdown" style={{ width: 310 }}>
                      {/* Quick Section */}
                      <div className="rtm-dropdown-section">
                        <div className="rtm-dropdown-section-title">BỐ CỤC NHANH</div>
                        <div className="rtm-quick-grid">
                          {([
                            [1, 1], [2, 1], [2, 2], [3, 2],
                            [4, 2], [3, 3], [4, 3], [5, 3],
                            [4, 4], [5, 4], [6, 4], [6, 5]
                          ] as [number, number][]).map(([c, r]) => (
                            <button
                              key={`${c}x${r}`}
                              className={`rtm-quick-btn ${gridCols === c && gridRows === r ? 'active' : ''}`}
                              onClick={() => {
                                changeGridSize(c, r);
                                setShowGridDropdown(false);
                              }}
                            >
                              {c}×{r}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Interactive Selection Grid */}
                      <div className="rtm-dropdown-section">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <span className="rtm-dropdown-section-title">CHỌN Ô LƯỚI</span>
                          <span className="rtm-dropdown-info">
                            {hoveredCol !== null && hoveredRow !== null 
                              ? `${hoveredCol + 1}×${hoveredRow + 1} (${(hoveredCol + 1) * (hoveredRow + 1)} Ô)`
                              : `${gridCols}×${gridRows} (${gridCols * gridRows} Ô)`
                            }
                          </span>
                        </div>
                        <div 
                          className="rtm-hover-grid-container"
                          onMouseLeave={() => {
                            setHoveredCol(null);
                            setHoveredRow(null);
                          }}
                        >
                          {Array.from({ length: 6 }).map((_, rIdx) => (
                            <div key={rIdx} className="rtm-hover-grid-row">
                              {Array.from({ length: 8 }).map((_, cIdx) => {
                                const isHovered = hoveredCol !== null && hoveredRow !== null && cIdx <= hoveredCol && rIdx <= hoveredRow;
                                const isSelected = hoveredCol === null && cIdx < gridCols && rIdx < gridRows;
                                return (
                                  <div
                                    key={cIdx}
                                    className={`rtm-hover-grid-cell ${isHovered ? 'hovered' : ''} ${isSelected ? 'selected' : ''}`}
                                    onMouseEnter={() => {
                                      setHoveredCol(cIdx);
                                      setHoveredRow(rIdx);
                                    }}
                                    onClick={() => {
                                      changeGridSize(cIdx + 1, rIdx + 1);
                                      setShowGridDropdown(false);
                                    }}
                                  />
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Custom Input Section */}
                      <div className="rtm-dropdown-section">
                        <div className="rtm-dropdown-section-title" style={{ marginBottom: 8 }}>NHẬP TÙY CHỈNH</div>
                        <div className="rtm-custom-inputs">
                          <input
                            type="number"
                            min="1"
                            max="10"
                            value={customCols}
                            onChange={(e) => setCustomCols(e.target.value)}
                            className="rtm-custom-input-field"
                          />
                          <span style={{ color: 'var(--admin-text-muted)', fontSize: 10 }}>×</span>
                          <input
                            type="number"
                            min="1"
                            max="10"
                            value={customRows}
                            onChange={(e) => setCustomRows(e.target.value)}
                            className="rtm-custom-input-field"
                          />
                          <button
                            className="rtm-custom-apply-btn"
                            onClick={() => {
                              const c = parseInt(customCols, 10);
                              const r = parseInt(customRows, 10);
                              if (c > 0 && r > 0) {
                                changeGridSize(c, r);
                                setShowGridDropdown(false);
                              }
                            }}
                          >
                            ÁP DỤNG
                          </button>
                        </div>
                      </div>

                      {/* Presets Section */}
                      <div className="rtm-dropdown-section" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                        <div className="rtm-dropdown-section-title" style={{ marginBottom: 8 }}>MẪU BỐ CỤC (PRESETS)</div>
                        <div className="rtm-presets-save" style={{ marginTop: 0, display: 'flex', gap: 6 }}>
                          <input
                            type="text"
                            className="rtm-preset-input"
                            placeholder="Tên mẫu..."
                            value={presetInput}
                            onChange={(e) => setPresetInput(e.target.value)}
                            style={{ flex: 1, background: 'rgba(0,0,0,0.25)', border: '1px solid var(--admin-border)', borderRadius: 0, color: '#fff', padding: '0 8px', fontSize: 11, height: 28 }}
                          />
                          <button 
                            className="rtm-preset-btn" 
                            onClick={handleSavePreset}
                            style={{ height: 28, borderRadius: 0, background: 'var(--admin-accent)', border: 'none', color: 'var(--admin-text-on-accent)', fontSize: 11, fontWeight: 'bold', padding: '0 12px', cursor: 'pointer' }}
                          >
                            Lưu
                          </button>
                        </div>
                        {presets.length > 0 && (
                          <div className="rtm-presets-list" style={{ marginTop: 10, maxHeight: 150, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {presets.map(p => (
                              <div 
                                key={p.id} 
                                className="rtm-preset-item"
                                onClick={() => {
                                  handleLoadPreset(p);
                                  setShowGridDropdown(false);
                                }}
                                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 0, cursor: 'pointer', transition: 'all 0.15s' }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'var(--admin-hover)'; e.currentTarget.style.borderColor = 'var(--admin-accent)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.02)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.05)'; }}
                              >
                                <span style={{ fontSize: 11, color: 'var(--admin-text)', fontWeight: 600 }}>{p.name} ({p.gridCols || p.gridSize}×{p.gridRows || p.gridSize})</span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <button
                                    className="rtm-preset-popout"
                                    onClick={(e) => openPresetInPopout(e, p.id)}
                                    title="Mở mẫu này trong cửa sổ mới"
                                    style={{ background: 'none', border: 'none', color: 'var(--admin-text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2px 6px' }}
                                    onMouseEnter={e => e.currentTarget.style.color = 'var(--admin-accent)'}
                                    onMouseLeave={e => e.currentTarget.style.color = 'var(--admin-text-muted)'}
                                  >
                                    <ExternalLink size={12} />
                                  </button>
                                  <button 
                                    className="rtm-preset-del" 
                                    onClick={(e) => handleDeletePreset(e, p.id)}
                                    title="Xóa mẫu"
                                    style={{ background: 'none', border: 'none', color: 'var(--admin-text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2px 6px' }}
                                    onMouseEnter={e => e.currentTarget.style.color = 'var(--admin-danger)'}
                                    onMouseLeave={e => e.currentTarget.style.color = 'var(--admin-text-muted)'}
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                    </div>
                  )}
                </div>

                {expandedCamId && (
                  <div className="nvr-back-btn visible" onClick={() => toggleExpand(expandedCamId)}>
                    ← Quay về lưới
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Main Area ── */}
      <div className="rtm-main" style={{ position: 'relative', display: 'flex', overflow: 'hidden' }}>
        {!isPopout && sidebarOpen && renderSidebar()}

        {/* Floating Sidebar Toggle Tab */}
        {!isCentralFleetView && !isPopout && (
          <button 
            className="rtm-sidebar-toggle-tab"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title={sidebarOpen ? "Ẩn danh sách" : "Hiện danh sách"}
            style={{
              position: 'absolute',
              left: sidebarOpen ? 190 : 0,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 18,
              height: 48,
              background: 'var(--admin-panel)',
              border: '1px solid var(--admin-border)',
              borderLeft: sidebarOpen ? 'none' : '1px solid var(--admin-border)',
              borderRadius: '0 6px 6px 0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              zIndex: 300,
              color: 'rgba(255, 255, 255, 0.6)',
              transition: 'left 0.1s ease',
              boxShadow: sidebarOpen ? '2px 0 5px rgba(0,0,0,0.2)' : '2px 0 5px rgba(0,0,0,0.5)'
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'var(--admin-accent)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)'}
          >
            <ChevronLeft size={14} style={{ transform: sidebarOpen ? 'none' : 'rotate(180deg)' }} />
          </button>
        )}

        <div className="nvr-wrap">
          <div 
            className="nvr-grid"
            style={{
              display: 'grid',
              gap: '2px',
              height: '100%',
              width: '100%',
              position: 'relative',
              boxSizing: 'border-box',
              gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
              gridTemplateRows: `repeat(${gridRows}, 1fr)`
            }}
          >
            {Array.from({ length: cellCount }).map((_, i) => {
              const camId = gridAssignments[i];
              const cam = cameras.find(c => c.id === camId);
              return renderCell(cam, i);
            })}
          </div>
        </div>
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div className="nvr-lb-overlay open" onClick={(e) => { if (e.target === e.currentTarget) setLightbox(null); }}>
          <span className="nvr-lb-close" onClick={() => setLightbox(null)}></span>
          <div className="nvr-lb-content">
            {lightbox.isVideo ? (
              <video src={lightbox.url} controls autoPlay loop style={{ maxHeight: '85vh' }} />
            ) : (
              <img src={lightbox.url} alt="snapshot" style={{ maxHeight: '85vh' }} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
