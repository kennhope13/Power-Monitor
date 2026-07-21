// ============================================================
// station-setup.ts — Helpers cho cấu hình trạm ban đầu
// Dùng để nhận biết tên trạm mặc định/chưa cấu hình và đọc giá trị lưu cục bộ.
// ============================================================

const DEFAULT_STATION_LABELS = [
  'TRẠM ĐIỆN',
  'TRAM DIEN',
  'TRẠM MẶC ĐỊNH',
  'TRAM MAC DINH',
  'STATIONOS',
  'CẦN CẤU HÌNH TRẠM',
  'CAN CAU HINH TRAM',
  'CHƯA CẤU HÌNH',
  'CHUA CAU HINH',
];

const normalizeText = (value: string): string => value
  .trim()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[đĐ]/g, 'D')
  .replace(/\s+/g, ' ')
  .toUpperCase();

export const getStoredStationName = (): string => {
  if (typeof window === 'undefined' || !window.localStorage) return '';
  return window.localStorage.getItem('station_name')?.trim() || '';
};

export const hasStoredServerIp = (): boolean => {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  
  if (window.localStorage.getItem('server_ip')?.trim()) return true;

  if (window.location) {
    const hostname = window.location.hostname;
    if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return true;
    }
  }

  return false;
};

export const isStationNameConfigured = (name?: string | null): boolean => {
  const normalized = normalizeText(name || '');
  if (!normalized) return false;
  return !DEFAULT_STATION_LABELS.includes(normalized);
};

export const getDisplayStationName = (...names: Array<string | null | undefined>): string => {
  for (const name of names) {
    if (isStationNameConfigured(name)) return (name || '').trim();
  }
  return '';
};

