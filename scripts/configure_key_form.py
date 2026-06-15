#!/usr/bin/env python3
# ============================================================
# configure_key_form.py — Trình cấu hình License Key
# Khởi chạy một giao diện web cục bộ để nhập và kích hoạt License Key
# ============================================================

import os
import json
import urllib.request
import urllib.error
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 8502

HTML_TEMPLATE = """<!DOCTYPE html>
<html>
<head>
    <title>StationMonitor - Cấu hình License Key</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
            background-color: #080d08;
            color: #e2e8f0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
            background-image: radial-gradient(circle at top right, rgba(16, 185, 129, 0.05), transparent 400px),
                              radial-gradient(circle at bottom left, rgba(14, 165, 233, 0.05), transparent 400px);
        }
        .card {
            background: rgba(30, 41, 59, 0.7);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            padding: 30px;
            border-radius: 16px;
            box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.7);
            width: 100%;
            max-width: 500px;
            border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .header {
            text-align: center;
            margin-bottom: 25px;
        }
        .logo {
            width: 48px;
            height: 48px;
            margin: 0 auto 12px;
            background: linear-gradient(135deg, #10b981, #0ea5e9);
            border-radius: 12px;
            display: flex;
            justify-content: center;
            align-items: center;
            box-shadow: 0 0 20px rgba(16, 185, 129, 0.3);
        }
        .logo svg {
            width: 24px;
            height: 24px;
            fill: #fff;
        }
        h1 {
            font-size: 22px;
            margin: 0 0 6px 0;
            background: linear-gradient(135deg, #4ade80, #38bdf8);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            font-weight: 700;
        }
        .subtitle {
            font-size: 13px;
            color: #94a3b8;
            margin: 0;
        }
        .form-group {
            margin-bottom: 18px;
        }
        label {
            display: block;
            margin-bottom: 6px;
            font-size: 13px;
            color: #cbd5e1;
            font-weight: 600;
        }
        input {
            width: 100%;
            padding: 11px 14px;
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            background-color: rgba(15, 23, 42, 0.6);
            color: #fff;
            box-sizing: border-box;
            font-size: 14px;
            transition: all 0.2s;
        }
        input:focus {
            outline: none;
            border-color: #10b981;
            box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.15);
            background-color: rgba(15, 23, 42, 0.8);
        }
        .row {
            display: flex;
            gap: 15px;
        }
        .row > div {
            flex: 1;
        }
        .btn-submit {
            width: 100%;
            padding: 13px;
            background: linear-gradient(135deg, #10b981, #059669);
            color: #fff;
            border: none;
            border-radius: 8px;
            font-weight: 700;
            cursor: pointer;
            margin-top: 15px;
            font-size: 14px;
            letter-spacing: 0.03em;
            transition: all 0.2s;
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.2);
        }
        .btn-submit:hover {
            opacity: 0.95;
            transform: translateY(-1px);
            box-shadow: 0 6px 16px rgba(16, 185, 129, 0.3);
        }
        .btn-submit:active {
            transform: translateY(0);
        }
        .alert {
            padding: 12px 16px;
            border-radius: 8px;
            font-size: 13.5px;
            margin-bottom: 20px;
            line-height: 1.4;
            display: none;
        }
        .alert-error {
            background-color: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.25);
            color: #f87171;
        }
        .alert-success {
            background-color: rgba(16, 185, 129, 0.1);
            border: 1px solid rgba(16, 185, 129, 0.25);
            color: #4ade80;
        }
        .status-container {
            margin-bottom: 20px;
            padding: 12px 16px;
            border-radius: 8px;
            background-color: rgba(255, 255, 255, 0.02);
            border: 1px solid rgba(255, 255, 255, 0.05);
            font-size: 12px;
            color: #94a3b8;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .status-badge {
            padding: 2px 8px;
            border-radius: 12px;
            font-weight: bold;
            font-size: 11px;
            text-transform: uppercase;
        }
        .status-active {
            background-color: rgba(16, 185, 129, 0.15);
            color: #4ade80;
        }
        .status-demo {
            background-color: rgba(234, 179, 8, 0.15);
            color: #facc15;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="header">
            <div class="logo">
                <svg viewBox="0 0 24 24">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
                </svg>
            </div>
            <h1>Cấu hình License Key</h1>
            <p class="subtitle">Nhập thông tin kích hoạt hệ thống StationOS</p>
        </div>

        <div id="statusBox" class="status-container">
            <span>Trạng thái hệ thống:</span>
            <span id="statusText" class="status-badge status-demo">Đang kiểm tra...</span>
        </div>

        <div id="alertBox" class="alert"></div>

        <form id="configForm" onsubmit="submitForm(event)">
            <div class="row">
                <div class="form-group">
                    <label for="username">Tài khoản quản trị</label>
                    <input type="text" id="username" value="admin" required>
                </div>
                <div class="form-group">
                    <label for="password">Mật khẩu</label>
                    <input type="password" id="password" value="Admin@123" required>
                </div>
            </div>

            <div class="form-group">
                <label for="licenseKey">License Key được cấp</label>
                <input type="text" id="licenseKey" placeholder="SOLO-YYMMDD-XXXX-XXXXXXXX..." required autocomplete="off" spellcheck="false">
            </div>

            <button type="submit" id="btnSubmit" class="btn-submit">KÍCH HOẠT LICENSE</button>
        </form>
    </div>

    <script>
        async function fetchStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                const badge = document.getElementById('statusText');
                if (data.activated) {
                    badge.innerText = 'ĐÃ KÍCH HOẠT (' + data.tier.toUpperCase() + ')';
                    badge.className = 'status-badge status-active';
                } else {
                    badge.innerText = 'DÙNG THỬ / CHƯA KÍCH HOẠT';
                    badge.className = 'status-badge status-demo';
                }
            } catch (err) {
                const badge = document.getElementById('statusText');
                badge.innerText = 'LỖI KẾT NỐI API';
                badge.className = 'status-badge status-error';
            }
        }

        async function submitForm(e) {
            e.preventDefault();
            const alertBox = document.getElementById('alertBox');
            const btn = document.getElementById('btnSubmit');
            
            alertBox.style.display = 'none';
            btn.disabled = true;
            btn.innerText = 'ĐANG XỬ LÝ...';

            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const key = document.getElementById('licenseKey').value.trim();

            try {
                const res = await fetch('/api/activate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password, key })
                });
                
                const data = await res.json();
                
                if (res.ok) {
                    alertBox.className = 'alert alert-success';
                    alertBox.innerText = data.message || 'Kích hoạt thành công!';
                    alertBox.style.display = 'block';
                    fetchStatus();
                } else {
                    alertBox.className = 'alert alert-error';
                    alertBox.innerText = 'Lỗi: ' + (data.error || 'Yêu cầu thất bại');
                    alertBox.style.display = 'block';
                }
            } catch (err) {
                alertBox.className = 'alert alert-error';
                alertBox.innerText = 'Không thể kết nối đến máy chủ API: ' + err.message;
                alertBox.style.display = 'block';
            } finally {
                btn.disabled = false;
                btn.innerText = 'KÍCH HOẠT LICENSE';
            }
        }

        fetchStatus();
    </script>
</body>
</html>
"""

class KeyConfigHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Tắt log để giao diện terminal gọn gàng
        return

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML_TEMPLATE.encode("utf-8"))
        elif self.path == "/api/status":
            try:
                # Forward to StationOS backend
                req = urllib.request.Request("http://127.0.0.1:5000/api/v1/license/status")
                with urllib.request.urlopen(req, timeout=5) as response:
                    res_data = response.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(res_data)
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/api/activate":
            content_length = int(self.headers["Content-Length"])
            post_data = self.rfile.read(content_length)
            
            try:
                data = json.loads(post_data.decode("utf-8"))
                username = data.get("username", "").strip()
                password = data.get("password", "").strip()
                key = data.get("key", "").strip()

                if not username or not password or not key:
                    raise ValueError("Vui lòng điền đầy đủ thông tin tài khoản và license key")

                # Step 1: Đăng nhập để lấy JWT token
                login_payload = json.dumps({"Username": username, "Password": password}).encode("utf-8")
                login_req = urllib.request.Request(
                    "http://127.0.0.1:5000/api/v1/auth/login",
                    data=login_payload,
                    headers={"Content-Type": "application/json"}
                )
                
                try:
                    with urllib.request.urlopen(login_req, timeout=5) as response:
                        login_res = json.loads(response.read().decode("utf-8"))
                        token = login_res.get("token")
                except urllib.error.HTTPError as e:
                    try:
                        err_data = json.loads(e.read().decode("utf-8"))
                        error_msg = err_data.get("message") or err_data.get("error") or "Sai tài khoản hoặc mật khẩu"
                    except:
                        error_msg = f"Đăng nhập thất bại (HTTP {e.code})"
                    raise ValueError(error_msg)

                if not token:
                    raise ValueError("Không lấy được token đăng nhập")

                # Step 2: Gửi yêu cầu kích hoạt License lên Backend
                activate_payload = json.dumps({"Key": key}).encode("utf-8")
                activate_req = urllib.request.Request(
                    "http://127.0.0.1:5000/api/v1/license/activate",
                    data=activate_payload,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {token}"
                    }
                )

                try:
                    with urllib.request.urlopen(activate_req, timeout=5) as response:
                        activate_res = json.loads(response.read().decode("utf-8"))
                        message = activate_res.get("message") or "Kích hoạt license thành công!"
                except urllib.error.HTTPError as e:
                    try:
                        err_data = json.loads(e.read().decode("utf-8"))
                        error_msg = err_data.get("message") or err_data.get("error") or f"Lỗi HTTP {e.code}"
                    except:
                        error_msg = f"Lỗi kích hoạt (HTTP {e.code})"
                    raise ValueError(error_msg)

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"message": message}).encode("utf-8"))

            except Exception as e:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

def main():
    server = HTTPServer(("localhost", PORT), KeyConfigHandler)
    url = f"http://localhost:{PORT}"
    
    print("=" * 60)
    # Print program information
    print(f" CỔNG THIẾT LẬP LICENSE KEY STATIONOS ĐANG CHẠY")
    print(f" Vui lòng truy cập: {url}")
    print("=" * 60)
    print(" -> Tự động mở trình duyệt... (Bấm Ctrl + C ở đây để dừng)")
    
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n Đã dừng máy chủ thiết lập License Key.")

if __name__ == "__main__":
    main()
