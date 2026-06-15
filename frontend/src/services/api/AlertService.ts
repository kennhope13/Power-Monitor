// ============================================================
// AlertService.ts — Quản lý cảnh báo hệ thống
// Endpoints: GET /alerts, POST /alerts/:id/ack|close, GET /alerts/:id
// Export: alertService (singleton), dùng qua StationApiService facade
// ============================================================

import { apiFetch, apiMutate, API_BASE } from './BaseApiService';
import { authService } from '../AuthService';
import type { AlertItem, AlertHistoryEntry } from '@/types/api.types';

export class AlertService {
  /** Lấy danh sách cảnh báo. Lọc theo status (open/acked/closed), khoảng thời gian, giới hạn số lượng. */
  async getAlerts(status?: string, from?: string, to?: string, limit = 200): Promise<AlertItem[]> {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (from)   params.set('from', from);
    if (to)     params.set('to', to);
    params.set('limit', String(limit));
    return apiFetch<AlertItem[]>(`/alerts?${params.toString()}`);
  }

  /** Xác nhận (acknowledge) cảnh báo — chuyển sang trạng thái "acked". */
  async ackAlert(id: string, note?: string): Promise<void> {
    return apiMutate('POST', `/alerts/${id}/ack`, { note });
  }

  /** Đóng cảnh báo — chuyển sang trạng thái "closed". */
  async closeAlert(id: string): Promise<void> {
    return apiMutate('POST', `/alerts/${id}/close`);
  }

  /** Gửi cảnh báo thủ công lên trạm tổng. */
  async sendCentral(id: string): Promise<void> {
    return apiMutate('POST', `/alerts/${id}/send-central`);
  }

  /** Chi tiết cảnh báo kèm lịch sử thay đổi trạng thái. */
  async getAlertDetail(id: string): Promise<AlertItem & { history: AlertHistoryEntry[] }> {
    return apiFetch(`/alerts/${id}`);
  }

  /** Xuất danh sách cảnh báo ra file CSV. Trả về Blob để trigger download. */
  async exportCsv(opts?: { status?: string; from?: string; to?: string }): Promise<Blob> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.from)   params.set('from', opts.from);
    if (opts?.to)     params.set('to', opts.to);
    const token = authService.getToken();
    const res = await fetch(`${API_BASE}/alerts/export?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return res.blob();
  }
}

export const alertService = new AlertService();
