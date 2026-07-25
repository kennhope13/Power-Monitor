import { useState, useEffect } from 'react';
import { stationApi } from '@/services/StationApiService';
import { showToast } from '@/utils/toast';
import { API_BASE_URL } from '@/utils/env';
import { authService } from '@/services/AuthService';

const RETENTION_OPTIONS = [
  { value: '30', label: '30 ngày', desc: 'Tiết kiệm ổ đĩa, phù hợp trạm ít sự cố' },
  { value: '60', label: '60 ngày', desc: 'Cân bằng giữa lưu trữ và dung lượng' },
  { value: '90', label: '90 ngày', desc: 'Lưu trữ lâu hơn, cần nhiều dung lượng hơn' },
  { value: '-1', label: 'Mãi mãi', desc: 'Lưu trữ vĩnh viễn, không tự động xóa dữ liệu' },
];

interface StorageInfo {
  drive: string;
  totalGb: number;
  freeGb: number;
  freePercent: number;
  checkedAt: string;
}

export default function VideoStorageTab() {
  const [retentionDays, setRetentionDays] = useState('30');
  const [autoDeleteOldest, setAutoDeleteOldest] = useState(true);
  const [storageInfo, setStorageInfo] = useState<StorageInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<{ deletedFiles: number; deletedReadings?: number; freedMb: number } | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const data = await stationApi.getSettings();
      setRetentionDays(data['video_retention_days'] ?? '30');
      setAutoDeleteOldest(data['video_auto_delete_oldest'] !== 'false');

      // Lấy storage info từ key đã được StorageMonitorWorker ghi
      const raw = data['storage_monitor'];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          setStorageInfo(Array.isArray(parsed) ? parsed : [parsed]);
        } catch {}
      }
    } catch {
      showToast('Không thể tải cấu hình lưu trữ', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await Promise.all([
        stationApi.updateSetting('video_retention_days', retentionDays),
        stationApi.updateSetting('video_auto_delete_oldest', String(autoDeleteOldest)),
      ]);
      showToast(`Đã lưu: giữ video ${retentionDays} ngày, tự động xóa file cũ nhất khi đầy`, 'success');
    } catch {
      showToast('Không thể lưu cấu hình', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleCleanup = async () => {
    setCleaning(true);
    setCleanResult(null);
    try {
      const token = authService.getToken();
      const base = API_BASE_URL.replace('/api/v1', '');
      const res = await fetch(`${base}/api/v1/storage/cleanup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setCleanResult({ 
        deletedFiles: data.deletedFiles ?? 0, 
        deletedReadings: data.deletedReadings ?? 0, 
        freedMb: data.freedMb ?? 0 
      });
      showToast(`Đã xóa ${data.deletedFiles} file và ${data.deletedReadings ?? 0} bản ghi đo lường, giải phóng ${data.freedMb?.toFixed(1)} MB`, 'success');
      await loadSettings(); // Refresh storage info
    } catch (e: any) {
      showToast(`Lỗi dọn dẹp: ${e.message || e}`, 'error');
    } finally {
      setCleaning(false);
    }
  };

  const usedPercent = storageInfo[0] ? 100 - storageInfo[0].freePercent : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Tiêu đề */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800, color: 'var(--admin-text)' }}>CẤU HÌNH LƯU TRỮ VIDEO</h2>
          <div style={{ fontSize: '0.75rem', color: 'var(--admin-text-muted)', marginTop: 2 }}>
            Quản lý thời gian giữ bằng chứng camera và chính sách xóa tự động
          </div>
        </div>
        {loading && <span style={{ fontSize: '0.7rem', color: 'var(--admin-accent)', fontWeight: 700 }}>ĐANG TẢI...</span>}
      </div>

      {/* Thông tin ổ đĩa */}
      {storageInfo.length > 0 && (
        <div style={{ background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', padding: 16 }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--admin-accent)', textTransform: 'uppercase', letterSpacing: '0.6px', borderBottom: '1px solid var(--admin-border-light)', paddingBottom: 8, marginBottom: 12 }}>
            TRẠNG THÁI Ổ ĐĨA
          </div>
          {storageInfo.map((s, i) => (
            <div key={i} style={{ marginBottom: i < storageInfo.length - 1 ? 12 : 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: '0.75rem', fontWeight: 700 }}>
                <span style={{ color: 'var(--admin-text)' }}>{s.drive}</span>
                <span style={{ color: usedPercent && usedPercent > 90 ? 'var(--admin-danger)' : usedPercent && usedPercent > 75 ? 'var(--admin-warning)' : 'var(--admin-success)' }}>
                  {s.freeGb.toFixed(1)} GB trống / {s.totalGb.toFixed(1)} GB
                </span>
              </div>
              <div style={{ height: 8, background: 'var(--admin-layer-3)', borderRadius: 0, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${Math.min(100 - s.freePercent, 100)}%`,
                  background: s.freePercent < 5 ? 'var(--admin-danger)' : s.freePercent < 10 ? 'var(--admin-warning)' : 'var(--admin-accent)',
                  transition: 'width 0.4s ease',
                }} />
              </div>
              <div style={{ fontSize: '0.65rem', color: 'var(--admin-text-muted)', marginTop: 4 }}>
                Sử dụng {(100 - s.freePercent).toFixed(1)}% — Cập nhật: {new Date(s.checkedAt).toLocaleString('vi-VN')}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

        {/* Chọn thời gian lưu trữ */}
        <div style={{ background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--admin-accent)', textTransform: 'uppercase', letterSpacing: '0.6px', borderBottom: '1px solid var(--admin-border-light)', paddingBottom: 8 }}>
            THỜI GIAN GIỮ VIDEO BẰNG CHỨNG
          </div>

          {RETENTION_OPTIONS.map(opt => (
            <label
              key={opt.value}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                cursor: 'pointer',
                padding: '10px 12px',
                borderRadius: 0,
                border: `1px solid ${retentionDays === opt.value ? 'var(--admin-accent)' : 'var(--admin-border)'}`,
                background: retentionDays === opt.value ? 'color-mix(in srgb, var(--admin-accent) 10%, transparent)' : 'var(--admin-layer-1)',
                transition: 'all 0.15s',
              }}
            >
              <input
                type="radio"
                name="retention"
                value={opt.value}
                checked={retentionDays === opt.value}
                onChange={() => setRetentionDays(opt.value)}
                style={{ accentColor: 'var(--admin-accent)', marginTop: 2, cursor: 'pointer' }}
              />
              <div>
                <div style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--admin-text)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {opt.label}
                  {opt.value === '30' && (
                    <span style={{ fontSize: '0.6rem', border: '1px solid var(--admin-accent)', color: 'var(--admin-accent)', padding: '0 4px', fontWeight: 700 }}>
                      MẶC ĐỊNH
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--admin-text-muted)', marginTop: 2 }}>{opt.desc}</div>
              </div>
            </label>
          ))}

          <div className="hint-text" style={{ fontSize: '0.7rem', color: 'var(--admin-text-muted)', marginTop: 4 }}>
            Hệ thống tự động xóa ảnh bằng chứng và video clip khi đã quá số ngày lưu trữ cài đặt.
          </div>
        </div>

        {/* Chính sách xóa & Dọn dẹp thủ công */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Chính sách xóa */}
          <div style={{ background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--admin-accent)', textTransform: 'uppercase', letterSpacing: '0.6px', borderBottom: '1px solid var(--admin-border-light)', paddingBottom: 8 }}>
              CHÍNH SÁCH XÓA KHI ĐẦY ĐĨA
            </div>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoDeleteOldest}
                onChange={e => setAutoDeleteOldest(e.target.checked)}
                style={{ accentColor: 'var(--admin-accent)', marginTop: 2, cursor: 'pointer', width: 14, height: 14 }}
              />
              <div>
                <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--admin-text)' }}>
                  Ưu tiên xóa file cũ nhất (FIFO)
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--admin-text-muted)', marginTop: 3 }}>
                  Khi ổ đĩa đầy (còn &lt; 5% trống), tự động xóa file bằng chứng cũ nhất để nhường chỗ cho sự kiện mới. Kiểu ghi đè vòng tròn.
                </div>
              </div>
            </label>

            <div style={{ background: 'var(--admin-layer-2)', border: '1px solid var(--admin-border-light)', padding: '8px 12px', fontSize: '0.7rem', color: 'var(--admin-text-muted)' }}>
              <strong style={{ color: 'var(--admin-warning)' }}>Lưu ý:</strong> Dữ liệu đã xóa không thể phục hồi. Hệ thống giữ nguyên file đính kèm sự cố chưa xử lý.
            </div>
          </div>

          {/* Dọn dẹp thủ công */}
          <div style={{ background: 'var(--admin-card-bg)', border: '1px solid var(--admin-border)', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--admin-accent)', textTransform: 'uppercase', letterSpacing: '0.6px', borderBottom: '1px solid var(--admin-border-light)', paddingBottom: 8 }}>
              DỌN DẸP THỦ CÔNG
            </div>

            <div style={{ fontSize: '0.72rem', color: 'var(--admin-text-muted)' }}>
              {retentionDays === '-1' ? (
                <span>Hệ thống đang được cấu hình lưu trữ <strong style={{ color: 'var(--admin-text)' }}>Mãi mãi</strong>. Không thể dọn dẹp theo thời gian.</span>
              ) : (
                <span>Xóa ngay các file bằng chứng và dữ liệu đo lường đã quá <strong style={{ color: 'var(--admin-text)' }}>{retentionDays} ngày</strong> để giải phóng dung lượng.</span>
              )}
            </div>

            {cleanResult && (
              <div style={{ background: 'color-mix(in srgb, var(--admin-success) 12%, transparent)', border: '1px solid var(--admin-success)', padding: '8px 12px', fontSize: '0.72rem', color: 'var(--admin-success)', fontWeight: 700 }}>
                ✓ Đã dọn dẹp xong. Xóa thành công {cleanResult.deletedFiles} file và {cleanResult.deletedReadings ?? 0} bản ghi đo lường cũ.
              </div>
            )}

            <button
              className="btn-industrial btn-danger"
              style={{ fontSize: '0.72rem', fontWeight: 800, padding: '8px 16px', opacity: cleaning || retentionDays === '-1' ? 0.5 : 1 }}
              onClick={handleCleanup}
              disabled={cleaning || retentionDays === '-1'}
            >
              {cleaning ? 'ĐANG XÓA...' : retentionDays === '-1' ? 'KHÔNG KHẢ DỤNG' : `XÓA DỮ LIỆU CŨ HƠN ${retentionDays} NGÀY NGAY BÂY`}
            </button>
          </div>

        </div>
      </div>

      {/* Footer lưu */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', background: 'var(--admin-layer-1)', border: '1px solid var(--admin-border)', padding: '12px 16px' }}>
        <button
          className="btn-industrial btn-primary"
          style={{ padding: '8px 24px', fontSize: '0.72rem', fontWeight: 800, textTransform: 'uppercase' }}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'ĐANG LƯU...' : 'LƯU CẤU HÌNH'}
        </button>
      </div>
    </div>
  );
}
