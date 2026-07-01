// ============================================================
// DeviceService.ts — Quản lý thiết bị (PLC, Camera, Sensor...)
// Endpoints: /stations/:id/devices, /devices, /protocol
// Hỗ trợ: CRUD, kiểm tra kết nối, quét LAN, ONVIF, Hikvision, auto-configure
// Export: deviceService (singleton), dùng qua StationApiService facade
// ============================================================

import { apiFetch, apiMutate, API_BASE } from './BaseApiService';
import { authService } from '../AuthService';
import type { Device, CameraDevice, RoiPoint, Boundary } from '@/types/api.types';
import { AI_ENGINE_URL } from '@/utils/env';

export class DeviceService {
  /** Lấy danh sách thiết bị của trạm. config JSON được parse tự động. */
  async getDevices(stationId?: string, type?: string): Promise<Device[]> {
    const q = type ? `?type=${type}` : '';
    const url = stationId ? `/stations/${stationId}/devices${q}` : `/devices${q}`;
    const raw = await apiFetch<any[]>(url);
    return raw.map(d => ({
      ...d,
      config: typeof d.config === 'string' ? JSON.parse(d.config) : (d.config ?? {})
    })) as Device[];
  }

  /** Tạo thiết bị mới cho trạm. config là JSON string (stringify trước khi gửi). */
  async createDevice(data: {
    stationId: string; name: string; type: string;
    protocol?: string; config?: string;
  }): Promise<Device> {
    return apiMutate('POST', '/devices', data);
  }

  /** Cập nhật tên, cấu hình, hoặc trạng thái thiết bị. */
  async updateDevice(id: string, data: { name?: string; config?: string; status?: string }): Promise<Device> {
    return apiMutate('PUT', `/devices/${id}`, data);
  }

  /** Xóa thiết bị. Cẩn thận: xóa luôn lịch sử sensor liên quan. */
  async deleteDevice(id: string): Promise<void> {
    return apiMutate('DELETE', `/devices/${id}`);
  }

  /** Kiểm tra kết nối tới thiết bị — trả về latency và trạng thái. */
  async testConnection(id: string): Promise<{ success: boolean; message: string; latencyMs: number }> {
    return apiMutate('POST', `/devices/${id}/test`);
  }

  /** Lấy credentials đã giải mã (username + password) — chỉ dùng trong UI admin. */
  async getCredentials(id: string): Promise<{ username: string; password: string }> {
    return apiFetch(`/devices/${id}/credentials`);
  }

  /** Lấy danh sách camera (lọc devices theo type=camera). */
  async getCameras(stationId: string): Promise<CameraDevice[]> {
    const devices = await this.getDevices(stationId, 'camera');
    return devices as CameraDevice[];
  }

  /** Quét subnet để phát hiện thiết bị mạng. Ví dụ subnet: "192.168.1.0/24". */
  async scanLan(subnet: string): Promise<any> {
    return apiFetch(`/devices/scan?subnet=${encodeURIComponent(subnet)}`);
  }

  /** Phát hiện camera ONVIF trong mạng nội bộ qua WS-Discovery. */
  async discoverOnvif(): Promise<any> {
    return apiFetch('/protocols/discover-onvif');
  }

  /** Kiểm tra kết nối giao thức (ONVIF, Modbus, ...) trước khi tạo thiết bị. */
  async testProtocolConnection(ip: string, port: number, protocol: string, config?: string): Promise<{ success: boolean; message: string; latencyMs?: number }> {
    return apiMutate('POST', '/protocols/test-connection', { protocol, config: config || JSON.stringify({ ip, port }) });
  }

  /** Phát hiện và lấy thông tin camera Hikvision theo IP. */
  async discoverHikvision(ip: string, username: string, password: string): Promise<any> {
    return apiMutate('POST', '/devices/discover', { ip, username, password });
  }

  /** Tự động cấu hình và tạo toàn bộ channel camera từ một đầu ghi Hikvision/ONVIF. */
  async autoConfigure(stationId: string, ip: string, username: string, password: string, namePrefix?: string): Promise<{
    created: Array<{ id: string; name: string; type: string; streamId: string }>;
    capabilities: any;
  }> {
    return apiMutate('POST', '/devices/auto-configure', { stationId, ip, username, password, namePrefix });
  }

  /** Import danh sách tủ điện từ file CSV/Excel. */
  async importCabinetTemplate(data: {
    stationId: string;
    ip: string;
    cabinetName?: string;
    file: File;
    rack?: number;
    slot?: number;
    db?: number;
  }): Promise<{
    success: boolean;
    message: string;
    created: Array<{ deviceId: string; name: string; points: number }>;
    updated: Array<{ deviceId: string; name: string; points: number }>;
    totalGroups: number;
  }> {
    const token = authService.getToken();
    const form = new FormData();
    form.append('stationId', data.stationId);
    form.append('ip', data.ip);
    if (data.cabinetName) form.append('CabinetName', data.cabinetName);
    form.append('rack', String(data.rack ?? 0));
    form.append('slot', String(data.slot ?? 1));
    if (data.db !== undefined && data.db !== null) form.append('db', String(data.db));
    form.append('file', data.file);

    const res = await fetch(`${API_BASE}/cabinet-import`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Import failed ${res.status}`);
    }

    return res.json();
  }

  // ── ROI Points (điểm chấm nhiệt trên camera nhiệt) ────────────

  async getRoiPoints(deviceId: string): Promise<RoiPoint[]> {
    const points = await apiFetch<RoiPoint[]>(`/devices/${deviceId}/roi-points`);
    return points.map(pt => ({
      ...pt,
      label: pt.label || pt.name || '',
      warningThreshold: pt.warningThreshold ?? pt.preAlarmThreshold,
      x: pt.x ?? (pt.tx ?? 0) * 100,
      y: pt.y ?? (pt.ty ?? 0) * 100,
    }));
  }

  async createRoiPoint(deviceId: string, data: Omit<RoiPoint, 'id'>): Promise<RoiPoint> {
    const txVal = data.tx !== undefined ? data.tx : (data.x !== undefined ? data.x / 100 : 0);
    const tyVal = data.ty !== undefined ? data.ty : (data.y !== undefined ? data.y / 100 : 0);
    const oxVal = data.ox !== undefined ? data.ox : (data.x !== undefined ? data.x / 100 : txVal);
    const oyVal = data.oy !== undefined ? data.oy : (data.y !== undefined ? data.y / 100 : tyVal);

    const payload = {
      name: data.label || data.name,
      tx: txVal,
      ty: tyVal,
      ox: oxVal,
      oy: oyVal,
      pointId: data.pointId,
      preAlarmThreshold: data.warningThreshold ?? data.preAlarmThreshold,
      alarmThreshold: data.alarmThreshold,
      sortOrder: data.sortOrder,
      color: data.color,
    };
    const pt = await apiMutate<any>('POST', `/devices/${deviceId}/roi-points`, payload);
    return {
      ...pt,
      label: pt.label || pt.name || '',
      warningThreshold: pt.warningThreshold ?? pt.preAlarmThreshold,
      x: pt.x ?? (pt.tx ?? 0) * 100,
      y: pt.y ?? (pt.ty ?? 0) * 100,
    };
  }

  async updateRoiPoint(deviceId: string, roiId: string, data: Partial<Omit<RoiPoint, 'id'>>): Promise<RoiPoint> {
    const txVal = data.tx !== undefined ? data.tx : (data.x !== undefined ? data.x / 100 : undefined);
    const tyVal = data.ty !== undefined ? data.ty : (data.y !== undefined ? data.y / 100 : undefined);
    const oxVal = data.ox !== undefined ? data.ox : (data.x !== undefined ? data.x / 100 : undefined);
    const oyVal = data.oy !== undefined ? data.oy : (data.y !== undefined ? data.y / 100 : undefined);

    const payload = {
      name: data.label || data.name,
      tx: txVal,
      ty: tyVal,
      ox: oxVal !== undefined ? oxVal : txVal,
      oy: oyVal !== undefined ? oyVal : tyVal,
      pointId: data.pointId,
      preAlarmThreshold: data.warningThreshold ?? data.preAlarmThreshold,
      alarmThreshold: data.alarmThreshold,
      sortOrder: data.sortOrder,
      color: data.color,
    };
    const pt = await apiMutate<any>('PUT', `/devices/${deviceId}/roi-points/${roiId}`, payload);
    return {
      ...pt,
      label: pt.label || pt.name || '',
      warningThreshold: pt.warningThreshold ?? pt.preAlarmThreshold,
      x: pt.x ?? (pt.tx ?? 0) * 100,
      y: pt.y ?? (pt.ty ?? 0) * 100,
    };
  }

  async deleteRoiPoint(deviceId: string, roiId: string): Promise<void> {
    return apiMutate('DELETE', `/devices/${deviceId}/roi-points/${roiId}`);
  }

  // Lấy nhiệt độ hiện tại tại tất cả ROI points của camera
  async getThermalReadings(deviceId: string): Promise<Record<string, number>> {
    return apiFetch<Record<string, number>>(`/devices/${deviceId}/thermal-readings`);
  }

  // Lấy ảnh snapshot tĩnh từ camera (dùng trong Analytics)
  async getCameraSnapshot(deviceId: string): Promise<{ url: string; capturedAt: string }> {
    return apiFetch<{ url: string; capturedAt: string }>(`/devices/${deviceId}/snapshot`);
  }

  // Lấy thông số VisibleValidRect từ camera qua backend
  async getThermalMapping(deviceId: string): Promise<{ x: number; y: number; width: number; height: number }> {
    return apiFetch<{ x: number; y: number; width: number; height: number }>(`/devices/${deviceId}/thermal-mapping`);
  }

  /** Đồng bộ cấu hình điểm & vùng đo nhiệt sang AI Engine. */
  async syncThermalConfig(deviceId: string, points: RoiPoint[], boundaries: Boundary[]): Promise<void> {
    const devices = await apiFetch<any[]>(`/devices`); // Lấy list device để lấy config (ip, auth)
    const d = devices.find(x => x.id === deviceId);
    if (!d) return;

    const cfg = typeof d.config === 'string' ? JSON.parse(d.config) : (d.config ?? {});
    const streamId = cfg.go2rtc_thermal || cfg.go2rtc_id;
    if (!streamId) return;

    const payload = {
      stream_id: streamId,
      device_id: deviceId,
      camera_ip: cfg.ip,
      username: cfg.username || 'admin',
      password: cfg.password || '',
      points: points.map(pt => ({
        id: pt.pointId || pt.id,
        x: pt.tx ?? (pt.x ? pt.x / 100 : 0.5),
        y: pt.ty ?? (pt.y ? pt.y / 100 : 0.5),
        pre_alarm: pt.warningThreshold ?? pt.preAlarmThreshold ?? 50,
        alarm: pt.alarmThreshold ?? 70,
        label: pt.label || pt.name || ''
      })),
      zones: boundaries.map(b => {
        const thresholds = typeof b.thresholds === 'string' ? JSON.parse(b.thresholds) : (b.thresholds ?? {});
        return {
          id: b.id,
          polygon: typeof b.polygon === 'string' ? JSON.parse(b.polygon) : (b.polygon ?? []),
          pre_alarm: thresholds.warning || thresholds.preAlarm || 50,
          alarm: thresholds.alarm || 70,
          label: b.name
        };
      })
    };

    try {
      await fetch(`${AI_ENGINE_URL}/config/thermal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.warn('[AI Engine] Sync failed:', err);
    }
  }

  async getRelated(deviceId: string): Promise<any> {
    const { apiFetch } = await import('./BaseApiService');
    return apiFetch(`/devices/${deviceId}/related`);
  }
}

export const deviceService = new DeviceService();
