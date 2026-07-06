// ============================================================
// AppShell.tsx — Khung bố cục chính: sidebar + header + nội dung trang
// Sidebar có thể thu gọn/mở rộng, trạng thái lưu vào localStorage
// Điều hướng lọc theo vai trò người dùng (admin / manager / operator)
// ============================================================

import { useEffect, useState, Suspense, useRef, useCallback, useMemo } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { authService } from '@/services/AuthService';
import { useAuthStore } from '@/store/authStore';
import { apiFetch } from '@/services/api/BaseApiService';
import { useAlertStore, useSensorStore, useStationStore } from '@/store';
import { ALERT_STATUS } from '@/types/enums';
import type { AlertItem, SensorPoint } from '@/types/api.types';
import { setTheme as setGlobalTheme } from '@/utils/theme-manager';
import { showToast } from '@/utils/toast';
import { playAlertSound } from '@/utils/sound-utils';
import { isCentralUser as isCentralUserAccount, MULTISITE_RETURN_TAB_KEY } from '@/utils/centralAccess';
import { getDisplayStationName, getStoredStationName, hasStoredServerIp } from '@/utils/station-setup';
import { createRealtimeHub } from '@/services/realtime.service';
import RichAlertModal from '@/components/ui/RichAlertModal';
import {
  LayoutDashboard, Video, AlertTriangle, LineChart,
  Wrench, FileArchive, Map, Radio, Settings, LogOut,
  ChevronLeft, ChevronRight, Key, Lock
} from 'lucide-react';

interface NavSubItem { id: string; path: string; label: string }
// roles: undefined = tất cả vai trò; có giá trị = chỉ vai trò trong mảng mới thấy
interface NavItem { id: string; path: string; icon: React.ReactNode; label: string; roles?: string[]; children?: NavSubItem[] }

const CENTRAL_NAV: NavItem[] = [
  { id: 'multisite', path: '/multisite', icon: <Map size={19} strokeWidth={1.5} />, label: 'Tổng quan' },
  { id: 'alerts-history', path: '/alerts-history', icon: <AlertTriangle size={19} strokeWidth={1.5} />, label: 'Nhật ký' },
  { id: 'audit-log', path: '/audit-log', icon: <FileArchive size={19} strokeWidth={1.5} />, label: 'Nhật ký hệ thống', roles: ['admin'] },
];

const CENTRAL_ADMIN_NAV: NavItem[] = [];

const CHILD_NAV: NavItem[] = [
  { id: 'dashboard', path: '/dashboard', icon: <LayoutDashboard size={19} strokeWidth={1.5} />, label: 'Tổng quan' },
  { id: 'realtime', path: '/realtime', icon: <Video size={19} strokeWidth={1.5} />, label: 'Trực tiếp' },
  { id: 'alerts-history', path: '/alerts-history', icon: <AlertTriangle size={19} strokeWidth={1.5} />, label: 'Lịch sử cảnh báo' },
  { id: 'analytics', path: '/analytics', icon: <LineChart size={19} strokeWidth={1.5} />, label: 'Phân tích' },
  { id: 'maintenance', path: '/maintenance', icon: <Wrench size={19} strokeWidth={1.5} />, label: 'Bảo trì', roles: ['admin', 'manager'] },
  { id: 'audit-log', path: '/audit-log', icon: <FileArchive size={19} strokeWidth={1.5} />, label: 'Nhật ký hệ thống', roles: ['admin'] },
];

const CHILD_ADMIN_NAV: NavItem[] = [
  { id: 'device-management', path: '/device-management', icon: <Radio size={19} strokeWidth={1.5} />, label: 'Thiết bị', roles: ['admin'] },
  { id: 'settings', path: '/settings', icon: <Settings size={19} strokeWidth={1.5} />, label: 'Cài đặt', roles: ['admin'] },
];

const THEME_NAMES: Record<string, string> = {
  dark: 'Tối',
  light: 'Trắng',
  'soft-light': 'Dịu mắt',
  silver: 'Bạc',
  industrial: 'Công nghiệp',
  hightech: 'Hiện đại',
  cyberpunk: 'Neon'
};

const isFireAlert = (alert: AlertItem) => {
  const m = (alert.message || '').toLowerCase();
  return m.includes('cháy') || m.includes('lửa') || m.includes('khói') || m.includes('fire') || m.includes('smoke');
};

/**
 * Khung bố cục chính của ứng dụng — gồm header, sidebar thu gọn/mở rộng và vùng nội dung trang.
 * Quản lý SignalR toàn cục, xử lý cảnh báo mới, đồng bộ cảm biến và điều hướng theo vai trò.
 */
export default function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore(s => s.user);
  const [stationConfigVersion, setStationConfigVersion] = useState(0);

  // ── Security Check ──
  useEffect(() => {
    if (!user) {
      navigate('/login');
    }
  }, [user, navigate]);

  // ── Session Validity Polling ──
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(async () => {
      try {
        await apiFetch('/stations');
      } catch (err) {
        console.warn('Session validity check failed:', err);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [user]);

  useEffect(() => {
    const refreshStationConfig = () => setStationConfigVersion(v => v + 1);
    window.addEventListener('station-config-updated', refreshStationConfig);
    window.addEventListener('storage', refreshStationConfig);
    return () => {
      window.removeEventListener('station-config-updated', refreshStationConfig);
      window.removeEventListener('storage', refreshStationConfig);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    if (isCentralUserAccount(user)) return;
    useStationStore.getState().fetch(true).catch(() => undefined);
  }, [user]);

  if (!user) return null;

  // Trạm tổng = tài khoản 'multi' HOẶC admin không bị giới hạn trạm (không có station_ids)
  const isCentralUser = isCentralUserAccount(user);
  const headerQuery = new URLSearchParams(location.search);
  const storedStationName = useMemo(() => getStoredStationName(), [stationConfigVersion]);

  // Global admin drill-down: đang xem trạm con từ màn hình đa trạm
  const viewingStationId = useStationStore(s => s.viewingStationId);
  const setViewingStation = useStationStore(s => s.setViewingStation);
  const isDrillDown = isCentralUser && !!viewingStationId && location.pathname !== '/multisite';

  // Khi navigate về /multisite → clear drill-down
  useEffect(() => {
    if (location.pathname === '/multisite') {
      setViewingStation(null);
    }
  }, [location.pathname, setViewingStation]);

  // Trạm hiện tại đang xem (khi drill-down)
  const stations = useStationStore(s => s.stations);
  const drillStation = isDrillDown ? stations.find(s => s.id === viewingStationId) : null;

  // Nav mode: central hoặc child
  const isCentralMode = isCentralUser && !isDrillDown;
  const navItems = isCentralMode ? CENTRAL_NAV : CHILD_NAV;
  const headerStationLabel = useMemo(() => {
    if (isDrillDown && drillStation?.name) return drillStation.name;
    if (isCentralMode) return 'TRẠM ĐIỆN';

    const selectedStationId = headerQuery.get('stationId') || localStorage.getItem('selected_station_id') || '';
    const matched = stations.find(s => s.id === selectedStationId);
    return getDisplayStationName(matched?.name, storedStationName) || 'CẦN CẤU HÌNH TRẠM';
  }, [isDrillDown, drillStation, isCentralMode, stations, location.search, storedStationName]);

  const parsedStationLabel = useMemo(() => {
    const text = (headerStationLabel || '').trim().toUpperCase();
    const kvMatch = text.match(/\b(\d+\s*KV)\b/i);
    const kvLabel = kvMatch && kvMatch[1] ? kvMatch[1].replace(/\s+/g, '').toUpperCase() : '';
    const cleaned = text
      .replace(/^(TRẠM BIẾN ÁP|TRẠM)\s+/i, '')
      .replace(/\b\d+\s*KV\b/i, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (kvLabel) {
      const words = cleaned.split(/\s+/).filter(Boolean);
      return words.length === 2
        ? { mode: 'split', first: words[0], second: words[1], sub: kvLabel }
        : { mode: 'single', text: cleaned, sub: kvLabel };
    }

    if (text.startsWith('TRẠM BIẾN ÁP ')) {
      return { mode: 'single', text: text.replace(/^TRẠM BIẾN ÁP /, ''), sub: 'TBA' };
    }
    return { mode: 'single', text, sub: '' };
  }, [headerStationLabel]);

  useEffect(() => {
    if (!user || isCentralUser) return;
    if (location.pathname.startsWith('/settings')) return;
    if (!hasStoredServerIp()) {
      navigate('/settings?setup=1', { replace: true });
    }
  }, [user, isCentralUser, location.pathname, navigate]);

  // Lọc adminNavItems theo quyền:
  // - Restricted admin (khi ở trạm tổng): ẩn settings, license
  // - Trên trạm con (Power-Monitor): luôn hiển thị đầy đủ menu quản trị cho Admin
  const adminNavItems = (isCentralMode ? CENTRAL_ADMIN_NAV : CHILD_ADMIN_NAV).filter(item => {
    if (isCentralMode && (user.is_restricted || (user.station_ids && user.station_ids.length > 0))) {
      return !['settings', 'license'].includes(item.id);
    }
    return true;
  });

  // ── Alerts Management ────────────────────────────────────────
  const [alertQueue, setAlertQueue] = useState<AlertItem[]>([]);
  const activeAlert = alertQueue[0] ?? null;

  const dismissActiveAlert = useCallback(() => {
    setAlertQueue(q => q.slice(1));
  }, []);

  const enqueueAlert = useCallback((alert: AlertItem) => {
    setAlertQueue(q => {
      // Không enqueue trùng alert id
      if (q.some(a => a.id === alert.id)) return q;

      const newQueue = [...q, alert];
      // Sắp xếp: Cảnh báo cháy/lửa/khói lên đầu, các cảnh báo khác xếp sau
      return [...newQueue].sort((a, b) => {
        const aFire = isFireAlert(a);
        const bFire = isFireAlert(b);
        if (aFire && !bFire) return -1;
        if (!aFire && bFire) return 1;
        return 0; // Giữ nguyên thứ tự thời gian tương đối
      });
    });
  }, []);

  const fetchAlerts = useAlertStore(s => s.fetch);
  const invalidateAlerts = useAlertStore(s => s.invalidate);

  // Track alert IDs đã show popup trong session này (reset khi đóng tab)
  const shownAlertIdsRef = useRef<Set<string>>((() => {
    try {
      return new Set<string>(JSON.parse(sessionStorage.getItem('shown_alert_ids') || '[]'));
    } catch { return new Set<string>(); }
  })());

  const markAlertShown = useCallback((id: string) => {
    shownAlertIdsRef.current.add(id);
    try {
      sessionStorage.setItem('shown_alert_ids', JSON.stringify([...shownAlertIdsRef.current]));
    } catch { /* sessionStorage không khả dụng */ }
  }, []);

  const enqueueAlertWithTrack = useCallback((alert: AlertItem) => {
    if (shownAlertIdsRef.current.has(alert.id)) return;
    markAlertShown(alert.id);
    enqueueAlert(alert);
  }, [enqueueAlert, markAlertShown]);

  useEffect(() => {
    // Fetch open alerts và enqueue những alert rule_engine chưa được show popup
    fetchAlerts(ALERT_STATUS.OPEN).then((openAlerts) => {
      if (!Array.isArray(openAlerts)) return;
      const unseen = openAlerts.filter(
        a => a.source === 'rule_engine' &&
          (a.level === 'alarm' || a.level === 'warning') &&
          !shownAlertIdsRef.current.has(a.id)
      );
      // Enqueue từng alert chưa xem, delay nhỏ để tránh spam ngay lúc load
      // Trạm tổng không hiện popup
      if (!isCentralMode) {
        unseen.forEach((a, i) => setTimeout(() => enqueueAlertWithTrack(a), i * 300));
      }
    }).catch(() => { });

    // Khởi tạo SignalR Hub toàn cục để lắng nghe mọi sự kiện trên mọi Tab
    const hub = createRealtimeHub();

    // 1. Lắng nghe cảnh báo mới từ Rule Engine, Camera, Maintenance
    hub.on('AlertNew', (alert: AlertItem) => {
      invalidateAlerts(ALERT_STATUS.OPEN);
      useAlertStore.getState().prepend(alert);
      fetchAlerts(ALERT_STATUS.OPEN, true);

      const level = (alert.level || '').toLowerCase();
      const isFire = alert.message?.toLowerCase().includes('cháy') || alert.message?.toLowerCase().includes('fire') || alert.message?.toLowerCase().includes('lửa');
      const shouldNotify = level === 'alarm' || level === 'warning' || level === 'danger' || isFire;
      const isAlarm = level === 'alarm' || level === 'danger' || isFire;

      // Chỉ hiển thị popup/toast cho warning + alarm + sự kiện cháy.
      if (!shouldNotify) return;

      const isOverview = isCentralMode || location.pathname.includes('multisite');
      const soundLevel: 'warning' | 'alarm' = isAlarm ? 'alarm' : 'warning';

      if (!isOverview) {
        // Nếu ở trang chi tiết: hiện popup cho cả warning và alarm
        playAlertSound(soundLevel);
        enqueueAlertWithTrack(alert);
      } else {
        // Nếu ở trang Tổng quan: hiện toast tương ứng, vẫn có âm thanh nhẹ cho warning
        showToast(alert.message || (isAlarm ? 'Báo động đỏ mới' : 'Cảnh báo mới'), isAlarm ? 'error' : 'info');
        playAlertSound(soundLevel);
      }
    });

    // 2. Lắng nghe cập nhật cảnh báo
    hub.on('AlertUpdated', (data: any) => {
      invalidateAlerts(ALERT_STATUS.OPEN);
      fetchAlerts(ALERT_STATUS.OPEN, true);

      // Nếu cảnh báo đang hiện Popup được cập nhật (vd: có ảnh/video mới), cập nhật ngay
      setAlertQueue(q => q.map(a => a.id === data.id ? { ...a, ...data } : a));
    });

    // 3. Lắng nghe sự kiện Camera AI
    hub.on('CameraEvent', (evt: any) => {
      // Chúng ta không gọi setActiveAlert ở đây nữa vì AlertNew sẽ hiển thị Popup 
      // với đầy đủ ảnh và thông tin chi tiết (do backend đã thống nhất gửi chung vào AlertNew)
      if (!evt || !evt.detectionType) return;

      // partial_discharge đã có AlertNew (level warning/alarm) nên không cần toast info rời rạc gây spam
      const isCritical = ['fire', 'thermal_hotspot', 'intrusion', 'partial_discharge'].includes(evt.detectionType);

      if (!isCritical) {
        showToast(`Camera: ${evt.detectionType.toUpperCase()}`, 'info');
      }
    });

    // 4. Lắng nghe cập nhật cảm biến (để đồng bộ store cho mọi tab)
    hub.on('SensorUpdate', (data: SensorPoint[]) => {
      if (!Array.isArray(data)) return;
      useSensorStore.setState(s => {
        const nextPoints = { ...s.pointsByStation };
        data.forEach(d => {
          Object.keys(nextPoints).forEach(sid => {
            const list = [...(nextPoints[sid] || [])];
            const idx = list.findIndex(p => p.pointId === d.pointId && p.deviceId === d.deviceId);
            if (idx >= 0) {
              list[idx] = d;
            } else {
              // Thêm sensor point mới nếu chưa có trong danh sách
              list.push(d);
            }
            nextPoints[sid] = list;
          });
        });
        return { pointsByStation: nextPoints };
      });
    });

    // 5. Lắng nghe cập nhật thông tin tài khoản để đồng bộ realtime không cần reload
    hub.on('UserStatusChange', (data: { username: string, status: string }) => {
      const currentUser = useAuthStore.getState().user;
      if (data && data.username === currentUser?.username) {
        if (data.status === 'updated') {
          console.log('[AppShell] User profile updated, performing silent refresh...');
          authService.refreshSession().then((success) => {
            if (success) {
              // Invalidate and refresh store data reactively
              useStationStore.getState().invalidate();
              useStationStore.getState().fetch(true);
              useAlertStore.getState().invalidate();
              useAlertStore.getState().fetch(ALERT_STATUS.OPEN, true);
              showToast('Thông tin phân quyền tài khoản đã được cập nhật thành công!', 'info');
            }
          });
        } else if (data.status === 'deactivated') {
          showToast('Tài khoản của bạn đã bị vô hiệu hóa bởi Quản trị viên.', 'error');
          setTimeout(() => {
            authService.logout();
            navigate('/login');
          }, 2000);
        }
      }
    });

    let isMounted = true;
    const startHub = async () => {
      try {
        await hub.start();
        console.log('[AppShell] SignalR Global Connected.');
      } catch (err) {
        console.warn('[AppShell] SignalR Global Connection failed, retrying in 5s...', err);
        if (isMounted) {
          setTimeout(startHub, 5000);
        }
      }
    };
    startHub();

    return () => {
      isMounted = false;
      hub.stop();
    };
  }, [fetchAlerts, invalidateAlerts]);

  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changePasswordError, setChangePasswordError] = useState('');
  const [changePasswordSuccess, setChangePasswordSuccess] = useState('');
  const [changePasswordLoading, setChangePasswordLoading] = useState(false);
  const [time, setTime] = useState(new Date().toLocaleTimeString('vi-VN'));

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangePasswordError('');
    setChangePasswordSuccess('');

    if (!oldPassword) {
      setChangePasswordError('Vui lòng nhập mật khẩu hiện tại');
      return;
    }
    if (!newPassword) {
      setChangePasswordError('Vui lòng nhập mật khẩu mới');
      return;
    }
    if (newPassword.length < 6) {
      setChangePasswordError('Mật khẩu mới phải có tối thiểu 6 ký tự');
      return;
    }
    if (newPassword === oldPassword) {
      setChangePasswordError('Mật khẩu mới không được trùng với mật khẩu cũ');
      return;
    }
    if (newPassword !== confirmPassword) {
      setChangePasswordError('Mật khẩu xác nhận không khớp');
      return;
    }

    setChangePasswordLoading(true);
    try {
      const res = await authService.changePassword(oldPassword, newPassword);
      if (res.success) {
        setChangePasswordSuccess('Đổi mật khẩu thành công!');
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setTimeout(() => {
          setShowChangePasswordModal(false);
          setChangePasswordSuccess('');
        }, 1500);
      } else {
        setChangePasswordError(res.error || 'Đổi mật khẩu thất bại');
      }
    } catch (err) {
      setChangePasswordError('Lỗi kết nối đến máy chủ');
    } finally {
      setChangePasswordLoading(false);
    }
  };

  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showThemeList, setShowThemeList] = useState(false);
  const [popupPos, setPopupPos] = useState({ bottom: 0, left: 0 });
  const userMenuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  // Sidebar mở rộng mặc định; lưu preference vào localStorage
  const [expanded, setExpanded] = useState(
    () => localStorage.getItem('sidebar-expanded') !== 'false'
  );
  const [theme, setThemeState] = useState<string>(
    () => localStorage.getItem('station-theme') || 'industrial'
  );

  /** Áp dụng theme mới và lưu vào localStorage, hiển thị toast xác nhận. */
  const handleSelectTheme = (newTheme: string) => {
    setThemeState(newTheme);
    setGlobalTheme(newTheme as any);

    const themeNames: Record<string, string> = {
      dark: 'Tối Tiêu chuẩn',
      light: 'Trắng Tiêu chuẩn',
      'soft-light': 'Sáng Dịu mắt',
      silver: 'Bạc Tinh tế',
      industrial: 'Xám Công nghiệp',
      hightech: 'Xanh Hiện đại',
      cyberpunk: 'Tím Neon'
    };
    showToast(`Đã áp dụng giao diện ${themeNames[newTheme] || newTheme}`, 'success');
  };

  useEffect(() => {
    // Đóng user menu khi đổi route/tab
    setShowUserMenu(false);
    setShowThemeList(false);
  }, [location.pathname]);

  useEffect(() => {
    // Đóng user menu khi click ra ngoài
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
        setShowThemeList(false);
      }
    };

    if (showUserMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showUserMenu]);

  useEffect(() => {
    // Áp dụng theme đã lưu ngay khi shell mount
    const savedTheme = localStorage.getItem('station-theme') || 'industrial';
    document.documentElement.dataset.theme = savedTheme;
    document.documentElement.classList.remove('theme-blue', 'theme-dark', 'theme-light', 'theme-industrial', 'theme-hightech', 'theme-matrix', 'theme-cyberpunk', 'theme-retro');
    document.documentElement.classList.add(`theme-${savedTheme}`);

    const handleThemeChange = (e: Event) => {
      const customEv = e as CustomEvent;
      const newTheme = customEv.detail?.theme;
      if (newTheme) {
        setThemeState(newTheme);
      }
    };
    window.addEventListener('theme-changed', handleThemeChange);

    const clockTimer = window.setInterval(() => {
      setTime(new Date().toLocaleTimeString('vi-VN'));
    }, 1000);

    return () => {
      window.clearInterval(clockTimer);
      window.removeEventListener('theme-changed', handleThemeChange);
    };
  }, []);

  /** Chuyển đổi trạng thái sidebar (mở rộng/thu gọn) và lưu vào localStorage. */
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    localStorage.setItem('sidebar-expanded', String(next));
  };

  /** Đăng xuất người dùng, xóa phiên và reload toàn bộ state app. */
  const handleLogout = async () => {
    await authService.logout();
    navigate('/login');
    window.location.reload(); // reset toàn bộ state app
  };

  /** Lọc và render danh sách NavLink theo vai trò người dùng, hỗ trợ sub-menu khi active. */
  const renderNav = (items: NavItem[]) =>
    items
      .filter(i => !i.roles || i.roles.includes(user.role))
      .map(i => {
        const hasChildren = i.children && i.children.length > 0;
        const isCurrentActive = window.location.pathname.startsWith(i.path);

        const targetPath = (hasChildren && i.children && i.children[0]) ? i.children[0].path : i.path;

        return (
          <div key={i.id} style={{ display: 'flex', flexDirection: 'column' }}>
            <NavLink
              to={targetPath}
              className={({ isActive }) => `nav-item${(isActive || isCurrentActive) ? ' active' : ''}`}
              title={!expanded ? i.label : undefined}
              end={!hasChildren}
            >
              <span className="nav-icon">{i.icon}</span>
              <span className={`nav-label${expanded ? ' nav-label--visible' : ''}`}>{i.label}</span>
              {hasChildren && expanded && (
                <span className="sub-chevron" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', opacity: 0.5, transform: isCurrentActive ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                  <ChevronRight size={12} strokeWidth={2.5} />
                </span>
              )}
            </NavLink>
            {hasChildren && expanded && isCurrentActive && (
              <div className="sb-sub-tree">
                {i.children!.map(child => (
                  <NavLink
                    key={child.id}
                    to={child.path}
                    className={({ isActive }) => `sb-sub-item${isActive ? ' active' : ''}`}
                  >
                    {child.label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        );
      });

  const themeClass = `theme-${theme}`;

  return (
    <div className={`app-shell admin-container ${themeClass}`}>


      {/* ── Full-width header (independent of sidebar) ── */}
      {!isCentralMode && isDrillDown && (
        <header className="admin-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flex: 1, minWidth: 0, overflow: 'hidden' }}>
            {isDrillDown && (
              <button
                onClick={() => {
                  const returnTab = localStorage.getItem(MULTISITE_RETURN_TAB_KEY);
                  setViewingStation(null);
                  navigate(returnTab ? `/multisite?tab=${encodeURIComponent(returnTab)}` : '/multisite');
                  localStorage.removeItem(MULTISITE_RETURN_TAB_KEY);
                }}
                style={{
                  height: 28,
                  padding: '0 10px',
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  border: '1px solid var(--admin-border)',
                  background: 'linear-gradient(180deg, rgba(15,23,42,0.92), rgba(15,23,42,0.72))',
                  color: 'var(--admin-accent)',
                  fontSize: '0.68rem',
                  fontWeight: 800,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
                }}
              >
                <span style={{ fontSize: '0.8rem', lineHeight: 1 }}>←</span>
                <span>Trạm tổng</span>
              </button>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexShrink: 0 }} />
        </header>
      )}


      {/* ── Body: sidebar + content ── */}
      <div className="app-body" style={isCentralMode ? { margin: 0, padding: 0 } : {}}>

        {/* ── Sidebar wrapper ── */}
        {!isCentralMode && (
          <div className={`sb-wrap${expanded ? ' expanded' : ''}`}>
            <nav className="sidebar-nav" id="sidebarNav">
              <div className="sb-brand">
                <div className="sb-brand__logo">
                  <img
                    alt="StationOS"
                    className="sb-logo__img"
                    src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWQiIHgxPSIwJSIgeTE9IjAlIiB4Mj0iMTAwJSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiM0NGZmODgiIC8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMDI4NGM3IiAvPjwvbGluZWFyR3JhZGllbnQ+PGZpbHRlciBpZD0iZ2xvdyI+PGZlR2F1c3NpYW5CbHVyIHN0ZERldmlhdGlvbj0iMyIgcmVzdWx0PSJjb2xvcmVkQmx1ciIvPjxmZU1lcmdlPjxmZU1lcmdlTm9kZSBpbj0iY29sb3JlZEJsdXIiLz48ZmVNZXJnZU5vZGUgaW49IlNvdXJjZUdyYXBoaWMiLz48L2ZlTWVyZ2U+PC9maWx0ZXI+PC9kZWZzPjxjaXJjbGUgY3g9IjUwIiBjeT0iNTAiIHI9IjQ1IiBmaWxsPSJub25lIiBzdHJva2U9InVybCgjZ3JhZCkiIHN0cm9rZS13aWR0aD0iNiIgZmlsdGVyPSJ1cmwoI2dsb3cpIi8+PHBhdGggZD0iTTUwIDE1IEw4MCAzNSBMODAgNjUgTDUwIDg1IEwyMCA2NSBMMjAgMzUgWiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmZmZmIiBzdHJva2Utd2lkdGg9IjMiIG9wYWNpdHk9IjAuNSIvPjxwYXRoIGQ9Ik01NSAyNSBMMzUgNTUgTDUwIDU1IEw0NSA3NSBMNjUgNDUgTDUwIDQ1IFoiIGZpbGw9IiM0NGZmODgiIGZpbHRlcj0idXJsKCNnbG93KSIvPjwvc3ZnPg=="
                  />
                </div>
                <div className={`sb-brand__info${expanded ? '' : ' hidden'}`}>
                  {parsedStationLabel.mode === 'split' ? (
                    <div className="sb-brand__main-grid">
                      <span className="sb-brand__main-word sb-brand__main-word--first">{parsedStationLabel.first}</span>
                      <span className="sb-brand__main-word sb-brand__main-word--second">{parsedStationLabel.second}</span>
                      {parsedStationLabel.sub && <span className="sb-brand__sub sb-brand__sub--below-second">{parsedStationLabel.sub}</span>}
                    </div>
                  ) : (
                    <>
                      <div className="sb-brand__main">{parsedStationLabel.text}</div>
                      {parsedStationLabel.sub && <span className="sb-brand__sub">{parsedStationLabel.sub}</span>}
                    </>
                  )}
                </div>
              </div>

              {/* ── Scrollable nav body ── */}
              <div className="sb-body">
                <div className="sb-group">
                  <div
                    className={`sb-group__label${expanded ? '' : ' hidden'}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'flex-start',
                      gap: 8
                    }}
                  >
                    <span>ĐIỀU HƯỚNG</span>
                  </div>
                  {renderNav(navItems)}
                </div>

                {user.role === 'admin' && (
                  <>
                    <div className="sb-sep" />
                    <div className="sb-group">
                      {renderNav(adminNavItems)}
                    </div>
                  </>
                )}
              </div>

              {/* ── Bottom actions (pinned) ── */}
              <div className="sb-bottom">
                <div className="sb-sep" />

                {/* Profile & User Menu Combined */}
                <div className="sb-user-action-wrap" style={{ position: 'relative' }} ref={userMenuRef}>

                  {/* Popover Menu — position:fixed để thoát overflow:hidden của sidebar */}
                  {showUserMenu && (
                    <div className="sb-user-popover" style={{ position: 'fixed', bottom: popupPos.bottom, left: popupPos.left, top: 'auto', width: 200, padding: '6px 0' }}>
                      <div
                        className="sb-popover-item"
                        onClick={() => setShowThemeList(!showThemeList)}
                        style={{ justifyContent: 'space-between', fontWeight: 700, padding: '8px 12px' }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span>🎨 Giao diện:</span>
                          <span style={{ color: 'var(--admin-accent)' }}>{THEME_NAMES[theme] || theme}</span>
                        </div>
                        <span style={{
                          fontSize: '0.6rem',
                          transform: showThemeList ? 'rotate(90deg)' : 'none',
                          transition: 'transform 0.15s ease',
                          opacity: 0.5
                        }}>▸</span>
                      </div>

                      {showThemeList && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '2px 6px', background: 'var(--admin-hover)', borderRadius: 0, margin: '2px 8px' }}>
                          {[
                            { value: 'dark', label: '⚫ Tối Tiêu chuẩn' },
                            { value: 'industrial', label: '🔘 Xám Công nghiệp' },
                            { value: 'hightech', label: '🔵 Xanh Hiện đại' },
                            { value: 'cyberpunk', label: '🟣 Tím Neon' },
                            { value: 'light', label: '⚪ Trắng Tiêu chuẩn' },
                            { value: 'soft-light', label: '🟡 Sáng Dịu mắt' },
                            { value: 'silver', label: '🥈 Bạc Tinh tế' },
                          ].map(t => {
                            const isActive = theme === t.value;
                            return (
                              <div
                                key={t.value}
                                onClick={() => handleSelectTheme(t.value)}
                                className="sb-popover-item"
                                style={{
                                  fontWeight: isActive ? 800 : 500,
                                  background: isActive ? 'var(--admin-accent)' : undefined,
                                  color: isActive ? '#ffffff' : undefined,
                                  justifyContent: 'space-between',
                                  padding: '5px 8px',
                                  fontSize: '0.7rem',
                                  borderRadius: 0,
                                }}
                              >
                                <span>{t.label}</span>
                                {isActive && <span style={{ fontSize: '0.6rem' }}>✓</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <div className="sb-popover-sep" style={{ margin: '4px 0' }} />
                      {authService.hasPermission('license:manage') && (
                        <>
                          <div
                            className="sb-popover-item"
                            onClick={() => {
                              navigate('/license');
                              setShowUserMenu(false);
                            }}
                            style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6 }}
                          >
                            <Key size={14} strokeWidth={2} /> <span>Giftcode bản quyền</span>
                          </div>
                          <div className="sb-popover-sep" style={{ margin: '4px 0' }} />
                        </>
                      )}
                      <div
                        className="sb-popover-item"
                        onClick={() => {
                          setShowChangePasswordModal(true);
                          setShowUserMenu(false);
                          setOldPassword('');
                          setNewPassword('');
                          setConfirmPassword('');
                          setChangePasswordError('');
                          setChangePasswordSuccess('');
                        }}
                        style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        <Lock size={14} strokeWidth={2} /> <span>Đổi mật khẩu</span>
                      </div>
                      <div className="sb-popover-sep" style={{ margin: '4px 0' }} />
                      <div className="sb-popover-item danger" onClick={() => { setShowLogoutModal(true); setShowUserMenu(false); }} style={{ padding: '8px 12px' }}>
                        <LogOut size={14} strokeWidth={2} /> <span>Đăng xuất</span>
                      </div>
                    </div>
                  )}

                  <div
                    ref={triggerRef}
                    className={`sb-user-action ${showUserMenu ? 'active' : ''}`}
                    onClick={() => {
                      if (!showUserMenu && triggerRef.current) {
                        const r = triggerRef.current.getBoundingClientRect();
                        setPopupPos({ bottom: window.innerHeight - r.top + 6, left: r.left });
                      }
                      setShowUserMenu(v => !v);
                    }}
                    title={!expanded ? 'Tài khoản' : undefined}
                  >
                    <div className="sb-profile">
                      <span className="user-avatar">{isCentralUser ? 'Q' : (user.fullname?.[0]?.toUpperCase() || 'A')}</span>
                      {expanded && (
                        <div className="sb-profile-info">
                          <div className="sb-profile-name">{isCentralUser ? 'Quản trị tổng quan' : user.fullname}</div>
                        </div>
                      )}
                      {expanded && (
                        <ChevronRight
                          size={14}
                          strokeWidth={2.5}
                          style={{
                            opacity: 0.4,
                            transform: showUserMenu ? 'rotate(-90deg)' : 'none',
                            transition: 'transform 0.2s'
                          }}
                        />
                      )}
                    </div>
                  </div>
                </div>
                <div className="sb-bottom-time">{time}</div>
              </div>

            </nav>

            {/* Toggle chevron — outside nav so overflow:hidden doesn't clip it */}
            <button className="sb-toggle" onClick={toggle} title={expanded ? 'Thu gọn' : 'Mở rộng'}>
              {expanded ? <ChevronLeft size={12} strokeWidth={2.5} /> : <ChevronRight size={12} strokeWidth={2.5} />}
            </button>
          </div>
        )}

        {/* ── Main view ── */}
        <div className="main-view">
          {/* Main view content */}
          <div className="page-content">
            <Suspense fallback={null}>
              <Outlet />
            </Suspense>
          </div>
        </div>

      </div>{/* end .app-body */}

      {/* ── Rich Alert Modal (queue — hiển thị từng cái) ── */}
      {activeAlert && !isCentralMode && !location.pathname.includes('multisite') && location.pathname !== '/' && (
        <RichAlertModal
          alert={activeAlert}
          queueCount={alertQueue.length}
          onClose={dismissActiveAlert}
        />
      )}

      {/* ── Logout modal ── */}
      {showLogoutModal && (
        <div className="modal-overlay active">
          <div className="modal-content" style={{ width: 380, textAlign: 'center' }}>
            <div className="modal-body" style={{ padding: '32px 24px' }}>
              <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'center' }}>
                <LogOut size={48} strokeWidth={1.5} color="var(--admin-danger)" />
              </div>
              <h3 style={{ margin: '0 0 8px', color: 'var(--admin-text, var(--admin-text))' }}>Đăng xuất</h3>
              <p style={{ margin: 0, opacity: 0.6, fontSize: '.9rem' }}>Bạn có chắc muốn đăng xuất khỏi hệ thống?</p>
            </div>
            <div className="modal-footer" style={{ justifyContent: 'center', gap: 12 }}>
              <button onClick={() => setShowLogoutModal(false)} className="btn-industrial" style={{ minWidth: 100 }}>Hủy</button>
              <button onClick={handleLogout} className="btn-industrial btn-danger" style={{ minWidth: 100 }}>Đăng xuất</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Change Password modal ── */}
      {showChangePasswordModal && (
        <div className="modal-overlay active">
          <div className="modal-content" style={{ width: 400 }}>
            <div className="modal-header" style={{ padding: '16px 20px', borderBottom: '1px solid var(--admin-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Lock size={18} strokeWidth={2} color="var(--admin-accent)" />
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--admin-text)' }}>Đổi mật khẩu tài khoản</h3>
            </div>
            <form onSubmit={handleChangePassword}>
              <div className="modal-body" style={{ padding: '20px' }}>
                {changePasswordError && (
                  <div style={{ marginBottom: 12, padding: '8px 12px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: 4, color: 'var(--admin-danger)', fontSize: '0.85rem' }}>
                    {changePasswordError}
                  </div>
                )}
                {changePasswordSuccess && (
                  <div style={{ marginBottom: 12, padding: '8px 12px', background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.2)', borderRadius: 4, color: 'var(--admin-success, #22c55e)', fontSize: '0.85rem' }}>
                    {changePasswordSuccess}
                  </div>
                )}

                <div className="form-group" style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: '0.85rem', fontWeight: 600 }}>Mật khẩu hiện tại <span style={{ color: 'var(--admin-danger)' }}>*</span></label>
                  <input
                    type="password"
                    className="form-input"
                    placeholder="••••••••"
                    value={oldPassword}
                    onChange={e => setOldPassword(e.target.value)}
                    required
                    style={{ width: '100%' }}
                  />
                </div>

                <div className="form-group" style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: '0.85rem', fontWeight: 600 }}>Mật khẩu mới <span style={{ color: 'var(--admin-danger)' }}>*</span></label>
                  <input
                    type="password"
                    className="form-input"
                    placeholder="••••••••"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    required
                    style={{ width: '100%' }}
                  />
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: '0.85rem', fontWeight: 600 }}>Xác nhận mật khẩu mới <span style={{ color: 'var(--admin-danger)' }}>*</span></label>
                  <input
                    type="password"
                    className="form-input"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    required
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
              <div className="modal-footer" style={{ padding: '16px 20px', borderTop: '1px solid var(--admin-border)', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                <button
                  type="button"
                  onClick={() => setShowChangePasswordModal(false)}
                  className="btn-industrial"
                  disabled={changePasswordLoading}
                  style={{ minWidth: 80 }}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="btn-industrial btn-primary"
                  disabled={changePasswordLoading}
                  style={{ minWidth: 100 }}
                >
                  {changePasswordLoading ? 'Đang lưu...' : 'Lưu thay đổi'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
