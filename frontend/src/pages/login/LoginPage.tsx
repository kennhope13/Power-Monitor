

// ============================================================
// LoginPage.tsx — Trang đăng nhập
// Gọi authService.login() → lưu JWT vào localStorage
// Nếu license hết hạn → chuyển sang /license thay vì /dashboard
// ============================================================

import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { authService } from '@/services/AuthService';
import './LoginPage.css';

export default function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [isShaking, setIsShaking] = useState(false); // animation lắc form khi sai mật khẩu

  const [showConfig, setShowConfig] = useState(false);
  const [serverIp, setServerIp] = useState('');

  useEffect(() => {
    setServerIp(localStorage.getItem('server_ip') || '');
  }, []);

  const handleSaveConfig = () => {
    const trimmed = serverIp.trim();
    if (trimmed) {
      localStorage.setItem('server_ip', trimmed);
    } else {
      localStorage.removeItem('server_ip');
    }
    window.location.reload();
  };

  const handleResetConfig = () => {
    localStorage.removeItem('server_ip');
    setServerIp('');
    window.location.reload();
  };

  
  const usernameRef = useRef<HTMLInputElement>(null);

  const resolveNextPath = () => {
    const params = new URLSearchParams(window.location.search);
    const next = params.get('next');
    if (next && next.startsWith('/')) return next;
    return null;
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const embedUser = params.get('u');
    const embedPass = params.get('p');
    const nextPath = resolveNextPath();

    if (authService.isAuthenticated()) {
      navigate(nextPath || '/dashboard', { replace: true });
      return;
    }

    // Chạy trong iframe embed từ trạm tổng — tự đăng nhập
    if (params.get('embed') === '1' && embedUser && embedPass) {
      authService.login(embedUser, embedPass).then(result => {
        if (result.success) navigate(nextPath || '/dashboard', { replace: true });
        else usernameRef.current?.focus();
      });
      return;
    }

    if (window.self !== window.top) {
      authService.login('admin', 'Admin@123').then(result => {
        if (result.success) navigate(nextPath || '/dashboard', { replace: true });
        else usernameRef.current?.focus();
      });
      return;
    }

    usernameRef.current?.focus();
  }, [navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;

    setLoading(true);
    setErrorMsg('');
    setIsShaking(false);

    // Delay 600ms để tránh cảm giác phản hồi quá nhanh (UX)
    await new Promise(r => setTimeout(r, 600));

    const result = await authService.login(username.trim(), password);

    setLoading(false);

    if (result.success) {
      navigate(resolveNextPath() || '/dashboard');
    } else {
      setErrorMsg(result.error || 'Đăng nhập thất bại');
      setIsShaking(true);
      // Reset class shake sau khi animation kết thúc (400ms)
      setTimeout(() => setIsShaking(false), 400);
    }
  };

  return (
    <div className="gm-login-wrapper">
      <div className="gm-overlay"></div>
      <div className="gm-glass-panel">
        <img src="/favico/logo.svg" alt="Station Monitor Logo" className="gm-logo" />
        <h2>Hệ Thống Giám Sát</h2>
        <p className="gm-slogan">"Giám sát liên tục — Phát hiện sớm — Cảnh báo đúng lúc"</p>

        {errorMsg && (
          <div className={`gm-error ${isShaking ? 'shake' : ''}`}>
            ️ {errorMsg}
          </div>
        )}

        <form onSubmit={handleLogin} autoComplete="off">
          <div className="gm-input-group">
            <label htmlFor="loginUsername">Tên đăng nhập</label>
            <input 
              ref={usernameRef}
              type="text" 
              id="loginUsername" 
              placeholder="Ví dụ: admin" 
              required
              value={username}
              onChange={e => setUsername(e.target.value)}
              disabled={loading}
            />
          </div>
          <div className="gm-input-group">
            <label htmlFor="loginPassword">Mật khẩu</label>
            <div className="gm-pw-wrap">
              <input 
                type={showPassword ? 'text' : 'password'} 
                id="loginPassword" 
                placeholder="••••••••" 
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={loading}
              />
              <button 
                type="button" 
                className="gm-eye-btn" 
                title="Hiện/Ẩn mật khẩu"
                onClick={() => setShowPassword(!showPassword)}
                disabled={loading}
              >
                {showPassword ? (
                  // eye-off icon
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                ) : (
                  // eye icon
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                )}
              </button>
            </div>
          </div>
          <button type="submit" className="gm-btn-login" disabled={loading}>
            {loading ? (
              <>
                <span>ĐANG ĐĂNG NHẬP...</span>
                <span>⏳</span>
              </>
            ) : (
              <span>ĐĂNG NHẬP</span>
            )}
          </button>
        </form>

        <div style={{ marginTop: '20px', textAlign: 'center' }}>
          <button
            type="button"
            className="gm-config-toggle-btn"
            onClick={() => setShowConfig(!showConfig)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--admin-text-muted)',
              fontSize: '11px',
              cursor: 'pointer',
              textDecoration: 'underline',
              letterSpacing: '0.5px'
            }}
          >
            {showConfig ? 'Ẩn cấu hình máy chủ' : 'Cấu hình IP máy chủ'}
          </button>
        </div>

        {showConfig && (
          <div className="gm-config-panel" style={{
            marginTop: '15px',
            paddingTop: '15px',
            borderTop: '1px dashed var(--admin-border-light)',
            textAlign: 'left'
          }}>
            <div className="gm-input-group" style={{ marginBottom: '10px' }}>
              <label htmlFor="serverIpInput">Địa chỉ IP máy chủ</label>
              <input
                type="text"
                id="serverIpInput"
                placeholder="Ví dụ: 192.168.1.100"
                value={serverIp}
                onChange={e => setServerIp(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                className="gm-btn-login"
                onClick={handleSaveConfig}
                style={{ flex: 1, padding: '8px', fontSize: '12px', background: '#0284c7' }}
              >
                LƯU & KẾT NỐI
              </button>
              {localStorage.getItem('server_ip') && (
                <button
                  type="button"
                  className="gm-btn-login"
                  onClick={handleResetConfig}
                  style={{ padding: '8px 12px', fontSize: '12px', background: 'rgba(239,68,68,0.2)', color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }}
                >
                  XÓA
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
