"""
thermal_analyzer.py — Phân tích camera nhiệt
- Đọc nhiệt độ tại các điểm đo P1-P10 qua Hikvision ISAPI
- Vẽ điểm + nhãn nhiệt độ lên frame
- Gửi cảnh báo về backend nếu vượt ngưỡng
"""
import asyncio
import time
import logging
import httpx
import cv2
import numpy as np
from dataclasses import dataclass, field

from config import get_settings
from services.streaming.rtsp_reader import RtspReader

logger = logging.getLogger(__name__)
cfg = get_settings()


@dataclass
class ThermalPoint:
    """Một điểm đo nhiệt độ trên camera."""
    id:          str           # "P1", "P2", ...
    x:           float         # tỉ lệ 0.0-1.0 theo chiều ngang frame
    y:           float         # tỉ lệ 0.0-1.0 theo chiều dọc frame
    pre_alarm:   float = 0.0   # 0.0 = Vô hiệu hóa
    alarm:       float = 0.0
    label:       str = ""      # Nhãn hiển thị (tự sinh từ id nếu bỏ trống)

    def __post_init__(self):
        if not self.label:
            self.label = self.id


@dataclass
class ThermalZone:
    """Một vùng (polygon) đo nhiệt độ trên camera."""
    id:          str
    polygon:     list[list[float]]  # Danh sách điểm [[x,y], [x,y], ...] (0.0-1.0)
    pre_alarm:   float = 0.0
    alarm:       float = 0.0
    label:       str = ""

    def __post_init__(self):
        if not self.label:
            self.label = self.id


@dataclass
class ThermalAnalyzer:
    """Xử lý một camera nhiệt: đọc RTSP + ISAPI + annotate + gửi webhook."""
    device_id:   str
    camera_ip:   str
    username:    str
    password:    str
    stream_id:   str           # go2rtc stream ID (ví dụ: camera_152_thermal)
    points:      list[ThermalPoint] = field(default_factory=list)
    zones:       list[ThermalZone]  = field(default_factory=list)

    _reader:     RtspReader | None = field(default=None, init=False, repr=False)
    _last_alert: dict[str, float]  = field(default_factory=dict, init=False, repr=False)
    _consecutive_auth_failures: int = field(default=0, init=False, repr=False)
    _auth_cooldown_until:       float = field(default=0.0, init=False, repr=False)

    last_point_temps:           dict[str, float]  = field(default_factory=dict, init=False, repr=False)
    last_zone_results:          dict[str, dict]   = field(default_factory=dict, init=False, repr=False)
    _last_history_save:         float             = field(default=0.0, init=False, repr=False)
    _last_jetson_push:          float             = field(default=0.0, init=False, repr=False)
    _last_matrix_fetch:         float             = field(default=0.0, init=False, repr=False)
    _cached_matrix:             any               = field(default=None, init=False, repr=False)

    def start(self) -> None:
        rtsp_url = f"{cfg.go2rtc_rtsp}/{self.stream_id}"
        self._reader = RtspReader(rtsp_url, self.stream_id)
        self._reader.start()

    def stop(self) -> None:
        if self._reader:
            self._reader.stop()
        if hasattr(self, '_http_client'):
            try:
                import asyncio
                asyncio.create_task(self._http_client.aclose())
            except Exception: pass

    def update_config(self, points: list[ThermalPoint], zones: list[ThermalZone], force_jetson_push: bool = False) -> None:
        """Cập nhật cấu hình các điểm và vùng đo nhiệt.
        
        force_jetson_push=True: Reset bộ đếm 5 phút, gửi sang Jetson ngay lần tiếp theo.
                                Dùng khi người dùng thay đổi cấu hình điểm đo trên giao diện.
        force_jetson_push=False (mặc định): Giữ nguyên bộ đếm, KHÔNG reset.
                                Dùng khi Jetson tự ping /config/thermal để đồng bộ (tránh vòng lặp).
        """
        self.points = points
        self.zones = zones
        if force_jetson_push:
            self._last_jetson_push = 0.0
        self._last_history_save = 0.0

    # ── Main process (gọi định kỳ từ scheduler) ──────────────

    async def process(self) -> None:
        """Đọc nhiệt độ tại các điểm và vùng, annotate frame, gửi alert nếu cần."""
        now = time.time()
        
        # Thống nhất chu kỳ truy vấn thiết bị (cả raw matrix và fallback) tối đa mỗi 2.0 giây
        should_fetch = (now - self._last_matrix_fetch >= 2.0)

        # Khởi tạo các thuộc tính cache nếu chưa có
        if not hasattr(self, '_use_fallback_only'):
            self._use_fallback_only = False
        if not hasattr(self, '_consecutive_matrix_failures'):
            self._consecutive_matrix_failures = 0
        if not hasattr(self, '_cached_point_temps'):
            self._cached_point_temps = {}
        if not hasattr(self, '_cached_zone_results'):
            self._cached_zone_results = {}

        if should_fetch:
            self._last_matrix_fetch = now
            point_temps = {}
            zone_results = {}
            fetched_ok = False

            # 1. Thử đọc matrix raw trước
            if not self._use_fallback_only:
                try:
                    matrix_data = await self._read_thermal_matrix()
                    if matrix_data:
                        self._consecutive_matrix_failures = 0
                        temperatures, w, h, mapping = matrix_data

                        # Trích xuất nhiệt độ cho points từ raw matrix
                        for pt in self.points:
                            px_norm = pt.x
                            py_norm = pt.y
                            if mapping:
                                px_norm = (px_norm - mapping.get("x", 0.0)) / mapping.get("width", 1.0)
                                py_norm = (py_norm - mapping.get("y", 0.0)) / mapping.get("height", 1.0)
                                px_norm = max(0.0, min(1.0, px_norm))
                                py_norm = max(0.0, min(1.0, py_norm))

                            px = int(px_norm * w)
                            py = int(py_norm * h)
                            px = max(0, min(px, w - 1))
                            py = max(0, min(py, h - 1))
                            idx = py * w + px
                            val = float(temperatures[idx])
                            if -50.0 <= val <= 500.0:
                                point_temps[pt.id] = val

                        # Trích xuất nhiệt độ cho zones từ raw matrix
                        for zn in self.zones:
                            if not zn.polygon or len(zn.polygon) < 3:
                                continue
                            
                            # Tạo mask cho polygon trên matrix nhỏ
                            mapped_polygon = []
                            for p in zn.polygon:
                                px_norm = p[0]
                                py_norm = p[1]
                                if mapping:
                                    px_norm = (px_norm - mapping.get("x", 0.0)) / mapping.get("width", 1.0)
                                    py_norm = (py_norm - mapping.get("y", 0.0)) / mapping.get("height", 1.0)
                                    px_norm = max(0.0, min(1.0, px_norm))
                                    py_norm = max(0.0, min(1.0, py_norm))
                                mapped_polygon.append([int(px_norm * w), int(py_norm * h)])

                            poly_pts = np.array(mapped_polygon, np.int32)
                            mask = np.zeros((h, w), dtype=np.uint8)
                            cv2.fillPoly(mask, [poly_pts], 255)
                            
                            # Lọc các giá trị nhiệt độ trong vùng và clamp
                            masked_temps = temperatures.reshape((h, w))[mask == 255]
                            valid_temps = masked_temps[(masked_temps >= -50.0) & (masked_temps <= 500.0)]
                            if valid_temps.size > 0:
                                max_val = float(np.max(valid_temps))
                                
                                full_matrix = temperatures.reshape((h, w))
                                full_matrix_masked = np.where((mask == 255) & (full_matrix >= -50.0) & (full_matrix <= 500.0), full_matrix, -1000.0)
                                max_idx = np.argmax(full_matrix_masked)
                                max_y, max_x = divmod(max_idx, w)
                                
                                # Convert max back to visible coordinates
                                vx = float(max_x / w)
                                vy = float(max_y / h)
                                if mapping:
                                    vx = vx * mapping.get("width", 1.0) + mapping.get("x", 0.0)
                                    vy = vy * mapping.get("height", 1.0) + mapping.get("y", 0.0)

                                zone_results[zn.id] = {
                                    "max": max_val,
                                    "x": vx,
                                    "y": vy
                                }
                        fetched_ok = True
                    else:
                        self._consecutive_matrix_failures += 1
                        if self._consecutive_matrix_failures >= 3:
                            self._use_fallback_only = True
                            logger.info("[ThermalAnalyzer] Switching to fallback thermometry for %s", self.camera_ip)
                except Exception as ex:
                    logger.warning("[ThermalAnalyzer] Matrix read failed for %s: %s", self.camera_ip, ex)
                    self._consecutive_matrix_failures += 1
                    if self._consecutive_matrix_failures >= 3:
                        self._use_fallback_only = True

            # 2. Dự phòng/fallback nếu matrix raw thất bại hoặc không dùng
            if not fetched_ok:
                try:
                    fallback_res = await self._read_temperatures_fallback()
                    if fallback_res:
                        point_temps, zone_results = fallback_res
                        fetched_ok = True
                except Exception as ex:
                    logger.warning("[ThermalAnalyzer] Fallback read failed for %s: %s", self.camera_ip, ex)

            # 3. Lưu cache & Ingest
            if fetched_ok:
                self._cached_point_temps = point_temps
                self._cached_zone_results = zone_results
                await self._ingest_measurements(point_temps, zone_results)
            else:
                point_temps = self._cached_point_temps
                zone_results = self._cached_zone_results
        else:
            point_temps = self._cached_point_temps
            zone_results = self._cached_zone_results

        if not point_temps and not zone_results:
            return

        # Lưu cache nhiệt độ thời gian thực cho HUD và API đọc
        self.last_point_temps = point_temps
        self.last_zone_results = zone_results

        # 4.3 Đẩy dữ liệu sang Jetson đối tác mỗi 5 phút
        now = time.time()
        if now - self._last_jetson_push >= 300.0:
            self._last_jetson_push = now 
            try:
                from datetime import datetime
                import requests
                # Hợp nhất cả điểm đo (points) và vùng đo (zones) sử dụng tên nhãn hiển thị (label)
                jetson_points = [{"id": pt.label or pt.id, "temperature": point_temps.get(pt.id)} for pt in self.points if point_temps.get(pt.id) is not None]
                jetson_points += [{"id": zn.label or zn.id, "temperature": zone_results[zn.id]["max"]} for zn in self.zones if zn.id in zone_results]
                
                if jetson_points:
                    payload = {
                        "camera_ip": self.camera_ip,
                        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "points": jetson_points
                    }
                    logger.info("[ThermalAnalyzer] Pushing %d points/zones to Jetson (%s): %s", len(jetson_points), self.camera_ip, payload)
                    try:
                        r1 = requests.post("http://192.168.10.104:8080/api/thermal-data", json=payload, timeout=5.0)
                        logger.info("[ThermalAnalyzer] Push to /api/thermal-data status: %d", r1.status_code)
                    except Exception as e:
                        logger.error("[ThermalAnalyzer] Failed to push to /api/thermal-data: %s", e)
                        
                # 4.4 Gửi cấu hình tọa độ điểm/vùng sang Jetson (KHÔNG chứa temperature)
                config_points = [{"id": pt.label or pt.id, "x": pt.x, "y": pt.y, "pre_alarm": pt.pre_alarm, "alarm": pt.alarm, "label": pt.label or pt.id} for pt in self.points]
                config_zones = [{"id": zn.label or zn.id, "polygon": zn.polygon, "pre_alarm": zn.pre_alarm, "alarm": zn.alarm, "label": zn.label or zn.id} for zn in self.zones]
                config_payload = {
                    "stream_id": self.stream_id,
                    "device_id": self.device_id,
                    "camera_ip": self.camera_ip,
                    "username": self.username,
                    "password": self.password,
                    "points": config_points,
                    "zones": config_zones
                }
                try:
                    logger.info("[ThermalAnalyzer] Pushing config to Jetson: %s", config_payload)
                    r2 = requests.post("http://192.168.10.104:8080/config/thermal", json=config_payload, timeout=5.0)
                    logger.info("[ThermalAnalyzer] Push to /config/thermal status: %d", r2.status_code)
                except Exception as e:
                    logger.error("[ThermalAnalyzer] Failed to push to /config/thermal: %s", e)
            except Exception as ex:
                logger.error("[ThermalAnalyzer] Critical push error: %s", ex)


        # 4.5 Pipeline dự báo AI cục bộ (mỗi 5 phút để đồng bộ với Jetson)
        if now - self._last_history_save >= 300.0:
            try:
                from services.thermal.thermal_forecaster import process_thermal_payload
                from datetime import datetime
                p_payload = [{"id": pt.label or pt.id, "temperature": point_temps.get(pt.id)} for pt in self.points if point_temps.get(pt.id) is not None]
                p_payload += [{"id": zn.label or zn.id, "temperature": zone_results[zn.id]["max"]} for zn in self.zones if zn.id in zone_results]
                if p_payload:
                    logger.info("[ThermalAnalyzer] Sending %d points to forecaster", len(p_payload))
                    process_thermal_payload({"timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "points": p_payload}, camera_id=self.stream_id)
                    self._last_history_save = now
                else:
                    logger.debug("[ThermalAnalyzer] No points available for forecaster")
            except Exception as e:
                logger.error("[ThermalAnalyzer] Forecaster call failed: %s", e)


        # 5. Serve MJPEG
        frame = self._reader.latest_frame if self._reader else None
        if frame is not None:
            _annotated_frames[self.stream_id] = self._annotate(frame, point_temps, zone_results)

        # 6. Check alert
        await self._check_and_alert(point_temps, zone_results)

    async def _ingest_measurements(self, point_temps: dict[str, float], zone_results: dict[str, dict]) -> None:
        """Gửi các giá trị nhiệt độ tức thời về backend."""
        payload = []
        for pt in self.points:
            temp = point_temps.get(pt.id)
            if temp is None: continue
            payload.append({"deviceId": self.device_id, "pointId": pt.id, "value": temp, "unit": "°C", "tx": pt.x, "ty": pt.y})
        for zn in self.zones:
            res = zone_results.get(zn.id)
            if not res: continue
            payload.append({"deviceId": self.device_id, "pointId": zn.id, "value": res["max"], "unit": "°C", "tx": res["x"], "ty": res["y"], "isZone": True})
        if not payload: return
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                await client.post(f"{cfg.backend_url}/api/v1/measurements/ingest", json=payload)
        except Exception: pass

    async def _read_thermal_matrix(self) -> tuple[np.ndarray, int, int, dict | None] | None:
        if not self.points and not self.zones: return None
        now = time.time()
        if now < self._auth_cooldown_until: return None
        if not hasattr(self, '_http_client'):
            self._http_client = httpx.AsyncClient(timeout=5.0)
        client = self._http_client

        if hasattr(self, '_working_channel') and self._working_channel:
            channels = [self._working_channel]
        else:
            channels = [2, 1]

        for ch in channels:
            url = f"http://{self.camera_ip}/ISAPI/Thermal/channels/{ch}/thermometry/jpegPicWithAppendData?format=json"
            try:
                resp = await client.get(url, auth=httpx.DigestAuth(self.username, self.password))
                if resp.status_code == 401:
                    self._consecutive_auth_failures += 1
                    if self._consecutive_auth_failures >= 3: self._auth_cooldown_until = now + 300
                    break
                if resp.status_code == 200:
                    self._working_channel = ch
                    self._consecutive_auth_failures = 0
                    content = resp.content
                    boundary = b'--boundary'
                    ct = resp.headers.get("content-type", "")
                    if "boundary=" in ct: boundary = f"--{ct.split('boundary=')[-1].strip()}".encode('ascii')
                    parts = content.split(boundary)
                    w, h, data_len = 256, 192, 196608
                    mapping = None
                    for part in parts:
                        if b'application/json' in part:
                            h_end = part.find(b'\r\n\r\n')
                            if h_end != -1:
                                import json
                                info = json.loads(part[h_end+4:].decode('utf-8', errors='ignore').strip()).get("JpegPictureWithAppendData", {})
                                w = info.get("thermalPicWidth") or info.get("jpegPicWidth") or 256
                                h = info.get("thermalPicHeight") or info.get("jpegPicHeight") or 192
                                data_len = info.get("p2pDataLen") or (w * h * 4)
                                mapping = info.get("VisibleValidRect")
                    for part in parts:
                        if b'application/octet-stream' in part:
                            h_end = part.find(b'\r\n\r\n')
                            if h_end != -1:
                                matrix_bytes = part[h_end+4:][:data_len]
                                raw_matrix = self._decode_thermal_matrix(matrix_bytes, int(w), int(h))
                                if raw_matrix is not None:
                                    return raw_matrix, int(w), int(h), mapping
                    break
            except Exception: pass
        return None

    def _decode_thermal_matrix(self, matrix_bytes: bytes, w: int, h: int) -> np.ndarray | None:
        """Decode Hikvision append-data thermal matrix.

        Different Hikvision thermal models expose p2p data as either 2-byte
        centi-degrees or 4-byte floats. Picking the wrong format yields values
        around 300C for normal scenes, so score candidate decodes by plausibility.
        """
        pixels = w * h
        candidates: list[np.ndarray] = []

        if len(matrix_bytes) >= pixels * 4:
            chunk4 = matrix_bytes[:pixels * 4]
            candidates.extend([
                np.frombuffer(chunk4, dtype='<f4').astype(np.float32),
                np.frombuffer(chunk4, dtype='>f4').astype(np.float32),
                np.frombuffer(chunk4, dtype='<i4').astype(np.float32) / 100.0,
                np.frombuffer(chunk4, dtype='>i4').astype(np.float32) / 100.0,
            ])

        if len(matrix_bytes) >= pixels * 2:
            chunk2 = matrix_bytes[:pixels * 2]
            candidates.extend([
                np.frombuffer(chunk2, dtype='<i2').astype(np.float32) / 100.0,
                np.frombuffer(chunk2, dtype='>i2').astype(np.float32) / 100.0,
            ])

        best = None
        best_score = -1.0
        for arr in candidates:
            if arr.size != pixels:
                continue
            finite = arr[np.isfinite(arr)]
            if finite.size < pixels * 0.95:
                continue
            physical = finite[(finite >= -40.0) & (finite <= 200.0)]
            if physical.size == 0:
                continue

            valid_ratio = physical.size / finite.size
            median = float(np.median(physical))
            p95 = float(np.percentile(physical, 95))
            center_penalty = abs(median - 35.0) / 200.0
            high_penalty = max(0.0, p95 - 120.0) / 200.0
            score = valid_ratio - center_penalty - high_penalty

            if score > best_score:
                best_score = score
                best = arr

        return best

    async def _fetch_rule_id_to_name(self) -> dict[int, str]:
        mapping = {}
        if not hasattr(self, '_http_client'):
            self._http_client = httpx.AsyncClient(timeout=5.0)
        client = self._http_client

        if hasattr(self, '_working_channel') and self._working_channel:
            channels = [self._working_channel]
        else:
            channels = [2, 1]

        for ch in channels:
            url = f"http://{self.camera_ip}/ISAPI/Thermal/channels/{ch}/thermometry/realTimeList"
            try:
                resp = await client.get(url, auth=httpx.DigestAuth(self.username, self.password))
                if resp.status_code == 200:
                    self._working_channel = ch
                    import xml.etree.ElementTree as ET
                    root = ET.fromstring(resp.content)
                    for r in root.iter():
                        tag_local = r.tag.split("}")[-1]
                        if tag_local == "ThermometryRegion":
                            rid = None
                            name_val = None
                            for child in r:
                                child_tag = child.tag.split("}")[-1]
                                if child_tag == "id":
                                    try:
                                        rid = int(child.text)
                                    except Exception:
                                        pass
                                elif child_tag == "name":
                                    name_val = child.text
                            if rid is not None and name_val is not None:
                                mapping[rid] = name_val
                    break
            except Exception as e:
                logger.error("[ThermalAnalyzer] Fallback fetch rule mapping error: %s", e)
        return mapping

    async def _read_temperatures_fallback(self) -> tuple[dict[str, float], dict[str, dict]] | None:
        if not hasattr(self, '_rule_id_to_name') or not self._rule_id_to_name:
            self._rule_id_to_name = await self._fetch_rule_id_to_name()

        if not hasattr(self, '_http_client'):
            self._http_client = httpx.AsyncClient(timeout=5.0)
        client = self._http_client

        point_temps = {}
        zone_results = {}

        if hasattr(self, '_working_channel') and self._working_channel:
            channels = [self._working_channel]
        else:
            channels = [2, 1]

        for ch in channels:
            url = f"http://{self.camera_ip}/ISAPI/Thermal/channels/{ch}/thermometry/1/rulesTemperatureInfo?format=json"
            try:
                resp = await client.get(url, auth=httpx.DigestAuth(self.username, self.password))
                if resp.status_code == 200:
                    self._working_channel = ch
                    data = resp.json()
                    rules_info = data.get("ThermometryRulesTemperatureInfoList", {}).get("ThermometryRulesTemperatureInfo", [])
                    for rule in rules_info:
                        rid = rule.get("id")
                        max_t = rule.get("maxTemperature")
                        if rid is None or max_t is None:
                            continue

                        rname = self._rule_id_to_name.get(rid, f"ID_{rid}")
                        matched = False

                        for pt in self.points:
                            if pt.id == f"P{rid}" or pt.id == str(rid) or pt.label == rname or pt.id == rname:
                                point_temps[pt.id] = float(max_t)
                                matched = True
                                break

                        if matched:
                            continue

                        for zn in self.zones:
                            if zn.id == f"Z{rid}" or zn.id == str(rid) or zn.label == rname or zn.id == rname:
                                max_pt = rule.get("MaxTemperaturePoint", {})
                                px = max_pt.get("positionX", 0.5)
                                py = max_pt.get("positionY", 0.5)
                                py_inverted = 1.0 - py

                                zone_results[zn.id] = {
                                    "max": float(max_t),
                                    "x": float(px),
                                    "y": float(py_inverted)
                                }
                                break
                    return point_temps, zone_results
            except Exception as e:
                logger.error("[ThermalAnalyzer] Fallback read temperatures error: %s", e)
        return None

    def _annotate(self, frame: np.ndarray, point_temps: dict[str, float], zone_results: dict[str, dict]) -> np.ndarray:
        out = frame.copy()
        h, w = out.shape[:2]
        font = cv2.FONT_HERSHEY_SIMPLEX
        for zn in self.zones:
            res = zone_results.get(zn.id)
            if not res: continue
            temp = res["max"]
            color = (0, 0, 255) if (zn.alarm > 0 and temp >= zn.alarm) else (0, 165, 255) if (zn.pre_alarm > 0 and temp >= zn.pre_alarm) else (0, 255, 0)
            cv2.polylines(out, [np.array([[int(p[0]*w), int(p[1]*h)] for p in zn.polygon], np.int32)], True, color, 1)
            cv2.drawMarker(out, (int(res["x"]*w), int(res["y"]*h)), color, cv2.MARKER_CROSS, 10, 1)
            cv2.putText(out, f"{zn.label}: {temp:.1f}C", (int(zn.polygon[0][0]*w), int(zn.polygon[0][1]*h) - 5), font, 0.45, color, 1, cv2.LINE_AA)
        for pt in self.points:
            temp = point_temps.get(pt.id)
            if temp is None: continue
            color = (0, 0, 255) if (pt.alarm > 0 and temp >= pt.alarm) else (0, 165, 255) if (pt.pre_alarm > 0 and temp >= pt.pre_alarm) else (0, 255, 0)
            cx, cy = int(pt.x * w), int(pt.y * h)
            cv2.drawMarker(out, (cx, cy), color, cv2.MARKER_CROSS, 12, 2)
            cv2.putText(out, pt.label, (cx + 15, cy - 4), font, 0.45, color, 1, cv2.LINE_AA)
            cv2.putText(out, f"{temp:.1f}C", (cx + 15, cy + 12), font, 0.5, color, 1, cv2.LINE_AA)
        return out

    async def _check_and_alert(self, point_temps: dict[str, float], zone_results: dict[str, dict]) -> None:
        now = time.time()
        for pt in self.points:
            temp = point_temps.get(pt.id)
            if temp is None or temp > 500.0: continue
            level = "alarm" if (pt.alarm > 0 and temp >= pt.alarm) else "pre_alarm" if (pt.pre_alarm > 0 and temp >= pt.pre_alarm) else None
            if level:
                key = f"{pt.id}:{level}"
                if now - self._last_alert.get(key, 0) >= cfg.alert_cooldown:
                    self._last_alert[key] = now
                    logger.warning("[ThermalAlert] %s trigger for %s: %.1f", level, pt.label, temp)
                    await self._send_webhook(pt.label, self.camera_ip, temp, level)
        for zn in self.zones:
            res = zone_results.get(zn.id)
            if not res or res["max"] > 500.0: continue
            temp = res["max"]
            level = "alarm" if (zn.alarm > 0 and temp >= zn.alarm) else "pre_alarm" if (zn.pre_alarm > 0 and temp >= zn.pre_alarm) else None
            if level:
                key = f"{zn.id}:{level}"
                if now - self._last_alert.get(key, 0) >= cfg.alert_cooldown:
                    self._last_alert[key] = now
                    logger.warning("[ThermalAlert] %s trigger for zone %s: %.1f", level, zn.label, temp)
                    await self._send_webhook(zn.label, self.camera_ip, temp, level)

    async def _send_webhook(self, label: str, ip: str, temp: float, level: str) -> None:
        event_type = "temperaturealarm" if level == "alarm" else "thermalexception"
        xml = f'<EventNotificationAlert version="2.0"><ipAddress>{ip}</ipAddress><eventType>{event_type}</eventType><eventState>active</eventState><channelID>2</channelID><dateTime>{_now_iso()}</dateTime><maxTemp>{temp:.2f}</maxTemp><eventDescription>Vùng/Điểm {label}: {temp:.1f}°C</eventDescription></EventNotificationAlert>'
        files = {"event": (None, xml, "application/xml")}
        frame = get_annotated_frame(self.stream_id)
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                if frame is not None:
                    _, buf = cv2.imencode(".jpg", frame); files["snapshot"] = ("snapshot.jpg", buf.tobytes(), "image/jpeg")
                    await client.post(f"{cfg.backend_url}/api/v1/camera-webhook", files=files)
                else:
                    await client.post(f"{cfg.backend_url}/api/v1/camera-webhook", content=xml, headers={"Content-Type": "application/xml"})
        except Exception: pass

_annotated_frames: dict[str, np.ndarray] = {}
def get_annotated_frame(stream_id: str) -> np.ndarray | None: return _annotated_frames.get(stream_id)
def _now_iso() -> str: from datetime import datetime, timezone; return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
