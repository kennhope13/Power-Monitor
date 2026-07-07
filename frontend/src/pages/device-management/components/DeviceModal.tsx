// ============================================================
// DeviceModal.tsx — Modal thêm/sửa thiết bị
// ============================================================
import { useState, useEffect } from 'react';
import { stationApi, Device } from '@/services/StationApiService';
import { Eye, EyeOff, Camera, Thermometer, CheckCircle2, X } from 'lucide-react';
import { showToast } from '@/utils/toast';

type FormData = {
  name: string; type: string; ip: string;
  rack: number; slot: number; db: number; length: number; pollIntervalS: number;
  username: string; password: string;
  rtspPath: string; go2rtcId: string;
  rtspOptical: string; go2rtcOptical: string;
  rtspThermal: string; go2rtcThermal: string;
  cabinetId: string; zone: string; mountType: string;
  port: number; unitId: number; enableHealthScore: boolean;
  focalLengthOptical?: number;
  focalLengthThermal?: number;
  jetsonIp: string;
};

const DEFAULT_FORM: FormData = {
  name: '', type: 'camera_cctv', ip: '',
  rack: 0, slot: 1, db: 32, length: 10, pollIntervalS: 5,
  username: '', password: '',
  rtspPath: '', go2rtcId: '',
  rtspOptical: '', go2rtcOptical: '',
  rtspThermal: '', go2rtcThermal: '',
  cabinetId: '', zone: '', mountType: 'outdoor',
  port: 502, unitId: 1, enableHealthScore: false,
  focalLengthOptical: undefined,
  focalLengthThermal: undefined,
  jetsonIp: '',
};

type Props = {
  open: boolean;
  editingDevice?: Device | null;
  stationId: string | null;
  onClose: () => void;
  onSaved: () => void;
};

export default function DeviceModal({ open, editingDevice, stationId, onClose, onSaved }: Props) {
  const [formData, setFormData] = useState<FormData>(DEFAULT_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [hadPassword, setHadPassword] = useState(false);
  const [fetchedPassword, setFetchedPassword] = useState('');
  const [testConnResult, setTestConnResult] = useState<{ show: boolean; success?: boolean; msg?: string }>({ show: false });
  const [canCreateNewDevice, setCanCreateNewDevice] = useState(false);

  const editingId = editingDevice?.id ?? null;

  useEffect(() => {
    if (!open) return;
    setTestConnResult({ show: false });
    setFetchedPassword('');
    if (editingDevice) {
      const cfg = editingDevice.config || {};
      const isCabinetLike = editingDevice.type === 'cabinet'
        || (editingDevice.type === 'plc_s7' && (Array.isArray(cfg.points) || Array.isArray(cfg.cabinet_points) || !!cfg.cabinet_code || !!cfg.poll_enabled));
      const wasPasswordSet = !!cfg.password && cfg.password !== '';
      setHadPassword(wasPasswordSet);
      setShowPassword(false);
      setFormData({
        name: editingDevice.name, type: isCabinetLike ? 'plc_s7' : editingDevice.type, ip: cfg.ip || '',
        rack: cfg.rack ?? 0, slot: cfg.slot ?? 1, db: cfg.db ?? 32, length: cfg.length ?? 10,
        pollIntervalS: cfg.poll_interval_s ?? 5,
        username: cfg.username || 'admin', password: wasPasswordSet ? '***' : '',
        rtspPath: cfg.rtsp_path || '', go2rtcId: cfg.go2rtc_id || '',
        rtspOptical: cfg.rtsp_optical || '', go2rtcOptical: cfg.go2rtc_optical || '',
        rtspThermal: cfg.rtsp_thermal || '', go2rtcThermal: cfg.go2rtc_thermal || '',
        cabinetId: cfg.cabinetId || '', zone: cfg.zone || '', mountType: cfg.mountType || 'outdoor',
        port: cfg.port ?? 502, unitId: cfg.unit_id ?? 1, enableHealthScore: cfg.enableHealthScore ?? false,
        focalLengthOptical: cfg.focal_length_optical != null ? parseFloat(cfg.focal_length_optical) : undefined,
        focalLengthThermal: cfg.focal_length_thermal != null ? parseFloat(cfg.focal_length_thermal) : undefined,
        jetsonIp: cfg.jetson_ip || '',
      });
    } else {
      setHadPassword(false);
      setShowPassword(false);
      setFormData(DEFAULT_FORM);
    }
  }, [open, editingDevice]);

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

  const set = (patch: Partial<FormData>) => setFormData(f => ({ ...f, ...patch }));

  const saveDevice = async () => {
    if (!editingId && !canCreateNewDevice) {
      alert('Cần nhập và kích hoạt license trước khi thêm thiết bị mới.');
      return;
    }

    if (!formData.name) { alert('Vui lòng nhập tên thiết bị'); return; }
    setIsSaving(true);
    try {
      const configObj: any = { ip: formData.ip, zone: formData.zone.trim(), mountType: formData.mountType };
      let protocol = 'modbus';
      const effectivePassword = (editingId && !formData.password.trim()) ? '***' : formData.password;

      if (formData.type === 'plc_s7') {
        protocol = 'snap7';
        Object.assign(configObj, { rack: formData.rack, slot: formData.slot, db: formData.db, offset: 0, length: formData.length, poll_interval_s: formData.pollIntervalS, enableHealthScore: formData.enableHealthScore });
      } else if (formData.type === 'camera_dual') {
        protocol = 'rtsp';
        const gOptical = formData.go2rtcOptical.trim() || `cam_${formData.ip.replace(/\./g, '_')}_optical`;
        const gThermal = formData.go2rtcThermal.trim() || `cam_${formData.ip.replace(/\./g, '_')}_thermal`;
        Object.assign(configObj, {
          rtsp_optical: formData.rtspOptical.trim(),
          go2rtc_optical: gOptical,
          rtsp_thermal: formData.rtspThermal.trim(),
          go2rtc_thermal: gThermal,
          username: formData.username,
          password: effectivePassword,
          focal_length_optical: formData.focalLengthOptical,
          focal_length_thermal: formData.focalLengthThermal,
          ...(formData.jetsonIp.trim() ? { jetson_ip: formData.jetsonIp.trim() } : {})
        });
      } else if (formData.type === 'camera_thermal') {
        protocol = 'rtsp';
        const gThermal = formData.go2rtcThermal.trim() || `cam_${formData.ip.replace(/\./g, '_')}_thermal`;
        Object.assign(configObj, {
          rtsp_thermal: formData.rtspThermal.trim(), go2rtc_thermal: gThermal,
          username: formData.username, password: effectivePassword,
          ...(formData.jetsonIp.trim() ? { jetson_ip: formData.jetsonIp.trim() } : {})
        });
      } else if (formData.type.startsWith('camera')) {
        protocol = 'rtsp';
        let rp = formData.rtspPath.trim();
        if (rp && !rp.startsWith('/')) rp = '/' + rp;
        const gid = formData.go2rtcId.trim() || `camera_${formData.ip.replace(/\./g, '_')}_${formData.type.replace('camera_', '')}`;
        Object.assign(configObj, { rtsp_path: rp, go2rtc_id: gid, username: formData.username, password: effectivePassword });
      } else if (formData.type === 'modbus_tcp') {
        Object.assign(configObj, { port: formData.port, unit_id: formData.unitId, username: formData.username, password: effectivePassword });
      }

      const configStr = JSON.stringify(configObj);
      if (editingId) {
        await stationApi.updateDevice(editingId, { name: formData.name, config: configStr });
      } else {
        await stationApi.createDevice({ stationId: stationId!, name: formData.name, type: formData.type, protocol, config: configStr });
      }
      onSaved();
      onClose();
      showToast(editingId ? 'Cập nhật thiết bị thành công' : 'Thêm thiết bị thành công', 'success');
    } catch (e: any) {
      alert(`Lỗi: ${e.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const testConn = async () => {
    if (!editingId) { setTestConnResult({ show: true, success: false, msg: 'Lưu thiết bị trước rồi mới test được.' }); return; }
    setTestConnResult({ show: true, msg: 'Đang kiểm tra...' });
    try {
      const res = await stationApi.testConnection(editingId);
      setTestConnResult({ show: true, success: res.success, msg: res.success ? `Kết nối thành công — ${res.latencyMs}ms` : res.message });
    } catch {
      setTestConnResult({ show: true, success: false, msg: 'Lỗi kết nối' });
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay active">
      <div className="modal-content" style={{ maxWidth: 560 }}>
        <div className="modal-header" style={{ position: 'relative' }}>
          <h3
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              textAlign: 'center',
              color: 'var(--admin-accent)',
              margin: 0,
              pointerEvents: 'none',
            }}
          >
            {editingId ? `Sửa: ${formData.name}` : 'Thêm thiết bị mới'}
          </h3>
          <button className="modal-close-btn" onClick={onClose} style={{ marginLeft: 'auto', position: 'relative', zIndex: 1 }}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          {!canCreateNewDevice && !editingId && (
            <div style={{ marginBottom: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: 'var(--admin-danger)', fontSize: '.78rem', fontWeight: 700 }}>
              Cần license để thêm thiết bị mới.
            </div>
          )}
          <div className="form-grid-2">
            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <label>Tên hiển thị *</label>
              <input type="text" className="form-input" placeholder="VD: PLC Tủ điện A1" value={formData.name} onChange={e => set({ name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Loại thiết bị *</label>
              <select className="form-select" value={formData.type} onChange={e => set({ type: e.target.value })}>
                <option value="plc_s7">PLC S7-1200/1500</option>
                <option value="camera_cctv">Camera Thường (RTSP)</option>
                <option value="camera_thermal">Camera Nhiệt (RTSP) — chỉ luồng nhiệt</option>
                <option value="camera_dual">Camera Dual-Stream (quang học + nhiệt)</option>
                <option value="camera_pd">Camera Phóng điện (RTSP)</option>
                <option value="modbus_tcp">Cảm biến Modbus TCP</option>
              </select>
            </div>
            <div className="form-group">
              <label>Địa chỉ IP *</label>
              <input type="text" className="form-input" placeholder="192.168.10.x" value={formData.ip} onChange={e => set({ ip: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Khu vực (Zone) <small style={{ opacity: .7, fontWeight: 400 }}>(vd: Sân trạm, Tủ 01)</small></label>
              <input type="text" list="zone-suggestions" className="form-input" placeholder="Nhập hoặc chọn..." value={formData.zone} onChange={e => set({ zone: e.target.value })} />
              <datalist id="zone-suggestions">
                <option value="Ngoài trời" /><option value="Hành lang" /><option value="Tủ trung thế 01" />
              </datalist>
            </div>
            <div className="form-group">
              <label>Vị trí lắp đặt</label>
              <select className="form-select" value={formData.mountType} onChange={e => set({ mountType: e.target.value })}>
                <option value="outdoor">Cột/Trụ ngoài trời</option>
                <option value="wall">Gắn tường (Tổng quan)</option>
                <option value="cabinet">Bên trong Tủ điện (Mini)</option>
              </select>
            </div>

            {formData.type === 'plc_s7' && (
              <>
                <div className="form-group" style={{ gridColumn: '1/-1', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 8 }}>
                  <div><label>Rack</label><input type="number" className="form-input" value={formData.rack} onChange={e => set({ rack: Number(e.target.value) })} /></div>
                  <div><label>Slot</label><input type="number" className="form-input" value={formData.slot} onChange={e => set({ slot: Number(e.target.value) })} /></div>
                  <div><label>DB Number</label><input type="number" className="form-input" value={formData.db} onChange={e => set({ db: Number(e.target.value) })} /></div>
                  <div><label>Length</label><input type="number" className="form-input" value={formData.length} onChange={e => set({ length: Number(e.target.value) })} /></div>
                  <div><label>Lấy mẫu (s)</label><input type="number" className="form-input" min={1} value={formData.pollIntervalS} onChange={e => set({ pollIntervalS: Number(e.target.value) })} /></div>
                </div>
                <div className="form-group" style={{ gridColumn: '1/-1', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                  <input type="checkbox" id="enableHealthScore" checked={formData.enableHealthScore} onChange={e => set({ enableHealthScore: e.target.checked })} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                  <label htmlFor="enableHealthScore" style={{ margin: 0, fontWeight: 600, cursor: 'pointer', fontSize: '.82rem', color: 'var(--admin-text)' }}>Đánh giá sức khỏe thiết bị (Tính điểm sức khỏe 0-100)</label>
                </div>
              </>
            )}

            {(formData.type.startsWith('camera') || formData.type === 'modbus_tcp') && (
              <>
                <div className="form-group">
                  <label>Username</label>
                  <input type="text" className="form-input" value={formData.username} onChange={e => set({ username: e.target.value })} autoComplete="off" placeholder="VD: admin" />
                </div>
                <div className="form-group">
                  <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>Password {editingId && hadPassword && <span style={{ fontSize: '.7rem', color: 'var(--admin-success, #22c55e)', fontWeight: 400, display: 'inline-flex', alignItems: 'center', gap: 2 }}><CheckCircle2 size={10} /> Đã cấu hình</span>}</span>
                    <button type="button" onClick={() => {
                      setShowPassword(prev => {
                        const next = !prev;
                        if (next && editingId && formData.password === '***') {
                          stationApi.getCredentials(editingId).then((creds: any) => {
                            setFetchedPassword(creds.password);
                            setFormData(f => ({ ...f, password: creds.password }));
                          }).catch(() => {});
                        }
                        if (!next && formData.password === fetchedPassword && fetchedPassword) {
                          setFormData(f => ({ ...f, password: '***' }));
                        }
                        return next;
                      });
                    }} style={{ background: 'none', border: '1px solid var(--admin-border, #334)', borderRadius: 3, cursor: 'pointer', padding: '2px 6px', display: 'flex', alignItems: 'center', color: 'var(--admin-text-muted)' }}>
                      {showPassword ? <EyeOff size={13} strokeWidth={1.8} /> : <Eye size={13} strokeWidth={1.8} />}
                    </button>
                  </label>
                  <input type={showPassword ? 'text' : 'password'} className="form-input" value={formData.password} placeholder={editingId && hadPassword ? 'Để trống = giữ mật khẩu cũ' : ''} onChange={e => set({ password: e.target.value })} autoComplete="new-password" />
                </div>
              </>
            )}

            {(formData.type === 'camera_dual' || formData.type === 'camera_thermal') && (
              <div style={{ gridColumn: '1/-1', display: 'flex', flexDirection: 'column', gap: 10, padding: '16px', background: 'rgba(239,68,68,.04)', border: '1px solid rgba(239,68,68,.18)', borderRadius: 6 }}>
                <div style={{ fontSize: '.65rem', fontWeight: 800, color: 'var(--admin-danger)', textTransform: 'uppercase', letterSpacing: '.8px', display: 'flex', gap: 6, alignItems: 'center' }}><Thermometer size={14} /> Luồng nhiệt (bắt buộc)</div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>RTSP URL — Nhiệt</span>
                    <select className="form-select" style={{ fontSize: 11, padding: '2px 6px', width: 'auto', minWidth: 120 }} onChange={e => { if (e.target.value) set({ rtspThermal: e.target.value }); }}>
                      <option value="">-- Preset --</option>
                      <option value="/Streaming/Channels/2">Hikvision kênh nhiệt 2 (HEVC/H.265)</option>
                      <option value="/Streaming/Channels/201">Hikvision kênh nhiệt 201</option>
                      <option value="/Streaming/Channels/202">Hikvision nhiệt sub 202</option>
                      <option value="/thermal/main">Generic /thermal/main</option>
                    </select>
                  </label>
                  <input type="text" className="form-input" placeholder="/Streaming/Channels/201" value={formData.rtspThermal} onChange={e => set({ rtspThermal: e.target.value })} />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>IP Jetson <small style={{ opacity: .7, fontWeight: 400 }}>(đồng bộ điểm nhiệt tự động)</small></label>
                  <input type="text" className="form-input" placeholder="VD: 192.168.10.104" value={formData.jetsonIp} onChange={e => set({ jetsonIp: e.target.value })} />
                </div>
              </div>
            )}

            {formData.type === 'camera_dual' && (
              <div style={{ gridColumn: '1/-1', display: 'flex', flexDirection: 'column', gap: 10, padding: '16px', background: 'rgba(59,130,246,.04)', border: '1px solid rgba(59,130,246,.18)', borderRadius: 6 }}>
                <div style={{ fontSize: '.65rem', fontWeight: 800, color: 'var(--admin-accent)', textTransform: 'uppercase', letterSpacing: '.8px', display: 'flex', gap: 6, alignItems: 'center' }}><Camera size={14} /> Luồng quang học</div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>RTSP URL — Quang học</span>
                    <select className="form-select" style={{ fontSize: 11, padding: '2px 6px', width: 'auto', minWidth: 120 }} onChange={e => { if (e.target.value) set({ rtspOptical: e.target.value }); }}>
                      <option value="">-- Preset --</option>
                      <option value="/Streaming/Channels/101">Hikvision kênh chính 101</option>
                      <option value="/Streaming/Channels/102">Hikvision kênh phụ 102</option>
                      <option value="/stream1">Generic /stream1</option>
                    </select>
                  </label>
                  <input type="text" className="form-input" placeholder="/Streaming/Channels/101" value={formData.rtspOptical} onChange={e => set({ rtspOptical: e.target.value })} />
                </div>
              </div>
            )}

            {formData.type === 'camera_dual' && (
              <div style={{ gridColumn: '1/-1', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: '16px', background: 'rgba(16,185,129,.04)', border: '1px solid rgba(16,185,129,.18)', borderRadius: 6 }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ color: 'var(--admin-text)' }}>Tiêu cự Quang học (mm)</label>
                  <input type="number" step="0.1" className="form-input" placeholder="VD: 4.0" value={formData.focalLengthOptical ?? ''} onChange={e => set({ focalLengthOptical: e.target.value === '' ? undefined : parseFloat(e.target.value) })} />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ color: 'var(--admin-text)' }}>Tiêu cự Nhiệt (mm)</label>
                  <input type="number" step="0.1" className="form-input" placeholder="VD: 4.0" value={formData.focalLengthThermal ?? ''} onChange={e => set({ focalLengthThermal: e.target.value === '' ? undefined : parseFloat(e.target.value) })} />
                </div>
              </div>
            )}

            {formData.type !== 'camera_dual' && formData.type !== 'camera_thermal' && formData.type.startsWith('camera') && (
              <div className="form-group" style={{ gridColumn: '1/-1', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>RTSP Path</span>
                  <select className="form-select" style={{ fontSize: 11, padding: '2px 6px', width: 'auto', minWidth: 120 }} onChange={e => { if (e.target.value) set({ rtspPath: e.target.value }); }}>
                    <option value="">-- Preset Hikvision --</option>
                    <option value="/Streaming/Channels/101">Kênh chính (101)</option>
                    <option value="/Streaming/Channels/102">Kênh phụ (102)</option>
                    <option value="/stream1">Generic /stream1</option>
                  </select>
                </label>
                <input type="text" className="form-input" placeholder="/Streaming/Channels/101" value={formData.rtspPath} onChange={e => set({ rtspPath: e.target.value })} />
              </div>
            )}

            {formData.type === 'modbus_tcp' && (
              <div style={{ gridColumn: '1/-1', display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}><label>Port</label><input type="number" className="form-input" value={formData.port} onChange={e => set({ port: Number(e.target.value) })} /></div>
                <div style={{ flex: 1 }}><label>Unit ID</label><input type="number" className="form-input" value={formData.unitId} onChange={e => set({ unitId: Number(e.target.value) })} /></div>
              </div>
            )}
          </div>

          {testConnResult.show && (
            <div style={{ marginTop: 10, fontSize: '.85rem', padding: 8, background: testConnResult.success === undefined ? 'var(--admin-layer-2)' : testConnResult.success ? 'var(--admin-tag-success-bg)' : 'var(--admin-tag-danger-bg)', color: testConnResult.success === undefined ? 'var(--admin-text)' : testConnResult.success ? 'var(--admin-success)' : 'var(--admin-danger)', border: '1px solid var(--admin-border)' }}>
              {testConnResult.msg}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-industrial" onClick={testConn}>Test kết nối</button>
          <div style={{ flex: 1 }} />
          <button className="btn-industrial" onClick={onClose}>Hủy</button>
          <button className="btn-industrial btn-primary" onClick={saveDevice} disabled={isSaving || (!editingId && !canCreateNewDevice)}>{isSaving ? '⏳ Đang lưu...' : 'Lưu thiết bị'}</button>
        </div>
      </div>
    </div>
  );
}
