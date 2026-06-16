const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = 8600; // Dùng port riêng, tránh xung đột với port 8502

let mainWindow = null;
let streamlitProcess = null;

// ── Tìm đường dẫn script và python ──────────────────────────
function getScriptPath() {
  // Khi đóng gói: extraResources nằm ở resources/
  const packed = path.join(process.resourcesPath, 'generate_license_streamlit.py');
  if (fs.existsSync(packed)) return packed;
  // Khi dev: dùng đường dẫn tương đối
  return path.join(__dirname, '..', 'scratch', 'generate_license_streamlit.py');
}

function getPython() {
  const candidates = [
    '/usr/bin/python3',
    '/usr/local/bin/python3',
    `${process.env.HOME}/.local/bin/python3`,
    'python3',
  ];
  for (const p of candidates) {
    try {
      if (p !== 'python3') {
        if (fs.existsSync(p)) return p;
      } else {
        execSync('which python3', { stdio: 'pipe' });
        return p;
      }
    } catch (_) {}
  }
  return 'python3';
}

// ── Khởi động Streamlit ──────────────────────────────────────
function startStreamlit() {
  const python = getPython();
  const script = getScriptPath();
  const keysPath = path.join(path.dirname(script), 'generated_keys.json');

  console.log(`[Electron] Python: ${python}`);
  console.log(`[Electron] Script: ${script}`);

  streamlitProcess = spawn(python, [
    '-m', 'streamlit', 'run', script,
    '--server.port', String(PORT),
    '--server.headless', 'true',
    '--server.enableCORS', 'false',
    '--server.enableXsrfProtection', 'false',
    '--browser.gatherUsageStats', 'false',
  ], {
    env: { ...process.env, STREAMLIT_BROWSER_GATHER_USAGE_STATS: '0' },
    cwd: path.dirname(script),
  });

  streamlitProcess.stdout.on('data', (d) => process.stdout.write(`[Streamlit] ${d}`));
  streamlitProcess.stderr.on('data', (d) => process.stderr.write(`[Streamlit] ${d}`));

  streamlitProcess.on('exit', (code) => {
    console.log(`[Streamlit] Exited with code ${code}`);
  });
}

// ── Chờ Streamlit sẵn sàng ──────────────────────────────────
function waitForStreamlit(retries = 30, delay = 1000) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(`http://localhost:${PORT}/`, (res) => {
        if (res.statusCode < 500) resolve();
        else if (n > 0) setTimeout(() => attempt(n - 1), delay);
        else reject(new Error('Streamlit không phản hồi'));
      }).on('error', () => {
        if (n > 0) setTimeout(() => attempt(n - 1), delay);
        else reject(new Error('Không kết nối được Streamlit'));
      });
    };
    attempt(retries);
  });
}

// ── Tạo cửa sổ chính ────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 800,
    minHeight: 600,
    title: 'StationOS – Tạo Giftcode Bản Quyền',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
    backgroundColor: '#0f1117', // Streamlit dark background
    show: false,
  });

  // Mở loading screen
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.show();

  // Chờ Streamlit rồi load
  waitForStreamlit()
    .then(() => {
      mainWindow.loadURL(`http://localhost:${PORT}`);
    })
    .catch((err) => {
      dialog.showErrorBox('Lỗi khởi động', `Không thể khởi động Streamlit:\n${err.message}`);
      app.quit();
    });

  // Mở link ngoài trong browser mặc định
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── App lifecycle ────────────────────────────────────────────
app.whenReady().then(() => {
  startStreamlit();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (streamlitProcess) {
    streamlitProcess.kill('SIGTERM');
    streamlitProcess = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (streamlitProcess) {
    streamlitProcess.kill('SIGTERM');
    streamlitProcess = null;
  }
});
