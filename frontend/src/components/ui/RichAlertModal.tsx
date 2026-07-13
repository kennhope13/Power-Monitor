import { useNavigate } from 'react-router-dom';
import { AlertTriangle, X, Image as ImageIcon } from 'lucide-react';
import type { AlertItem } from '@/types/api.types';
import { API_BASE_URL } from '@/utils/env';

interface RichAlertModalProps {
  alert: AlertItem;
  onClose: () => void;
  queueCount?: number;
}

export default function RichAlertModal({ alert, onClose, queueCount = 0 }: RichAlertModalProps) {
  const navigate = useNavigate();
  
  const isFire = alert.message?.toLowerCase().includes('cháy') || alert.message?.toLowerCase().includes('fire') || alert.message?.toLowerCase().includes('lửa');
  const isAlarm = alert.level === 'alarm' || isFire;
  const color = isFire ? '#ff3300' : (isAlarm ? 'var(--admin-danger)' : 'var(--admin-warning)');
  const shadowColor = isFire ? 'rgba(255, 51, 0, 0.6)' : (isAlarm ? 'rgba(239, 68, 68, 0.3)' : 'rgba(245, 158, 11, 0.3)');
  const headerText = isFire ? '🔥 CẢNH BÁO CHÁY KHẨN CẤP' : (isAlarm ? 'BÁO ĐỘNG MỚI' : 'CẢNH BÁO MỚI');

  // Parse metadata
  let meta: any = {};
  if (typeof alert.metadata === 'string') {
    try { meta = JSON.parse(alert.metadata); } catch {}
  } else if (alert.metadata) {
    meta = alert.metadata;
  }

  // Xử lý URL ảnh/video
  let rawUrl = alert.thumbnailUrl || alert.imageUrl || meta.snapshotUrl || meta.thumbnailUrl;
  const imageUrl = rawUrl
    ? (rawUrl.startsWith('http') || rawUrl.startsWith('blob:') || rawUrl.startsWith('data:') ? rawUrl : `${API_BASE_URL}${rawUrl}`)
    : null;
    
  const videoUrl = alert.videoUrl 
    ? (alert.videoUrl.startsWith('http') || alert.videoUrl.startsWith('blob:') || alert.videoUrl.startsWith('data:') ? alert.videoUrl : `${API_BASE_URL}${alert.videoUrl}`)
    : null;

  const handleContainerClick = () => {
    navigate(`/alerts-history?alertId=${alert.id}`);
    onClose();
  };

  return (
    <>
      <style>{`
        @keyframes fire-glow {
          0% { box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8), 0 0 20px rgba(255, 51, 0, 0.4); border-color: #ff3300; }
          50% { box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8), 0 0 50px rgba(255, 51, 0, 0.8); border-color: #ffcc00; }
          100% { box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8), 0 0 20px rgba(255, 51, 0, 0.4); border-color: #ff3300; }
        }
        @keyframes sideAlertIn {
          from { opacity: 0; transform: translateX(100%) scale(0.9); }
          to { opacity: 1; transform: translateX(0) scale(1); }
        }
      `}</style>
      <div 
        style={{ 
          position: 'fixed', top: 100, right: 24, zIndex: 100005,
          width: 420, background: 'var(--admin-bg)',
          border: `1px solid ${color}`, 
          borderLeft: `6px solid ${color}`,
          boxShadow: `0 20px 60px rgba(0, 0, 0, 0.8), 0 0 30px ${shadowColor}`,
          borderRadius: 0, overflow: 'hidden',
          cursor: 'pointer',
          animation: isFire ? 'fire-glow 1s infinite ease-in-out' : 'sideAlertIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
          fontFamily: 'var(--admin-font), sans-serif'
        }}
        onClick={handleContainerClick}
      >
        {/* Header báo động */}
        <div style={{ 
          background: isFire ? 'linear-gradient(90deg, #ff3300, #ff9900)' : 'rgba(0,0,0,0.2)', 
          color: '#fff', padding: '12px 18px', 
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          borderBottom: '1px solid var(--admin-border-light)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <AlertTriangle size={18} fill={isFire ? '#fff' : color} color={isFire ? '#ff3300' : "#fff"} />
            <span style={{ fontWeight: 900, fontSize: '0.9rem', letterSpacing: 1.5, color: isFire ? '#fff' : color }}>{headerText}</span>
            {queueCount > 1 && (
              <span style={{
                background: isFire ? '#fff' : color, color: '#000', fontSize: '0.65rem', fontWeight: 800,
                padding: '1px 6px', borderRadius: 10, letterSpacing: 0
              }}>
                +{queueCount - 1} cảnh báo nữa
              </span>
            )}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', opacity: 0.4 }}
          >
            <X size={20} />
          </button>
        </div>
      
        <div style={{ padding: 20, display: 'flex', gap: 20 }}>
          {/* Vùng hiển thị Media (Ưu tiên Video) */}
          <div style={{ 
            width: 160, height: 110, borderRadius: 0, overflow: 'hidden', 
            border: '1px solid var(--admin-border)', background: '#000', 
            flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            position: 'relative'
          }}>
            {videoUrl ? (
              <video key={videoUrl} autoPlay loop muted style={{ width: '100%', height: '100%', objectFit: 'cover' }}>
                <source src={videoUrl} type="video/mp4" />
              </video>
            ) : imageUrl ? (
              <img src={imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <div style={{ opacity: 0.1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <ImageIcon size={32} />
                <span style={{ fontSize: '0.5rem', fontWeight: 900 }}>NO MEDIA</span>
              </div>
            )}
            
            {videoUrl && (
              <div style={{ 
                position: 'absolute', bottom: 4, right: 4, 
                background: color, color: '#fff', 
                fontSize: '0.45rem', fontWeight: 900, padding: '1px 4px'
              }}>VIDEO</div>
            )}
          </div>

          {/* Chi tiết cảnh báo */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ 
              fontSize: '0.65rem', color: 'var(--admin-text-muted)', 
              fontWeight: 800, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 
            }}>
              <span style={{ padding: '1px 6px', background: 'var(--admin-layer-2)', color: 'var(--admin-text)' }}>
                {new Date(alert.triggeredAt).toLocaleTimeString('vi-VN')}
              </span>
              <span style={{ opacity: 0.5 }}>{(alert.source ?? '').toUpperCase()}</span>
            </div>
            <div style={{ 
              fontSize: '0.95rem', fontWeight: 900, color: 'var(--admin-text)', 
              lineHeight: 1.4, marginBottom: 12,
              display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              textTransform: 'uppercase'
            }}>
              {alert.message}
            </div>
            <div style={{ 
              fontSize: '0.75rem', color: 'var(--admin-accent)', 
              fontWeight: 900, letterSpacing: 0.5,
              display: 'flex', alignItems: 'center', gap: 6
            }}>
              XEM CHI TIẾT SỰ KIỆN <span style={{ fontSize: '1rem' }}>→</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
