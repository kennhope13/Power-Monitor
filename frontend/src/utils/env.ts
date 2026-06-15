// ============================================================
// env.ts — Tập trung các biến môi trường dùng trong frontend
// Cấu hình trong file .env (không sửa trực tiếp tại đây)
//   VITE_API_URL    = http://localhost:5000   (backend REST + SignalR)
//   VITE_GO2RTC_URL = http://localhost:1984   (stream camera RTSP→WebRTC)
//   VITE_APP_MODE   = onprem | cloud
// ============================================================

// Helper to extract clean hostname/IP from input
const cleanHostname = (input: string): string => {
  let cleaned = input.trim();
  cleaned = cleaned.replace(/^(https?:\/\/)/i, '');
  cleaned = cleaned.split('/')[0] || '';
  cleaned = cleaned.split(':')[0] || '';
  return cleaned;
};

// Helper to get target hostname based on saved localStorage IP or window location
const getTargetHostname = (): string | null => {
  if (typeof window !== 'undefined' && window.localStorage) {
    const saved = window.localStorage.getItem('server_ip');
    if (saved && saved.trim() !== '') {
      return cleanHostname(saved);
    }
  }
  if (typeof window !== 'undefined' && window.location) {
    const hostname = window.location.hostname;
    if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return hostname;
    }
  }
  return null;
};

// URL server go2rtc để phát stream camera qua WebRTC
const rawGo2rtc = (import.meta.env.VITE_GO2RTC_URL as string | undefined) ?? 'http://localhost:1984';
/** URL của server go2rtc — tự thay localhost bằng hostname thực nếu chạy trên mạng. */
export const GO2RTC_URL: string = (() => {
  const host = getTargetHostname();
  if (host) {
    return rawGo2rtc.replace(/(localhost|127\.0\.0\.1)/g, host);
  }
  return rawGo2rtc;
})();

// URL gốc của backend API — dùng cho REST và WebSocket SignalR
const rawApi = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:5000';
/** URL gốc của backend REST API và SignalR — tự thay localhost bằng hostname thực. */
export const API_BASE_URL: string = (() => {
  const host = getTargetHostname();
  if (host) {
    return rawApi.replace(/(localhost|127\.0\.0\.1)/g, host);
  }
  return rawApi;
})();

// URL gốc của AI Engine (FastAPI) — dùng để xem luồng camera AI đã được vẽ sẵn và các API AI
const rawAi = (import.meta.env.VITE_AI_ENGINE_URL as string | undefined) ?? 
              (import.meta.env.VITE_AI_URL as string | undefined) ?? 
              '/ai-api';
export const AI_ENGINE_URL: string = (() => {
  const host = getTargetHostname();
  if (host) {
    return `http://${host}:8100`;
  }
  // Nếu dùng proxy relative path (như /ai-api), giữ nguyên
  if (rawAi.startsWith('/')) {
    return rawAi;
  }
  // Nếu là địa chỉ IP cụ thể (không phải localhost), giữ nguyên
  if (!rawAi.includes('localhost') && !rawAi.includes('127.0.0.1')) {
    return rawAi;
  }
  return rawAi;
})();

// Chế độ triển khai: 'onprem' | 'cloud'
export const APP_MODE: string =
  (import.meta.env.VITE_APP_MODE as string | undefined) ?? 'onprem';

// Cảnh báo trong development nếu biến môi trường thiếu
if (import.meta.env.DEV) {
  if (!import.meta.env.VITE_API_URL) {
    console.warn('[env] VITE_API_URL chưa được cấu hình, dùng fallback:', API_BASE_URL);
  }
  if (!import.meta.env.VITE_GO2RTC_URL) {
    console.warn('[env] VITE_GO2RTC_URL chưa được cấu hình, dùng fallback:', GO2RTC_URL);
  }
  if (!import.meta.env.VITE_AI_URL) {
    console.warn('[env] VITE_AI_URL (AI Engine) chưa được cấu hình, dùng fallback:', AI_ENGINE_URL);
  }
}
