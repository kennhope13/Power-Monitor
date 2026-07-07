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

  const handleCopyDevMessage = () => {
    const fingerprint = requestInfo?.fingerprint || 'MÃ_FINGERPRINT_CỦA_TRẠM';
    const errorJson = importErrorDetail 
      ? JSON.stringify(importErrorDetail)
      : '{"message":"Không đọc được file license","state":"invalid","licenseId":null,"addonId":null,"tier":null}';

    const devMsg = `Hi team, khi import file license \`.lic\` ở trạm con (Power-Monitor), hệ thống báo lỗi:
\`${errorJson}\`

**Nguyên nhân:** 
Hàm \`DeserializeEnvelope\` trong file \`LicenseService.cs\` của hệ thống trạm con thực hiện phân tích cú pháp JSON sang class \`LicenseEnvelope\` bị thất bại (trả về \`null\`). Có thể file license đang được sinh ra dưới dạng chuỗi Key thông thường (Legacy Key) hoặc cấu trúc JSON đang bị lệch so với model của Backend.

Nhờ team kiểm tra lại cấu trúc xuất file \`.lic\` đảm bảo phải khớp chính xác với C# Records \`LicenseEnvelope\` dưới đây:

\`\`\`csharp
public sealed record LicenseEnvelope(
    LicensePayload Payload,
    LicenseSignatureBlock Signature);

public sealed record LicensePayload(
    int Version,
    string LicenseType,     // "base" hoặc "addon"
    string LicenseId,       // UUID
    string? AddonId,
    string Tier,            // "solo", "team", "ent"
    string? Customer,
    DateTime IssuedAt,
    DateTime ExpiresAt,
    LicenseHardwareBinding Hardware,
    LicenseLimits Limits);

public sealed record LicenseSignatureBlock(
    string Algorithm,       // "RSA-SHA256" hoặc "HMAC-SHA256"
    string Value,           // Chữ ký Base64 hoặc Hex
    string? KeyId = null);

public sealed record LicenseHardwareBinding(
    string? Fingerprint,
    string? CpuId,
    string? MainboardUuid,
    string? DiskSerial,
    string? MachineName,
    string? Platform,
    string? MachineGuid,
    IReadOnlyList<string>? PhysicalMacs);

public sealed record LicenseLimits(
    int MaxUsers,
    int MaxDevices,
    int MaxCameras,
    int MaxSensors,
    int MaxRoiPoints,
    int MaxRoiRegions,
    int MaxPdRegions);
\`\`\`

Hoặc team có thể xuất file dưới dạng JSON mẫu này:
\`\`\`json
{
  "Payload": {
    "Version": 1,
    "LicenseType": "base",
    "LicenseId": "nhập-uuid-vào-đây",
    "Tier": "solo",
    "Customer": "Tên Khách Hàng",
    "IssuedAt": "2026-07-06T00:00:00Z",
    "ExpiresAt": "2027-07-06T00:00:00Z",
    "Hardware": {
      "Fingerprint": "${fingerprint}",
      "CpuId": "...",
      "MainboardUuid": "...",
      "PhysicalMacs": []
    },
    "Limits": {
      "MaxUsers": 1,
      "MaxDevices": 10,
      "MaxCameras": 10,
      "MaxSensors": 10,
      "MaxRoiPoints": 30,
      "MaxRoiRegions": 10,
      "MaxPdRegions": 10
    }
  },
  "Signature": {
    "Algorithm": "RSA-SHA256",
    "Value": "Chữ_ký_bảo_mật"
  }
}
\`\`\`
Cảm ơn team!`;

    navigator.clipboard.writeText(devMsg).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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
                <span>{status.source === 'file' ? 'File license' : 'License key'}</span>
              </div>
              <div className="license-limit-grid">
                <div className="license-limit-item">
                  <span>Trạm</span>
                  <strong>{formatUsage(status.currentStations, status.maxDevices)}</strong>
                </div>
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
                <div className="license-diagnostic-box">
                  <div className="diagnostic-header">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--admin-warning, #f59e0b)" strokeWidth="2.5" className="diagnostic-icon">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <span>Lỗi Định Dạng File Bản Quyền (.lic)</span>
                  </div>
                  <p className="diagnostic-body">
                    Hệ thống trạm con không thể chuyển đổi JSON trong file license sang cấu trúc <code>LicenseEnvelope</code> của backend.
                  </p>
                  <button
                    type="button"
                    className={`btn-diagnostic-copy ${copied ? 'copied' : ''}`}
                    onClick={handleCopyDevMessage}
                  >
                    {copied ? (
                      <>
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" className="btn-icon">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        Đã sao chép báo cáo lỗi!
                      </>
                    ) : (
                      <>
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" className="btn-icon">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                        Sao chép tin nhắn báo lỗi chi tiết gửi Dev
                      </>
                    )}
                  </button>
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
