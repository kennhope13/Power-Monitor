const { app, BrowserWindow, Menu } = require('electron');
const { spawn, spawnSync }  = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const http  = require('http');
const https = require('https');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-setuid-sandbox');

// ── File logger ──────────────────────────────
const LOG_FILE = path.join(os.homedir(), 'Desktop', 'station-monitor.log');
const _logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(...args) {
  const msg = args.join(' ');
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  _logStream.write(line);
}
process.on('uncaughtException', (err) => log('[CRASH]', err.stack || err));
process.on('unhandledRejection', (err) => log('[REJECT]', err?.stack || err));

let mainWindow   = null;
let localUiServer = null;
let localUiPort = null;

function getTargetUrl() {
  return app.isPackaged
    ? `http://127.0.0.1:${localUiPort ?? 4173}`
    : 'http://localhost:5173';
}

// ─────────────────────────────────────────────
// Tìm thư mục gốc của project (có start-all.sh)
// ─────────────────────────────────────────────
function findProjectRoot() {
  const isWindows = process.platform === 'win32';
  const candidates = [];

  if (isWindows && app.isPackaged) {
    candidates.push(process.resourcesPath);
  }

  if (process.env.APPIMAGE) {
    candidates.push(path.resolve(path.dirname(process.env.APPIMAGE), '..', '..'));
  }
  candidates.push(path.resolve(__dirname, '..', '..', '..'));
  candidates.push(path.join(os.homedir(), 'Desktop', 'Power-Monitor'));

  for (const c of candidates) {
    if (isWindows) {
      if (fs.existsSync(path.join(c, 'backend', 'StationOS.Api.exe'))) return c;
    } else {
      if (fs.existsSync(path.join(c, 'start-all.sh'))) return c;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// Kiểm tra xem backend service đã chạy sẵn chưa
// ─────────────────────────────────────────────
function checkIfServicesRunning() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:5000/health', (res) => {
      res.destroy();
      resolve(true);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.setTimeout(400, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ─────────────────────────────────────────────
// Spawn start-all.sh (detached — thoát Electron không kill services)
// ─────────────────────────────────────────────
function spawnHiddenWin32(exePath, args, cwd, logPath) {
  const escapedExe = exePath.replace(/'/g, "''");
  const escapedCwd = cwd.replace(/'/g, "''");
  const escapedLog = logPath ? logPath.replace(/'/g, "''") : null;
  
  const argListStr = args.length 
    ? `-ArgumentList ${args.map(a => `'${a.replace(/'/g, "''")}'`).join(',')}` 
    : '';
    
  const redirectStr = escapedLog 
    ? `-RedirectStandardOutput '${escapedLog}' -RedirectStandardError '${escapedLog}'` 
    : '';

  const psCommand = `Start-Process -FilePath '${escapedExe}' ${argListStr} -WorkingDirectory '${escapedCwd}' ${redirectStr} -WindowStyle Hidden`;
  
  log('[spawnHiddenWin32] Running PS command:', psCommand);
  
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
    windowsHide: true,
    stdio: 'ignore'
  });
  proc.unref();
}

function startAllServices(root) {
  console.log('[Station Monitor] Khởi động services từ:', root);
  const env = { 
    ...process.env, 
    STATION_ELECTRON_NO_FRONTEND: app.isPackaged ? '1' : '0',
    ASPNETCORE_URLS: 'http://127.0.0.1:5000'
  };
  
  if (process.platform === 'win32') {
    const userData = app.getPath('userData');
    const pgDataDir = path.join(userData, 'pg_data');
    const pgBinDir = path.join(root, 'pg_portable', 'bin');
    
    if (!fs.existsSync(pgDataDir)) {
      log('Khởi tạo database mới tại:', pgDataDir);
      try {
        spawnSync(path.join(pgBinDir, 'initdb.exe'), ['-D', pgDataDir, '-U', 'postgres', '-E', 'UTF8', '--locale=C', '--auth=trust'], { stdio: 'ignore', windowsHide: true });
      } catch (e) {
        log('Lỗi initdb:', e.message);
      }
    }
    
    spawnHiddenWin32(
      path.join(pgBinDir, 'pg_ctl.exe'),
      ['-D', pgDataDir, '-l', path.join(userData, 'postgres.log'), 'start'],
      path.join(root, 'pg_portable'),
      null
    );

    spawnHiddenWin32(
      path.join(root, 'backend', 'StationOS.Api.exe'),
      [],
      path.join(root, 'backend'),
      path.join(userData, 'backend.log')
    );

    spawnHiddenWin32(
      path.join(root, 'go2rtc', 'go2rtc.exe'),
      [],
      path.join(root, 'go2rtc'),
      path.join(userData, 'go2rtc.log')
    );
    
    log('[Station Monitor] Đã kích hoạt PostgreSQL, Backend và go2rtc trên Windows.');
  } else {
    const proc = spawn('bash', ['start-all.sh'], {
      cwd: root,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    proc.unref();
  }
}

// ─────────────────────────────────────────────
// Poll cho đến khi cả UI server và Backend API (port 5000) sẵn sàng
// ─────────────────────────────────────────────
function waitForServer(onReady) {
  const targetUrl = getTargetUrl();
  
  const check = () => {
    const client = targetUrl.startsWith('https://') ? https : http;
    const req = client.get(targetUrl, (res) => {
      res.destroy();
      
      // UI Server đã sẵn sàng, tiếp tục kiểm tra Backend API (port 5000)
      const backendReq = http.get('http://127.0.0.1:5000/health', (backendRes) => {
        backendRes.destroy();
        log('[Station Monitor] Cả UI và Backend đều đã sẵn sàng.');
        onReady();
      });
      backendReq.on('error', () => {
        log('[Station Monitor] Giao diện sẵn sàng nhưng Backend chưa phản hồi. Đang đợi...');
        setTimeout(check, 1000);
      });
      backendReq.setTimeout(1000, () => {
        backendReq.destroy();
        setTimeout(check, 1000);
      });
    });
    
    req.on('error', () => {
      setTimeout(check, 1000);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      setTimeout(check, 1000);
    });
  };
  check();
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.ico': return 'image/x-icon';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

function pipeProxy(req, res, targetBase) {
  const url = new URL(req.url, targetBase);
  const client = url.protocol === 'https:' ? https : http;
  const proxyReq = client.request(url, {
    method: req.method,
    headers: req.headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Proxy error: ${err.message}`);
  });
  req.pipe(proxyReq);
}

function startLocalUiServer() {
  if (localUiServer) return Promise.resolve(localUiPort);

  const distDir = path.join(app.getAppPath(), 'dist');
  if (!fs.existsSync(distDir)) {
    throw new Error(`Không tìm thấy frontend dist tại ${distDir}`);
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = req.url || '/';

      if (reqUrl.startsWith('/api/') || reqUrl.startsWith('/media/') || reqUrl.startsWith('/ws/')) {
        pipeProxy(req, res, 'http://127.0.0.1:5000');
        return;
      }
      if (reqUrl === '/ai-api' || reqUrl.startsWith('/ai-api/')) {
        req.url = reqUrl.replace(/^\/ai-api/, '');
        pipeProxy(req, res, 'http://127.0.0.1:8100');
        return;
      }

      const safePath = decodeURIComponent(reqUrl.split('?')[0] || '/');
      const requested = safePath === '/' ? 'index.html' : safePath.replace(/^\/+/, '');
      let filePath = path.join(distDir, requested);

      if (!filePath.startsWith(distDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(distDir, 'index.html');
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': getMimeType(filePath), 'Cache-Control': 'no-cache' });
        res.end(data);
      });
    });

    server.on('error', reject);
    server.listen(4173, '0.0.0.0', () => {
      localUiServer = server;
      localUiPort = 4173;
      resolve(localUiPort);
    });
  });
}

// ─────────────────────────────────────────────
// Màn hình loading
// ─────────────────────────────────────────────
function loadingHTML(message) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    min-height:100vh;background:#0a0f1e;color:#f1f5f9;font-family:sans-serif;gap:20px;
  }
  body::before{
    content:'';position:fixed;inset:0;
    background-image:
      linear-gradient(rgba(59,130,246,0.04) 1px,transparent 1px),
      linear-gradient(90deg,rgba(59,130,246,0.04) 1px,transparent 1px);
    background-size:40px 40px;pointer-events:none;
  }
  .logo{
    width:64px;height:64px;
    background:linear-gradient(135deg,#1d4ed8,#3b82f6);
    border-radius:16px;display:flex;align-items:center;justify-content:center;
    box-shadow:0 0 30px rgba(59,130,246,0.4);
  }
  .logo svg{width:36px;height:36px;fill:white}
  h1{font-size:22px;font-weight:700;letter-spacing:-0.5px}
  p{font-size:13px;color:#64748b}
  .spinner{
    width:40px;height:40px;
    border:3px solid rgba(59,130,246,0.2);
    border-top-color:#3b82f6;
    border-radius:50%;animation:spin 1s linear infinite;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
  .msg{font-size:13px;color:#94a3b8}
</style>
</head>
<body>
  <div class="logo">
    <svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 14l-3-3 1.41-1.41L11 12.17l4.59-4.58L17 9l-6 6z"/></svg>
  </div>
  <h1>Station Monitor</h1>
  <div class="spinner"></div>
  <p class="msg">${message}</p>
</body>
</html>`);
}

// ─────────────────────────────────────────────
// Màn hình lỗi (không tìm thấy project)
// ─────────────────────────────────────────────
function errorHTML(msg) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"/>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;
    min-height:100vh;background:#0a0f1e;color:#f1f5f9;font-family:sans-serif;gap:16px;}
  h2{color:#ef4444;font-size:18px}
  p{font-size:13px;color:#94a3b8;max-width:400px;text-align:center;line-height:1.6}
</style></head>
<body>
  <h2>⚠️ Không tìm thấy dịch vụ</h2>
  <p>${msg}</p>
</body></html>`);
}

// ─────────────────────────────────────────────
// Tạo cửa sổ chính
// ─────────────────────────────────────────────
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900,
    minWidth: 1024, minHeight: 600,
    resizable: true, center: true,
    backgroundColor: '#0a0f1e',
    title: 'Hệ Thống Giám Sát — Station Monitor',
    darkTheme: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  log('createWindow() bắt đầu, isPackaged:', app.isPackaged);
  log('appPath:', app.getAppPath());

  mainWindow.maximize();
  mainWindow.focus();

  // loading.html được unpack ra ngoài asar → dùng real filesystem path
  const asarDir = app.getAppPath();
  const unpackedDir = asarDir.replace('app.asar', 'app.asar.unpacked');
  const loadingPath = path.join(unpackedDir, 'electron', 'loading.html');
  log('loadingPath:', loadingPath, 'exists:', fs.existsSync(loadingPath));
  try {
    if (fs.existsSync(loadingPath)) {
      await mainWindow.loadFile(loadingPath);
      log('loadFile loading.html OK');
    } else {
      await mainWindow.loadURL(loadingHTML('Đang khởi động...'));
      log('loadURL data: OK (fallback)');
    }
  } catch (err) {
    log('LOAD LOADING ERROR:', err.message);
  }

  const root = findProjectRoot();
  log('findProjectRoot:', root);
  
  if (!root) {
    await mainWindow.loadURL(errorHTML('Không tìm thấy thư mục dự án Power-Monitor.'));
    return;
  }

  // Khởi động services nếu chưa chạy
  const isRunning = await checkIfServicesRunning();
  if (!isRunning) {
    log('[Station Monitor] Services chưa chạy, tiến hành khởi động...');
    startAllServices(root);
  } else {
    log('[Station Monitor] Services đã chạy sẵn, bỏ qua bước khởi động.');
  }

  if (app.isPackaged) {
    log('isPackaged → startLocalUiServer...');
    const distDir = path.join(app.getAppPath(), 'dist');
    log('distDir:', distDir, 'exists:', fs.existsSync(distDir));
    try {
      await startLocalUiServer();
      log('localUiServer OK port:', localUiPort);
    } catch (err) {
      log('startLocalUiServer ERROR:', err.message);
      if (err.code === 'EADDRINUSE') {
        log('[Station Monitor] Cổng 4173 đã được sử dụng. Tiếp tục tải giao diện...');
      } else {
        await mainWindow.loadURL(errorHTML(`Không thể khởi động giao diện: ${err.message}`));
        return;
      }
    }
  }

  const targetUrl = getTargetUrl();
  log('targetUrl:', targetUrl, '→ polling...');

  // Đợi server lên rồi mở dashboard
  waitForServer(() => {
    log('server ready → loadURL', targetUrl);
    if (!mainWindow) return;
    mainWindow.loadURL(targetUrl)
      .then(() => log('loadURL success'))
      .catch(err => log('loadURL ERROR:', err.message));
  });

  // Bắt did-fail-load
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('did-fail-load:', code, desc, url);
  });

  // Bắt console logs từ renderer
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    log(`[CONSOLE L${level}] ${message} (${path.basename(sourceId)}:${line})`);
  });

  // Bắt renderer crash
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('Renderer gone:', details.reason, details.exitCode);
  });

  // F12 mở/đóng DevTools
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12') mainWindow.webContents.toggleDevTools();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─────────────────────────────────────────────
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (localUiServer) {
    try { localUiServer.close(); } catch {}
    localUiServer = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
