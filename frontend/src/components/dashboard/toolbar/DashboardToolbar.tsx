

import { Settings } from 'lucide-react';
import { useState } from 'react';

interface DashboardToolbarProps {
  stationName: string;
  showStationName?: boolean;
  isEditMode: boolean;
  onToggleEditMode: () => void;
  showLabels: boolean;
  onToggleLabels: () => void;
  onFit: () => void;
  onRotate: () => void;
  onColorChange: (hex: string) => void;
  filters: { thermal: boolean; pd: boolean; camera: boolean };
  onFilterChange: (filters: { thermal: boolean; pd: boolean; camera: boolean }) => void;
  unpinnedCount?: number;
}

export default function DashboardToolbar(props: DashboardToolbarProps) {
  const {
    stationName,
    showStationName = true,
    isEditMode,
    onToggleEditMode,
    onFit,
    onRotate,
    showLabels,
    onToggleLabels,
    onColorChange,
    filters,
    onFilterChange,
    unpinnedCount = 0
  } = props;
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div
      id="sldToolbar"
      className={isEditMode ? 'edit-mode-active' : ''}
      style={{
        position: 'absolute', top: 10, left: 10, zIndex: 30,
        display: 'flex', flexDirection: 'column', gap: 6,
        background: 'var(--admin-overlay)', backdropFilter: 'blur(12px)',
        border: '1px solid var(--admin-border)', borderRadius: 0, padding: '6px 14px',
        transition: 'all 0.25s ease',
        boxShadow: 'var(--admin-shadow)',
        alignItems: 'center'
      }}
    >
      {/* Title & Toggle Row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {showStationName && (
          <span style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--admin-text)', whiteSpace: 'nowrap' }}>
            {stationName.toUpperCase() || 'SƠ ĐỒ TRẠM'}
          </span>
        )}

        <div style={{ display: 'flex', gap: 6 }}>
          {!isEditMode && (
            <button
              onClick={onToggleEditMode}
              className="btn-industrial btn-sm"
              style={{ fontSize: '0.65rem', padding: '2px 8px', height: 24, position: 'relative' }}
            >
              CHỈNH SƠ ĐỒ
              {unpinnedCount > 0 && (
                <span style={{
                  position: 'absolute', top: -5, right: -5,
                  background: 'var(--admin-danger)', color: '#fff',
                  fontSize: 9, fontWeight: 900,
                  width: 14, height: 14, borderRadius: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '0 0 5px var(--admin-danger)',
                  animation: 'pulse 1.5s infinite'
                }}>
                  {unpinnedCount}
                </span>
              )}
            </button>
          )}

          <button
            onClick={() => setIsOpen(!isOpen)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--admin-text-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 4,
              borderRadius: 0,
              transition: 'background 0.2s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--admin-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            title="Điều khiển sơ đồ"
          >
            <Settings size={14} style={{ transform: isOpen ? 'rotate(45deg)' : 'none', transition: 'transform 0.3s' }} />
          </button>
        </div>
      </div>
      
      {/* Toggled Control Row */}
      {isOpen && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          paddingTop: 4, borderTop: '1px solid var(--admin-border-light)',
          animation: 'toolbarSlideDown 0.2s ease-out'
        }}>
          {/* Filters */}
          <label style={{ fontSize: 10, color: 'var(--admin-text-muted)', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={filters.thermal} onChange={e => onFilterChange({ ...filters, thermal: e.target.checked })} /> Nhiệt
          </label>
          <label style={{ fontSize: 10, color: 'var(--admin-text-muted)', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={filters.pd} onChange={e => onFilterChange({ ...filters, pd: e.target.checked })} /> PD
          </label>
          <label style={{ fontSize: 10, color: 'var(--admin-text-muted)', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={filters.camera} onChange={e => onFilterChange({ ...filters, camera: e.target.checked })} /> Camera
          </label>
          
          <div style={{ width: 1, height: 18, background: 'var(--admin-border-light)' }}></div>
          
          {/* Actions */}
          <button onClick={onFit} className="btn-industrial btn-sm">FIT</button>
          <button onClick={onRotate} className="btn-industrial btn-sm">XOAY</button>
          
          <button 
            onClick={onToggleLabels} 
            className={`btn-industrial btn-sm ${showLabels ? 'btn-primary' : ''}`}
          >
            {showLabels ? 'ẨN TÊN' : 'HIỆN TÊN'}
          </button>

          <label title="Màu đường nét" style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', color: 'var(--admin-text-muted)', fontSize: 10 }}>
            <input 
              type="color" 
              defaultValue="#f59e0b"
              onChange={e => onColorChange(e.target.value)}
              style={{ width: 18, height: 14, border: 'none', padding: 0, background: 'none', cursor: 'pointer', borderRadius: 0 }} 
            />
          </label>
        </div>
      )}

      <style>{`
        @keyframes toolbarSlideDown {
          from { opacity: 0; transform: translateY(-5px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse {
          0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
          70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
          100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
        }
      `}</style>
    </div>
  );
}
