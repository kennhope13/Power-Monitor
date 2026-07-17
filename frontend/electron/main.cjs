const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const { spawn, spawnSync, execSync }  = require('child_process');
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
const preferLocalUi = process.env.STATION_ELECTRON_LOCAL_UI === '1'
  || process.env.STATION_ELECTRON_NO_FRONTEND === '1';
let forceLocalUi = preferLocalUi;

function getTargetUrl() {
  return (app.isPackaged || forceLocalUi)
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
function checkIfServicesRunning(root) {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:5000/health', (res) => {
      const backendOk = res.statusCode === 200;
      res.destroy();
      if (!backendOk) {
        resolve(false);
        return;
      }

      if (process.platform !== 'win32' || !root) {
        resolve(true);
        return;
      }

      try {
        const pgReady = spawnSync(
          path.join(root, 'pg_portable', 'bin', 'pg_isready.exe'),
          ['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres'],
          { timeout: 3000, windowsHide: true, encoding: 'utf8' }
        );
        resolve(pgReady.status === 0);
      } catch {
        resolve(false);
      }
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
// Dừng Backend và PostgreSQL khi đóng ứng dụng
// ─────────────────────────────────────────────
function stopAppServices() {
  const root = findProjectRoot();
  if (!root) return;

  log('[Station Monitor] Bắt đầu dừng Backend và PostgreSQL...');

  if (process.platform === 'win32') {
    const userData = app.getPath('userData');
    const pgDataDir = path.join(userData, 'pg_data');
    const pgBinDir = path.join(root, 'pg_portable', 'bin');

    // 1. Dừng backend và giải phóng port 5000
    try {
      spawnSync('powershell', ['-Command', 'Get-NetTCPConnection -LocalPort 5000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }'], { windowsHide: true });
      spawnSync('taskkill', ['/F', '/IM', 'StationOS.Api.exe', '/T'], { windowsHide: true });
      log('[Station Monitor] Đã đóng tiến trình Backend.');
    } catch (e) {
      log('[Station Monitor] Lỗi dừng Backend:', e.message);
    }

    // 2. Dừng PostgreSQL bằng pg_ctl stop
    try {
      const pgCtlExe = path.join(pgBinDir, 'pg_ctl.exe');
      if (fs.existsSync(pgCtlExe)) {
        log('[Station Monitor] Đang dừng PostgreSQL an toàn...');
        spawnSync(pgCtlExe, ['stop', '-D', pgDataDir, '-m', 'fast', '-w', '-t', '5'], { windowsHide: true, timeout: 6000 });
      }
    } catch (e) {
      log('[Station Monitor] Lỗi dừng PostgreSQL (pg_ctl):', e.message);
    }

    // 3. Đảm bảo kill triệt để postgres.exe
    try {
      spawnSync('taskkill', ['/F', '/IM', 'postgres.exe', '/T'], { windowsHide: true });
    } catch (e) { }

    log('[Station Monitor] Đã hoàn tất dừng Backend và PostgreSQL.');
  } else {
    try {
      spawnSync('pkill', ['-f', 'StationOS.Api'], { timeout: 3000 });
      spawnSync('pkill', ['-f', 'postgres'], { timeout: 3000 });
      log('[Station Monitor] Đã dừng Backend và Postgres trên Linux/macOS.');
    } catch (e) {
      log('[Station Monitor] Lỗi dừng services trên Linux/macOS:', e.message);
    }
  }
}

// ─────────────────────────────────────────────
// Đợi PostgreSQL sẵn sàng nhận kết nối
// ─────────────────────────────────────────────
function waitForPostgres(pgBinDir, maxRetries = 30) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const check = () => {
      attempt++;
      try {
        const result = spawnSync(
          path.join(pgBinDir, 'pg_isready.exe'),
          ['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres'],
          { timeout: 3000, windowsHide: true, encoding: 'utf8' }
        );
        if (result.status === 0) {
          log(`[PostgreSQL] Sẵn sàng sau ${attempt} lần thử.`);
          resolve();
          return;
        }
      } catch (e) {
        // pg_isready chưa có hoặc lỗi, bỏ qua
      }
      if (attempt >= maxRetries) {
        reject(new Error(`PostgreSQL không sẵn sàng sau ${maxRetries} lần thử`));
        return;
      }
      setTimeout(check, 1000);
    };
    check();
  });
}

// ─────────────────────────────────────────────
// Tạo database StationOS nếu chưa tồn tại
// ─────────────────────────────────────────────
function ensureDatabaseExists(pgBinDir) {
  try {
    // Thử tạo database, nếu đã tồn tại thì sẽ báo lỗi nhẹ (không crash)
    const result = spawnSync(
      path.join(pgBinDir, 'createdb.exe'),
      ['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-E', 'UTF8', '--locale=C', 'StationOS'],
      { timeout: 10000, windowsHide: true, encoding: 'utf8', env: { ...process.env, PGCLIENTENCODING: 'UTF8' } }
    );
    if (result.status === 0) {
      log('[PostgreSQL] Đã tạo database StationOS thành công.');
    } else if (result.stderr && result.stderr.includes('already exists')) {
      log('[PostgreSQL] Database StationOS đã tồn tại.');
    } else {
      log('[PostgreSQL] createdb output:', result.stdout, result.stderr);
    }
  } catch (e) {
    log('[PostgreSQL] Lỗi tạo database:', e.message);
  }

  // Set encoding UTF8 cho database (phòng khi database đang dùng WIN1252)
  try {
    spawnSync(
      path.join(pgBinDir, 'psql.exe'),
      ['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'StationOS', '-c', "ALTER DATABASE \"StationOS\" SET client_encoding = 'UTF8';"],
      { timeout: 5000, windowsHide: true, encoding: 'utf8', env: { ...process.env, PGCLIENTENCODING: 'UTF8' } }
    );
    log('[PostgreSQL] Đã set client_encoding = UTF8 cho database StationOS.');
  } catch (e) {
    log('[PostgreSQL] Lỗi set encoding:', e.message);
  }
}

// ─────────────────────────────────────────────
// Spawn start-all.sh (detached — thoát Electron không kill services)
// ─────────────────────────────────────────────
function spawnHiddenWin32(exePath, args, cwd, stdoutPath, stderrPath, extraEnv) {
  const escapedExe = exePath.replace(/'/g, "''");
  const escapedCwd = cwd.replace(/'/g, "''");
  const escapedOut = stdoutPath ? stdoutPath.replace(/'/g, "''") : null;
  const escapedErr = stderrPath ? stderrPath.replace(/'/g, "''") : null;
  
  const argListStr = args.length 
    ? `-ArgumentList ${args.map(a => `'${a.replace(/'/g, "''")}'`).join(',')}` 
    : '';
    
  let redirectStr = '';
  if (escapedOut) {
    redirectStr += ` -RedirectStandardOutput '${escapedOut}'`;
  }
  if (escapedErr) {
    redirectStr += ` -RedirectStandardError '${escapedErr}'`;
  }

  // Xây dựng environment block nếu có extraEnv
  let envPrefix = '';
  if (extraEnv) {
    const envSetStatements = Object.entries(extraEnv)
      .map(([k, v]) => `$env:${k}='${v.replace(/'/g, "''")}'`)
      .join('; ');
    envPrefix = envSetStatements + '; ';
  }

  const psCommand = `${envPrefix}Start-Process -FilePath '${escapedExe}' ${argListStr} -WorkingDirectory '${escapedCwd}' ${redirectStr} -WindowStyle Hidden`;
  
  log('[spawnHiddenWin32] Running PS command:', psCommand);
  
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
    windowsHide: true,
    stdio: 'ignore'
  });
  proc.unref();
}

let isStartingServices = false;

async function startAllServices(root) {
  if (isStartingServices) {
    log('[Station Monitor] Services đang được khởi động, bỏ qua yêu cầu mới.');
    return;
  }
  isStartingServices = true;
  try {
    const userData = app.getPath('userData');
    const env = { 
      ...process.env, 
      STATION_ELECTRON_NO_FRONTEND: (app.isPackaged || preferLocalUi) ? '1' : '0',
      ASPNETCORE_URLS: 'http://0.0.0.0:5000',
      STATIONOS_LICENSE_ROOT: path.join(userData, 'Licenses'),
      STATIONOS_WEB_ROOT: path.join(userData, 'wwwroot')
    };
  
  if (process.platform === 'win32') {
    const pgDataDir = path.join(userData, 'pg_data');
    const pgBinDir = path.join(root, 'pg_portable', 'bin');
    
    // Dọn dẹp tiến trình cũ (zombie) trước khi khởi động
    let go2rtcRunning = false;
    try {
      // Đảm bảo kill bất kỳ tiến trình nào đang giữ cổng 5000
      spawnSync('powershell', ['-Command', 'Get-NetTCPConnection -LocalPort 5000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }'], { windowsHide: true });
      
      spawnSync('taskkill', ['/F', '/IM', 'StationOS.Api.exe', '/T'], { windowsHide: true });
      
      try {
        const pgCtlExe = path.join(pgBinDir, 'pg_ctl.exe');
        if (fs.existsSync(pgCtlExe)) {
          log('[Station Monitor] Đang dừng PostgreSQL an toàn...');
          spawnSync(pgCtlExe, ['stop', '-D', pgDataDir, '-m', 'fast', '-w', '-t', '5'], { windowsHide: true, timeout: 6000 });
        }
      } catch (e) { }

      spawnSync('taskkill', ['/F', '/IM', 'postgres.exe', '/T'], { windowsHide: true });

      // Kiểm tra xem go2rtc có đang chạy sẵn không
      try {
        const checkGo2rtc = spawnSync('powershell', ['-Command', 'Get-NetTCPConnection -LocalPort 1984 -ErrorAction SilentlyContinue'], { windowsHide: true, encoding: 'utf8' });
        if (checkGo2rtc.status === 0 && checkGo2rtc.stdout.includes('1984')) {
          go2rtcRunning = true;
          log('[Station Monitor] go2rtc đã chạy sẵn trên cổng 1984. Giữ nguyên go2rtc.');
        }
      } catch (e) { }

      if (!go2rtcRunning) {
        spawnSync('taskkill', ['/F', '/IM', 'go2rtc.exe', '/T'], { windowsHide: true });
      }
      log('[Station Monitor] Đã dọn dẹp tiến trình cũ trên Windows.');
    } catch (e) {
      log('[Station Monitor] Lỗi dọn dẹp tiến trình:', e.message);
    }
    
    // ── Bước 1: initdb nếu chưa có data directory ──
    if (!fs.existsSync(pgDataDir)) {
      log('Khởi tạo database mới tại:', pgDataDir);
      try {
        spawnSync(path.join(pgBinDir, 'initdb.exe'), [
          '-D', pgDataDir, 
          '-U', 'postgres', 
          '-E', 'UTF8', 
          '--locale=C', 
          '--auth=trust'
        ], { 
          stdio: 'ignore', 
          windowsHide: true,
          env: { ...process.env, PGCLIENTENCODING: 'UTF8' }
        });
      } catch (e) {
        log('Lỗi initdb:', e.message);
      }
    }

    // Đảm bảo postgresql.conf có client_encoding = 'UTF8'
    try {
      const pgConfPath = path.join(pgDataDir, 'postgresql.conf');
      if (fs.existsSync(pgConfPath)) {
        let pgConf = fs.readFileSync(pgConfPath, 'utf8');
        if (!pgConf.includes("client_encoding = 'UTF8'")) {
          pgConf += "\n# Force UTF8 encoding for Vietnamese text support\nclient_encoding = 'UTF8'\n";
          fs.writeFileSync(pgConfPath, pgConf, 'utf8');
          log('[PostgreSQL] Đã thêm client_encoding = UTF8 vào postgresql.conf');
        }
      }
    } catch (e) {
      log('[PostgreSQL] Lỗi cập nhật postgresql.conf:', e.message);
    }
    
    // ── Bước 2: Khởi động PostgreSQL ──
    const pidFile = path.join(pgDataDir, 'postmaster.pid');
    if (fs.existsSync(pidFile)) {
      try {
        fs.unlinkSync(pidFile);
        log('[PostgreSQL] Đã xóa postmaster.pid cũ.');
      } catch (e) {
        log('[PostgreSQL] Lỗi xóa postmaster.pid:', e.message);
      }
    }

    spawnHiddenWin32(
      path.join(pgBinDir, 'pg_ctl.exe'),
      ['-D', pgDataDir, '-l', path.join(userData, 'postgres.log'), 'start'],
      path.join(root, 'pg_portable'),
      null,
      null
    );

    // ── Bước 3: Đợi PostgreSQL sẵn sàng ──
    try {
      await waitForPostgres(pgBinDir, 30);
    } catch (e) {
      log('[PostgreSQL] CẢNH BÁO:', e.message, '— thử tiếp tục anyway...');
    }

    // ── Bước 4: Tạo database StationOS nếu chưa có ──
    ensureDatabaseExists(pgBinDir);

    // ── Bước 5: Khởi động Backend (SAU KHI PostgreSQL sẵn sàng + DB đã tạo) ──
    // Read saved server_ip from server_ip.json to bind the backend to it in addition to localhost
    let urls = 'http://127.0.0.1:5000';
    try {
      const filePath = path.join(userData, 'server_ip.json');
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && parsed.ip && parsed.ip.trim()) {
          const bindIp = parsed.ip.trim();
          if (bindIp !== '127.0.0.1' && bindIp !== 'localhost') {
            // Thay vì dùng bindIp cụ thể dễ bị crash (SocketException 10049) khi đổi mạng/nhập nhầm,
            // ta bind thẳng vào 0.0.0.0 để lắng nghe trên tất cả card mạng đang hoạt động.
            urls = 'http://127.0.0.1:5000;http://0.0.0.0:5000';
            log('[Startup] Binding backend to multiple URLs (LAN mode):', urls);
          }
        }
      }
    } catch (e) {
      log('[Startup] Error reading server_ip.json:', e.message);
    }

    spawnHiddenWin32(
      path.join(root, 'backend', 'StationOS.Api.exe'),
      ['--urls', urls],
      path.join(root, 'backend'),
      path.join(userData, 'backend.log'),
      path.join(userData, 'backend_err.log'),
      { 
        PGCLIENTENCODING: 'UTF8',
        STATIONOS_LICENSE_ROOT: path.join(userData, 'Licenses'),
        STATIONOS_WEB_ROOT: path.join(userData, 'wwwroot')
      }
    );

    // ── Bước 6: Khởi động go2rtc ──
    if (!go2rtcRunning) {
      spawnHiddenWin32(
        path.join(root, 'go2rtc', 'go2rtc.exe'),
        [],
        path.join(root, 'go2rtc'),
        path.join(userData, 'go2rtc.log'),
        path.join(userData, 'go2rtc_err.log')
      );
      log('[Station Monitor] Đã kích hoạt PostgreSQL, Backend và go2rtc trên Windows.');
    } else {
      log('[Station Monitor] Đã kích hoạt PostgreSQL và Backend (giữ nguyên go2rtc đang chạy sẵn) trên Windows.');
    }
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
  } finally {
    isStartingServices = false;
  }
}

// ─────────────────────────────────────────────
// Poll cho đến khi cả UI server và Backend API (port 5000) sẵn sàng
// Backend /health trả 503 khi DB chưa migrate xong, 200 khi sẵn sàng hoàn toàn
// ─────────────────────────────────────────────
function waitForServer(onReady) {
  const targetUrl = getTargetUrl();
  
  const check = () => {
    const client = targetUrl.startsWith('https://') ? https : http;
    const req = client.get(targetUrl, (res) => {
      res.destroy();
      
      // UI Server đã sẵn sàng, tiếp tục kiểm tra Backend API (port 5000)
      const backendReq = http.get('http://127.0.0.1:5000/health', (backendRes) => {
        const statusCode = backendRes.statusCode;
        backendRes.destroy();
        
        if (statusCode === 200) {
          log('[Station Monitor] Cả UI và Backend đều đã sẵn sàng.');
          onReady();
        } else {
          log(`[Station Monitor] Backend chưa sẵn sàng (HTTP ${statusCode}). Đang đợi DB migrate...`);
          setTimeout(check, 1500);
        }
      });
      backendReq.on('error', () => {
        log('[Station Monitor] Giao diện sẵn sàng nhưng Backend chưa phản hồi. Đang đợi...');
        setTimeout(check, 1500);
      });
      backendReq.setTimeout(2000, () => {
        backendReq.destroy();
        setTimeout(check, 1500);
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

      if (reqUrl.startsWith('/api/') || reqUrl.startsWith('/media/') || reqUrl.startsWith('/ws/') || reqUrl.startsWith('/sld/')) {
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

    server.on('upgrade', (req, socket, head) => {
      const reqUrl = req.url || '/';
      if (reqUrl.startsWith('/ws/')) {
        const targetUrl = new URL(reqUrl, 'http://127.0.0.1:5000');
        const options = {
          port: 5000,
          host: '127.0.0.1',
          path: targetUrl.pathname + targetUrl.search,
          headers: req.headers,
          method: req.method || 'GET'
        };

        const proxyReq = http.request(options);
        proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n` +
            Object.keys(proxyRes.headers)
              .map(key => `${key}: ${proxyRes.headers[key]}`)
              .join('\r\n') +
            '\r\n\r\n'
          );

          if (proxyHead && proxyHead.length > 0) {
            socket.write(proxyHead);
          }

          proxySocket.on('error', (err) => {
            log(`[ProxySocket Error] ${err.message}`);
            socket.destroy();
          });
          socket.on('error', (err) => {
            log(`[Socket Error] ${err.message}`);
            proxySocket.destroy();
          });

          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
        });

        proxyReq.on('error', (err) => {
          log(`[WS Proxy Error] ${err.message}`);
          socket.end();
        });

        if (head && head.length > 0) {
          proxyReq.write(head);
        }
        proxyReq.end();
      } else {
        socket.end();
      }
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
// Kiểm tra xem backend đã chạy sẵn trong nền hay chưa
// ─────────────────────────────────────────────
function checkServicesRunning(root) {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:5000/health', (res) => {
      const backendOk = res.statusCode === 200;
      res.destroy();
      if (!backendOk) {
        resolve(false);
        return;
      }

      if (process.platform !== 'win32' || !root) {
        resolve(true);
        return;
      }

      try {
        const pgReady = spawnSync(
          path.join(root, 'pg_portable', 'bin', 'pg_isready.exe'),
          ['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres'],
          { timeout: 3000, windowsHide: true, encoding: 'utf8' }
        );
        resolve(pgReady.status === 0);
      } catch {
        resolve(false);
      }
    });
    req.on('error', () => {
      resolve(false);
    });
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
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
      preload: path.join(__dirname, 'preload.cjs'),
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

  // ── Kiểm tra xem services đã chạy ngầm hay chưa ──
  log('[Station Monitor] Kiểm tra xem services đã chạy ngầm hay chưa...');
  const alreadyRunning = await checkServicesRunning(root);
  if (alreadyRunning) {
    log('[Station Monitor] Services đã chạy sẵn trong nền. Bỏ qua bước khởi động lại.');
  } else {
    log('[Station Monitor] Services chưa chạy hoặc chưa sẵn sàng. Tiến hành khởi động...');
    await startAllServices(root);
  }

  // Kiểm tra xem Vite dev server (port 5173) có đang chạy không (chỉ khi chưa package)
  let useVite = false;
  if (!app.isPackaged && !preferLocalUi) {
    try {
      useVite = await new Promise((resolve) => {
        const req = http.get('http://127.0.0.1:5173', (res) => {
          res.destroy();
          resolve(true);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(500, () => {
          req.destroy();
          resolve(false);
        });
      });
    } catch (e) {
      useVite = false;
    }
  } else if (preferLocalUi) {
    log('[Station Monitor] Shortcut mode: dùng local UI server trên cổng 4173, không dùng Vite 5173.');
  }

  if (!useVite) {
    log('[Station Monitor] Vite dev server không chạy. Chuyển sang dùng local UI server trên cổng 4173.');
    forceLocalUi = true;
  }

  if (app.isPackaged || forceLocalUi) {
    log('Khởi chạy local UI server (phục vụ từ dist)...');
    const distDir = path.join(app.getAppPath(), 'dist');
    log('distDir:', distDir, 'exists:', fs.existsSync(distDir));
    try {
      await startLocalUiServer();
      log('localUiServer OK port:', localUiPort);
    } catch (err) {
      log('startLocalUiServer ERROR:', err.message);
      if (err.code === 'EADDRINUSE') {
        log('[Station Monitor] Cổng 4173 đã được sử dụng. Tiếp tục tải giao diện...');
        localUiPort = 4173;
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
    
    // ── Backend Watchdog ──
    // Kiểm tra backend health mỗi 10 giây, nếu chết thì tự restart
    let consecutiveFailures = 0;
    const watchdogInterval = setInterval(() => {
      if (!mainWindow) {
        clearInterval(watchdogInterval);
        return;
      }
      const healthReq = http.get('http://127.0.0.1:5000/health', (res) => {
        const backendOk = res.statusCode === 200;
        res.destroy();
        if (backendOk) {
          consecutiveFailures = 0;
          return;
        }

        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          log(`[Watchdog] Backend health HTTP ${res.statusCode} liên tục 3 lần. Đang tự động khởi động lại...`);
          consecutiveFailures = 0;
          startAllServices(root).then(() => {
            log('[Watchdog] Đã khởi động lại services.');
          }).catch(err => {
            log('[Watchdog] Lỗi khởi động lại:', err.message);
          });
        } else {
          log(`[Watchdog] Backend health HTTP ${res.statusCode}. Lỗi lần ${consecutiveFailures}...`);
        }
      });
      healthReq.on('error', () => {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          log('[Watchdog] Backend không phản hồi liên tục 3 lần! Đang tự động khởi động lại...');
          consecutiveFailures = 0;
          startAllServices(root).then(() => {
            log('[Watchdog] Đã khởi động lại services.');
          }).catch(err => {
            log('[Watchdog] Lỗi khởi động lại:', err.message);
          });
        } else {
          log(`[Watchdog] Backend không phản hồi. Lỗi lần ${consecutiveFailures}...`);
        }
      });
      healthReq.setTimeout(3000, () => {
        healthReq.destroy();
      });
    }, 10000);
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

// Register IPC handler to save server_ip config file
ipcMain.handle('save-server-ip', async (event, ip) => {
  try {
    const userData = app.getPath('userData');
    const filePath = path.join(userData, 'server_ip.json');
    fs.writeFileSync(filePath, JSON.stringify({ ip }));
    log('[IPC] Saved server_ip:', ip);

    // Tự động khởi động lại Backend với IP mới nếu đang chạy trên Windows
    if (process.platform === 'win32') {
      const root = findProjectRoot();
      if (root) {
        log('[IPC] Đang tắt Backend cũ để áp dụng IP mới...');
        try {
          spawnSync('powershell', ['-Command', 'Get-NetTCPConnection -LocalPort 5000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }'], { windowsHide: true });
          spawnSync('taskkill', ['/F', '/IM', 'StationOS.Api.exe', '/T'], { windowsHide: true });
        } catch (e) {
          log('[IPC] Lỗi khi tắt Backend cũ:', e.message);
        }

        // Đợi 1 giây để Windows giải phóng hoàn toàn cổng 5000
        log('[IPC] Đang đợi cổng 5000 giải phóng...');
        await new Promise(resolve => setTimeout(resolve, 1000));

        let urls = 'http://127.0.0.1:5000';
        if (ip && ip.trim()) {
          const bindIp = ip.trim();
          if (bindIp !== '127.0.0.1' && bindIp !== 'localhost') {
            // Thay vì dùng bindIp cụ thể dễ bị crash, ta bind vào 0.0.0.0
            urls = 'http://127.0.0.1:5000;http://0.0.0.0:5000';
          }
        }

        log('[IPC] Khởi chạy lại Backend với URLs:', urls);
        spawnHiddenWin32(
          path.join(root, 'backend', 'StationOS.Api.exe'),
          ['--urls', urls],
          path.join(root, 'backend'),
          path.join(userData, 'backend.log'),
          path.join(userData, 'backend_err.log'),
          { 
            PGCLIENTENCODING: 'UTF8',
            STATIONOS_LICENSE_ROOT: path.join(userData, 'Licenses'),
            STATIONOS_WEB_ROOT: path.join(userData, 'wwwroot')
          }
        );
      }
    }
    return true;
  } catch (e) {
    log('[IPC] Error saving server_ip:', e.message);
    return false;
  }
});

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

let isQuitting = false;
app.on('before-quit', () => {
  if (!isQuitting) {
    isQuitting = true;
    if (localUiServer) {
      try { localUiServer.close(); } catch {}
      localUiServer = null;
    }
    stopAppServices();
  }
});

