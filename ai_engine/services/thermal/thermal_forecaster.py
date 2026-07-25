"""
thermal_forecaster.py — Pipeline nhận & dự báo nhiệt độ theo chu kỳ 5 phút
"""
import os, json, csv, logging, threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional
import numpy as np

logger = logging.getLogger(__name__)
_csv_lock = threading.Lock()
BASE_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = BASE_DIR / "data"
RECEIVED_DIR = DATA_DIR / "received_data"

# Helper function to get paths dynamically based on camera/stream ID
def _get_paths(camera_id: Optional[str] = None):
    suffix = f"_{camera_id}" if camera_id else ""
    history_csv = DATA_DIR / f"live_thermal_history{suffix}.csv"
    predictions_csv = DATA_DIR / f"live_predictions{suffix}.csv"
    predictions_history_csv = DATA_DIR / f"live_predictions_history{suffix}.csv"
    return history_csv, predictions_csv, predictions_history_csv

HISTORY_CSV, PREDICTIONS_CSV, PREDICTIONS_HISTORY_CSV = _get_paths()
CONFIG_FILE = BASE_DIR / "model" / "config.json"

for _d in (DATA_DIR, RECEIVED_DIR): _d.mkdir(parents=True, exist_ok=True)

def _load_config() -> dict:
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f: return json.load(f)
    except Exception: return {"targets": ["ID_1","ID_2","ID_3","ID_4","ID_5","ID_6"], "window_size": 30, "horizon": 5}

def save_raw_payload(payload: dict) -> Path:
    ts_str = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    dest = RECEIVED_DIR / f"{ts_str}.json"
    try:
        with open(dest, "w", encoding="utf-8") as f: json.dump(payload, f, ensure_ascii=False, indent=2)
    except Exception: pass
    return dest

def thermal_json_to_row(payload: dict, targets: list[str]) -> dict:
    ts_raw = payload.get("timestamp") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try: ts = datetime.strptime(str(ts_raw), "%Y-%m-%d %H:%M:%S").strftime("%Y-%m-%d %H:%M:%S")
    except ValueError: ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    p_map = {str(pt.get("id", "")).replace(":", "_"): pt.get("temperature") for pt in payload.get("points", [])}
    row = {"timestamp": ts}
    for t in targets: row[t] = p_map.get(t)
    return row

def check_and_rotate_csv(file_path: Path, expected_fields: list[str]) -> None:
    """Cập nhật header nếu có thêm điểm đo mới mà không làm mất dữ liệu cũ."""
    if not file_path.exists(): return
    try:
        with open(file_path, "r", encoding="utf-8") as f: 
            reader = csv.reader(f)
            header = next(reader)
        
        # Nếu có trường mới, chúng ta sẽ viết lại file với header mới
        new_fields = [f for f in expected_fields if f not in header]
        if new_fields:
            logger.info("[Forecaster] Adding new fields to history CSV: %s", new_fields)
            with open(file_path, "r", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
            
            with open(file_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=expected_fields)
                writer.writeheader()
                for r in rows:
                    writer.writerow(r)
    except Exception as e:
        logger.error("[Forecaster] Header update failed: %s", e)

def append_history_row(row: dict, targets: list[str], camera_id: Optional[str] = None) -> None:
    history_csv, _, _ = _get_paths(camera_id)
    fields = ["timestamp"] + targets
    
    with _csv_lock:
        exists = history_csv.exists()
        if not exists:
            try:
                with open(history_csv, "w", newline="", encoding="utf-8") as f:
                    writer = csv.DictWriter(f, fieldnames=fields)
                    writer.writeheader()
            except Exception as e:
                logger.error("[Forecaster] Failed to create history CSV: %s", e)
                return
        else:
            check_and_rotate_csv(history_csv, fields)
        
        try:
            with open(history_csv, "r", encoding="utf-8") as f:
                actual_fields = f.readline().strip().split(",")
        except Exception:
            actual_fields = fields

        try:
            with open(history_csv, "a", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=actual_fields, extrasaction="ignore")
                writer.writerow(row)
        except Exception: pass

def _linear_predict(values: list[float], steps_ahead: float) -> float:
    """Hồi quy tuyến tính: 1 step = 5 phút."""
    n = len(values)
    if n < 2: return round(values[0], 1) if n == 1 else 0.0
    x, y = np.arange(n), np.array(values)
    try: slope, intercept = np.linalg.lstsq(np.vstack([x, np.ones(n)]).T, y, rcond=None)[0]
    except Exception: slope, intercept = 0.0, np.mean(y)
    pred = slope * (n - 1 + steps_ahead) + intercept
    return round(max(0.0, min(pred, 500.0)), 1)

def compute_prediction(targets: list[str], window_size: int, horizon: int, camera_id: Optional[str] = None) -> Optional[dict]:
    history_csv, _, _ = _get_paths(camera_id)
    if not history_csv.exists(): return None
    try:
        with open(history_csv, "r", encoding="utf-8") as f: rows = list(csv.DictReader(f))
    except Exception: return None
    recent = rows[-window_size:] if len(rows) >= 1 else []
    if not recent: return None
    last_ts = datetime.now()
    try: last_ts = datetime.strptime(recent[-1]["timestamp"], "%Y-%m-%d %H:%M:%S")
    except Exception: pass
    pred = {"issued_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "input_timestamp": last_ts.strftime("%Y-%m-%d %H:%M:%S"), "forecast_timestamp": (last_ts + timedelta(minutes=horizon*5)).strftime("%Y-%m-%d %H:%M:%S")}
    for t in targets:
        vals = [float(r[t]) for r in recent if r.get(t) is not None and r.get(t) != ""]
        pred[f"{t}_pred"] = _linear_predict(vals, horizon) if vals else None # Dự báo h bước (mỗi bước 5p)
    return pred

def save_prediction(prediction: dict, targets: list[str], camera_id: Optional[str] = None) -> dict:
    _, predictions_csv, _ = _get_paths(camera_id)
    fields = ["issued_at", "input_timestamp", "forecast_timestamp"] + [f"{t}_pred" for t in targets]
    
    with _csv_lock:
        # 1. Đọc dự đoán hiện tại đang lưu
        existing = {}
        if predictions_csv.exists():
            try:
                with open(predictions_csv, "r", encoding="utf-8") as f:
                    rows = list(csv.DictReader(f))
                    if rows:
                        existing = rows[-1]
            except Exception: pass
            
        # 2. Ghi đè tệp tin với bộ dữ liệu dự đoán mới nhận
        try:
            with open(predictions_csv, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
                writer.writeheader()
                writer.writerow(prediction)
        except Exception: pass
    return prediction

def append_prediction_history(prediction: dict, targets: list[str], camera_id: Optional[str] = None) -> None:
    _, _, predictions_history_csv = _get_paths(camera_id)
    fields = ["issued_at", "input_timestamp", "forecast_timestamp"] + [f"{t}_pred" for t in targets]
    with _csv_lock:
        check_and_rotate_csv(predictions_history_csv, fields)
        exists = predictions_history_csv.exists()
        try:
            with open(predictions_history_csv, "a", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
                if not exists: writer.writeheader()
                writer.writerow(prediction)
        except Exception: pass

def process_thermal_payload(payload: dict, camera_id: Optional[str] = None) -> dict:
    cfg = _load_config()
    targets, w_size, hor = cfg["targets"], int(cfg["window_size"]), int(cfg["horizon"])
    
    # Overwrite targets to use only the points/zones actually present in this camera's payload
    payload_targets = [str(pt.get("id", "")).replace(":", "_") for pt in payload.get("points", [])]
    if payload_targets:
        targets = payload_targets
        
    save_raw_payload(payload)
    try: row = thermal_json_to_row(payload, targets)
    except Exception as e: 
        logger.error("[Forecaster] Payload conversion failed: %s", e)
        return {"success": False}
    append_history_row(row, targets, camera_id=camera_id)
    
    # Máy trạm chỉ lưu dữ liệu thực tế. Dự báo chỉ được ghi khi Jetson gửi
    # vào POST /api/prediction, tránh tự dự báo lúc Jetson mất kết nối.
    
    return {"success": True, "timestamp": row["timestamp"]}

def load_latest_prediction(targets: list[str], camera_id: Optional[str] = None) -> Optional[dict]:
    _, predictions_csv, _ = _get_paths(camera_id)
    if not predictions_csv.exists(): return None
    with _csv_lock:
        try:
            with open(predictions_csv, "r", encoding="utf-8") as f: rows = list(csv.DictReader(f))
            if not rows: return None
            last = rows[-1]
            res = {"issued_at": last.get("issued_at"), "input_timestamp": last.get("input_timestamp"), "forecast_timestamp": last.get("forecast_timestamp")}
            for t in targets: 
                v = last.get(f"{t}_pred")
                res[f"{t}_pred"] = float(v) if v is not None and v != "" else None
            return res
        except Exception: return None

def find_matched_prediction(dt: datetime, pred_list: list[dict], max_delta_s: int = 60) -> Optional[dict]:
    """Max delta 60s for 1-minute cycle."""
    best, min_d = None, timedelta(seconds=max_delta_s)
    for p in pred_list:
        try: fts = datetime.strptime(p["forecast_timestamp"], "%Y-%m-%d %H:%M:%S")
        except Exception: continue
        d = abs(dt - fts)
        if d < min_d: min_d, best = d, p
    return best

def load_history_for_chart(targets: list[str], window_points: int = 60, horizon: int = 5, date_str: Optional[str] = None, camera_id: Optional[str] = None) -> list[dict]:
    """Trả về dữ liệu từ mốc thời gian sớm nhất có dữ liệu (tối đa 24h) của ngày được chọn."""
    import math
    def safe_float(val):
        if not val or not val.strip():
            return None
        try:
            f = float(val)
            if math.isnan(f) or math.isinf(f):
                return None
            # Loại bỏ các giá trị dị thường (ví dụ: < -50 hoặc > 300 độ C) từ camera lỗi
            if f < -50.0 or f > 300.0:
                return None
            return f
        except Exception:
            return None

    now_dt = datetime.now()
    
    # 1. Xác định ngày mục tiêu
    if date_str:
        try:
            target_date = datetime.strptime(date_str.strip(), "%Y-%m-%d")
        except Exception:
            target_date = now_dt
    else:
        target_date = now_dt
        
    is_today = (target_date.date() == now_dt.date())
    
    start_dt = target_date.replace(hour=0, minute=0, second=0, microsecond=0)
    if is_today:
        base_dt = now_dt.replace(second=0, microsecond=0)
        # Giới hạn mốc bắt đầu không quá window_points phút trước (mặc định 60, nhưng frontend đang gọi 1440)
        # Để đảm bảo chỉ hiển thị trong ngày hôm nay, ta lấy max của đầu ngày hôm nay và mốc lùi window_points
        start_dt = max(start_dt, base_dt - timedelta(minutes=window_points))
    else:
        base_dt = target_date.replace(hour=23, minute=59, second=0, microsecond=0)
    
    history_csv, _, predictions_history_csv = _get_paths(camera_id)
    all_rows = []
    if history_csv.exists():
        with _csv_lock:
            try:
                with open(history_csv, "r", encoding="utf-8") as f: all_rows = list(csv.DictReader(f))
            except Exception: pass
            
    # 2. Bucketing dữ liệu (dùng Full Key)
    history_map: dict[str, dict] = {}
    for r in all_rows:
        try:
            ts = r.get("timestamp", "")
            dt = datetime.strptime(ts[:19], "%Y-%m-%d %H:%M:%S") if len(ts) > 16 else datetime.strptime(ts[:16], "%Y-%m-%d %H:%M")
            key = dt.strftime("%Y-%m-%d %H:%M")
            if key not in history_map: history_map[key] = r.copy()
            else:
                for t in targets:
                    v = r.get(t)
                    if v and v.strip(): history_map[key][t] = v
        except Exception: continue

    raw_preds = []
    if predictions_history_csv.exists():
        with _csv_lock:
            try:
                with open(predictions_history_csv, "r", encoding="utf-8") as f: raw_preds = list(csv.DictReader(f))
            except Exception: pass

    pred_map: dict[str, dict] = {}
    for p in raw_preds:
        try:
            fts_str = p.get("forecast_timestamp", "")
            if not fts_str: continue
            fts_dt = datetime.strptime(fts_str[:19], "%Y-%m-%d %H:%M:%S")
            key = fts_dt.strftime("%Y-%m-%d %H:%M")
            if key not in pred_map: pred_map[key] = p.copy()
            else:
                for t in targets:
                    v = p.get(f"{t}_pred")
                    if v and v.strip(): pred_map[key][f"{t}_pred"] = v
        except Exception: continue

    # 3. Tạo dải thời gian liên tục từ start_dt đến base_dt
    res = []
    curr = start_dt
    while curr <= base_dt:
        full_key = curr.strftime("%Y-%m-%d %H:%M")
        display_key = curr.strftime("%H:%M")
        
        r = history_map.get(full_key, {})
        p_data = pred_map.get(full_key, {})
        
        item = {"timestamp": display_key, "full_ts": full_key}
        for t in targets:
            v = r.get(t)
            item[f"{t}_actual"] = safe_float(v)
            pv = p_data.get(f"{t}_pred")
            item[f"{t}_pred"] = safe_float(pv)
        res.append(item)
        curr += timedelta(minutes=1)

    # 4. Thêm mốc dự báo tương lai (chỉ thêm nếu là hôm nay)
    if is_today:
        for i in range(1, horizon + 1):
            target_dt = base_dt + timedelta(minutes=i)
            full_key = target_dt.strftime("%Y-%m-%d %H:%M")
            display_key = target_dt.strftime("%H:%M")
            p_data = pred_map.get(full_key, {})
            
            item = {"timestamp": display_key, "full_ts": full_key, "is_future": True}
            for t in targets:
                item[f"{t}_actual"] = None
                pv = p_data.get(f"{t}_pred")
                item[f"{t}_pred"] = safe_float(pv)
            res.append(item)

    return res
