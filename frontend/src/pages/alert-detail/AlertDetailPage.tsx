// ============================================================
// AlertDetailPage.tsx — Trang chi tiết một cảnh báo
// Truy cập qua: /alert-detail?alertId=xxx hoặc navigate từ AlertsHistoryPage
// Hiển thị: thông tin đầy đủ, ảnh/video bằng chứng, lịch sử xử lý
// Chức năng: xác nhận (ack), đóng cảnh báo, tạo phiếu bảo trì
// ============================================================

import { useState, useEffect, ReactNode, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { stationApi, type AlertItem, type AlertHistoryEntry } from '@/services/StationApiService';
import { useDeviceStore } from '@/store';
import { fmtDateTime } from '@/utils/format';
import { showToast } from '@/utils/toast';
import { API_BASE_URL } from '@/utils/env';
import { confirmDialog } from '@/utils/confirm';

// AlertDetail = dữ liệu cảnh báo + mảng lịch sử thay đổi trạng thái
type AlertDetail = AlertItem & { history: AlertHistoryEntry[] };

/**
 * Trang chi tiết cảnh báo độc lập, truy cập qua query param ?id=<alertId>.
 * Hiển thị đầy đủ: thông tin, ảnh/video bằng chứng, biểu đồ cảm biến và
 * timeline lịch sử xử lý. Cho phép ACK và đóng cảnh báo ngay trên trang.
 */
export default function AlertDetailPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const id = searchParams.get('id');

  const [alert, setAlert] = useState<AlertDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [context, setContext] = useState<any>(null);
  const findDevice = useDeviceStore(s => s.findById);
  const device = alert?.deviceId ? findDevice(alert.deviceId) : undefined;

  /** Tải chi tiết cảnh báo và dữ liệu ngữ cảnh cảm biến ±30s quanh sự kiện. */
  const loadAlertDetail = async () => {
    if (!id) {
      setErrorMsg('Không tìm thấy ID cảnh báo.');
      return;
    }

    setLoading(true);
    setErrorMsg('');
    try {
      const data = await stationApi.getAlertDetail(id) as any;
      setAlert(data);

      // Tải thêm dữ liệu cảm biến 30 giây quanh thời điểm sự kiện
      if (data.detectionId || data.id) {
        const ctx = await stationApi.getEventContext(data.detectionId || data.id).catch(() => null);
        setContext(ctx);
      }
    } catch (e: any) {
      setErrorMsg(`Không thể tải chi tiết cảnh báo: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAlertDetail();
  }, [id]);

  /** Gửi xác nhận ACK kèm ghi chú người dùng nhập qua prompt. */
  const handleAck = async () => {
    if (!alert) return;
    const note = prompt('Ghi chú ACK (tùy chọn):');
    if (note === null) return; // người dùng huỷ prompt

    try {
      await stationApi.ackAlert(alert.id, note);
      showToast('Đã xác nhận cảnh báo (ACK)', 'success');
      loadAlertDetail();
    } catch (e: any) {
      showToast(`Lỗi xác nhận cảnh báo: ${e.message || e}`, 'error');
    }
  };

  /** Đóng cảnh báo sau khi người dùng xác nhận qua confirm dialog. */
  const handleClose = async () => {
    if (!alert) return;
    if (!await confirmDialog({ title: 'Đóng cảnh báo', message: 'Xác nhận đóng cảnh báo này?', confirmText: 'Đóng', danger: false })) return;

    try {
      await stationApi.closeAlert(alert.id);
      showToast('Đã xử lý cảnh báo', 'success');
      loadAlertDetail();
    } catch (e: any) {
      showToast(`Lỗi đóng cảnh báo: ${e.message || e}`, 'error');
    }
  };

  if (loading) {
    return (
      <div className="list-page" style={{ maxWidth: 900, margin: '0 auto', padding: 40, textAlign: 'center', color: 'var(--admin-text-muted)' }}>
        ⏳ Đang tải chi tiết cảnh báo...
      </div>
    );
  }

  if (errorMsg || !alert) {
    return (
      <div className="list-page" style={{ maxWidth: 900, margin: '0 auto', padding: 40, textAlign: 'center', color: 'var(--admin-danger)' }}>
        ️ {errorMsg || 'Không có ID cảnh báo.'}
        <div style={{ marginTop: 20 }}>
          <button className="btn-industrial" onClick={() => navigate(-1)}>← Quay lại</button>
        </div>
      </div>
    );
  }

  const isAlarm = alert.level === 'alarm';
  const color = isAlarm ? 'var(--admin-danger)' : 'var(--admin-warning)';
  const levelText = isAlarm ? 'BÁO ĐỘNG' : 'CẢNH BÁO';

  const statusLabel: Record<string, string> = {
    open: 'Chưa xử lý',
    acked: '🟡 Đang xử lý',
    closed: '🟢 Đã xử lý',
  };
  const sourceLabel: Record<string, string> = {
    rule_engine: 'Quy tắc tự động',
    ai_detection: 'AI Detection',
    manual: 'Thủ công',
    maintenance: 'Bảo trì',
  };

  // Hàm trợ giúp: định dạng timestamp hoặc trả về '—' nếu không có giá trị
  const fmt = (ts?: string) => (ts ? fmtDateTime(ts) : '—');

  // Parse metadata để lấy thêm thông tin (ví dụ link ảnh quang học/nhiệt song song)
  const metadata = typeof alert.metadata === 'string' ? (() => { try { return JSON.parse(alert.metadata); } catch { return {}; } })() : (alert.metadata || {});

  // Phân tích tọa độ vùng từ metadata hoặc context boundary để vẽ đè lên ảnh/video bằng chứng
  const overlayGeometry = useMemo(() => {
    // Trường hợp 1: ROI đa giác (array of [x, y])
    if (metadata.polygon) {
      try {
        const pts = typeof metadata.polygon === 'string' ? JSON.parse(metadata.polygon) : metadata.polygon;
        if (Array.isArray(pts)) return { type: 'polygon', points: pts };
      } catch {}
    }

    // Trường hợp 2: Điểm chấm nhiệt (tx, ty)
    if (metadata.tx != null && metadata.ty != null) {
      return { type: 'point', x: metadata.tx, y: metadata.ty };
    }

    // Trường hợp 3: Vùng ROI chữ nhật (x1, y1, x2, y2)
    if (metadata.x1 != null && metadata.y1 != null) {
      return { type: 'rect', x1: metadata.x1, y1: metadata.y1, x2: metadata.x2, y2: metadata.y2 };
    }

    // Fallback: Tìm polygon của boundary liên kết nếu có
    if (context?.boundary) {
      try {
        const polygonVal = context.boundary.polygonJson || context.boundary.polygon || context.boundary.PolygonJson || context.boundary.Polygon;
        if (polygonVal) {
          const pts = typeof polygonVal === 'string' ? JSON.parse(polygonVal) : polygonVal;
          if (Array.isArray(pts)) return { type: 'polygon', points: pts };
        }
      } catch {}
    }

    return null;
  }, [metadata, context]);

  /**
   * Render một dòng thông tin dạng label — value theo chiều ngang.
   * Dùng để hiển thị các trường như trạng thái, nguồn, giá trị...
   */
  const infoRow = (label: string, value: ReactNode) => (
    <div 
      style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 0', borderBottom: '1px solid var(--admin-border-light)'
      }}
    >
      <span style={{ fontSize: '.78rem', color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '.3px' }}>{label}</span>
      <span style={{ fontSize: '.85rem', color: 'var(--admin-text)', fontWeight: 600 }}>{value}</span>
    </div>
  );

  /**
   * Render một mục trong timeline lịch sử xử lý cảnh báo.
   * @param o - Thông tin mục: icon, màu, thời gian, người thực hiện, mô tả
   * @param idx - Chỉ số dùng làm key React
   */
  const timelineItem = (o: { icon: string; color: string; time: string; actor: string; desc: string; isFirst: boolean }, idx: number) => (
    <div key={idx} style={{ display: 'flex', gap: 14, position: 'relative', paddingBottom: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
        <div 
          style={{
            width: 30, height: 30, borderRadius: '50%', background: `${o.color}22`,
            border: `2px solid ${o.color}`, display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: '.75rem', color: o.color, fontWeight: 700
          }}
        >
          {o.icon}
        </div>
        {!o.isFirst && (
          <div style={{ width: 2, flex: 1, background: 'var(--admin-border-light)', marginTop: 4, minHeight: 16 }}></div>
        )}
      </div>
      <div style={{ flex: 1, paddingTop: 4 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '.7rem', fontFamily: 'monospace', color: 'var(--admin-text-muted)' }}>{o.time}</span>
          <span 
            style={{
              fontSize: '.65rem', fontWeight: 700, padding: '1px 7px', borderRadius: 0,
              background: 'var(--admin-bg)', border: '1px solid var(--admin-border-light)',
              color: 'var(--admin-text)', opacity: .8
            }}
          >
            {o.actor.toUpperCase()}
          </span>
        </div>
        <div style={{ fontSize: '.85rem', color: 'var(--admin-text-muted)' }} dangerouslySetInnerHTML={{ __html: o.desc }}></div>
      </div>
    </div>
  );

  return (
    <div className="list-page" style={{ maxWidth: 900, margin: '0 auto', padding: '20px 0' }}>
      {/* Header breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <button className="btn-industrial" onClick={() => navigate(-1)}>← Quay lại</button>
        <span style={{ color: 'var(--admin-text-muted)' }}>Nhật ký cảnh báo</span>
        <span style={{ color: 'var(--admin-text-muted)', opacity: 0.5 }}>/</span>
        <span style={{ color: '#44ff88', fontSize: '.85rem', fontFamily: 'monospace' }}>{alert.id.slice(0, 8)}…</span>
        
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {alert.status === 'open' && (
            <button className="btn-industrial btn-primary" onClick={handleAck}>Tiếp nhận</button>
          )}
          {alert.status === 'acked' && (
            <button className="btn-industrial btn-danger" onClick={handleClose}>Đóng</button>
          )}
          <button className="btn-industrial" onClick={() => navigate('/analytics')}>Xem phân tích</button>
        </div>
      </div>

      {/* Level banner */}
      <div 
        style={{
          background: `${color}12`, border: `1px solid ${color}33`, borderRadius: 0,
          padding: '14px 20px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 14
        }}
      >
        <div 
          style={{
            width: 10, height: 10, borderRadius: '50%', background: color,
            flexShrink: 0, boxShadow: `0 0 8px ${color}`
          }}
        ></div>
        <span style={{ fontSize: '1rem', fontWeight: 800, color: color }}>{levelText}</span>
        <span style={{ opacity: .85, fontSize: '.9rem', color: 'var(--admin-text)' }}>{alert.message}</span>
        <span style={{ marginLeft: 'auto', fontSize: '.8rem', color: 'var(--admin-text-muted)' }}>{fmt(alert.triggeredAt)}</span>
      </div>

      {/* 2-column info */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
        <div className="admin-card" style={{ padding: 20 }}>
          <div className="card-title" style={{ marginBottom: 14 }}>THÔNG TIN CẢNH BÁO</div>
          {infoRow('Mức độ', <span className={`tag ${isAlarm ? 'tag-danger' : 'tag-warning'}`}>{levelText}</span>)}
          {infoRow('Trạng thái', statusLabel[alert.status] ?? alert.status)}
          {infoRow('Nguồn', sourceLabel[alert.source] ?? alert.source)}
          {infoRow('Giá trị', alert.value !== undefined ? <b style={{ color: color }}>{alert.value.toFixed(2)}</b> : '—')}
          {infoRow('Phát sinh', fmt(alert.triggeredAt))}
          {infoRow('ACK lúc', fmt(alert.ackedAt))}
          {infoRow('Đóng lúc', fmt(alert.closedAt))}
          {alert.ackNote && infoRow('Ghi chú ACK', <em style={{ color: 'var(--admin-text-muted)' }}>{alert.ackNote}</em>)}
        </div>

        <div className="admin-card" style={{ padding: 20 }}>
          <div className="card-title" style={{ marginBottom: 14 }}>ID THAM CHIẾU</div>
          {infoRow('Alert ID', <code style={{ fontSize: '.72rem', color: 'var(--admin-text-muted)' }}>{alert.id}</code>)}
          {infoRow('Thiết bị', alert.deviceId ? (
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); navigate(`/device-management?deviceId=${alert.deviceId}`); }}
              style={{ color: 'var(--admin-info-text)', textDecoration: 'underline', cursor: 'pointer', fontSize: '.85rem' }}
              title="Mở trang quản lý thiết bị"
            >
              {device?.name ?? alert.deviceId.slice(0, 8)}
              <span style={{ marginLeft: 6, opacity: .6 }}>→</span>
            </a>
          ) : '—')}
          {infoRow('Quy tắc tự động', alert.ruleId ? (
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); navigate(`/rule-engine?ruleId=${alert.ruleId}`); }}
              style={{ color: 'var(--admin-info-text)', textDecoration: 'underline', cursor: 'pointer', fontSize: '.85rem' }}
              title="Xem Quy tắc tự động"
            >
              {alert.ruleId.slice(0, 8)}
              <span style={{ marginLeft: 6, opacity: .6 }}>→</span>
            </a>
          ) : '—')}
          <div style={{ marginTop: 20, padding: 12, background: 'rgba(59,130,246,.06)', border: '1px solid rgba(59,130,246,.15)', borderRadius: 0, fontSize: '.8rem', color: 'var(--admin-info-text)', lineHeight: 1.5 }}>
            Để xem xu hướng dữ liệu theo thời gian, dùng trang <b>Phân tích</b>.
            <br />
            <button className="btn-industrial btn-primary" style={{ marginTop: 10, fontSize: '.8rem' }} onClick={() => navigate('/analytics')}>
              Mở trang Phân tích
            </button>
          </div>
        </div>
      </div>

      {/* Evidence Section (Image/Video) */}
      <div style={{ display: 'grid', gridTemplateColumns: alert.videoUrl ? '1fr 1fr' : '1fr', gap: 16, marginBottom: 20 }}>
        {(alert.imageUrl || metadata?.snapshotUrl) && (
          <div className="admin-card" style={{ padding: 16 }}>
            <div className="card-title" style={{ marginBottom: 12 }}>ẢNH CHỤP BẰNG CHỨNG</div>
            
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {/* Ảnh Chính (Nếu có opticalSnapshotUrl thì ImageUrl là ảnh quang học) */}
              <div style={{ flex: 1, minWidth: 280 }}>
                {metadata?.opticalSnapshotUrl && (
                  <div style={{ fontSize: '.7rem', color: 'var(--admin-accent)', fontWeight: 800, marginBottom: 4, textTransform: 'uppercase' }}>
                    📷 Ảnh Quang học (Chụp khẩn cấp)
                  </div>
                )}
                <div style={{ position: 'relative', width: '100%' }}>
                  <img 
                    src={alert.imageUrl?.startsWith('http') ? alert.imageUrl : `${API_BASE_URL}${alert.imageUrl}`} 
                    alt="Evidence" 
                    style={{ display: 'block', width: '100%', height: 'auto', border: '1px solid var(--admin-border)', borderRadius: 4 }}
                  />
                  {overlayGeometry && (
                    <svg 
                      viewBox="0 0 1 1" 
                      preserveAspectRatio="none"
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 10 }}
                    >
                      {overlayGeometry.type === 'polygon' && overlayGeometry.points && (
                        <polygon 
                          points={overlayGeometry.points.map((p: any) => `${p[0]},${p[1]}`).join(' ')}
                          fill="rgba(239, 68, 68, 0.15)"
                          stroke={color}
                          strokeWidth="0.01"
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                      {overlayGeometry.type === 'rect' && (
                        <rect 
                          x={overlayGeometry.x1} y={overlayGeometry.y1} 
                          width={overlayGeometry.x2 - overlayGeometry.x1} 
                          height={overlayGeometry.y2 - overlayGeometry.y1}
                          fill="rgba(239, 68, 68, 0.15)"
                          stroke={color}
                          strokeWidth="0.01"
                        />
                      )}
                      {overlayGeometry.type === 'point' && (
                        <circle cx={overlayGeometry.x} cy={overlayGeometry.y} r="0.02" fill={color} stroke="#fff" strokeWidth="0.005" />
                      )}
                    </svg>
                  )}
                </div>
              </div>

              {/* Ảnh Nhiệt (Nếu có ảnh quang học riêng thì hiển thị ảnh nhiệt song song) */}
              {metadata?.opticalSnapshotUrl && metadata?.snapshotUrl && (
                <div style={{ flex: 1, minWidth: 280 }}>
                  <div style={{ fontSize: '.7rem', color: 'var(--admin-danger)', fontWeight: 800, marginBottom: 4, textTransform: 'uppercase' }}>
                    🌡️ Ảnh Nhiệt (Gốc)
                  </div>
                  <div style={{ position: 'relative', width: '100%' }}>
                    <img 
                      src={metadata.snapshotUrl.startsWith('http') ? metadata.snapshotUrl : `${API_BASE_URL}${metadata.snapshotUrl}`} 
                      alt="Thermal Evidence" 
                      style={{ display: 'block', width: '100%', height: 'auto', border: '1px solid var(--admin-border)', borderRadius: 4 }}
                    />
                    {overlayGeometry && (
                      <svg 
                        viewBox="0 0 1 1" 
                        preserveAspectRatio="none"
                        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 10 }}
                      >
                        {overlayGeometry.type === 'polygon' && overlayGeometry.points && (
                          <polygon 
                            points={overlayGeometry.points.map((p: any) => `${p[0]},${p[1]}`).join(' ')}
                            fill="rgba(239, 68, 68, 0.15)"
                            stroke={color}
                            strokeWidth="0.01"
                            vectorEffect="non-scaling-stroke"
                          />
                        )}
                        {overlayGeometry.type === 'rect' && (
                          <rect 
                            x={overlayGeometry.x1} y={overlayGeometry.y1} 
                            width={overlayGeometry.x2 - overlayGeometry.x1} 
                            height={overlayGeometry.y2 - overlayGeometry.y1}
                            fill="rgba(239, 68, 68, 0.15)"
                            stroke={color}
                            strokeWidth="0.01"
                          />
                        )}
                        {overlayGeometry.type === 'point' && (
                          <circle cx={overlayGeometry.x} cy={overlayGeometry.y} r="0.02" fill={color} stroke="#fff" strokeWidth="0.005" />
                        )}
                      </svg>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {alert.videoUrl && (
          <div className="admin-card" style={{ padding: 16 }}>
            <div className="card-title" style={{ marginBottom: 12 }}>VIDEO GHI HÌNH SỰ KIỆN</div>
            
            <div style={{ position: 'relative', width: '100%', display: 'inline-block', background: '#000', borderRadius: 4, overflow: 'hidden' }}>
              <video 
                src={alert.videoUrl.startsWith('http') ? alert.videoUrl : `${API_BASE_URL}/api/v1/events/${(alert as any).detectionId || alert.id}/video`} 
                controls 
                style={{ display: 'block', width: '100%', height: 'auto' }}
              />
              
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
                      fill="rgba(239, 68, 68, 0.15)"
                      stroke={color}
                      strokeWidth="0.01"
                      vectorEffect="non-scaling-stroke"
                    >
                      <animate attributeName="stroke-opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite" />
                    </polygon>
                  )}
                  {overlayGeometry.type === 'rect' && (
                    <rect 
                      x={overlayGeometry.x1} y={overlayGeometry.y1} 
                      width={overlayGeometry.x2 - overlayGeometry.x1} 
                      height={overlayGeometry.y2 - overlayGeometry.y1}
                      fill="rgba(239, 68, 68, 0.15)"
                      stroke={color}
                      strokeWidth="0.01"
                    >
                      <animate attributeName="stroke-opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite" />
                    </rect>
                  )}
                  {overlayGeometry.type === 'point' && (
                    <g transform={`translate(${overlayGeometry.x}, ${overlayGeometry.y})`}>
                      <circle r="0.02" fill="none" stroke={color} strokeWidth="0.005">
                         <animate attributeName="r" values="0.01;0.04;0.01" dur="1.5s" repeatCount="indefinite" />
                         <animate attributeName="stroke-opacity" values="1;0;1" dur="1.5s" repeatCount="indefinite" />
                      </circle>
                      <path d="M-0.03 0 L0.03 0 M0 -0.03 L0 0.03" stroke={color} strokeWidth="0.005" />
                    </g>
                  )}
                </svg>
              )}
            </div>
            <div style={{ marginTop: 10, textAlign: 'right' }}>
              <a 
                href={`${API_BASE_URL}/api/v1/events/${(alert as any).detectionId || alert.id}/bundle`}
                className="btn-industrial" 
                style={{ fontSize: '.75rem' }}
                target="_blank" rel="noreferrer"
              >
                📥 Tải xuống gói dữ liệu (.zip)
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Sensor Readings Timeline Context */}
      {context?.sensorReadings && context.sensorReadings.length > 0 && (
        <div className="admin-card" style={{ padding: 20, marginBottom: 20 }}>
          <div className="card-title" style={{ marginBottom: 16 }}>BIỂU ĐỒ CẢM BIẾN (±30s XUNG QUANH EVENT)</div>
          <div style={{ height: 200, display: 'flex', alignItems: 'flex-end', gap: 2, paddingBottom: 20, borderBottom: '1px solid var(--admin-border)' }}>
             {/* Mock visual timeline if no chart lib integrated yet */}
             {context.sensorReadings.map((r: any, idx: number) => {
               const max = Math.max(...context.sensorReadings.map((x: any) => x.value || 0));
               const height = ((r.value || 0) / (max || 1)) * 100;
               const isNearEvent = Math.abs(new Date(r.time).getTime() - new Date(alert.triggeredAt).getTime()) < 5000;
               return (
                 <div key={idx} title={`${r.pointId}: ${r.value}${r.unit} at ${new Date(r.time).toLocaleTimeString()}`} style={{ 
                   flex: 1, height: `${height}%`, background: isNearEvent ? 'var(--admin-danger)' : 'var(--admin-info-text)',
                   opacity: .6, minWidth: 2
                 }}></div>
               );
             })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.7rem', color: 'var(--admin-text-muted)', marginTop: 8 }}>
            <span>{new Date(context.sensorReadings[0].time).toLocaleTimeString()}</span>
            <span>THỜI ĐIỂM PHÁT HIỆN ({new Date(alert.triggeredAt).toLocaleTimeString()})</span>
            <span>{new Date(context.sensorReadings[context.sensorReadings.length - 1].time).toLocaleTimeString()}</span>
          </div>
        </div>
      )}

      {/* Timeline history */}
      <div className="admin-card" style={{ padding: 20 }}>
        <div className="card-title" style={{ marginBottom: 16 }}>LỊCH SỬ XỬ LÝ</div>
        {alert.history.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--admin-text-muted)', fontSize: '.85rem' }}>
            Chưa có lịch sử xử lý.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {/* System initial timeline item */}
            {timelineItem({
              icon: '', color: color,
              time: fmt(alert.triggeredAt),
              actor: 'SYSTEM',
              desc: `Cảnh báo phát sinh — ${levelText} — ${alert.message}`,
              isFirst: true,
            }, -1)}
            {alert.history.map((h, idx) => timelineItem({
              icon: h.status === 'acked' ? '' : h.status === 'closed' ? '' : '•',
              color: h.status === 'closed' ? 'var(--admin-success)' : h.status === 'acked' ? 'var(--admin-warning)' : 'var(--admin-text-muted)',
              time: fmt(h.changedAt),
              actor: h.changedBy || 'system',
              desc: `Chuyển trạng thái → <b>${statusLabel[h.status] ?? h.status}</b>${h.note ? ` — <em style="color:var(--admin-text-muted)">${h.note}</em>` : ''}`,
              isFirst: false,
            }, idx))}
          </div>
        )}
      </div>
    </div>
  );
}
