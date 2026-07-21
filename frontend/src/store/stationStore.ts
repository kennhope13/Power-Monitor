// ============================================================
// stationStore.ts — Cache danh sách Station global
// Trang dashboard, reports, maintenance, multisite... đều dùng chung
// TTL 60s (station ít thay đổi). Gọi invalidate() để force refetch.
// ============================================================

import { create } from 'zustand';
import { stationService } from '@/services/api/StationService';
import type { Station } from '@/types/api.types';
import { useAuthStore } from './authStore';
import { isCentralUser, MULTISITE_DRILL_STATION_KEY } from '@/utils/centralAccess';

const STALE_MS = 60_000;

interface StationStore {
  stations: Station[];
  isLoading: boolean;
  lastFetchedAt: number | null;
  error: string | null;
  // Global admin drill-down: ID trạm con đang được xem từ màn hình đa trạm
  viewingStationId: string | null;
  fetch: (force?: boolean) => Promise<Station[]>;
  invalidate: () => void;
  getFirstStationId: () => Promise<string | null>;
  setViewingStation: (id: string | null) => void;
}

let inflight: Promise<Station[]> | null = null;

export const useStationStore = create<StationStore>((set, get) => ({
  stations: [],
  isLoading: false,
  lastFetchedAt: null,
  error: null,
  viewingStationId: localStorage.getItem(MULTISITE_DRILL_STATION_KEY) ?? null,

  fetch: async (force = false) => {
    const state = get();
    const isFresh = state.lastFetchedAt && (Date.now() - state.lastFetchedAt) < STALE_MS;
    if (!force && isFresh) return state.stations;
    if (inflight) return inflight;

    set({ isLoading: true, error: null });
    inflight = stationService.getStations()
      .then(stations => {
        set({ stations, isLoading: false, lastFetchedAt: Date.now() });
        if (stations.length > 0 && !localStorage.getItem('selected_station_id')) {
          const firstId = stations[0]?.id;
          if (firstId) {
            localStorage.setItem('selected_station_id', firstId);
          }
        }
        return stations;
      })
      .catch(err => {
        set({ isLoading: false, error: String(err) });
        throw err;
      })
      .finally(() => { inflight = null; });
    return inflight;
  },

  invalidate: () => set({ lastFetchedAt: null }),

  setViewingStation: (id) => {
    if (id) {
      localStorage.setItem(MULTISITE_DRILL_STATION_KEY, id);
      localStorage.setItem('selected_station_id', id);
    } else {
      localStorage.removeItem(MULTISITE_DRILL_STATION_KEY);
    }
    set({ viewingStationId: id });
  },

  getFirstStationId: async () => {
    const saved = localStorage.getItem('selected_station_id');
    const stations = await get().fetch();
    const user = useAuthStore.getState().user;
    // Global admin đang drill-down: tôn trọng selected_station_id
    if (isCentralUser(user)) {
      if (saved && stations.some(s => s.id === saved)) return saved;
      if (stations.length === 0) return null;
      const first = stations[0]?.id ?? null;
      if (first) localStorage.setItem('selected_station_id', first);
      return first;
    }

    if (saved && stations.some(s => s.id === saved)) return saved;
    const defaultId = stations[0]?.id ?? null;
    if (defaultId) localStorage.setItem('selected_station_id', defaultId);
    return defaultId;
  },
}));
