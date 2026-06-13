#!/bin/bash
# ============================================================
# stop-all.sh — Dừng toàn bộ các dịch vụ StationOS
# ============================================================

echo "==============================================="
echo "  StationOS Dev Stack — Stop All"
echo "==============================================="
echo ""

echo "[1/2] Dừng container go2rtc..."
if command -v docker &> /dev/null; then
    sudo docker rm -f stationos-go2rtc-monitor >/dev/null 2>&1 || true
fi

echo "[2/2] Dừng các tiến trình đang giữ cổng..."
for port in 5173 5000 8100; do
    PIDS=$(lsof -t -i:$port 2>/dev/null)
    if [ -n "$PIDS" ]; then
        echo "  → Kill port $port (PID: $PIDS)"
        echo "$PIDS" | xargs kill -9 >/dev/null 2>&1 || true
    fi
done

echo ""
echo "Giữ nguyên Database PostgreSQL container để bảo lưu dữ liệu."
echo "Để dừng Database:  sudo docker compose -f docker-compose.db.yml down"
echo ""
echo "==============================================="
echo "  Đã dừng hoàn toàn Backend + AI Engine + Frontend + go2rtc."
echo "==============================================="
