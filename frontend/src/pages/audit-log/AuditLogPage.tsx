// ============================================================
// AuditLogPage.tsx — Nhật ký hoạt động hệ thống
// Tab: Tất cả | Hành động | Đăng nhập | Thông báo | Quy tắc kích hoạt
// Dữ liệu không thể sửa đổi (immutable) — chỉ đọc
// ============================================================

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { stationApi, Station, Device } from '@/services/StationApiService';
import { authService } from '@/services/AuthService';
import { isCentralUser } from '@/utils/centralAccess';
import { fmtDateTime } from '@/utils/format';
import ToolbarSelect from '@/components/ui/ToolbarSelect';
import DateRangePicker from '@/components/ui/DateRangePicker';
import './AuditLogPage.css';

type TabId = 'all' | 'audit' | 'login';

interface AuditLogPageProps {
  embeddedMode?: 'default' | 'central';
  stationIdOverride?: string | null;
}

// Cấu trúc chuẩn hóa dùng để hiển thị — gộp từ nhiều nguồn log khác nhau
interface LogItem {
  ts: string;
  type: string;   // audit | login
  action: string;
  info: string;
  who: string;
  stationId?: string;
  stationName?: string;
  raw: any;       // object gốc từ API, dùng khi expand dòng
}

export default function AuditLogPage({ embeddedMode = 'default', stationIdOverride = null }: AuditLogPageProps) {
  const [activeTab, setActiveTab] = useState<TabId>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<LogItem[]>([]);       // log đã gộp + chuẩn hóa
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loginLogs, setLoginLogs] = useState<any[]>([]);
  const [selectedDetail, setSelectedDetail] = useState<{
    entityType: string | null | undefined;
    entityId?: string | null | undefined;
    action: string;
    oldValue: string | null | undefined;
    newValue: string | null | undefined;
    title: string;
    who?: string;
    stationName?: string;
    ts?: string;
    ipAddress?: string;
    raw?: any;
  } | null>(null);

  const currentUser = authService.getUser();
  const isCentralMode = isCentralUser(currentUser);

  const [stationsList, setStationsList] = useState<Station[]>([]);
  const [devicesList, setDevicesList] = useState<Device[]>([]);
  const [filterStation, setFilterStation] = useState<string>(stationIdOverride || '');

  const openDetail = useCallback((detail: {
    entityType: string | null | undefined;
    entityId?: string | null | undefined;
    action: string;
    oldValue: string | null | undefined;
    newValue: string | null | undefined;
    title: string;
    who?: string;
    stationName?: string;
    ts?: string;
    ipAddress?: string;
    raw?: any;
  }) => {
    setSelectedDetail(detail);
  }, []);

  const closeDetail = useCallback(() => {
    setSelectedDetail(null);
  }, []);

  const withTimeout = useCallback(async <T,>(promise: Promise<T>, ms: number, fallback: T, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race<T>([
        promise,
        new Promise<T>(resolve => {
          timer = setTimeout(() => {
            console.warn(`[AuditLogPage] ${label} timeout after ${ms}ms`);
            resolve(fallback);
          }, ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    if (!selectedDetail) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDetail();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeDetail, selectedDetail]);

  // Chuyển entityType từ API sang nhãn tiếng Việt
  const entityLabel = (type: string | null): string => {
    const map: Record<string, string> = {
      device: 'Thiết bị',
      rule: 'Quy tắc',
      alert: 'Cảnh báo',
      user: 'Người dùng',
      settings: 'Cấu hình',
      maintenance: 'Bảo trì',
      measurement: 'Điểm đo',
      station: 'Trạm',
      boundary: 'Vùng giám sát',
      sensor: 'Cảm biến',
    };
    return type ? (map[type] ?? type) : '—';
  };

  const actionLabel = (action: string): string => {
    const map: Record<string, string> = {
      create: 'Tạo mới',
      update: 'Cập nhật',
      delete: 'Xóa',
      login:  'Đăng nhập',
      logout: 'Đăng xuất',
      failed: 'Thất bại',
    };
    return map[action?.toLowerCase()] ?? action;
  };

  const getStationLabel = (stationName?: string | null) => stationName || 'Trung tâm đa trạm';

  const buildDetailNarrative = (detail: {
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    who?: string;
    stationName?: string;
  }) => {
    const actor = detail.who || 'Người dùng';
    const action = actionLabel(detail.action).toLowerCase();
    const entity = entityLabel(detail.entityType ?? null).toLowerCase();
    const station = detail.stationName || 'Trung tâm đa trạm';

    if (detail.action?.toLowerCase() === 'login') {
      return `${actor} đã đăng nhập tại ${station}.`;
    }
    if (detail.action?.toLowerCase() === 'logout') {
      return `${actor} đã đăng xuất tại ${station}.`;
    }
    if (detail.action?.toLowerCase() === 'failed') {
      return `${actor} có một lần thao tác thất bại tại ${station}.`;
    }
    return `${actor} đã ${action} ${entity} tại ${station}.`;
  };

  const parseJson = (str: string | null | undefined) => {
    if (!str) return null;
    try {
      if (typeof str === 'object') return str;
      return JSON.parse(str);
    } catch {
      return null;
    }
  };

  const stationMap = useMemo(() => {
    const map: Record<string, string> = {};
    stationsList.forEach(s => {
      map[s.id] = s.name;
    });
    return map;
  }, [stationsList]);

  const deviceMap = useMemo(() => {
    const map: Record<string, string> = {};
    devicesList.forEach(d => {
      map[d.id] = d.name;
    });
    return map;
  }, [devicesList]);

  const matchesActionFilter = useCallback((action: string) => {
    if (!filterAction) return true;
    return action?.toLowerCase() === filterAction.toLowerCase();
  }, [filterAction]);

  const filteredLogs = useMemo(() => {
    if (!filterAction) return logs;
    return logs.filter(m => matchesActionFilter(m.action));
  }, [logs, matchesActionFilter, filterAction]);

  const filteredAuditLogs = useMemo(() => {
    if (!filterAction) return auditLogs;
    return auditLogs.filter(l => matchesActionFilter(l.action));
  }, [auditLogs, matchesActionFilter, filterAction]);

  const filteredLoginLogs = useMemo(() => {
    if (!filterAction) return loginLogs;
    return loginLogs.filter(l => matchesActionFilter(l.action));
  }, [loginLogs, matchesActionFilter, filterAction]);

  const getHumanReadableChanges = (
    entityType: string | null | undefined,
    action: string,
    oldValStr: string | null | undefined,
    newValStr: string | null | undefined
  ) => {
    const oldVal = parseJson(oldValStr);
    const newVal = parseJson(newValStr);

    const ignoredKeys = new Set([
      'id', 'idguid', 'createdat', 'updatedat', 'passwordhash',
      'password', 'concurrencystamp', 'securitystamp', 'normalizedemail',
      'normalizedusername', 'emailconfirmed', 'phonenumberconfirmed',
      'twofactorenabled', 'lockoutend', 'lockoutenabled', 'accessfailedcount',
      'station', 'device', 'rules', 'sensorreadings', 'alerts', 'sldpoints',
      'maintenancetasks', 'ruletriggerlogs', 'roipoints', 'boundaries'
    ]);

    const entity = (entityType ?? '').toLowerCase();
    const isPointLikeEntity = ['point', 'measurement', 'roipoint', 'sldpoint'].some(token => entity.includes(token));
    const geometryKeys = new Set(['x', 'y', 'r']);

    const formatGeometry = (obj: any) => {
      if (!obj || typeof obj !== 'object') return '(trống)';
      const parts: string[] = [];
      if (obj.x !== undefined && obj.x !== null) parts.push(`X: ${obj.x}`);
      if (obj.y !== undefined && obj.y !== null) parts.push(`Y: ${obj.y}`);
      if (obj.r !== undefined && obj.r !== null) parts.push(`Bán kính: ${obj.r}px`);
      return parts.length ? parts.join(' | ') : '(trống)';
    };

    const buildNamedRows = (obj: any) => {
      if (!obj || typeof obj !== 'object') return [] as Array<[string, any]>;
      const rows: Array<[string, any]> = [];

      if (isPointLikeEntity) {
        const geometry = formatGeometry(obj);
        if (geometry !== '(trống)') {
          rows.push(['geometry', geometry]);
        }
      }

      Object.entries(obj).forEach(([k, v]) => {
        const key = k.toLowerCase();
        if (ignoredKeys.has(key) || geometryKeys.has(key)) return;
        rows.push([k, v]);
      });

      return rows;
    };

    const translateKey = (k: string): string => {
      const keys: Record<string, string> = {
        name: 'Tên quy tắc / Tên điểm',
        label: 'Tên hiển thị',
        pointId: 'Mã điểm đo',
        r: 'Bán kính vùng chấm (px)',
        x: 'Tọa độ X',
        y: 'Tọa độ Y',
        alarmThreshold: 'Ngưỡng báo động (°C)',
        preAlarmThreshold: 'Ngưỡng cảnh báo (°C)',
        warningThreshold: 'Ngưỡng cảnh báo (°C)',
        enabled: 'Trạng thái hoạt động',
        isActive: 'Trạng thái hoạt động',
        type: 'Phân loại',
        severityLevel: 'Mức độ nghiêm trọng',
        title: 'Tiêu đề công việc / Quy tắc',
        scheduledDate: 'Ngày lên lịch',
        assignedTo: 'Người được bàn giao',
        notes: 'Ghi chú / Mô tả',
        ackNote: 'Ghi chú xác nhận',
        fullName: 'Họ và tên',
        email: 'Địa chỉ Email',
        role: 'Vai trò tài khoản',
        status: 'Trạng thái',
        thresholds: 'Ngưỡng giá trị',
        polygon: 'Tọa độ vùng quét (polygon)',
        config: 'Cấu hình thiết bị',
        ip: 'Địa chỉ IP',
        username: 'Tên đăng nhập',
        stationIds: 'Các trạm quản lý',
        deviceId: 'Thiết bị liên kết',
        stationId: 'Trạm liên kết',
        checklist: 'Danh mục kiểm tra',
        condition: 'Điều kiện giám sát',
        actions: 'Tác động hệ thống',
        thresholdsJson: 'Cấu hình ngưỡng',
        thresholdsjson: 'Cấu hình ngưỡng',
        ruleSet: 'Nhóm quy tắc',
        point: 'Điểm đo giám sát',
        op: 'Phép toán so sánh',
        preAlarm: 'Ngưỡng Cảnh báo (Vàng)',
        alarm: 'Nguy hiểm (Đỏ)',
        doAlert: 'Gửi cảnh báo thời gian thực',
        doHealth: 'Trừ điểm sức khỏe',
        doMaintenance: 'Lập phiếu bảo trì tự động',
        penalty: 'Điểm sức khỏe trừ',
        maintType: 'Loại bảo trì lập lịch',
        maintDays: 'Thời hạn hoàn thành bảo trì (ngày)',
        ox: 'Tọa độ X (Quang học)',
        oy: 'Tọa độ Y (Quang học)',
        tx: 'Tọa độ X (Ảnh nhiệt)',
        ty: 'Tọa độ Y (Ảnh nhiệt)',
        sortOrder: 'Thứ tự hiển thị',
        color: 'Màu sắc hiển thị'
      };
      return keys[k] ?? k;
    };

    const translateValue = (k: string, v: any): React.ReactNode => {
      const renderCompactObject = (obj: any, title = 'Dữ liệu cấu trúc') => {
        if (!obj || typeof obj !== 'object') return '—';
        const entries = Object.entries(obj).filter(([, value]) => value !== null && value !== undefined);
        if (entries.length === 0) return '—';
        return (
          <div className="audit-object-preview">
            <div className="audit-object-preview__title">{title}</div>
            {entries.slice(0, 6).map(([key, value]) => (
              <div key={key} className="audit-object-preview__row">
                <span>{translateKey(key)}</span>
                <strong>{typeof value === 'object' && value !== null ? (Array.isArray(value) ? `Danh sách ${value.length} mục` : `${Object.keys(value).length} trường`) : String(value)}</strong>
              </div>
            ))}
            {entries.length > 6 && (
              <div className="audit-object-preview__more">+{entries.length - 6} trường khác</div>
            )}
          </div>
        );
      };

      const renderThresholdsJson = (value: any) => {
        const parsed = typeof value === 'string' ? parseJson(value) : value;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

        const displayName = parsed.fullName || parsed.label || parsed.name || 'Cấu hình ngưỡng';
        const warnValue = parsed.warn ?? parsed.warning ?? parsed.preAlarm ?? parsed.pre_alarm ?? parsed.prealarm ?? '—';
        const alarmValue = parsed.alarm ?? parsed.high ?? parsed.threshold ?? '—';
        const fontSize = parsed.fontSize ?? parsed.fontsize;
        const labelPos = parsed.labelPos ?? parsed.labelPosition;
        const strokeWidth = parsed.strokeWidth ?? parsed.strokewidth;

        const summaryBits: string[] = [
          `Cảnh báo ${warnValue}`,
          `Báo động ${alarmValue}`,
        ];
        if (labelPos !== undefined && labelPos !== null) summaryBits.push(`Nhãn ${labelPos}`);
        if (fontSize !== undefined && fontSize !== null) summaryBits.push(`Cỡ ${fontSize}`);
        if (strokeWidth !== undefined && strokeWidth !== null) summaryBits.push(`Nét ${strokeWidth}`);

        return (
          <div className="audit-threshold-preview">
            <div className="audit-threshold-preview__name">{displayName}</div>
            <div className="audit-threshold-preview__summary">
              {summaryBits.map(bit => (
                <span key={bit} className="audit-threshold-preview__chip">
                  {bit}
                </span>
              ))}
            </div>
          </div>
        );
      };

      if (v === null || v === undefined) return '(trống)';
      if (typeof v === 'boolean') return v ? 'Đang bật / Hoạt động' : 'Tắt / Ngừng hoạt động';
      if (k === 'label' && typeof v === 'string' && !v.trim()) return 'Chưa đặt tên';
      if (k === 'role') {
        if (v === 'admin') return 'Quản trị viên hệ thống';
        if (v === 'manager') return 'Quản lý trạm con';
        if (v === 'operator') return 'Nhân viên vận hành';
      }
      if ((k === 'x' || k === 'y' || k === 'r') && (typeof v === 'number' || typeof v === 'string')) {
        return `${v}`;
      }
      if (k === 'severityLevel' || k === 'level') {
        if (v === 'alarm') return 'Nguy hiểm (Alarm)';
        if (v === 'warning') return 'Cảnh báo (Warning)';
        if (v === 'info') return 'Thông tin (Info)';
      }
      if (k === 'condition' && typeof v === 'string') {
        const parsedCond = parseJson(v);
        if (parsedCond) {
          const parts: string[] = [];
          if (parsedCond.point) parts.push(`Điểm đo: ${parsedCond.point}`);
          if (parsedCond.op) parts.push(`Phép toán: ${parsedCond.op}`);
          if (parsedCond.value !== undefined && parsedCond.value !== null) parts.push(`Giá trị: ${parsedCond.value}`);
          if (parsedCond.pre_alarm !== undefined && parsedCond.pre_alarm !== null) parts.push(`Ngưỡng cảnh báo: ${parsedCond.pre_alarm}°C`);
          if (parsedCond.alarm !== undefined && parsedCond.alarm !== null) parts.push(`Ngưỡng báo động: ${parsedCond.alarm}°C`);
          return parts.join(' | ');
        }
      }
      if (k === 'actions' && typeof v === 'string') {
        const parsedAct = parseJson(v);
        if (Array.isArray(parsedAct)) {
          const actStrings = parsedAct.map(act => {
            if (act.type === 'alert') return 'Cảnh báo Live';
            if (act.type === 'health') return `Điểm sức khỏe (-${act.penalty}đ)`;
            if (act.type === 'maintenance') {
              const typeMap: Record<string, string> = {
                inspection: 'Kiểm tra',
                repair: 'Sửa chữa',
                cleaning: 'Vệ sinh',
                calibration: 'Hiệu chuẩn'
              };
              return `Phiếu bảo trì tự động (${typeMap[act.taskType] || act.taskType}, hạn ${act.scheduledInDays} ngày)`;
            }
            return act.type || JSON.stringify(act);
          });
          return actStrings.join(' + ');
        }
      }
      if (k === 'maintType') {
        const typeMap: Record<string, string> = {
          inspection: 'Kiểm tra thiết bị',
          repair: 'Sửa chữa khẩn cấp',
          cleaning: 'Vệ sinh công nghiệp',
          calibration: 'Hiệu chuẩn thông số'
        };
        return typeMap[v] || v;
      }
      if (k === 'deviceId' && typeof v === 'string') {
        return deviceMap[v] ? `${deviceMap[v]} (ID: ${v.slice(0, 8)})` : v;
      }
      if (k === 'stationId' && typeof v === 'string') {
        return stationMap[v] ? `${stationMap[v]} (ID: ${v.slice(0, 8)})` : v;
      }
      if (k === 'checklist') {
        const parsedList = parseJson(v);
        if (Array.isArray(parsedList)) {
          return (
            <ul style={{ paddingLeft: 16, margin: 0, listStyle: 'none' }}>
              {parsedList.map((item: any, idx: number) => (
                <li key={idx} style={{ color: item.done ? 'var(--admin-success)' : 'var(--admin-text-muted)', marginBottom: 4 }}>
                  <span style={{ marginRight: 6, fontWeight: 'bold' }}>{item.done ? '☑' : '☐'}</span>
                  {item.item}
                </li>
              ))}
            </ul>
          );
        }
      }
      if (k.toLowerCase() === 'thresholdsjson') {
        const summary = renderThresholdsJson(v);
        if (summary) return summary;
      }
      if (k === 'thresholds' && typeof v === 'string') {
        const parsedTh = parseJson(v);
        if (parsedTh) {
          return Object.entries(parsedTh).map(([tk, tv]) => `${tk === 'warn' || tk === 'warning' ? 'Cảnh báo' : 'Báo động'}: ${tv}`).join(', ');
        }
      }
      if (k === 'scheduledDate' && typeof v === 'string') {
        try {
          return new Date(v).toLocaleDateString('vi-VN');
        } catch {
          return v;
        }
      }
      if (k === 'polygon' && typeof v === 'string') {
        const coords = parseJson(v);
        if (Array.isArray(coords)) {
          return `Vùng khép kín gồm ${coords.length} điểm tọa độ`;
        }
      }
      if (k === 'config') {
        const cfg = parseJson(v);
        if (cfg && typeof cfg === 'object') {
          return Object.entries(cfg)
            .map(([ck, cv]) => `${ck}: ${cv}`)
            .join(' | ');
        }
      }
      if (Array.isArray(v)) {
        if (v.length === 0) return '(trống)';
        const hasObjects = v.some(item => typeof item === 'object' && item !== null);
        if (!hasObjects) return v.join(', ');
        return <span>Danh sách gồm {v.length} mục</span>;
      }
      if (typeof v === 'object' && v !== null) {
        return renderCompactObject(v, translateKey(k));
      }
      return String(v);
    };

    const extractThresholdConfig = (value: any) => {
      const parsed = typeof value === 'string' ? parseJson(value) : value;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return {
        name: parsed.fullName || parsed.label || parsed.name || 'Cấu hình ngưỡng',
        warn: parsed.warn ?? parsed.warning ?? parsed.preAlarm ?? parsed.pre_alarm ?? parsed.prealarm,
        alarm: parsed.alarm ?? parsed.high ?? parsed.threshold,
        labelPos: parsed.labelPos ?? parsed.labelPosition,
        fontSize: parsed.fontSize ?? parsed.fontsize,
        strokeWidth: parsed.strokeWidth ?? parsed.strokewidth,
      };
    };

    const renderThresholdDiff = (oldValue: any, newValue: any) => {
      const oldCfg = extractThresholdConfig(oldValue);
      const newCfg = extractThresholdConfig(newValue);
      if (!oldCfg || !newCfg) return null;

      const fields: Array<{ label: string; oldV: any; newV: any }> = [
        { label: 'Cảnh báo', oldV: oldCfg.warn, newV: newCfg.warn },
        { label: 'Báo động', oldV: oldCfg.alarm, newV: newCfg.alarm },
        { label: 'Nhãn', oldV: oldCfg.labelPos, newV: newCfg.labelPos },
        { label: 'Cỡ chữ', oldV: oldCfg.fontSize, newV: newCfg.fontSize },
        { label: 'Độ dày nét', oldV: oldCfg.strokeWidth, newV: newCfg.strokeWidth },
      ].filter(item => item.oldV !== item.newV);

      const nameChanged = oldCfg.name !== newCfg.name;

      if (fields.length === 0 && !nameChanged) {
        return <span style={{ color: 'var(--admin-text-muted)' }}>Không có thay đổi thực tế trong cấu hình ngưỡng.</span>;
      }

      return (
        <div className="audit-change-diff">
          <div className="audit-change-diff__title">{newCfg.name}</div>
          {nameChanged && (
            <div className="audit-change-diff__row">
              <span className="audit-change-diff__label">Tên hiển thị</span>
              <span className="audit-change-diff__value">
                <i>{String(oldCfg.name)}</i> → <b>{String(newCfg.name)}</b>
              </span>
            </div>
          )}
          {fields.map(field => (
            <div key={field.label} className="audit-change-diff__row">
              <span className="audit-change-diff__label">{field.label}</span>
              <span className="audit-change-diff__value">
                <i>{field.oldV === undefined || field.oldV === null ? '—' : String(field.oldV)}</i> → <b>{field.newV === undefined || field.newV === null ? '—' : String(field.newV)}</b>
              </span>
            </div>
          ))}
        </div>
      );
    };

    // Trường hợp tạo mới (create) hoặc không có oldValue
    if (action.toLowerCase() === 'create' || !oldVal) {
      if (!newVal) return <span style={{ color: 'var(--admin-text-muted)' }}>Không có thông tin chi tiết.</span>;

      const filteredNewVal = buildNamedRows(newVal);

      return (
        <table className="detail-changes-table">
          <thead>
            <tr>
              <th colSpan={2}>THÔNG TIN KHỞI TẠO CHI TIẾT</th>
            </tr>
          </thead>
          <tbody>
            {filteredNewVal.map(([k, v]) => {
              if (v === null || v === undefined) return null;
              return (
                <tr key={k}>
                  <td className="detail-key">{k === 'geometry' ? 'Vị trí' : translateKey(k)}</td>
                  <td className="detail-val-new">{translateValue(k, v)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    }

    // Trường hợp xóa (delete) hoặc không có newValue
    if (action.toLowerCase() === 'delete' || !newVal) {
      if (!oldVal) return <span style={{ color: 'var(--admin-text-muted)' }}>Không có thông tin chi tiết.</span>;

      const filteredOldVal = buildNamedRows(oldVal);

      return (
        <table className="detail-changes-table">
          <thead>
            <tr>
              <th colSpan={2}>THÔNG TIN ĐỐI TƯỢNG ĐÃ XÓA</th>
            </tr>
          </thead>
          <tbody>
            {filteredOldVal.map(([k, v]) => {
              if (v === null || v === undefined) return null;
              return (
                <tr key={k}>
                  <td className="detail-key">{k === 'geometry' ? 'Vị trí' : translateKey(k)}</td>
                  <td className="detail-val-old" style={{ textDecoration: 'none' }}>{translateValue(k, v)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    }

    // Trường hợp cập nhật (update)
    const changes: { key: string; oldV: any; newV: any }[] = [];
    const allKeys = Array.from(new Set([...Object.keys(oldVal), ...Object.keys(newVal)]));
    const geometryChanged = isPointLikeEntity && ['x', 'y', 'r'].some(k => oldVal[k] !== newVal[k]);

    for (const k of allKeys) {
      if (ignoredKeys.has(k.toLowerCase())) continue;
      if (isPointLikeEntity && geometryKeys.has(k.toLowerCase())) continue;

      if ((oldVal[k] && typeof oldVal[k] === 'object') || (newVal[k] && typeof newVal[k] === 'object')) {
        if (JSON.stringify(oldVal[k]) !== JSON.stringify(newVal[k])) {
          changes.push({ key: k, oldV: JSON.stringify(oldVal[k]), newV: JSON.stringify(newVal[k]) });
        }
        continue;
      }
      if (oldVal[k] !== newVal[k]) {
        changes.push({ key: k, oldV: oldVal[k], newV: newVal[k] });
      }
    }

    if (geometryChanged) {
      changes.unshift({
        key: 'geometry',
        oldV: formatGeometry(oldVal),
        newV: formatGeometry(newVal),
      });
    }

    if (changes.length === 0) {
      return <span style={{ color: 'var(--admin-text-muted)' }}>Cập nhật các thuộc tính hệ thống.</span>;
    }

    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <table className="detail-changes-table">
          <thead>
            <tr>
              <th>Thuộc tính thay đổi</th>
              <th>Giá trị cũ</th>
              <th>Giá trị mới</th>
            </tr>
          </thead>
          <tbody>
            {changes.map(c => {
              if (c.key.toLowerCase() === 'thresholdsjson') {
                return (
                  <tr key={c.key}>
                    <td className="detail-key">{translateKey(c.key)}</td>
                    <td className="detail-val-new" colSpan={2}>
                      {renderThresholdDiff(c.oldV, c.newV)}
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={c.key}>
                  <td className="detail-key">{c.key === 'geometry' ? 'Vị trí' : translateKey(c.key)}</td>
                  <td className="detail-val-old">{translateValue(c.key, c.oldV)}</td>
                  <td className="detail-val-new">{translateValue(c.key, c.newV)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  useEffect(() => {
    if (isCentralMode) {
      stationApi.getStations()
        .then(data => setStationsList(data))
        .catch(err => console.error('Lỗi tải danh sách trạm:', err));
    }
    stationApi.getDevices()
      .then(data => setDevicesList(data))
      .catch(err => console.error('Lỗi tải danh sách thiết bị:', err));
  }, [isCentralMode]);

  const loadData = useCallback(async () => {
    setLoading(true);
    
    const from = startDate ? new Date(startDate + 'T00:00:00').toISOString() : undefined;
    const to = endDate ? new Date(endDate + 'T23:59:59').toISOString() : undefined;
    const params = { from, to, limit: 100, stationId: filterStation || undefined };

    try {
      if (activeTab === 'all') {
        const [audit, logins] = await Promise.all([
          withTimeout(stationApi.getAuditLogs(params), 12000, [], 'getAuditLogs(all)'),
          withTimeout(stationApi.getLoginLogs(params), 12000, [], 'getLoginLogs(all)')
        ]);

        const merged: LogItem[] = [
          ...audit.map(l => ({ ts: l.ts, type: 'audit', action: l.action, info: entityLabel(l.entityType ?? null), who: l.fullName || l.username || 'system', stationId: l.stationId, stationName: l.stationName, raw: l })),
          ...logins.map(l => {
            const roleLabel = l.role === 'admin' ? 'Quản trị viên' : (l.role ? 'Nhân viên' : '');
            const displayName = l.fullName 
              ? `${l.fullName}${roleLabel ? ` (${roleLabel})` : ''}` 
              : `${l.username}${roleLabel ? ` (${roleLabel})` : ''}`;
            return {
              ts: l.ts,
              type: 'login',
              action: 'Auth',
              info: l.action === 'login' ? 'Đăng nhập thành công' : 'Thất bại / Thoát',
              who: displayName,
              stationId: l.stationId,
              stationName: l.stationName,
              raw: l
            };
          })
        ].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

        setLogs(merged);
      } else if (activeTab === 'audit') {
        const data = await withTimeout(stationApi.getAuditLogs({
          ...params,
          limit: 200,
          action: filterAction || undefined,
        }), 12000, [], 'getAuditLogs(audit)');
        setAuditLogs(data);
      } else if (activeTab === 'login') {
        const data = await withTimeout(stationApi.getLoginLogs(params), 12000, [], 'getLoginLogs(login)');
        setLoginLogs(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [activeTab, startDate, endDate, filterStation, filterAction]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const renderTableHead = () => {
    if (activeTab === 'all') {
      return (
        <tr>
          <th className="col-time">Thời gian</th>
          <th className="col-type">Loại</th>
          {isCentralMode && <th className="col-station">Trạm</th>}
          <th className="col-event">Hành động / Sự kiện</th>
        </tr>
      );
    }
    if (activeTab === 'audit') {
      return (
        <tr>
          <th className="col-time">Thời gian</th>
          <th className="col-action">Hành động</th>
          {isCentralMode && <th className="col-station">Trạm</th>}
          <th className="col-who">Người thực hiện</th>
        </tr>
      );
    }
    if (activeTab === 'login') {
      return (
        <tr>
          <th className="col-time">Thời gian</th>
          {isCentralMode && <th className="col-station">Trạm</th>}
          <th className="col-action">Tên đăng nhập</th>
          <th>Kết quả</th>
          <th className="col-ip">Địa chỉ IP</th>
        </tr>
      );
    }
    return (
      <tr>
        <th className="col-time">Thời gian</th>
        {isCentralMode && <th className="col-station">Trạm</th>}
        <th className="col-action">Tên đăng nhập</th>
        <th>Kết quả</th>
        <th className="col-ip">Địa chỉ IP</th>
      </tr>
    );
  };

  const getRecordCount = () => {
    if (activeTab === 'all') return filteredLogs.length;
    if (activeTab === 'audit') return filteredAuditLogs.length;
    return filteredLoginLogs.length;
  };

  const renderAllRows = (items: LogItem[], keyPrefix = 'all') => items.map((m, idx) => {
    const hasDetail = m.type === 'audit';
    const eventText = m.type === 'audit' ? actionLabel(m.action) : m.info;

    return (
      <tr
        key={`${keyPrefix}-${idx}`}
        className={hasDetail ? 'audit-row-clickable' : undefined}
        onClick={hasDetail ? () => openDetail({
          entityType: m.raw?.entityType,
          entityId: m.raw?.entityId,
          action: m.raw?.action,
          oldValue: m.raw?.oldValue,
          newValue: m.raw?.newValue,
          title: `${actionLabel(m.raw?.action)} · ${entityLabel(m.raw?.entityType ?? null)}`,
          who: m.who,
          stationName: m.stationName,
          ts: m.ts,
          ipAddress: m.raw?.ipAddress,
          raw: m.raw
        }) : undefined}
      >
          <td className="col-time" style={{ color: 'var(--admin-text-muted)', fontFamily: 'monospace' }}>
            {fmtDateTime(m.ts)}
          </td>
          <td className="col-type">
            <span className={`tag-all tag-${m.type}`} title={m.type === 'audit' ? 'Hành động hệ thống' : 'Đăng nhập'}>
              {m.type === 'audit' ? 'THAO TÁC' : m.type === 'login' ? 'ĐĂNG NHẬP' : m.type.toUpperCase()}
            </span>
          </td>
          {isCentralMode && (
            <td className="col-station" style={{ color: 'var(--admin-text-muted)', fontWeight: 500 }}>
              {getStationLabel(m.stationName)}
            </td>
          )}
          <td className="col-event" style={{ fontWeight: 600 }}>
            {eventText}
          </td>
      </tr>
    );
  });

  const renderAuditRows = (items: any[], keyPrefix = 'audit') => items.map((l, idx) => {
    return (
      <tr
        key={`${keyPrefix}-${idx}`}
        className="audit-row-clickable"
        onClick={() => openDetail({
          entityType: l.entityType,
          entityId: l.entityId,
          action: l.action,
          oldValue: l.oldValue,
          newValue: l.newValue,
          title: `${actionLabel(l.action)} · ${entityLabel(l.entityType ?? null)}`,
          who: l.fullName || l.username || 'system',
          stationName: l.stationName,
          ts: l.ts,
          ipAddress: l.ipAddress,
          raw: l
        })}
      >
          <td className="col-time" style={{ color: 'var(--admin-text-muted)' }}>
            {fmtDateTime(l.ts)}
          </td>
          <td className="col-action">
            <b>{actionLabel(l.action)}</b>
          </td>
          {isCentralMode && (
            <td className="col-station" style={{ color: 'var(--admin-text-muted)', fontWeight: 500 }}>
              {getStationLabel(l.stationName)}
            </td>
          )}
          <td className="col-who">{l.fullName || l.username || 'system'}</td>
      </tr>
    );
  });

  const renderLoginRows = (items: any[]) => items.map((l, idx) => {
    const roleLabel = l.role === 'admin' ? 'Quản trị viên' : (l.role ? 'Nhân viên' : '');
    const displayName = l.fullName 
      ? `${l.fullName}${roleLabel ? ` (${roleLabel})` : ''}` 
      : `${l.username}${roleLabel ? ` (${roleLabel})` : ''}`;

    return (
      <tr key={`${l.stationId || 'unknown'}-${idx}`}>
        <td className="col-time">{fmtDateTime(l.ts)}</td>
        {isCentralMode && (
          <td className="col-station" style={{ color: 'var(--admin-text-muted)', fontWeight: 500 }}>
            {getStationLabel(l.stationName)}
          </td>
        )}
        <td className="col-action">
          <b>{displayName}</b>
        </td>
        <td>{l.action === 'login' ? 'Đăng nhập' : 'Thất bại / Thoát'}</td>
        <td className="col-ip">{l.ipAddress || 'internal'}</td>
      </tr>
    );
  });

  const shouldGroupByStation = embeddedMode === 'central' && isCentralMode && !filterStation;

  const groupedStations = useMemo(() => {
    if (!shouldGroupByStation) return [];

    function groupItems<T extends { stationId?: string; stationName?: string }>(items: T[]) {
      const grouped = new Map<string, { id: string; name: string; items: T[] }>();
      items.forEach((item, index) => {
        const id = item.stationId || `unknown-${index}`;
        const name = getStationLabel(item.stationName);
        const current = grouped.get(id);
        if (current) {
          current.items.push(item);
          return;
        }
        grouped.set(id, { id, name, items: [item] });
      });
      return Array.from(grouped.values()).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    }

    if (activeTab === 'all') return groupItems(filteredLogs);
    if (activeTab === 'audit') return groupItems(filteredAuditLogs);
    if (activeTab === 'login') return groupItems(filteredLoginLogs);
    return groupItems(filteredLoginLogs);
  }, [activeTab, filteredAuditLogs, filteredLoginLogs, filteredLogs, shouldGroupByStation]);

  const renderEmptyState = () => {
    const colSpan = activeTab === 'login'
      ? (isCentralMode ? 5 : 4)
      : (isCentralMode ? 4 : 3);

    let message = 'Không có dữ liệu.';
    if (activeTab === 'all') message = 'Không có dữ liệu tổng hợp.';
    if (activeTab === 'audit') message = 'Không có nhật ký hành động.';
    if (activeTab === 'login') message = 'Không có nhật ký đăng nhập.';

    return (
      <tr>
        <td colSpan={colSpan} style={{ textAlign: 'center', padding: 60, color: 'var(--admin-text-muted)', fontStyle: 'italic' }}>
          {message}
        </td>
      </tr>
    );
  };

  const renderTableBody = (groupItems?: any[], groupKey?: string) => {
    if (loading) {
      return (
        <tr>
          <td colSpan={activeTab === 'login' ? (isCentralMode ? 5 : 4) : (isCentralMode ? 4 : 3)} style={{ textAlign: 'center', padding: 60, color: 'var(--admin-text-muted)' }}>
            Đang tải dữ liệu...
          </td>
        </tr>
      );
    }

    const items = groupItems;

    if (activeTab === 'all') {
      const source = items || filteredLogs;
      if (source.length === 0) return renderEmptyState();
      return renderAllRows(source, groupKey || 'all');
    }

    if (activeTab === 'audit') {
      const source = items || filteredAuditLogs;
      if (source.length === 0) return renderEmptyState();
      return renderAuditRows(source, groupKey || 'audit');
    }

    if (activeTab === 'login') {
      const source = items || filteredLoginLogs;
      if (source.length === 0) return renderEmptyState();
      return renderLoginRows(source);
    }
    return renderEmptyState();
  };

  return (
    <div className="admin-page-container">
      <div className="page-toolbar-row">
        <div className="page-title-cell">
          {embeddedMode !== 'central' && <h2>NHẬT KÝ</h2>}
        </div>

        <div className="page-toolbar-group">
          {isCentralMode && (
            <div className="page-toolbar-cell" style={{ height: 28 }}>
              <span className="page-cell-label">TRẠM:</span>
              <ToolbarSelect
                value={filterStation}
                onChange={setFilterStation}
                options={[{ value: '', label: `Tất cả (${stationsList.length})` }, ...stationsList.map(s => ({ value: s.id, label: s.name }))]}
                width={140}
              />
            </div>
          )}

          <DateRangePicker
            startDate={startDate}
            endDate={endDate}
            onChange={(s, e) => { setStartDate(s); setEndDate(e); }}
          />

          <div className="page-toolbar-cell" style={{ height: 28 }}>
            <span className="page-cell-label">LOẠI:</span>
            <ToolbarSelect
              value={activeTab}
              onChange={(v: string) => setActiveTab(v as TabId)}
              options={[
                { value: 'all', label: 'Tất cả nhật ký' },
                { value: 'audit', label: 'Hành động hệ thống' },
                { value: 'login', label: 'Nhật ký đăng nhập' },
              ]}
              width={140}
            />
          </div>

          <div className="page-toolbar-cell" style={{ height: 28 }}>
            <span className="page-cell-label">HÀNH ĐỘNG:</span>
            <ToolbarSelect
              value={filterAction}
              onChange={setFilterAction}
              options={[
                { value: '', label: 'Tất cả' },
                { value: 'create', label: 'Tạo mới' },
                { value: 'update', label: 'Cập nhật' },
                { value: 'delete', label: 'Xóa' },
                { value: 'login', label: 'Đăng nhập' },
                { value: 'logout', label: 'Đăng xuất' },
                { value: 'failed', label: 'Thất bại' },
              ]}
              width={110}
            />
          </div>
        </div>
      </div>

      <div className="admin-card" style={{ padding: 0, overflow: 'hidden', flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: shouldGroupByStation ? 12 : 0 }}>
          {shouldGroupByStation ? (
            groupedStations.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {groupedStations.map(group => (
                  <div key={group.id} className="admin-card" style={{ padding: 0, overflow: 'hidden' }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      background: 'var(--admin-layer-1)',
                      borderBottom: '1px solid var(--admin-border-subtle)'
                    }}>
                      <strong style={{ fontSize: '.84rem', letterSpacing: '.04em' }}>{group.name}</strong>
                      <span style={{ color: 'var(--admin-text-muted)', fontSize: '.72rem' }}>{group.items.length} bản ghi</span>
                    </div>
                    <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead style={{ background: 'var(--admin-layer-1)' }}>
                        {renderTableHead()}
                      </thead>
                      <tbody>
                        {renderTableBody(group.items, `station-${group.id}-${activeTab}`)}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            ) : (
              <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {renderTableBody()}
                </tbody>
              </table>
            )
          ) : (
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--admin-layer-1)' }}>
                {renderTableHead()}
              </thead>
              <tbody>
                {renderTableBody()}
              </tbody>
            </table>
          )}
        </div>

        {selectedDetail && (
          <aside className="audit-inline-detail">
            <div className="audit-detail-drawer-header" style={{ borderBottom: '1px solid var(--admin-border-subtle, #1a2235)' }}>
              <div>
                <div className="audit-detail-drawer-kicker">CHI TIẾT NHẬT KÝ</div>
                <div className="audit-detail-drawer-title">{selectedDetail.title}</div>
              </div>
              <button className="audit-detail-close" onClick={closeDetail} aria-label="Đóng chi tiết">×</button>
            </div>

            <div className="audit-detail-drawer-body">
              <div className="audit-detail-story">
                <div className="audit-detail-story__headline">{buildDetailNarrative(selectedDetail)}</div>
                <div className="audit-detail-story__subline">
                  Ghi nhận lúc {selectedDetail.ts ? fmtDateTime(selectedDetail.ts) : '—'}{selectedDetail.ipAddress ? ` · IP ${selectedDetail.ipAddress}` : ''}
                </div>
              </div>

              <div className="audit-detail-grid">
                <div className="audit-detail-card">
                  <span>Người thực hiện</span>
                  <strong>{selectedDetail.who || '—'}</strong>
                </div>
                <div className="audit-detail-card">
                  <span>Trạm</span>
                  <strong>{selectedDetail.stationName || 'Trung tâm đa trạm'}</strong>
                </div>
                <div className="audit-detail-card">
                  <span>Hành động</span>
                  <strong>{actionLabel(selectedDetail.action)}</strong>
                </div>
                <div className="audit-detail-card">
                  <span>Đối tượng</span>
                  <strong>{entityLabel(selectedDetail.entityType ?? null)}</strong>
                </div>
                <div className="audit-detail-card">
                  <span>Địa chỉ IP</span>
                  <strong>{selectedDetail.ipAddress || '—'}</strong>
                </div>
              </div>

              <div className="audit-detail-section">
                <div className="audit-detail-section-title">NGƯỜI DÙNG ĐÃ LÀM GÌ</div>
                <div className="audit-detail-content">
                  {getHumanReadableChanges(
                    selectedDetail.entityType,
                    selectedDetail.action,
                    selectedDetail.oldValue,
                    selectedDetail.newValue
                  )}
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>

      <div className="audit-footer" style={{ marginTop: 8 }}>
        <span>Nhật ký thời gian thực — không thể sửa đổi</span>
        <span>{getRecordCount()} bản ghi</span>
      </div>
    </div>
  );
}
