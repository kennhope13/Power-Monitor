import os
import math
from PIL import Image, ImageDraw, ImageFont

# Set up paths
output_dir = "/home/admin-/Desktop/Power-Monitor/docs/diagrams"
os.makedirs(output_dir, exist_ok=True)

# Colors
BG_COLOR = (252, 253, 253)
BOX_BG = (238, 244, 248)
BORDER_COLOR = (44, 82, 130)
TEXT_COLOR = (45, 55, 72)
HEADER_BG = (208, 225, 253)
ARROW_COLOR = (49, 130, 206)
WHITE = (255, 255, 255)

# Fonts: DejaVu Sans has excellent Vietnamese character support
try:
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)
    font_bold = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 13)
    font_title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 16)
except:
    font = ImageFont.load_default()
    font_bold = ImageFont.load_default()
    font_title = ImageFont.load_default()

def draw_arrow(draw, start, end, label=""):
    # Draw line
    draw.line([start, end], fill=ARROW_COLOR, width=2)
    # Draw arrowhead
    x1, y1 = start
    x2, y2 = end
    angle = math.atan2(y2 - y1, x2 - x1)
    arrow_len = 10
    px1 = x2 - arrow_len * math.cos(angle - math.pi/6)
    py1 = y2 - arrow_len * math.sin(angle - math.pi/6)
    px2 = x2 - arrow_len * math.cos(angle + math.pi/6)
    py2 = y2 - arrow_len * math.sin(angle + math.pi/6)
    draw.polygon([(x2, y2), (px1, py1), (px2, py2)], fill=ARROW_COLOR)
    
    # Label drawing with backing masking box to prevent line overlaps
    if label:
        text_w = draw.textlength(label, font=font)
        text_h = 14
        lx = (x1 + x2) / 2 - text_w / 2
        ly = (y1 + y2) / 2 - text_h / 2
        # Mask out the line behind the text
        draw.rectangle([lx - 4, ly - 2, lx + text_w + 4, ly + text_h + 2], fill=BG_COLOR)
        # Render the text
        draw.text((lx, ly), label, fill=TEXT_COLOR, font=font)

def draw_rounded_rect(draw, coords, r, fill, outline, width=2):
    x1, y1, x2, y2 = coords
    draw.rectangle([x1+r, y1, x2-r, y2], fill=fill)
    draw.rectangle([x1, y1+r, x2, y2-r], fill=fill)
    draw.ellipse([x1, y1, x1+2*r, y1+2*r], fill=fill)
    draw.ellipse([x2-2*r, y1, x2, y1+2*r], fill=fill)
    draw.ellipse([x1, y2-2*r, x1+2*r, y2], fill=fill)
    draw.ellipse([x2-2*r, y2-2*r, x2, y2], fill=fill)
    # Outline
    draw.line([x1+r, y1, x2-r, y1], fill=outline, width=width)
    draw.line([x1+r, y2, x2-r, y2], fill=outline, width=width)
    draw.line([x1, y1+r, x1, y2-r], fill=outline, width=width)
    draw.line([x2, y1+r, x2, y2-r], fill=outline, width=width)
    draw.arc([x1, y1, x1+2*r, y1+2*r], 180, 270, fill=outline, width=width)
    draw.arc([x2-2*r, y1, x2, y1+2*r], 270, 360, fill=outline, width=width)
    draw.arc([x1, y2-2*r, x1+2*r, y2], 90, 180, fill=outline, width=width)
    draw.arc([x2-2*r, y2-2*r, x2, y2], 0, 90, fill=outline, width=width)

# ==========================================
# 1. Architecture Diagram
# ==========================================
img = Image.new('RGB', (850, 480), BG_COLOR)
draw = ImageDraw.Draw(img)

draw.text((20, 20), "SƠ ĐỒ KIẾN TRÚC HỆ THỐNG STATIONOS (ALL-IN-ONE)", fill=BORDER_COLOR, font=font_title)

# Client Container
draw_rounded_rect(draw, [40, 80, 270, 420], 10, BOX_BG, BORDER_COLOR)
draw.rectangle([40, 80, 270, 110], fill=HEADER_BG)
draw.text((50, 88), "CLIENT (Electron + React)", fill=TEXT_COLOR, font=font_bold)
draw.text((55, 130), "- UI Render: Port 6173\n- Giao diện giám sát SLD\n- CCTV & Camera Nhiệt\n- Biểu đồ PD Analytics\n- Quản lý thiết bị\n- Xác thực & Phân quyền", fill=TEXT_COLOR, font=font)

# Service Container
draw_rounded_rect(draw, [330, 80, 570, 420], 10, BOX_BG, BORDER_COLOR)
draw.rectangle([330, 80, 570, 110], fill=HEADER_BG)
draw.text((340, 88), "SERVICE (ASP.NET Core)", fill=TEXT_COLOR, font=font_bold)
draw.text((345, 130), "- API Backend: Port 5050\n- go2rtc Streamer: Port 1984\n- Hub SignalR Realtime\n- PlcPollingWorker (S7)\n- CentralSyncWorker\n- License Checker Engine", fill=TEXT_COLOR, font=font)

# Database Container
draw_rounded_rect(draw, [630, 80, 830, 420], 10, BOX_BG, BORDER_COLOR)
draw.rectangle([630, 80, 830, 110], fill=HEADER_BG)
draw.text((640, 88), "DATABASE (PostgreSQL)", fill=TEXT_COLOR, font=font_bold)
draw.text((645, 130), "- PG Portable: Port 6432\n- Table Stations / Devices\n- Table SensorReadings\n- Table Alerts / Rules\n- Table SyncQueues\n- Table MaintenanceTasks", fill=TEXT_COLOR, font=font)

# Arrows
draw_arrow(draw, (270, 160), (330, 160), "HTTP/WS")
draw_arrow(draw, (270, 320), (330, 320), "WebRTC")
draw_arrow(draw, (570, 240), (630, 240), "EF Core")

img.save(os.path.join(output_dir, "architecture_diagram.png"))

# ==========================================
# 2. Use Case Diagram
# ==========================================
img = Image.new('RGB', (850, 550), BG_COLOR)
draw = ImageDraw.Draw(img)

draw.text((20, 20), "SƠ ĐỒ USE CASE HỆ THỐNG STATIONOS", fill=BORDER_COLOR, font=font_title)

# System boundary
draw.rectangle([200, 60, 650, 520], outline=BORDER_COLOR, width=2)
draw.text((210, 70), "Hệ thống StationOS (Trạm con)", fill=BORDER_COLOR, font=font_bold)

# Use Cases
ucs = [
    ("Đăng nhập hệ thống (RBAC)", 100),
    ("Giám sát sơ đồ một sợi SLD", 170),
    ("Xem camera Live & Nhiệt", 240),
    ("Nhận cảnh báo & Kích còi báo", 310),
    ("Cấu hình quy tắc cảnh báo", 380),
    ("Nhập & Kiểm tra License bản quyền", 450)
]

for name, y in ucs:
    draw.ellipse([300, y, 550, y+45], outline=BORDER_COLOR, fill=BOX_BG, width=2)
    w = draw.textlength(name, font=font)
    draw.text((425 - w/2, y + 14), name, fill=TEXT_COLOR, font=font)

# Actors
def draw_actor(draw, x, y, label):
    draw.ellipse([x-12, y, x+12, y+24], outline=BORDER_COLOR, fill=WHITE, width=2)
    draw.line([x, y+24, x, y+55], fill=BORDER_COLOR, width=2)
    draw.line([x-20, y+35, x+20, y+35], fill=BORDER_COLOR, width=2)
    draw.line([x, y+55, x-15, y+75], fill=BORDER_COLOR, width=2)
    draw.line([x, y+55, x+15, y+75], fill=BORDER_COLOR, width=2)
    w = draw.textlength(label, font=font_bold)
    draw.text((x - w/2, y + 80), label, fill=TEXT_COLOR, font=font_bold)

# Left Actors
draw_actor(draw, 80, 100, "Quản trị viên")
draw_actor(draw, 80, 320, "Nhân viên trực ban")

# Connect actors to UCs
draw.line([100, 140, 300, 122], fill=BORDER_COLOR, width=1)
draw.line([100, 140, 300, 402], fill=BORDER_COLOR, width=1)
draw.line([100, 140, 300, 472], fill=BORDER_COLOR, width=1)

draw.line([100, 360, 300, 122], fill=BORDER_COLOR, width=1)
draw.line([100, 360, 300, 192], fill=BORDER_COLOR, width=1)
draw.line([100, 360, 300, 262], fill=BORDER_COLOR, width=1)
draw.line([100, 360, 300, 332], fill=BORDER_COLOR, width=1)

# Right External System
draw.rectangle([700, 220, 820, 300], fill=BOX_BG, outline=BORDER_COLOR, width=2)
draw.text((712, 240), "Hệ thống\nTrạm Tổng\n(Central API)", fill=TEXT_COLOR, font=font_bold)

# Connect Central to UCs (e.g. Sync)
draw.line([550, 332, 700, 260], fill=BORDER_COLOR, width=1)

img.save(os.path.join(output_dir, "usecase_diagram.png"))

# ==========================================
# 3. Class Diagram
# ==========================================
img = Image.new('RGB', (950, 580), BG_COLOR)
draw = ImageDraw.Draw(img)

draw.text((20, 20), "SƠ ĐỒ LỚP HỆ THỐNG STATIONOS (UML CLASS DIAGRAM)", fill=BORDER_COLOR, font=font_title)

# Station
draw.rectangle([40, 80, 240, 240], fill=BOX_BG, outline=BORDER_COLOR, width=2)
draw.rectangle([40, 80, 240, 105], fill=HEADER_BG)
draw.text((50, 85), "Station (Trạm)", fill=TEXT_COLOR, font=font_bold)
draw.text((45, 115), "+ Id: Guid\n+ Code: string\n+ Name: string\n+ Location: string\n+ Status: string", fill=TEXT_COLOR, font=font)

# Device
draw.rectangle([340, 80, 580, 260], fill=BOX_BG, outline=BORDER_COLOR, width=2)
draw.rectangle([340, 80, 580, 105], fill=HEADER_BG)
draw.text((350, 85), "Device (Thiết bị)", fill=TEXT_COLOR, font=font_bold)
draw.text((345, 115), "+ Id: Guid\n+ StationId: Guid\n+ Name: string\n+ Type: string\n+ Protocol: string\n+ Config: string\n+ IsOnline: bool\n+ Status: string", fill=TEXT_COLOR, font=font)

# SensorReading
draw.rectangle([680, 80, 920, 260], fill=BOX_BG, outline=BORDER_COLOR, width=2)
draw.rectangle([680, 80, 920, 105], fill=HEADER_BG)
draw.text((690, 85), "SensorReading (Giá trị đo)", fill=TEXT_COLOR, font=font_bold)
draw.text((685, 115), "+ Id: int\n+ Time: DateTime\n+ DeviceId: Guid\n+ PointId: string\n+ Value: double?\n+ Unit: string\n+ Quality: int", fill=TEXT_COLOR, font=font)

# Rule
draw.rectangle([40, 320, 240, 480], fill=BOX_BG, outline=BORDER_COLOR, width=2)
draw.rectangle([40, 320, 240, 345], fill=HEADER_BG)
draw.text((50, 325), "Rule (Quy tắc)", fill=TEXT_COLOR, font=font_bold)
draw.text((45, 355), "+ Id: Guid\n+ StationId: Guid\n+ Name: string\n+ Condition: string\n+ Actions: string\n+ Enabled: bool", fill=TEXT_COLOR, font=font)

# Alert
draw.rectangle([340, 320, 580, 530], fill=BOX_BG, outline=BORDER_COLOR, width=2)
draw.rectangle([340, 320, 580, 345], fill=HEADER_BG)
draw.text((350, 325), "Alert (Cảnh báo)", fill=TEXT_COLOR, font=font_bold)
draw.text((345, 355), "+ Id: Guid\n+ StationId: Guid\n+ PointId: string\n+ Message: string\n+ Severity: string\n+ ValueTrigger: double\n+ Timestamp: DateTime\n+ Acknowledged: bool\n+ AckBy: string", fill=TEXT_COLOR, font=font)

# SyncQueue
draw.rectangle([680, 320, 920, 500], fill=BOX_BG, outline=BORDER_COLOR, width=2)
draw.rectangle([680, 320, 920, 345], fill=HEADER_BG)
draw.text((690, 325), "SyncQueue (Hàng đợi)", fill=TEXT_COLOR, font=font_bold)
draw.text((685, 355), "+ Id: long\n+ EntityType: string\n+ EntityId: Guid\n+ Payload: string\n+ Status: string\n+ RetryCount: int\n+ CreatedAt: DateTime", fill=TEXT_COLOR, font=font)

# Relations
draw.line([240, 160, 340, 160], fill=BORDER_COLOR, width=2)
draw.text((250, 140), "1", fill=TEXT_COLOR, font=font)
draw.text((320, 140), "*", fill=TEXT_COLOR, font=font)

draw.line([580, 160, 680, 160], fill=BORDER_COLOR, width=2)
draw.text((590, 140), "1", fill=TEXT_COLOR, font=font)
draw.text((660, 140), "*", fill=TEXT_COLOR, font=font)

draw.line([140, 240, 140, 320], fill=BORDER_COLOR, width=2)
draw.line([460, 260, 460, 320], fill=BORDER_COLOR, width=2)

img.save(os.path.join(output_dir, "class_diagram.png"))

# ==========================================
# 4. Activity Diagram
# ==========================================
img = Image.new('RGB', (850, 480), BG_COLOR)
draw = ImageDraw.Draw(img)

draw.text((20, 20), "SƠ ĐỒ HOẠT ĐỘNG THU THẬP TELEMETRY & ĐÁNH GIÁ CẢNH BÁO", fill=BORDER_COLOR, font=font_title)

# Start node
draw.ellipse([400, 50, 420, 70], fill=BORDER_COLOR)
draw_arrow(draw, (410, 70), (410, 100))

# Activity 1: Read Sensors
draw_rounded_rect(draw, [250, 100, 570, 140], 5, BOX_BG, BORDER_COLOR)
draw.text((265, 113), "Đọc dữ liệu cảm biến (PLC S7, Modbus, Camera Nhiệt)", fill=TEXT_COLOR, font=font_bold)
draw_arrow(draw, (410, 140), (410, 170))

# Decision 1
draw.polygon([(410, 170), (450, 190), (410, 210), (370, 190)], outline=BORDER_COLOR, fill=HEADER_BG, width=2)
draw.text((460, 183), "Thành công?", fill=TEXT_COLOR, font=font)

# Success arrow
draw_arrow(draw, (410, 210), (410, 250), "Có")
# Fail arrow
draw.line([370, 190, 180, 190], fill=ARROW_COLOR, width=2)
draw_arrow(draw, (180, 190), (180, 250), "Không")

# Fail Action
draw_rounded_rect(draw, [80, 250, 280, 290], 5, BOX_BG, BORDER_COLOR)
draw.text((95, 263), "Ghi nhận Offline, Quality=2", fill=TEXT_COLOR, font=font)

# Success Action
draw_rounded_rect(draw, [300, 250, 520, 290], 5, BOX_BG, BORDER_COLOR)
draw.text((315, 263), "Ghi nhận số đo, Quality=1", fill=TEXT_COLOR, font=font)

draw_arrow(draw, (410, 290), (410, 330))
draw.line([180, 290, 180, 310], fill=ARROW_COLOR, width=2)
draw.line([180, 310, 410, 310], fill=ARROW_COLOR, width=2)

# Activity 3: Rule Evaluation
draw_rounded_rect(draw, [250, 330, 570, 370], 5, BOX_BG, BORDER_COLOR)
draw.text((275, 343), "Đánh giá quy tắc cảnh báo & Đẩy SignalR", fill=TEXT_COLOR, font=font_bold)
draw_arrow(draw, (410, 370), (410, 410))

# End Node
draw.ellipse([400, 410, 420, 430], fill=WHITE, outline=BORDER_COLOR, width=2)
draw.ellipse([404, 414, 416, 426], fill=BORDER_COLOR)

img.save(os.path.join(output_dir, "activity_diagram.png"))

# ==========================================
# 5. State Diagram
# ==========================================
img = Image.new('RGB', (850, 420), BG_COLOR)
draw = ImageDraw.Draw(img)

draw.text((20, 20), "SƠ ĐỒ TRẠNG THÁI THIẾT BỊ VÀ VÒNG ĐỜI CẢNH BÁO", fill=BORDER_COLOR, font=font_title)

# Device Connection state
draw.text((60, 60), "1. Trạng thái kết nối thiết bị", fill=BORDER_COLOR, font=font_bold)
draw_rounded_rect(draw, [60, 100, 180, 140], 5, BOX_BG, BORDER_COLOR)
draw.text((85, 113), "UNKNOWN", fill=TEXT_COLOR, font=font_bold)
draw_rounded_rect(draw, [300, 100, 420, 140], 5, BOX_BG, BORDER_COLOR)
draw.text((330, 113), "ONLINE", fill=TEXT_COLOR, font=font_bold)
draw_rounded_rect(draw, [180, 220, 300, 260], 5, BOX_BG, BORDER_COLOR)
draw.text((210, 233), "OFFLINE", fill=TEXT_COLOR, font=font_bold)

draw_arrow(draw, (180, 120), (300, 120), "Ping OK")
draw_arrow(draw, (360, 140), (300, 220), "Mất Ping")
draw_arrow(draw, (180, 240), (120, 140), "Có Ping lại")

# Alert state
draw.text((480, 60), "2. Vòng đời Cảnh báo sự cố (Alert)", fill=BORDER_COLOR, font=font_bold)
draw_rounded_rect(draw, [480, 100, 600, 140], 5, BOX_BG, BORDER_COLOR)
draw.text((520, 113), "ACTIVE", fill=TEXT_COLOR, font=font_bold)
draw_rounded_rect(draw, [700, 100, 820, 140], 5, BOX_BG, BORDER_COLOR)
draw.text((735, 113), "ACKNOWLEDGED", fill=TEXT_COLOR, font=font_bold)
draw_rounded_rect(draw, [590, 220, 710, 260], 5, BOX_BG, BORDER_COLOR)
draw.text((625, 233), "RESOLVED", fill=TEXT_COLOR, font=font_bold)

draw_arrow(draw, (600, 120), (700, 120), "Bấm Xác nhận")
draw_arrow(draw, (760, 140), (710, 220), "Về bình thường")
draw_arrow(draw, (590, 240), (540, 140), "Reset")

img.save(os.path.join(output_dir, "state_diagram.png"))

# ==========================================
# 6. Database ERD Diagram
# ==========================================
img = Image.new('RGB', (950, 620), BG_COLOR)
draw = ImageDraw.Draw(img)

draw.text((20, 20), "SƠ ĐỒ MỐI QUAN HỆ CƠ SỞ DỮ LIỆU THỰC TẾ (DATABASE ERD SCHEMA)", fill=BORDER_COLOR, font=font_title)

# Stations
draw.rectangle([40, 70, 260, 230], outline=BORDER_COLOR, fill=BOX_BG, width=2)
draw.rectangle([40, 70, 260, 95], fill=HEADER_BG)
draw.text((45, 75), "Stations (Trạm giám sát)", fill=TEXT_COLOR, font=font_bold)
draw.text((45, 105), "* Id: uuid (PK)\n- Code: varchar(50) (UQ)\n- Name: varchar(200)\n- Location: text\n- Status: varchar(20)", fill=TEXT_COLOR, font=font)

# Devices
draw.rectangle([340, 70, 600, 260], outline=BORDER_COLOR, fill=BOX_BG, width=2)
draw.rectangle([340, 70, 600, 95], fill=HEADER_BG)
draw.text((345, 75), "Devices (Thiết bị kết nối)", fill=TEXT_COLOR, font=font_bold)
draw.text((345, 105), "* Id: uuid (PK)\n- StationId: uuid (FK)\n- Name: varchar(150)\n- Type: varchar(50)\n- Protocol: varchar(50)\n- Config: text\n- IsOnline: boolean", fill=TEXT_COLOR, font=font)

# SensorReadings
draw.rectangle([680, 70, 910, 260], outline=BORDER_COLOR, fill=BOX_BG, width=2)
draw.rectangle([680, 70, 910, 95], fill=HEADER_BG)
draw.text((685, 75), "SensorReadings (Số đo)", fill=TEXT_COLOR, font=font_bold)
draw.text((685, 105), "* Id: serial (PK)\n- Time: timestamp\n- StationId: uuid (FK)\n- DeviceId: uuid (FK)\n- PointId: varchar(100)\n- Value: double\n- Quality: integer", fill=TEXT_COLOR, font=font)

# Rules
draw.rectangle([40, 290, 260, 450], outline=BORDER_COLOR, fill=BOX_BG, width=2)
draw.rectangle([40, 290, 260, 315], fill=HEADER_BG)
draw.text((45, 295), "Rules (Quy tắc)", fill=TEXT_COLOR, font=font_bold)
draw.text((45, 325), "* Id: uuid (PK)\n- StationId: uuid (FK)\n- Name: varchar(200)\n- Condition: text\n- Actions: text\n- Enabled: boolean", fill=TEXT_COLOR, font=font)

# Alerts
draw.rectangle([340, 290, 600, 520], outline=BORDER_COLOR, fill=BOX_BG, width=2)
draw.rectangle([340, 290, 600, 315], fill=HEADER_BG)
draw.text((345, 295), "Alerts (Cảnh báo)", fill=TEXT_COLOR, font=font_bold)
draw.text((345, 325), "* Id: uuid (PK)\n- StationId: uuid (FK)\n- PointId: varchar(100)\n- Message: varchar(500)\n- Severity: varchar(20)\n- ValueTrigger: double\n- Timestamp: timestamp\n- Acknowledged: boolean", fill=TEXT_COLOR, font=font)

# Relations (Lines)
draw.line([260, 140, 340, 140], fill=BORDER_COLOR, width=2)
draw.line([600, 160, 680, 160], fill=BORDER_COLOR, width=2)
draw.line([150, 230, 150, 290], fill=BORDER_COLOR, width=2)
draw.line([470, 260, 470, 290], fill=BORDER_COLOR, width=2)

img.save(os.path.join(output_dir, "erd_diagram.png"))

print("All 6 diagrams generated successfully at docs/diagrams")
