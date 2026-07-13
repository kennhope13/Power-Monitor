// ============================================================
// ScanModal.tsx — Modal khám phá thiết bị mạng
// Bao gồm: Quét LAN, ONVIF, Test kết nối thủ công + Auto-thêm Hikvision
// ============================================================
import { useEffect, useState } from 'react';
import { stationApi } from '@/services/StationApiService';
import { Camera, Thermometer, Circle, CheckCircle2, AlertTriangle, X } from 'lucide-react';

type Props = {
  open: boolean;
  stationId: string | null;
  onClose: () => void;
  onDeviceAdded: () => void;
};

export default function ScanModal({ open, stationId, onClose, onDeviceAdded }: Props) {
  const [scanTab, setScanTab] = useState(0);
  const [canCreateNewDevice, setCanCreateNewDevice] = useState(false);

  // LAN Scan
  const [scanSubnet, setScanSubnet] = useState('192.168.10');
  const [isScanning, setIsScanning] = useState(false);
  const [scanResults, setScanResults] = useState<any[] | null>(null);

  // ONVIF
  const [isOnvifScanning, setIsOnvifScanning] = useState(false);
  const [onvifResults, setOnvifResults] = useState<any[] | null>(null);

  // Test thủ công
  const [tcIp, setTcIp] = useState('');
  const [tcProtocol, setTcProtocol] = useState('plc_s7');
  const [tcPort, setTcPort] = useState(102);
  const [isTesting, setIsTesting] = useState(false);
  const [tcResult, setTcResult] = useState<any | null>(null);

  // Auto-configure Hikvision
  const [autoConfigTarget, setAutoConfigTarget] = useState<{ ip: string } | null>(null);
  const [autoConfigCreds, setAutoConfigCreds] = useState({ username: 'admin', password: '' });
  const [isAutoConfiguring, setIsAutoConfiguring] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    stationApi.getLicenseStatus()
      .then(data => {
        if (!cancelled) setCanCreateNewDevice(data?.activated === true && data?.isValid === true);
      })
      .catch(() => {
        if (!cancelled) setCanCreateNewDevice(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const runLanScan = async () => {
    setIsScanning(true); setScanResults(null);
    try { setScanResults(await stationApi.scanLan(scanSubnet)); }
    catch (err: any) { alert(`Lỗi quét LAN: ${err.message || err}`); }
    finally { setIsScanning(false); }
  };

  const runOnvifScan = async () => {
    setIsOnvifScanning(true); setOnvifResults(null);
    try { setOnvifResults(await stationApi.discoverOnvif()); }
    catch (err: any) { alert(`Lỗi tìm ONVIF: ${err.message || err}`); }
    finally { setIsOnvifScanning(false); }
  };

  const runTestConn = async () => {
    if (!tcIp) { alert('Nhập địa chỉ IP'); return; }
    setIsTesting(true); setTcResult(null);
    try { setTcResult(await stationApi.testProtocolConnection(tcIp, tcPort, tcProtocol)); }
    catch { alert('Lỗi test kết nối'); }
    finally { setIsTesting(false); }
  };

  const runAutoConfig = async () => {
    if (!canCreateNewDevice) {
      alert('Cần nhập và kích hoạt license trước khi thêm thiết bị mới.');
      return;
    }
    if (!stationId || !autoConfigTarget) return;
    setIsAutoConfiguring(true);
    try {
      const res = await stationApi.autoConfigure(stationId, autoConfigTarget.ip, autoConfigCreds.username, autoConfigCreds.password);
      const names = res.created.map((d: any) => d.name).join('\n');
      alert(`Đã tạo ${res.created.length} thiết bị:\n${names}`);
      setAutoConfigTarget(null);
      onDeviceAdded();
    } catch (e: any) {
      alert(`Lỗi: ${e.message}`);
    } finally {
      setIsAutoConfiguring(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="modal-overlay active">
        <div className="modal-content" style={{ maxWidth: 680 }}>
          <div className="modal-header">
            <h3>Khám phá thiết bị</h3>
            <button className="modal-close-btn" onClick={onClose}><X size={20} /></button>
          </div>
          <div className="modal-body">
            {/* Tabs */}
            <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--admin-border)', marginBottom: 16 }}>
              {['Quét LAN', 'ONVIF', 'Test kết nối'].map((t, i) => (
                <button key={i} onClick={() => setScanTab(i)}
                  style={{ padding: '8px 16px', background: 'none', border: 'none', borderBottom: `2px solid ${i === scanTab ? 'var(--admin-accent)' : 'transparent'}`, color: i === scanTab ? 'var(--admin-accent)' : 'var(--admin-text)', opacity: i === scanTab ? 1 : 0.5, fontSize: '.8rem', fontWeight: 600, cursor: 'pointer' }}>
                  {t}
                </button>
              ))}
            </div>

            {/* LAN Scan */}
            {scanTab === 0 && (
              <div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <input type="text" className="form-input" value={scanSubnet} onChange={e => setScanSubnet(e.target.value)} placeholder="Subnet: 192.168.10" style={{ flex: 1 }} />
                  <button className="btn-industrial btn-primary" onClick={runLanScan} disabled={isScanning}>▶ Bắt đầu quét</button>
                </div>
                <div style={{ minHeight: 120, maxHeight: 280, overflowY: 'auto', background: 'var(--admin-layer-2)', border: '1px solid var(--admin-border)', padding: 12, fontSize: '.82rem' }}>
                  {isScanning ? <div style={{ color: 'var(--admin-text-muted)', textAlign: 'center' }}>⏳ Đang quét {scanSubnet}.1 → .254 ...</div>
                    : scanResults === null ? <div style={{ color: 'var(--admin-text-muted)', textAlign: 'center' }}>Nhấn "Bắt đầu quét" để tìm thiết bị trong subnet</div>
                      : scanResults.length === 0 ? <div style={{ color: 'var(--admin-text-muted)', textAlign: 'center' }}>Không tìm thấy thiết bị nào</div>
                        : scanResults.map((f, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--admin-border)', gap: 8 }}>
                            <div style={{ flex: 1 }}>
                              <b style={{ color: 'var(--admin-text)' }}>{f.ip}</b>
                              <span style={{ marginLeft: 8, fontSize: '.75rem', color: f.protocol === 'hikvision' ? 'var(--admin-accent)' : 'var(--admin-text-muted)' }}>
                                {f.protocol === 'hikvision' ? <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Camera size={12} /> Hikvision</span> : f.guessedType || f.protocol || 'Unknown'}
                              </span>
                              {f.protocol === 'hikvision' && f.deviceInfo && <span style={{ marginLeft: 6, fontSize: '.72rem', color: 'var(--admin-text-muted)' }}>{f.deviceInfo}</span>}
                              {f.protocol === 'hikvision' && f.hasThermal && <span style={{ marginLeft: 6, fontSize: '.7rem', background: 'var(--admin-tag-danger-bg)', color: 'var(--admin-danger)', padding: '1px 6px', display: 'inline-flex', alignItems: 'center', gap: 2 }}><Thermometer size={10} /> Nhiệt</span>}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              {f.protocol === 'hikvision' && (
                                <button className="btn-industrial btn-sm btn-primary" onClick={() => {
                                  if (!canCreateNewDevice) {
                                    alert('Cần nhập và kích hoạt license trước khi thêm thiết bị mới.');
                                    return;
                                  }
                                  setAutoConfigTarget({ ip: f.ip });
                                }} disabled={!canCreateNewDevice} title="Tự động tạo tất cả luồng cho camera này">Auto-thêm</button>
                              )}
                              <span style={{ fontSize: '.75rem', color: f.isOnline || f.isReachable ? 'var(--admin-success)' : 'var(--admin-danger)' }}>
                                {f.isOnline || f.isReachable ? <Circle size={12} fill="var(--admin-success)" color="var(--admin-success)" /> : <Circle size={12} fill="var(--admin-text-muted)" color="var(--admin-text-muted)" />}
                              </span>
                            </div>
                          </div>
                        ))}
                </div>
              </div>
            )}

            {/* ONVIF */}
            {scanTab === 1 && (
              <div>
                <p style={{ fontSize: '.82rem', opacity: 0.7, marginBottom: 12, color: 'var(--admin-text)' }}>Gửi WS-Discovery multicast để tìm camera ONVIF trong cùng subnet.</p>
                <button className="btn-industrial btn-primary" onClick={runOnvifScan} disabled={isOnvifScanning}>Tìm camera ONVIF</button>
                <div style={{ marginTop: 12, minHeight: 100, maxHeight: 280, overflowY: 'auto', background: 'var(--admin-layer-2)', border: '1px solid var(--admin-border)', padding: 12, fontSize: '.82rem' }}>
                  {isOnvifScanning ? <div style={{ color: 'var(--admin-text-muted)', textAlign: 'center' }}>⏳ Đang tìm...</div>
                    : onvifResults === null ? <div style={{ color: 'var(--admin-text-muted)', textAlign: 'center' }}>Nhấn nút để tìm</div>
                      : onvifResults.length === 0 ? <div style={{ color: 'var(--admin-text-muted)', textAlign: 'center' }}>Không tìm thấy camera ONVIF</div>
                        : onvifResults.map((c, i) => (
                          <div key={i} style={{ padding: '10px 12px', borderBottom: '1px solid var(--admin-border)' }}>
                            <b style={{ color: 'var(--admin-text)' }}>{c.ip || c.address || 'N/A'}</b>
                            <span style={{ marginLeft: 8, fontSize: '.75rem', color: 'var(--admin-accent)', fontWeight: 'bold' }}>ONVIF</span>
                            {c.name && <div style={{ fontSize: '.75rem', color: 'var(--admin-text-muted)', marginTop: 2 }}>{c.name}</div>}
                          </div>
                        ))}
                </div>
              </div>
            )}

            {/* Test thủ công */}
            {scanTab === 2 && (
              <div>
                <div className="form-grid-2" style={{ marginBottom: 12 }}>
                  <div className="form-group"><label>Địa chỉ IP</label><input type="text" className="form-input" value={tcIp} onChange={e => setTcIp(e.target.value)} placeholder="192.168.10.100" /></div>
                  <div className="form-group">
                    <label>Giao thức</label>
                    <select className="form-select" value={tcProtocol} onChange={e => setTcProtocol(e.target.value)}>
                      <option value="plc_s7">PLC S7 (Snap7)</option>
                      <option value="modbus_tcp">Modbus TCP</option>
                      <option value="camera_rtsp">Camera RTSP</option>
                      <option value="onvif">ONVIF</option>
                    </select>
                  </div>
                  <div className="form-group"><label>Port</label><input type="number" className="form-input" value={tcPort} onChange={e => setTcPort(Number(e.target.value))} /></div>
                </div>
                <button className="btn-industrial btn-primary" onClick={runTestConn} disabled={isTesting}>Test kết nối</button>
                <div style={{ marginTop: 12, minHeight: 80, background: 'var(--admin-layer-2)', border: '1px solid var(--admin-border)', padding: 12, fontSize: '.82rem', color: 'var(--admin-text-muted)' }}>
                  {isTesting ? '⏳ Đang test...' : tcResult === null ? 'Nhập thông tin và nhấn Test' : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <b style={{ color: tcResult.success ? 'var(--admin-success)' : 'var(--admin-danger)' }}>
                          {tcResult.success
                            ? <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><CheckCircle2 size={14} /> Kết nối thành công</span>
                            : <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><AlertTriangle size={14} /> Kết nối thất bại</span>}
                        </b>
                        {tcResult.latencyMs != null && <span style={{ fontSize: '.75rem', color: 'var(--admin-text-muted)' }}>{tcResult.latencyMs}ms</span>}
                      </div>
                      {tcResult.message && <div style={{ fontSize: '.8rem', color: 'var(--admin-text-muted)' }}>{tcResult.message}</div>}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Auto-configure Hikvision sub-modal */}
      {autoConfigTarget && (
        <div className="modal-overlay active" style={{ zIndex: 1100 }}>
          <div className="modal-content" style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h3>Auto-thêm camera Hikvision</h3>
              <button className="modal-close-btn" onClick={() => setAutoConfigTarget(null)}><X size={20} /></button>
            </div>
            <div className="modal-body">

              <div style={{ marginBottom: 14, padding: '8px 12px', background: 'var(--admin-layer-2)', border: '1px solid var(--admin-border)', fontSize: '.8rem', color: 'var(--admin-text-muted)' }}>
                IP: <b style={{ color: 'var(--admin-text)' }}>{autoConfigTarget.ip}</b> — Hệ thống sẽ tự detect capabilities qua ISAPI và tạo đúng số bản ghi.
              </div>
              <div className="form-group">
                <label>Username</label>
                <input type="text" className="form-input" value={autoConfigCreds.username} onChange={e => setAutoConfigCreds(p => ({ ...p, username: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Password</label>
                <input type="password" className="form-input" value={autoConfigCreds.password} onChange={e => setAutoConfigCreds(p => ({ ...p, password: e.target.value }))} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-industrial" onClick={() => setAutoConfigTarget(null)}>Hủy</button>
              <button className="btn-industrial btn-primary" disabled={isAutoConfiguring || !canCreateNewDevice} onClick={runAutoConfig}>
                {isAutoConfiguring ? '⏳ Đang xử lý...' : 'Tự động cấu hình'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
