import React, { useState, useRef, useEffect } from 'react';
import { Edit2 } from 'lucide-react';

interface ActionDropdownProps {
  children: React.ReactNode;
}

/**
 * Dropdown hành động: nhấn nút bút chì để mở menu nổi chứa các ActionDropdownItem.
 * Tự đóng khi click ra ngoài vùng menu nhờ event listener mousedown trên document.
 */
export default function ActionDropdown({ children }: ActionDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState({ top: 0, left: 0, openUp: false });

  const updatePosition = React.useCallback(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const dropdownHeight = 260; // Chiều cao ước tính của menu 7 items
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < dropdownHeight && rect.top > dropdownHeight;

    setCoords({
      top: openUp ? rect.top - 4 : rect.bottom + 4,
      left: rect.right - 140,
      openUp
    });
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      updatePosition();
      document.addEventListener('mousedown', handleClickOutside);
      // Lắng nghe sự kiện cuộn ở mọi phần tử cha (bao gồm cả bảng cuộn)
      window.addEventListener('scroll', updatePosition, { capture: true, passive: true });
      window.addEventListener('resize', updatePosition);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', updatePosition, { capture: true });
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen, updatePosition]);

  return (
    <div className="action-dropdown-wrap" style={{ position: 'relative', display: 'inline-block' }} ref={menuRef}>
      <button 
        className="btn-industrial btn-sm" 
        style={{ 
          width: 30, height: 24, padding: 0, 
          background: 'transparent', border: '1px solid var(--admin-border)',
          borderRadius: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--admin-text-muted)'
        }} 
        onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen); }}
        title="Thao tác"
      >
        <Edit2 size={16} />
      </button>

      {isOpen && (
        <div 
          className="action-dropdown-list" 
          style={{ 
            position: 'fixed', 
            top: coords.top,
            left: coords.left,
            transform: coords.openUp ? 'translateY(-100%)' : 'none',
            background: 'var(--admin-panel)',
            border: '1px solid var(--admin-border)',
            borderRadius: 0,
            boxShadow: '0 10px 25px rgba(0, 0, 0, 0.4)',
            zIndex: 9999,
            minWidth: 140,
            maxHeight: 240, // Giới hạn chiều cao để bật tính năng cuộn nếu quá dài
            overflowY: 'auto',
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            animation: coords.openUp ? 'dropdownFadeInUp 0.15s ease-out' : 'dropdownFadeIn 0.15s ease-out'
          }}
          onClick={(e) => {
            e.stopPropagation();
            setIsOpen(false); // Đóng menu sau khi chọn một chức năng
          }}
        >
          {children}
        </div>
      )}

      <style>{`
        @keyframes dropdownFadeIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes dropdownFadeInUp {
          from { opacity: 0; transform: translateY(calc(-100% + 10px)); }
          to { opacity: 1; transform: translateY(-100%); }
        }
        /* Custom scrollbar cho ActionDropdown */
        .action-dropdown-list::-webkit-scrollbar {
          width: 4px;
          height: 4px;
        }
        .action-dropdown-list::-webkit-scrollbar-thumb {
          background: var(--admin-scrollbar);
          border-radius: 2px;
        }
      `}</style>
    </div>
  );
}

interface ActionDropdownItemProps {
  icon?: React.ReactNode;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
}

/**
 * Một mục trong ActionDropdown: hiển thị icon (tuỳ chọn) và nhãn,
 * đổi màu đỏ khi là thao tác nguy hiểm (danger=true).
 */
export function ActionDropdownItem({ icon, label, onClick, danger }: ActionDropdownItemProps) {
  return (
    <button 
      className={`dropdown-item ${danger ? 'danger' : ''}`} 
      style={{ 
        display: 'flex', alignItems: 'center', gap: icon ? 10 : 0,
        padding: '8px 12px', border: 'none', background: 'transparent',
        width: '100%', textAlign: 'left', cursor: 'pointer',
        fontSize: '0.78rem', fontWeight: 600, borderRadius: 0,
        color: danger ? 'var(--admin-danger)' : 'var(--admin-text)',
        transition: 'background 0.15s'
      }} 
      onClick={(e) => { 
        console.log(`ActionDropdownItem clicked: ${label}`);
        onClick(e); 
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = danger ? 'rgba(239,68,68,0.1)' : 'var(--admin-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon && <span style={{ display: 'flex', opacity: 0.7 }}>{icon}</span>}
      <span>{label}</span>
    </button>
  );
}
