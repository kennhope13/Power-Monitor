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

def draw_container(draw, x, y, title, lines, width=270, height=320):
    draw_rounded_rect(draw, [x, y, x + width, y + height], 10, BOX_BG, BORDER_COLOR)
    draw.rectangle([x, y, x + width, y + 30], fill=HEADER_BG)
    title_w = draw.textlength(title, font=font_bold)
    draw.text((x + (width - title_w)/2, y + 8), title, fill=TEXT_COLOR, font=font_bold)
    yy = y + 45
    for line in lines:
        draw.text((x + 15, yy), line, fill=TEXT_COLOR, font=font)
        yy += 20

def draw_class_box(draw, x, y, title, lines, width=280, height=180):
    draw_rounded_rect(draw, [x, y, x + width, y + height], 8, BOX_BG, BORDER_COLOR)
    draw.rectangle([x, y, x + width, y + 25], fill=HEADER_BG)
    title_w = draw.textlength(title, font=font_bold)
    draw.text((x + (width - title_w)/2, y + 5), title, fill=TEXT_COLOR, font=font_bold)
    yy = y + 35
    for line in lines:
        draw.text((x + 12, yy), line, fill=TEXT_COLOR, font=font)
        yy += 18

# ==========================================
# 1. Architecture Diagram
# ==========================================
img = Image.new('RGB', (960, 480), BG_COLOR)
draw = ImageDraw.Draw(img)
draw.text((20, 20), "SƠ ĐỒ KIẾN TRÚC HỆ THỐNG STATIONOS (ALL-IN-ONE)", fill=BORDER_COLOR, font=font_title)

draw_container(draw, 40, 80, "CLIENT (Electron + React)", [
    "- UI Render: Port 6173",
    "- Giao diện sơ đồ một sợi SLD",
    "- CCTV & Camera Nhiệt",
    "- Biểu đồ PD Analytics",
    "- Quản lý thiết bị trạm con",
    "- Xác thực & Phân quyền"
], width=260, height=340)

draw_container(draw, 340, 80, "SERVICE (ASP.NET Core)", [
    "- API Backend: Port 5050",
    "- go2rtc Streamer: Port 1984",
    "- Hub SignalR Realtime",
    "- PlcPollingWorker (S7)",
    "- CentralSyncWorker",
    "- License Checker Engine"
], width=280, height=340)

draw_container(draw, 660, 80, "DATABASE (PostgreSQL)", [
    "- PG Portable: Port 6432",
    "- Table Stations / Devices",
    "- Table SensorReadings",
    "- Table Alerts / Rules",
    "- Table SyncQueues",
    "- Table MaintenanceTasks"
], width=260, height=340)

draw_arrow(draw, (300, 160), (340, 160), "HTTP/WS")
draw_arrow(draw, (300, 320), (340, 320), "WebRTC")
draw_arrow(draw, (620, 240), (660, 240), "EF Core")

img.save(os.path.join(output_dir, "architecture_diagram.png"))

# ==========================================
# 2. Use Case Diagram
# ==========================================
img = Image.new('RGB', (950, 550), BG_COLOR)
draw = ImageDraw.Draw(img)
draw.text((20, 20), "SƠ ĐỒ USE CASE HỆ THỐNG STATIONOS", fill=BORDER_COLOR, font=font_title)

# System boundary
draw.rectangle([200, 60, 750, 520], outline=BORDER_COLOR, width=2)
draw.text((210, 70), "Hệ thống StationOS (Trạm con)", fill=BORDER_COLOR, font=font_bold)

# Use Cases (widened ellipse, centered text)
ucs = [
    ("Đăng nhập hệ thống (RBAC)", 100),
    ("Giám sát sơ đồ một sợi SLD", 170),
    ("Xem camera Live & Nhiệt", 240),
    ("Nhận cảnh báo & Kích còi báo", 310),
    ("Cấu hình quy tắc cảnh báo", 380),
    ("Nhập & Kiểm tra License bản quyền", 450)
]

for name, y in ucs:
    draw.ellipse([280, y, 620, y+45], outline=BORDER_COLOR, fill=BOX_BG, width=2)
    w = draw.textlength(name, font=font)
    draw.text((450 - w/2, y + 14), name, fill=TEXT_COLOR, font=font)

# Actors
def draw_actor(draw, x, y, label):
    draw.ellipse([x-12, y, x+12, y+24], outline=BORDER_COLOR, fill=WHITE, width=2)
    draw.line([x, y+24, x, y+55], fill=BORDER_COLOR, width=2)
    draw.line([x-20, y+35, x+20, y+35], fill=BORDER_COLOR, width=2)
    draw.line([x, y+55, x-15, y+75], fill=BORDER_COLOR, width=2)
    draw.line([x, y+55, x+15, y+75], fill=BORDER_COLOR, width=2)
    w = draw.textlength(label, font=font_bold)
    draw.text((x - w/2, y + 80), label, fill=TEXT_COLOR, font=font_bold)

draw_actor(draw, 80, 100, "Quản trị viên")
draw_actor(draw, 80, 320, "Nhân viên trực ban")

draw.line([100, 140, 280, 122], fill=BORDER_COLOR, width=1)
draw.line([100, 140, 280, 402], fill=BORDER_COLOR, width=1)
draw.line([100, 140, 280, 472], fill=BORDER_COLOR, width=1)

draw.line([100, 360, 280, 122], fill=BORDER_COLOR, width=1)
draw.line([100, 360, 280, 192], fill=BORDER_COLOR, width=1)
draw.line([100, 360, 280, 262], fill=BORDER_COLOR, width=1)
draw.line([100, 360, 280, 332], fill=BORDER_COLOR, width=1)

# Right External System
draw.rectangle([760, 220, 900, 300], fill=BOX_BG, outline=BORDER_COLOR, width=2)
lines_ext = ["Hệ thống", "Trạm Trung tâm", "(Central API)"]
yy_ext = 230
for line_ext in lines_ext:
    w_ext = draw.textlength(line_ext, font=font_bold)
    draw.text((830 - w_ext/2, yy_ext), line_ext, fill=TEXT_COLOR, font=font_bold)
    yy_ext += 20
draw.line([620, 332, 760, 260], fill=BORDER_COLOR, width=1)

img.save(os.path.join(output_dir, "usecase_diagram.png"))

# ==========================================
# 3. Class Diagram
# ==========================================
img = Image.new('RGB', (1000, 580), BG_COLOR)
draw = ImageDraw.Draw(img)
draw.text((20, 20), "SƠ ĐỒ LỚP HỆ THỐNG STATIONOS (UML CLASS DIAGRAM)", fill=BORDER_COLOR, font=font_title)

draw_class_box(draw, 40, 80, "Station (Trạm)", [
    "+ Id: Guid",
    "+ Code: string",
    "+ Name: string",
    "+ Location: string",
    "+ Status: string"
], width=250, height=180)

draw_class_box(draw, 330, 80, "Device (Thiết bị)", [
    "+ Id: Guid",
    "+ StationId: Guid",
    "+ Name: string",
    "+ Type: string",
    "+ Protocol: string",
    "+ Config: string",
    "+ IsOnline: bool",
    "+ Status: string"
], width=290, height=200)

draw_class_box(draw, 660, 80, "SensorReading (Giá trị đo)", [
    "+ Id: int",
    "+ Time: DateTime",
    "+ DeviceId: Guid",
    "+ PointId: string",
    "+ Value: double?",
    "+ Unit: string",
    "+ Quality: int"
], width=290, height=200)

draw_class_box(draw, 40, 320, "Rule (Quy tắc)", [
    "+ Id: Guid",
    "+ StationId: Guid",
    "+ Name: string",
    "+ Condition: string",
    "+ Actions: string",
    "+ Enabled: bool"
], width=250, height=180)

draw_class_box(draw, 330, 320, "Alert (Cảnh báo)", [
    "+ Id: Guid",
    "+ StationId: Guid",
    "+ PointId: string",
    "+ Message: string",
    "+ Severity: string",
    "+ ValueTrigger: double",
    "+ Timestamp: DateTime",
    "+ Acknowledged: bool",
    "+ AckBy: string"
], width=290, height=220)

draw_class_box(draw, 660, 320, "SyncQueue (Hàng đợi)", [
    "+ Id: long",
    "+ EntityType: string",
    "+ EntityId: Guid",
    "+ Payload: string",
    "+ Status: string",
    "+ RetryCount: int",
    "+ CreatedAt: DateTime"
], width=290, height=200)

draw.line([290, 160, 330, 160], fill=BORDER_COLOR, width=2)
draw.text((298, 140), "1", fill=TEXT_COLOR, font=font)
draw.text((318, 140), "*", fill=TEXT_COLOR, font=font)

draw.line([620, 160, 660, 160], fill=BORDER_COLOR, width=2)
draw.text((628, 140), "1", fill=TEXT_COLOR, font=font)
draw.text((648, 140), "*", fill=TEXT_COLOR, font=font)

draw.line([140, 260, 140, 320], fill=BORDER_COLOR, width=2)
draw.line([475, 280, 475, 320], fill=BORDER_COLOR, width=2)

img.save(os.path.join(output_dir, "class_diagram.png"))

# ==========================================
# 4. Activity Diagram
# ==========================================
img = Image.new('RGB', (950, 480), BG_COLOR)
draw = ImageDraw.Draw(img)
draw.text((20, 20), "SƠ ĐỒ HOẠT ĐỘNG THU THẬP TELEMETRY & ĐÁNH GIÁ CẢNH BÁO", fill=BORDER_COLOR, font=font_title)

# Start node centered at X=425
draw.ellipse([415, 50, 435, 70], fill=BORDER_COLOR)
draw_arrow(draw, (425, 70), (425, 100))

# Activity 1: Read Sensors
draw_rounded_rect(draw, [220, 100, 630, 140], 5, BOX_BG, BORDER_COLOR)
w = draw.textlength("Đọc dữ liệu cảm biến (PLC S7, Modbus, Camera Nhiệt)", font=font_bold)
draw.text((425 - w/2, 113), "Đọc dữ liệu cảm biến (PLC S7, Modbus, Camera Nhiệt)", fill=TEXT_COLOR, font=font_bold)
draw_arrow(draw, (425, 140), (425, 170))

# Decision 1
draw.polygon([(425, 170), (465, 190), (425, 210), (385, 190)], outline=BORDER_COLOR, fill=HEADER_BG, width=2)
draw.text((475, 183), "Thành công?", fill=TEXT_COLOR, font=font)

# Success arrow
draw_arrow(draw, (425, 210), (425, 250), "Có")
# Fail arrow
draw.line([385, 190, 170, 190], fill=ARROW_COLOR, width=2)
draw_arrow(draw, (170, 190), (170, 250), "Không")

# Fail Action
draw_rounded_rect(draw, [60, 250, 280, 290], 5, BOX_BG, BORDER_COLOR)
draw.text((75, 263), "Ghi nhận Offline, Quality=2", fill=TEXT_COLOR, font=font)

# Success Action
draw_rounded_rect(draw, [300, 250, 540, 290], 5, BOX_BG, BORDER_COLOR)
draw.text((315, 263), "Ghi nhận số đo, Quality=1", fill=TEXT_COLOR, font=font)

draw_arrow(draw, (425, 290), (425, 330))
draw.line([170, 290, 170, 310], fill=ARROW_COLOR, width=2)
draw.line([170, 310, 425, 310], fill=ARROW_COLOR, width=2)

# Activity 3: Rule Evaluation
draw_rounded_rect(draw, [220, 330, 630, 370], 5, BOX_BG, BORDER_COLOR)
w = draw.textlength("Đánh giá quy tắc cảnh báo & Đẩy SignalR", font=font_bold)
draw.text((425 - w/2, 343), "Đánh giá quy tắc cảnh báo & Đẩy SignalR", fill=TEXT_COLOR, font=font_bold)
draw_arrow(draw, (425, 370), (425, 410))

# End Node
draw.ellipse([415, 410, 435, 430], fill=WHITE, outline=BORDER_COLOR, width=2)
draw.ellipse([419, 414, 431, 426], fill=BORDER_COLOR)

img.save(os.path.join(output_dir, "activity_diagram.png"))

# ==========================================
# 5. State Diagram
# ==========================================
img = Image.new('RGB', (950, 420), BG_COLOR)
draw = ImageDraw.Draw(img)
draw.text((20, 20), "SƠ ĐỒ TRẠNG THÁI THIẾT BỊ VÀ VÒNG ĐỜI CẢNH BÁO", fill=BORDER_COLOR, font=font_title)

# Device Connection state
draw.text((60, 60), "1. Trạng thái kết nối thiết bị", fill=BORDER_COLOR, font=font_bold)
draw_rounded_rect(draw, [40, 100, 200, 140], 5, BOX_BG, BORDER_COLOR)
draw.text((78, 113), "UNKNOWN", fill=TEXT_COLOR, font=font_bold)

draw_rounded_rect(draw, [320, 100, 480, 140], 5, BOX_BG, BORDER_COLOR)
draw.text((368, 113), "ONLINE", fill=TEXT_COLOR, font=font_bold)

draw_rounded_rect(draw, [180, 220, 340, 260], 5, BOX_BG, BORDER_COLOR)
draw.text((228, 233), "OFFLINE", fill=TEXT_COLOR, font=font_bold)

draw_arrow(draw, (200, 120), (320, 120), "Ping OK")
draw_arrow(draw, (380, 140), (300, 220), "Mất Ping")
draw_arrow(draw, (180, 240), (120, 140), "Có Ping lại")

# Alert state
draw.text((500, 60), "2. Vòng đời Cảnh báo sự cố (Alert)", fill=BORDER_COLOR, font=font_bold)

draw_rounded_rect(draw, [500, 100, 660, 140], 5, BOX_BG, BORDER_COLOR)
draw.text((552, 113), "ACTIVE", fill=TEXT_COLOR, font=font_bold)

draw_rounded_rect(draw, [720, 100, 900, 140], 5, BOX_BG, BORDER_COLOR)
draw.text((742, 113), "ACKNOWLEDGED", fill=TEXT_COLOR, font=font_bold)

draw_rounded_rect(draw, [610, 220, 770, 260], 5, BOX_BG, BORDER_COLOR)
draw.text((652, 233), "RESOLVED", fill=TEXT_COLOR, font=font_bold)

draw_arrow(draw, (660, 120), (720, 120), "Xác nhận")
draw_arrow(draw, (770, 140), (710, 220), "OK trở lại")
draw_arrow(draw, (610, 240), (560, 140), "Reset")

img.save(os.path.join(output_dir, "state_diagram.png"))

# ==========================================
# 6. Database ERD Diagram
# ==========================================
img = Image.new('RGB', (1000, 620), BG_COLOR)
draw = ImageDraw.Draw(img)
draw.text((20, 20), "SƠ ĐỒ MỐI QUAN HỆ CƠ SỞ DỮ LIỆU THỰC TẾ (DATABASE ERD SCHEMA)", fill=BORDER_COLOR, font=font_title)

# Stations
draw_class_box(draw, 40, 70, "Stations (Trạm giám sát)", [
    "* Id: uuid (PK)",
    "- Code: varchar(50) (UQ)",
    "- Name: varchar(200)",
    "- Location: text",
    "- Status: varchar(20)"
], width=250, height=170)

# Devices
draw_class_box(draw, 330, 70, "Devices (Thiết bị kết nối)", [
    "* Id: uuid (PK)",
    "- StationId: uuid (FK)",
    "- Name: varchar(150)",
    "- Type: varchar(50)",
    "- Protocol: varchar(50)",
    "- Config: text",
    "- IsOnline: boolean"
], width=290, height=200)

# SensorReadings
draw_class_box(draw, 660, 70, "SensorReadings (Số đo)", [
    "* Id: serial (PK)",
    "- Time: timestamp",
    "- StationId: uuid (FK)",
    "- DeviceId: uuid (FK)",
    "- PointId: varchar(100)",
    "- Value: double",
    "- Quality: integer"
], width=290, height=200)

# Rules
draw_class_box(draw, 40, 290, "Rules (Quy tắc)", [
    "* Id: uuid (PK)",
    "- StationId: uuid (FK)",
    "- Name: varchar(200)",
    "- Condition: text",
    "- Actions: text",
    "- Enabled: boolean"
], width=250, height=170)

# Alerts
draw_class_box(draw, 330, 290, "Alerts (Cảnh báo)", [
    "* Id: uuid (PK)",
    "- StationId: uuid (FK)",
    "- PointId: varchar(100)",
    "- Message: varchar(500)",
    "- Severity: varchar(20)",
    "- ValueTrigger: double",
    "- Timestamp: timestamp",
    "- Acknowledged: boolean"
], width=290, height=220)

draw.line([290, 140, 330, 140], fill=BORDER_COLOR, width=2)
draw.line([620, 160, 660, 160], fill=BORDER_COLOR, width=2)
draw.line([150, 240, 150, 290], fill=BORDER_COLOR, width=2)
draw.line([475, 270, 475, 290], fill=BORDER_COLOR, width=2)

img.save(os.path.join(output_dir, "erd_diagram.png"))

print("All 6 diagrams regenerated successfully with perfectly centered title headers and widened boxes.")
