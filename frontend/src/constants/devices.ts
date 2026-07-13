// ============================================================
// devices.ts — Hằng số loại thiết bị (device type strings)
// Khớp 1-1 với trường `type` mà backend trả về.
// ============================================================

export const DEV_PLC_S7   = 'plc_s7';
export const DEV_CABINET  = 'cabinet';
export const DEV_CAM_CCTV = 'camera_cctv';
export const DEV_CAM_THERMAL = 'camera_thermal';
export const DEV_CAM_PD   = 'camera_pd';
export const DEV_CAM_DUAL = 'camera_dual';

// Các loại được coi là "camera" (dùng để lọc danh sách)
export const DEV_CAM_TYPES = [DEV_CAM_CCTV, DEV_CAM_THERMAL, DEV_CAM_PD, DEV_CAM_DUAL] as const;

// Label hiển thị cho từng loại thiết bị
export const DEVICE_TYPE_LABELS: Record<string, string> = {
  [DEV_PLC_S7]:        'PLC S7-1200/1500',
  [DEV_CABINET]:       'PLC S7 - tủ điện cảm biến',
  [DEV_CAM_CCTV]:      'Camera CCTV',
  [DEV_CAM_THERMAL]:   'Camera Nhiệt',
  [DEV_CAM_PD]:        'Camera Phóng điện',
  [DEV_CAM_DUAL]:      'Camera Dual (Nhiệt & Quang)',
  'modbus_tcp':         'Modbus TCP',
  'sensor_temp':        'Cảm biến nhiệt độ',
};
