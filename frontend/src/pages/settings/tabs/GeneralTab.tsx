// ============================================================
// GeneralTab.tsx — Tab "Cài đặt chung" (Redesign Chuẩn Công Nghiệp)
// Cấu hình:
//   - plc_poll_interval_s          : chu kỳ đọc PLC/Modbus (giây)
//   - db_save_interval_s           : chu kỳ lưu dữ liệu xuống DB (giây)
//   - camera_record_duration_s     : thời lượng ghi hình camera (giây)
//   - health_check_interval_s      : tần suất kiểm tra thiết bị còn sống (giây)
//   - alert_email                  : email nhận cảnh báo
//   - timezone                     : múi giờ hệ thống
// ============================================================

import { useState, useEffect } from 'react';
import { stationApi } from '@/services/StationApiService';
import { showToast } from '@/utils/toast';

export default function GeneralTab() {
  const [plcPoll, setPlcPoll] = useState('5');
  const [dbSave, setDbSave] = useState('60');
  const [camRecord, setCamRecord] = useState('12');
  const [healthCheck, setHealthCheck] = useState('30');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [enableEmail, setEnableEmail] = useState(true);
  const [enableSms, setEnableSms] = useState(false);
  const [timezone, setTimezone] = useState('Asia/Ho_Chi_Minh');
  const [loading, setLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');

  // Thông tin trạm cục bộ
  const [stationId, setStationId] = useState<string | null>(null);
  const [stationName, setStationName] = useState('');

  // Trạng thái kiểm tra lỗi (Validation Errors)
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = () => {
    setLoading(true);
    stationApi.getSettings()
      .then(data => {
        setPlcPoll(data['plc_poll_interval_s'] ?? '5');
        setDbSave(data['db_save_interval_s'] ?? '60');
        setCamRecord(data['camera_record_duration_s'] ?? '12');
        setHealthCheck(data['health_check_interval_s'] ?? '30');
        setEmail(data['alert_email'] ?? '');
        setPhone(data['alert_phone'] ?? '');
        setEnableEmail(data['enable_alert_email'] !== 'false');
        setEnableSms(data['enable_alert_sms'] === 'true');
        setTimezone(data['timezone'] ?? 'Asia/Ho_Chi_Minh');
        
        // Reset errors
        setErrors({});
      })
      .catch(() => showToast('Không thể tải cài đặt từ máy chủ', 'error'))
      .finally(() => setLoading(false));

    stationApi.getStations().then(stations => {
      if (stations && stations.length > 0) {
        setStationId(stations[0].id);
        setStationName(stations[0].name);
      }
    }).catch(() => console.error('Lỗi tải thông tin trạm'));
  };

  // Kiểm tra tính hợp lệ của tham số thời gian thực (Live Validation)
  const validateField = (name: string, value: string): string => {
    const numericFields = ['plcPoll', 'dbSave', 'camRecord', 'healthCheck'];
    if (numericFields.includes(name)) {
      const num = Number(value);
      if (!value || isNaN(num)) return 'Giá trị nhập phải là chữ số';
      
      switch (name) {
        case 'plcPoll':
          if (num < 1 || num > 60) return 'Chu kỳ quét PLC phải từ 1 đến 60 giây';
          break;
        case 'dbSave':
          if (num < 5 || num > 3600) return 'Chu kỳ lưu DB phải từ 5 đến 3600 giây (1 giờ)';
          if (num < Number(plcPoll)) return 'Chu kỳ lưu trữ DB không được nhỏ hơn chu kỳ lấy mẫu PLC';
          break;
        case 'camRecord':
          if (num < 3 || num > 300) return 'Thời lượng video trích xuất phải từ 3 đến 300 giây';
          break;
        case 'healthCheck':
          if (num < 5 || num > 1800) return 'Tần suất kiểm tra thiết bị phải từ 5 đến 1800 giây';
          break;
      }
    } else {
      switch (name) {
        case 'stationName':
          if (!value.trim()) return 'Tên trạm không được để trống';
          break;
        case 'email':
          if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Định dạng Email không hợp lệ';
          break;
        case 'phone':
          if (value && !/^\+?[0-9]{9,15}$/.test(value)) return 'Số điện thoại không hợp lệ';
          break;
      }
    }
    return '';
  };

  const handleFieldChange = (name: string, value: string, setter: (v: string) => void) => {
    setter(value);
    const err = validateField(name, value);
    setErrors(prev => {
      const next = { ...prev };
      if (err) next[name] = err;
      else delete next[name];
      return next;
    });
  };

  // Áp dụng các chế độ vận hành định sẵn (Industrial Presets)
  const applyPreset = (presetType: 'standard' | 'high' | 'saver') => {
    if (presetType === 'standard') {
      setPlcPoll('5');
      setDbSave('60');
      setCamRecord('15');
      setHealthCheck('30');
      showToast('Đã áp dụng thông số: Vận hành Tiêu chuẩn', 'info');
    } else if (presetType === 'high') {
      setPlcPoll('2');
      setDbSave('30');
      setCamRecord('20');
      setHealthCheck('15');
      showToast('Đã áp dụng thông số: Đọc liên tục & Phản ứng nhanh', 'info');
    } else if (presetType === 'saver') {
      setPlcPoll('10');
      setDbSave('120');
      setCamRecord('10');
      setHealthCheck('60');
      showToast('Đã áp dụng thông số: Tiết kiệm tài nguyên & Ổ cứng', 'info');
    }
    
    // Clear errors after preset load
    setErrors({});
  };

  // Khôi phục mặc định ban đầu của nhà máy
  const resetToFactoryDefaults = () => {
    setPlcPoll('5');
    setDbSave('60');
    setCamRecord('12');
    setHealthCheck('30');
    setEmail('');
    setPhone('');
    setEnableEmail(true);
    setEnableSms(false);
    setTimezone('Asia/Ho_Chi_Minh');
    setErrors({});
    showToast('Đã khôi phục cài đặt mặc định nhà máy', 'info');
  };

  const handleSave = async () => {
    // Chạy kiểm tra lỗi cho tất cả các trường
    const newErrors: Record<string, string> = {};
    const checks = { stationName, plcPoll, dbSave, camRecord, healthCheck, email, phone };
    Object.entries(checks).forEach(([key, val]) => {
      const err = validateField(key, val);
      if (err) newErrors[key] = err;
    });

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      showToast('Vui lòng sửa các lỗi nhập liệu trước khi lưu!', 'error');
      return;
    }

    setSaveStatus('Đang lưu cấu hình...');
    try {
      await Promise.all([
        stationApi.updateSetting('plc_poll_interval_s', plcPoll),
        stationApi.updateSetting('db_save_interval_s', dbSave),
        stationApi.updateSetting('camera_record_duration_s', camRecord),
        stationApi.updateSetting('health_check_interval_s', healthCheck),
        stationApi.updateSetting('alert_email', email),
        stationApi.updateSetting('alert_phone', phone),
        stationApi.updateSetting('enable_alert_email', String(enableEmail)),
        stationApi.updateSetting('enable_alert_sms', String(enableSms)),
        stationApi.updateSetting('timezone', timezone),
        ...(stationId && stationName.trim() ? [stationApi.updateStation(stationId, stationName)] : [])
      ]);
      setSaveStatus('Đã lưu thành công');
      showToast('Cập nhật thông số hệ thống thành công!', 'success');
      setTimeout(() => setSaveStatus(''), 4000);
    } catch (e: any) {
      setSaveStatus(`Lỗi lưu trữ: ${e.message || e}`);
      showToast('Không thể lưu cài đặt chung xuống máy chủ', 'error');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <style>{`
        .preset-card {
          flex: 1;
          padding: 12px 16px;
          border-radius: 6px;
          border: 1px solid var(--admin-border);
          background: var(--admin-layer-1);
          cursor: pointer;
          transition: all 0.2s;
        }
        .preset-card:hover {
          border-color: var(--admin-accent);
          background: var(--admin-layer-2);
          transform: translateY(-2px);
        }
        .setting-section {
          background: var(--admin-card-bg);
          border: 1px solid var(--admin-border);
          border-radius: 6px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .section-header {
          font-size: 0.72rem;
          font-weight: 800;
          color: var(--admin-accent);
          text-transform: uppercase;
          letter-spacing: 0.6px;
          border-bottom: 1px solid var(--admin-border-light);
          padding-bottom: 8px;
          margin-bottom: 4px;
        }
        .err-label {
          color: var(--admin-danger);
          font-size: 0.7rem;
          margin-top: 4px;
          font-weight: 600;
        }
        .default-badge {
          background: var(--admin-layer-3);
          color: var(--admin-text-muted);
          font-size: 0.62rem;
          padding: 1px 5px;
          border-radius: 3px;
          font-weight: 700;
          margin-left: 8px;
        }
      `}</style>

      {/* Tiêu đề & Trạng thái tải */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800, color: 'var(--admin-text)' }}>CẤU HÌNH VẬN HÀNH</h2>
          <div style={{ fontSize: '0.75rem', color: 'var(--admin-text-muted)', marginTop: 2 }}>Điều chỉnh tốc độ cập nhật dữ liệu và thiết lập thông báo cho trạm</div>
        </div>
        {loading && <span style={{ fontSize: '0.7rem', color: 'var(--admin-accent)', fontWeight: 700 }}>ĐANG TẢI...</span>}
      </div>

      {/* ── CHỌN NHANH CHẾ ĐỘ ── */}
      <div className="setting-section" style={{ borderRadius: 0 }}>
        <div className="section-header">CHẾ ĐỘ VẬN HÀNH NHANH</div>
        <div style={{ display: 'flex', gap: 12 }}>
          
          <div className="preset-card" style={{ borderRadius: 0 }} onClick={() => applyPreset('standard')}>
            <div style={{ fontWeight: 800, fontSize: '0.75rem', color: 'var(--admin-text)', display: 'flex', justifyContent: 'space-between', textTransform: 'uppercase' }}>
              <span>Tiêu Chuẩn</span>
              <span style={{ fontSize: '0.6rem', border: '1px solid var(--admin-accent)', color: 'var(--admin-accent)', padding: '0 4px', borderRadius: 0 }}>KHUYÊN DÙNG</span>
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--admin-text-muted)', marginTop: 8 }}>
              Cân bằng giữa độ chính xác và tuổi thọ linh kiện. Phù hợp cho mọi trạm điện.
            </div>
          </div>

          <div className="preset-card" style={{ borderRadius: 0 }} onClick={() => applyPreset('high')}>
            <div style={{ fontWeight: 800, fontSize: '0.75rem', color: 'var(--admin-text)', display: 'flex', justifyContent: 'space-between', textTransform: 'uppercase' }}>
              <span>Ưu tiên tốc độ</span>
              <span style={{ fontSize: '0.6rem', border: '1px solid var(--admin-danger)', color: 'var(--admin-danger)', padding: '0 4px', borderRadius: 0 }}>PHẢN ỨNG NHANH</span>
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--admin-text-muted)', marginTop: 8 }}>
              Cập nhật dữ liệu liên tục. Dùng khi cần theo dõi sát sao một sự cố đang diễn ra.
            </div>
          </div>

          <div className="preset-card" style={{ borderRadius: 0 }} onClick={() => applyPreset('saver')}>
            <div style={{ fontWeight: 800, fontSize: '0.75rem', color: 'var(--admin-text)', display: 'flex', justifyContent: 'space-between', textTransform: 'uppercase' }}>
              <span>Ưu tiên bền bỉ</span>
              <span style={{ fontSize: '0.6rem', border: '1px solid var(--admin-success)', color: 'var(--admin-success)', padding: '0 4px', borderRadius: 0 }}>TIẾT KIỆM</span>
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--admin-text-muted)', marginTop: 8 }}>
              Giảm thiểu ghi chép để bảo vệ ổ cứng. Dùng cho các trạm hoạt động ổn định.
            </div>
          </div>

        </div>
      </div>

      {/* ── CẤU HÌNH CHI TIẾT ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        
        {/* Cột 1: Dữ liệu & Ghi hình */}
        <div className="setting-section" style={{ borderRadius: 0 }}>
          <div className="section-header">THÔNG TIN & DỮ LIỆU</div>

          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: 800, marginBottom: 6, textTransform: 'uppercase' }}>
              Tên Trạm / Dự án
            </label>
            <input 
              type="text" 
              className="form-input" 
              style={{ width: '100%', boxSizing: 'border-box', borderRadius: 0, borderColor: errors.stationName ? 'var(--admin-danger)' : 'var(--admin-border)' }}
              placeholder="Ví dụ: Trạm 110kV Long An" 
              value={stationName} 
              onChange={e => handleFieldChange('stationName', e.target.value, setStationName)} 
            />
            {errors.stationName && <div className="err-label">✕ {errors.stationName}</div>}
            <div className="hint-text">Tên trạm hiển thị trên tiêu đề và báo cáo.</div>
          </div>
          
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: 800, marginBottom: 6, textTransform: 'uppercase' }}>
              Tần suất đọc dữ liệu tủ điện (giây)
            </label>
            <input 
              type="number" 
              className="form-input" 
              style={{ width: '100%', boxSizing: 'border-box', borderRadius: 0, borderColor: errors.plcPoll ? 'var(--admin-danger)' : 'var(--admin-border)' }}
              min="1" max="60" value={plcPoll} 
              onChange={e => handleFieldChange('plcPoll', e.target.value, setPlcPoll)} 
            />
            {errors.plcPoll && <div className="err-label">✕ {errors.plcPoll}</div>}
            <div className="hint-text">Thời gian hệ thống hỏi dữ liệu mới từ các cảm biến tủ điện.</div>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: 800, marginBottom: 6, textTransform: 'uppercase' }}>
              Tần suất sao lưu vào bộ nhớ (giây)
            </label>
            <input 
              type="number" 
              className="form-input" 
              style={{ width: '100%', boxSizing: 'border-box', borderRadius: 0, borderColor: errors.dbSave ? 'var(--admin-danger)' : 'var(--admin-border)' }}
              min="5" max="3600" value={dbSave} 
              onChange={e => handleFieldChange('dbSave', e.target.value, setDbSave)} 
            />
            {errors.dbSave && <div className="err-label">✕ {errors.dbSave}</div>}
            <div className="hint-text">Càng lâu thì càng bảo vệ tốt ổ cứng của máy chủ trạm.</div>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: 800, marginBottom: 6, textTransform: 'uppercase' }}>
              Độ dài video bằng chứng (giây)
            </label>
            <input 
              type="number" 
              className="form-input" 
              style={{ width: '100%', boxSizing: 'border-box', borderRadius: 0, borderColor: errors.camRecord ? 'var(--admin-danger)' : 'var(--admin-border)' }}
              min="3" max="300" value={camRecord} 
              onChange={e => handleFieldChange('camRecord', e.target.value, setCamRecord)} 
            />
            {errors.camRecord && <div className="err-label">✕ {errors.camRecord}</div>}
            <div className="hint-text">Độ dài đoạn clip camera tự trích xuất khi có phóng điện hoặc quá nhiệt.</div>
          </div>
        </div>

        {/* Cột 2: Thông báo & Kết nối */}
        <div className="setting-section" style={{ borderRadius: 0 }}>
          <div className="section-header">THÔNG BÁO & KẾT NỐI</div>

          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: 800, marginBottom: 6, textTransform: 'uppercase' }}>
              Tần suất kiểm tra kết nối (giây)
            </label>
            <input 
              type="number" 
              className="form-input" 
              style={{ width: '100%', boxSizing: 'border-box', borderRadius: 0, borderColor: errors.healthCheck ? 'var(--admin-danger)' : 'var(--admin-border)' }}
              min="5" max="1800" value={healthCheck} 
              onChange={e => handleFieldChange('healthCheck', e.target.value, setHealthCheck)} 
            />
            {errors.healthCheck && <div className="err-label">✕ {errors.healthCheck}</div>}
            <div className="hint-text">Thời gian hệ thống tự động kiểm tra xem các thiết bị còn hoạt động không.</div>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: 800, marginBottom: 6, textTransform: 'uppercase' }}>
              Email nhận cảnh báo sự cố
            </label>
            <input 
              type="email" 
              className="form-input" 
              style={{ width: '100%', boxSizing: 'border-box', borderRadius: 0, borderColor: errors.email ? 'var(--admin-danger)' : 'var(--admin-border)' }}
              placeholder="nhan.thong.bao@congty.com" 
              value={email} 
              onChange={e => handleFieldChange('email', e.target.value, setEmail)} 
            />
            {errors.email && <div className="err-label">✕ {errors.email}</div>}
            <div className="hint-text">Hệ thống gửi thư báo ngay khi có sự cố Báo động đỏ xảy ra.</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer', marginTop: 4 }}>
              <input 
                type="checkbox" 
                checked={enableEmail} 
                onChange={e => setEnableEmail(e.target.checked)} 
                style={{ accentColor: 'var(--admin-accent)', cursor: 'pointer' }}
              />
              <span>Kích hoạt gửi thư cảnh báo (Email)</span>
            </label>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: 800, marginBottom: 6, textTransform: 'uppercase' }}>
              Số điện thoại nhận cảnh báo (SMS)
            </label>
            <input 
              type="text" 
              className="form-input" 
              style={{ width: '100%', boxSizing: 'border-box', borderRadius: 0, borderColor: errors.phone ? 'var(--admin-danger)' : 'var(--admin-border)' }}
              placeholder="e.g. 0912345678" 
              value={phone} 
              onChange={e => handleFieldChange('phone', e.target.value, setPhone)} 
            />
            {errors.phone && <div className="err-label">✕ {errors.phone}</div>}
            <div className="hint-text">Hệ thống gửi tin nhắn SMS khẩn cấp khi có sự cố nghiêm trọng xảy ra.</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer', marginTop: 4 }}>
              <input 
                type="checkbox" 
                checked={enableSms} 
                onChange={e => setEnableSms(e.target.checked)} 
                style={{ accentColor: 'var(--admin-accent)', cursor: 'pointer' }}
              />
              <span>Kích hoạt gửi tin nhắn cảnh báo (SMS)</span>
            </label>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ display: 'block', fontSize: '0.65rem', fontWeight: 800, marginBottom: 6, textTransform: 'uppercase' }}>
              Giờ hệ thống
            </label>
            <select 
              className="form-select" 
              style={{ width: '100%', borderRadius: 0 }}
              value={timezone} 
              onChange={e => setTimezone(e.target.value)}
            >
              <option value="Asia/Ho_Chi_Minh">Việt Nam (GMT+07:00)</option>
              <option value="UTC">Giờ Quốc Tế (UTC+00:00)</option>
            </select>
            <div className="hint-text">Đảm bảo thời gian trên biểu đồ khớp với đồng hồ thực tế.</div>
          </div>

        </div>

      </div>

      {/* ── FOOTER THAO TÁC ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--admin-layer-1)', border: '1px solid var(--admin-border)', padding: '12px 16px', borderRadius: 0 }}>
        <div>
          <button className="btn-industrial" style={{ background: 'var(--admin-layer-3)', marginRight: 8, borderRadius: 0, fontSize: '.7rem' }} onClick={resetToFactoryDefaults}>
            CÀI LẠI MẶC ĐỊNH
          </button>
          <button className="btn-industrial" style={{ background: 'var(--admin-layer-2)', borderRadius: 0, fontSize: '.7rem' }} onClick={loadSettings}>
            TẢI LẠI DỮ LIỆU
          </button>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {saveStatus && (
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: saveStatus.includes('Lỗi') ? 'var(--admin-danger)' : 'var(--admin-success)' }}>
              {saveStatus.toUpperCase()}
            </span>
          )}
          <button 
            className="btn-industrial btn-primary" 
            style={{ padding: '8px 24px', fontSize: '0.72rem', fontWeight: 800, textTransform: 'uppercase', borderRadius: 0 }} 
            onClick={handleSave}
            disabled={Object.keys(errors).length > 0}
          >
            LƯU THAY ĐỔI
          </button>
        </div>
      </div>
    </div>
  );
}
