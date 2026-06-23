// ============================================================
// UserManagementPage.tsx — Quản lý tài khoản người dùng
// Vai trò: operator (xem + ack) | manager (+ báo cáo) | admin (toàn quyền)
// Chức năng: thêm/sửa tài khoản, đổi mật khẩu, vô hiệu hóa, phân quyền trạm
// ============================================================

import { useState, useEffect, useMemo } from 'react';
import { stationApi, UserItem, Station } from '@/services/StationApiService';
import { confirmDialog } from '@/utils/confirm';
import { authService } from '@/services/AuthService';

interface UserManagementPageProps {
  embeddedMode?: 'default' | 'central';
}

export default function UserManagementPage({ embeddedMode = 'default' }: UserManagementPageProps) {
  const currentUser = authService.getUser();
  const isRestrictedAdmin = currentUser?.station_ids && currentUser.station_ids.length > 0;

  const [users, setUsers] = useState<UserItem[]>([]);
  const [stationsList, setStationsList] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStationId, setFilterStationId] = useState('');

  // Modals state
  const [isUserModalOpen, setIsUserModalOpen] = useState(false);
  const [isPwModalOpen, setIsPwModalOpen] = useState(false);
  
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [showPermissions, setShowPermissions] = useState(false);
  const [showDefaultAccounts, setShowDefaultAccounts] = useState(false);
  
  // Form State
  const [formData, setFormData] = useState({
    username: '', fullName: '', email: '',
    password: '', confirmPassword: '',
    role: 'operator', isActive: true,
    stationIds: [] as string[]
  });
  
  // Password change state
  const [pwData, setPwData] = useState({ newPassword: '', confirmPassword: '' });

  useEffect(() => {
    loadUsers();
    loadStations();
  }, []);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const data = await stationApi.getUsers();
      setUsers(data);
    } catch (e) {
      console.error('Lỗi tải danh sách người dùng:', e);
      alert('Lỗi tải danh sách người dùng');
    } finally {
      setLoading(false);
    }
  };

  const loadStations = async () => {
    try {
      const data = await stationApi.getStations();
      setStationsList(data);
    } catch (e) {
      console.error('Lỗi tải danh sách trạm:', e);
    }
  };

  const openAddModal = () => {
    setEditingUserId(null);
    setFormData({
      username: '', fullName: '', email: '',
      password: '', confirmPassword: '',
      role: 'operator', isActive: true,
      stationIds: []
    });
    setIsUserModalOpen(true);
  };

  const openEditModal = (u: UserItem) => {
    setEditingUserId(u.id);
    setFormData({
      username: u.username, fullName: u.fullName || '', email: u.email || '',
      password: '', confirmPassword: '',
      role: u.role, isActive: u.isActive,
      stationIds: u.stationIds || []
    });
    setIsUserModalOpen(true);
  };

  const openPwModal = (id: string) => {
    setEditingUserId(id);
    setPwData({ newPassword: '', confirmPassword: '' });
    setIsPwModalOpen(true);
  };

  const saveUser = async () => {
    const { username, fullName, email, password, confirmPassword, role, isActive, stationIds } = formData;
    
    if (editingUserId) {
      // Edit mode
      try {
        await stationApi.updateUser(editingUserId, { fullName, email, role, isActive, stationIds });
        alert('Cập nhật tài khoản thành công');
        setIsUserModalOpen(false);
        loadUsers();
      } catch (e: any) {
        alert(`Lỗi: ${e.message}`);
      }
    } else {
      // Add mode
      if (!username) { alert('Vui lòng nhập tên đăng nhập'); return; }
      if (password !== confirmPassword) { alert('Mật khẩu xác nhận không khớp'); return; }
      if (password.length < 6) { alert('Mật khẩu phải ít nhất 6 ký tự'); return; }

      try {
        await stationApi.createUser({ username, password, fullName, email, role, stationIds });
        alert(`Đã thêm tài khoản "${username}" thành công`);
        setIsUserModalOpen(false);
        loadUsers();
      } catch (e: any) {
        alert(`Lỗi: ${e.message}`);
      }
    }
  };

  const changePassword = async () => {
    if (!editingUserId) return;
    if (pwData.newPassword !== pwData.confirmPassword) { alert('Mật khẩu xác nhận không khớp'); return; }
    if (pwData.newPassword.length < 6) { alert('Mật khẩu phải ít nhất 6 ký tự'); return; }

    try {
      await stationApi.changePassword(editingUserId, { newPassword: pwData.newPassword });
      alert('Đổi mật khẩu thành công');
      setIsPwModalOpen(false);
    } catch (e: any) {
      alert(`Lỗi: ${e.message}`);
    }
  };

  const deactivateUser = async (u: UserItem) => {
    if (!await confirmDialog({ title: 'Vô hiệu hóa tài khoản', message: `Vô hiệu hóa tài khoản "${u.username}"?`, confirmText: 'Vô hiệu hóa', danger: true })) return;
    try {
      await stationApi.deactivateUser(u.id);
      alert(`Đã vô hiệu hóa tài khoản "${u.username}"`);
      loadUsers();
    } catch (e: any) {
      alert(`Lỗi: ${e.message}`);
    }
  };

  const getAssignedStationsText = (u: UserItem) => {
    if (u.stationIds && u.stationIds.length > 0) {
      const names = u.stationIds
        .map(id => stationsList.find(s => s.id === id)?.name || id.slice(0, 8))
        .join(', ');
      return names;
    }
    if (u.role === 'admin' || u.role === 'manager') {
      return 'Tất cả trạm';
    }
    return 'Tất cả trạm (mặc định)';
  };

  const filteredUsers = useMemo(() => {
    if (!filterStationId) return users;
    return users.filter(u => (u.stationIds ?? []).includes(filterStationId));
  }, [users, filterStationId]);

  const scopedSummary = useMemo(() => {
    const list = filteredUsers;
    return {
      total: list.length,
      active: list.filter(u => u.isActive).length,
      admins: list.filter(u => u.role === 'admin').length,
    };
  }, [filteredUsers]);

  return (
    <div className="admin-page-container">
      
      {embeddedMode === 'central' && (
        <div style={{ padding: '12px 12px 0 12px' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.3fr repeat(3, minmax(120px, 1fr))',
              gap: 16,
            }}
          >
            <div className="admin-card" style={{ background: 'linear-gradient(135deg, rgba(14,165,233,0.18), rgba(15,23,42,0.92))', padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontSize: '.65rem', fontWeight: 900, letterSpacing: '0.08em', color: 'var(--admin-accent)' }}>
                    QUẢN LÝ TÀI KHOẢN NGƯỜI DÙNG
                  </div>
                  <div style={{ marginTop: 6, fontSize: '1.2rem', fontWeight: 800, color: 'var(--admin-text)' }}>
                    {filterStationId ? (stationsList.find(s => s.id === filterStationId)?.name || 'Không rõ trạm') : 'Toàn mạng lưới'}
                  </div>
                  <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '.68rem', color: 'var(--admin-text-muted)' }}>
                      Phạm vi: <b style={{ color: 'var(--admin-text)' }}>{filterStationId ? 'Theo trạm' : 'Tất cả trạm'}</b>
                    </span>
                  </div>
                </div>
                <div style={{ minWidth: 220 }}>
                  <div style={{ fontSize: '.62rem', fontWeight: 800, color: 'var(--admin-text-muted)', marginBottom: 6 }}>LỌC NGƯỜI DÙNG THEO TRẠM</div>
                  <select
                    value={filterStationId}
                    onChange={e => setFilterStationId(e.target.value)}
                    style={{
                      width: '100%',
                      background: 'rgba(15,23,42,0.65)',
                      border: '1px solid var(--admin-accent)',
                      color: 'var(--admin-text)',
                      padding: '8px 10px',
                      fontSize: '.74rem',
                      fontWeight: 700,
                      outline: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    <option value="">Tất cả các trạm</option>
                    {stationsList.map(s => (
                      <option key={s.id} value={s.id}>
                        {(s.code ? `${s.code} - ` : '') + s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {[
              { label: 'Tổng tài khoản', value: scopedSummary.total, color: 'var(--admin-text)' },
              { label: 'Đang hoạt động', value: scopedSummary.active, color: 'var(--admin-success)' },
              { label: 'Tài khoản admin', value: scopedSummary.admins, color: 'var(--admin-accent)' },
            ].map(card => (
              <div key={card.label} className="admin-card" style={{ padding: 16 }}>
                <div style={{ fontSize: '.68rem', fontWeight: 800, color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{card.label}</div>
                <div style={{ marginTop: 10, fontSize: '1.8rem', fontWeight: 900, color: card.color }}>{card.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="page-toolbar-row" style={{ marginTop: embeddedMode === 'central' ? 12 : 0 }}>
        <div className="page-title-cell">
          {embeddedMode !== 'central' && <h2>NGƯỜI DÙNG</h2>}
        </div>
        <div className="page-toolbar-group">
          <button 
            className="btn-industrial btn-primary" 
            style={{ height: 32, padding: '0 16px', fontSize: '.75rem', fontWeight: 800 }}
            onClick={openAddModal}
          >
            + THÊM TÀI KHOẢN
          </button>
        </div>
      </div>
      
      <div className="admin-card" style={{ padding: 0, overflow: 'auto', flex: 1, marginTop: 12 }}>
          <table className="data-table">
            <thead style={{ position: 'sticky', top: 0, zIndex: 10 }}>
              <tr>
                <th>Họ tên & Phân quyền trạm</th>
                <th>Tên đăng nhập</th>
                <th>Email</th>
                <th>Vai trò</th>
                <th style={{ textAlign: 'center' }}>Trạng thái</th>
                <th style={{ textAlign: 'center' }}>Hành động</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--admin-text-muted)', padding: 40 }}>⏳ Đang tải...</td></tr>
              ) : filteredUsers.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--admin-text-muted)', padding: 40 }}>
                  {filterStationId ? 'Không có người dùng nào thuộc trạm đã chọn' : 'Chưa có người dùng nào'}
                </td></tr>
              ) : (
                filteredUsers.map(u => {
                  const roleColor = u.role === 'admin' ? 'var(--admin-danger)' : u.role === 'manager' ? '#f59e0b' : 'var(--admin-success)';
                  const roleLabel = u.role === 'admin' ? 'Quản trị' : u.role === 'manager' ? 'Quản lý' : 'Vận hành';
                  return (
                    <tr key={u.id}>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <b style={{ fontSize: '.75rem' }}>{u.fullName || '—'}</b>
                          <span style={{ fontSize: '.6rem', color: 'var(--admin-text-muted)', marginTop: 4 }}>
                            📍 {getAssignedStationsText(u)}
                          </span>
                        </div>
                      </td>
                      <td><code style={{ background: 'var(--admin-layer-2)', padding: '2px 6px', borderRadius: 4, fontSize: '.7rem' }}>{u.username}</code></td>
                      <td style={{ fontSize: '.75rem' }}>{u.email || '—'}</td>
                      <td>
                        <span style={{ 
                           color: roleColor, fontSize: '.75rem', fontWeight: 700 
                        }}>{roleLabel}</span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span className="status-dot" style={{ background: u.isActive ? 'var(--admin-success)' : 'var(--admin-danger)', marginRight: 0 }}></span>
                          <span style={{ fontSize: '.75rem' }}>{u.isActive ? 'Hoạt động' : 'Vô hiệu'}</span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                          <button className="btn-industrial btn-sm" onClick={() => openEditModal(u)} title="Sửa thông tin" style={{ fontSize: '.65rem' }}>Sửa</button>
                          <button className="btn-industrial btn-sm" onClick={() => openPwModal(u.id)} title="Đổi mật khẩu">Đổi MK</button>
                          {u.isActive && <button className="btn-industrial btn-sm btn-danger" onClick={() => deactivateUser(u)} title="Vô hiệu hóa">Vô hiệu</button>}
                        </div>
                      </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="admin-card" style={{ padding: '12px 20px', marginTop: 12 }}>
        <div 
          style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center', 
            cursor: 'pointer',
            userSelect: 'none'
          }}
          onClick={() => setShowPermissions(!showPermissions)}
        >
          <div style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--admin-text)', textTransform: 'uppercase', fontFamily: 'Consolas, monospace', letterSpacing: '0.5px' }}>
            BẢNG PHÂN QUYỀN HỆ THỐNG {showPermissions ? '▼' : '►'}
          </div>
          <span style={{ fontSize: '0.7rem', color: 'var(--admin-accent)', fontWeight: 800 }}>
            {showPermissions ? 'THU GỌN' : 'HIỂN THỊ CHI TIẾT'}
          </span>
        </div>
        
        {showPermissions && (
          <table className="data-table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Tính năng</th>
                <th style={{ textAlign: 'center' }}>Operator</th>
                <th style={{ textAlign: 'center' }}>Manager</th>
                <th style={{ textAlign: 'center' }}>Admin</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Xem Dashboard', '✓', '✓', '✓'],
                ['Acknowledge Alarm', '✓', '✓', '✓'],
                ['Xem báo cáo', '✓', '✓', '✓'],
                ['Tạo & Gửi báo cáo', '—', '✓', '✓'],
                ['Cấu hình ngưỡng', '—', '—', '✓'],
                ['Quản lý thiết bị', '—', '—', '✓'],
                ['Quản lý người dùng', '—', '—', '✓'],
                ['Xem Audit Log', '—', '✓', '✓'],
                ['Cài đặt hệ thống', '—', '—', '✓'],
              ].map((row, i) => (
                <tr key={i}>
                  <td>{row[0]}</td>
                  <td style={{ textAlign: 'center', color: row[1] === '✓' ? 'var(--admin-success)' : 'var(--admin-text-muted)', fontWeight: row[1] === '✓' ? 'bold' : 'normal' }}>{row[1]}</td>
                  <td style={{ textAlign: 'center', color: row[2] === '✓' ? 'var(--admin-success)' : 'var(--admin-text-muted)', fontWeight: row[2] === '✓' ? 'bold' : 'normal' }}>{row[2]}</td>
                  <td style={{ textAlign: 'center', color: row[3] === '✓' ? 'var(--admin-success)' : 'var(--admin-text-muted)', fontWeight: row[3] === '✓' ? 'bold' : 'normal' }}>{row[3]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="admin-card" style={{ padding: '12px 20px', marginTop: 12 }}>
        <div 
          style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center', 
            cursor: 'pointer',
            userSelect: 'none'
          }}
          onClick={() => setShowDefaultAccounts(!showDefaultAccounts)}
        >
          <div style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--admin-text)', textTransform: 'uppercase', fontFamily: 'Consolas, monospace', letterSpacing: '0.5px' }}>
            3 BẢNG PHÂN QUYỀN CHI TIẾT CÁC TÀI KHOẢN MẶC ĐỊNH {showDefaultAccounts ? '▼' : '►'}
          </div>
          <span style={{ fontSize: '0.7rem', color: 'var(--admin-accent)', fontWeight: 800 }}>
            {showDefaultAccounts ? 'THU GỌN' : 'HIỂN THỊ CHI TIẾT'}
          </span>
        </div>
        
        {showDefaultAccounts && (
          <div style={{ marginTop: 12, overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '18%' }}>Cấp Quản Lý</th>
                  <th style={{ width: '12%' }}>Tài Khoản</th>
                  <th style={{ width: '12%' }}>Mật Khẩu</th>
                  <th style={{ width: '23%' }}>Phạm Vi</th>
                  <th style={{ width: '35%' }}>Chức Năng Cho Phép</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><b style={{ color: 'var(--admin-danger)', fontSize: '.75rem' }}>Admin Toàn Cục</b></td>
                  <td><code style={{ background: 'var(--admin-layer-2)', padding: '2px 6px', borderRadius: 4, fontSize: '.7rem' }}>multi</code></td>
                  <td><code style={{ background: 'var(--admin-layer-2)', padding: '2px 6px', borderRadius: 4, fontSize: '.7rem' }}>Demo@2024</code></td>
                  <td style={{ fontSize: '.75rem' }}>Toàn bộ hệ thống (Không giới hạn Tỉnh/Trạm).</td>
                  <td>
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: '.72rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <li>Thêm, sửa, xóa các Tỉnh trong hệ thống.</li>
                      <li>Thêm mới, kết nối, gỡ bỏ Trạm Con khỏi Tỉnh.</li>
                      <li>Tạo mới, phân quyền Admin cấp dưới (provinceadmin, teamleader, stationadmin).</li>
                      <li>Kích hoạt, quản lý Giftcode bản quyền toàn cục.</li>
                      <li>Giám sát camera trực tiếp, biểu đồ đo đạc, xem cảnh báo toàn hệ thống.</li>
                      <li>Điều khiển thiết bị từ xa tại bất kỳ trạm nào.</li>
                    </ul>
                  </td>
                </tr>
                <tr>
                  <td><b style={{ color: '#f59e0b', fontSize: '.75rem' }}>Admin Tỉnh</b></td>
                  <td><code style={{ background: 'var(--admin-layer-2)', padding: '2px 6px', borderRadius: 4, fontSize: '.7rem' }}>provinceadmin</code></td>
                  <td><code style={{ background: 'var(--admin-layer-2)', padding: '2px 6px', borderRadius: 4, fontSize: '.7rem' }}>Province@123</code></td>
                  <td style={{ fontSize: '.75rem' }}>Chỉ trong Tỉnh được gán (Tây Ninh, Long An...).</td>
                  <td>
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: '.72rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <li>Quản lý danh sách các Trạm Con và Tổ thao tác trực thuộc tỉnh phụ trách.</li>
                      <li>Tạo tài khoản cấp dưới (Tổ trưởng, Admin Trạm, Nhân viên) trong tỉnh.</li>
                      <li>Kích hoạt, gia hạn Giftcode bản quyền cho các Trạm Con thuộc tỉnh.</li>
                      <li>Xem camera, bản đồ số, trạng thái thiết bị và báo cáo tổng hợp thuộc tỉnh.</li>
                    </ul>
                  </td>
                </tr>
                <tr>
                  <td><b style={{ color: 'var(--admin-success)', fontSize: '.75rem' }}>Tổ trưởng Tổ thao tác</b></td>
                  <td><code style={{ background: 'var(--admin-layer-2)', padding: '2px 6px', borderRadius: 4, fontSize: '.7rem' }}>teamleader</code></td>
                  <td><code style={{ background: 'var(--admin-layer-2)', padding: '2px 6px', borderRadius: 4, fontSize: '.7rem' }}>TeamLeader@123</code></td>
                  <td style={{ fontSize: '.75rem' }}>Các trạm do Tổ thao tác phụ trách.</td>
                  <td>
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: '.72rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <li>Giám sát thời gian thực các trạm biến áp được phân công.</li>
                      <li>Theo dõi camera trực tiếp, tiếp nhận cảnh báo khẩn cấp tại hiện trường.</li>
                      <li>Điều khiển thiết bị ngoại vi (còi, đèn, camera PTZ) khi xử lý sự cố.</li>
                      <li>Xem lịch sử sự cố và xuất báo cáo vận hành thuộc tổ.</li>
                    </ul>
                  </td>
                </tr>
                <tr>
                  <td><b style={{ color: 'var(--admin-accent)', fontSize: '.75rem' }}>Admin Trạm</b></td>
                  <td><code style={{ background: 'var(--admin-layer-2)', padding: '2px 6px', borderRadius: 4, fontSize: '.7rem' }}>stationadmin</code></td>
                  <td><code style={{ background: 'var(--admin-layer-2)', padding: '2px 6px', borderRadius: 4, fontSize: '.7rem' }}>Station@123</code></td>
                  <td style={{ fontSize: '.75rem' }}>Chỉ trong Trạm con được gán.</td>
                  <td>
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: '.72rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <li>Cấu hình camera, cảm biến nhiệt độ, cảm biến PD cục bộ tại trạm con.</li>
                      <li>Thiết lập ngưỡng luật cảnh báo tự động (nhiệt độ, xâm nhập) tại trạm.</li>
                      <li>Quản lý nhân sự và gán lịch trực cho nhân viên vận hành tại trạm con.</li>
                      <li>Xem camera trực tiếp, lịch sử ghi hình và báo cáo hiệu suất thiết bị trạm.</li>
                    </ul>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* MODAL USER FORM */}
      {isUserModalOpen && (
        <div className="modal-overlay active">
          <div className="modal-content" style={{ width: 520 }}>
            <div className="modal-header">
              <h3>{editingUserId ? `SỬA TÀI KHOẢN — ${formData.username}` : 'THÊM TÀI KHOẢN'}</h3>
              <button className="modal-close-btn" onClick={() => setIsUserModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              {!editingUserId && (
                <div className="form-group">
                  <label>Tên đăng nhập <span style={{ color: 'var(--admin-danger)' }}>*</span></label>
                  <input type="text" className="form-input" placeholder="nguyen.va" value={formData.username} onChange={e => setFormData({ ...formData, username: e.target.value })} />
                </div>
              )}
              <div className="form-group"><label>Họ tên</label><input type="text" className="form-input" placeholder="Nguyễn Văn A" value={formData.fullName} onChange={e => setFormData({ ...formData, fullName: e.target.value })} /></div>
              <div className="form-group"><label>Email</label><input type="email" className="form-input" placeholder="user@station.vn" value={formData.email} onChange={e => setFormData({ ...formData, email: e.target.value })} /></div>
              
              {!editingUserId && (
                <div className="form-grid-2">
                  <div className="form-group"><label>Mật khẩu <span style={{ color: 'var(--admin-danger)' }}>*</span></label><input type="password" className="form-input" placeholder="••••••••" value={formData.password} onChange={e => setFormData({ ...formData, password: e.target.value })} /></div>
                  <div className="form-group"><label>Xác nhận mật khẩu</label><input type="password" className="form-input" placeholder="••••••••" value={formData.confirmPassword} onChange={e => setFormData({ ...formData, confirmPassword: e.target.value })} /></div>
                </div>
              )}
              
              <div className="form-group" style={{ marginTop: 8 }}>
                <label>Vai trò</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                  <label className="checkbox-label"><input type="radio" name="role" value="operator" checked={formData.role === 'operator'} onChange={e => setFormData({ ...formData, role: e.target.value })} /> <b>Operator</b> <span style={{ color: 'var(--admin-text-muted)', marginLeft: 4 }}>– Xem + Acknowledge</span></label>
                  <label className="checkbox-label"><input type="radio" name="role" value="manager" checked={formData.role === 'manager'} onChange={e => setFormData({ ...formData, role: e.target.value })} /> <b>Manager</b> <span style={{ color: 'var(--admin-text-muted)', marginLeft: 4 }}>– Operator + Tạo báo cáo</span></label>
                  {/* Restricted admin chỉ tạo được admin có gán trạm (không tạo global admin) */}
                  <label className="checkbox-label"><input type="radio" name="role" value="admin" checked={formData.role === 'admin'} onChange={e => setFormData({ ...formData, role: e.target.value })} /> <b>Admin</b> <span style={{ color: 'var(--admin-text-muted)', marginLeft: 4 }}>– {isRestrictedAdmin ? 'Quản lý trạm' : 'Toàn quyền'}</span></label>
                </div>
              </div>

              {/* PHÂN QUYỀN TRẠM BIẾN ÁP */}
              {!isRestrictedAdmin && (() => {
                // Global admin + operator: hiển thị khi role=operator
                // Global admin + manager/admin: ẩn (mặc định tất cả trạm)
                const showStationPicker = formData.role === 'operator';
                const visibleStations = stationsList;

                return (
                  <div className="form-group" style={{ marginTop: 12 }}>
                    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>Trạm biến áp được giám sát</span>
                      {!showStationPicker && (
                        <span style={{ fontSize: 9, color: 'var(--admin-success)', fontWeight: 800 }}>TẤT CẢ (Mặc định)</span>
                      )}
                    </label>

                    {showStationPicker && (
                      <div style={{
                        maxHeight: 120, overflowY: 'auto', border: '1px solid var(--admin-border)',
                        padding: 8, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6,
                        background: 'var(--admin-layer-2)'
                      }} className="custom-hud-scroll">
                        {visibleStations.length === 0 ? (
                          <span style={{ fontSize: 11, color: 'var(--admin-text-muted)' }}>Chưa có trạm nào</span>
                        ) : (
                          visibleStations.map(s => {
                            const isChecked = formData.stationIds.includes(s.id);
                            return (
                              <label key={s.id} className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {
                                    const nextIds = isChecked
                                      ? formData.stationIds.filter(id => id !== s.id)
                                      : [...formData.stationIds, s.id];
                                    setFormData({ ...formData, stationIds: nextIds });
                                  }}
                                />
                                <span style={{ fontSize: 11 }}>{s.name} <code style={{ fontSize: 10, color: 'var(--admin-text-muted)' }}>({s.code})</code></span>
                              </label>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}

              {editingUserId && (
                <div className="form-group" style={{ marginTop: 12 }}>
                  <label className="checkbox-label">
                    <input type="checkbox" checked={formData.isActive} onChange={e => setFormData({ ...formData, isActive: e.target.checked })} /> Tài khoản đang hoạt động
                  </label>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn-industrial" onClick={() => setIsUserModalOpen(false)}>Hủy</button>
              <button className="btn-industrial btn-primary" onClick={saveUser}>Lưu tài khoản</button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL PASSWORD */}
      {isPwModalOpen && (
        <div className="modal-overlay active">
          <div className="modal-content" style={{ width: 420 }}>
            <div className="modal-header">
              <h3>ĐỔI MẬT KHẨU</h3>
              <button className="modal-close-btn" onClick={() => setIsPwModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group"><label>Mật khẩu mới <span style={{ color: 'var(--admin-danger)' }}>*</span></label><input type="password" className="form-input" placeholder="••••••••" value={pwData.newPassword} onChange={e => setPwData({ ...pwData, newPassword: e.target.value })} /></div>
              <div className="form-group"><label>Xác nhận mật khẩu mới</label><input type="password" className="form-input" placeholder="••••••••" value={pwData.confirmPassword} onChange={e => setPwData({ ...pwData, confirmPassword: e.target.value })} /></div>
            </div>
            <div className="modal-footer">
              <button className="btn-industrial" onClick={() => setIsPwModalOpen(false)}>Hủy</button>
              <button className="btn-industrial btn-primary" onClick={changePassword}>Đổi mật khẩu</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
