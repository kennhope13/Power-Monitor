// src/hooks/usePdRegion.ts
import { useState, useCallback, useEffect } from 'react';
import { stationApi, Boundary } from '@/services/StationApiService';
import { authService } from '@/services/AuthService';
import { AI_ENGINE_URL, API_BASE_URL } from '@/utils/env';
import { confirmDialog } from '@/utils/confirm';

/**
 * Hook managing PD regions for a selected camera.
 * It loads regions from backend, handles drawing state, and provides CRUD helpers.
 */
export const usePdRegion = (cameraId: string | null) => {
  const [regions, setRegions] = useState<any[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [draftVertices, setDraftVertices] = useState<{ x: number; y: number }[]>([]);
  const [editingRegion, setEditingRegion] = useState<any | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftWarn, setDraftWarn] = useState('20');
  const [draftAlarm, setDraftAlarm] = useState('45');

  // AI Stats state
  const [aiStats, setAiStats] = useState<{ 
    db?: number | null, 
    hz?: number | null, 
    detection?: { x: number; y: number } | null,
    active_boundary?: string | null,
    discharge_counts?: Record<string, number> | null
  }>({});

  /** Thông báo AI Engine reload vùng PD — fire-and-forget */
  const notifyAiEngine = useCallback(async () => {
    if (!cameraId) return;
    try {
      await fetch(`${AI_ENGINE_URL}/config/pd-regions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: cameraId, stream_id: cameraId }),
      });
    } catch { /* AI Engine chưa chạy → bỏ qua */ }
  }, [cameraId]);

  /** Tải lại danh sách vùng PD từ backend theo cameraId hiện tại. */
  const load = useCallback(async () => {
    if (!cameraId) {
      setRegions([]);
      return;
    }
    try {
      const data = await stationApi.getBoundaries(cameraId, 'pd');
      // Chuyển [[x,y],...] (0-1) → [{x,y},...] (0-100)
      const mapped = data.map((b: Boundary) => {
        let vertices = [];
        try {
          const arr = JSON.parse(b.polygon);
          vertices = arr.map(([x, y]: [number, number]) => ({ x: x * 100, y: y * 100 }));
        } catch { /* empty */ }

        let warn = 20, alarm = 45;
        try {
          const t = JSON.parse(b.thresholds || '{}');
          warn = t.warn ?? t.warning ?? 20;
          alarm = t.alarm ?? 45;
        } catch { /* empty */ }

        return { ...b, vertices, warningThreshold: warn, alarmThreshold: alarm };
      });
      setRegions(mapped);
    } catch (e) {
      console.error('Failed to load PD regions', e);
      setRegions([]);
    }
  }, [cameraId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll Realtime Stats
  useEffect(() => {
    if (!cameraId) return;
    let timer: any;
    const fetchStats = async () => {
      try {
        const token = authService.getToken() || '';
        const backend = API_BASE_URL.replace('/api/v1', '');
        const res = await fetch(`${AI_ENGINE_URL}/pd-monitor/${cameraId}/state?token=${token}&backend=${backend}`);
        if (res.ok) {
          const data = await res.json();
          setAiStats({ 
            db: data.db, 
            hz: data.hz, 
            detection: data.detection, 
            active_boundary: data.active_boundary,
            discharge_counts: data.discharge_counts
          });
        }
      } catch { /* ignore */ }
      timer = setTimeout(fetchStats, 500);
    };
    fetchStats();
    return () => clearTimeout(timer);
  }, [cameraId]);

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  /** Bắt đầu kéo vẽ hình chữ nhật trên overlay khi ở chế độ vẽ. */
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isDrawing) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setDragStart({ x, y });
    setIsDragging(true);
    setDraftVertices([{ x, y }]);
  };

  /** Cập nhật đỉnh thứ tư của hình chữ nhật draft khi đang kéo. */
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing || !isDragging || !dragStart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    
    // Create rectangle vertices
    setDraftVertices([
        dragStart,
        { x: x, y: dragStart.y },
        { x: x, y: y },
        { x: dragStart.x, y: y }
    ]);
  };

  /** Kết thúc thao tác kéo và tự động hoàn thành vùng nếu đủ 3 đỉnh. */
  const handleMouseUp = () => {
    if (!isDrawing || !isDragging) return;
    setIsDragging(false);
    setDragStart(null);
    if (draftVertices.length >= 3) {
        finishDrawing();
    }
  };

  // ---- Drawing helpers ----
  /** Kích hoạt chế độ vẽ và reset trạng thái draft. */
  const startDrawing = () => {
    setIsDrawing(true);
    setDraftVertices([]);
    setEditingRegion(null);
    setDraftName('');
    setDraftWarn('20');
    setDraftAlarm('45');
  };

  /** Thêm một đỉnh vào polygon draft (bỏ qua khi đang kéo hình chữ nhật). */
  const addVertex = (pt: { x: number; y: number }) => {
    if (!isDrawing || isDragging) return; // Don't add vertex if dragging
    setDraftVertices(v => [...v, pt]);
  };

  /** Hoàn thành vẽ — xác nhận danh sách đỉnh (tối thiểu 3) và thoát chế độ vẽ. */
  const finishDrawing = (providedVertices?: { x: number; y: number }[]) => {
    const verts = providedVertices ?? draftVertices;
    if (verts.length < 3) {
      alert('Vui lòng vẽ ít nhất 3 điểm');
      return;
    }
    if (providedVertices) setDraftVertices(providedVertices);
    setIsDrawing(false);
  };

  // ---- CRUD ----
  /** Lưu vùng PD (tạo mới hoặc cập nhật) rồi thông báo AI Engine reload. */
  const save = async () => {
    if (!cameraId) return;
    if (!draftName.trim()) {
      alert('Tên vùng không được để trống');
      return;
    }

    // Chuyển [{x,y},...] 0-100 → [[x,y],...] 0-1 JSON string
    const targetVertices = editingRegion ? editingRegion.vertices : draftVertices;
    const polygon = JSON.stringify(targetVertices.map((v: any) => [v.x / 100, v.y / 100]));
    const thresholds = JSON.stringify({ warn: parseFloat(draftWarn) || 20, alarm: parseFloat(draftAlarm) || 45 });

    const payload: Partial<Boundary> = {
      name: draftName.trim(),
      type: 'pd',
      polygon,
      thresholds,
      severityLevel: 'warning',
      enabled: true
    };

    try {
      if (editingRegion) {
        await stationApi.updateBoundary(editingRegion.id, payload);
      } else {
        await stationApi.createBoundary(cameraId, payload);
      }
      await load();
      await notifyAiEngine();
      // reset draft state
      setEditingRegion(null);
      setDraftVertices([]);
      setIsDrawing(false);
      setDraftName('');
    } catch (e) {
      console.error('Failed to save PD region', e);
      alert('Lưu vùng thất bại');
    }
  };

  /** Xóa vùng PD theo id sau khi xác nhận từ người dùng. */
  const remove = async (id: string) => {
    if (!cameraId) return;
    if (!await confirmDialog({ title: 'Xóa vùng PD', message: 'Bạn có chắc chắn muốn xóa vùng này?', confirmText: 'Xóa', danger: true })) return;
    try {
      await stationApi.deleteBoundary(id);
      await load();
      await notifyAiEngine();
    } catch (e) {
      console.error('Delete failed', e);
      alert('Xóa thất bại');
    }
  };

  /** Nạp dữ liệu vùng đã có vào form để chỉnh sửa. */
  const edit = (region: any) => {
    setEditingRegion(region);
    setDraftName(region.name);
    setDraftWarn(String(region.warningThreshold ?? 20));
    setDraftAlarm(String(region.alarmThreshold ?? 45));
    setDraftVertices(region.vertices);
    setIsDrawing(false);
  };

  /** Đặt lại toàn bộ trạng thái draft về giá trị mặc định. */
  const resetDraft = () => {
    setDraftName('');
    setDraftWarn('20');
    setDraftAlarm('45');
    setDraftVertices([]);
    setEditingRegion(null);
    setIsDrawing(false);
  };

  return {
    regions,
    isDrawing,
    draftVertices,
    draftName,
    draftWarn,
    draftAlarm,
    editingRegion,
    load,
    startDrawing,
    addVertex,
    finishDrawing,
    save,
    remove,
    edit,
    setDraftName,
    setDraftWarn,
    setDraftAlarm,
    setDraftVertices,
    setEditingRegion,
    resetDraft,
    aiStats,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    isDragging,
  };

};
