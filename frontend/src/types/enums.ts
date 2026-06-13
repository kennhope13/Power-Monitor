// ============================================================
// enums.ts — Enum dùng chung cho cả frontend
// Tránh dùng string literal rải rác gây typo / inconsistency
// ============================================================

export const ALERT_STATUS = {
  OPEN: 'open',
  ACKED: 'acked',
  CLOSED: 'closed',
} as const;
export type AlertStatus = typeof ALERT_STATUS[keyof typeof ALERT_STATUS];

export const ALERT_LEVEL = {
  INFO: 'info',
  WARNING: 'warning',
  ALARM: 'alarm',
} as const;
export type AlertLevel = typeof ALERT_LEVEL[keyof typeof ALERT_LEVEL];

export const DEVICE_STATUS = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  ERROR: 'error',
  UNKNOWN: 'unknown',
} as const;
export type DeviceStatus = typeof DEVICE_STATUS[keyof typeof DEVICE_STATUS];

/** Label tiếng Việt cho hiển thị UI. Luôn dùng những hàm này thay vì hardcode chuỗi. */
export const alertStatusLabel = (s: string): string => {
  switch (s) {
    case ALERT_STATUS.OPEN:   return 'Chưa xử lý';
    case ALERT_STATUS.ACKED:  return 'Đang xử lý';
    case ALERT_STATUS.CLOSED: return 'Đã xử lý';
    default: return s;
  }
};

export const alertLevelLabel = (l: string): string => {
  switch (l) {
    case ALERT_LEVEL.INFO:    return 'Thông tin';
    case ALERT_LEVEL.WARNING: return 'Cảnh báo';
    case ALERT_LEVEL.ALARM:   return 'Báo động';
    default: return l;
  }
};

export const deviceStatusLabel = (s: string): string => {
  switch (s) {
    case DEVICE_STATUS.ONLINE:  return 'Trực tuyến';
    case DEVICE_STATUS.OFFLINE: return 'Ngoại tuyến';
    case DEVICE_STATUS.ERROR:   return 'Lỗi';
    default: return 'Không rõ';
  }
};
