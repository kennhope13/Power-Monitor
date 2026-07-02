import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';

interface Props {
  startDate: string;
  endDate: string;
  onChange: (start: string, end: string) => void;
}

const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const MONTHS = ['Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
  'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];

function toDateStr(d: Date) {
  return d.toISOString().split('T')[0]!;
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

function buildCalendar(year: number, month: number) {
  const firstDay = new Date(year, month, 1).getDay();
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const cells: { date: Date; otherMonth: boolean }[] = [];
  for (let i = startOffset - 1; i >= 0; i--)
    cells.push({ date: new Date(year, month - 1, daysInPrevMonth - i), otherMonth: true });
  for (let d = 1; d <= daysInMonth; d++)
    cells.push({ date: new Date(year, month, d), otherMonth: false });
  const remaining = 42 - cells.length;
  for (let d = 1; d <= remaining; d++)
    cells.push({ date: new Date(year, month + 1, d), otherMonth: true });
  return cells;
}

export default function DateRangePicker({ startDate, endDate, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [hoverDate, setHoverDate] = useState('');
  const [selecting, setSelecting] = useState('');
  const [popupPos, setPopupPos] = useState({ top: 0, left: 0 });
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const today = toDateStr(new Date());
  const initMonth = () => {
    const d = parseDate(startDate) ?? new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  };
  const [view, setView] = useState(initMonth);

  useEffect(() => {
    if (open) setView(initMonth());
  }, [open]);

  // Position popup below button using fixed coords to escape overflow:hidden
  const openPopup = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setPopupPos({ top: rect.bottom + 6, left: rect.left });
    }
    setOpen(o => !o);
    setSelecting('');
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popupRef.current && !popupRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setSelecting('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const prevMonth = () => setView(v =>
    v.month === 0 ? { year: v.year - 1, month: 11 } : { ...v, month: v.month - 1 }
  );
  const nextMonth = () => setView(v =>
    v.month === 11 ? { year: v.year + 1, month: 0 } : { ...v, month: v.month + 1 }
  );

  const handleDayClick = (dateStr: string) => {
    if (!selecting) {
      setSelecting(dateStr);
    } else {
      const [s, e] = dateStr < selecting ? [dateStr, selecting] : [selecting, dateStr];
      onChange(s, e);
      setSelecting('');
      setOpen(false);
    }
  };

  const clearFilter = () => {
    onChange('', '');
    setSelecting('');
    setOpen(false);
  };

  const cells = buildCalendar(view.year, view.month);

  const effectiveStart = selecting || startDate;
  const effectiveEnd = selecting ? hoverDate : endDate;
  const rangeStart = effectiveStart && effectiveEnd
    ? (effectiveStart < effectiveEnd ? effectiveStart : effectiveEnd)
    : effectiveStart;
  const rangeEnd = effectiveStart && effectiveEnd
    ? (effectiveStart < effectiveEnd ? effectiveEnd : effectiveStart)
    : '';

  const hasFilter = startDate || endDate;

  const popup = (
    <div
      ref={popupRef}
      style={{
        position: 'fixed',
        top: popupPos.top,
        left: popupPos.left,
        zIndex: 99999,
        background: 'var(--admin-panel)',
        border: '1px solid var(--admin-border)',
        boxShadow: '0 8px 32px rgba(0,0,0,.8)',
        padding: 14,
        minWidth: 280,
        userSelect: 'none',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <button type="button" className="btn-industrial" style={{ height: 24, width: 24, padding: 0 }} onClick={prevMonth}>
          <ChevronLeft size={13} />
        </button>
        <span style={{ fontSize: '.78rem', fontWeight: 800, letterSpacing: '.04em', color: 'var(--admin-text)' }}>
          {MONTHS[view.month]} {view.year}
        </span>
        <button type="button" className="btn-industrial" style={{ height: 24, width: 24, padding: 0 }} onClick={nextMonth}>
          <ChevronRight size={13} />
        </button>
      </div>

      {/* Hint */}
      <div style={{ fontSize: '.62rem', color: 'var(--admin-text-muted)', marginBottom: 8, textAlign: 'center', letterSpacing: '.03em' }}>
        {selecting ? '▶ Nhấn chọn ngày kết thúc' : '▶ Nhấn chọn ngày bắt đầu'}
      </div>

      {/* Weekday headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {WEEKDAYS.map(d => (
          <div key={d} style={{ textAlign: 'center', fontSize: '.6rem', fontWeight: 900, color: 'var(--admin-text-muted)', padding: '2px 0' }}>
            {d}
          </div>
        ))}
      </div>

      {/* Days grid */}
      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}
        onMouseLeave={() => setHoverDate('')}
      >
        {cells.map(({ date, otherMonth }, i) => {
          const ds = toDateStr(date);
          const isStart = ds === rangeStart;
          const isEnd = !!rangeEnd && ds === rangeEnd;
          const inRange = !!(rangeStart && rangeEnd && ds > rangeStart && ds < rangeEnd);
          const isToday = ds === today;
          const isPending = ds === selecting;

          return (
            <div
              key={i}
              onMouseEnter={() => selecting && setHoverDate(ds)}
              onClick={() => !otherMonth && handleDayClick(ds)}
              style={{
                textAlign: 'center',
                padding: '5px 0',
                fontSize: '.7rem',
                fontWeight: isStart || isEnd || isPending ? 900 : 500,
                cursor: otherMonth ? 'default' : 'pointer',
                color: otherMonth
                  ? 'var(--admin-text-muted)'
                  : isStart || isEnd ? '#fff'
                  : inRange ? 'var(--admin-text)'
                  : isToday ? 'var(--admin-accent)'
                  : 'var(--admin-text)',
                background: isStart || isEnd
                  ? 'var(--admin-accent)'
                  : isPending ? 'rgba(6,182,212,.5)'
                  : inRange ? 'rgba(6,182,212,.15)'
                  : 'transparent',
                borderRadius: 2,
                outline: isToday && !isStart && !isEnd ? '1px solid var(--admin-accent)' : 'none',
                transition: 'background .1s',
              }}
            >
              {date.getDate()}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--admin-border)' }}>
        <button type="button" className="btn-industrial" style={{ fontSize: '.68rem', height: 26, padding: '0 10px' }} onClick={clearFilter}>
          Xóa lọc
        </button>
        <div style={{ fontSize: '.65rem', color: 'var(--admin-text-muted)', fontFamily: 'var(--admin-font-mono)' }}>
          {rangeStart && rangeEnd ? `${rangeStart} → ${rangeEnd}` : rangeStart || '—'}
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        ref={triggerRef}
        type="button"
        className="btn-industrial"
        style={{
          height: 28,
          padding: '0 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          fontSize: '.72rem',
          fontFamily: 'var(--admin-font-mono)',
          fontWeight: 700,
          background: open || hasFilter ? 'rgba(6,182,212,.12)' : undefined,
          borderColor: open || hasFilter ? 'var(--admin-accent)' : undefined,
          color: hasFilter ? 'var(--admin-accent)' : undefined,
        }}
        onClick={openPopup}
        title="Lọc theo khoảng ngày"
      >
        <CalendarDays size={13} />
        {hasFilter && (
          <span style={{ fontSize: '.7rem', fontWeight: 700, letterSpacing: '.03em', whiteSpace: 'nowrap' }}>
            {startDate === endDate
              ? startDate
              : `${startDate.slice(5).replace('-', '/')} → ${endDate.slice(5).replace('-', '/')}`}
          </span>
        )}
        {hasFilter && (
          <span
            title="Xóa bộ lọc ngày"
            onClick={e => { e.stopPropagation(); clearFilter(); }}
            style={{
              marginLeft: 2,
              color: 'var(--admin-text-muted)',
              fontSize: '.8rem',
              lineHeight: 1,
              cursor: 'pointer',
            }}
          >
            ✕
          </span>
        )}
      </button>

      {open && createPortal(popup, document.body)}
    </div>
  );
}
