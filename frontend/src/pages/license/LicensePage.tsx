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

  const canManageLicense = authService.hasPermission('license:manage');

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
      setSuccessMsg(data?.message || 'Kích hoạt thành công! Đang tải lại...');
      setKey('');
      await loadStatus();
      setTimeout(() => navigate('/dashboard'), 1500);
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

    const isActivated = status.activated;
    const tierLabel = isActivated ? (status.tier === 'solo' ? 'Solo' : status.tier === 'team' ? 'Team' : status.tier === 'enterprise' ? 'Enterprise' : status.tier) : 'Dùng thử (Trial)';
    const expDate = isActivated && status.expiresAt ? new Date(status.expiresAt).toLocaleDateString('vi-VN') : '—';
    const actDate = isActivated && status.activatedAt ? new Date(status.activatedAt).toLocaleDateString('vi-VN') : '—';
    const statusCls = !isActivated ? 'demo' : status.isValid ? 'valid' : 'expired';
    const statusTxt = !isActivated ? 'Chưa kích hoạt' : status.isValid ? 'Đang hoạt động' : 'Đã hết hạn';

    const maxUsers = isActivated ? (status.maxUsers && status.maxUsers >= 999 ? 'Không giới hạn' : status.maxUsers) : '1';
    const activeSessions = isActivated ? (status.activeSessions ?? 0) : 1;
    const maxUsersLimit = isActivated ? (status.maxUsers && status.maxUsers >= 999 ? '∞' : status.maxUsers) : 1;

    const maxNonCams = isActivated ? (status.maxDevices && status.maxDevices >= 999 ? 'Không giới hạn' : (status.maxDevices ?? '—')) : '5';
    const maxCams = isActivated ? (status.maxCameras && status.maxCameras >= 999 ? 'Không giới hạn' : (status.maxCameras ?? '—')) : '5';
    const maxRoiPoints = isActivated ? (status.maxRoiPoints && status.maxRoiPoints >= 999 ? 'Không giới hạn' : (status.maxRoiPoints ?? '—')) : '5';
    const maxRoiRegions = isActivated ? (status.maxRoiRegions && status.maxRoiRegions >= 999 ? 'Không giới hạn' : (status.maxRoiRegions ?? '—')) : '5';
    const maxPdRegions = isActivated ? (status.maxPdRegions && status.maxPdRegions >= 999 ? 'Không giới hạn' : (status.maxPdRegions ?? '—')) : '5';

    return (
      <div className={`status-container ${statusCls}`}>
        <div className="info-section" style={{ marginBottom: 0 }}>
          <div className="status-row">
            <span>Trạng thái</span>
            <span className={`status-badge ${statusCls}`}>{statusTxt}</span>
          </div>
          <div className="status-row">
            <span>Gói sản phẩm</span>
            <span>
              <span className={`tier-pill ${isActivated && status.tier ? getTierClass(status.tier) : 'demo'}`}>
                {tierLabel}
              </span>
            </span>
          </div>
          <div className="status-row">
            <span>Người dùng & Phiên</span>
            <span>{activeSessions} / {maxUsersLimit} người dùng</span>
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

          {isActivated && (
            <>
              <div className="status-row">
                <span>Ngày kích hoạt</span>
                <span>{actDate}</span>
              </div>
              <div className="status-row">
                <span>Ngày hết hạn</span>
                <span>{expDate} {status.daysRemaining !== undefined && `(còn ${status.daysRemaining} ngày)`}</span>
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="license-page">
      <div className="license-hero">
        <div className="license-card">
          <div className="license-grid-layout">
            
            {/* Left Column: Current Status & System Limits */}
            <div className="license-left-col">
              <h2 className="col-title">Trạng thái bản quyền</h2>
              {renderStatusBox()}
            </div>

            {/* Right Column: Activation Form & Action Steps */}
            <div className="license-right-col">
              <div className="license-header">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#44ff88" strokeWidth="1.5">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <h1>Giftcode Bản quyền</h1>
                <p>Kích hoạt để mở rộng giới hạn hệ thống</p>
              </div>

              {canManageLicense && (
                <div className="license-activate-section" id="activateSection">
                  <h3>Nhập Giftcode kích hoạt</h3>
                  <p className="license-hint">
                    Định dạng: <code>SOLO-YYMMDD-XXXX-XXXXXXXX</code>
                  </p>

                  {errorMsg && <div className="license-error">⚠️ {errorMsg}</div>}
                  {successMsg && <div className="license-success">✅ {successMsg}</div>}

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
                      {loading ? 'Đang gửi...' : 'Kích hoạt'}
                    </button>
                  </form>
                </div>
              )}

              <div className="license-contact-info">
                ℹ️ <strong>Hỗ trợ & Cấp Giftcode:</strong> Nếu có nhu cầu mở rộng/thêm thiết bị, camera hoặc tăng số điểm nhiệt, vui lòng liên hệ trực tiếp với <strong>Nhà phát triển (Lập trình viên)</strong> để được hỗ trợ và cấp mã kích hoạt mới.
              </div>

              <div className="license-actions">
                <button className="btn-license-skip" onClick={() => navigate('/dashboard')}>
                  Quay lại Dashboard
                </button>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
