import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { stationApi } from '@/services/StationApiService';
import type { Rule } from '@/types/api.types';

const SC = { good: '#10B981', warning: '#F59E0B', danger: '#EF4444' } as const;

/**
 * Trả về màu hiển thị cho mức phóng điện PD (đỏ > 50dB, vàng > 20dB, xanh bình thường).
 * Trả về xám khi thiết bị offline.
 */
const getPdColor = (pd: number, isOffline: boolean) => {
  if (isOffline) return '#9CA3AF';
  if (pd < 0) {
    if (pd > -20) return '#EF4444';
    if (pd > -27) return '#F59E0B';
    return '#10B981';
  }
  if (pd > 50) return '#EF4444';
  if (pd > 20) return '#F59E0B';
  return '#10B981';
};

interface KpiCardsProps {
  plcOnline: boolean;
  devices: any[];
  sensors: any[];
  rules?: Rule[];
}

/**
 * Widget giám sát tủ điện trên Dashboard: hiển thị nhiệt độ 3 pha và
 * mức phóng điện PD cho từng tủ, kèm điểm sức khỏe tổng hợp từ backend.
 */
export default function KpiCards({ plcOnline, devices = [], sensors = [], rules = [] }: KpiCardsProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [healthScores, setHealthScores] = useState<Record<string, { score: number; risk: string }>>({});
  const navigate = useNavigate();

  const normalize = (id?: string) => (id || '').trim().toLowerCase();
  const evaluate = (v: number, op: string, t: number) => {
    if (op === '>') return v > t;
    if (op === '>=') return v >= t;
    if (op === '<') return v < t;
    if (op === '<=') return v <= t;
    if (op === '==') return Math.abs(v - t) < 0.001;
    return false;
  };
  const getThresholdLevel = (deviceId: string, pointId: string, value: number): 'alarm' | 'warning' | undefined => {
    const pid = normalize(pointId);
    const suffix = pid.includes('_') ? pid.split('_').pop() || pid : pid;
    const matches: Array<{ op: string; warn: number | null; alarm: number | null }> = [];
    for (const rule of rules) {
      if (!rule.enabled || !rule.deviceId || rule.deviceId.toLowerCase() !== deviceId.toLowerCase()) continue;
      let cond: any;
      try { cond = JSON.parse(rule.condition); } catch { continue; }
      const rulePoint = normalize(cond.point);
      if (!rulePoint) continue;
      if (rulePoint !== pid && rulePoint !== suffix) continue;

      matches.push({
        op: cond.op ?? '>',
        alarm: cond.alarm != null ? Number(cond.alarm) : null,
        warn: cond.pre_alarm != null ? Number(cond.pre_alarm) : null,
      });
    }
    if (matches.length === 0) return undefined;
    const ops = new Set(matches.map(m => m.op));
    const isLowerBetter = ops.has('<') || ops.has('<=');
    const pick = (values: Array<number | null>) => {
      const nums = values.filter((n): n is number => n != null && !Number.isNaN(n));
      if (nums.length === 0) return null;
      return isLowerBetter ? Math.min(...nums) : Math.max(...nums);
    };
    const alarm = pick(matches.map(m => m.alarm));
    const warn = pick(matches.map(m => m.warn));
    const op = isLowerBetter ? '<=' : '>';
    if (alarm != null && evaluate(value, op, alarm)) return 'alarm';
    if (warn != null && evaluate(value, op, warn)) return 'warning';
    return undefined;
  };
  const getSensorColor = (deviceId: string, pointId: string, value: number | null | undefined, fallback: string) => {
    if (value === null || value === undefined) return '#9CA3AF';
    const level = getThresholdLevel(deviceId, pointId, value);
    if (level === 'alarm') return '#EF4444';
    if (level === 'warning') return '#F59E0B';
    return fallback;
  };

  // Chỉ lấy các thiết bị loại PLC Siemens hoặc Tủ điện (cabinet)
  const cabinetDevices = useMemo(() => {
    return devices.filter(d => d.type === 'plc_s7' || d.type === 'cabinet');
  }, [devices]);

  // Nạp điểm sức khỏe thực tế từ C# Backend API
  useEffect(() => {
    stationApi.getHealthScores()
      .then(scores => {
        // Chuẩn hóa key sang chữ thường để tránh lỗi so sánh ID
        const map: Record<string, { score: number; risk: string }> = {};
        scores.forEach(s => {
          map[s.deviceId.toLowerCase()] = {
            score: s.score,
            risk: s.risk || (s.score >= 80 ? 'good' : s.score >= 50 ? 'warning' : 'danger')
          };
        });
        setHealthScores(map);
      })
      .catch(err => console.warn('[KPI] Lỗi nạp điểm sức khỏe:', err));
  }, [devices]);

  /** Tổng hợp thông tin hiển thị cho từng tủ điện: nhiệt độ 3 pha, PD và trạng thái sức khỏe. */
  const cabinetList = useMemo(() => {
    const list: any[] = [];
    cabinetDevices.forEach(cab => {
      const hInfo = healthScores[cab.id.toLowerCase()] || { score: 100, risk: 'good' };
      
      const t1Sensor = sensors.find(s => s.deviceId === cab.id && (s.pointId === 'nhiet_do_pha_1' || s.pointId === 'temp_1'));
      const t2Sensor = sensors.find(s => s.deviceId === cab.id && (s.pointId === 'nhiet_do_pha_2' || s.pointId === 'temp_2'));
      const t3Sensor = sensors.find(s => s.deviceId === cab.id && (s.pointId === 'nhiet_do_pha_3' || s.pointId === 'temp_3'));
      const pdSensor = sensors.find(s => s.deviceId === cab.id && (s.pointId === 'phong_dien' || s.pointId === 'pd'));

      const t1 = !t1Sensor || t1Sensor.quality === 2 ? null : Math.round(t1Sensor.value * 10) / 10;
      const t2 = !t2Sensor || t2Sensor.quality === 2 ? null : Math.round(t2Sensor.value * 10) / 10;
      const t3 = !t3Sensor || t3Sensor.quality === 2 ? null : Math.round(t3Sensor.value * 10) / 10;

      const pdVal = !pdSensor || pdSensor.quality === 2 ? null : pdSensor.value;

      const healthStatus = hInfo.risk as 'good' | 'warning' | 'danger';
      
      const pdLevel = pdVal === null ? 'low'
        : pdVal < 0 ? (pdVal > -20 ? 'high' : pdVal > -27 ? 'medium' : 'low')
        : (pdVal > 50 ? 'high' : pdVal > 20 ? 'medium' : 'low');

      list.push({
        id: cab.id,
        name: cab.name || 'Tủ điện',
        status: cab.status || 'unknown',
        t1,
        t2,
        t3,
        pdCount: pdVal === null ? null : Math.round(pdVal),
        pdLevel,
        healthScore: hInfo.score,
        healthStatus
      });
    });
    return list;
  }, [cabinetDevices, healthScores, sensors]);

  const dangerCount  = cabinetList.filter(c => c.healthStatus === 'danger').length;
  const warningCount = cabinetList.filter(c => c.healthStatus === 'warning').length;

  return (
    <div
      id="floatKpi"
      style={{
        width: '100%',
        background: 'var(--admin-overlay)', backdropFilter: 'blur(12px)',
        border: `1px solid ${dangerCount > 0 ? 'rgba(239,68,68,0.4)' : 'var(--admin-border)'}`,
        borderRadius: 0, overflow: 'hidden', boxShadow: 'var(--admin-shadow)'
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--admin-border-light)', background: 'var(--admin-hover)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.65rem', fontWeight: 800, color: 'var(--admin-text)', letterSpacing: '.5px' }}>
            GIÁM SÁT TỦ ĐIỆN
          </span>
          {dangerCount > 0 && (
            <span style={{ fontSize: '0.55rem', fontWeight: 800, color: '#EF4444', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 0, padding: '1px 5px' }}>
              {dangerCount} NGUY HIỂM
            </span>
          )}
          {warningCount > 0 && !dangerCount && (
            <span style={{ fontSize: '0.55rem', fontWeight: 800, color: '#F59E0B', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 0, padding: '1px 5px' }}>
              {warningCount} CẢNH BÁO
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.58rem', fontWeight: 700, color: plcOnline ? '#10B981' : '#EF4444', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 5, height: 5, borderRadius: 0, background: plcOnline ? '#10B981' : '#EF4444', display: 'inline-block' }} />
            PLC
          </span>
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            style={{ background: 'none', border: 'none', color: 'var(--admin-text-muted)', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1, padding: '0 2px' }}
          >
            {isCollapsed ? '▼' : '▲'}
          </button>
        </div>
      </div>

      {/* Cabinet list */}
      {!isCollapsed && (
        <div style={{ padding: '4px 0' }}>
          {cabinetList.length === 0 ? (
            <div style={{ padding: '16px 10px', fontSize: '0.68rem', color: 'var(--admin-text-muted)', textAlign: 'center' }}>
              Chưa có tủ điện nào được cấu hình
            </div>
          ) : (
            cabinetList.map((cab, idx) => {
              const isOffline = cab.status === 'offline';
              const color = isOffline ? '#9CA3AF' : SC[cab.healthStatus as keyof typeof SC];
              const statusLabel = isOffline ? 'OFFLINE' : (cab.healthStatus === 'danger' ? 'NGUY HIỂM' : cab.healthStatus === 'warning' ? 'CẢNH BÁO' : 'BÌNH THƯỜNG');

              return (
                <div
                  key={cab.id}
                  onClick={() => navigate(`/analytics?cabinet=${cab.id}`)}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 2,
                    padding: '5px 8px', cursor: 'pointer',
                    borderBottom: idx < cabinetList.length - 1 ? '1px solid var(--admin-border-light)' : 'none',
                    borderLeft: `3px solid ${color}`,
                    transition: 'background .1s',
                    opacity: isOffline ? 0.65 : 1
                  }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--admin-hover)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                >
                  {/* Row 1: Name and status badge */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                    {/* Square Dot */}
                    <div style={{ width: 6, height: 6, borderRadius: 0, background: color, flexShrink: 0 }} />

                    {/* Name */}
                    <span style={{ flex: 1, fontSize: '0.72rem', fontWeight: 700, color: isOffline ? '#9CA3AF' : 'var(--admin-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {cab.name}
                    </span>

                    {/* Status badge */}
                    <span style={{ fontSize: '0.52rem', fontWeight: 800, color: isOffline ? '#EF4444' : color, background: isOffline ? 'rgba(239,68,68,0.08)' : `${color}18`, border: `1px solid ${isOffline ? 'rgba(239,68,68,0.25)' : `${color}40`}`, borderRadius: 0, padding: '1px 4px', flexShrink: 0 }}>
                      {statusLabel}
                    </span>
                  </div>

                  {/* Row 2: Grid of Pha A, B, C, PD */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1.2fr', gap: 2, marginTop: 1, width: '100%' }}>
                    <div style={{ background: 'rgba(255,255,255,0.04)', padding: '2px 4px', borderRadius: 0, textAlign: 'center' }}>
                      <div style={{ fontSize: '0.42rem', color: 'var(--admin-text-muted)', fontWeight: 600 }}>PHA A</div>
                      <div style={{ fontSize: '0.62rem', fontWeight: 800, color: getSensorColor(cab.id, 'nhiet_do_pha_1', cab.t1, 'var(--admin-success)'), fontFamily: 'Consolas,monospace' }}>
                        {isOffline || cab.t1 === null ? '---' : `${cab.t1}°C`}
                      </div>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.04)', padding: '2px 4px', borderRadius: 0, textAlign: 'center' }}>
                      <div style={{ fontSize: '0.42rem', color: 'var(--admin-text-muted)', fontWeight: 600 }}>PHA B</div>
                      <div style={{ fontSize: '0.62rem', fontWeight: 800, color: getSensorColor(cab.id, 'nhiet_do_pha_2', cab.t2, 'var(--admin-success)'), fontFamily: 'Consolas,monospace' }}>
                        {isOffline || cab.t2 === null ? '---' : `${cab.t2}°C`}
                      </div>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.04)', padding: '2px 4px', borderRadius: 0, textAlign: 'center' }}>
                      <div style={{ fontSize: '0.42rem', color: 'var(--admin-text-muted)', fontWeight: 600 }}>PHA C</div>
                      <div style={{ fontSize: '0.62rem', fontWeight: 800, color: getSensorColor(cab.id, 'nhiet_do_pha_3', cab.t3, 'var(--admin-success)'), fontFamily: 'Consolas,monospace' }}>
                        {isOffline || cab.t3 === null ? '---' : `${cab.t3}°C`}
                      </div>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.04)', padding: '2px 4px', borderRadius: 0, textAlign: 'center' }}>
                      <div style={{ fontSize: '0.42rem', color: 'var(--admin-text-muted)', fontWeight: 600 }}>P.ĐIỆN</div>
                      <div style={{ fontSize: '0.6rem', fontWeight: 800, color: getPdColor(cab.pdCount, isOffline), fontFamily: 'Consolas,monospace' }}>
                        {isOffline || cab.pdCount === null ? '---' : cab.pdCount <= -60 ? '----' : `${cab.pdCount}dB`}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Footer */}
      {!isCollapsed && (
        <div
          onClick={() => navigate('/analytics')}
          style={{ padding: '6px 10px', borderTop: '1px solid var(--admin-border-light)', background: 'var(--admin-hover)', textAlign: 'center', cursor: 'pointer' }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = '0.7'}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = '1'}
        >
          <span style={{ fontSize: '0.62rem', fontWeight: 800, color: 'var(--admin-accent)' }}>
            XEM PHÂN TÍCH CHI TIẾT →
          </span>
        </div>
      )}
    </div>
  );
}
