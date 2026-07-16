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
  maxSensors?: number;
  currentStations?: number;
  currentCameras?: number;
  currentSensors?: number;
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
  const [importErrorDetail, setImportErrorDetail] = useState<{ message: string; state?: string; licenseId?: string; addonId?: string; tier?: string } | null>(null);
  const [copied, setCopied] = useState(false);

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

    const primaryMac = (requestInfo.physicalMacs?.[0] ?? '').replace(/[-:]/g, '').toUpperCase();
    const payload = {
      fingerprint: {
        cpuId: requestInfo.cpuId ?? '',
        mainboardUuid: requestInfo.mainboardUuid ?? '',
        osDiskSerial: requestInfo.diskSerial ?? '',
        machineName: requestInfo.machineName,
        platform: requestInfo.platform,
        macAddress: primaryMac,
      },
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
    setImportErrorDetail(null);

    try {
      const data = await stationApi.importLicense(licenseFile);
      setSuccessMsg(data?.message || 'Import file license thành công!');
      setLicenseFile(null);
      await loadStatus();
    } catch (err: any) {
      const rawMsg = err?.message ?? '';
      try {
        const parsed = JSON.parse(rawMsg);
        if (parsed && typeof parsed === 'object' && parsed.message) {
          setErrorMsg(parsed.message);
          setImportErrorDetail({
            message: parsed.message,
            state: parsed.state,
            licenseId: parsed.licenseId,
            addonId: parsed.addonId,
            tier: parsed.tier
          });
          return;
        }
      } catch {
        // Not JSON
      }
      setErrorMsg(rawMsg || 'Không thể import file license');
    } finally {
      setLoading(false);
    }
  };

  const getTierClass = (tier: string) => {
    if (tier === 'solo') return 'solo';
    if (tier === 'team') return 'team';
    return 'ent';
  };

  const formatLimit = (value?: number) => {
    if (value === undefined || value === null) return '—';
    if (value >= 99999 || value >= 999) return '∞';
    return value.toLocaleString('vi-VN');
  };

  const formatUsage = (current?: number, limit?: number) => {
    const used = current ?? 0;
    return `${used.toLocaleString('vi-VN')}/${formatLimit(limit)}`;
  };

  const renderStatusBox = () => {
    if (!status) {
      return <div style={{ color: 'var(--admin-text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>Đang tải trạng thái...</div>;
    }

    const isActivated = status.activated;
    const tierLabel = isActivated ? (status.tier === 'solo' ? 'Solo' : status.tier === 'team' ? 'Team' : status.tier === 'enterprise' ? 'Enterprise' : status.tier) : 'Dùng thử (Trial)';
    const expDate = isActivated && status.expiresAt ? new Date(status.expiresAt).toLocaleDateString('vi-VN') : '—';
    const actDate = isActivated && status.activatedAt ? new Date(status.activatedAt).toLocaleDateString('vi-VN') : '—';

    let statusCls = 'demo';
    let statusTxt = 'Chưa kích hoạt';
    if (isActivated) {
      if (status.isValid) {
        statusCls = 'valid';
        statusTxt = 'Đang hoạt động';
      } else {
        statusCls = 'expired';
        const state = status.state?.toLowerCase();
        if (state === 'hardware_mismatch') {
          statusTxt = 'Sai phần cứng';
        } else if (state === 'expired') {
          statusTxt = 'Đã hết hạn';
        } else if (state === 'addon_rejected') {
          statusTxt = 'Add-on bị từ chối';
        } else {
          statusTxt = 'Không hợp lệ';
        }
      }
    }

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
          {isActivated && (
            <>
              <div className="status-row status-row-section">
                <span>Quyền được cấp</span>
                <span>
                  {status.source === 'managed' 
                    ? 'Do Trạm tổng quản lý' 
                    : status.source === 'file' 
                      ? 'File license' 
                      : 'License key'}
                </span>
              </div>
              <div className="license-limit-grid">
                <div className="license-limit-item">
                  <span>Camera</span>
                  <strong>{formatUsage(status.currentCameras, status.maxCameras)}</strong>
                </div>
                <div className="license-limit-item">
                  <span>Sensor</span>
                  <strong>{formatUsage(status.currentSensors, status.maxSensors)}</strong>
                </div>
              </div>
              {status.baseLicenseId && (
                <div className="status-row">
                  <span>License ID</span>
                  <span className="license-id-text">{status.baseLicenseId}</span>
                </div>
              )}
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
              
              {importErrorDetail && (
                <div className="license-diagnostic-box" style={{ padding: '12px 16px', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.2)', borderRadius: '6px', marginTop: '10px' }}>
                  <div className="diagnostic-header" style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#f59e0b', fontWeight: 600, marginBottom: '4px' }}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <circle cx="12" cy="12" r="10"></circle>
                      <line x1="12" y1="8" x2="12" y2="12"></line>
                      <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg>
                    <span>Lỗi xác thực Bản quyền</span>
                  </div>
                  <p className="diagnostic-body" style={{ color: 'var(--admin-text)', fontSize: '13px', margin: 0, opacity: 0.9 }}>
                    File này không hợp lệ hoặc đã bị chỉnh sửa, vui lòng liên hệ nhà cung cấp.
                  </p>
                </div>
              )}
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
