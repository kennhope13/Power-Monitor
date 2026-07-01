import { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CAM_POINT_LABELS, PT_PD } from '@/constants/points';
import type { Rule } from '@/types/api.types';

export interface CameraSensor {
  pid: string;
  value: number;
  unit?: string;
  deviceName?: string;
  pointName?: string;
}

interface CameraGridProps {
  sensors: CameraSensor[];
  alertsCount: number;
  /** Danh sách Rule để lấy ngưỡng cảnh báo/nguy hiểm cho từng điểm đo */
  rules?: Rule[];
  /** Danh sách camera để chọn */
  camOptionsGroups?: Record<string, { id: string, label: string }[]>;
  /** Camera đang chọn */
  activeCameraSrc?: string;
  /** Callback khi chọn camera */
  onCamChange?: (srcId: string) => void;
}

/** Phân tích ngưỡng từ Rule condition JSON cho 1 điểm đo cụ thể */
function getThresholdsFromRules(pid: string, rules: Rule[]): { warn: number | null; alarm: number | null } {
  for (const r of rules) {
    if (!r.enabled) continue;
    try {
      const cond = JSON.parse(r.condition);
      // Support matching condition point against either whole unique pid or the original pointId part (suffix after last '_')
      const parts = pid.split('_');
      const pointId = parts[parts.length - 1];
      if (cond.point !== pid && cond.point !== pointId && !pid.toLowerCase().includes(cond.point.toLowerCase())) continue;
      const warn = cond.pre_alarm ?? null;
      const alarm = cond.alarm ?? cond.value ?? null;
      return { warn, alarm };
    } catch { continue; }
  }
  return { warn: null, alarm: null };
}

/**
 * Xác định màu hiển thị dựa trên ngưỡng cảnh báo và nguy hiểm.
 */
function getStatusColor(val: number, warn: number | null, alarm: number | null, isPd: boolean = false) {
  if (alarm !== null && val >= alarm) return 'var(--admin-danger)';
  if (warn !== null && val >= warn) return 'var(--admin-warning)';
  
  // Nếu là PD: > 10dB thì xanh đậm (accent), còn lại xanh lá (success) thay vì xám (muted)
  if (isPd) return val >= 10 ? 'var(--admin-accent)' : 'var(--admin-success)';
  
  if (warn === null && alarm === null) return 'var(--admin-text-muted)';
  return 'var(--admin-success)';
}

/**
 * Panel điểm đo Dashboard: hiển thị danh sách điểm đo nhiệt và điểm phóng điện (PD)
 */
export default function CameraGrid({ sensors, alertsCount, rules = [], camOptionsGroups, activeCameraSrc, onCamChange }: CameraGridProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isPdCollapsed, setIsPdCollapsed] = useState(false);
  const [isCamDropdownOpen, setIsCamDropdownOpen] = useState(false);
  const dropdownTriggerRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 0 });

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownTriggerRef.current && !dropdownTriggerRef.current.contains(event.target as Node)) {
        setIsCamDropdownOpen(false);
      }
    };
    if (isCamDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isCamDropdownOpen]);

  // Update menu position when opening
  const toggleDropdown = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isCamDropdownOpen && dropdownTriggerRef.current) {
      const rect = dropdownTriggerRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 160) });
    }
    setIsCamDropdownOpen(!isCamDropdownOpen);
  };

  // Find active camera label
  const activeLabel = useMemo(() => {
    if (!camOptionsGroups || !activeCameraSrc) return 'Chọn Camera';
    for (const group of Object.values(camOptionsGroups)) {
      const found = group.find(opt => opt.id === activeCameraSrc);
      if (found) return found.label;
    }
    return 'Chọn Camera';
  }, [camOptionsGroups, activeCameraSrc]);

  // Phân tách sensors thành Thermal và PD
  const { thermalRows, pdRows } = useMemo(() => {
    const tRows: any[] = [];
    const pRows: any[] = [];

    sensors.forEach(s => {
      const pid = s.pid.toUpperCase();
      const thresholds = getThresholdsFromRules(pid, rules);
      const rawPidPart = pid.split('_').pop() || '';
      
      const labelFromMap = s.pointName || CAM_POINT_LABELS[rawPidPart] || CAM_POINT_LABELS[pid];
      const label = labelFromMap || pid;

      // Cải tiến nhận diện PD: Dựa vào Unit (dB) hoặc từ khóa trong PID/Label
      const isPd = s.unit?.toUpperCase() === 'DB' ||
                   pid === PT_PD.toUpperCase() || 
                   pid.startsWith('PD_') || 
                   pid.includes('_PD') ||
                   label.toUpperCase().startsWith('PD') ||
                   label.toUpperCase().includes('PHÓNG ĐIỆN') ||
                   label.toUpperCase().includes('PHONG DIEN');

      // LOGIC HIỂN THỊ MỚI: 
      // 1. Nếu là Phóng điện (PD): LUÔN HIỂN THỊ (vì đây là dữ liệu an toàn quan trọng)
      // 2. Nếu là Nhiệt độ: CHỈ HIỂN THỊ nếu điểm này có trong cấu hình (đã được đặt tên/label từ backend)
      //    Nếu s.pointName là undefined nghĩa là điểm này không tồn tại trong danh sách ROI/Boundaries của trạm.
      if (!isPd && s.pointName === undefined) return;
      
      const row = {
        pid,
        label,
        sensor: s,
        warn: thresholds.warn,
        alarm: thresholds.alarm,
        isPd
      };

      if (isPd) pRows.push(row);
      else tRows.push(row);
    });

    return {
      thermalRows: tRows.sort((a, b) => (b.sensor?.value ?? -Infinity) - (a.sensor?.value ?? -Infinity)),
      pdRows: pRows.sort((a, b) => (b.sensor?.value ?? -Infinity) - (a.sensor?.value ?? -Infinity))
    };
  }, [sensors, rules]);

  const hottest = thermalRows.find(r => r.sensor);
  const overDanger  = thermalRows.filter(r => r.sensor && r.alarm !== null && r.sensor.value >= r.alarm).length;
  const overWarning = thermalRows.filter(r => r.sensor && r.warn !== null && r.sensor.value >= r.warn && (r.alarm === null || r.sensor.value < r.alarm)).length;

  const pdDanger = pdRows.filter(r => r.sensor && r.alarm !== null && r.sensor.value >= r.alarm).length;

  return (
    <div
      id="floatCamGrid"
      style={{
        width: '100%',
        display: 'flex', flexDirection: 'column', gap: 10
      }}
    >
      {/* SECTION: NHIỆT ĐỘ */}
      <div style={{ background: 'var(--admin-overlay)', backdropFilter: 'blur(12px)', border: '1px solid var(--admin-border)', borderRadius: 0, overflow: 'visible', boxShadow: 'var(--admin-shadow)', position: 'relative' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--admin-border-light)', background: 'var(--admin-hover)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, overflow: 'hidden' }}>
            <span style={{ fontSize: '0.65rem', fontWeight: 800, color: 'var(--admin-text)', letterSpacing: '.5px', whiteSpace: 'nowrap' }}>
              ĐIỂM ĐO NHIỆT
            </span>

            {camOptionsGroups && onCamChange && (
              <div style={{ position: 'relative', marginLeft: 4 }} ref={dropdownTriggerRef}>
                <button
                  onClick={toggleDropdown}
                  style={{
                    fontSize: '0.6rem',
                    padding: '2px 8px',
                    background: 'rgba(255,255,255,0.12)',
                    border: '1px solid var(--admin-border)',
                    color: 'var(--admin-text)',
                    borderRadius: 0,
                    maxWidth: '120px',
                    cursor: 'pointer',
                    outline: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{activeLabel}</span>
                  <span style={{ fontSize: '0.5rem', opacity: 0.6, flexShrink: 0 }}>▼</span>
                </button>

                {isCamDropdownOpen && createPortal(
                  <div
                    style={{
                      position: 'fixed',
                      top: menuPos.top,
                      left: menuPos.left,
                      background: 'var(--admin-panel, #24272a)',
                      border: '1px solid var(--admin-border)',
                      borderRadius: 0,
                      boxShadow: '0 10px 30px rgba(0, 0, 0, 0.6)',
                      zIndex: 99999,
                      minWidth: menuPos.width,
                      maxHeight: 300,
                      overflowY: 'auto',
                      padding: 4,
                      animation: 'dropdownFadeIn 0.1s ease-out',
                    }}
                    onClick={e => e.stopPropagation()}
                  >
                    {Object.entries(camOptionsGroups).map(([zone, opts]) => {
                      // Lọc bỏ các camera PD khỏi danh sách chọn của phần Nhiệt độ
                      const filteredOpts = opts.filter(opt => 
                        !opt.label.toUpperCase().includes('PD') && 
                        !opt.label.toUpperCase().includes('PHÓNG ĐIỆN') &&
                        !opt.label.toUpperCase().includes('PHONG DIEN')
                      );
                      
                      if (filteredOpts.length === 0) return null;

                      return (
                        <div key={zone}>
                          <div style={{ fontSize: '0.55rem', color: 'var(--admin-text-muted)', padding: '6px 8px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid var(--admin-border-light)', marginBottom: 2 }}>{zone}</div>
                          {filteredOpts.map(opt => (
                            <div
                              key={opt.id}
                              onMouseDown={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                console.log('Camera selected:', opt.id);
                                onCamChange(opt.id);
                                setIsCamDropdownOpen(false);
                              }}
                              style={{
                                fontSize: '0.72rem',
                                padding: '8px 12px',
                                color: opt.id === activeCameraSrc ? 'var(--admin-accent)' : 'var(--admin-text)',
                                cursor: 'pointer',
                                background: opt.id === activeCameraSrc ? 'rgba(99,102,241,0.12)' : 'transparent',
                                borderRadius: 0,
                                transition: 'all 0.15s',
                                fontWeight: opt.id === activeCameraSrc ? 700 : 400
                              }}
                              onMouseEnter={(e) => { if (opt.id !== activeCameraSrc) e.currentTarget.style.background = 'var(--admin-hover)'; }}
                              onMouseLeave={(e) => { if (opt.id !== activeCameraSrc) e.currentTarget.style.background = 'transparent'; }}
                            >
                              {opt.label}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>,
                  document.body
                )}
              </div>
            )}

            {overDanger > 0 && (
              <span style={{ fontSize: '0.58rem', fontWeight: 800, color: 'var(--admin-danger)', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 0, padding: '1px 4px', whiteSpace: 'nowrap' }}>
                {overDanger}
              </span>
            )}
            {overWarning > 0 && (
              <span style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--admin-warning)', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 0, padding: '1px 4px', whiteSpace: 'nowrap' }}>
                {overWarning}
              </span>
            )}
          </div>
          <button onClick={() => setIsCollapsed(!isCollapsed)} style={{ background: 'none', border: 'none', color: 'var(--admin-text-muted)', cursor: 'pointer', fontSize: '0.9rem', padding: '0 2px', flexShrink: 0 }}>
            {isCollapsed ? '▼' : '▲'}
          </button>
        </div>

        <style>{`
          @keyframes dropdownFadeIn {
            from { opacity: 0; transform: translateY(-5px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `}</style>

        {!isCollapsed && (
          <div style={{ padding: '4px 0' }}>
            {thermalRows.length === 0 ? (
              <div style={{ padding: '16px 10px', fontSize: '0.68rem', color: 'var(--admin-text-muted)', textAlign: 'center' }}>Chưa cấu hình điểm đo nhiệt</div>
            ) : (
              thermalRows.map((row, idx) => {
                const val = row.sensor?.value;
                const color = val !== undefined ? getStatusColor(val, row.warn, row.alarm) : 'var(--admin-border)';
                const isHottest = row.pid === hottest?.pid && val !== undefined;
                const unit = row.sensor?.unit || '°C';
                return (
                  <div key={row.pid} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: idx < thermalRows.length - 1 ? '1px solid var(--admin-border-light)' : 'none', background: isHottest && val !== undefined && row.alarm !== null && val >= row.alarm ? 'rgba(239,68,68,0.06)' : 'transparent' }}>
                    <div style={{ width: 6, height: 6, borderRadius: 0, background: color, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: '0.68rem', color: 'var(--admin-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isHottest ? 700 : 400 }}>{row.label}</span>
                    <span style={{ fontSize: '0.75rem', fontWeight: 800, color, fontFamily: 'Consolas,monospace', flexShrink: 0 }}>{val !== undefined ? `${val.toFixed(1)}${unit}` : '--'}</span>
                    {isHottest && val !== undefined && (
                      <span style={{ fontSize: '0.52rem', fontWeight: 800, color: 'var(--admin-danger)', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 0, padding: '1px 4px', flexShrink: 0 }}>MAX</span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* SECTION: PHÓNG ĐIỆN */}
      <div style={{ background: 'var(--admin-overlay)', backdropFilter: 'blur(12px)', border: '1px solid var(--admin-border)', borderRadius: 0, overflow: 'hidden', boxShadow: 'var(--admin-shadow)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--admin-border-light)', background: 'var(--admin-hover)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '0.65rem', fontWeight: 800, color: 'var(--admin-text)', letterSpacing: '.5px' }}>
              ĐIỂM PHÓNG ĐIỆN
            </span>
            {pdDanger > 0 && (
              <span style={{ fontSize: '0.58rem', fontWeight: 800, color: 'var(--admin-danger)', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 0, padding: '1px 5px' }}>
                {pdDanger} NGUY HIỂM
              </span>
            )}
          </div>
          <button onClick={() => setIsPdCollapsed(!isPdCollapsed)} style={{ background: 'none', border: 'none', color: 'var(--admin-text-muted)', cursor: 'pointer', fontSize: '0.9rem', padding: '0 2px' }}>
            {isPdCollapsed ? '▼' : '▲'}
          </button>
        </div>

        {!isPdCollapsed && (
          <div style={{ padding: '4px 0' }}>
            {pdRows.length === 0 ? (
              <div style={{ padding: '16px 10px', fontSize: '0.68rem', color: 'var(--admin-text-muted)', textAlign: 'center' }}>Chưa phát hiện phóng điện</div>
            ) : (
              pdRows.map((row, idx) => {
                const val = row.sensor?.value;
                const color = val !== undefined ? getStatusColor(val, row.warn, row.alarm, true) : 'var(--admin-border)';
                const unit = row.sensor?.unit || 'dB';
                return (
                  <div key={row.pid} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: idx < pdRows.length - 1 ? '1px solid var(--admin-border-light)' : 'none' }}>
                    <div style={{ width: 6, height: 6, borderRadius: 0, background: color, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: '0.68rem', color: 'var(--admin-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.label}</span>
                    <span style={{ fontSize: '0.75rem', fontWeight: 800, color: val !== undefined && val <= -60 ? 'var(--admin-text-muted)' : color, fontFamily: 'Consolas,monospace', flexShrink: 0 }}>{val === undefined ? '--' : val <= -60 ? '----' : `${val.toFixed(1)} ${unit}`}</span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
