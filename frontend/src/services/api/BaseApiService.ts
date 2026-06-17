import { authService } from '../AuthService';
import { useAuthStore } from '@/store/authStore';
import { API_BASE_URL } from '@/utils/env';

export const API_BASE = `${API_BASE_URL}/api/v1`;

let refreshPromise: Promise<string | null> | null = null;

async function performRefresh(): Promise<string | null> {
  const store = useAuthStore.getState();
  const refreshToken = store.refreshToken;
  if (!refreshToken) {
    store.clearSession();
    return null;
  }

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      store.clearSession();
      return null;
    }

    const data = await res.json();
    const token: string = data.token ?? '';
    const newRefreshToken = data.refreshToken ?? '';

    // Decode JWT payload để lấy thông tin user
    const base64url = token.split('.')[1] ?? '';
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));

    const user = {
      user_id: payload['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'] ?? '',
      username: payload['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] ?? '',
      fullname: payload['fullName'] ?? '',
      email: '',
      role: payload['http://schemas.microsoft.com/ws/2008/06/identity/claims/role'] ?? 'operator',
      active: true,
      created_at: new Date().toISOString(),
      is_restricted: payload['isRestricted'] === 'true' || !!payload['stationIds'],
      station_ids: payload['stationIds'] ? payload['stationIds'].split(',') : undefined,
    };

    store.setSession(user, token, newRefreshToken);
    return token;
  } catch (err) {
    store.clearSession();
    return null;
  }
}

async function getValidToken(): Promise<string | null> {
  const token = authService.getToken();
  if (!token) return null;

  try {
    const base64url = token.split('.')[1] ?? '';
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));
    
    // Nếu token sắp hết hạn trong vòng 10 giây -> làm mới chủ động
    const exp = payload.exp * 1000;
    if (Date.now() + 10000 >= exp) {
      if (!refreshPromise) {
        refreshPromise = performRefresh().finally(() => {
          refreshPromise = null;
        });
      }
      return await refreshPromise;
    }
  } catch {
    if (!refreshPromise) {
      refreshPromise = performRefresh().finally(() => {
        refreshPromise = null;
      });
    }
    return await refreshPromise;
  }

  return token;
}

/** GET request với Bearer token tự động. Tự động làm mới và thử lại nếu token hết hạn. */
export async function apiFetch<T>(path: string): Promise<T> {
  let token = await getValidToken();
  let res = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });

  if (res.status === 401) {
    if (!refreshPromise) {
      refreshPromise = performRefresh().finally(() => {
        refreshPromise = null;
      });
    }
    token = await refreshPromise;
    if (token) {
      res = await fetch(`${API_BASE}${path}`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` }
      });
    } else {
      useAuthStore.getState().clearSession();
    }
  }

  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

/** POST/PUT/PATCH/DELETE với JSON body và Bearer token. Tự động làm mới và thử lại nếu token hết hạn. */
export async function apiMutate<T = any>(method: string, path: string, body?: object): Promise<T> {
  let token = await getValidToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };

  let res = await fetch(`${API_BASE}${path}`, {
    method,
    cache: 'no-store',
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (res.status === 401) {
    if (!refreshPromise) {
      refreshPromise = performRefresh().finally(() => {
        refreshPromise = null;
      });
    }
    token = await refreshPromise;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      res = await fetch(`${API_BASE}${path}`, {
        method,
        cache: 'no-store',
        headers,
        body: body ? JSON.stringify(body) : undefined
      });
    } else {
      useAuthStore.getState().clearSession();
    }
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `${method} ${path} → ${res.status}`);
  }
  if (res.status === 204) return null as T;
  return res.json();
}
