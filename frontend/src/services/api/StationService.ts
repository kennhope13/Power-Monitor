// ============================================================
// StationService.ts — Quản lý danh sách trạm điện (Station)
// Endpoints: GET /stations
// Một hệ thống có thể có nhiều trạm (multisite); mỗi trạm có id riêng
// Export: stationService (singleton), dùng qua StationApiService facade
// ============================================================

import { apiFetch, apiMutate } from './BaseApiService';
import type { Station } from '@/types/api.types';

export class StationService {
  /** Lấy danh sách tất cả trạm điện đang quản lý. */
  async getStations(): Promise<Station[]> {
    return apiFetch<Station[]>('/stations');
  }

  /** Lấy id của trạm đầu tiên — dùng khi URL không chứa stationId. */
  async getFirstStationId(): Promise<string | null> {
    const stations = await this.getStations();
    if (stations.length === 0) return null;
    return stations[0]?.id ?? null;
  }

  /** Tạo trạm mới. */
  async createStation(name: string, code: string, location: string): Promise<Station> {
    return apiMutate<Station>('POST', '/stations', { name, code, location });
  }

  /** Cập nhật trạm. */
  async updateStation(id: string, name: string, code?: string, location?: string, status?: string): Promise<Station> {
    return apiMutate<Station>('PUT', `/stations/${id}`, { name, code, location, status });
  }

  /** Xóa trạm. */
  async deleteStation(id: string): Promise<void> {
    return apiMutate<void>('DELETE', `/stations/${id}`);
  }
}

export const stationService = new StationService();
