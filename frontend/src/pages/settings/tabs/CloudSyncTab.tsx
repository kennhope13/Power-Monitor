import { useState, useEffect, useCallback } from 'react';
import { stationApi } from '@/services/StationApiService';
import { showToast } from '@/utils/toast';
import { 
  CheckCircle, AlertCircle, 
  ArrowUp, Info, Activity, Database, ShieldCheck, RefreshCw
} from 'lucide-react';

interface SyncStatus {
  isConfigured: boolean;
  pendingCount: number;
  sentCount: number;
  failedCount: number;
  supabaseUrl?: string | null;
  lastSyncAt?: string | null;
}

export default function CloudSyncTab() {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncActionStatus, setSyncActionStatus] = useState('');
  const [triggeringSync, setTriggeringSync] = useState(false);

  const loadSyncStatus = useCallback(async () => {
    try {
      const data = await stationApi.getSyncStatus();
      setSyncStatus(data);
    } catch {
      // Sync status optional — ignore if cloud not configured
    }
  }, []);

  useEffect(() => { loadSyncStatus(); }, [loadSyncStatus]);

  const handleTriggerSync = async () => {
    setTriggeringSync(true);
    setSyncActionStatus('⏳ Đang kích hoạt...');
    try {
      const res = await stationApi.triggerSync();
      setSyncActionStatus(res.message);
      showToast('Kích hoạt đồng bộ Cloud thành công', 'success');
      setTimeout(() => loadSyncStatus(), 2000);
    } catch (e: any) {
      setSyncActionStatus(e.message || String(e));
      showToast('Lỗi đồng bộ Cloud', 'error');
    } finally {
      setTriggeringSync(false);
      setTimeout(() => setSyncActionStatus(''), 5000);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="card-title" style={{ marginBottom: 0 }}>CLOUD SYNC — SUPABASE</div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
        {[
          { label: 'CHỜ ĐỒNG BỘ', value: syncStatus?.pendingCount, color: 'var(--admin-accent)', icon: <Activity size={18} /> },
          { label: 'ĐÃ ĐỒNG BỘ', value: syncStatus?.sentCount, color: 'var(--admin-success)', icon: <CheckCircle size={18} /> },
          { label: 'LỖI KẾT NỐI', value: syncStatus?.failedCount, color: 'var(--admin-danger)', icon: <AlertCircle size={18} /> },
        ].map(({ label, value, color, icon }) => (
          <div key={label} style={{ 
            background: 'var(--admin-hover)', 
            border: `1px solid ${value && value > 0 && label === 'LỖI KẾT NỐI' ? 'var(--admin-danger)' : 'var(--admin-border)'}`, 
            borderRadius: 0, padding: '16px 12px', textAlign: 'center',
            boxShadow: value && value > 0 && label === 'LỖI KẾT NỐI' ? 'inset 0 0 10px rgba(239,68,68,0.05)' : 'none'
          }}>
            <div style={{ color, display: 'flex', justifyContent: 'center', marginBottom: 8, opacity: 0.8 }}>{icon}</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color, fontFamily: 'var(--font-mono)' }}>{value ?? '—'}</div>
            <div style={{ fontSize: '0.62rem', color: 'var(--admin-text-muted)', marginTop: 4, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '1px' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Connection Details */}
      <div style={{ background: 'var(--admin-panel)', border: '1px solid var(--admin-border)', borderRadius: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--admin-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.72rem', fontWeight: 800, color: 'var(--admin-text)', textTransform: 'uppercase', letterSpacing: '.5px' }}>
            <Database size={13} strokeWidth={2.5} style={{ color: 'var(--admin-accent)' }} />
            Cấu hình Cloud
          </div>
          {syncStatus ? (
            syncStatus.isConfigured ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--admin-success)', fontSize: '0.68rem', fontWeight: 800 }}>
                <span style={{ width: 6, height: 6, borderRadius: 0, background: 'currentColor' }} />
                ĐÃ KẾT NỐI
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--admin-danger)', fontSize: '0.68rem', fontWeight: 800 }}>
                <span style={{ width: 6, height: 6, borderRadius: 0, background: 'currentColor' }} />
                CHƯA CẤU HÌNH
              </div>
            )
          ) : (
            <span style={{ fontSize: '0.68rem', color: 'var(--admin-text-muted)' }}>ĐANG KIỂM TRA...</span>
          )}
        </div>
        
        <div style={{ padding: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div>
              <div style={{ fontSize: '0.62rem', color: 'var(--admin-text-muted)', fontWeight: 800, marginBottom: 6, textTransform: 'uppercase' }}>ĐỊA CHỈ CLOUD (ENDPOINT)</div>
              <div style={{ fontSize: '0.82rem', color: 'var(--admin-text)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all', opacity: 0.9 }}>
                {syncStatus?.supabaseUrl ?? 'N/A'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '0.62rem', color: 'var(--admin-text-muted)', fontWeight: 800, marginBottom: 6, textTransform: 'uppercase' }}>LẦN ĐỒNG BỘ CUỐI</div>
              <div style={{ fontSize: '0.82rem', color: 'var(--admin-text)', fontWeight: 600 }}>
                {syncStatus?.lastSyncAt ? new Date(syncStatus.lastSyncAt).toLocaleString('vi-VN') : '—'}
              </div>
            </div>
          </div>
          
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--admin-border)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <Info size={14} style={{ marginTop: 2, color: 'var(--admin-accent)', flexShrink: 0 }} />
            <div style={{ fontSize: '0.72rem', color: 'var(--admin-text-muted)', lineHeight: 1.5 }}>
              Hệ thống tự động đồng bộ dữ liệu Cảnh báo (Alerts) và Lịch bảo trì (Maintenance Tasks) lên đám mây Supabase mỗi <b>5 phút</b> để phục vụ giám sát từ xa.
            </div>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button 
          className="btn-industrial btn-primary" 
          onClick={handleTriggerSync} 
          disabled={triggeringSync}
          style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 16px', borderRadius: 0, fontSize: '.7rem' }}
        >
          {triggeringSync ? <RefreshCw size={12} className="spin" /> : <ArrowUp size={12} />}
          {triggeringSync ? 'ĐANG ĐỒNG BỘ...' : 'ĐỒNG BỘ NGAY'}
        </button>
        {syncActionStatus && (
          <div style={{ 
            display: 'flex', alignItems: 'center', gap: 6, fontSize: '.75rem', 
            color: syncActionStatus.toLowerCase().includes('lỗi') ? 'var(--admin-danger)' : 'var(--admin-success)',
            marginLeft: 10, fontWeight: 700
          }}>
            <Activity size={12} /> {syncActionStatus}
          </div>
        )}
      </div>

      {/* Mobile App Info */}
      <div style={{ 
        marginTop: 10, padding: '16px', background: 'rgba(0,0,0,0.1)', 
        border: '1px solid var(--admin-border)', borderRadius: 0,
        display: 'flex', gap: 14
      }}>
        <div style={{ width: 36, height: 36, borderRadius: 0, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--admin-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <ShieldCheck size={18} style={{ color: 'var(--admin-accent)' }} />
        </div>
        <div>
          <div style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--admin-text)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.5px' }}>DÀNH CHO ỨNG DỤNG DI ĐỘNG (MOBILE)</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--admin-text-muted)', lineHeight: 1.6 }}>
            Sử dụng <b>Mã khách (Anon key)</b> dưới đây để ứng dụng Mobile có thể đọc dữ liệu trực tiếp từ đám mây mà không cần thiết lập VPN.
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: '0.62rem', fontWeight: 800, color: 'var(--admin-text-muted)' }}>MÃ KHÁCH (ANON KEY):</span>
              <code style={{ background: 'var(--admin-hover)', padding: '3px 10px', borderRadius: 0, color: 'var(--admin-text)', fontSize: '0.7rem', fontFamily: 'var(--font-mono)', border: '1px solid var(--admin-border)' }}>
                sb_publishable_live_4492...
              </code>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
