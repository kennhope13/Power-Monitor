// ============================================================
// DeviceManagementPage.tsx — Quản lý thiết bị kết nối
// Hỗ trợ: PLC S7-1200, Camera (CCTV/Nhiệt/PD), Cảm biến Modbus
// Tính năng: Thêm/sửa/xóa, kiểm tra kết nối, dò tìm mạng (scan)
// ============================================================

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LayoutList, Trash2, Settings, Zap, Thermometer, Eye, EyeOff, ShieldAlert, Flame } from 'lucide-react';
import { stationApi, Device, CameraDevice, Rule } from '@/services/StationApiService';
import { confirmDialog } from '@/utils/confirm';
import { showToast } from '@/utils/toast';
import { DEVICE_TYPE_LABELS } from '@/constants/devices';
import { PT_TEMP_1, PT_TEMP_2, PT_TEMP_3, PT_PD, PT_CAM_IDS, TEMP_LABELS, CAM_POINT_LABELS } from '@/constants/points';
import { useStationStore } from '@/store';
import ThermalConfigTab from './components/ThermalConfigTab';
import PdRegionTab from './components/PdRegionTab';
import FireAlarmConfigTab from './components/FireAlarmConfigTab';
import { MULTISITE_DRILL_STATION_KEY } from '@/utils/centralAccess';

import ActionDropdown, { ActionDropdownItem } from '@/components/ui/ActionDropdown';


const CABINET_FALLBACK_POINTS = [
  { value: PT_TEMP_1, label: `${TEMP_LABELS[PT_TEMP_1]} (°C)` },
  { value: PT_TEMP_2, label: `${TEMP_LABELS[PT_TEMP_2]} (°C)` },
  { value: PT_TEMP_3, label: `${TEMP_LABELS[PT_TEMP_3]} (°C)` },
  { value: PT_PD,     label: `${TEMP_LABELS[PT_PD]} (dB)` },
];

const CAMERA_FALLBACK_POINTS = [
  ...(PT_CAM_IDS as readonly string[]).map(id => ({ value: id, label: `Điểm camera ${id} — Nhiệt độ (°C)` })),
];

const GENERIC_FALLBACK_POINTS = [
  ...CABINET_FALLBACK_POINTS,
  ...CAMERA_FALLBACK_POINTS,
];

const isCabinetLikeDevice = (type: string, cfg: Record<string, any> = {}) => {
  if (type === 'cabinet') return true;
  if (type !== 'plc_s7') return false;
  return Array.isArray(cfg.points)
    || Array.isArray(cfg.cabinet_points)
    || !!cfg.cabinet_code
    || !!cfg.poll_enabled;
};

type CabinetPointTemplate = {
  pointId: string;
  name: string;
  tagName: string;
  type: 'Int' | 'UInt' | 'DInt' | 'Real' | 'Bool';
  dbAddress: string;
  valueRange: string;
  note: string;
  unit?: string;
  offset?: number;
  bit?: number;
};

const parseCabinetPointsJson = (text: string): CabinetPointTemplate[] => {
  if (!text.trim()) return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('Cabinet points phải là một mảng JSON.');
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Point #${index + 1} không hợp lệ.`);
    }
    return {
      pointId: String(item.pointId ?? item.id ?? item.name ?? `point_${index + 1}`),
      name: String(item.name ?? item.label ?? item.pointId ?? `Point ${index + 1}`),
      tagName: String(item.tagName ?? item.tagname ?? item.name ?? item.pointId ?? `Point ${index + 1}`),
      type: (item.type ?? 'Int') as CabinetPointTemplate['type'],
      dbAddress: String(item.dbAddress ?? item.db_address ?? ''),
      valueRange: String(item.valueRange ?? ''),
      note: String(item.note ?? ''),
      unit: item.unit != null ? String(item.unit) : undefined,
      offset: item.offset != null ? Number(item.offset) : undefined,
      bit: item.bit != null ? Number(item.bit) : undefined,
    };
  });
};

// Nhãn hiển thị theo loại thiết bị — import từ constants để dùng chung
const TYPE_LABELS = DEVICE_TYPE_LABELS;

interface DeviceManagementPageProps {
  initialAction?: 'new' | null;
  onInitialActionHandled?: () => void;
}

/**
 * Trang quản lý thiết bị — hỗ trợ thêm/sửa/xóa thiết bị,
 * kiểm tra kết nối, quét LAN/ONVIF và cấu hình nhiệt/PD/vùng giám sát.
 */
export default function DeviceManagementPage({
  initialAction = null,
  onInitialActionHandled,
}: DeviceManagementPageProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const stations = useStationStore(s => s.stations);
  const viewingStationId = useStationStore(s => s.viewingStationId);
  const [stationId, setStationId] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);

  // Trạng thái modal thêm/sửa thiết bị
  const [isDeviceModalOpen, setIsDeviceModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // null = đang thêm mới
  const [isSaving, setIsSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [testConnResult, setTestConnResult] = useState<{ show: boolean, success?: boolean, msg?: string, latency?: number }>({ show: false });

  // Dữ liệu form — dùng chung cho mọi loại thiết bị, field nào không dùng thì bỏ qua
  const [formData, setFormData] = useState({
    name: '', type: 'camera_cctv', ip: '',
    rack: 0, slot: 1, db: 32, length: 10,
    username: 'admin', password: '',
    // Legacy single stream
    rtspPath: '', go2rtcId: '',
    // Dual-stream (camera_dual / camera_thermal)
    rtspOptical: '', go2rtcOptical: '',
    rtspThermal: '', go2rtcThermal: '',
    // Cabinet link
    cabinetId: '',
    port: 502, unitId: 1,
    pollEnabled: false,
    enableHealthScore: false
  });
  const [cabinetPointsJson, setCabinetPointsJson] = useState('');


  const [roiTab, setRoiTab] = useState(0); // page tabs: 0=all, 2=pd region, 3=thermal, 4=fire config
  const [selectedRoiDevice, setSelectedRoiDevice] = useState<CameraDevice | null>(null);
  const [selectedPdDevice, setSelectedPdDevice] = useState<CameraDevice | null>(null);
  const [selectedFireDevice, setSelectedFireDevice] = useState<CameraDevice | null>(null);

  // PD Refactor hook

  // Trạng thái modal dò tìm thiết bị trên mạng
  const [isScanModalOpen, setIsScanModalOpen] = useState(false);
  const [scanTab, setScanTab] = useState(0); // 0=Ping scan, 1=ONVIF, 2=Test thủ công

  const [scanSubnet, setScanSubnet] = useState('192.168.10');
  const [isScanning, setIsScanning] = useState(false);
  const [scanResults, setScanResults] = useState<any[] | null>(null);

  const [cabinetImportFile, setCabinetImportFile] = useState<File | null>(null);

  // Auto-configure Hikvision modal
  const [autoConfigTarget, setAutoConfigTarget] = useState<{ ip: string } | null>(null);
  const [autoConfigCreds, setAutoConfigCreds] = useState({ username: 'admin', password: '' });
  const [isAutoConfiguring, setIsAutoConfiguring] = useState(false);

  const [isOnvifScanning, setIsOnvifScanning] = useState(false);
  const [onvifResults, setOnvifResults] = useState<any[] | null>(null);

  // Test kết nối thủ công (nhập IP/port trực tiếp)
  const [tcIp, setTcIp] = useState('');
  const [tcProtocol, setTcProtocol] = useState('plc_s7');
  const [tcPort, setTcPort] = useState(102);
  const [isTesting, setIsTesting] = useState(false);
  const [tcResult, setTcResult] = useState<any | null>(null);

  // States cho cấu hình quy tắc nhanh tại thiết bị
  const [selectedRulesDevice, setSelectedRulesDevice] = useState<Device | null>(null);
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [deviceRules, setDeviceRules] = useState<Rule[]>([]);
  const [isEditingRule, setIsEditingRule] = useState(false);
  const [ruleEditingId, setRuleEditingId] = useState<string | null>(null);
  const [pointOptions, setPointOptions] = useState<any[]>(CABINET_FALLBACK_POINTS);
  const [isSavingRule, setIsSavingRule] = useState(false);
  const [ruleSaveError, setRuleSaveError] = useState<string>('');
  const [stationMenuOpen, setStationMenuOpen] = useState(false);
  const [stationMenuPos, setStationMenuPos] = useState({ top: 0, left: 0, width: 260 });
  const stationBtnRef = useRef<HTMLButtonElement>(null);

  const [ruleFormData, setRuleFormData] = useState({
    name: '',
    ruleSet: '',
    point: 'P1',
    op: '>=',
    preAlarm: '',
    alarm: '',
    doAlert: true,
    doHealth: false,
    doMaintenance: false,
    penalty: 10,
    maintType: 'inspection',
    maintDays: 30
  });

  const loadRulesForDevice = async (dev: Device) => {
    setRulesLoading(true);
    try {
      const allRules = await stationApi.getRules();
      const devId = dev.id.toLowerCase();
      const filtered = allRules.filter(r => (r.deviceId ?? '').toLowerCase() === devId);
      setDeviceRules(filtered);

      const buildOptions = (points: any[]) => {
        const seen = new Set<string>();
        return points
          .filter(p => {
            const pid = String(p?.pointId ?? p?.id ?? '').trim();
            if (!pid || seen.has(pid)) return false;
            seen.add(pid);
            return true;
          })
          .map(p => {
            const pid = String(p.pointId ?? p.id ?? '').trim();
            const name = String(p.name ?? p.label ?? p.tagName ?? TEMP_LABELS[pid] ?? CAM_POINT_LABELS[pid] ?? pid.replace(/_/g, ' '));
            const unit = p.unit != null ? String(p.unit) : '';
            return { value: pid, label: unit ? `${name} (${unit})` : name };
          });
      };

      const cfg = dev.config || {};
      const cabinetPoints = isCabinetLikeDevice(dev.type, cfg)
        ? (Array.isArray(cfg.points) ? cfg.points : Array.isArray(cfg.cabinet_points) ? cfg.cabinet_points : [])
        : [];

      if (cabinetPoints.length > 0) {
        const options = buildOptions(cabinetPoints);
        setPointOptions(options);
        if (!isEditingRule && options[0]?.value) {
          setRuleFormData(prev => ({ ...prev, point: options[0].value }));
        }
        return;
      }

      const firstId = stationId || await stationApi.getFirstStationId();
      if (firstId) {
        const pts = await stationApi.getLatestPoints(firstId).catch(() => []);
        const scopedPoints = pts.filter(p => String(p.deviceId ?? '').toLowerCase() === dev.id.toLowerCase());

        if (scopedPoints.length > 0) {
          const options = buildOptions(scopedPoints);
          setPointOptions(options);
          if (!isEditingRule && options[0]?.value) {
            setRuleFormData(prev => ({ ...prev, point: options[0].value }));
          }
          return;
        }
      }

      const fallback = isCabinetLikeDevice(dev.type, cfg) ? CABINET_FALLBACK_POINTS : dev.type.startsWith('camera') ? CAMERA_FALLBACK_POINTS : GENERIC_FALLBACK_POINTS;
      setPointOptions(fallback);
      if (!isEditingRule && fallback[0]?.value) {
        setRuleFormData(prev => ({ ...prev, point: fallback[0].value }));
      }
    } catch (e) {
      console.error('Lỗi khi tải quy tắc:', e);
    } finally {
      setRulesLoading(false);
    }
  };

  const handleOpenRulesModal = (dev: Device) => {
    setSelectedRulesDevice(dev);
    setIsRulesModalOpen(true);
    setIsEditingRule(false);
    setRuleEditingId(null);
    loadRulesForDevice(dev);
  };

  const parseCondition = (json: string): any => {
    try { return JSON.parse(json); } catch { return { point: '?', op: '>=', value: 0 }; }
  };

  const parseActions = (actionsJson: string): any => {
    try {
      const arr: any[] = JSON.parse(actionsJson);
      const healthA = arr.find(a => a.type === 'health');
      const alertA = arr.find(a => a.type === 'alert' || !a.type);
      const maintA = arr.find(a => a.type === 'maintenance');
      return {
        doHealth: !!healthA, penalty: healthA?.penalty ?? 10,
        doAlert: !!alertA, level: alertA?.level ?? (alertA === undefined ? 'warning' : 'hybrid'),
        doMaintenance: !!maintA, maintType: maintA?.taskType ?? 'inspection', maintDays: maintA?.scheduledInDays ?? 30,
      };
    } catch {
      return { doHealth: false, penalty: 10, doAlert: true, level: 'warning', doMaintenance: false, maintType: 'inspection', maintDays: 30 };
    }
  };

  const handleToggleRule = async (id: string, currentEnabled: boolean) => {
    try {
      await stationApi.toggleRule(id);
      setDeviceRules(deviceRules.map(r => r.id === id ? { ...r, enabled: !currentEnabled } : r));
    } catch (e) {
      alert('Không thể thay đổi trạng thái: ' + e);
    }
  };

  const handleDeleteRule = async (id: string) => {
    if (!await confirmDialog({
      title: 'Xóa quy tắc',
      message: 'Xóa quy tắc này?',
      confirmText: 'Xóa',
      cancelText: 'Hủy',
      danger: true,
    })) return;
    try {
      await stationApi.deleteRule(id);
      if (selectedRulesDevice) loadRulesForDevice(selectedRulesDevice);
    } catch (e) {
      alert('Không thể xóa quy tắc: ' + e);
    }
  };

  const handleSaveRule = async () => {
    if (!selectedRulesDevice) return;
    if (isSavingRule) return;
    setRuleSaveError('');
    const { name, point, op, preAlarm, alarm, doAlert, doHealth, doMaintenance, penalty, maintType, maintDays, ruleSet } = ruleFormData;
    if (!name) { alert('Vui lòng nhập tên quy tắc'); return; }
    
    const preA = preAlarm === '' ? null : parseFloat(preAlarm);
    const alA = alarm === '' ? null : parseFloat(alarm);

    if (preA === null && alA === null) { alert('Vui lòng cấu hình ít nhất 1 ngưỡng cảnh báo hoặc nguy hiểm'); return; }
    if (!doAlert && !doHealth && !doMaintenance) { alert('Vui lòng chọn ít nhất 1 hành động'); return; }

    const condition = JSON.stringify({ type: 'analog', point, op, pre_alarm: preA, alarm: alA });
    
    const actionList: any[] = [];
    if (doAlert) actionList.push({ type: 'alert', level: (alA !== null && preA !== null) ? 'hybrid' : (alA !== null ? 'alarm' : 'warning') });
    if (doHealth) actionList.push({ type: 'health', penalty });
    if (doMaintenance) actionList.push({ type: 'maintenance', taskType: maintType, scheduledInDays: maintDays });

    const actions = JSON.stringify(actionList);

    setIsSavingRule(true);
    try {
      const resolvedStationId = selectedRulesDevice.stationId || stationId || '';
      let savedRule: Rule;
      if (ruleEditingId) {
        savedRule = await stationApi.updateRule(ruleEditingId, { name, ruleSet: ruleSet || undefined, condition, actions, stationId: resolvedStationId, deviceId: selectedRulesDevice.id });
      } else {
        savedRule = await stationApi.createRule({ name, ruleSet: ruleSet || undefined, condition, actions, enabled: true, stationId: resolvedStationId, deviceId: selectedRulesDevice.id });
      }
      setDeviceRules(prev => {
        const next = prev.filter(r => r.id !== savedRule.id);
        return [savedRule, ...next];
      });
      loadRulesForDevice(selectedRulesDevice).catch(err => {
        console.error('[Rules] Background reload failed:', err);
      });
      setIsEditingRule(false);
      setRuleEditingId(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRuleSaveError(msg || 'Không thể lưu quy tắc');
      alert(`Không thể lưu quy tắc: ${msg}`);
      console.error('[Rules] Save failed:', e);
    } finally {
      setIsSavingRule(false);
    }
  };

  const handleOpenAddRule = () => {
    setRuleEditingId(null);
    setRuleSaveError('');
    const defaultPoint = pointOptions[0]?.value || 'P1';
    setRuleFormData({
      name: '',
      ruleSet: 'Mặc định',
      point: defaultPoint,
      op: '>=',
      preAlarm: '',
      alarm: '',
      doAlert: true,
      doHealth: false,
      doMaintenance: false,
      penalty: 10,
      maintType: 'inspection',
      maintDays: 30
    });
    setIsEditingRule(true);
  };

  const handleOpenEditRule = (r: Rule) => {
    setRuleEditingId(r.id);
    setRuleSaveError('');
    const cond = parseCondition(r.condition);
    const actions = parseActions(r.actions);
    setRuleFormData({
      name: r.name,
      ruleSet: r.ruleSet || '',
      point: cond.point,
      op: cond.op || '>=',
      preAlarm: cond.pre_alarm ?? cond.value ?? '',
      alarm: cond.alarm ?? '',
      doAlert: actions.doAlert,
      doHealth: actions.doHealth,
      doMaintenance: actions.doMaintenance,
      penalty: actions.penalty,
      maintType: actions.maintType,
      maintDays: actions.maintDays
    });
    setIsEditingRule(true);
  };

  useEffect(() => {
    loadDevices();
  }, []);

  useEffect(() => {
    if (!stationId || loading) return;
    const shouldOpenFromQuery = searchParams.get('action') === 'new';
    const shouldOpenFromProp = initialAction === 'new';
    if (!shouldOpenFromQuery && !shouldOpenFromProp) return;

    openDeviceModal();

    if (shouldOpenFromQuery) {
      const next = new URLSearchParams(searchParams);
      next.delete('action');
      setSearchParams(next, { replace: true });
    }

    if (shouldOpenFromProp) {
      onInitialActionHandled?.();
    }
  }, [stationId, loading, searchParams, setSearchParams, initialAction, onInitialActionHandled]);

  /** Tải danh sách thiết bị từ trạm đầu tiên và cập nhật state. */
  const loadDevices = async (preferredStationId?: string | null) => {
    setLoading(true);
    try {
      const stationList = await useStationStore.getState().fetch().catch(() => []);
      const savedStationId = localStorage.getItem('selected_station_id');
      const drillStationId = localStorage.getItem(MULTISITE_DRILL_STATION_KEY);
      
      const isValidSaved = savedStationId && stationList.some((s: any) => s.id === savedStationId);
      const validSavedId = isValidSaved ? savedStationId : null;

      const fallbackStationId = preferredStationId || viewingStationId || drillStationId || validSavedId || stationList[0]?.id || await stationApi.getFirstStationId();
      const id = preferredStationId || fallbackStationId;
      setStationId(id);
      if (id) {
        localStorage.setItem('selected_station_id', id);
        const data = await stationApi.getDevices(id);
        setDevices(data);
      } else {
        setDevices([]);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  /** Kiểm tra kết nối tới thiết bị và hiển thị kết quả latency qua alert. */
  const handleTestDevice = async (id: string) => {
    try {
      const res = await stationApi.testConnection(id);
      alert(res.success ? `Kết nối OK — ${res.latencyMs}ms` : `${res.message}`);
    } catch {
      alert('Không thể test kết nối');
    }
  };

  /** Xóa thiết bị sau khi xác nhận từ người dùng và cập nhật danh sách. */
  const handleDelete = async (d: Device) => {
    const isCamera = d.type.startsWith('camera');
    if (!await confirmDialog({
      title: 'Xóa thiết bị',
      message: `Xóa thiết bị "${d.name}"?${isCamera ? '\\nStream go2rtc cũng sẽ bị xóa.' : ''}`,
      confirmText: 'Xóa thiết bị',
      danger: true,
    })) return;

    try {
      await stationApi.deleteDevice(d.id);
      setDevices(prev => prev.filter(x => x.id !== d.id));
      alert('Đã xóa thiết bị');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Xóa thất bại: ${msg}`);
      console.error('[DeviceManagement] Delete failed:', e);
    }
  };

  /** Mở modal thêm hoặc sửa thiết bị, nạp dữ liệu hiện tại vào form nếu sửa. */
  const openDeviceModal = (d?: Device) => {
    setEditingId(d?.id ?? null);
    setTestConnResult({ show: false });
    setShowPassword(false);
    setCabinetImportFile(null);
    if (d) {
      const cfg = d.config || {};
      const cabinetPoints = isCabinetLikeDevice(d.type, cfg)
        ? (Array.isArray(cfg.points) ? cfg.points : Array.isArray(cfg.cabinet_points) ? cfg.cabinet_points : [])
        : [];
      setFormData({
        name: d.name, type: isCabinetLikeDevice(d.type, cfg) ? 'cabinet' : d.type, ip: cfg.ip || '',
        rack: cfg.rack ?? 0, slot: cfg.slot ?? 1, db: cfg.db ?? 32, length: cfg.length ?? 10,
        username: cfg.username || 'admin', password: cfg.password || '',
        rtspPath: cfg.rtsp_path || '', go2rtcId: cfg.go2rtc_id || '',
        rtspOptical: cfg.rtsp_optical || '', go2rtcOptical: cfg.go2rtc_optical || '',
        rtspThermal: cfg.rtsp_thermal || '', go2rtcThermal: cfg.go2rtc_thermal || '',
        cabinetId: cfg.cabinetId || '',
        port: cfg.port ?? 502, unitId: cfg.unit_id ?? 1,
        pollEnabled: cfg.poll_enabled ?? cabinetPoints.length > 0,
        enableHealthScore: cfg.enableHealthScore ?? false
      });
      if (isCabinetLikeDevice(d.type, cfg)) {
        setCabinetPointsJson(cabinetPoints.length > 0
          ? JSON.stringify(cabinetPoints, null, 2)
          : '');
      } else {
        setCabinetPointsJson('');
      }
    } else {
      setFormData({
        name: '', type: 'camera_cctv', ip: '',
        rack: 0, slot: 1, db: 32, length: 10,
        username: 'admin', password: '',
        rtspPath: '', go2rtcId: '',
        rtspOptical: '', go2rtcOptical: '',
        rtspThermal: '', go2rtcThermal: '',
        cabinetId: '',
        port: 502, unitId: 1,
        pollEnabled: false,
        enableHealthScore: false
      });
      setCabinetPointsJson('');
    }
    setIsDeviceModalOpen(true);
  };

  const validateCabinetForm = (requireFile: boolean) => {
    if (formData.type !== 'plc_s7') return null;

    const missing: string[] = [];
    if (!formData.name.trim()) missing.push('tên');
    if (!formData.ip.trim()) missing.push('IP');
    if (!formData.username.trim()) missing.push('user');
    if (!formData.password.trim()) missing.push('mật khẩu');
    if (requireFile && !cabinetImportFile) missing.push('file import');

    if (missing.length === 0) return null;
    return `Thiếu ${missing.join(', ')}.`;
  };

  /** Lưu thiết bị (tạo mới hoặc cập nhật) với cấu hình phù hợp từng loại. */
  const saveDevice = async () => {
    if (!formData.name) { alert('Vui lòng nhập tên thiết bị'); return; }
    setIsSaving(true);
    try {
      const configObj: any = { ip: formData.ip };
      let protocol = 'modbus';
      
      if (formData.type === 'plc_s7') {
        protocol = 'snap7';
        Object.assign(configObj, { rack: formData.rack, slot: formData.slot, db: formData.db, offset: 0, length: formData.length, enableHealthScore: formData.enableHealthScore });
      } else if (formData.type === 'camera_dual') {
        protocol = 'rtsp';
        const gOptical = formData.go2rtcOptical.trim() || `cam_${formData.ip.replace(/\./g, '_')}_optical`;
        const gThermal = formData.go2rtcThermal.trim() || `cam_${formData.ip.replace(/\./g, '_')}_thermal`;
        Object.assign(configObj, {
          rtsp_optical: formData.rtspOptical.trim(), go2rtc_optical: gOptical,
          rtsp_thermal: formData.rtspThermal.trim(), go2rtc_thermal: gThermal,
          username: formData.username, password: formData.password,
        });
      } else if (formData.type === 'camera_thermal') {
        protocol = 'rtsp';
        const gThermal = formData.go2rtcThermal.trim() || `cam_${formData.ip.replace(/\./g, '_')}_thermal`;
        Object.assign(configObj, {
          rtsp_thermal: formData.rtspThermal.trim(), go2rtc_thermal: gThermal,
          username: formData.username, password: formData.password,
        });
      } else if (formData.type.startsWith('camera')) {
        protocol = 'rtsp';
        let rp = formData.rtspPath.trim();
        if (rp && !rp.startsWith('/')) rp = '/' + rp;
        const gid = formData.go2rtcId.trim() || `camera_${formData.ip.replace(/\./g, '_')}_${formData.type.replace('camera_', '')}`;
        Object.assign(configObj, { rtsp_path: rp, go2rtc_id: gid, username: formData.username, password: formData.password });
      } else if (formData.type === 'modbus_tcp') {
        Object.assign(configObj, { port: formData.port, unit_id: formData.unitId, username: formData.username, password: formData.password });
      }

      if (formData.type === 'plc_s7' && cabinetImportFile) {
        const trimmedPoints = cabinetPointsJson.trim();
        const points = trimmedPoints ? parseCabinetPointsJson(trimmedPoints) : [];
        Object.assign(configObj, {
          cabinet_code: formData.name.trim(),
          points,
          poll_enabled: trimmedPoints.length > 0 || formData.pollEnabled,
        });
      }

      const configStr = JSON.stringify(configObj);

      if (editingId) {
        await stationApi.updateDevice(editingId, { name: formData.name, config: configStr });
      } else {
        await stationApi.createDevice({ stationId: stationId!, name: formData.name, type: formData.type, protocol, config: configStr });
      }
      setIsDeviceModalOpen(false);
      loadDevices();
      showToast(editingId ? 'Cập nhật thiết bị thành công' : 'Thêm thiết bị thành công', 'success');
    } catch (e: any) {
      alert(`Lỗi: ${e.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  /** Kiểm tra kết nối tới thiết bị đang chỉnh sửa và hiển thị kết quả trong modal. */
  const testModalConn = async () => {
    setTestConnResult({ show: true, msg: 'Đang kiểm tra...' });
    try {
      const configObj: any = { ip: formData.ip };
      let protocol = 'rtsp';
      
      if (formData.type === 'plc_s7') {
        protocol = 'snap7';
        Object.assign(configObj, { rack: formData.rack, slot: formData.slot, db: formData.db, length: formData.length });
      } else if (formData.type === 'camera_dual' || formData.type === 'camera_thermal' || formData.type.startsWith('camera')) {
        protocol = 'rtsp';
        let pwd = formData.password;
        if ((pwd === '***' || pwd === '...') && editingId) {
          const creds = await stationApi.getCredentials(editingId);
          pwd = creds.password;
        }
        Object.assign(configObj, { username: formData.username, password: pwd });
      } else if (formData.type === 'modbus_tcp') {
        protocol = 'modbus';
        Object.assign(configObj, { port: formData.port, unit_id: formData.unitId, username: formData.username, password: formData.password });
      }

      const res = await stationApi.testProtocolConnection(formData.ip, formData.port || 102, protocol, JSON.stringify(configObj));
      setTestConnResult({ show: true, success: res.success, msg: res.success ? `Kết nối thành công — ${res.latencyMs}ms` : res.message, latency: res.latencyMs });
    } catch (err: any) {
      setTestConnResult({ show: true, success: false, msg: `Lỗi: ${err.message || 'Lỗi kết nối'}` });
    }
  };

  // Discovery functions
  /** Quét dải IP trong subnet để tìm thiết bị online. */
  const runLanScan = async () => {
    setIsScanning(true);
    setScanResults(null);
    try {
      setScanResults(await stationApi.scanLan(scanSubnet));
    } catch (err: any) {
      alert(`Lỗi quét LAN: ${err.message || err}`);
    } finally {
      setIsScanning(false);
    }
  };

  /** Gửi WS-Discovery multicast để tìm camera ONVIF trong mạng. */
  const runOnvifScan = async () => {
    setIsOnvifScanning(true);
    setOnvifResults(null);
    try {
      setOnvifResults(await stationApi.discoverOnvif());
    } catch (err: any) {
      alert(`Lỗi tìm ONVIF: ${err.message || err}`);
    } finally {
      setIsOnvifScanning(false);
    }
  };

  /** Kiểm tra kết nối thủ công tới IP/port với giao thức được chọn. */
  const runTestConn = async () => {
    if (!tcIp) { alert('Nhập địa chỉ IP'); return; }
    setIsTesting(true);
    setTcResult(null);
    try {
      setTcResult(await stationApi.testProtocolConnection(tcIp, tcPort, tcProtocol));
    } catch {
      alert('Lỗi test kết nối');
    } finally {
      setIsTesting(false);
    }
  };

  const handleImportCabinetFromForm = async () => {
    if (!stationId) {
      alert('Chưa chọn trạm');
      return;
    }
    if (!cabinetImportFile) {
      alert('Vui lòng chọn file CSV hoặc Excel cho tủ');
      return;
    }
    if (!formData.name.trim()) {
      alert('Vui lòng nhập tên tủ');
      return;
    }
    const cabinetError = validateCabinetForm(true);
    if (cabinetError) {
      alert(cabinetError);
      return;
    }

    setIsSaving(true);
    try {
      const result = await stationApi.importCabinetTemplate({
        stationId,
        ip: formData.ip.trim(),
        cabinetName: formData.name.trim(),
        file: cabinetImportFile,
        rack: formData.rack,
        slot: formData.slot,
        db: formData.db,
      });
      setIsDeviceModalOpen(false);
      setCabinetImportFile(null);
      loadDevices();
      alert(result.message || `Thêm thành công ${result.totalGroups} tủ`);
    } catch (err: any) {
      alert(`Import thất bại: ${err.message || err}`);
    } finally {
      setIsSaving(false);
    }
  };

  const online = devices.filter(d => d.status === 'online').length;
  const requiresStationSelection = false;


  return (
    <div className="admin-page-container">

      {/* TOOLBAR */}
      {roiTab === 3 ? (
        <div className="page-toolbar-row">
          <div className="page-title-cell" style={{ alignItems: 'center' }}>
            <button
              className="btn-industrial btn-sm btn-back"
              onClick={() => { setRoiTab(0); setSelectedRoiDevice(null); }}
              style={{
                width: 30,
                height: 30,
                padding: 0,
                borderColor: 'var(--admin-border)',
                background: 'var(--admin-layer-2)',
                color: 'var(--admin-text-muted)',
                flexShrink: 0,
                alignSelf: 'center'
              }}
            >
              ←
            </button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <div style={{ fontSize: '.6rem', fontWeight: 800, letterSpacing: '.08em', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>
                CẤU HÌNH NHIỆT
              </div>
              <h2 style={{ fontSize: '1rem', margin: 0, fontWeight: 800, color: 'var(--admin-text)' }}>
                {selectedRoiDevice?.name || '---'}
              </h2>
            </div>
          </div>
        </div>
      ) : roiTab === 4 ? (
        <div className="page-toolbar-row">
          <div className="page-title-cell" style={{ alignItems: 'center' }}>
            <button
              className="btn-industrial btn-sm btn-back"
              onClick={() => { setRoiTab(0); setSelectedFireDevice(null); }}
              style={{
                width: 30,
                height: 30,
                padding: 0,
                borderColor: 'var(--admin-border)',
                background: 'var(--admin-layer-2)',
                color: 'var(--admin-text-muted)',
                flexShrink: 0,
                alignSelf: 'center'
              }}
            >
              ←
            </button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <div style={{ fontSize: '.6rem', fontWeight: 800, letterSpacing: '.08em', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>
                CẤU HÌNH CẢNH BÁO CHÁY
              </div>
              <h2 style={{ fontSize: '1rem', margin: 0, fontWeight: 800, color: 'var(--admin-text)' }}>
                {selectedFireDevice?.name || '---'}
              </h2>
            </div>
          </div>
          <div className="page-toolbar-group" style={{ justifyContent: 'flex-end' }}>
            <div className="page-toolbar-cell" style={{ height: 30, padding: '0 12px', background: 'var(--admin-layer-1)', border: '1px solid var(--admin-border)' }}>
              <span style={{ fontSize: '.64rem', fontWeight: 800, color: 'var(--admin-danger)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                Cảnh báo cháy
              </span>
            </div>
          </div>
        </div>
      ) : roiTab === 2 ? (
        <div className="page-toolbar-row">
          <div className="page-title-cell" style={{ alignItems: 'center' }}>
            <button
              className="btn-industrial btn-sm btn-back"
              onClick={() => { setRoiTab(0); setSelectedPdDevice(null); }}
              style={{
                width: 30,
                height: 30,
                padding: 0,
                borderColor: 'var(--admin-border)',
                background: 'var(--admin-layer-2)',
                color: 'var(--admin-text-muted)',
                flexShrink: 0,
                alignSelf: 'center'
              }}
            >
              ←
            </button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <div style={{ fontSize: '.6rem', fontWeight: 800, letterSpacing: '.08em', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>
                VẼ VÙNG PD
              </div>
              <h2 style={{ fontSize: '1rem', margin: 0, fontWeight: 800, color: 'var(--admin-text)' }}>
                {selectedPdDevice?.name || '---'}
              </h2>
            </div>
          </div>
          <div className="page-toolbar-group" style={{ justifyContent: 'flex-end' }}>
            <div className="page-toolbar-cell" style={{ height: 30, padding: '0 12px', background: 'var(--admin-layer-1)', border: '1px solid var(--admin-border)' }}>
              <span style={{ fontSize: '.64rem', fontWeight: 800, color: 'var(--admin-accent)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                Thiết lập vùng
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="page-toolbar-row">
          <div className="page-title-cell">
            <h2>QUẢN LÝ THIẾT BỊ</h2>
          </div>
          <div className="page-toolbar-group">
            {/* Status Indicators */}
            <div className="page-toolbar-cell" style={{ height: 28 }}>
              <span style={{ color: 'var(--admin-success)', fontWeight: 800, fontSize: '.75rem' }}>🟢 {online} ONLINE</span>
              <span style={{ color: 'var(--admin-text-muted)', opacity: 0.3, margin: '0 4px' }}>|</span>
              <span style={{ color: 'var(--admin-danger)', fontWeight: 800, fontSize: '.75rem' }}>{devices.length - online} OFFLINE</span>
            </div>
  
            {/* Action Buttons */}
            <button 
              className="btn-industrial btn-primary" 
              disabled={requiresStationSelection}
              onClick={() => openDeviceModal()}
              style={requiresStationSelection ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
            >
              + THÊM THIẾT BỊ
            </button>
            <button 
              className="btn-industrial" 
              disabled={requiresStationSelection}
              onClick={() => setIsScanModalOpen(true)}
              style={requiresStationSelection ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
            >
              QUÉT LAN
            </button>
          </div>
        </div>
      )}

      {/* ═══ TAB 0: ALL DEVICES ═══ */}
      {roiTab === 0 && (
        <div className="admin-card" style={{ padding: 0, overflow: 'auto', flex: 1 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Tên thiết bị</th>
                <th>Loại</th>
                <th>IP / Địa chỉ</th>
                <th>Trạng thái</th>
                <th>Ngày thêm</th>
                <th style={{ width: 80 }}>Hành động</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: 30, color: 'var(--admin-text-muted)' }}>⏳ Đang tải...</td></tr>
              ) : devices.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: 30, color: 'var(--admin-text-muted)' }}>Chưa có thiết bị nào.</td></tr>
              ) : (
                devices.map(d => (
                  <tr key={d.id}>
                    <td>
                      <div className="device-table-cell device-table-cell--name">
                        <b>{d.name}</b>
                      </div>
                    </td>
                    <td>
                      <div className="device-table-cell device-table-cell--type">
                        {TYPE_LABELS[d.type] || d.type}
                      </div>
                    </td>
                    <td>
                      <div className="device-table-cell device-table-cell--ip">
                        <code style={{ fontSize: '.8rem' }}>{d.config?.ip || '---'}</code>
                        {d.type.startsWith('camera') && d.config?.go2rtc_id && <><br/><small style={{ opacity: .5 }}>go2rtc: {d.config.go2rtc_id}</small></>}
                        {d.type.startsWith('camera') && d.config?.go2rtc_thermal && <><br/><small style={{ opacity: .5, color: 'var(--admin-danger)' }}>thermal: {d.config.go2rtc_thermal}</small></>}
                        {d.type === 'camera_pd' && <><br/><small style={{ opacity: .7, color: 'var(--admin-accent)', fontWeight: 700 }}>PD band 25–49 kHz</small></>}
                        {isCabinetLikeDevice(d.type, d.config || {}) && <><br/><small style={{ opacity: .5 }}>Tủ điện cảm biến (đọc từ file import)</small></>}
                      </div>
                    </td>
                    <td>
                      <div className="device-table-cell device-table-cell--status">
                        <span className="status-dot" style={{ background: d.status === 'online' ? 'var(--admin-success)' : 'var(--admin-danger)' }}></span>
                        {d.status === 'online' ? ' Online' : ' Offline'}
                      </div>
                    </td>
                    <td>
                      <div className="device-table-cell device-table-cell--date" style={{ fontSize: '.8rem', opacity: .7 }}>
                        {new Date(d.createdAt).toLocaleDateString('vi-VN')}
                      </div>
                    </td>

                    <td>
                      <div className="device-table-cell device-table-cell--actions">
                        <ActionDropdown>
                          <ActionDropdownItem icon={<Settings size={14} />} label="Sửa thiết bị" onClick={() => openDeviceModal(d)} />
                          <ActionDropdownItem icon={<LayoutList size={14} />} label="Kiểm tra kết nối" onClick={() => handleTestDevice(d.id)} />
                          <ActionDropdownItem icon={<ShieldAlert size={14} />} label="Quy tắc giám sát" onClick={() => handleOpenRulesModal(d)} />
                          {(d.type === 'camera_thermal' || d.type === 'camera_dual') && (
                            <ActionDropdownItem icon={<Thermometer size={14} />} label="Cấu hình nhiệt" onClick={() => { setSelectedRoiDevice(d as CameraDevice); setRoiTab(3); }} />
                          )}
                          {(d.type === 'camera_thermal' || d.type === 'camera_dual') && (
                            <ActionDropdownItem icon={<Flame size={14} />} label="Cấu hình cảnh báo cháy" onClick={() => { setSelectedFireDevice(d as CameraDevice); setRoiTab(4); }} />
                          )}
                          {d.type === 'camera_pd' && (
                            <ActionDropdownItem icon={<Zap size={14} />} label="Vẽ vùng PD" onClick={() => { setSelectedPdDevice(d as CameraDevice); setRoiTab(2); }} />
                          )}
                          <ActionDropdownItem icon={<Trash2 size={14} />} label="Xóa thiết bị" danger onClick={() => handleDelete(d)} />
                        </ActionDropdown>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══ TAB 2: CẤU HÌNH VÙNG PD ═══ */}
      {roiTab === 2 && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>


          <div style={{ flex: 1, padding: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {selectedPdDevice ? (
              <PdRegionTab 
                cameras={devices.filter(d => d.type.startsWith('camera')) as CameraDevice[]}
                initialCamera={selectedPdDevice}
                onBack={() => { setRoiTab(0); setSelectedPdDevice(null); }}
              />
            ) : (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-muted)' }}>
                Vui lòng chọn một thiết bị PD từ danh sách.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ TAB 3: CẤU HÌNH ĐIỂM ĐO NHIỆT ĐỘ ═══ */}
      {roiTab === 3 && selectedRoiDevice && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <ThermalConfigTab
            device={selectedRoiDevice}
            onBack={() => { setRoiTab(0); setSelectedRoiDevice(null); }}
          />
        </div>
      )}

      {/* ═══ TAB 4: CẤU HÌNH CẢNH BÁO CHÁY ═══ */}
      {roiTab === 4 && selectedFireDevice && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <FireAlarmConfigTab
            device={selectedFireDevice}
            onBack={() => { setRoiTab(0); setSelectedFireDevice(null); }}
          />
        </div>
      )}

      {/* DEVICE MODAL */}
      {isDeviceModalOpen && (
        <div className="modal-overlay active" onClick={(e) => { if (e.target === e.currentTarget) setIsDeviceModalOpen(false); }}>
          <div className="modal-content" style={{ maxWidth: 560 }}>
            <div className="modal-header" style={{ position: 'relative' }}>
              <h3
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  textAlign: 'center',
                  color: 'var(--admin-accent)',
                  margin: 0,
                  pointerEvents: 'none',
                }}
              >
                {editingId ? `Sửa: ${formData.name}` : 'Thêm thiết bị mới'}
              </h3>
              <button className="modal-close-btn" onClick={() => setIsDeviceModalOpen(false)} style={{ marginLeft: 'auto', position: 'relative', zIndex: 1 }}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: 0, background: 'var(--admin-layer-1)' }}>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                
                {/* A. GENERAL INFO */}
                <div style={{ background: 'var(--admin-border)', color: '#fff', padding: '6px 16px', fontSize: '.62rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '1px' }}>
                  A. Định danh thiết bị
                </div>
                <div style={{ padding: '15px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', alignItems: 'center', gap: 15 }}>
                    <label style={{ fontSize: '.68rem', fontWeight: 800, color: 'var(--admin-text-muted)', textAlign: 'right' }}>TÊN HIỂN THỊ</label>
                    <input type="text" className="form-input" style={{ borderRadius: 0 }} placeholder="VD: Sensor Tủ 477" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', alignItems: 'center', gap: 15 }}>
                    <label style={{ fontSize: '.68rem', fontWeight: 800, color: 'var(--admin-text-muted)', textAlign: 'right' }}>PHÂN LOẠI</label>
                    <select className="form-select" style={{ borderRadius: 0 }} value={formData.type} onChange={e => setFormData({ ...formData, type: e.target.value })}>
                      <option value="camera_dual">Camera Dual-Stream (Nhiệt + Quang)</option>
                      <option value="camera_thermal">Camera Nhiệt (RTSP)</option>
                      <option value="camera_cctv">Camera CCTV thường (RTSP)</option>
                      <option value="camera_pd">Camera Phóng điện (RTSP)</option>
                      <option value="plc_s7">PLC S7-1200/1500</option>
                      <option value="modbus_tcp">Modbus TCP Device</option>
                    </select>
                  </div>
                </div>

                {/* B. CONNECTION */}
                <div style={{ background: 'var(--admin-border)', color: '#fff', padding: '6px 16px', fontSize: '.62rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '1px' }}>
                  B. Kết nối & Xác thực
                </div>
                <div style={{ padding: '15px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: '.6rem', fontWeight: 800, color: 'var(--admin-text-muted)' }}>ĐỊA CHỈ IP (HOST)</label>
                    <input type="text" className="form-input" style={{ borderRadius: 0 }} placeholder="192.168.10.152" value={formData.ip} onChange={e => setFormData({ ...formData, ip: e.target.value })} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: '.6rem', fontWeight: 800, color: 'var(--admin-text-muted)' }}>TÀI KHOẢN (USER)</label>
                    <input type="text" className="form-input" style={{ borderRadius: 0 }} value={formData.username} onChange={e => setFormData({ ...formData, username: e.target.value })} />
                  </div>
                  <div style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: '.6rem', fontWeight: 800, color: 'var(--admin-text-muted)' }}>MẬT KHẨU (PASSWORD)</label>
                    <div style={{ position: 'relative' }}>
                      <input type={showPassword ? 'text' : 'password'} className="form-input" style={{ borderRadius: 0, paddingRight: 35 }} value={formData.password} onChange={e => setFormData({ ...formData, password: e.target.value })} />
                      <button type="button" onClick={() => setShowPassword(!showPassword)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--admin-text-muted)' }}>
                        {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>

                  {formData.type === 'plc_s7' && (
                    <div style={{ gridColumn: 'span 2', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, border: '1px solid var(--admin-border)', padding: 10, background: 'rgba(0,0,0,0.1)' }}>
                      <div><label style={{ fontSize: '.55rem', display: 'block', marginBottom: 2 }}>RACK</label><input type="number" className="form-input" value={formData.rack} onChange={e => setFormData({ ...formData, rack: Number(e.target.value) })} /></div>
                      <div><label style={{ fontSize: '.55rem', display: 'block', marginBottom: 2 }}>SLOT</label><input type="number" className="form-input" value={formData.slot} onChange={e => setFormData({ ...formData, slot: Number(e.target.value) })} /></div>
                      <div><label style={{ fontSize: '.55rem', display: 'block', marginBottom: 2 }}>DB NO.</label><input type="number" className="form-input" value={formData.db} onChange={e => setFormData({ ...formData, db: Number(e.target.value) })} /></div>
                      <div><label style={{ fontSize: '.55rem', display: 'block', marginBottom: 2 }}>LEN</label><input type="number" className="form-input" value={formData.length} onChange={e => setFormData({ ...formData, length: Number(e.target.value) })} /></div>
                    </div>
                  )}

                  {formData.type === 'plc_s7' && (
                    <div style={{ gridColumn: 'span 2', border: '1px solid var(--admin-border)', padding: 10, background: 'rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={{ fontSize: '.62rem', fontWeight: 900, color: 'var(--admin-accent)', letterSpacing: '0.04em' }}>IMPORT FILE CSV / EXCEL</span>
                          <span style={{ fontSize: '.68rem', color: 'var(--admin-text-muted)', lineHeight: 1.45 }}>
                            PLC engineer chỉ cần gửi file bảng điểm. Hệ thống sẽ đọc `Name`, `Tagname`, `Type`, `DB address`, `Value`, `Note` và tự ghép thành `config.points`.
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn-industrial"
                          style={{ padding: '4px 10px', height: 28, fontSize: '.68rem', flexShrink: 0 }}
                          onClick={() => document.getElementById('cabinet-import-input')?.click()}
                        >
                          Chọn file
                        </button>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                        <div style={{ border: '1px solid var(--admin-border)', background: 'rgba(255,255,255,0.02)', padding: 8, minHeight: 76 }}>
                          <div style={{ fontSize: '.58rem', fontWeight: 800, color: 'var(--admin-warning)', marginBottom: 4 }}>1. Dòng tủ</div>
                          <div style={{ fontSize: '.68rem', color: 'var(--admin-text-muted)', lineHeight: 1.45 }}>Một dòng chỉ có `Name` sẽ được hiểu là tên tủ, ví dụ `TỦ_477`.</div>
                        </div>
                        <div style={{ border: '1px solid var(--admin-border)', background: 'rgba(255,255,255,0.02)', padding: 8, minHeight: 76 }}>
                          <div style={{ fontSize: '.58rem', fontWeight: 800, color: 'var(--admin-accent)', marginBottom: 4 }}>2. Dòng điểm</div>
                          <div style={{ fontSize: '.68rem', color: 'var(--admin-text-muted)', lineHeight: 1.45 }}>Dòng có `Tagname`, `Type`, `DB address` là một điểm đo. `DB32.DBD0` = DB32, offset 0.</div>
                        </div>
                        <div style={{ border: '1px solid var(--admin-border)', background: 'rgba(255,255,255,0.02)', padding: 8, minHeight: 76 }}>
                          <div style={{ fontSize: '.58rem', fontWeight: 800, color: 'var(--admin-success)', marginBottom: 4 }}>3. Worker PLC</div>
                          <div style={{ fontSize: '.68rem', color: 'var(--admin-text-muted)', lineHeight: 1.45 }}>PLC worker sẽ đọc `dbAddress` của từng điểm để lấy dữ liệu đúng vị trí trong DB.</div>
                        </div>
                      </div>

                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.68rem', color: 'var(--admin-text-muted)', fontWeight: 700 }}>
                        <input
                          type="checkbox"
                          checked={formData.pollEnabled}
                          onChange={e => setFormData({ ...formData, pollEnabled: e.target.checked })}
                          style={{ accentColor: 'var(--admin-accent)' }}
                        />
                        Đọc dữ liệu thật cho tủ này
                      </label>

                      <input
                        id="cabinet-import-input"
                        type="file"
                        accept=".csv,.xlsx,.xlsm"
                        style={{ display: 'none' }}
                        onChange={e => setCabinetImportFile(e.target.files?.[0] ?? null)}
                      />

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: 8, border: '1px dashed var(--admin-border)', background: 'rgba(255,255,255,0.02)' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ fontSize: '.68rem', fontWeight: 800, color: 'var(--admin-text)' }}>
                            {cabinetImportFile ? cabinetImportFile.name : 'Chưa chọn file import'}
                          </span>
                          <span style={{ fontSize: '.66rem', color: 'var(--admin-text-muted)' }}>
                            Khi bấm lưu, hệ thống sẽ import file này và tạo/cập nhật tủ theo tên đã nhập.
                            PLC/tủ cảm biến phải có đủ Tên, IP, User, Mật khẩu và file import hợp lệ.
                          </span>
                        </div>
                        {cabinetImportFile && (
                          <button
                            type="button"
                            className="btn-industrial"
                            style={{ padding: '4px 10px', height: 28, fontSize: '.68rem' }}
                            onClick={() => setCabinetImportFile(null)}
                          >
                            Bỏ file
                          </button>
                        )}
                      </div>

                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: '.68rem', color: 'var(--admin-text-muted)', lineHeight: 1.5 }}>
                        <span style={{ padding: '3px 8px', border: '1px solid var(--admin-border)', background: 'rgba(255,255,255,0.03)' }}>Hỗ trợ `csv`, `xlsx`, `xlsm`</span>
                        <span style={{ padding: '3px 8px', border: '1px solid var(--admin-border)', background: 'rgba(255,255,255,0.03)' }}>Có thể import nhiều tủ trong cùng 1 file</span>
                        <span style={{ padding: '3px 8px', border: '1px solid var(--admin-border)', background: 'rgba(255,255,255,0.03)' }}>DB mặc định lấy từ field `DB NO.` nếu file thiếu</span>
                      </div>
                    </div>
                  )}
                </div>

                {/* C. VIDEO STREAMS */}
                {formData.type.startsWith('camera') && (
                  <>
                    <div style={{ background: 'var(--admin-border)', color: '#fff', padding: '6px 16px', fontSize: '.62rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '1px' }}>
                      C. Cấu hình luồng truyền tải
                    </div>
                    <div style={{ padding: '15px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                      
                      {/* THERMAL */}
                      {(formData.type === 'camera_dual' || formData.type === 'camera_thermal') && (
                        <div style={{ border: '1px solid var(--admin-border)', padding: 10, background: 'rgba(0,0,0,0.1)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <span style={{ fontSize: '.62rem', fontWeight: 900, color: 'var(--admin-danger)' }}>🌡 LUỒNG NHIỆT (THERMAL)</span>
                            <select className="form-select" style={{ fontSize: 9, height: 18, width: 'auto', padding: '0 4px', border: 'none', background: 'var(--admin-layer-2)' }} onChange={e => e.target.value && setFormData({ ...formData, rtspThermal: e.target.value })}>
                              <option value="">Preset</option>
                              <option value="/Streaming/Channels/201">Hik Ch201</option>
                              <option value="/thermal/main">Generic</option>
                            </select>
                          </div>
                          <input type="text" className="form-input" style={{ fontSize: '.75rem', marginBottom: 6 }} placeholder="RTSP Path" value={formData.rtspThermal} onChange={e => setFormData({ ...formData, rtspThermal: e.target.value })} />
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: '.58rem', color: 'var(--admin-text-muted)' }}>STREAM ID:</span>
                            <input type="text" className="form-input" style={{ flex: 1, fontSize: '.7rem', height: 22, border: 'none', background: 'rgba(255,255,255,0.03)' }} value={formData.go2rtcThermal} onChange={e => setFormData({ ...formData, go2rtcThermal: e.target.value })} placeholder="Auto-generate" />
                          </div>
                        </div>
                      )}

                      {/* OPTICAL */}
                      {formData.type === 'camera_dual' && (
                        <div style={{ border: '1px solid var(--admin-border)', padding: 10, background: 'rgba(0,0,0,0.1)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <span style={{ fontSize: '.62rem', fontWeight: 900, color: 'var(--admin-accent)' }}>📷 LUỒNG QUANG HỌC (OPTICAL)</span>
                            <select className="form-select" style={{ fontSize: 9, height: 18, width: 'auto', padding: '0 4px', border: 'none', background: 'var(--admin-layer-2)' }} onChange={e => e.target.value && setFormData({ ...formData, rtspOptical: e.target.value })}>
                              <option value="">Preset</option>
                              <option value="/Streaming/Channels/101">Hik Ch101</option>
                              <option value="/live/main">Generic</option>
                            </select>
                          </div>
                          <input type="text" className="form-input" style={{ fontSize: '.75rem', marginBottom: 6 }} placeholder="RTSP Path" value={formData.rtspOptical} onChange={e => setFormData({ ...formData, rtspOptical: e.target.value })} />
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: '.58rem', color: 'var(--admin-text-muted)' }}>STREAM ID:</span>
                            <input type="text" className="form-input" style={{ flex: 1, fontSize: '.7rem', height: 22, border: 'none', background: 'rgba(255,255,255,0.03)' }} value={formData.go2rtcOptical} onChange={e => setFormData({ ...formData, go2rtcOptical: e.target.value })} placeholder="Auto-generate" />
                          </div>
                        </div>
                      )}

                      {/* OTHER CAM */}
                      {formData.type !== 'camera_dual' && formData.type !== 'camera_thermal' && formData.type.startsWith('camera') && (
                        <div style={{ border: '1px solid var(--admin-border)', padding: 10, background: 'rgba(0,0,0,0.1)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <span style={{ fontSize: '.62rem', fontWeight: 900 }}>🎥 RTSP STREAM</span>
                            <select className="form-select" style={{ fontSize: 9, height: 18, width: 'auto', padding: '0 4px', border: 'none', background: 'var(--admin-layer-2)' }} onChange={e => e.target.value && setFormData({ ...formData, rtspPath: e.target.value })}>
                              <option value="">Preset</option>
                              <option value="/Streaming/Channels/101">Hik Ch101</option>
                              <option value="/live/main">Generic</option>
                            </select>
                          </div>
                          <input type="text" className="form-input" style={{ fontSize: '.75rem', marginBottom: 6 }} value={formData.rtspPath} onChange={e => setFormData({ ...formData, rtspPath: e.target.value })} />
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: '.58rem', color: 'var(--admin-text-muted)' }}>STREAM ID:</span>
                            <input type="text" className="form-input" style={{ flex: 1, fontSize: '.7rem', height: 22, border: 'none', background: 'rgba(255,255,255,0.03)' }} value={formData.go2rtcId} onChange={e => setFormData({ ...formData, go2rtcId: e.target.value })} placeholder="Auto-generate" />
                          </div>
                        </div>
                      )}

                    </div>
                  </>
                )}

                {formData.type === 'modbus_tcp' && (
                  <div style={{ padding: '15px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15, background: 'rgba(0,0,0,0.1)', borderTop: '1px solid var(--admin-border)' }}>
                    <div><label style={{ fontSize: '.6rem' }}>PORT</label><input type="number" className="form-input" value={formData.port} onChange={e => setFormData({ ...formData, port: Number(e.target.value) })} /></div>
                    <div><label style={{ fontSize: '.6rem' }}>UNIT ID</label><input type="number" className="form-input" value={formData.unitId} onChange={e => setFormData({ ...formData, unitId: Number(e.target.value) })} /></div>
                  </div>
                )}
              </div>

              {testConnResult.show && (
                <div style={{ marginTop: 10, fontSize: '.85rem', padding: 8, background: testConnResult.success === undefined ? 'var(--admin-layer-2)' : testConnResult.success ? 'var(--admin-tag-success-bg)' : 'var(--admin-tag-danger-bg)', color: testConnResult.success === undefined ? 'var(--admin-text)' : testConnResult.success ? 'var(--admin-success)' : 'var(--admin-danger)', border: '1px solid var(--admin-border)' }}>
                  {testConnResult.msg}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn-industrial" onClick={testModalConn}>Test kết nối</button>
              <div style={{ flex: 1 }}></div>
              <button
                className="btn-industrial"
                onClick={() => {
                  setIsDeviceModalOpen(false);
                  setCabinetImportFile(null);
                }}
              >
                Hủy
              </button>
              <button
                className="btn-industrial btn-primary"
                onClick={formData.type === 'plc_s7' && cabinetImportFile ? handleImportCabinetFromForm : saveDevice}
                disabled={isSaving}
              >
                {isSaving
                  ? '⏳ Đang xử lý...'
                  : formData.type === 'plc_s7' && cabinetImportFile
                    ? 'Import và lưu'
                    : 'Lưu thiết bị'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SCAN MODAL */}
      {isScanModalOpen && (
        <div className="modal-overlay active" onClick={(e) => { if (e.target === e.currentTarget) setIsScanModalOpen(false); }}>
          <div className="modal-content" style={{ maxWidth: 680 }}>
            <div className="modal-header">
              <h3>Khám phá thiết bị</h3>
              <button className="modal-close-btn" onClick={() => setIsScanModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--admin-border)', marginBottom: 16 }}>
                {['Quét LAN', 'ONVIF', 'Test kết nối'].map((t, i) => (
                  <button key={i} className={`disc-tab ${i === scanTab ? 'disc-tab-active' : ''}`} onClick={() => setScanTab(i)} style={{ padding: '8px 16px', background: 'none', border: 'none', borderBottom: `2px solid ${i === scanTab ? 'var(--admin-accent)' : 'transparent'}`, color: i === scanTab ? 'var(--admin-accent)' : 'var(--admin-text)', opacity: i === scanTab ? 1 : 0.5, fontSize: '.8rem', fontWeight: 600, cursor: 'pointer' }}>
                    {t}
                  </button>
                ))}
              </div>

              {scanTab === 0 && (
                <div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                    <input type="text" className="form-input" value={scanSubnet} onChange={e => setScanSubnet(e.target.value)} placeholder="Subnet: 192.168.10" style={{ flex: 1 }} />
                    <button className="btn-industrial btn-primary" onClick={runLanScan} disabled={isScanning}>▶ Bắt đầu quét</button>
                  </div>
                  <div style={{ minHeight: 120, maxHeight: 280, overflowY: 'auto', background: 'var(--admin-layer-2)', border: '1px solid var(--admin-border)', padding: 12, fontSize: '.82rem' }}>
                    {isScanning ? <div style={{ color: 'var(--admin-text-muted)', textAlign: 'center' }}>⏳ Đang quét {scanSubnet}.1 → .254 ...</div> : 
                     scanResults === null ? <div style={{ color: 'var(--admin-text-muted)', textAlign: 'center' }}>Nhấn "Bắt đầu quét" để tìm thiết bị trong subnet</div> :
                     scanResults.length === 0 ? <div style={{ color: 'var(--admin-text-muted)', textAlign: 'center' }}>Không tìm thấy thiết bị nào</div> :
                     scanResults.map((f, i) => (
                       <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--admin-border)', gap: 8 }}>
                         <div style={{ flex: 1 }}>
                           <b style={{ color: 'var(--admin-text)' }}>{f.ip}</b>
                           <span style={{ marginLeft: 8, fontSize: '.75rem', color: f.protocol === 'hikvision' ? 'var(--admin-accent)' : 'var(--admin-text-muted)' }}>
                             {f.protocol === 'hikvision' ? '📷 Hikvision' : f.guessedType || f.protocol || 'Unknown'}
                           </span>
                           {f.protocol === 'hikvision' && f.deviceInfo && (
                             <span style={{ marginLeft: 6, fontSize: '.72rem', color: 'var(--admin-text-muted)' }}>{f.deviceInfo}</span>
                           )}
                           {f.protocol === 'hikvision' && f.hasThermal && (
                             <span style={{ marginLeft: 6, fontSize: '.7rem', background: 'var(--admin-tag-danger-bg)', color: 'var(--admin-danger)', padding: '1px 6px' }}>🌡 Nhiệt</span>
                           )}
                         </div>
                         <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                           {f.protocol === 'hikvision' && (
                             <button
                               className="btn-industrial btn-sm btn-primary"
                               onClick={() => setAutoConfigTarget({ ip: f.ip })}
                               title="Tự động tạo tất cả luồng cho camera này"
                             >Auto-thêm</button>
                           )}
                           <span style={{ fontSize: '.75rem', color: f.isOnline || f.isReachable ? 'var(--admin-success)' : 'var(--admin-danger)' }}>
                             {f.isOnline || f.isReachable ? '🟢' : '⚫'}
                           </span>
                         </div>
                       </div>
                     ))}
                  </div>
                </div>
              )}

              {scanTab === 1 && (
                <div>
                  <p style={{ fontSize: '.82rem', opacity: 0.7, marginBottom: 12, color: 'var(--admin-text)' }}>Gửi WS-Discovery multicast để tìm camera ONVIF trong cùng subnet.</p>
                  <button className="btn-industrial btn-primary" onClick={runOnvifScan} disabled={isOnvifScanning}>Tìm camera ONVIF</button>
                  <div style={{ marginTop: 12, minHeight: 100, maxHeight: 280, overflowY: 'auto', background: 'var(--admin-layer-2)', border: '1px solid var(--admin-border)', padding: 12, fontSize: '.82rem' }}>
                    {isOnvifScanning ? <div style={{ color: 'var(--admin-text-muted)', textAlign: 'center' }}>⏳ Đang tìm...</div> :
                     onvifResults === null ? <div style={{ color: 'var(--admin-text-muted)', textAlign: 'center' }}>Nhấn nút để tìm</div> :
                     onvifResults.length === 0 ? <div style={{ color: 'var(--admin-text-muted)', textAlign: 'center' }}>Không tìm thấy camera ONVIF</div> :
                     onvifResults.map((c, i) => (
                       <div key={i} style={{ padding: '10px 12px', borderBottom: '1px solid var(--admin-border)' }}>
                         <b style={{ color: 'var(--admin-text)' }}>{c.ip || c.address || 'N/A'}</b><span style={{ marginLeft: 8, fontSize: '.75rem', color: 'var(--admin-accent)', fontWeight: 'bold' }}>ONVIF</span>
                         {c.name && <div style={{ fontSize: '.75rem', color: 'var(--admin-text-muted)', marginTop: 2 }}>{c.name}</div>}
                       </div>
                     ))}
                  </div>
                </div>
              )}

              {scanTab === 2 && (
                <div>
                  <div className="form-grid-2" style={{ marginBottom: 12 }}>
                    <div className="form-group"><label>Địa chỉ IP</label><input type="text" className="form-input" value={tcIp} onChange={e => setTcIp(e.target.value)} placeholder="192.168.10.100" /></div>
                    <div className="form-group"><label>Giao thức</label><select className="form-select" value={tcProtocol} onChange={e => setTcProtocol(e.target.value)}><option value="plc_s7">PLC S7 (Snap7)</option><option value="modbus_tcp">Modbus TCP</option><option value="camera_rtsp">Camera RTSP</option><option value="onvif">ONVIF</option></select></div>
                    <div className="form-group"><label>Port</label><input type="number" className="form-input" value={tcPort} onChange={e => setTcPort(Number(e.target.value))} /></div>
                  </div>
                  <button className="btn-industrial btn-primary" onClick={runTestConn} disabled={isTesting}>Test kết nối</button>
                  <div style={{ marginTop: 12, minHeight: 80, background: 'var(--admin-layer-2)', border: '1px solid var(--admin-border)', padding: 12, fontSize: '.82rem', color: 'var(--admin-text-muted)' }}>
                    {isTesting ? '⏳ Đang test...' : tcResult === null ? 'Nhập thông tin và nhấn Test' : (
                       <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                          <b style={{ color: tcResult.success ? 'var(--admin-success)' : 'var(--admin-danger)' }}>{tcResult.success ? '🟢 Kết nối thành công' : '🔴 Kết nối thất bại'}</b>
                          {tcResult.latencyMs != null && <span style={{ fontSize: '.75rem', color: 'var(--admin-text-muted)' }}>{tcResult.latencyMs}ms</span>}
                        </div>
                        {tcResult.message && <div style={{ fontSize: '.8rem', color: 'var(--admin-text-muted)' }}>{tcResult.message}</div>}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* AUTO-CONFIGURE MODAL */}
      {autoConfigTarget && (
        <div className="modal-overlay active" onClick={(e) => { if (e.target === e.currentTarget) setAutoConfigTarget(null); }}>
          <div className="modal-content" style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h3>Auto-thêm camera Hikvision</h3>
              <button className="modal-close-btn" onClick={() => setAutoConfigTarget(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ marginBottom: 14, padding: '8px 12px', background: 'var(--admin-layer-2)', border: '1px solid var(--admin-border)', fontSize: '.8rem', color: 'var(--admin-text-muted)' }}>
                IP: <b style={{ color: 'var(--admin-text)' }}>{autoConfigTarget.ip}</b> — Hệ thống sẽ tự detect capabilities qua ISAPI và tạo đúng số bản ghi (quang học + nhiệt nếu có).
              </div>
              <div className="form-group">
                <label>Username</label>
                <input type="text" className="form-input" value={autoConfigCreds.username}
                  onChange={e => setAutoConfigCreds(p => ({ ...p, username: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Password</label>
                <input type="password" className="form-input" value={autoConfigCreds.password}
                  onChange={e => setAutoConfigCreds(p => ({ ...p, password: e.target.value }))} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-industrial" onClick={() => setAutoConfigTarget(null)}>Hủy</button>
              <button
                className="btn-industrial btn-primary"
                disabled={isAutoConfiguring}
                onClick={async () => {
                  if (!stationId) return;
                  setIsAutoConfiguring(true);
                  try {
                    const res = await stationApi.autoConfigure(
                      stationId, autoConfigTarget.ip,
                      autoConfigCreds.username, autoConfigCreds.password
                    );
                    const names = res.created.map((d: any) => d.name).join('\n');
                    alert(`Đã tạo ${res.created.length} thiết bị:\n${names}`);
                    setAutoConfigTarget(null);
                    loadDevices();
                  } catch (e: any) {
                    alert(`Lỗi: ${e.message}`);
                  } finally {
                    setIsAutoConfiguring(false);
                  }
                }}
              >{isAutoConfiguring ? '⏳ Đang xử lý...' : 'Tự động cấu hình'}</button>
            </div>
          </div>
        </div>
      )}
      {/* QUICK RULES CONFIGURATION MODAL */}
      {isRulesModalOpen && selectedRulesDevice && (
        <div className="modal-overlay active" onClick={(e) => { if (e.target === e.currentTarget) setIsRulesModalOpen(false); }} style={{ zIndex: 999 }}>
          <div className="modal-content" style={{ maxWidth: isEditingRule ? 560 : 700 }}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ShieldAlert size={20} style={{ color: 'var(--admin-accent)' }} />
                <h3 style={{ margin: 0 }}>Quy tắc giám sát: {selectedRulesDevice.name}</h3>
              </div>
              <button className="modal-close-btn" onClick={() => setIsRulesModalOpen(false)}>✕</button>
            </div>
            
            <div className="modal-body" style={{ padding: 20, background: 'var(--admin-layer-1)', maxHeight: '70vh', overflowY: 'auto' }}>
              {isEditingRule ? (
                /* CHẾ ĐỘ THÊM/SỬA RULE */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {ruleSaveError && (
                    <div style={{ padding: '8px 10px', border: '1px solid rgba(239, 68, 68, 0.35)', background: 'rgba(239, 68, 68, 0.08)', color: 'var(--admin-danger)', fontSize: '.75rem' }}>
                      {ruleSaveError}
                    </div>
                  )}
                  <div className="form-group" style={{ margin: 0 }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, marginBottom: 6 }}>Tên quy tắc <span style={{ color: 'var(--admin-danger)' }}>*</span></label>
                    <input className="form-input" style={{ width: '100%', boxSizing: 'border-box' }} placeholder="VD: Quá nhiệt máy biến áp" value={ruleFormData.name} onChange={e => setRuleFormData({ ...ruleFormData, name: e.target.value })} />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, marginBottom: 6 }}>Điểm đo cảm biến <span style={{ color: 'var(--admin-danger)' }}>*</span></label>
                      <select className="form-select" style={{ width: '100%' }} value={ruleFormData.point} onChange={e => setRuleFormData({ ...ruleFormData, point: e.target.value })}>
                        {pointOptions.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                    </div>
                    
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, marginBottom: 6 }}>Phân nhóm quy tắc</label>
                      <input className="form-input" style={{ width: '100%', boxSizing: 'border-box' }} placeholder="VD: Cảnh báo nhiệt độ" value={ruleFormData.ruleSet} onChange={e => setRuleFormData({ ...ruleFormData, ruleSet: e.target.value })} />
                    </div>
                  </div>

                  <div style={{ border: '1px solid var(--admin-border)', padding: 14, borderRadius: 6, background: 'var(--admin-layer-2)' }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--admin-accent)', fontWeight: 800, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Ngưỡng và Điều kiện so sánh</div>
                    
                    <div className="form-group" style={{ marginBottom: 10 }}>
                      <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, marginBottom: 4 }}>Phép toán so sánh</label>
                      <select className="form-select" style={{ width: '100%' }} value={ruleFormData.op} onChange={e => setRuleFormData({ ...ruleFormData, op: e.target.value })}>
                        <option value=">=">&gt;= Lớn hơn hoặc bằng (Mặc định)</option>
                        <option value=">">&gt; Lớn hơn hẳn</option>
                        <option value="<=">&lt;= Nhỏ hơn hoặc bằng</option>
                        <option value="<">&lt; Nhỏ hơn hẳn</option>
                        <option value="==">== Bằng chính xác</option>
                      </select>
                    </div>
                    
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <div className="form-group" style={{ margin: 0 }}>
                        <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--admin-warning)', marginBottom: 4 }}>Ngưỡng Cảnh báo (Vàng)</label>
                        <input className="form-input" style={{ width: '100%', boxSizing: 'border-box' }} type="number" placeholder="Bỏ trống nếu không dùng" step="any" value={ruleFormData.preAlarm} onChange={e => setRuleFormData({ ...ruleFormData, preAlarm: e.target.value })} />
                      </div>
                      <div className="form-group" style={{ margin: 0 }}>
                        <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--admin-danger)', marginBottom: 4 }}>Ngưỡng Nguy hiểm (Đỏ)</label>
                        <input className="form-input" style={{ width: '100%', boxSizing: 'border-box' }} type="number" placeholder="Bỏ trống nếu không dùng" step="any" value={ruleFormData.alarm} onChange={e => setRuleFormData({ ...ruleFormData, alarm: e.target.value })} />
                      </div>
                    </div>
                  </div>

                  <div className="form-group" style={{ margin: 0 }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, marginBottom: 6 }}>Tác động và Tự động hóa hệ thống</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                      <div style={{ padding: '10px 12px', borderRadius: 6, border: '1px solid var(--admin-border)', background: 'var(--admin-layer-2)' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', margin: 0 }}>
                          <input type="checkbox" checked={ruleFormData.doAlert} onChange={e => setRuleFormData({ ...ruleFormData, doAlert: e.target.checked })} style={{ accentColor: 'var(--admin-warning)', width: 16, height: 16 }} />
                          <div>
                            <span style={{ fontWeight: 700, fontSize: '0.8rem', color: 'var(--admin-text)' }}>Kích hoạt cảnh báo hệ thống</span>
                            <div style={{ fontSize: '0.7rem', color: 'var(--admin-text-muted)', marginTop: 1 }}>Hiển thị trên bảng cảnh báo thời gian thực.</div>
                          </div>
                        </label>
                      </div>
                      
                      <div style={{ padding: '10px 12px', borderRadius: 6, border: '1px solid var(--admin-border)', background: 'var(--admin-layer-2)' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', margin: 0 }}>
                          <input type="checkbox" checked={ruleFormData.doHealth} onChange={e => setRuleFormData({ ...ruleFormData, doHealth: e.target.checked })} style={{ accentColor: '#0ea5e9', width: 16, height: 16 }} />
                          <div>
                            <span style={{ fontWeight: 700, fontSize: '0.8rem', color: 'var(--admin-text)' }}>Ảnh hưởng sức khỏe thiết bị</span>
                            <div style={{ fontSize: '0.7rem', color: 'var(--admin-text-muted)', marginTop: 1 }}>Tự động trừ điểm sức khỏe của thiết bị này khi có sự cố.</div>
                          </div>
                        </label>
                        {ruleFormData.doHealth && (
                          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: 12 }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--admin-text-muted)' }}>Số điểm trừ (1-100):</span>
                            <input type="number" className="form-input" style={{ width: 80, padding: '4px 8px' }} min="1" max="100" value={ruleFormData.penalty} onChange={e => setRuleFormData({ ...ruleFormData, penalty: Number(e.target.value) })} />
                          </div>
                        )}
                      </div>

                      <div style={{ padding: '10px 12px', borderRadius: 6, border: '1px solid var(--admin-border)', background: 'var(--admin-layer-2)' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', margin: 0 }}>
                          <input type="checkbox" checked={ruleFormData.doMaintenance} onChange={e => setRuleFormData({ ...ruleFormData, doMaintenance: e.target.checked })} style={{ accentColor: 'var(--admin-success)', width: 16, height: 16 }} />
                          <div>
                            <span style={{ fontWeight: 700, fontSize: '0.8rem', color: 'var(--admin-text)' }}>Lập phiếu bảo trì tự động (CMMS)</span>
                            <div style={{ fontSize: '0.7rem', color: 'var(--admin-text-muted)', marginTop: 1 }}>Tự động tạo một công việc bảo trì khi thiết bị vượt ngưỡng đỏ.</div>
                          </div>
                        </label>
                        {ruleFormData.doMaintenance && (
                          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                              <div>
                                <label style={{ fontSize: '0.68rem', color: 'var(--admin-text-muted)', display: 'block', marginBottom: 4 }}>Loại công việc bảo trì</label>
                                <select className="form-select" style={{ width: '100%', padding: '4px 8px', fontSize: '0.72rem' }} value={ruleFormData.maintType} onChange={e => setRuleFormData({ ...ruleFormData, maintType: e.target.value })}>
                                  <option value="inspection">Kiểm tra thiết bị</option>
                                  <option value="repair">Sửa chữa khẩn cấp</option>
                                  <option value="cleaning">Vệ sinh công nghiệp</option>
                                  <option value="calibration">Hiệu chuẩn thông số</option>
                                </select>
                              </div>
                              <div>
                                <label style={{ fontSize: '0.68rem', color: 'var(--admin-text-muted)', display: 'block', marginBottom: 4 }}>Thời hạn hoàn thành (ngày)</label>
                                <input type="number" className="form-input" style={{ width: '100%', padding: '4px 8px', fontSize: '0.72rem', boxSizing: 'border-box' }} min="1" max="365" value={ruleFormData.maintDays} onChange={e => setRuleFormData({ ...ruleFormData, maintDays: Number(e.target.value) })} />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                /* CHẾ ĐỘ HIỂN THỊ DANH SÁCH RULES */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: '.75rem', color: 'var(--admin-text-muted)', fontWeight: 700 }}>DANH SÁCH QUY TẮC ĐANG ÁP DỤNG ({deviceRules.length})</span>
                    <button className="btn-industrial btn-primary btn-sm" onClick={handleOpenAddRule}>
                      + THÊM QUY TẮC MỚI
                    </button>
                  </div>

                  {rulesLoading ? (
                    <div style={{ textAlign: 'center', padding: 24, color: 'var(--admin-text-muted)' }}>⏳ Đang tải quy tắc...</div>
                  ) : deviceRules.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: 30, border: '1px dashed var(--admin-border)', borderRadius: 6, color: 'var(--admin-text-muted)', fontSize: '.8rem' }}>
                      Thiết bị này chưa có quy tắc riêng. Nhấp vào <b>+ Thêm quy tắc mới</b> để thiết lập kịch bản tự động hóa.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {deviceRules.map(r => {
                        const cond = parseCondition(r.condition);
                        const actions = parseActions(r.actions);
                        const pointLabel = (pointOptions.find(p => p.value === cond.point)?.label ?? cond.point).split(' — ')[0];
                        
                        const hasAlarm = cond.alarm !== null && cond.alarm !== undefined && cond.alarm !== '';
                        const hasWarning = (cond.pre_alarm !== null && cond.pre_alarm !== undefined && cond.pre_alarm !== '') || (cond.value !== undefined && actions.level === 'warning');
                        const valAlarm = cond.alarm ?? (actions.level === 'alarm' ? cond.value : null);
                        const valWarning = cond.pre_alarm ?? (actions.level === 'warning' ? cond.value : null);

                        return (
                          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: 'var(--admin-layer-2)', border: '1px solid var(--admin-border)', borderRadius: 4 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontWeight: 800, fontSize: '.82rem', color: 'var(--admin-text)' }}>{r.name}</span>
                                {actions.doHealth && <span style={{ fontSize: '0.62rem', padding: '1px 5px', background: 'rgba(14,165,233,0.15)', color: '#0ea5e9', borderRadius: 3 }}>Sức khỏe (-{actions.penalty}đ)</span>}
                                {actions.doMaintenance && <span style={{ fontSize: '0.62rem', padding: '1px 5px', background: 'rgba(34,197,94,0.15)', color: 'var(--admin-success)', borderRadius: 3 }}>Bảo trì</span>}
                              </div>
                              <div style={{ fontSize: '.7rem', color: 'var(--admin-text-muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span>Điểm đo: <b>{pointLabel}</b></span>
                                <span style={{ opacity: 0.3 }}>|</span>
                                <span>Điều kiện: <code>{cond.op || '≥'}</code></span>
                                <span style={{ opacity: 0.3 }}>|</span>
                                {hasWarning && <span>Cảnh báo: <b style={{ color: '#fbbf24' }}>{valWarning}°C</b></span>}
                                {hasAlarm && <span style={{ marginLeft: 4 }}>Nguy hiểm: <b style={{ color: '#ef4444' }}>{valAlarm}°C</b></span>}
                              </div>
                            </div>

                            {/* Switch Enable */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <label style={{ position: 'relative', display: 'inline-block', width: 34, height: 18 }}>
                                <input type="checkbox" checked={r.enabled} onChange={() => handleToggleRule(r.id, r.enabled)} style={{ opacity: 0, width: 0, height: 0 }} />
                                <span style={{ position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0, background: r.enabled ? 'var(--admin-accent)' : 'var(--admin-layer-3)', borderRadius: 18, transition: '.2s' }}>
                                  <span style={{ position: 'absolute', content: '""', height: 12, width: 12, left: r.enabled ? 19 : 3, bottom: 3, background: 'white', borderRadius: '50%', transition: '.2s' }}></span>
                                </span>
                              </label>
                              
                              <button className="btn-industrial btn-sm" onClick={() => handleOpenEditRule(r)} style={{ padding: '2px 8px', fontSize: 10 }}>Sửa</button>
                              <button className="btn-industrial btn-sm btn-danger" onClick={() => handleDeleteRule(r.id)} style={{ padding: '2px 8px', fontSize: 10 }}>Xóa</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="modal-footer">
              {isEditingRule ? (
                <>
                  <button type="button" className="btn-industrial" onClick={() => setIsEditingRule(false)} disabled={isSavingRule}>Quay lại</button>
                  <div style={{ flex: 1 }}></div>
                  <button type="button" className="btn-industrial btn-primary" onClick={handleSaveRule} disabled={isSavingRule}>{isSavingRule ? 'Đang lưu...' : 'Lưu quy tắc'}</button>
                </>
              ) : (
                <>
                  <div style={{ flex: 1 }}></div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {/* ╔═══ ROI CONFIGURATION POPUP DIALOG REMOVED ═══ */}

      {/* ╔═══ PD REGION CONFIGURATION POPUP DIALOG REMOVED ═══ */}
    </div>
  );
}
