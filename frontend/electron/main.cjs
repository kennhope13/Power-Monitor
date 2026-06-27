const { app, BrowserWindow, Menu, nativeTheme } = require('electron');
const { spawn, execSync }  = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const http  = require('http');
const https = require('https');
const net   = require('net');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-setuid-sandbox');

// ── File logger ──────────────────────────────
const LOG_FILE = path.join(os.homedir(), 'Desktop', 'station-monitor.log');
const _logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
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
// Tìm thư mục gốc của project (có start-all.sh hoặc packaged resources)
// ─────────────────────────────────────────────
function isWindowsPackaged() {
  return app.isPackaged && process.platform === 'win32';
}

function findProjectRoot() {
  // Windows packaged mode: resources nằm trong process.resourcesPath
  if (isWindowsPackaged()) {
    const resPath = process.resourcesPath;
    log('[findProjectRoot] Windows packaged mode, resourcesPath:', resPath);
    return resPath; // chứa backend/, ai_engine/, frontend-dist/
  }

  const candidates = [];

  // 1. Khi chạy AppImage: APPIMAGE trỏ tới file .AppImage
  //    AppImage nằm tại <project>/frontend/dist-electron/
  if (process.env.APPIMAGE) {
    candidates.push(
      path.resolve(path.dirname(process.env.APPIMAGE), '..', '..')
    );
  }

  // 2. Khi chạy electron . trong dev: __dirname = <project>/frontend/electron/
  candidates.push(
    path.resolve(__dirname, '..', '..')
  );

  // 3. Fallback cứng
  candidates.push(
    path.join(os.homedir(), 'Desktop', 'Power-Monitor')
  );

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'start-all.sh'))) {
      return c;
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

function checkIfGo2RtcRunning() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:1984/api/streams', (res) => {
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
// Kiểm tra cổng mạng có bị chiếm dụng không
// ─────────────────────────────────────────────
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

// ─────────────────────────────────────────────
// Khởi tạo và chạy PostgreSQL di động (Portable)
// ─────────────────────────────────────────────
function startPortablePostgres(root) {
  return new Promise((resolve, reject) => {
    const pgDir = path.join(root, 'pg_portable');
    const pgDataDir = path.join(app.getPath('userData'), 'pg_data');
    const initdbExe = path.join(pgDir, 'bin', 'initdb.exe');
    const pgctlExe = path.join(pgDir, 'bin', 'pg_ctl.exe');

    log('[PG] Đang kiểm tra cơ sở dữ liệu di động...');
    log('[PG] Thư mục dữ liệu:', pgDataDir);

    const pgVersionFile = path.join(pgDataDir, 'PG_VERSION');
    const utf8FlagFile = path.join(pgDataDir, 'initialized_utf8.flag');

    // Nếu đã khởi tạo trước đó nhưng không có flag UTF-8 (phiên bản cũ bị lỗi mã hóa WIN1252),
    // tiến hành xóa sạch thư mục dữ liệu để khởi tạo lại từ đầu.
    if (fs.existsSync(pgDataDir) && !fs.existsSync(utf8FlagFile)) {
      log('[PG] Phát hiện database phiên bản cũ hoặc sai bảng mã (không có UTF-8 flag). Tiến hành xóa để làm sạch...');
      try {
        fs.rmSync(pgDataDir, { recursive: true, force: true });
        log('[PG] Đã xóa thư mục database cũ.');
      } catch (err) {
        log('[PG] Không thể xóa thư mục database cũ:', err.message);
      }
    }

    if (!fs.existsSync(pgDataDir)) {
      try {
        fs.mkdirSync(pgDataDir, { recursive: true });
      } catch (err) {
        log('[PG] Không thể tạo thư mục dữ liệu:', err.message);
        return reject(err);
      }
    }

    if (!fs.existsSync(pgVersionFile)) {
      log('[PG] Khởi tạo database lần đầu với bảng mã UTF-8...');
      const pwFile = path.join(os.tmpdir(), 'pg_pw.txt');
      try {
        fs.writeFileSync(pwFile, 'postgres123', 'utf8');
        // Sử dụng -E UTF8 và --locale=C để đảm bảo hỗ trợ tiếng Việt có dấu
        const initCmd = `"${initdbExe}" -U postgres --pwfile="${pwFile}" -D "${pgDataDir}" -E UTF8 --locale=C --auth-local=trust --auth-host=trust`;
        log('[PG] Chạy lệnh initdb:', initCmd);
        execSync(initCmd, { stdio: 'inherit', windowsHide: true });
        log('[PG] Khởi tạo database thành công.');

        // Ghi file flag để đánh dấu đã khởi tạo thành công với UTF-8
        fs.writeFileSync(utf8FlagFile, 'utf8_ok', 'utf8');
      } catch (err) {
        log('[PG] Lỗi khởi tạo database:', err.message);
        return reject(err);
      } finally {
        try { fs.unlinkSync(pwFile); } catch {}
      }
    } else {
      log('[PG] Database đã được khởi tạo trước đó và hợp lệ.');
    }

    log('[PG] Bắt đầu khởi động server database...');
    const logFile = path.join(app.getPath('userData'), 'pg_server.log');
    try {
      const startCmd = `"${pgctlExe}" -D "${pgDataDir}" -l "${logFile}" start`;
      log('[PG] Chạy lệnh pg_ctl start:', startCmd);
      execSync(startCmd, { stdio: 'inherit', windowsHide: true });
      log('[PG] Server database đã được gọi khởi động.');
    } catch (err) {
      log('[PG] Lỗi khởi động server database:', err.message);
      return reject(err);
    }

    // Đợi server sẵn sàng và tạo database StationOS
    (async () => {
      const psqlExe = path.join(pgDir, 'bin', 'psql.exe');
      let serverReady = false;
      for (let i = 0; i < 15; i++) {
        try {
          execSync(`"${psqlExe}" -U postgres -h 127.0.0.1 -d postgres -c "SELECT 1"`, { stdio: 'ignore', windowsHide: true });
          serverReady = true;
          log('[PG] Server database đã sẵn sàng nhận kết nối.');
          break;
        } catch (err) {
          log('[PG] Server database chưa sẵn sàng, đợi 1s...');
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (serverReady) {
        try {
          const createDbCmd = `"${psqlExe}" -U postgres -h 127.0.0.1 -d postgres -c "CREATE DATABASE \\"StationOS\\""`;
          log('[PG] Chạy lệnh tạo database:', createDbCmd);
          execSync(createDbCmd, { stdio: 'ignore', windowsHide: true });
          log('[PG] Đã đảm bảo database StationOS tồn tại.');
        } catch (err) {
          log('[PG] Database StationOS có thể đã tồn tại hoặc không thể tạo.');
        }
        resolve();
      } else {
        reject(new Error('Server database không phản hồi sau 15 giây.'));
      }
    })();
  });
}

// ─────────────────────────────────────────────
// Tắt PostgreSQL di động
// ─────────────────────────────────────────────
function stopPortablePostgres(root) {
  const pgDir = path.join(root, 'pg_portable');
  const pgDataDir = path.join(app.getPath('userData'), 'pg_data');
  const pgctlExe = path.join(pgDir, 'bin', 'pg_ctl.exe');

  if (fs.existsSync(pgDataDir) && fs.existsSync(pgctlExe)) {
    log('[PG] Đang tắt server database...');
    try {
      const stopCmd = `"${pgctlExe}" -D "${pgDataDir}" stop -m fast`;
      log('[PG] Chạy lệnh pg_ctl stop:', stopCmd);
      execSync(stopCmd, { stdio: 'inherit', windowsHide: true });
      log('[PG] Server database đã được tắt.');
    } catch (err) {
      log('[PG] Lỗi khi tắt database:', err.message);
    }
  }
}

// ─────────────────────────────────────────────
// Spawn services (detached — thoát Electron không kill services)
// ─────────────────────────────────────────────
let backendProc = null;
let aiProc = null;

function startAllServices(root) {
  log('[Station Monitor] Khởi động services từ:', root);
  const env = { ...process.env, STATION_ELECTRON_NO_FRONTEND: app.isPackaged ? '1' : '0' };

  if (isWindowsPackaged()) {
    const appDataPath = app.getPath('userData');
    const webRootPath = path.join(appDataPath, 'wwwroot');
    const subDirs = [
      '',
      'media',
      'media/buffer',
      'media/recordings',
      'detections',
      'reports',
      'sld'
    ];
    for (const sub of subDirs) {
      const fullPath = path.join(webRootPath, sub);
      if (!fs.existsSync(fullPath)) {
        try {
          fs.mkdirSync(fullPath, { recursive: true });
        } catch (e) {
          log(`[Station Monitor] Lỗi tạo thư mục ${fullPath}: ${e.message}`);
        }
      }
    }
    env.STATIONOS_WEBROOT = webRootPath;

    // Windows packaged: spawn .NET API và AI engine trực tiếp từ resources
    const backendExe = path.join(root, 'backend', 'StationOS.Api.exe');
    const aiExe = path.join(root, 'ai_engine', 'ai_engine.exe');

    if (fs.existsSync(backendExe)) {
      log('[Win] Starting backend:', backendExe);
      try {
        const backendLogFile = path.join(os.homedir(), 'Desktop', 'station-backend.log');
        const backendOut = fs.openSync(backendLogFile, 'a');
        backendProc = spawn(backendExe, [], {
          cwd: path.join(root, 'backend'),
          env,
          detached: true,
          stdio: ['ignore', backendOut, backendOut],
          windowsHide: true,
        });
        backendProc.unref();
      } catch (err) {
        log('[Win] Failed to spawn backend:', err.message);
      }
    } else {
      log('[Win] Backend exe not found:', backendExe);
    }

    if (fs.existsSync(aiExe)) {
      log('[Win] Starting AI engine:', aiExe);
      try {
        const aiLogFile = path.join(os.homedir(), 'Desktop', 'station-ai.log');
        const aiOut = fs.openSync(aiLogFile, 'a');
        aiProc = spawn(aiExe, [], {
          cwd: path.join(root, 'ai_engine'),
          env,
          detached: true,
          stdio: ['ignore', aiOut, aiOut],
          windowsHide: true,
        });
        aiProc.unref();
      } catch (err) {
        log('[Win] Failed to spawn AI engine:', err.message);
      }
    } else {
      log('[Win] AI engine exe not found:', aiExe);
    }

    // Windows packaged: spawn go2rtc media proxy for camera streaming
    const go2rtcExe = path.join(root, 'go2rtc', 'go2rtc.exe');
    const go2rtcYaml = path.join(root, 'go2rtc', 'go2rtc.yaml');
    if (fs.existsSync(go2rtcExe)) {
      log('[Win] Starting go2rtc:', go2rtcExe);
      try {
        const go2rtcLogFile = path.join(os.homedir(), 'Desktop', 'station-go2rtc.log');
        const go2rtcOut = fs.openSync(go2rtcLogFile, 'a');
        const go2rtcArgs = fs.existsSync(go2rtcYaml) ? ['-c', go2rtcYaml] : [];
        const go2rtcProc = spawn(go2rtcExe, go2rtcArgs, {
          cwd: path.join(root, 'go2rtc'),
          env,
          detached: true,
          stdio: ['ignore', go2rtcOut, go2rtcOut],
          windowsHide: true,
        });
        go2rtcProc.unref();
      } catch (err) {
        log('[Win] Failed to spawn go2rtc:', err.message);
      }
    } else {
      log('[Win] go2rtc.exe not found:', go2rtcExe);
    }
  } else {
    // Linux: chạy start-all.sh như trước
    const proc = spawn('bash', ['start-all.sh'], {
      cwd: root,
      env,
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
  }
}

// ─────────────────────────────────────────────
// Poll cho đến khi cả UI server và Backend API (port 5000) sẵn sàng
// ─────────────────────────────────────────────
function waitForServer(onReady) {
  const targetUrl = getTargetUrl();
  let attempts = 0;
  const check = () => {
    attempts++;
    if (attempts === 15) {
      if (mainWindow) {
        mainWindow.loadURL(loadingHTML(
          'Backend API chưa phản hồi. Vui lòng đảm bảo cơ sở dữ liệu PostgreSQL (TimescaleDB) đang chạy ở cổng 5432.<br>' +
          'Bạn có thể xem chi tiết lỗi tại file log ngoài Desktop: <b>station-backend.log</b>'
        )).catch(() => {});
      }
    }
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

  // Tìm frontend dist: packaged Windows → resources/frontend-dist, khác → app/dist
  let distDir;
  if (isWindowsPackaged()) {
    distDir = path.join(process.resourcesPath, 'frontend-dist');
  } else {
    distDir = path.join(app.getAppPath(), 'dist');
  }
  log('[startLocalUiServer] distDir:', distDir, 'exists:', fs.existsSync(distDir));
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
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  log('createWindow() bắt đầu, isPackaged:', app.isPackaged);
  log('appPath:', app.getAppPath());

  mainWindow.maximize();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

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
    await mainWindow.loadURL(errorHTML(
      'Không tìm thấy thư mục dự án Power-Monitor.<br>'
      + 'Vui lòng đặt project tại: ' + path.join(os.homedir(), 'Desktop', 'Power-Monitor')
    ));
    return;
  }

  // Khởi động services nếu chưa chạy
  const [backendRunning, go2rtcRunning] = await Promise.all([
    checkIfServicesRunning(),
    checkIfGo2RtcRunning(),
  ]);
  if (!backendRunning || !go2rtcRunning) {
    log('[Station Monitor] Services chưa đầy đủ, tiến hành khởi động...');
    log('[Station Monitor] backendRunning =', backendRunning, 'go2rtcRunning =', go2rtcRunning);
    if (isWindowsPackaged()) {
      try {
        const pgPortInUse = await isPortInUse(5432);
        if (!pgPortInUse) {
          await startPortablePostgres(root);
        } else {
          log('[PG] Cổng 5432 đã được sử dụng. Bỏ qua khởi động database di động.');
        }
      } catch (err) {
        log('[PG] Không thể kiểm tra hoặc khởi động database di động:', err.message);
      }
    }
    startAllServices(root);
  } else {
    log('[Station Monitor] Backend và go2rtc đã chạy sẵn, bỏ qua bước khởi động.');
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
  nativeTheme.themeSource = 'dark';
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
  if (isWindowsPackaged()) {
    const root = findProjectRoot();
    if (root) {
      stopPortablePostgres(root);
    }
  }
  if (process.platform !== 'darwin') app.quit();
});
