// ============================================================
// AlertsHistoryPage.tsx — Danh sách và chi tiết cảnh báo
// Layout: panel trái (danh sách) + panel phải (chi tiết + ảnh/video)
// Hỗ trợ: lọc theo trạng thái/cấp/thiết bị, sắp xếp, tìm theo khoảng thời gian
// Nhận cảnh báo mới realtime qua SignalR
// ============================================================

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import ToolbarSelect from '@/components/ui/ToolbarSelect';
import { Calendar, RefreshCw, Play, Camera } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { stationApi, AlertItem, AlertHistoryEntry } from '@/services/StationApiService';
import { useStationStore, useDeviceStore, useAlertStore } from '@/store';
import { ALERT_STATUS, ALERT_LEVEL, alertStatusLabel, alertLevelLabel } from '@/types/enums';
import { createRealtimeHub } from '@/services/realtime.service';
import { fmtDateTime } from '@/utils/format';
import { confirmDialog } from '@/utils/confirm';
import { GO2RTC_URL } from '@/utils/env';
import { authService } from '@/services/AuthService';
import './AlertsHistoryPage.css';

type SortCol = 'time' | 'level';
type SortDir = 'asc' | 'desc';
// AlertDetail = AlertItem + lịch sử thay đổi trạng thái
type AlertDetail = AlertItem & { history: AlertHistoryEntry[] };

/**
 * Helper để lấy nội dung tóm tắt cho danh sách (ẩn bớt chi tiết kỹ thuật dài)
 */
const getAlertSummary = (msg: string) => {
  if (!msg) return "";
  // Xóa phần nguồn [DEVICE] nếu có vì đã có nhãn riêng
  let clean = msg.replace(/^\[.*?\]\s*/, '');
  
  // Nếu là cảnh báo nhiệt độ: "Vùng/Điểm Tên: 32.0°C — chi tiết..." -> Lấy trước dấu "—"
  if (clean.includes(' — ')) {
    clean = clean.split(' — ')[0] || '';
  }
  
  // Nếu là cảnh báo hệ thống quá dài: "NGUY CẤP: Ổ đĩa /path/to/something..." -> Lấy trước dấu chấm hoặc dấu !
  if (clean.includes('!')) {
    clean = (clean.split('!')[0] || '') + '!';
  } else if (clean.includes('.')) {
    clean = (clean.split('.')[0] || '') + '.';
  }

  return clean;
};

type ParsedAlertDisplay = {
  eyebrow?: string;
  headline: string;
  detail?: string;
  tone?: 'alarm' | 'warning' | 'info';
};

const isMaintenanceAlert = (msg: string) => /^\[MT:.*?\]/i.test(msg || '');

const parseAlertDisplay = (msg: string): ParsedAlertDisplay => {
  if (!msg) {
    return { headline: '' };
  }

  const match = msg.match(/^\[(.*?)\]\s*(.*)$/);
  const tag = match?.[1];
  const body = match?.[2] || msg;
  const cleanBody = getAlertSummary(body);

  if (tag?.startsWith('MT:')) {
    const overdue = body.match(/^Bảo trì quá hạn\s+(\d+)\s+ngày:\s*(.*)$/i);
    if (overdue) {
      return {
        eyebrow: `QUÁ HẠN ${overdue[1]} NGÀY`,
        headline: overdue[2] || 'Hạng mục bảo trì',
        detail: 'Cần kiểm tra và xử lý ngay',
        tone: 'alarm',
      };
    }

    const dueToday = body.match(/^Hôm nay phải bảo trì:\s*(.*)$/i);
    if (dueToday) {
      return {
        eyebrow: 'ĐẾN HẠN HÔM NAY',
        headline: dueToday[1] || 'Hạng mục bảo trì',
        detail: 'Nhắc lịch bảo trì định kỳ',
        tone: 'warning',
      };
    }

    return {
      eyebrow: 'BẢO TRÌ',
      headline: cleanBody,
      tone: 'warning',
    };
  }

  if (match) {
    return {
      eyebrow: tag,
      headline: cleanBody,
      tone: 'info',
    };
  }

  return {
    headline: cleanBody,
    tone: 'info',
  };
};

/**
 * Trang lịch sử cảnh báo: hiển thị danh sách cảnh báo bên trái,
 * chi tiết cảnh báo bên phải. Hỗ trợ lọc, sắp xếp, lọc theo ngày,
 * xác nhận (ack), đóng alert và nhận cảnh báo mới qua SignalR.
 */
export default function AlertsHistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Hỗ trợ deep link: /alerts-history?alertId=xxx tự động mở detail
  const initialAlertId = searchParams.get('alertId');
  const initialStationId = searchParams.get('stationId') || '';

  // Kiểm tra chế độ trạm tổng (đồng bộ với AppShell)
  const isCentralMode = false;

  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [timeRange, setTimeRange] = useState('all');
  const [sortBy, setSortBy] = useState<SortCol>('time');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const [filterStation, setFilterStation] = useState(initialStationId);
  const stations = useStationStore(s => s.stations);

  const [selectedId, setSelectedId] = useState<string>('');
  const [detailData, setDetailData] = useState<AlertDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Devices từ store (chia sẻ với Dashboard, Maintenance...)
  const fetchStations = useStationStore(s => s.fetch);
  const fetchDevices = useDeviceStore(s => s.fetch);
  const allDevicesByStation = useDeviceStore(s => s.devicesByStation);
  const devices = useMemo(() => Object.values(allDevicesByStation).flat(), [allDevicesByStation]);
  const ackAlertInStore = useAlertStore(s => s.ack);
  const closeAlertInStore = useAlertStore(s => s.close);
  const [filterDevice, setFilterDevice] = useState('');

  // Bộ lọc nâng cao — loại sự kiện và cấp độ
  const [filterType, setFilterType] = useState('');
  const [filterLevel, setFilterLevel] = useState('');

  // Modal chọn khoảng ngày tùy chỉnh
  const [dateModalOpen, setDateModalOpen] = useState(false);

  // Khoảng thời gian mặc định: Tất cả lịch sử
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Giá trị tạm trong modal (chưa áp dụng cho đến khi bấm Xác nhận)
  const [tempStartDate, setTempStartDate] = useState('');
  const [tempEndDate, setTempEndDate] = useState('');

  // Load devices list on mount (qua store — chia sẻ với các page khác)
  useEffect(() => {
    fetchStations().then(stations => {
      stations.forEach(s => fetchDevices(s.id));
    }).catch(e => console.error("Lỗi tải stations/devices:", e));
  }, [fetchStations, fetchDevices]);

  // Presets trigger date changes
  useEffect(() => {
    if (timeRange === 'custom') return;
    const now = new Date();
    let start = new Date();
    if (timeRange === 'today') {
      // start is today
    } else if (timeRange === 'yesterday') {
      start.setDate(now.getDate() - 1);
      now.setDate(now.getDate() - 1);
    } else if (timeRange === '7d') {
      start.setDate(now.getDate() - 7);
    } else if (timeRange === '30d') {
      start.setDate(now.getDate() - 30);
    } else if (timeRange === 'all') {
      setStartDate('');
      setEndDate('');
      return;
    }
    setStartDate(start.toISOString().split('T')[0] ?? '');
    setEndDate(now.toISOString().split('T')[0] ?? '');
  }, [timeRange]);

  // Sync temp dates when main dates are set
  useEffect(() => {
    setTempStartDate(startDate);
    setTempEndDate(endDate);
  }, [startDate, endDate]);

  // Ack modal state
  const [ackModalOpen, setAckModalOpen] = useState(false);
  const [ackTargetId, setAckTargetId] = useState('');
  const [ackNote, setAckNote] = useState('');

  /** Tải danh sách cảnh báo từ API theo khoảng thời gian và trạng thái đang lọc. */
  const loadAlerts = useCallback(async () => {
    setLoading(true);
    try {
      // Chuyển ngày text sang ISO để gửi API
      const from = startDate ? new Date(startDate + 'T00:00:00').toISOString() : undefined;
      const to = endDate ? new Date(endDate + 'T23:59:59').toISOString() : undefined;
      const data = await stationApi.getAlerts(filterStatus || undefined, from, to);
      setAlerts(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, filterStatus]);

  useEffect(() => {
    loadAlerts();
  }, [loadAlerts]);

  // Realtime
  useEffect(() => {
    const hubConnection = createRealtimeHub();

    hubConnection.on('AlertNew', (alert: any) => {
      const aid = alert.id || alert.Id;
      if (!aid) return;
      const normalized: AlertItem = {
        id: aid,
        source: alert.source || alert.Source || 'camera',
        level: alert.level || alert.Level || 'alarm',
        status: alert.status || alert.Status || 'open',
        message: alert.message || alert.Message || '',
        value: alert.value || alert.Value,
        deviceId: alert.deviceId || alert.DeviceId,
        ruleId: alert.ruleId || alert.RuleId,
        triggeredAt: alert.triggeredAt || alert.TriggeredAt || new Date().toISOString(),
        thumbnailUrl: alert.thumbnailUrl || alert.ThumbnailUrl,
        imageUrl: alert.imageUrl || alert.ImageUrl,
        videoUrl: alert.videoUrl || alert.VideoUrl
      };

      if (filterStatus && filterStatus !== normalized.status) return;

      setAlerts(prev => {
        if (prev.find(a => a.id === normalized.id)) return prev;
        return [normalized, ...prev];
      });
    });

    hubConnection.on('AlertUpdated', (data: any) => {
      setAlerts(prev => prev.map(a => {
        if (a.id === data.id) {
          return { ...a, videoUrl: data.videoUrl || a.videoUrl, status: data.status || a.status };
        }
        return a;
      }));
      if (selectedId === data.id) {
        loadDetail(data.id, true); // Silent reload
      }
    });

    hubConnection.start().catch((err: any) => console.warn('SignalR start error:', err));
    return () => { hubConnection.stop(); };
  }, [filterStatus, selectedId]);

  // Load detail automatically if alertId in query string
  useEffect(() => {
    if (initialAlertId && alerts.length > 0) {
      loadDetail(initialAlertId);
      // Remove it from URL so it doesn't get stuck
      setSearchParams(new URLSearchParams());
    }
  }, [initialAlertId, alerts.length]);

  /** Tải chi tiết + lịch sử xử lý của một cảnh báo theo id. */
  const loadDetail = async (id: string, silent = false) => {
    setSelectedId(id);
    if (!silent) setDetailLoading(true);
    try {
      const data = await stationApi.getAlertDetail(id);
      setDetailData(data);
    } catch (e) {
      console.error(e);
      setDetailData(null);
    } finally {
      if (!silent) setDetailLoading(false);
    }
  };

  /** Xử lý click vào dòng alert — bỏ qua nếu người dùng nhấn nút hành động. */
  const handleRowClick = (e: React.MouseEvent, id: string) => {
    if ((e.target as HTMLElement).closest('button')) return; // Ignore if clicking action buttons
    loadDetail(id);
  };

  /** Mở modal xác nhận (ACK) cho cảnh báo được chọn. */
  const handleAckClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setAckTargetId(id);
    setAckNote('');
    setAckModalOpen(true);
  };

  /** Gửi xác nhận ACK kèm ghi chú lên store/API rồi làm mới danh sách. */
  const submitAck = async () => {
    if (ackTargetId) {
      await ackAlertInStore(ackTargetId, ackNote);
      setAckModalOpen(false);
      loadAlerts();
      if (selectedId === ackTargetId) loadDetail(selectedId);
    }
  };

  /** Đóng cảnh báo sau khi người dùng xác nhận qua hộp thoại. */
  const handleCloseAlert = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!await confirmDialog({ title: 'Đóng cảnh báo', message: 'Xác nhận đóng alert này?', confirmText: 'Đóng alert' })) return;
    await closeAlertInStore(id);
    loadAlerts();
    if (selectedId === id) loadDetail(selectedId);
  };

  /** Xuất danh sách cảnh báo hiện tại ra file CSV và kích hoạt tải về. */
  const exportCsv = () => {
    const opts = {
      status: filterStatus || undefined,
      from: startDate ? new Date(startDate + 'T00:00:00').toISOString() : undefined,
      to: endDate ? new Date(endDate + 'T23:59:59').toISOString() : undefined,
    };
    stationApi.exportAlertsCsv(opts).then(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `alerts_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
    }).catch(err => console.warn('[AlertsHistory] Export lỗi:', err));
  };

  /**
   * Lọc và sắp xếp danh sách alert theo thiết bị, loại sự kiện,
   * mức độ và cột sắp xếp hiện tại. Tính toán lại khi filter/sort thay đổi.
   */
  const sortedAlerts = useMemo(() => {
    let result = [...alerts];
    if (filterStation) {
      result = result.filter(a => a.stationId === filterStation);
    }
    if (filterDevice) {
      result = result.filter(a => a.deviceId === filterDevice);
    }
    if (filterType) {
      // Lọc theo từ khóa trong nội dung message
      if (filterType === 'nguoi') {
        result = result.filter(a => a.message?.toLowerCase().includes('người') || a.message?.toLowerCase().includes('xâm nhập'));
      } else if (filterType === 'chay') {
        result = result.filter(a => a.message?.toLowerCase().includes('cháy') || a.message?.toLowerCase().includes('khói'));
      } else if (filterType === 'diem') {
        result = result.filter(a => a.message?.toLowerCase().includes('điểm') || a.message?.toLowerCase().includes('nhiệt độ'));
      }
    }
    if (filterLevel) {
      result = result.filter(a => a.level?.toLowerCase() === filterLevel.toLowerCase());
    }

    // Thứ tự ưu tiên mức độ: alarm > warning > info
    const levelOrder: Record<string, number> = { [ALERT_LEVEL.ALARM]: 0, [ALERT_LEVEL.WARNING]: 1, [ALERT_LEVEL.INFO]: 2 };
    return result.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'time') {
        cmp = new Date(a.triggeredAt).getTime() - new Date(b.triggeredAt).getTime();
      } else {
        cmp = (levelOrder[a.level] ?? 9) - (levelOrder[b.level] ?? 9);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [alerts, filterDevice, filterType, filterLevel, sortBy, sortDir]);

  /** Đổi cột sắp xếp hoặc đảo chiều nếu đang sắp xếp theo cột đó. */
  const handleSort = (col: SortCol) => {
    if (sortBy === col) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
  };

  return (
    <div className="admin-page-container">
      <div className="page-toolbar-row">
        <div className="page-title-cell">
          <h2>NHẬT KÝ</h2>
        </div>
        <div className="page-toolbar-group">
          <div className="page-toolbar-cell" style={{ height: 28 }}>
            <span className="page-cell-label">LỌC NHANH:</span>
            <ToolbarSelect
              value={timeRange}
              onChange={v => { setTimeRange(v); if (v === 'custom') setDateModalOpen(true); }}
              options={[
                { value: 'today', label: 'Hôm nay' },
                { value: 'yesterday', label: 'Hôm qua' },
                { value: '7d', label: '7 ngày' },
                { value: '30d', label: '30 ngày' },
                { value: 'all', label: 'Tất cả' },
                { value: 'custom', label: 'Tùy chỉnh' },
              ]}
              width={110}
            />
            <button className="btn-industrial" style={{ height: 22, width: 22, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '.8rem', border: 'none', background: 'transparent', opacity: 0.8 }} title="Chọn ngày" onClick={() => setDateModalOpen(true)}><Calendar size={14} strokeWidth={2} /></button>
          </div>
          <div className="page-toolbar-cell" style={{ height: 28 }}>
            <span className="page-cell-label">THIẾT BỊ:</span>
            <ToolbarSelect
              value={filterDevice}
              onChange={setFilterDevice}
              options={[{ value: '', label: `Tất cả (${devices.length})` }, ...devices.map(d => ({ value: d.id, label: d.name }))]}
              width={130}
            />
          </div>
          <div className="page-toolbar-cell" style={{ height: 28 }}>
            <span className="page-cell-label">SỰ KIỆN:</span>
            <ToolbarSelect
              value={filterType}
              onChange={setFilterType}
              options={[{ value: '', label: 'Tất cả' }, { value: 'nguoi', label: 'Người' }, { value: 'chay', label: 'Cháy' }, { value: 'diem', label: 'Nhiệt' }]}
              width={90}
            />
          </div>
          <div className="page-toolbar-cell" style={{ height: 28 }}>
            <span className="page-cell-label">MỨC:</span>
            <ToolbarSelect
              value={filterLevel}
              onChange={setFilterLevel}
              options={[{ value: '', label: 'Tất cả' }, { value: 'alarm', label: 'Báo động' }, { value: 'warning', label: 'Cảnh báo' }]}
              width={100}
            />
          </div>
          <div className="page-toolbar-cell" style={{ height: 28 }}>
            <span className="page-cell-label">TT:</span>
            <ToolbarSelect
              value={filterStatus}
              onChange={setFilterStatus}
              options={[{ value: '', label: 'Tất cả' }, { value: 'open', label: 'Chưa xử lý' }, { value: 'acked', label: 'Đang xử lý' }, { value: 'closed', label: 'Đã xử lý' }]}
              width={90}
            />
          </div>
          <button 
            className="btn-industrial" 
            title="Xuất CSV" 
            onClick={exportCsv} 
          >
            ⬇ CSV
          </button>
          <button 
            className="btn-industrial btn-primary" 
            onClick={loadAlerts} 
          >
            ↺ MỚI
          </button>
        </div>
      </div>

      <div className="ah-layout">
        <div className={`ah-backdrop ${selectedId ? 'active' : ''}`} onClick={() => setSelectedId('')}></div>
        
        {/* List Column */}
        <div className="ah-list-col">
          <div className="admin-card" style={{ padding: 0, overflow: 'hidden', flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="ah-grid-header">
              <div>ẢNH</div>
              <div className="ah-sortable-th" onClick={() => handleSort('time')}>
                THỜI GIAN <span className={`ah-sort-badge ${sortBy !== 'time' ? 'ah-sort-inactive' : ''}`}>{sortBy === 'time' && sortDir === 'asc' ? '↑' : '↓'}</span>
              </div>
              <div className="ah-sortable-th" style={{ justifyContent: 'flex-start' }} onClick={() => handleSort('level')}>
                MỨC ĐỘ <span className={`ah-sort-badge ${sortBy !== 'level' ? 'ah-sort-inactive' : ''}`}>{sortBy === 'level' && sortDir === 'asc' ? '↑' : '↓'}</span>
              </div>
              <div>NỘI DUNG</div>
              <div>TRẠNG THÁI</div>
              <div>HÀNH ĐỘNG</div>
            </div>
            
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {loading ? (
                <div style={{ textAlign: 'center', padding: 60, color: 'var(--admin-text-muted)' }}>Đang tải...</div>
              ) : sortedAlerts.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--admin-text-muted)', padding: 40 }}>Không có cảnh báo trong khoảng thời gian này.</div>
              ) : (
                sortedAlerts.map(a => (
                  (() => {
                    const parsed = parseAlertDisplay(a.message);
                    const maintenanceAlert = isMaintenanceAlert(a.message);
                    return (
                  <div 
                    key={a.id} 
                    className={`ah-grid-row ${a.id === selectedId ? 'ah-selected' : ''}`}
                    onClick={(e) => handleRowClick(e, a.id)}
                  >
                    {/* COL 1: ẢNH */}
                    <div>
                      {a.thumbnailUrl ? (
                        <div style={{ position: 'relative', width: 50, height: 36, background: '#000', border: '1px solid var(--admin-border)', overflow: 'hidden' }}>
                          <img src={a.thumbnailUrl} alt="Thumb" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          {a.videoUrl && (
                            <div style={{ 
                              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', 
                              background: 'rgba(0,0,0,0.3)', color: 'var(--admin-accent)', fontSize: '1rem' 
                            }}>
                              <Play size={16} fill="currentColor" />
                            </div>
                          )}
                        </div>
                      ) : a.videoUrl ? (
                        <div style={{ position: 'relative', width: 50, height: 36, background: 'rgba(6, 182, 212, 0.1)', border: '1px solid rgba(6, 182, 212, 0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-accent)' }}>
                          <Play size={14} fill="currentColor" />
                        </div>
                      ) : maintenanceAlert ? (
                        <div className="ah-media-empty" aria-label="Cảnh báo bảo trì không có hình ảnh">
                          -
                        </div>
                      ) : (
                        <div style={{ width: 50, height: 36, background: 'rgba(255,255,255,0.03)', border: '1px dashed var(--admin-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-muted)', fontSize: '0.45rem', fontWeight: 900 }}>N/A</div>
                      )}
                    </div>

                    {/* COL 2: THỜI GIAN */}
                    <div className="ah-time-cell">
                      <div className="ah-time-val">{fmtDateTime(a.triggeredAt).split(' ')[1]}</div>
                      <div className="ah-date-val">{fmtDateTime(a.triggeredAt).split(' ')[0]}</div>
                    </div>

                    {/* COL 3: MỨC ĐỘ */}
                    <div>
                      {a.level === ALERT_LEVEL.ALARM
                        ? <span className="ah-badge ah-badge-alarm">{alertLevelLabel(a.level)}</span>
                        : <span className="ah-badge ah-badge-warning">{alertLevelLabel(a.level)}</span>}
                    </div>

                    {/* COL 4: NỘI DUNG */}
                    <div className="ah-msg-cell">
                       <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                         <div style={{ flex: 1, minWidth: 0 }}>
                           {parsed.eyebrow && (
                             <div className="ah-msg-topline">
                               <span className={`ah-msg-chip ah-msg-chip-${parsed.tone || 'info'}`}>{parsed.eyebrow}</span>
                             </div>
                           )}
                           <div className="ah-msg-body" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                             {parsed.headline}
                           </div>
                           {parsed.detail && (
                             <div className="ah-msg-detail" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                               {parsed.detail}
                             </div>
                           )}
                         </div>
                         
                         {a.videoUrl && (
                           <span style={{ 
                             background: 'rgba(var(--admin-accent-rgb), 0.1)', 
                             color: 'var(--admin-accent)', 
                             fontSize: '0.55rem', 
                             fontWeight: 900, 
                             padding: '2px 6px',
                             border: '1px solid var(--admin-accent)',
                             display: 'flex',
                             alignItems: 'center',
                             gap: 4
                           }}>
                             <Play size={8} fill="currentColor" /> VIDEO
                           </span>
                         )}
                       </div>
                    </div>

                    {/* COL 5: TRẠNG THÁI */}
                    <div>
                      {a.status === ALERT_STATUS.OPEN  ? <span className="ah-badge ah-badge-status-open">{alertStatusLabel(a.status)}</span> :
                       a.status === ALERT_STATUS.ACKED ? <span className="ah-badge ah-badge-warning" style={{ background: 'transparent' }}>{alertStatusLabel(a.status)}</span> :
                                                        <span className="ah-badge" style={{ color: '#10B981' }}>{alertStatusLabel(a.status)}</span>}
                    </div>

                    {/* COL 6: HÀNH ĐỘNG */}
                    <div>
                      {a.status === ALERT_STATUS.OPEN ? (
                        <button className="ah-btn-ack" onClick={(e) => handleAckClick(e, a.id)}>Tiếp nhận</button>
                      ) : a.status === ALERT_STATUS.ACKED ? (
                        <button className="btn-industrial btn-sm" style={{ height: 26, fontSize: '.65rem', padding: '0 10px' }} onClick={(e) => handleCloseAlert(e, a.id)}>Đóng</button>
                      ) : (
                        <div style={{ color: '#10B981', fontSize: '1rem', fontWeight: 900, lineHeight: 1 }} aria-label="Đã xử lý">✓</div>
                      )}
                    </div>
                  </div>
                    );
                  })()
                ))
              )}
            </div>

            <div style={{ padding: '8px 16px', background: 'var(--admin-layer-3)', borderTop: '1px solid var(--admin-border)', fontSize: '.62rem', fontWeight: 800, color: 'var(--admin-text-muted)', display: 'flex', justifyContent: 'space-between', letterSpacing: '.5px' }}>
              <span>HIỂN THỊ {sortedAlerts.length} / {alerts.length} CẢNH BÁO</span>
              <span style={{ fontFamily: 'monospace' }}>{startDate ? `${startDate} → ${endDate || 'NAY'}` : 'TẤT CẢ THỜI GIAN'}</span>
            </div>
          </div>
        </div>

        {/* Detail Panel */}
        <div className={`ah-detail-panel ${selectedId ? 'open' : ''}`}>
          <div className="ah-detail-inner">
            {!selectedId ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: .2, fontSize: '.7rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '2px' }}>Chọn cảnh báo</div>
            ) : detailLoading ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: .4, fontSize: '.75rem', fontWeight: 700 }}>⏳ ĐANG TẢI DỮ LIỆU...</div>
            ) : !detailData ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-danger)', fontWeight: 800 }}>LỖI TẢI CHI TIẾT</div>
            ) : (
              <AlertDetailView 
                data={detailData} 
                onClose={() => setSelectedId('')} 
                onAck={() => handleAckClick({ stopPropagation: () => {} } as any, detailData.id)}
                onCloseAlert={() => handleCloseAlert({ stopPropagation: () => {} } as any, detailData.id)}
                onRefresh={() => loadDetail(detailData.id, true)}
                devices={devices}
              />
            )}
          </div>
        </div>
      </div>

      {/* Custom Date Picker Modal */}
      {dateModalOpen && (
        <div className="modal-overlay active" onClick={() => setDateModalOpen(false)}>
          <div className="modal-content" style={{ width: 340 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 style={{ margin: 0, fontSize: '.9rem', fontWeight: 800, letterSpacing: '.5px' }}>CHỌN KHOẢNG THỜI GIAN</h3>
              <button className="modal-close-btn" onClick={() => setDateModalOpen(false)}></button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="form-group">
                <label style={{ fontSize: '.7rem', fontWeight: 'bold', color: 'var(--admin-text-muted)' }}>TỪ NGÀY:</label>
                <input 
                  type="date" 
                  className="form-input" 
                  style={{ width: '100%', height: 32, fontSize: '.8rem', fontFamily: 'monospace' }} 
                  value={tempStartDate} 
                  onChange={e => setTempStartDate(e.target.value)} 
                />
              </div>
              <div className="form-group">
                <label style={{ fontSize: '.7rem', fontWeight: 'bold', color: 'var(--admin-text-muted)' }}>ĐẾN NGÀY:</label>
                <input 
                  type="date" 
                  className="form-input" 
                  style={{ width: '100%', height: 32, fontSize: '.8rem', fontFamily: 'monospace' }} 
                  value={tempEndDate} 
                  onChange={e => setTempEndDate(e.target.value)} 
                />
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: 8 }}>
              <button className="btn-industrial" style={{ flex: 1 }} onClick={() => setDateModalOpen(false)}>HỦY</button>
              <button className="btn-industrial btn-primary" style={{ flex: 1 }} onClick={() => {
                setStartDate(tempStartDate);
                setEndDate(tempEndDate);
                setTimeRange('custom');
                setDateModalOpen(false);
              }}>ÁP DỤNG</button>
            </div>
          </div>
        </div>
      )}

      {/* ACK Modal */}
      {ackModalOpen && (
        <div className="modal-overlay active">
          <div className="modal-content" style={{ width: 400 }}>
            <div className="modal-header">
              <h3>Xác nhận cảnh báo</h3>
              <button className="modal-close" onClick={() => setAckModalOpen(false)}></button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Ghi chú xử lý (tùy chọn)</label>
                <textarea className="form-input" rows={3} placeholder="Đã kiểm tra, đang xử lý..." value={ackNote} onChange={e => setAckNote(e.target.value)}></textarea>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-industrial btn-primary" onClick={submitAck}>Xác nhận</button>
              <button className="btn-industrial" onClick={() => setAckModalOpen(false)}>Hủy</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Panel chi tiết một cảnh báo: hiển thị ảnh/video bằng chứng,
 * thông tin cảnh báo và timeline lịch sử xử lý.
 */
function AlertDetailView({ data, onClose, onAck, onCloseAlert, onRefresh, devices = [] }: { data: AlertDetail, onClose: () => void, onAck: () => void, onCloseAlert: () => void, onRefresh?: () => void, devices?: any[] }) {
  const isAlarm = data.level === 'alarm';
  const accentColor = isAlarm ? '#EF4444' : '#F59E0B';
  const levelText = isAlarm ? 'BÁO ĐỘNG' : 'CẢNH BÁO';

  const statusLabel: Record<string, string> = { open: 'Chưa xử lý', acked: 'Đang xử lý', closed: 'Đã xử lý' };
  const sourceLabel: Record<string, string> = { rule_engine: 'Hệ thống quy tắc', ai_detection: 'Phân tích AI', manual: 'Nhập thủ công', camera: 'Giám sát Camera' };

  // Phân tích tọa độ vùng từ metadata (hỗ trợ cả Point và ROI)
  const overlayGeometry = useMemo(() => {
    let meta: any = {};
    if (typeof data.metadata === 'string') {
      try { meta = JSON.parse(data.metadata); } catch {}
    } else {
      meta = data.metadata || {};
    }

    // Trường hợp 1: ROI đa giác (array of [x, y])
    if (meta.polygon) {
      try {
        const pts = typeof meta.polygon === 'string' ? JSON.parse(meta.polygon) : meta.polygon;
        if (Array.isArray(pts)) return { type: 'polygon', points: pts };
      } catch {}
    }

    // Trường hợp 2: Điểm chấm nhiệt (tx, ty)
    if (meta.tx != null && meta.ty != null) {
      return { type: 'point', x: meta.tx, y: meta.ty };
    }

    // Trường hợp 3: Vùng ROI chữ nhật (x1, y1, x2, y2)
    if (meta.x1 != null && meta.y1 != null) {
      return { type: 'rect', x1: meta.x1, y1: meta.y1, x2: meta.x2, y2: meta.y2 };
    }

    return null;
  }, [data.metadata]);

  // Tự động tìm stream URL tương ứng với camera của Alert này
  const liveCameraSrc = useMemo(() => {
    if (!data.deviceId) return null;
    const devIdLower = data.deviceId.toLowerCase();
    const cam = devices.find(d => d.id.toLowerCase() === devIdLower);
    if (!cam) return null;
    const cfg = cam.config || {};
    const isThermal = data.message.toLowerCase().includes('nhiệt độ') || data.message.toLowerCase().includes('°c');
    const src = isThermal ? (cfg.go2rtc_thermal || cfg.go2rtc_optical) : (cfg.go2rtc_optical || cfg.go2rtc_thermal);
    return src || cfg.go2rtc_id;
  }, [data.deviceId, devices, data.message]);

  const hasMediaOrGeometry = useMemo(() => {
    return !!(data.imageUrl || data.videoUrl || liveCameraSrc || overlayGeometry);
  }, [data.imageUrl, data.videoUrl, liveCameraSrc, overlayGeometry]);

  const unit = useMemo(() => {
    const msg = data.message.toLowerCase();
    if (msg.includes('người')) return 'NGƯỜI';
    if (msg.includes('nhiệt độ') || msg.includes('°c')) return '°C';
    return 'ĐƠN VỊ';
  }, [data.message]);

  return (
    <div className="ah-detail-inner">
      <div className="ah-detail-header">
        <div style={{ width: 12, height: 12, background: accentColor, border: '2px solid rgba(255,255,255,0.2)' }}></div>
        <span style={{ fontWeight: 900, fontSize: '0.85rem', color: 'var(--admin-text)', letterSpacing: '1px', textTransform: 'uppercase' }}>{levelText} CHI TIẾT</span>
        <span style={{ fontFamily: 'var(--admin-font-mono)', fontSize: '0.65rem', opacity: 0.5, flex: 1, textAlign: 'right', paddingRight: 12 }}>ID: {data.id.slice(0, 8)}</span>
        
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-industrial" style={{ width: 28, height: 24, padding: 0, border: '1px solid var(--admin-border)', background: 'var(--admin-layer-2)' }} onClick={onRefresh} title="Cập nhật">
            <RefreshCw size={12} />
          </button>
          <button className="btn-industrial" style={{ width: 28, height: 24, padding: 0, border: '1px solid var(--admin-border)', background: 'var(--admin-layer-2)' }} onClick={onClose}>✕</button>
        </div>
      </div>

      <div className="ah-detail-scroll">
        {/* EVIDENCE MEDIA GROUP */}
        {hasMediaOrGeometry && (
          <div className="ah-detail-section" style={{ background: 'var(--admin-layer-1)' }}>
            <div className="ah-section-title">Bằng chứng sự kiện</div>
            
            <div className="ah-evidence-box" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
              {data.videoUrl ? (
                <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', height: '100%', maxHeight: 320, overflow: 'hidden' }}>
                  <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', maxHeight: 320 }}>
                    <video key={data.videoUrl} style={{ display: 'block', maxWidth: '100%', maxHeight: 320, width: 'auto', height: 'auto' }} controls autoPlay loop muted>
                      <source src={data.videoUrl} type="video/mp4" />
                    </video>
                    
                    {/* OVERLAY LAYER */}
                    {overlayGeometry && (
                      <svg 
                        viewBox="0 0 1 1" 
                        preserveAspectRatio="none"
                        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 10 }}
                      >
                        {overlayGeometry.type === 'polygon' && overlayGeometry.points && (
                          <polygon 
                            points={overlayGeometry.points.map((p: any) => `${p[0]},${p[1]}`).join(' ')}
                            fill="rgba(239, 68, 68, 0.1)"
                            stroke={accentColor}
                            strokeWidth="0.01"
                            vectorEffect="non-scaling-stroke"
                          >
                            <animate attributeName="stroke-opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" />
                          </polygon>
                        )}
                        {overlayGeometry.type === 'rect' && (
                          <rect 
                            x={overlayGeometry.x1} y={overlayGeometry.y1} 
                            width={overlayGeometry.x2 - overlayGeometry.x1} 
                            height={overlayGeometry.y2 - overlayGeometry.y1}
                            fill="rgba(239, 68, 68, 0.1)"
                            stroke={accentColor}
                            strokeWidth="0.01"
                          >
                            <animate attributeName="stroke-opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" />
                          </rect>
                        )}
                        {overlayGeometry.type === 'point' && (
                          <g transform={`translate(${overlayGeometry.x}, ${overlayGeometry.y})`}>
                            <circle r="0.02" fill="none" stroke={accentColor} strokeWidth="0.005">
                               <animate attributeName="r" values="0.01;0.04;0.01" dur="1.5s" repeatCount="indefinite" />
                               <animate attributeName="stroke-opacity" values="1;0;1" dur="1.5s" repeatCount="indefinite" />
                            </circle>
                            <path d="M-0.03 0 L0.03 0 M0 -0.03 L0 0.03" stroke={accentColor} strokeWidth="0.005" />
                          </g>
                        )}
                      </svg>
                    )}
                  </div>
                  
                  <div className="ah-evidence-label" style={{ background: 'var(--admin-accent)', zIndex: 11 }}>VIDEO DIỄN BIẾN</div>
                </div>
              ) : data.imageUrl ? (
                <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', height: '100%' }}>
                  <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', maxHeight: 320 }}>
                    <img src={data.imageUrl} style={{ display: 'block', maxWidth: '100%', maxHeight: 320, width: 'auto', height: 'auto' }} alt="Snapshot" />
                    
                    {/* OVERLAY TRÊN ẢNH (Dùng chung logic với video) */}
                    {overlayGeometry && (
                       <svg viewBox="0 0 1 1" preserveAspectRatio="none" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
                          {overlayGeometry.type === 'polygon' && overlayGeometry.points && <polygon points={overlayGeometry.points.map((p: any) => `${p[0]},${p[1]}`).join(' ')} fill="rgba(239, 68, 68, 0.15)" stroke={accentColor} strokeWidth="0.01" vectorEffect="non-scaling-stroke" />}
                          {overlayGeometry.type === 'rect' && <rect x={overlayGeometry.x1} y={overlayGeometry.y1} width={overlayGeometry.x2 - overlayGeometry.x1} height={overlayGeometry.y2 - overlayGeometry.y1} fill="rgba(239, 68, 68, 0.15)" stroke={accentColor} strokeWidth="0.01" />}
                          {overlayGeometry.type === 'point' && <circle cx={overlayGeometry.x} cy={overlayGeometry.y} r="0.02" fill={accentColor} stroke="#fff" strokeWidth="0.005" />}
                       </svg>
                    )}
                  </div>
                  <div className="ah-evidence-label">ẢNH CHỤP SỰ KIỆN</div>
                </div>
              ) : liveCameraSrc ? (
                <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', height: '100%', minHeight: 240, maxHeight: 320, overflow: 'hidden', aspectRatio: '16/9', background: '#000' }}>
                  <iframe
                    src={`/camera-stream.html?src=${liveCameraSrc}&mode=webrtc,mse&go2rtc=${GO2RTC_URL}`}
                    style={{ width: '100%', height: '100%', border: 'none', pointerEvents: 'none', display: 'block' }}
                    allow="autoplay"
                    title="Camera Live Stream"
                  />
                  {/* OVERLAY TRÊN LIVE STREAM */}
                  {overlayGeometry && (
                    <svg 
                      viewBox="0 0 1 1" 
                      preserveAspectRatio="none"
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 10 }}
                    >
                      {overlayGeometry.type === 'polygon' && overlayGeometry.points && (
                        <polygon 
                          points={overlayGeometry.points.map((p: any) => `${p[0]},${p[1]}`).join(' ')}
                          fill="rgba(239, 68, 68, 0.1)"
                          stroke={accentColor}
                          strokeWidth="0.01"
                          vectorEffect="non-scaling-stroke"
                        >
                          <animate attributeName="stroke-opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" />
                        </polygon>
                      )}
                      {overlayGeometry.type === 'rect' && (
                        <rect 
                          x={overlayGeometry.x1} y={overlayGeometry.y1} 
                          width={overlayGeometry.x2 - overlayGeometry.x1} 
                          height={overlayGeometry.y2 - overlayGeometry.y1}
                          fill="rgba(239, 68, 68, 0.1)"
                          stroke={accentColor}
                          strokeWidth="0.01"
                        />
                      )}
                      {overlayGeometry.type === 'point' && (
                        <circle cx={overlayGeometry.x} cy={overlayGeometry.y} r="0.02" fill={accentColor} stroke="#fff" strokeWidth="0.005" />
                      )}
                    </svg>
                  )}
                  <div className="ah-evidence-label" style={{ background: 'var(--admin-accent)', zIndex: 11 }}>LUỒNG CAMERA TRỰC TUYẾN</div>
                </div>
              ) : (
                <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', height: '100%', minHeight: 240, maxHeight: 320, aspectRatio: '16/9', background: '#111' }}>
                  <div style={{ opacity: 0.2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                    <Camera size={32} />
                    <span style={{ fontSize: '0.65rem', fontWeight: 900 }}>BẢN ĐỒ VÙNG CẢNH BÁO</span>
                  </div>
                  {/* OVERLAY LAYER */}
                  {overlayGeometry && (
                    <svg viewBox="0 0 1 1" preserveAspectRatio="none" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
                      {overlayGeometry.type === 'polygon' && overlayGeometry.points && <polygon points={overlayGeometry.points.map((p: any) => `${p[0]},${p[1]}`).join(' ')} fill="rgba(239, 68, 68, 0.15)" stroke={accentColor} strokeWidth="0.01" vectorEffect="non-scaling-stroke" />}
                      {overlayGeometry.type === 'rect' && <rect x={overlayGeometry.x1} y={overlayGeometry.y1} width={overlayGeometry.x2 - overlayGeometry.x1} height={overlayGeometry.y2 - overlayGeometry.y1} fill="rgba(239, 68, 68, 0.15)" stroke={accentColor} strokeWidth="0.01" />}
                      {overlayGeometry.type === 'point' && <circle cx={overlayGeometry.x} cy={overlayGeometry.y} r="0.02" fill={accentColor} stroke="#fff" strokeWidth="0.005" />}
                    </svg>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="ah-detail-section">
          <div className="ah-section-title">Thông báo hệ thống</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 900, lineHeight: 1.4, color: 'var(--admin-text)', marginBottom: 12 }}>{data.message}</div>
          <div className="ah-info-item highlight">
            <span className="ah-info-key">Thời gian kích hoạt</span>
            <span className="ah-info-val" style={{ fontFamily: 'var(--admin-font-mono)' }}>{fmtDateTime(data.triggeredAt)}</span>
          </div>
        </div>

        <div className="ah-detail-section">
          <div className="ah-section-title">Dữ liệu kỹ thuật</div>
          <div className="ah-info-grid">
            <div className="ah-info-item">
              <span className="ah-info-key">Trạng thái hiện tại</span>
              <span className="ah-info-val" style={{ color: accentColor }}>{statusLabel[data.status] || data.status}</span>
            </div>
            <div className="ah-info-item">
              <span className="ah-info-key">Nguồn phát hiện</span>
              <span className="ah-info-val">{sourceLabel[data.source] || data.source}</span>
            </div>
            {data.value != null && (
              <div className="ah-info-item highlight" style={{ borderLeft: '4px solid var(--admin-accent)' }}>
                <span className="ah-info-key" style={{ color: 'var(--admin-accent)' }}>Giá trị đo lường</span>
                <span className="ah-info-val" style={{ fontSize: '1.2rem', color: accentColor }}>
                  {data.value.toFixed(2)}
                  <small style={{ fontSize: '0.7rem', marginLeft: 6, opacity: 0.5 }}>{unit}</small>
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="ah-detail-section">
          <div className="ah-section-title">Nhật ký xử lý</div>
          <div className="ah-timeline">
            <div className="ah-tl-item">
              <div className="ah-tl-line"></div>
              <div className="ah-tl-dot" style={{ borderColor: accentColor }}></div>
              <div className="ah-tl-content">
                <div className="ah-tl-header">
                  <span className="ah-tl-time">{fmtDateTime(data.triggeredAt)}</span>
                  <span className="ah-tl-actor">SYSTEM</span>
                </div>
                <div className="ah-tl-msg">Hệ thống phát sinh cảnh báo {levelText.toLowerCase()}</div>
              </div>
            </div>
            {data.history.map((h, i) => (
              <div key={i} className="ah-tl-item">
                <div className="ah-tl-line"></div>
                <div className="ah-tl-dot" style={{ borderColor: h.status === 'closed' ? '#10B981' : '#F59E0B' }}></div>
                <div className="ah-tl-content">
                  <div className="ah-tl-header">
                    <span className="ah-tl-time">{fmtDateTime(h.changedAt)}</span>
                    <span className="ah-tl-actor">{(h.changedBy || 'VẬN HÀNH').toUpperCase()}</span>
                  </div>
                  <div className="ah-tl-msg">Chuyển trạng thái sang: <b>{statusLabel[h.status] || h.status}</b></div>
                  {h.note && <div className="ah-tl-note">{h.note}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="ah-actions-footer">
        {data.status !== 'closed' && (
          <button className="ah-btn-footer ah-btn-footer-danger" onClick={onCloseAlert}>Đóng cảnh báo</button>
        )}
        {data.status === 'open' && (
          <button className="ah-btn-footer ah-btn-footer-primary" onClick={onAck}>Tiếp nhận xử lý</button>
        )}
      </div>
    </div>
  );
}
