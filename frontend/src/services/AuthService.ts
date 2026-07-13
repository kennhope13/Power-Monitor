// ============================================================
// AuthService – Kết nối backend thật qua REST API
// POST /api/v1/auth/login → JWT token
// ============================================================

import type { User, UserRole } from '@/types/api.types';
import { API_BASE_URL } from '@/utils/env';
import { useAuthStore } from '@/store/authStore';

// Tự tính API_BASE để tránh circular import với BaseApiService
const API_BASE = `${API_BASE_URL}/api/v1`;

/**
 * Dịch vụ xác thực người dùng — xử lý đăng nhập, đăng xuất và quản lý phiên JWT.
 */
class AuthService {
    /**
     * Đăng nhập bằng tên đăng nhập và mật khẩu, lưu JWT token vào store và localStorage.
     */
    public async login(username: string, password: string): Promise<{ success: boolean; error?: string; licenseReason?: string }> {
        try {
            const res = await fetch(`${API_BASE}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });

            if (!res.ok) {
                let errorMsg = 'Sai tên đăng nhập hoặc mật khẩu';
                try {
                    const errData = await res.json();
                    if (errData && errData.message) {
                        errorMsg = errData.message;
                    }
                } catch {}
                return { success: false, error: errorMsg };
            }

            const data = await res.json();
            const token: string = data.token ?? '';

            // Decode JWT payload
            const base64url = token.split('.')[1] ?? '';
            const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
            const jsonBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            const payload = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));
            
            const user: User = {
                user_id: payload['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'] ?? '',
                username: payload['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] ?? username,
                fullname: payload['fullName'] ?? username,
                email: '',
                role: (payload['http://schemas.microsoft.com/ws/2008/06/identity/claims/role'] ?? 'operator') as UserRole,
                active: true,
                created_at: new Date().toISOString(),
                is_restricted: payload['isRestricted'] === 'true' || !!payload['stationIds'],
                station_ids: payload['stationIds'] ? payload['stationIds'].split(',') : undefined
            };

            const refreshToken = data.refreshToken ?? '';

            // Cập nhật Zustand Store
            useAuthStore.getState().setSession(user, token, refreshToken);
            
            // Mirror token to localStorage for backward compatibility with other tabs/components
            localStorage.setItem('station_token', token);
            
            return { success: true, licenseReason: data.licenseReason ?? '' };

        } catch (err) {
            return { success: false, error: 'Không thể kết nối tới máy chủ' };
        }
    }

    /** Đăng xuất — xóa phiên khỏi store và localStorage. */
    public async logout(): Promise<void> {
        const token = this.getToken();
        if (token) {
            try {
                await fetch(`${API_BASE}/auth/logout`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });
            } catch (err) {
                console.warn('Backend logout failed:', err);
            }
        }
        useAuthStore.getState().clearSession();
        localStorage.removeItem('station_token');
    }

    /** Trả về JWT token hiện tại từ store, hoặc null nếu chưa đăng nhập. */
    public getToken(): string | null {
        return useAuthStore.getState().token;
    }

    /** Trả về thông tin người dùng hiện tại từ store, hoặc null nếu chưa đăng nhập. */
    public getUser(): User | null {
        return useAuthStore.getState().user;
    }

    /** Kiểm tra người dùng hiện tại đã xác thực hay chưa. */
    public isAuthenticated(): boolean {
        return useAuthStore.getState().isAuthenticated;
    }

    /** Kiểm tra người dùng hiện tại có thuộc ít nhất một trong các vai trò cho trước. */
    public hasRole(...roles: UserRole[]): boolean {
        const user = this.getUser();
        return user ? roles.includes(user.role) : false;
    }

    /** Kiểm tra người dùng hiện tại có quyền cụ thể hay không. */
    public hasPermission(permissionKey: string): boolean {
        const user = this.getUser();
        if (!user) return false;
        if (user.role === 'admin') return true;
        return false;
    }

    /** Refresh session silently using the stored refreshToken. */
    public async refreshSession(): Promise<boolean> {
        const refreshToken = useAuthStore.getState().refreshToken;
        if (!refreshToken) return false;

        try {
            const res = await fetch(`${API_BASE}/auth/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken }),
            });

            if (!res.ok) {
                await this.logout();
                return false;
            }

            const data = await res.json();
            const token: string = data.token ?? '';

            // Decode JWT payload
            const base64url = token.split('.')[1] ?? '';
            const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
            const jsonBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            const payload = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));
            
            const uName = payload['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] ?? data.user?.username ?? '';
            const fName = payload['fullName'] ?? data.user?.fullName ?? uName;

            const user: User = {
                user_id: payload['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'] ?? '',
                username: uName,
                fullname: fName,
                email: '',
                role: (payload['http://schemas.microsoft.com/ws/2008/06/identity/claims/role'] ?? 'operator') as UserRole,
                active: true,
                created_at: new Date().toISOString(),
                is_restricted: payload['isRestricted'] === 'true' || !!payload['stationIds'],
                station_ids: payload['stationIds'] ? payload['stationIds'].split(',') : undefined
            };

            const newRefreshToken = data.refreshToken ?? '';

            // Cập nhật Zustand Store
            useAuthStore.getState().setSession(user, token, newRefreshToken);
            
            // Mirror token to localStorage for backward compatibility
            localStorage.setItem('station_token', token);
            
            return true;
        } catch (err) {
            console.error('[AuthService] silent refresh error:', err);
            return false;
        }
    }

    /** Đổi mật khẩu của người dùng hiện tại */
    public async changePassword(oldPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
        const token = this.getToken();
        if (!token) return { success: false, error: 'Chưa đăng nhập hoặc phiên làm việc đã hết hạn' };
        
        try {
            const res = await fetch(`${API_BASE}/auth/change-password`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ oldPassword, newPassword }),
            });

            if (!res.ok) {
                let errorMsg = 'Đổi mật khẩu thất bại';
                try {
                    const errData = await res.json();
                    if (errData && errData.message) {
                        errorMsg = errData.message;
                    }
                } catch {}
                return { success: false, error: errorMsg };
            }

            return { success: true };
        } catch (err) {
            return { success: false, error: 'Không thể kết nối tới máy chủ' };
        }
    }
}

export const authService = new AuthService();
