import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authService } from '@/services/AuthService';
import { stationApi } from '@/services/StationApiService';
import './LicensePage.css';

interface LicenseStatus {
  activated: boolean;
  tier?: string;
  maxUsers?: number;
  maxDevices?: number;
  maxCameras?: number;
  maxRoiPoints?: number;
  maxRoiRegions?: number;
  maxPdRegions?: number;
  expiresAt?: string;
  activatedAt?: string;
  activeSessions?: number;
  isValid?: boolean;
  daysRemaining?: number;
}

export default function LicensePage() {
  const navigate = useNavigate();
  
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const isAdmin = authService.getUser()?.role === 'admin';

  const loadStatus = async () => {
    try {
      const data = await stationApi.getLicenseStatus();
      setStatus(data);
    } catch {
      setStatus({ activated: false });
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) {
      setErrorMsg('Vui lòng nhập license key');
      return;
    }

    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const data = await stationApi.activateLicense(key.trim());
      if (data?.message && !data?.activated) {
        setErrorMsg(data.message ?? 'Kích hoạt thất bại');
      } else {
        setSuccessMsg('Kích hoạt thành công! Đang tải lại...');
        setKey('');
        await loadStatus();
        setTimeout(() => navigate('/dashboard'), 1500);
      }
    } catch (err: any) {
      setErrorMsg(err?.message ?? 'Không thể kết nối backend');
    } finally {
      setLoading(false);
    }
  };

  const getTierClass = (tier: string) => {
    if (tier === 'solo') return 'solo';
    if (tier === 'team') return 'team';
    return 'ent';
  };

  const renderStatusBox = () => {
    if (!status) {
      return <div style={{ color: 'var(--admin-text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>Đang tải trạng thái...</div>;
    }

    if (!status.activated) {
      return (
        <div className="status-box">
          <div className="status-row">
            <span>Trạng thái</span>
            <span className="status-badge demo">Chưa kích hoạt (Dùng thử)</span>
          </div>
          <div className="status-row">
            <span>Số người dùng tối đa</span>
            <span>1 người dùng</span>
          </div>
          <div className="status-row">
            <span>Số thiết bị tối đa</span>
            <span>5 thiết bị</span>
          </div>
          <div className="status-row">
            <span>Số camera tối đa</span>
            <span>5 camera</span>
          </div>
          <div className="status-row">
            <span>Số điểm nhiệt tối đa</span>
            <span>10 điểm</span>
          </div>
        </div>
      );
    }

    const tierLabel = status.tier === 'solo' ? 'Solo' : status.tier === 'team' ? 'Team' : status.tier === 'enterprise' ? 'Enterprise' : status.tier;
    const expDate = status.expiresAt ? new Date(status.expiresAt).toLocaleDateString('vi-VN') : '—';
    const actDate = status.activatedAt ? new Date(status.activatedAt).toLocaleDateString('vi-VN') : '—';
    const statusCls = status.isValid ? 'valid' : 'expired';
    const statusTxt = status.isValid ? 'Đang hoạt động' : 'Đã hết hạn';

    const maxNonCams = status.maxDevices && status.maxDevices >= 999 ? 'Không giới hạn' : (status.maxDevices ?? '—');
    const maxCams = status.maxCameras && status.maxCameras >= 999 ? 'Không giới hạn' : (status.maxCameras ?? '—');
    const maxRoiPoints = status.maxRoiPoints && status.maxRoiPoints >= 999 ? 'Không giới hạn' : (status.maxRoiPoints ?? '—');
    const maxRoiRegions = status.maxRoiRegions && status.maxRoiRegions >= 999 ? 'Không giới hạn' : (status.maxRoiRegions ?? '—');
    const maxPdRegions = status.maxPdRegions && status.maxPdRegions >= 999 ? 'Không giới hạn' : (status.maxPdRegions ?? '—');

    return (
      <div className={`status-box ${statusCls}`}>
        <div className="status-row">
          <span>Trạng thái</span>
          <span className={`status-badge ${statusCls}`}>{statusTxt}</span>
        </div>
        <div className="status-row">
          <span>Gói</span>
          <span>
            <span className={`tier-pill ${status.tier ? getTierClass(status.tier) : ''}`}>
              {tierLabel}
            </span>
          </span>
        </div>
        <div className="status-row">
          <span>Số người dùng tối đa</span>
          <span>{status.maxUsers && status.maxUsers >= 999 ? 'Không giới hạn' : status.maxUsers}</span>
        </div>
        <div className="status-row">
          <span>Phiên đang hoạt động</span>
          <span>{status.activeSessions ?? 0} / {status.maxUsers && status.maxUsers >= 999 ? '∞' : status.maxUsers}</span>
        </div>
        <div className="status-row">
          <span>Số thiết bị tối đa</span>
          <span>{maxNonCams}</span>
        </div>
        <div className="status-row">
          <span>Số camera tối đa</span>
          <span>{maxCams}</span>
        </div>
        <div className="status-row">
          <span>Số điểm nhiệt tối đa</span>
          <span>{maxRoiPoints}</span>
        </div>
        <div className="status-row">
          <span>Số vùng nhiệt tối đa</span>
          <span>{maxRoiRegions}</span>
        </div>
        <div className="status-row">
          <span>Số vùng phóng điện tối đa</span>
          <span>{maxPdRegions}</span>
        </div>
        <div className="status-row">
          <span>Ngày hết hạn</span>
          <span>{expDate} (còn {status.daysRemaining ?? 0} ngày)</span>
        </div>
        <div className="status-row">
          <span>Ngày kích hoạt</span>
          <span>{actDate}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="license-page">
      <div className="license-hero">
        <div className="license-card">
          <div className="license-header">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#44ff88" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <h1>Quản lý License</h1>
            <p>Kích hoạt bản quyền phần mềm StationMonitor</p>
          </div>

          {renderStatusBox()}

          <div className="license-contact-info" style={{ 
            marginTop: 15, 
            padding: '12px 16px', 
            borderRadius: 8, 
            background: 'rgba(255, 255, 255, 0.03)', 
            border: '1px dashed rgba(255, 255, 255, 0.1)',
            fontSize: '13px',
            color: '#aaa',
            textAlign: 'center',
            lineHeight: '1.5'
          }}>
            ℹ️ <strong>Hỗ trợ & Cấp License:</strong> Nếu có nhu cầu mở rộng/thêm thiết bị, camera hoặc tăng số điểm nhiệt, vui lòng liên hệ trực tiếp với <strong>Nhà phát triển (Lập trình viên)</strong> để được hỗ trợ và cấp mã kích hoạt mới.
          </div>

          {isAdmin && (
            <div className="license-activate-section" id="activateSection">
              <h3>Kích hoạt License Key</h3>
              <p className="license-hint">
                Nhập license key do nhà cung cấp cấp. Định dạng: <code>SOLO-YYMMDD-XXXX-XXXXXXXX</code>
              </p>

              {errorMsg && <div className="license-error">️ {errorMsg}</div>}
              {successMsg && <div className="license-success">{successMsg}</div>}

              <form onSubmit={handleActivate} className="license-input-row">
                <input 
                  type="text" 
                  className="license-input"
                  placeholder="VD: SOLO-270101-A3F7-1B2C3D4E"
                  spellCheck="false" 
                  autoComplete="off"
                  value={key}
                  onChange={e => setKey(e.target.value)}
                  disabled={loading}
                />
                <button type="submit" className="btn-license-activate" disabled={loading}>
                  {loading ? 'Đang kích hoạt...' : 'Kích hoạt'}
                </button>
              </form>

              {/* Removed license-tiers grid for a cleaner interface */}
            </div>
          )}

          <div className="license-actions">
            <button className="btn-license-skip" onClick={() => navigate('/dashboard')}>
              Quay lại Dashboard
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
