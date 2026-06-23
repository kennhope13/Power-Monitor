import { useState, useEffect, useMemo } from 'react';
import { stationApi, MaintenanceTask, Device } from '@/services/StationApiService';
import { useStationStore, useDeviceStore } from '@/store';
import { Edit2 } from 'lucide-react';
import { authService } from '@/services/AuthService';

const DEFAULT_CHECKLIST: Record<string, string[]> = {
  inspection: ['Kiểm tra tổng quan', 'Đo nhiệt độ', 'Kiểm tra cách điện', 'Ghi nhật ký'],
  repair: ['Xác định hỏng hóc', 'Chuẩn bị phụ tùng', 'Sửa chữa', 'Kiểm tra lại', 'Ghi nhật ký'],
  cleaning: ['Vệ sinh bề mặt', 'Vệ sinh cách điện', 'Vệ sinh buồng điện', 'Kiểm tra sau vệ sinh'],
  calibration: ['Kiểm tra thiết bị đo', 'Hiệu chỉnh', 'Ghi kết quả', 'Dán tem kiểm định'],
  other: ['Mô tả công việc', 'Kiểm tra kết quả', 'Ghi nhật ký'],
};

const TYPE_LABELS: Record<string, string> = {
  inspection: 'Kiểm tra',
  repair: 'Sửa chữa',
  cleaning: 'Vệ sinh',
  calibration: 'Hiệu chỉnh',
  other: 'Khác',
};

const STATUS_COLORS: Record<string, string> = {
  pending: 'var(--admin-warning)',
  in_progress: 'var(--admin-accent)',
  completed: 'var(--admin-success)',
  overdue: 'var(--admin-danger)',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Đang chờ',
  in_progress: 'Đang làm',
  completed: 'Hoàn thành',
  overdue: 'Quá hạn',
};

const FILTERS = [
  { f: 'all', lbl: 'Tất cả' },
  { f: 'pending', lbl: 'Đang chờ' },
  { f: 'in_progress', lbl: 'Đang làm' },
  { f: 'overdue', lbl: 'Quá hạn' },
  { f: 'completed', lbl: 'Hoàn thành' },
];

interface ChecklistItem { item: string; done: boolean; }

/**
 * Trang quản lý lịch bảo trì thiết bị: hiển thị danh sách công việc
 * dạng bảng, hỗ trợ lọc theo trạng thái và tạo/chỉnh sửa qua modal.
 */
export default function MaintenancePage() {
  const [stationId, setStationId] = useState('');
  const [tasks, setTasks] = useState<MaintenanceTask[]>([]);
  const [filter, setFilter] = useState('all');

  const canManageMaintenance = useMemo(() => {
    // Trạm con không được phép tự tạo/sửa/xóa lịch bảo trì (chỉ đồng bộ từ trạm tổng)
    return false;
  }, []);

  const getFirstStationId = useStationStore(s => s.getFirstStationId);
  const fetchDevices = useDeviceStore(s => s.fetch);
  const devicesByStation = useDeviceStore(s => s.devicesByStation);
  const devices: Device[] = useMemo(
    () => stationId ? (devicesByStation[stationId] ?? []) : [],
    [stationId, devicesByStation]
  );

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mDevice, setMDevice] = useState('');
  const [mType, setMType] = useState('inspection');
  const [mTitle, setMTitle] = useState('');
  const [mDate, setMDate] = useState('');
  const [mAssign, setMAssign] = useState('');
  const [mNotes, setMNotes] = useState('');
  const [mChecklist, setMChecklist] = useState<ChecklistItem[]>([]);
  const [mSendEmail, setMSendEmail] = useState(false);

  /** Tải danh sách công việc bảo trì và danh sách thiết bị của trạm. */
  const loadData = async (sid: string) => {
    try {
      const t = await stationApi.getMaintenance(sid || undefined);
      setTasks(t);
      if (sid) fetchDevices(sid);
    } catch { setTasks([]); }
  };

  useEffect(() => {
    getFirstStationId().then(id => { if (id) { setStationId(id); loadData(id); } });
  }, [getFirstStationId]);

  /**
   * Mở modal tạo mới hoặc chỉnh sửa công việc bảo trì.
   * Nếu truyền task vào thì điền sẵn form với dữ liệu task đó.
   */
  const openModal = (task?: MaintenanceTask) => {
    if (task) {
      setEditingId(task.id);
      setMDevice(task.deviceId || '');
      setMType(task.type);
      setMTitle(task.title);
      setMDate(task.scheduledDate ? task.scheduledDate.substring(0, 10) : '');
      setMAssign(task.assignedTo || '');
      setMNotes(task.notes || '');
      try { setMChecklist(JSON.parse(task.checklist || '[]')); } catch { setMChecklist([]); }
    } else {
      setEditingId(null);
      setMDevice('');
      setMType('inspection');
      setMTitle('');
      setMDate(new Date().toISOString().substring(0, 10));
      setMAssign('');
      setMNotes('');
      setMChecklist((DEFAULT_CHECKLIST['inspection'] ?? []).map(item => ({ item, done: false })));
    }
    setMSendEmail(false);
    setModalOpen(true);
  };

  /**
   * Cập nhật loại bảo trì và tự động nạp checklist mặc định
   * cho loại đó nếu đang tạo mới (không phải chỉnh sửa).
   */
  const handleTypeChange = (type: string) => {
    setMType(type);
    // Chỉ reset checklist khi tạo mới — giữ nguyên khi sửa
    if (!editingId) setMChecklist((DEFAULT_CHECKLIST[type] ?? []).map(item => ({ item, done: false })));
  };

  /** Lưu công việc bảo trì (tạo mới hoặc cập nhật) rồi đóng modal và làm mới danh sách. */
  const saveModal = async () => {
    const payload = {
      stationId,
      deviceId: mDevice || null,
      title: mTitle,
      type: mType,
      scheduledDate: new Date(mDate).toISOString(),
      assignedTo: mAssign,
      notes: mNotes,
      checklist: JSON.stringify(mChecklist),
      sendEmail: mSendEmail,
    };
    try {
      if (editingId) await stationApi.updateMaintenance(editingId, payload);
      else await stationApi.createMaintenance(payload as any);
      setModalOpen(false);
      loadData(stationId);
    } catch (e: any) { alert(`Lỗi: ${e.message}`); }
  };

  // Lọc danh sách theo tab trạng thái đang chọn
  const filteredTasks = filter === 'all' ? tasks : tasks.filter(t => t.status === filter);

  /** Đếm số công việc theo từng trạng thái để hiển thị badge trên tab lọc. */
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: tasks.length };
    tasks.forEach(t => { c[t.status] = (c[t.status] || 0) + 1; });
    return c;
  }, [tasks]);

  return (
    <div className="admin-page-container">

      {/* Toolbar — khớp pattern với các trang khác */}
      <div className="page-toolbar-row">
        <div className="page-title-cell">
          <h2>LỊCH BẢO TRÌ</h2>
        </div>

        <div className="page-toolbar-group">
          {/* Filter tabs */}
          <div className="page-toolbar-cell" style={{ gap: 0, padding: '0 4px', height: 28 }}>
            <span className="page-cell-label" style={{ marginRight: 6 }}>LỌC:</span>
            {FILTERS.map(({ f, lbl }) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  background: filter === f ? 'var(--admin-accent)' : 'transparent',
                  border: 'none',
                  borderRadius: 3,
                  color: filter === f ? 'var(--admin-text-on-accent)' : 'var(--admin-text-muted)',
                  fontWeight: 700,
                  fontSize: '.65rem',
                  padding: '2px 8px',
                  cursor: 'pointer',
                  height: 20,
                  whiteSpace: 'nowrap',
                }}
              >
                {lbl}{counts[f] ? ` (${counts[f]})` : ''}
              </button>
            ))}
          </div>

          {canManageMaintenance && (
            <button
              className="btn-industrial btn-primary"
              style={{ height: 32, padding: '0 12px', fontSize: '.75rem', fontWeight: 700 }}
              onClick={() => openModal()}
            >
              + TẠO LỊCH MỚI
            </button>
          )}

          <button
            className="btn-industrial"
            style={{ height: 32, padding: '0 10px', fontSize: '.75rem', fontWeight: 700 }}
            onClick={() => loadData(stationId)}
          >
            ↺ LÀM MỚI
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="admin-card" style={{ padding: 0, overflow: 'hidden', marginTop: 12 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>TIÊU ĐỀ</th>
              <th>THIẾT BỊ</th>
              <th>LOẠI</th>
              <th>NGÀY DỰ KIẾN</th>
              <th>GIAO CHO</th>
              <th>TRẠNG THÁI</th>
              {canManageMaintenance && <th style={{ width: 60 }}>SỬA</th>}
            </tr>
          </thead>
          <tbody>
            {filteredTasks.length === 0 ? (
              <tr>
                <td colSpan={canManageMaintenance ? 7 : 6} style={{ textAlign: 'center', padding: 40, color: 'var(--admin-text-muted)' }}>
                  Không có dữ liệu
                </td>
              </tr>
            ) : (
              filteredTasks.map(t => (
                <tr key={t.id}>
                  <td style={{ fontWeight: 600 }}>{t.title}</td>
                  <td>{t.deviceName || '—'}</td>
                  <td>{TYPE_LABELS[t.type] || t.type}</td>
                  <td>{t.scheduledDate?.substring(0, 10)}</td>
                  <td>{t.assignedTo || '—'}</td>
                  <td>
                    <span className="tag" style={{ color: STATUS_COLORS[t.status], background: `${STATUS_COLORS[t.status]}18`, border: `1px solid ${STATUS_COLORS[t.status]}40` }}>
                      {STATUS_LABELS[t.status]}
                    </span>
                  </td>
                  {canManageMaintenance && (
                    <td>
                      <button
                        onClick={() => openModal(t)}
                        title="Sửa"
                        style={{ background: 'transparent', border: 'none', padding: 6, borderRadius: '50%', color: 'var(--admin-text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--admin-accent)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--admin-text-muted)'}
                      >
                        <Edit2 size={15} />
                      </button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      {modalOpen && (
        <div className="modal-overlay active">
          <div className="modal-content" style={{ width: 620, background: 'var(--admin-panel)', borderRadius: 8, border: '1px solid var(--admin-border)', padding: 0 }}>
            <div className="modal-header" style={{ padding: '16px 20px', borderBottom: '1px solid var(--admin-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: '.85rem', fontWeight: 800, letterSpacing: '.5px' }}>
                {editingId ? 'SỬA LỊCH BẢO TRÌ' : 'TẠO LỊCH BẢO TRÌ MỚI'}
              </h3>
              <button onClick={() => setModalOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1.1rem', color: 'var(--admin-text-muted)', lineHeight: 1 }}>✕</button>
            </div>

            <div className="modal-body" style={{ padding: 20 }}>
              <div className="form-grid-2">
                <div className="form-group">
                  <label style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--admin-text-muted)' }}>THIẾT BỊ</label>
                  <select className="form-select" style={{ background: 'var(--admin-layer-2)' }} value={mDevice} onChange={e => setMDevice(e.target.value)}>
                    <option value="">-- Không chọn --</option>
                    {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--admin-text-muted)' }}>LOẠI BẢO TRÌ</label>
                  <select className="form-select" style={{ background: 'var(--admin-layer-2)' }} value={mType} onChange={e => handleTypeChange(e.target.value)}>
                    <option value="inspection">Kiểm tra</option>
                    <option value="repair">Sửa chữa</option>
                    <option value="cleaning">Vệ sinh</option>
                    <option value="calibration">Hiệu chỉnh</option>
                    <option value="other">Khác</option>
                  </select>
                </div>
                <div className="form-group" style={{ gridColumn: '1/-1' }}>
                  <label style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--admin-text-muted)' }}>TIÊU ĐỀ *</label>
                  <input type="text" className="form-input" style={{ background: 'var(--admin-layer-2)' }} value={mTitle} onChange={e => setMTitle(e.target.value)} placeholder="Vd: Kiểm tra MBA chính" />
                </div>
                <div className="form-group">
                  <label style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--admin-text-muted)' }}>NGÀY DỰ KIẾN *</label>
                  <input type="date" className="form-input" style={{ background: 'var(--admin-layer-2)' }} value={mDate} onChange={e => setMDate(e.target.value)} />
                </div>
                <div className="form-group">
                  <label style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--admin-text-muted)' }}>GIAO CHO</label>
                  <input type="text" className="form-input" style={{ background: 'var(--admin-layer-2)' }} value={mAssign} onChange={e => setMAssign(e.target.value)} placeholder="Tên kỹ thuật viên / email..." />
                </div>
                <div className="form-group" style={{ gridColumn: '1/-1', display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <input 
                    type="checkbox" 
                    id="mSendEmail" 
                    checked={mSendEmail} 
                    onChange={e => setMSendEmail(e.target.checked)} 
                    style={{ accentColor: 'var(--admin-accent)', cursor: 'pointer', width: 14, height: 14 }} 
                  />
                  <label htmlFor="mSendEmail" style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--admin-text)', cursor: 'pointer', userSelect: 'none' }}>
                    GỬI THÔNG BÁO QUA EMAIL CHO KỸ SƯ (CMMS)
                  </label>
                </div>
              </div>

              <div className="form-group">
                <label style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--admin-text-muted)' }}>GHI CHÚ</label>
                <textarea rows={2} className="form-input" style={{ background: 'var(--admin-layer-2)', resize: 'vertical' }} value={mNotes} onChange={e => setMNotes(e.target.value)} placeholder="Mô tả công việc..." />
              </div>

              <div className="form-group">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <label style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--admin-text-muted)' }}>CHECKLIST</label>
                  <button className="btn-industrial btn-sm" onClick={() => setMChecklist([...mChecklist, { item: '', done: false }])}>+ Thêm mục</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {mChecklist.map((c, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--admin-layer-2)', border: '1px solid var(--admin-border)', padding: '5px 10px', borderRadius: 4 }}>
                      <input type="checkbox" checked={c.done} onChange={e => { const nc = [...mChecklist]; nc[i]!.done = e.target.checked; setMChecklist(nc); }} style={{ accentColor: 'var(--admin-success)', cursor: 'pointer' }} />
                      <input type="text" value={c.item} onChange={e => { const nc = [...mChecklist]; nc[i]!.item = e.target.value; setMChecklist(nc); }} placeholder="Nội dung mục..." style={{ flex: 1, background: 'transparent', border: 'none', color: 'var(--admin-text)', fontSize: '.8rem', outline: 'none' }} />
                      <button onClick={() => setMChecklist(mChecklist.filter((_, idx) => idx !== i))} style={{ background: 'none', border: 'none', color: 'var(--admin-text-muted)', cursor: 'pointer', fontSize: '.85rem', lineHeight: 1 }}>✕</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="modal-footer" style={{ padding: '14px 20px', borderTop: '1px solid var(--admin-border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn-industrial" onClick={() => setModalOpen(false)}>Hủy</button>
              <button className="btn-industrial btn-primary" onClick={saveModal}>Lưu</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
