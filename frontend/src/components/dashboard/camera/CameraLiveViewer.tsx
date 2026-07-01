import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { GO2RTC_URL } from '@/utils/env';

interface CameraLiveViewerProps {
  cameraSrc?: string;
  headerAddon?: React.ReactNode;
  hasAlert?: boolean;
}

export default function CameraLiveViewer({ cameraSrc = '', headerAddon, hasAlert = false }: CameraLiveViewerProps) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [isHovered, setIsHovered] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const navigate = useNavigate();

  return (
    <>
      {hasAlert && (
        <style>{`
          @keyframes border-pulse {
            0% { border-color: rgba(239, 68, 68, 0.5); box-shadow: 0 0 8px rgba(239, 68, 68, 0.4); }
            50% { border-color: rgba(239, 68, 68, 1); box-shadow: 0 0 16px rgba(239, 68, 68, 0.8), inset 0 0 8px rgba(239, 68, 68, 0.4); }
            100% { border-color: rgba(239, 68, 68, 0.5); box-shadow: 0 0 8px rgba(239, 68, 68, 0.4); }
          }
        `}</style>
      )}
      <div
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          background: '#000',
          borderRadius: 0,
          overflow: 'hidden',
          minHeight: isCollapsed ? 26 : 0,
          border: hasAlert ? '2px solid rgba(239, 68, 68, 0.8)' : '1px solid rgba(255,255,255,0.08)',
          animation: hasAlert ? 'border-pulse 1.5s infinite ease-in-out' : 'none',
          boxShadow: hasAlert ? '0 0 12px rgba(239, 68, 68, 0.6)' : 'var(--admin-shadow)',
        }}
      >
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px',
        background: 'rgba(15, 23, 42, 0.75)', backdropFilter: 'blur(4px)', borderBottom: '1px solid rgba(255,255,255,0.1)',
        opacity: isHovered || isCollapsed ? 1 : 0, transition: 'opacity 0.2s ease-in-out',
        pointerEvents: isHovered || isCollapsed ? 'auto' : 'none',
      }}>
        {/* Trái: CAMERA label + select chọn camera */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: '0.55rem', fontWeight: 800, color: '#fff', flexShrink: 0 }}>CAMERA</span>
          {headerAddon}
        </div>
        {/* Phải: nút collapse */}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '0.7rem', lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
        >
          {isCollapsed ? '▼' : '▲'}
        </button>
      </div>

      {!isCollapsed && (
        <div
          onDoubleClick={() => navigate('/realtime')}
          style={{ position: 'relative', width: '100%', aspectRatio: '4/3', background: '#000', overflow: 'hidden', cursor: 'pointer' }}
        >
          {cameraSrc ? (
            <iframe
              ref={iframeRef}
              src={`/camera-stream.html?src=${cameraSrc}&mode=webrtc,mse&go2rtc=${GO2RTC_URL}`}
              style={{ width: '100%', height: '100%', border: 'none', pointerEvents: 'none', display: 'block' }}
              allow="autoplay"
              title="Camera Live Stream"
            />
          ) : (
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem', fontWeight: 600 }}>
              Chưa có Camera
            </div>
          )}
        </div>
      )}
    </div>
    </>
  );
}
