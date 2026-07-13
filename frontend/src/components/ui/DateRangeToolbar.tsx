import ToolbarSelect from '@/components/ui/ToolbarSelect';

type QuickRange = 'all' | 'today' | 'yesterday' | '7d' | '30d' | 'custom';

interface DateRangeToolbarProps {
  label?: string;
  preset: QuickRange;
  from: string;
  to: string;
  onPresetChange: (preset: QuickRange) => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  compact?: boolean;
  presetWidth?: number;
}

export default function DateRangeToolbar({
  label = 'THỜI GIAN:',
  preset,
  from,
  to,
  onPresetChange,
  onFromChange,
  onToChange,
  compact = false,
  presetWidth = 120,
}: DateRangeToolbarProps) {
  return (
    <div className="page-toolbar-cell" style={{ height: 28, display: 'flex', alignItems: 'center', gap: 8, flexWrap: compact ? 'wrap' : 'nowrap' }}>
      <span className="page-cell-label">{label}</span>
      <ToolbarSelect
        value={preset}
        onChange={v => onPresetChange(v as QuickRange)}
        options={[
          { value: 'today', label: 'Hôm nay' },
          { value: 'yesterday', label: 'Hôm qua' },
          { value: '7d', label: '7 ngày' },
          { value: '30d', label: '30 ngày' },
          { value: 'custom', label: 'Tùy chọn' },
          { value: 'all', label: 'Tất cả' },
        ]}
        width={presetWidth}
      />
      <input
        type="date"
        value={from}
        onChange={e => {
          if (preset !== 'custom') onPresetChange('custom');
          onFromChange(e.target.value);
        }}
        style={{
          height: 28,
          background: 'var(--admin-layer-2)',
          border: '1px solid var(--admin-border)',
          color: 'var(--admin-text)',
          fontSize: '.75rem',
          padding: '0 8px',
          borderRadius: 0,
          outline: 'none',
          fontFamily: 'var(--font-mono)',
        }}
        title="Từ ngày"
      />
      <span style={{ color: 'var(--admin-text-muted)', fontSize: '.72rem', fontWeight: 700 }}>→</span>
      <input
        type="date"
        value={to}
        onChange={e => {
          if (preset !== 'custom') onPresetChange('custom');
          onToChange(e.target.value);
        }}
        style={{
          height: 28,
          background: 'var(--admin-layer-2)',
          border: '1px solid var(--admin-border)',
          color: 'var(--admin-text)',
          fontSize: '.75rem',
          padding: '0 8px',
          borderRadius: 0,
          outline: 'none',
          fontFamily: 'var(--font-mono)',
        }}
        title="Đến ngày"
      />
    </div>
  );
}
