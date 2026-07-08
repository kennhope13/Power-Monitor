#!/bin/bash
# ============================================================
# start-all.sh — Khởi động StationOS (Backend + Frontend + go2rtc)
# Tự động dọn dẹp tiến trình cũ, khởi chạy cơ sở dữ liệu và các thành phần.
# ============================================================



# Lấy thư mục gốc
ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$ROOT"

export ASPNETCORE_ENVIRONMENT=Development
export ASPNETCORE_URLS="http://0.0.0.0:5000"

echo "=================================================="
echo "   STATIONOS - KHỞI ĐỘNG HỆ THỐNG MỚI (LINUX)"
echo "=================================================="
echo ""

# 1. Dọn dẹp chỉ các cổng của project này (5173, 5000, 8100) và các tiến trình zombie
echo "[1/4] Đang dọn dẹp các tiến trình cũ..."
for port in 5173 5000 8100; do
    PIDS=$(lsof -t -i:$port 2>/dev/null)
    if [ -n "$PIDS" ]; then
        echo "  → Kill port $port (PID: $PIDS)"
        echo "$PIDS" | xargs kill -9 >/dev/null 2>&1 || true
    fi
done

# Giải phóng thêm các tiến trình build / compiler bị kẹt của dotnet
echo "  → Dọn dẹp các tiến trình compiler/dotnet dư thừa..."
pkill -9 -f "VBCSCompiler" 2>/dev/null || true
pkill -9 -f "MSBuild" 2>/dev/null || true
pkill -9 -f "StationOS.Api" 2>/dev/null || true

if command -v docker &> /dev/null; then
    # Chỉ dọn dẹp container nếu docker daemon đang chạy
    if docker ps >/dev/null 2>&1; then
        docker rm -f stationos-go2rtc-monitor >/dev/null 2>&1 || true
    fi
fi
sleep 1
echo "✅ Dọn dẹp hoàn tất."

# 2. Khởi động PostgreSQL (TimescaleDB)
echo "[2/4] Khởi động Database TimescaleDB..."
if lsof -i :5432 >/dev/null 2>&1; then
    echo "✅ Database đang chạy sẵn (Port: 5432)"
else
    if command -v docker &> /dev/null && docker compose version &> /dev/null; then
        echo "  → Cổng 5432 chưa mở. Đang khởi động Database bằng docker compose..."
        sudo docker compose -f docker-compose.db.yml up -d || echo "⚠️ Lỗi: Không thể chạy docker compose, vui lòng khởi động database thủ công."
        echo "✅ Đã gửi lệnh khởi động Database."
    else
        echo "⚠️  Docker / Docker Compose chưa được bật hoặc cài đặt. Vui lòng đảm bảo cổng 5432 có database postgres/postgres123."
    fi
fi

# 3. Khởi động Video Streaming (go2rtc)
echo "[3/4] Khởi động go2rtc Video Streamer..."
kill -9 $(pgrep -f "go2rtc") >/dev/null 2>&1 || true
if command -v docker &> /dev/null; then
    sudo docker rm -f stationos-go2rtc-monitor >/dev/null 2>&1 || true
fi
export PATH="$ROOT/go2rtc:$PATH"
nohup "$ROOT/go2rtc/go2rtc" -c "$ROOT/go2rtc/go2rtc.yaml" > "$ROOT/go2rtc.log" 2>&1 &
echo "✅ go2rtc đang chạy ngầm (Port: 1984)"

# 4. Khởi động Backend (.NET 8)
echo "[4/4] Khởi động C# Backend..."
export DOTNET_CLI_HOME=/tmp

# Tận dụng binary đã build sẵn để khởi động tức thì, tránh Roslyn compiler chiếm 100% CPU
API_BIN="$ROOT/backend/StationOS.Api/bin/Debug/net8.0/StationOS.Api"
API_DLL="$ROOT/backend/StationOS.Api/bin/Debug/net8.0/StationOS.Api.dll"

if [ -f "$API_BIN" ]; then
    echo "  → Khởi chạy Backend từ binary đã biên dịch..."
    cd "$ROOT/backend/StationOS.Api"
    nohup ./bin/Debug/net8.0/StationOS.Api > "$ROOT/backend.log" 2>&1 &
    BACKEND_PID=$!
    cd "$ROOT"
elif [ -f "$API_DLL" ]; then
    echo "  → Khởi chạy Backend từ DLL đã biên dịch..."
    cd "$ROOT/backend/StationOS.Api"
    nohup dotnet "$API_DLL" > "$ROOT/backend.log" 2>&1 &
    BACKEND_PID=$!
    cd "$ROOT"
else
    echo "  → Không tìm thấy bản build. Khởi chạy bằng dotnet run (sẽ mất vài phút)..."
    nohup dotnet run --project backend/StationOS.Api > backend.log 2>&1 &
    BACKEND_PID=$!
fi
echo "✅ Backend đang khởi chạy ngầm (PID: $BACKEND_PID, Port: 5000)"

# Đợi backend sẵn sàng (tối đa 15 giây, dừng ngay khi OK)
for i in {1..15}; do
    sleep 1
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:5000/health 2>/dev/null | grep -q "200"; then
        echo "✅ Backend đã SẴN SÀNG!"
        break
    fi
done

echo ""
echo "=================================================="
echo " HỆ THỐNG ĐÃ SẴN SÀNG!"
echo ""
echo " Frontend : http://localhost:5173"
echo " Backend  : http://localhost:5000/swagger"
echo " go2rtc   : http://localhost:1984"
echo ""
echo " Tài khoản quản trị: admin / Admin@123"
echo " Logs Backend: tail -f backend.log"
echo " Logs AI Engine: tail -f ai_engine.log"
echo "=================================================="
echo ""

# 5. Khởi động AI Engine (Python FastAPI — cung cấp nhiệt độ điểm đo ROI)
echo "[5/5] Khởi động AI Engine (Python FastAPI)..."
cd "$ROOT/ai_engine"
if [ -d ".venv" ]; then
    .venv/bin/pip install -r requirements.txt > /dev/null 2>&1 || true
    nohup .venv/bin/python main.py > "$ROOT/ai_engine.log" 2>&1 &
else
    pip3 install -r requirements.txt > /dev/null 2>&1 || true
    nohup python3 main.py > "$ROOT/ai_engine.log" 2>&1 &
fi
AI_PID=$!
echo "✅ AI Engine đang khởi chạy ngầm (PID: $AI_PID, Port: 8100)"

cd "$ROOT"
if [ "${STATION_ELECTRON_NO_FRONTEND:-0}" = "1" ]; then
    echo "ℹ️  Bỏ qua Vite dev server vì đang chạy bản Electron packaged."
    exit 0
fi

# Chạy Frontend ở foreground
cd "$ROOT/frontend"
if [ ! -d "node_modules" ]; then
    echo "📦 Thư viện Frontend chưa được cài đặt. Đang cài đặt tự động..."
    npm install
fi
npm run dev -- --host
