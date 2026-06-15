// ============================================================
// AuditLogPage.tsx — Nhật ký hoạt động hệ thống
// Tab: Tất cả | Hành động | Đăng nhập | Thông báo | Quy tắc kích hoạt
// Dữ liệu không thể sửa đổi (immutable) — chỉ đọc
// ============================================================

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { stationApi, Station, Device } from '@/services/StationApiService';
import { authService } from '@/services/AuthService';
import { isCentralUser } from '@/utils/centralAccess';
import { fmtDateTime, fmtTimeRange } from '@/utils/format';
import ToolbarSelect from '@/components/ui/ToolbarSelect';
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
  const [timeRange, setTimeRange] = useState('all');
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<LogItem[]>([]);       // log đã gộp + chuẩn hóa
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loginLogs, setLoginLogs] = useState<any[]>([]);

  const currentUser = authService.getUser();
  const isCentralMode = isCentralUser(currentUser);

  const [stationsList, setStationsList] = useState<Station[]>([]);
  const [devicesList, setDevicesList] = useState<Device[]>([]);
  const [filterStation, setFilterStation] = useState<string>(stationIdOverride || '');

  // Theo dõi dòng nào đang mở rộng để xem raw JSON
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  // Tính khoảng thời gian from/to từ preset (today/7d/...) — memo tránh tính lại
  const dates = useMemo(() => fmtTimeRange(timeRange), [timeRange]);

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => ({ ...prev, [id]: !prev[id] }));
  };

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

  // Format chuỗi JSON từ oldValue/newValue để hiển thị dễ đọc
  const prettyFormat = (raw: string | null): string => {
    if (!raw) return '(trống)';
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
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

    const translateKey = (k: string): string => {
      const keys: Record<string, string> = {
        name: 'Tên quy tắc / Tên điểm',
        pointId: 'Mã điểm đo',
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
      if (v === null || v === undefined) return '(trống)';
      if (typeof v === 'boolean') return v ? 'Đang bật / Hoạt động' : 'Tắt / Ngừng hoạt động';
      if (k === 'role') {
        if (v === 'admin') return 'Quản trị viên hệ thống';
        if (v === 'manager') return 'Quản lý trạm con';
        if (v === 'operator') return 'Nhân viên vận hành';
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
        return (
          <pre style={{
            margin: 0, fontSize: '0.68rem',
            color: 'var(--admin-text-muted)',
            maxHeight: 100, overflow: 'auto',
            background: 'var(--admin-layer-1)',
            padding: '4px 8px', borderRadius: 3,
            whiteSpace: 'pre-wrap', wordBreak: 'break-all'
          }}>
            {JSON.stringify(v, null, 2)}
          </pre>
        );
      }
      if (typeof v === 'object' && v !== null) {
        return (
          <pre style={{
            margin: 0, fontSize: '0.68rem',
            color: 'var(--admin-text-muted)',
            maxHeight: 100, overflow: 'auto',
            background: 'var(--admin-layer-1)',
            padding: '4px 8px', borderRadius: 3,
            whiteSpace: 'pre-wrap', wordBreak: 'break-all'
          }}>
            {JSON.stringify(v, null, 2)}
          </pre>
        );
      }
      return String(v);
    };

    // Trường hợp tạo mới (create) hoặc không có oldValue
    if (action.toLowerCase() === 'create' || !oldVal) {
      if (!newVal) return <span style={{ color: 'var(--admin-text-muted)' }}>Không có thông tin chi tiết.</span>;

      const filteredNewVal = Object.entries(newVal).filter(([k]) => !ignoredKeys.has(k.toLowerCase()));

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
                  <td className="detail-key">{translateKey(k)}</td>
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

      const filteredOldVal = Object.entries(oldVal).filter(([k]) => !ignoredKeys.has(k.toLowerCase()));

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
                  <td className="detail-key">{translateKey(k)}</td>
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

    for (const k of allKeys) {
      if (ignoredKeys.has(k.toLowerCase())) continue;

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

    if (changes.length === 0) {
      return <span style={{ color: 'var(--admin-text-muted)' }}>Cập nhật các thuộc tính hệ thống.</span>;
    }

    return (
      <table className="detail-changes-table">
        <thead>
          <tr>
            <th>Thuộc tính thay đổi</th>
            <th>Giá trị cũ</th>
            <th>Giá trị mới</th>
          </tr>
        </thead>
        <tbody>
          {changes.map(c => (
            <tr key={c.key}>
              <td className="detail-key">{translateKey(c.key)}</td>
              <td className="detail-val-old">{translateValue(c.key, c.oldV)}</td>
              <td className="detail-val-new">{translateValue(c.key, c.newV)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
    setExpandedIds({});
    
    const from = dates.from ? new Date(dates.from).toISOString() : undefined;
    const to = dates.to ? new Date(dates.to + 'T23:59:59').toISOString() : undefined;
    const params = { from, to, limit: 100, stationId: filterStation || undefined };

    try {
      if (activeTab === 'all') {
        const [audit, logins] = await Promise.all([
          stationApi.getAuditLogs(params),
          stationApi.getLoginLogs(params)
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
        const data = await stationApi.getAuditLogs({ ...params, limit: 200 });
        setAuditLogs(data);
      } else if (activeTab === 'login') {
        const data = await stationApi.getLoginLogs(params);
        setLoginLogs(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [activeTab, dates, filterStation]);

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
          <th className="col-who">Đối tượng</th>
          <th className="col-view">Xem</th>
        </tr>
      );
    }
    if (activeTab === 'audit') {
      return (
        <tr>
          <th className="col-time">Thời gian</th>
          <th className="col-action">Hành động</th>
          {isCentralMode && <th className="col-station">Trạm</th>}
          <th className="col-event">Đối tượng tác động</th>
          <th className="col-who">Người thực hiện</th>
          <th className="col-view">Xem</th>
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
    if (activeTab === 'all') return logs.length;
    if (activeTab === 'audit') return auditLogs.length;
    return loginLogs.length;
  };

  const renderAllRows = (items: LogItem[], keyPrefix = 'all') => items.map((m, idx) => {
    const rowId = `${keyPrefix}-${idx}`;
    const hasDetail = m.type === 'audit';
    const isExpanded = !!expandedIds[rowId];

    return (
      <React.Fragment key={rowId}>
        <tr>
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
            {m.info} <small style={{ color: 'var(--admin-text-muted)', fontWeight: 'normal' }}>({actionLabel(m.action)})</small>
          </td>
          <td className="col-who">{m.who || 'system'}</td>
          <td className="col-view" style={{ textAlign: 'center' }}>
            {hasDetail ? (
              <button className="expanding-btn" onClick={() => toggleExpand(rowId)}>
                {isExpanded ? '▲' : '▼'}
              </button>
            ) : '—'}
          </td>
        </tr>
        {hasDetail && isExpanded && (
          <tr className="audit-detail-row">
            <td colSpan={isCentralMode ? 6 : 5} style={{ padding: 16 }}>
              {getHumanReadableChanges(m.raw.entityType, m.raw.action, m.raw.oldValue, m.raw.newValue)}
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  });

  const renderAuditRows = (items: any[], keyPrefix = 'audit') => items.map((l, idx) => {
    const rowId = `${keyPrefix}-${idx}`;
    const isExpanded = !!expandedIds[rowId];
    return (
      <React.Fragment key={rowId}>
        <tr>
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
          <td className="col-event">
            {entityLabel(l.entityType)}{' '}
            <small style={{ color: 'var(--admin-text-muted)', fontSize: '0.7rem' }}>{l.entityId?.slice(0, 8) || ''}</small>
          </td>
          <td className="col-who">{l.fullName || l.username || 'system'}</td>
          <td className="col-view" style={{ textAlign: 'center' }}>
            <button className="expanding-btn" onClick={() => toggleExpand(rowId)}>
              {isExpanded ? '▲' : '▼'}
            </button>
          </td>
        </tr>
        {isExpanded && (
          <tr className="audit-detail-row">
            <td colSpan={isCentralMode ? 6 : 5} style={{ padding: 16 }}>
              {getHumanReadableChanges(l.entityType, l.action, l.oldValue, l.newValue)}
            </td>
          </tr>
        )}
      </React.Fragment>
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

    if (activeTab === 'all') return groupItems(logs);
    if (activeTab === 'audit') return groupItems(auditLogs);
    if (activeTab === 'login') return groupItems(loginLogs);
    return groupItems(loginLogs);
  }, [activeTab, auditLogs, loginLogs, logs, shouldGroupByStation]);

  const renderEmptyState = () => {
    const colSpan = activeTab === 'all' || activeTab === 'audit'
      ? (isCentralMode ? 6 : 5)
      : (isCentralMode ? 5 : 4);

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
          <td colSpan={isCentralMode ? 6 : 5} style={{ textAlign: 'center', padding: 60, color: 'var(--admin-text-muted)' }}>
            Đang tải dữ liệu...
          </td>
        </tr>
      );
    }

    const items = groupItems;

    if (activeTab === 'all') {
      const source = items || logs;
      if (source.length === 0) return renderEmptyState();
      return renderAllRows(source, groupKey || 'all');
    }

    if (activeTab === 'audit') {
      const source = items || auditLogs;
      if (source.length === 0) return renderEmptyState();
      return renderAuditRows(source, groupKey || 'audit');
    }

    if (activeTab === 'login') {
      const source = items || loginLogs;
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
            <span className="page-cell-label">THỜI GIAN:</span>
            <ToolbarSelect
              value={timeRange}
              onChange={setTimeRange}
              options={[
                { value: 'today', label: 'Hôm nay' },
                { value: 'yesterday', label: 'Hôm qua' },
                { value: '7d', label: '7 ngày qua' },
                { value: '30d', label: '30 ngày qua' },
                { value: 'all', label: 'Tất cả lịch sử' },
              ]}
              width={110}
            />
          </div>

          <button 
            className="btn-industrial btn-primary" 
            style={{ height: 28, padding: '0 12px', fontSize: '.72rem', fontWeight: 800 }}
            onClick={loadData}
          >
            ↻ LÀM MỚI
          </button>
        </div>
      </div>

      <div className="admin-card" style={{ padding: 0, overflow: 'hidden', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: shouldGroupByStation ? 12 : 0 }}>
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
      </div>

      <div className="audit-footer" style={{ marginTop: 8 }}>
        <span>Nhật ký thời gian thực — không thể sửa đổi</span>
        <span>{getRecordCount()} bản ghi</span>
      </div>
    </div>
  );
}
