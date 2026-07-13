/**
 * afterPack hook — nhúng --no-sandbox --disable-gpu vào AppImage wrapper
 * Electron trên server Linux (HP ProLiant, VGA Matrox G200) cần disable GPU
 * để tránh crash: "GPU process isn't usable. Goodbye."
 */
const path = require('path');
const fs   = require('fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;

  const appOutDir   = context.appOutDir;
  const execName    = context.packager.executableName; // "station-os"
  const execPath    = path.join(appOutDir, execName);
  const backupPath  = `${execPath}.__bin__`;

  if (!fs.existsSync(execPath)) {
    console.log('[afterPack] Không tìm thấy executable:', execPath);
    return;
  }

  // Đổi tên binary gốc thành .<name>.__bin__
  fs.renameSync(execPath, backupPath);

  // Tạo wrapper shell script thay thế
  const wrapper = `#!/bin/bash
DIR="$(dirname "$(readlink -f "$0")")"
exec "$DIR/${execName}.__bin__" --no-sandbox --disable-gpu --disable-gpu-sandbox --disable-setuid-sandbox --disable-dev-shm-usage "$@"
`;
  fs.writeFileSync(execPath, wrapper, { mode: 0o755 });
  console.log('[afterPack] Đã tạo wrapper script cho', execName);
};
