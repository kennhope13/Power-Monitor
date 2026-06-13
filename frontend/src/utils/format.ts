// ============================================================
// format.ts — Các hàm định dạng hiển thị dùng chung toàn app
// Ngày giờ, nhãn cấp độ cảnh báo, màu trạng thái
// ============================================================

// Định dạng timestamp → chuỗi ngày giờ tiếng Việt: "dd/MM/yyyy, HH:mm"
export function fmtDateTime(ts: string | Date): string {
  return new Date(ts).toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Chuyển preset range string → khoảng from/to dạng YYYY-MM-DD
// Dùng cho bộ lọc thời gian trong Reports, AlertsHistory
export function fmtTimeRange(range: string): { from: string; to: string } {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (range === 'today') {
    return { from: todayStr, to: todayStr };
  } else if (range === 'yesterday') {
    const y = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    return { from: y, to: y };
  } else if (range === '7d') {
    return {
      from: new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10),
      to: todayStr,
    };
  } else if (range === '30d') {
    return {
      from: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10),
      to: todayStr,
    };
  } else if (range === 'all') {
    return { from: '', to: '' };
  }
  return { from: todayStr, to: todayStr };
}

// Màu theo cấp độ cảnh báo — khớp với CSS variable theme
export function alarmLevelColor(level: string): string {
  const colorMap: Record<string, string> = {
    critical: 'var(--admin-danger)',
    high: '#f97316',
    medium: 'var(--admin-warning)',
    low: '#84cc16',
    info: 'var(--admin-accent)',
  };
  return colorMap[level] || 'var(--admin-text-muted)';
}

// Nhãn hiển thị theo cấp độ cảnh báo (tiếng Việt)
export function alarmLevelLabel(level: string): string {
  const labelMap: Record<string, string> = {
    critical: 'Nghiêm trọng',
    high: 'Cao',
    medium: 'Trung bình',
    low: 'Thấp',
    info: 'Thông tin',
  };
  return labelMap[level] || level.toUpperCase();
}

// Nhãn trạng thái cảnh báo (tiếng Việt)
export function statusLabel(status: string): string {
  const labelMap: Record<string, string> = {
    open: 'Chưa xác nhận',
    acked: 'Đã xác nhận',
    closed: 'Đã xử lý',
  };
  return labelMap[status] || status;
}

// Màu theo trạng thái cảnh báo
export function statusColor(status: string): string {
  const colorMap: Record<string, string> = {
    open: 'var(--admin-danger)',
    acked: 'var(--admin-warning)',
    closed: 'var(--admin-success)',
  };
  return colorMap[status] || 'var(--admin-text-muted)';
}
