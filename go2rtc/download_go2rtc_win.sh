#!/usr/bin/env bash
# ============================================================
# download_go2rtc_win.sh — Tải go2rtc.exe + ffmpeg.exe cho Windows
# Chạy script này trước khi build installer Windows.
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GO2RTC_VERSION="1.9.4"
FFMPEG_VERSION="7.0"

echo "📥 Tải go2rtc.exe (v${GO2RTC_VERSION}) cho Windows..."
if [ ! -f "${DIR}/go2rtc.exe" ]; then
    curl -L -o "${DIR}/go2rtc.exe" \
        "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_win64.zip" && \
    cd "${DIR}" && unzip -o go2rtc_win64.zip go2rtc.exe 2>/dev/null || \
    curl -L -o "${DIR}/go2rtc.exe" \
        "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_win64.exe"
    echo "✅ go2rtc.exe đã tải xong"
else
    echo "✅ go2rtc.exe đã tồn tại, bỏ qua"
fi

echo ""
echo "📥 Tải ffmpeg.exe cho Windows..."
if [ ! -f "${DIR}/ffmpeg.exe" ]; then
    FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    FFMPEG_TMP="${DIR}/ffmpeg_win.zip"
    curl -L -o "${FFMPEG_TMP}" "${FFMPEG_URL}"
    # Extract only ffmpeg.exe and ffprobe.exe
    unzip -j -o "${FFMPEG_TMP}" "*/bin/ffmpeg.exe" -d "${DIR}/" 2>/dev/null || true
    unzip -j -o "${FFMPEG_TMP}" "*/bin/ffprobe.exe" -d "${DIR}/" 2>/dev/null || true
    rm -f "${FFMPEG_TMP}"
    echo "✅ ffmpeg.exe đã tải xong"
else
    echo "✅ ffmpeg.exe đã tồn tại, bỏ qua"
fi

echo ""
echo "=================================================="
echo " Tất cả binary Windows đã sẵn sàng trong: ${DIR}"
echo " go2rtc.exe : $(ls -lh ${DIR}/go2rtc.exe 2>/dev/null | awk '{print $5}' || echo 'MISSING')"
echo " ffmpeg.exe : $(ls -lh ${DIR}/ffmpeg.exe 2>/dev/null | awk '{print $5}' || echo 'MISSING')"
echo "=================================================="
