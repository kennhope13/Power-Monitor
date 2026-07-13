// ============================================================
// SystemService.ts — Cài đặt hệ thống, người dùng, cloud sync, license
// Endpoints: /users, /settings, /sync, /notifications, /detections, /license
// Gộp các API quản trị hệ thống không thuộc domain cụ thể nào
// Export: systemService (singleton), dùng qua StationApiService facade
// ============================================================

import { apiFetch, apiMutate } from './BaseApiService';
import { authService } from '../AuthService';
import { API_BASE_URL } from '@/utils/env';
import type { UserItem, SmtpConfig, SyncStatus } from '@/types/api.types';

export class SystemService {
  // ── Users ─────────────────────────────────────────────────

  /** Lấy danh sách tài khoản người dùng. */
  async getUsers(): Promise<UserItem[]> {
    return apiFetch<UserItem[]>('/users');
  }

  /** Tạo tài khoản mới. data cần có username, password, role, fullname. */
  async createUser(data: any): Promise<UserItem> {
    return apiMutate('POST', '/users', data);
  }

  /** Cập nhật thông tin hoặc role của người dùng. */
  async updateUser(id: string, data: any): Promise<UserItem> {
    return apiMutate('PUT', `/users/${id}`, data);
  }

  /** Vô hiệu hóa tài khoản (soft delete). */
  async deleteUser(id: string): Promise<void> {
    return apiMutate('DELETE', `/users/${id}`);
  }

  /** Đổi mật khẩu. Admin không cần oldPassword; user thường thì cần. */
  async changePassword(id: string, data: { oldPassword?: string; newPassword: string }): Promise<{ message: string }> {
    return apiMutate('POST', `/users/${id}/change-password`, data);
  }

  // ── Settings ──────────────────────────────────────────────

  /** Lấy toàn bộ cài đặt hệ thống dạng key-value string. */
  async getSettings(): Promise<Record<string, string>> {
    return apiFetch<Record<string, string>>('/settings');
  }

  /** Cập nhật một setting theo key. Ví dụ key: "smtp.host", value: "smtp.gmail.com". */
  async updateSetting(key: string, value: string): Promise<any> {
    return apiMutate('PUT', `/settings/${key}`, { value });
  }

  // ── Cloud Sync ────────────────────────────────────────────

  /** Trạng thái đồng bộ cloud: lần sync cuối, lỗi nếu có. */
  async getSyncStatus(): Promise<SyncStatus> {
    return apiFetch<SyncStatus>('/sync/status');
  }

  /** Kích hoạt đồng bộ cloud ngay lập tức (không chờ schedule). */
  async triggerSync(): Promise<any> {
    return apiMutate('POST', '/sync/trigger');
  }

  // ── Notifications ─────────────────────────────────────────

  /** Lấy cấu hình SMTP hiện tại để điền vào form cài đặt. */
  async getSmtpConfig(): Promise<SmtpConfig> {
    return apiFetch<SmtpConfig>('/notifications/smtp-config');
  }

  /** Gửi email test để kiểm tra cấu hình SMTP. */
  async sendTestEmail(email: string): Promise<{ message: string }> {
    return apiMutate('POST', '/notifications/test-email', { email });
  }

  // ── Detections ────────────────────────────────────────────

  /** Lấy danh sách sự kiện phát hiện (AI/camera). queryString truyền thẳng vào URL. */
  async getDetections(queryString: string): Promise<any[]> {
    return apiFetch(`/detections?${queryString}`);
  }

  // ── License ───────────────────────────────────────────────

  /** Trạng thái license: hợp lệ/hết hạn, số ngày còn lại, module được phép. */
  async getLicenseStatus(): Promise<any> {
    return apiFetch('/license/status');
  }

  /** Thông tin fingerprint để tạo file .lic. */
  async getLicenseRequest(): Promise<any> {
    return apiFetch('/license/request');
  }

  /** Kích hoạt license bằng key. */
  async activateLicense(key: string): Promise<any> {
    return apiMutate('POST', '/license/activate', { key });
  }

  /** Import file .lic. */
  async importLicense(file: File): Promise<any> {
    const token = authService.getToken();
    const form = new FormData();
    form.append('file', file, file.name);

    const res = await fetch(`${API_BASE_URL}/api/v1/license/import`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `POST /license/import → ${res.status}`);
    }

    return res.json();
  }
}

export const systemService = new SystemService();
