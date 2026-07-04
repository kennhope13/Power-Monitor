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
  source?: string;
  state?: string;
  message?: string;
  addonCount?: number;
  baseLicenseId?: string;
  hardwareFingerprint?: string;
}

interface LicenseRequestInfo {
  fingerprint: string;
  machineName: string;
  platform: string;
  cpuId?: string;
  mainboardUuid?: string;
  diskSerial?: string;
  physicalMacs?: string[];
  licenseDirectory?: string;
  requestedAtUtc?: string;
}

export default function LicensePage() {
  const navigate = useNavigate();
  
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [key, setKey] = useState('');
  const [licenseFile, setLicenseFile] = useState<File | null>(null);
  const [requestInfo, setRequestInfo] = useState<LicenseRequestInfo | null>(null);
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

  const loadRequestInfo = async () => {
    try {
      const data = await stationApi.getLicenseRequest();
      setRequestInfo(data);
    } catch {
      setRequestInfo(null);
    }
  };

  const handleExportRequest = () => {
    if (!requestInfo) return;

    const payload = {
      fingerprint: requestInfo.fingerprint,
      machineName: requestInfo.machineName,
      platform: requestInfo.platform,
      cpuId: requestInfo.cpuId,
      mainboardUuid: requestInfo.mainboardUuid,
      diskSerial: requestInfo.diskSerial,
      physicalMacs: requestInfo.physicalMacs ?? [],
      requestedAtUtc: requestInfo.requestedAtUtc,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'license-request.licreq';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    loadStatus();
    loadRequestInfo();
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

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!licenseFile) {
      setErrorMsg('Vui lòng chọn file .lic');
      return;
    }

    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const data = await stationApi.importLicense(licenseFile);
      setSuccessMsg(data?.message || 'Import file license thành công!');
      setLicenseFile(null);
      await loadStatus();
    } catch (err: any) {
      setErrorMsg(err?.message ?? 'Không thể import file license');
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
    const activeSessions = isActivated ? (status.activeSessions ?? 0) : 1;
    const maxUsersLimit = isActivated ? (status.maxUsers && status.maxUsers >= 999 ? '∞' : status.maxUsers) : 1;

    return (
      <div className={`status-container ${statusCls}`}>
        <div className="status-topline">
          <span>License</span>
          <span className={`status-badge ${statusCls}`}>{statusTxt}</span>
        </div>

        <div className="status-rows">
          <div className="status-row">
            <span>Gói</span>
            <span>
              <span className={`tier-pill ${isActivated && status.tier ? getTierClass(status.tier) : 'demo'}`}>
                {tierLabel}
              </span>
            </span>
          </div>
          <div className="status-row">
            <span>Người dùng đồng thời</span>
            <span>{activeSessions} / {maxUsersLimit}</span>
          </div>
          <div className="status-row">
            <span>Ngày hết hạn</span>
            <span>{expDate}{status.daysRemaining !== undefined ? ` (còn ${status.daysRemaining} ngày)` : ''}</span>
          </div>
          <div className="status-row">
            <span>Ngày kích hoạt</span>
            <span>{actDate}</span>
          </div>
        </div>

      </div>
    );
  };

  return (
    <div className="license-page">
      <div className="license-hero">
        <div className="license-card">
          <button className="license-back" type="button" onClick={() => navigate('/dashboard')} aria-label="Quay lại Dashboard">
            ←
          </button>
          <div className="license-header">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#44ff88" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <h1>Quản lý License</h1>
            <p>Kích hoạt bản quyền phần mềm StationMonitor</p>
          </div>

          {(errorMsg || successMsg) && (
            <div className="license-message-stack">
              {errorMsg && <div className="license-error">⚠️ {errorMsg}</div>}
              {successMsg && <div className="license-success">✅ {successMsg}</div>}
            </div>
          )}

          <div className="license-stack">
            <section className="license-panel">
              <h2 className="panel-title">Trạng thái</h2>
              {renderStatusBox()}
            </section>

            <section className="license-panel">
              <h2 className="panel-title">Kích hoạt offline</h2>

              <div className="license-subsection">
                <div className="license-inline-actions">
                  <button type="button" className="btn-license-secondary" onClick={handleExportRequest} disabled={!requestInfo}>
                    Xuất file .licreq
                  </button>
                </div>
              </div>

              <div className="license-subsection">
                {canManageLicense ? (
                  <form onSubmit={handleImport} className="license-form-stack">
                    <div className="license-file-picker">
                      <input
                        id="licenseFileInput"
                        type="file"
                        className="license-file-input"
                        accept=".lic,application/json"
                        onChange={e => setLicenseFile(e.target.files?.[0] ?? null)}
                        disabled={loading}
                      />
                      <span className={`license-file-name ${licenseFile ? 'has-file' : ''}`}>
                        {licenseFile ? licenseFile.name : 'Chưa chọn file'}
                      </span>
                      <label htmlFor="licenseFileInput" className="btn-license-secondary license-file-label">
                        Chọn file .lic
                      </label>
                      <button type="submit" className="btn-license-activate license-import-btn" disabled={loading || !licenseFile}>
                        {loading ? 'Đang xử lý...' : 'Import'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="license-muted">Tài khoản hiện tại không có quyền nhập license.</div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
