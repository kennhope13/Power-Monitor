// ============================================================
// api.types.ts — Định nghĩa kiểu dữ liệu API backend
// Nguồn sự thật duy nhất cho tất cả response từ /api/v1
// Khớp 1-1 với schema của StationMonitor backend
// ============================================================

// ── Auth & User ───────────────────────────────────────────────
export type UserRole = 'admin' | 'manager' | 'operator';

export interface User {
  user_id: string;
  username: string;
  fullname: string;
  email: string;
  role: UserRole;
  active: boolean;
  created_at: string;
  is_restricted?: boolean;
  station_ids?: string[];
}

// ── Trạm và Thiết bị ─────────────────────────────────────────

export interface Station {
  id: string;
  name: string;
  code: string;
  status: string;
  /** JSON string từ backend: {"lat": 10.768, "lng": 106.790, "address": "..."} */
  location?: string;
  createdAt?: string;
}

/** Helper parse location JSON. */
export interface StationLocation {
  lat?: number;
  lng?: number;
  address?: string;
}

export interface Device {
  id: string;
  name: string;
  type: string;           // plc_s7 | camera_cctv | camera_thermal | ...
  protocol: string;       // modbus_tcp | rtsp | ...
  config: Record<string, any>; // cấu hình riêng từng loại thiết bị (JSON)
  status: string;         // online | offline | error
  stationId: string;
  createdAt: string;
}

// Điểm chấm nhiệt trên camera nhiệt — vị trí đo nhiệt độ tùy chỉnh
export interface RoiPoint {
  id: string;
  deviceId?: string;
  name?: string;             // VD: "Đầu cáp Pha A", "Sứ cách điện"
  label?: string;            // VD: "Đầu cáp Pha A" (Legacy compatibility)
  x?: number;                // % tọa độ X trên frame (Legacy compatibility, 0-100)
  y?: number;                // % tọa độ Y trên frame (Legacy compatibility, 0-100)
  tx?: number;               // tọa độ X trên frame thermal (0.0-1.0)
  ty?: number;               // tọa độ Y trên frame thermal (0.0-1.0)
  ox?: number;               // tọa độ X trên frame optical (0.0-1.0)
  oy?: number;               // tọa độ Y trên frame optical (0.0-1.0)
  pointId?: string;          // ID sensor để map với dữ liệu từ API (tùy chọn)
  alarmThreshold?: number;   // °C — ngưỡng báo động đỏ
  preAlarmThreshold?: number; // °C — ngưỡng cảnh báo vàng (pre-alarm)
  warningThreshold?: number;  // °C — ngưỡng cảnh báo vàng (Legacy compatibility)
  color?: string;            // màu hiển thị tùy chỉnh (override mặc định)
  sortOrder?: number;        // thứ tự hiển thị trong danh sách
}

export interface Boundary {
  id: string;
  deviceId: string;
  name: string;
  type: 'pd' | 'intrusion' | 'roi' | string;
  /** JSON string: [[x,y], [x,y], ...] tọa độ chuẩn hóa 0-1 */
  polygon: string;
  /** JSON string: { "warning": 50, "alarm": 70 } */
  thresholds?: string;
  severityLevel: 'info' | 'warning' | 'alarm';
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type CameraType =
  | 'camera_cctv'     // Camera quang học thường + AI
  | 'camera_thermal'  // Camera nhiệt thuần (chỉ có luồng nhiệt)
  | 'camera_dual'     // Camera vừa quang học vừa nhiệt (2 luồng)
  | 'camera_pd';      // Camera phóng điện

export interface CameraDevice {
  id: string;
  name: string;
  type: CameraType;
  protocol: string;
  status: string;             // online | offline | error
  stationId: string;

  config: {
    ip?: string;
    username?: string;
    // Luồng quang học (visible light)
    rtsp_optical?: string;    // rtsp://ip/Streaming/Channels/101
    go2rtc_optical?: string;  // ID stream optical trong go2rtc
    // Luồng nhiệt (thermal/radiometric)
    rtsp_thermal?: string;    // rtsp://ip/Streaming/Channels/201
    go2rtc_thermal?: string;  // ID stream thermal trong go2rtc
    // Legacy — giữ tương thích ngược với camera_cctv cũ
    rtsp_path?: string;
    go2rtc_id?: string;
    // Camera liên kết với tủ điện nào (tùy chọn)
    cabinetId?: string;
    // Tiêu cự ống kính (tùy chọn, cho cam dual)
    focal_length_optical?: number;
    focal_length_thermal?: number;
  };

  // Danh sách điểm chấm nhiệt — chỉ có với camera_thermal và camera_dual
  roiPoints?: RoiPoint[];

  // Cấu hình AI detection — chỉ có với camera_cctv và camera_dual
  aiConfig?: {
    detectClasses: ('smoke' | 'fire' | 'person' | 'anomaly')[];
    confidenceThreshold: number; // 0.0–1.0
  };
}

// ── Dữ liệu Cảm biến ─────────────────────────────────────────

export interface SensorPoint {
  deviceId: string;
  pointId: string;        // vd: nhiet_do_pha_1, phong_dien, P1..P10
  value: number;
  unit: string;           // °C, dB, ppm, ...
  quality: number;        // 0–100, chất lượng tín hiệu
  time: string;           // ISO timestamp
}

// ── Quy tắc & Cảnh báo ───────────────────────────────────────

export interface Rule {
  id: string;
  name: string;
  ruleSet?: string;       // nhóm quy tắc, vd: "Tủ điện A"
  stationId?: string;
  condition: string;      // JSON: { point, op, value } — điều kiện kích hoạt
  actions: string;        // JSON: [{ type, level }] — hành động khi vi phạm
  enabled: boolean;
  deviceId?: string;
  deviceName?: string;
  createdAt: string;
}

export interface AlertItem {
  id: string;
  source: string;         // rule_engine | ai_detection | manual
  level: string;          // warning | alarm
  status: string;         // open | acked | closed
  message: string;
  value?: number;         // giá trị đo lúc kích hoạt
  deviceId?: string;
  pointId?: string;       // điểm đo kích hoạt (vd: nhiet_do_pha_1, phong_dien)
  ruleId?: string;
  stationId?: string;     // trạm nguồn phát sinh cảnh báo
  stationName?: string;   // tên trạm (để hiển thị ở trạm tổng)
  triggeredAt: string;
  ackedAt?: string;
  closedAt?: string;
  ackNote?: string;       // ghi chú khi xác nhận
  imageUrl?: string;      // ảnh chụp lúc báo động
  videoUrl?: string;      // video clip xung quanh sự kiện
  thumbnailUrl?: string;
  metadata?: any;
}

export interface AlertHistoryEntry {
  status: string;         // trạng thái sau khi thay đổi
  changedAt: string;
  note?: string;
  changedBy?: string;     // username người thực hiện
}

// ── Nhật ký Hệ thống ─────────────────────────────────────────

export interface AuditLogEntry {
  id: string;
  action: string;         // CREATE | UPDATE | DELETE | LOGIN | ...
  entityType?: string;    // User | Rule | Device | Alert | ...
  entityId?: string;
  ipAddress?: string;
  ts: string;
  userId?: string;
  username?: string;
  fullName?: string;
  oldValue?: string | null; // giá trị trước thay đổi (JSON)
  newValue?: string | null; // giá trị sau thay đổi (JSON)
  stationId?: string;
  stationName?: string;
}

export interface LoginLogEntry {
  id: string;
  username?: string;
  action: string;         // login | logout | failed
  ipAddress?: string;
  ts: string;
  stationId?: string;
  stationName?: string;
  role?: string;
  fullName?: string;
}

export interface NotifyLogEntry {
  id: string;
  channel: string;
  recipient: string;
  status: string;
  sentAt: string;
  errorMessage?: string;
  stationId?: string;
  stationName?: string;
}

export interface RuleTriggerLogEntry {
  id: string;
  triggeredAt: string;
  ruleId: string;
  ruleName?: string;
  deviceId?: string;
  deviceName?: string;
  valueAtTrigger?: number;
  stationId?: string;
  stationName?: string;
}

// ── Người dùng ───────────────────────────────────────────────

export interface UserItem {
  id: string;
  username: string;
  fullName?: string;
  email?: string;
  role: string;           // operator | manager | admin
  isActive: boolean;
  stationIds?: string[];
  createdAt: string;
}

// ── Sơ đồ một sợi (SLD) ──────────────────────────────────────

export interface SldPoint {
  id: string;
  pointId: string;        // liên kết với SensorPoint.pointId
  label: string;
  x: number;              // tọa độ % trên SVG
  y: number;
  r: number;              // bán kính vùng click (px)
  deviceId?: string;
  deviceName?: string;
  deviceType?: string;
  deviceStatus?: string;
}

export interface SldUnpinnedDevice {
  id: string;
  name: string;
  type: string;
  status: string;
  sensorTag?: string;     // tag cảm biến chưa được gắn lên sơ đồ
}

export interface SldData {
  sldFileId?: string;
  svgUrl?: string;        // URL file SVG sơ đồ đã upload
  version: number;
  points: SldPoint[];
  unpinned: SldUnpinnedDevice[]; // thiết bị chưa có vị trí trên sơ đồ
}

// ── Báo cáo ──────────────────────────────────────────────────

export interface ReportItem {
  id: string;
  stationId: string;
  type: string;           // daily | monthly | event
  periodFrom?: string;
  periodTo?: string;
  fileUrl?: string;       // link tải file PDF/XLSX đã tạo
  generatedBy?: string;   // username người tạo
  generatedAt: string;
}

// ── Bảo trì ──────────────────────────────────────────────────

export interface MaintenanceTask {
  id: string;
  stationId: string;
  deviceId?: string;
  deviceName?: string;
  title: string;
  type: string;           // inspection | repair | cleaning | calibration | other
  scheduledDate: string;
  assignedTo?: string;    // tên người được giao việc
  status: string;         // pending | in_progress | completed | overdue
  checklist?: string;     // JSON string: [{ item, done }]
  notes?: string;
  sourceAlertId?: string; // nếu tạo từ cảnh báo
  createdAt: string;
  completedAt?: string;
}

export interface MaintenanceSuggestion {
  deviceId?: string;
  deviceName: string;
  reason: string;         // lý do đề xuất bảo trì
  priority: string;       // high | medium | low
  suggestedDate: string;
}

// ── Thông báo Email ──────────────────────────────────────────

export interface SmtpConfig {
  host: string;
  port: string;
  username: string;
  hasPassword: boolean;   // true nếu đã cấu hình mật khẩu (không trả về plaintext)
  from: string;           // địa chỉ email gửi
}

// ── Phân tích Sức khỏe Thiết bị ─────────────────────────────

export interface HealthScore {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  status: string;
  score: number;          // 0–100, điểm sức khỏe (100 = tốt nhất)
  risk: string;           // good | fair | poor | critical
  alarmCount?: number;
  warningCount?: number;
  ts?: string;
}

export interface TrendItem {
  deviceId: string;
  pointId: string;
  label: string;
  slopePerDay: number;    // tốc độ tăng/giảm mỗi ngày
  trend: string;          // rising | falling | stable
  sampleCount: number;
  latestValue: number;
  unit: string;
}

// ── Đồng bộ Cloud ────────────────────────────────────────────

export interface SyncStatus {
  isConfigured: boolean;  // đã cấu hình Supabase chưa
  pendingCount: number;   // số bản ghi chờ đồng bộ
  sentCount: number;      // đã gửi thành công
  failedCount: number;    // gửi thất bại
  lastSyncAt?: string;
  supabaseUrl?: string;
}
