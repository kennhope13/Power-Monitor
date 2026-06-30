#!/usr/bin/env bash
# create_desktop_shortcut.sh
# Tạo file .desktop trên Desktop để khởi chạy AppImage của Station Monitor

APPDIR="$(pwd)/frontend/dist-electron"
APPIMAGE=$(find "$APPDIR" -maxdepth 1 -name "Station*AppImage" | head -n1)

if [[ -z "$APPIMAGE" ]]; then
  echo "Không tìm thấy AppImage trong $APPDIR"
  exit 1
fi

DESKTOP_FILE="$HOME/Desktop/Station Monitor.desktop"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=Station Monitor
Comment=Desktop client for Power‑Monitor
Exec=$APPIMAGE
Icon=$APPDIR/linux-unpacked/resources/icon.png
Terminal=false
Type=Application
Categories=Utility;
EOF

chmod +x "$DESKTOP_FILE"

echo "Desktop shortcut tạo tại: $DESKTOP_FILE"
