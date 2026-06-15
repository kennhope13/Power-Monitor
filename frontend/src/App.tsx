// ============================================================
// App.tsx — Cấu trúc routing chính của ứng dụng
// Sử dụng React Router v7, lazy loading từng trang để giảm bundle size
// Tất cả trang trừ /login đều yêu cầu đăng nhập (ProtectedRoute)
// ============================================================

import React, { Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import AppShell from '@/components/layout/AppShell';
import { useAuthStore } from '@/store/authStore';
import type { User, UserRole } from '@/types/api.types';

// Lazy import — mỗi trang là một chunk riêng, tải khi cần
const DashboardPage = React.lazy(() => import('@/pages/dashboard/DashboardPage'));
const RealtimeMonitorPage = React.lazy(() => import('@/pages/realtime-monitor/RealtimeMonitorPage'));
const AlertsHistoryPage = React.lazy(() => import('@/pages/alerts-history/AlertsHistoryPage'));
const AlertDetailPage = React.lazy(() => import('@/pages/alert-detail/AlertDetailPage'));
const AnalyticsLayout = React.lazy(() => import('@/pages/analytics/AnalyticsLayout'));
const ReportsPage = React.lazy(() => import('@/pages/reports/ReportsPage'));
const MaintenancePage = React.lazy(() => import('@/pages/maintenance/MaintenancePage'));
const AuditLogPage = React.lazy(() => import('@/pages/audit-log/AuditLogPage'));
const DeviceManagementPage = React.lazy(() => import('@/pages/device-management/DeviceManagementPage'));
const ThermalConfigPage = React.lazy(() => import('@/pages/device-management/ThermalConfigPage'));
const UserManagementPage = React.lazy(() => import('@/pages/user-management/UserManagementPage'));
const SettingsPage = React.lazy(() => import('@/pages/settings/SettingsPage'));
const LoginPage = React.lazy(() => import('@/pages/login/LoginPage'));
const LicensePage = React.lazy(() => import('@/pages/license/LicensePage'));

import { authService } from '@/services/AuthService';

// Bảo vệ route và phân quyền theo vai trò
const ProtectedRoute = ({ children, roles, denyRestricted }: { children: React.ReactNode, roles?: string[], denyRestricted?: boolean }) => {
  const user = authService.getUser();
  
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  
  if (denyRestricted && user.is_restricted) {
    // Nếu trang cấm restricted admin (admin trạm con), đưa về Dashboard
    return <Navigate to="/dashboard" replace />;
  }
  
  const hasRole = !roles || roles.includes(user.role);
  if (!hasRole) {
    // Nếu user không có quyền truy cập trang này, đưa về Dashboard
    return <Navigate to="/dashboard" replace />;
  }
  
  return <>{children}</>;
};

const IndexRedirect = () => {
  return <Navigate to="/dashboard" replace />;
};

const ScreenLoader = () => {
  const bg = '#f1f5f9';
  const text = '#0f172a';
  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: bg,
      color: text,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'monospace',
      fontSize: '14px',
      fontWeight: 'bold',
      zIndex: 9999
    }}>
      Loading...
    </div>
  );
};

function SsoAutoLogin() {
  const location = useLocation();
  const navigate = useNavigate();
  const setSession = useAuthStore(s => s.setSession);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');

    if (token) {
      try {
        // Decode JWT payload
        const base64url = token.split('.')[1] ?? '';
        const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const payload = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));

        const user: User = {
          user_id: payload['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'] ?? '',
          username: payload['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] ?? 'sso_user',
          fullname: payload['fullName'] ?? 'SSO User',
          email: '',
          role: (payload['http://schemas.microsoft.com/ws/2008/06/identity/claims/role'] ?? 'operator') as UserRole,
          active: true,
          created_at: new Date().toISOString(),
          is_restricted: payload['isRestricted'] === 'true' || !!payload['stationIds'],
          station_ids: payload['stationIds'] ? payload['stationIds'].split(',') : undefined
        };

        // Lưu thông tin phiên đăng nhập
        setSession(user, token);
        localStorage.setItem('station_token', token);

        // Xóa tham số token khỏi URL để bảo mật và chuyển hướng người dùng
        const nextPath = params.get('next');
        params.delete('token');
        const searchStr = params.toString();

        let targetPath = location.pathname;
        if (location.pathname === '/login' || location.pathname === '/') {
          targetPath = nextPath || '/dashboard';
        }

        const cleanUrl = targetPath + (searchStr ? `?${searchStr}` : '') + location.hash;
        
        // Cập nhật URL và chuyển hướng người dùng
        window.history.replaceState({}, document.title, cleanUrl);
        navigate(cleanUrl, { replace: true });
      } catch (error) {
        console.error('Lỗi giải mã token SSO:', error);
      }
    }
  }, [location, setSession, navigate]);

  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <SsoAutoLogin />
      {/* Suspense hiển thị fallback trong khi chunk JS đang tải */}
      <Suspense fallback={<ScreenLoader />}>
        <Routes>
          {/* Trang đăng nhập — không cần xác thực */}
          <Route path="/login" element={<LoginPage />} />

          {/* AppShell bọc toàn bộ layout (sidebar + header + content) */}
          <Route path="/" element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
            <Route index element={<IndexRedirect />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="realtime" element={<RealtimeMonitorPage />} />
            <Route path="alerts-history" element={<AlertsHistoryPage />} />
            <Route path="alert-detail" element={<AlertDetailPage />} />

            {/* Analytics — internal tabs, no nested routes */}
            <Route path="analytics" element={<AnalyticsLayout />} />

            <Route path="reports" element={<ProtectedRoute roles={['admin', 'manager']}><ReportsPage /></ProtectedRoute>} />
            <Route path="maintenance" element={<ProtectedRoute roles={['admin', 'manager']}><MaintenancePage /></ProtectedRoute>} />
             <Route path="audit-log" element={<ProtectedRoute roles={['admin']}><AuditLogPage /></ProtectedRoute>} />
             <Route path="device-management" element={<ProtectedRoute roles={['admin']}><DeviceManagementPage /></ProtectedRoute>} />
             <Route path="device-management/:deviceId/thermal-config" element={<ProtectedRoute roles={['admin']}><ThermalConfigPage /></ProtectedRoute>} />
             <Route path="user-management" element={<ProtectedRoute roles={['admin']}><UserManagementPage /></ProtectedRoute>} />
             <Route path="settings" element={<ProtectedRoute roles={['admin']} denyRestricted><SettingsPage /></ProtectedRoute>} />
             <Route path="license" element={<ProtectedRoute roles={['admin']} denyRestricted><LicensePage /></ProtectedRoute>} />
             <Route path="*" element={<div style={{color:'var(--admin-text)', padding:20}}>404 - Page not found</div>} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
