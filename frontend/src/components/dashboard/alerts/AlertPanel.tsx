import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AlertItem } from '@/types/api.types';

interface AlertPanelProps {
  alerts: AlertItem[];
  onAlertClick?: (alert: AlertItem) => void;
}

/** Phân loại cảnh báo dựa trên nội dung thông điệp để hiển thị tiêu đề thu gọn. */
const getCategory = (msg: string) => {
  const m = (msg || '').toLowerCase();
  if (m.includes('cháy') || m.includes('lửa') || m.includes('khói') || m.includes('fire') || m.includes('smoke')) {
    return { text: 'CHÁY', color: '#ef4444', bg: 'rgba(239,68,68,0.15)', border: 'rgba(239,68,68,0.35)' };
  }
  if (m.includes('người') || m.includes('xâm nhập') || m.includes('bảo hộ') || m.includes('ppe') || m.includes('nhân viên')) {
    return { text: 'NGƯỜI', color: '#06b6d4', bg: 'rgba(6,182,212,0.12)', border: 'rgba(6,182,212,0.2)' };
  }
  if (m.includes('pd') || m.includes('phóng điện') || m.includes('phong dien') || m.includes('acoustic') || m.includes('âm thanh') || m.includes('tần số') || m.includes('discharge')) {
    return { text: 'PD', color: '#a855f7', bg: 'rgba(168,85,247,0.12)', border: 'rgba(168,85,247,0.2)' };
  }
  if (m.includes('nhiệt') || m.includes('roi') || m.includes('thermal') || m.includes('quá nhiệt') || m.includes('temp')) {
    return { text: 'NHIỆT', color: '#f97316', bg: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.2)' };
  }
  return { text: 'HỆ THỐNG', color: '#64748b', bg: 'rgba(100,116,139,0.12)', border: 'rgba(100,116,139,0.2)' };
};

/**
 * Tính thời gian tương đối từ timestamp ISO đến hiện tại (vừa xong / x phút / x giờ / x ngày).
 * @param iso - Chuỗi thời gian ISO 8601
 */
const timeAgo = (iso: string) => {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m}p trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h trước`;
  return `${Math.floor(h / 24)}n trước`;
};


/**
 * Panel cảnh báo gần đây trên Dashboard: liệt kê tối đa 12 cảnh báo mới nhất,
 * có thể thu gọn và điều hướng đến trang lịch sử chi tiết.
 */
export default function AlertPanel({ alerts, onAlertClick }: AlertPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const navigate = useNavigate();

  const isFireAlert = (a: AlertItem) => {
    const m = (a.message || '').toLowerCase();
    return m.includes('cháy') || m.includes('lửa') || m.includes('khói') || m.includes('fire') || m.includes('smoke');
  };

  const sorted = [...alerts].sort((a, b) => {
    const aFire = isFireAlert(a);
    const bFire = isFireAlert(b);
    if (aFire && !bFire) return -1;
    if (!aFire && bFire) return 1;
    return new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime();
  });

  const openCount = alerts.filter(a => a.status === 'open').length;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      flex: isCollapsed ? '0 0 auto' : (sorted.length === 0 ? '0 0 auto' : '0 1 auto'),
      maxHeight: '480px',
      minHeight: 0,
      background: 'var(--admin-overlay)', backdropFilter: 'blur(12px)',
      border: `1px solid ${openCount > 0 ? 'rgba(239,68,68,0.35)' : 'var(--admin-border)'}`,
      borderRadius: 0, overflow: 'hidden', boxShadow: 'var(--admin-shadow)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '2px 4px', borderBottom: '1px solid var(--admin-border-light)',
        background: 'var(--admin-hover)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: '0.55rem', fontWeight: 800, color: 'var(--admin-text)', letterSpacing: '.3px' }}>
            MỚI
          </span>
          {openCount > 0 && (
            <span style={{
              fontSize: '0.45rem', fontWeight: 800, padding: '0px 3px', borderRadius: 0,
              background: 'var(--admin-tag-danger-bg)', color: 'var(--admin-tag-danger-text)',
              border: '1px solid var(--admin-tag-danger-bg)',
            }}>
              {openCount}
            </span>
          )}
        </div>
        <button
          onClick={() => setIsCollapsed(v => !v)}
          style={{ background: 'none', border: 'none', color: 'var(--admin-text-muted)', cursor: 'pointer', fontSize: '0.75rem', lineHeight: 1, padding: '0 1px' }}
        >
          {isCollapsed ? '▼' : '▲'}
        </button>
      </div>

      {/* List */}
      {!isCollapsed && (
        <>
          {sorted.length === 0 ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '8px 8px',
              color: '#10b981', 
              fontSize: '0.6rem',
              fontWeight: 800,
              background: 'rgba(16,185,129,0.06)',
              borderBottom: '1px solid var(--admin-border-light)',
              letterSpacing: '0.2px'
            }}>
              <span style={{ fontSize: '0.7rem', lineHeight: 1 }}>✓</span>
              ỔN ĐỊNH
            </div>
          ) : (
            <div style={{ overflowY: 'auto', flex: '0 1 auto', padding: '2px 4px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.6rem' }}>
                <tbody>
                  {sorted.slice(0, 30).map((a, idx) => {
                    const isAlarm = a.level === 'alarm';
                    const cat = getCategory(a.message);
                    
                    // Dynamic colors for NHIỆT & CHÁY
                    const isThermal = cat.text === 'NHIỆT';
                    const isFire = cat.text === 'CHÁY';
                    const finalCatColor = isFire ? '#ef4444' : (isThermal ? (isAlarm ? '#ef4444' : '#f59e0b') : cat.color);
                    const finalCatBg = isFire ? 'rgba(239,68,68,0.15)' : (isThermal ? (isAlarm ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)') : cat.bg);
                    const finalCatBorder = isFire ? 'rgba(239,68,68,0.35)' : (isThermal ? (isAlarm ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)') : cat.border);

                    return (
                      <tr
                        key={a.id}
                        onClick={() => {
                          if (onAlertClick) {
                            onAlertClick(a);
                          } else {
                            navigate(`/alerts-history?alertId=${a.id}`);
                          }
                        }}
                        style={{
                          borderBottom: '1px solid var(--admin-border-light)',
                          background: idx % 2 === 0 ? 'transparent' : 'var(--admin-layer-1)',
                          cursor: 'pointer',
                          transition: 'all 0.15s'
                        }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--admin-hover)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = idx % 2 === 0 ? 'transparent' : 'var(--admin-layer-1)'}
                      >
                        {/* Time */}
                        <td style={{ padding: '1px 2px', color: 'var(--admin-text-muted)', whiteSpace: 'nowrap', textAlign: 'left', width: '70%' }}>
                          {timeAgo(a.triggeredAt)}
                        </td>
                        {/* Category Pill */}
                        <td style={{ padding: '1px 2px', textAlign: 'right', width: '30%' }}>
                          <span style={{
                            display: 'inline-block',
                            fontSize: '0.46rem',
                            fontWeight: 900,
                            padding: '1px 3px',
                            borderRadius: 0,
                            background: finalCatBg,
                            color: finalCatColor,
                            border: `1px solid ${finalCatBorder}`,
                            minWidth: 28,
                            textAlign: 'center',
                            lineHeight: 1.1
                          }}>
                            {cat.text}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Footer */}
          <div
            onClick={() => navigate('/alerts-history')}
            style={{
              padding: '2px 4px', borderTop: '1px solid var(--admin-border-light)',
              background: 'var(--admin-hover)', textAlign: 'center', cursor: 'pointer', flexShrink: 0,
            }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = '0.7'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = '1'}
          >
            <span style={{ fontSize: '0.55rem', fontWeight: 800, color: 'var(--admin-accent)' }}>
              LỊCH SỬ →
            </span>
          </div>
        </>
      )}
    </div>
  );
}
