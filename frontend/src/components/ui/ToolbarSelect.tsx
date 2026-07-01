import { useState, useRef } from 'react';

interface Option {
  value: string;
  label: string;
}

interface ToolbarSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  width?: number;
  style?: React.CSSProperties;
}

export default function ToolbarSelect({ value, onChange, options, width = 160, style }: ToolbarSelectProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  const selected = options.find(o => o.value === value);

  const handleOpen = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom, left: r.left, width: r.width });
    setOpen(o => !o);
  };

  return (
    <div style={{ display: 'inline-block', ...style }}>
      {open && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setOpen(false)} />
      )}
      <button
        ref={btnRef}
        onClick={handleOpen}
        style={{
          width,
          background: 'var(--admin-bg, #1a1c1e)',
          border: '1px solid var(--admin-border)',
          color: 'var(--admin-text)',
          padding: '3px 8px',
          fontSize: '.72rem',
          fontWeight: 600,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          height: 24,
          textTransform: 'none',
          letterSpacing: 'normal',
          borderRadius: 0,
          boxSizing: 'border-box',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.label ?? '—'}
        </span>
        <span style={{ flexShrink: 0, opacity: 0.45, fontSize: '.6rem' }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: 'fixed',
          top: pos.top,
          left: pos.left,
          width: pos.width,
          zIndex: 9999,
          background: 'var(--admin-panel, #24272a)',
          border: '1px solid var(--admin-border)',
          maxHeight: 240,
          overflowY: 'auto',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}>
          {options.map(o => {
            const active = o.value === value;
            return (
              <div
                key={o.value}
                onClick={() => { onChange(o.value); setOpen(false); }}
                style={{
                  padding: '6px 10px',
                  fontSize: '.72rem',
                  cursor: 'pointer',
                  fontWeight: active ? 800 : 500,
                  color: active ? 'var(--admin-accent)' : 'var(--admin-text)',
                  background: active ? 'rgba(14,165,233,0.12)' : 'transparent',
                  borderLeft: `2px solid ${active ? 'var(--admin-accent)' : 'transparent'}`,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.05)'; }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
              >
                {o.label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
