import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { stationApi } from '@/services/StationApiService';
import type { SldUnpinnedDevice, SldPoint } from '@/types/api.types';
import type { SldCanvasRef, BadgeConfig } from './SldCanvas';
import { DEFAULT_BADGE, BADGE_COLORS } from './SldCanvas';

interface Props {
  stationId: string;
  sldRef: React.RefObject<SldCanvasRef | null>;
  refreshTick?: number;
  selectedNode: SldPoint | null;
  onClearSelection: () => void;
  onDone?: () => void;
}

const labelStyle: React.CSSProperties = {
  fontSize: '.58rem', fontWeight: 800, color: 'var(--admin-text-muted)',
  textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6,
  fontFamily: 'Consolas,monospace',
};

/**
 * Điều khiển tăng/giảm số nguyên bằng nút +/–.
 * Dùng cho cài đặt kích thước node và cỡ chữ trong SldEditPanel.
 */
const Stepper = ({ value, onChange, min = 1, max = 60, unit = 'px' }: any) => (
  <div style={{ display: 'flex', alignItems: 'center', background: 'var(--admin-layer-2)', border: '1px solid var(--admin-border)', borderRadius: 4, height: 26, overflow: 'hidden' }}>
    <button onClick={() => onChange(Math.max(min, Number(value) - 1))} 
      style={{ width: 24, height: '100%', border: 'none', background: 'rgba(255,255,255,0.05)', color: 'var(--admin-text)', cursor: 'pointer', fontSize: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>-</button>
    <div style={{ flex: 1, minWidth: 40, textAlign: 'center', fontSize: '.75rem', fontWeight: 700, color: 'var(--admin-accent)' }}>
      {value}<span style={{ fontSize: '.55rem', fontWeight: 400, opacity: 0.5, marginLeft: 2 }}>{unit}</span>
    </div>
    <button onClick={() => onChange(Math.min(max, Number(value) + 1))}
      style={{ width: 24, height: '100%', border: 'none', background: 'rgba(255,255,255,0.05)', color: 'var(--admin-text)', cursor: 'pointer', fontSize: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
  </div>
);

/**
 * Nút chọn vị trí badge (trên/dưới/trái/phải) cho node trên sơ đồ SLD.
 * Hiển thị mũi tên tương ứng và nổi bật khi đang được chọn.
 */
const PosBtn = ({ pos, active, onClick }: { pos: 'top'|'bottom'|'left'|'right'; active: boolean; onClick: () => void }) => (
  <button onClick={onClick}
    title={pos === 'top' ? 'Trên' : pos === 'bottom' ? 'Dưới' : pos === 'left' ? 'Trái' : 'Phải'}
    className={`btn-industrial btn-sm ${active ? 'btn-primary' : ''}`}
    style={{ width: 26, padding: 0 }}>
    {pos === 'top' ? '↑' : pos === 'bottom' ? '↓' : pos === 'left' ? '←' : '→'}
  </button>
);

/**
 * Panel chỉnh sửa sơ đồ nhất tuyến (SLD): cho phép upload SVG nền,
 * cấu hình badge tất cả node cùng lúc, kéo thả thiết bị chưa gắn,
 * và chỉnh chi tiết node đang chọn (tên, kích thước, màu, vị trí badge).
 */
export default function SldEditPanel({ stationId, sldRef, refreshTick, selectedNode, onClearSelection, onDone }: Props) {
  const [unpinned, setUnpinned] = useState<SldUnpinnedDevice[]>([]);

  const unpinnedGroups = useMemo(() => {
    const groups: Record<string, { id: string; name: string; type: string; tags: string[] }> = {};
    unpinned.forEach(d => {
      if (!groups[d.id]) groups[d.id] = { id: d.id, name: d.name, type: d.type, tags: [] };
      const group = groups[d.id];
      if (group) {
        if (d.sensorTag) group.tags.push(d.sensorTag);
        if (!d.sensorTag) group.name = d.name;
      }
    });
    return Object.values(groups);
  }, [unpinned]);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [svgStatus, setSvgStatus] = useState('');
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const confirmResolve = useRef<((v: boolean) => void) | null>(null);

  const showConfirm = (msg: string): Promise<boolean> =>
    new Promise(resolve => { setConfirmMsg(msg); confirmResolve.current = resolve; });

  const handleConfirmOk = () => { setConfirmMsg(null); confirmResolve.current?.(true); };
  const handleConfirmCancel = () => { setConfirmMsg(null); confirmResolve.current?.(false); };

  // Global badge config
  const [gPos, setGPos] = useState<BadgeConfig['pos']>('top');
  const [gSize, setGSize] = useState(9);
  const [gColor, setGColor] = useState(DEFAULT_BADGE.color);
  const [gRadius, setGRadius] = useState(8);

  // Per-node config (khi có selectedNode)
  const [nRadius, setNRadius] = useState(8);
  const [nLabel, setNLabel] = useState('');
  const [nPos, setNPos] = useState<BadgeConfig['pos']>('top');
  const [nSize, setNSize] = useState(9);
  const [nColor, setNColor] = useState(DEFAULT_BADGE.color);

  // Load node config khi chọn node
  useEffect(() => {
    if (!selectedNode) return;
    setNRadius(selectedNode.r);
    setNLabel(selectedNode.label || selectedNode.deviceName || '');
    const cfg = sldRef.current?.getNodeBadgeConfig(selectedNode.id) ?? DEFAULT_BADGE;
    setNPos(cfg.pos);
    setNSize(cfg.size);
    setNColor(cfg.color);
  }, [selectedNode?.id]);

  /**
   * Lưu thay đổi cấu hình (bán kính, nhãn, badge) của node đang được chọn
   * vào canvas ngay lập tức qua imperative ref.
   */
  const updateSelectedNode = async (radius: number, label: string, pos: BadgeConfig['pos'], size: number, color: string) => {
    if (!selectedNode) return;
    try {
      await sldRef.current?.saveNodeConfig(selectedNode.id, radius, { pos, size, color }, label);
    } catch (e) { console.error('Update failed', e); }
  };

  /** Tải lại danh sách thiết bị chưa gắn và trạng thái SVG từ API. */
  const loadSldData = async () => {
    try {
      const data = await stationApi.getSld(stationId);
      setUnpinned(data.unpinned || []);
      if (data.svgUrl) setSvgStatus('Đã có sơ đồ ✓');
    } catch {}
  };

  useEffect(() => { if (stationId) loadSldData(); }, [stationId, refreshTick]);

  /** Upload file SVG lên server rồi yêu cầu canvas tải lại dữ liệu SLD. */
  const handleUpload = async () => {
    if (!uploadFile) return;
    setUploading(true);
    try {
      await stationApi.uploadSldSvg(stationId, uploadFile);
      sldRef.current?.reloadData();
      setSvgStatus(uploadFile.name + ' ✓');
      setUploadFile(null);
    } catch (err: any) { alert(`Upload thất bại: ${err.message || err}`); }
    finally { setUploading(false); }
  };

  /** Nhãn xóa theo loại thiết bị */
  const deleteLabel = (node: SldPoint) => {
    const t = node.deviceType || '';
    if (t.startsWith('camera')) return 'Xóa camera';
    if (t === 'cabinet') return 'Xóa tủ điện';
    if (t === 'plc_s7') return 'Xóa PLC';
    if (t === 'sensor_temp') return 'Xóa cảm biến';
    return 'Xóa thiết bị';
  };

  /** Xóa node đang chọn khỏi sơ đồ sau khi người dùng xác nhận. */
  const handleDeleteNode = async () => {
    if (!selectedNode) return;
    const nodeName = selectedNode.label || selectedNode.deviceName || 'điểm đã chọn';
    if (!await showConfirm(`${deleteLabel(selectedNode)} "${nodeName}" khỏi sơ đồ?`)) return;
    try {
      await sldRef.current?.deleteNode(selectedNode.id);
      loadSldData();
      onClearSelection();
    } catch { alert('Xóa thất bại'); }
  };

  /** Áp dụng cấu hình badge (vị trí, cỡ chữ, màu) cho toàn bộ node trên sơ đồ. */
  const handleApplyAll = () => {
    sldRef.current?.applyGlobalBadge({ pos: gPos, size: gSize, color: gColor });
  };

  /** Cập nhật bán kính tất cả node đồng thời và ghi lên backend. */
  const handleApplyAllRadius = async (val: number) => {
    setGRadius(val);
    try {
      await sldRef.current?.applyGlobalRadius(val);
    } catch (e) {
      console.error('Global radius update failed', e);
    }
  };

  return (
    <div style={{
      position: 'absolute', top: 10, left: 10, zIndex: 40, width: 270,
      background: 'var(--admin-overlay)', backdropFilter: 'blur(12px)',
      border: '1px solid rgba(99,102,241,0.5)', borderRadius: 4,
      boxShadow: 'var(--admin-shadow)', maxHeight: 'calc(100% - 50px)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '7px 12px', borderBottom: '1px solid var(--admin-border-light)', background: 'var(--admin-hover)', flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '.7rem', fontWeight: 900, color: 'var(--admin-accent)', letterSpacing: '.5px' }}>
          {selectedNode ? `✏ ${selectedNode.label || selectedNode.deviceName || selectedNode.pointId || 'Node'}` : '✏ CHỈNH SƠ ĐỒ'}
        </span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {selectedNode && (
            <button onClick={onClearSelection}
              style={{ background: 'none', border: 'none', color: 'var(--admin-text-muted)', cursor: 'pointer', fontSize: '.8rem', lineHeight: 1 }}>
              <X size={14} />
            </button>
          )}
          {onDone && (
            <button onClick={onDone}
              className="btn-industrial btn-sm btn-primary"
              style={{ fontSize: '0.62rem', padding: '2px 8px', height: 22 }}>
              XONG
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>

        {selectedNode ? (
          /* ── Chế độ chỉnh node đang chọn ── */
          <>
            <div>
              <div style={labelStyle}>Tên hiển thị</div>
              <input type="text" value={nLabel}
                onChange={e => { setNLabel(e.target.value); updateSelectedNode(nRadius, e.target.value, nPos, nSize, nColor); }}
                placeholder="Nhập tên node..."
                style={{ width: '100%', fontSize: '.75rem', padding: '5px 8px', background: 'var(--admin-layer-2)', border: '1px solid var(--admin-accent)', borderRadius: 3, color: 'var(--admin-text)', outline: 'none' }}
              />
            </div>

            <div>
              <div style={labelStyle}>Kích thước node</div>
              <Stepper value={nRadius} onChange={(v: number) => { setNRadius(v); updateSelectedNode(v, nLabel, nPos, nSize, nColor); }} min={1} max={60} />
            </div>

            <div>
              <div style={labelStyle}>Vị trí thông số</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['top','bottom','left','right'] as const).map(p => (
                  <PosBtn key={p} pos={p} active={nPos === p} onClick={() => { setNPos(p); updateSelectedNode(nRadius, nLabel, p, nSize, nColor); }} />
                ))}
              </div>
            </div>

            <div>
              <div style={labelStyle}>Cỡ chữ</div>
              <Stepper value={nSize} onChange={(v: number) => { setNSize(v); updateSelectedNode(nRadius, nLabel, nPos, v, nColor); }} min={6} max={18} />
            </div>

            <div>
              <div style={labelStyle}>Màu chữ</div>
              <div style={{ display: 'flex', gap: 5 }}>
                {BADGE_COLORS.map(c => (
                  <div key={c} onClick={() => { setNColor(c); updateSelectedNode(nRadius, nLabel, nPos, nSize, c); }}
                    style={{ width: 20, height: 20, borderRadius: 3, background: c, cursor: 'pointer', border: `2px solid ${nColor === c ? 'var(--admin-text)' : 'transparent'}` }} />
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={handleDeleteNode}
                className="btn-industrial btn-sm btn-danger" style={{ flex: 1 }}>
                {selectedNode ? deleteLabel(selectedNode) : 'Xóa thiết bị'}
              </button>
            </div>
          </>
        ) : (
          /* ── Chế độ mặc định ── */
          <>
            {/* Upload SVG */}
            <div>
              <div style={labelStyle}>File SVG sơ đồ</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <label style={{ flex: 1, fontSize: '.68rem', padding: '5px 8px', border: '1px dashed var(--admin-border)', borderRadius: 3, cursor: 'pointer', color: uploadFile ? 'var(--admin-text)' : 'var(--admin-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {uploadFile ? uploadFile.name : (svgStatus || 'Chọn file .svg')}
                  <input type="file" accept=".svg" style={{ display: 'none' }} onChange={e => setUploadFile(e.target.files?.[0] ?? null)} />
                </label>
                <button onClick={handleUpload} disabled={!uploadFile || uploading}
                  className={`btn-industrial btn-sm ${uploadFile ? 'btn-primary' : ''}`}
                  style={{ flexShrink: 0 }}>
                  {uploading ? '...' : 'Upload'}
                </button>
              </div>
            </div>

            <div style={{ height: 1, background: 'var(--admin-border-light)' }} />

            {/* Unpinned */}
            {unpinnedGroups.length > 0 ? (
              <div>
                <div style={labelStyle}>Thiết bị chưa gắn (Kéo thả vào sơ đồ)</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {unpinnedGroups.map(g => (
                    <div key={g.id} draggable
                      onDragStart={e => {
                        e.dataTransfer.setData('device_id', g.id);
                        e.dataTransfer.setData('device_name', g.name);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      style={{ padding: '6px 8px', fontSize: '.68rem', backgroundColor: 'var(--admin-layer-1)', border: '1px dashed var(--admin-border)', borderRadius: 0, cursor: 'grab', color: 'var(--admin-text)' }}>
                      <div style={{ fontWeight: 700 }}>{g.name}</div>
                      <div style={{ color: 'var(--admin-text-muted)', fontSize: '.6rem', marginTop: 2 }}>
                        {g.tags.length > 0 ? `${g.tags.length} điểm đo · ` : ''}{g.type}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '.68rem', color: 'var(--admin-text-muted)', textAlign: 'center', padding: '8px 0' }}>
                Tất cả thiết bị đã được gắn lên sơ đồ
              </div>
            )}
          </>
        )}
      </div>

      {confirmMsg !== null && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)' }}
          onClick={handleConfirmCancel}>
          <div style={{ background: 'var(--admin-panel, #1e2126)', border: '1px solid var(--admin-border)', borderRadius: 0, padding: '24px 28px', minWidth: 300, maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}
            onClick={e => e.stopPropagation()}>
            <p style={{ margin: '0 0 20px', fontSize: '.85rem', color: 'var(--admin-text)', lineHeight: 1.5 }}>{confirmMsg}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={handleConfirmCancel}
                style={{ padding: '6px 16px', fontSize: '.78rem', background: 'rgba(255,255,255,0.08)', border: '1px solid var(--admin-border)', borderRadius: 0, color: 'var(--admin-text)', cursor: 'pointer' }}>
                Hủy
              </button>
              <button onClick={handleConfirmOk}
                style={{ padding: '6px 16px', fontSize: '.78rem', background: '#EF4444', border: 'none', borderRadius: 0, color: '#fff', cursor: 'pointer', fontWeight: 700 }}>
                Xóa
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
