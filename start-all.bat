@echo off
chcp 65001 >nul
setlocal

echo ===============================================
echo  StationOS Dev Stack — Start All
echo ===============================================
echo.

REM Tới folder chứa file .bat này
cd /d "%~dp0"
set ROOT=%CD%

REM ── 1. PostgreSQL (TimescaleDB) ──────────────────────────────
echo [1/4] PostgreSQL container...
docker start stationmonitor-db >nul 2>&1
if errorlevel 1 (
    echo    Khong start duoc container 'stationmonitor-db'.
    echo    Khoi tao Docker Desktop truoc, hoac chay:
    echo      docker run -d --name stationmonitor-db -p 5432:5432 ^
    echo        -e POSTGRES_PASSWORD=postgres123 timescale/timescaledb:latest-pg16
    pause
    exit /b 1
)
echo    OK — port 5432

REM ── 2. go2rtc (RTSP → WebRTC) ────────────────────────────────
echo [2/4] go2rtc container...
docker rm -f stationos-go2rtc >nul 2>&1
docker run -d --name stationos-go2rtc ^
    -p 1984:1984 -p 8554:8554 -p 8555:8555 ^
    -v "%ROOT%\go2rtc\go2rtc.yaml:/config/go2rtc.yaml" ^
    alexxit/go2rtc:latest >nul 2>&1
if errorlevel 1 (
    echo    Loi khi start go2rtc — bo qua, video live se khong work
) else (
    echo    OK — port 1984 API, 8555 WebRTC
)

REM ── 3. Backend (.NET 8) ──────────────────────────────────────
echo [3/4] Backend .NET (port 5000)...
start "StationOS Backend" cmd /k "cd /d "%ROOT%\backend" && dotnet run --project StationOS.Api"
echo    Mo cua so moi — xem log o do

REM ── 4. Frontend (Vite) ───────────────────────────────────────
if /I "%STATION_ELECTRON_NO_FRONTEND%"=="1" (
    echo [4/4] Bo qua Frontend Vite vi dang chay ban Electron packaged...
    goto after_frontend
)

echo [4/4] Frontend Vite (port 5173)...
start "StationOS Frontend" cmd /k "cd /d "%ROOT%\frontend" && npm run dev"
echo    Mo cua so moi — xem log o do

:after_frontend

echo.
echo ===============================================
echo  Tat ca dang khoi dong. Cho ~30 giay roi mo:
echo.
echo    Frontend:  http://localhost:5173
echo    Backend:   http://localhost:5000/swagger
echo    go2rtc:    http://localhost:1984
echo    Database:  localhost:5432 (postgres / postgres123)
echo.
echo  Tai khoan admin:  admin / Admin@123
echo ===============================================
echo.

REM Đợi backend ready
echo Cho backend ready...
:wait_backend
timeout /t 3 /nobreak >nul
curl -s -o nul -w "" http://localhost:5000/api/v1/stations 2>nul
if errorlevel 1 goto wait_backend
echo Backend READY.
echo.
echo De dung tat ca: chay stop-all.bat

endlocal
