import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { Download, ChevronDown, FileSpreadsheet, FileText } from 'lucide-react';
import DateRangePicker from '@/components/ui/DateRangePicker';
import ToolbarSelect from '@/components/ui/ToolbarSelect';
import './AnalyticsLayout.css';
import CabinetAnalyticsTab from './tabs/CabinetAnalyticsTab';
import ThermalForecastTab from './tabs/ThermalForecastTab';
import PdAnalyticsTab from './tabs/PdAnalyticsTab';

interface ExportFns { xlsx: () => void; csv: () => void; pdf: () => void; }

export default function AnalyticsLayout() {
  const [searchParams] = useSearchParams();
  const cabParam = searchParams.get('cabinet');
  const [activeTab, setActiveTab] = useState<'cabinet' | 'thermal' | 'pd'>('thermal');

  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const [exportFns, setExportFns] = useState<ExportFns | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 0 });

  const registerExport = useCallback((fns: ExportFns | null) => setExportFns(fns), []);

  useEffect(() => {
    if (cabParam) setActiveTab('cabinet');
  }, [cabParam]);

  useEffect(() => {
    setExportFns(null);
  }, [activeTab]);

  useEffect(() => {
    if (!exportOpen) return;
    const handler = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node) &&
          exportBtnRef.current && !exportBtnRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [exportOpen]);

  const openExportMenu = () => {
    const r = exportBtnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 160) });
    setExportOpen(o => !o);
  };

  return (
    <div className="admin-page-container">
      <div className="page-toolbar-row">
        <div className="page-title-cell">
          <h2>PHÂN TÍCH</h2>
        </div>

        <div className="page-toolbar-group">
          <DateRangePicker
            startDate={fromDate}
            endDate={toDate}
            onChange={(s, e) => { setFromDate(s); setToDate(e); }}
          />

          <div className="page-toolbar-cell" style={{ height: 28 }}>
            <span className="page-cell-label">LOẠI:</span>
            <ToolbarSelect
              value={activeTab}
              onChange={(v: string) => setActiveTab(v as 'cabinet' | 'thermal' | 'pd')}
              options={[
                { value: 'thermal', label: 'AI NHIỆT' },
                { value: 'pd', label: 'PHÂN TÍCH PHÓNG ĐIỆN' },
                { value: 'cabinet', label: 'PHÂN TÍCH TỦ ĐIỆN' },
              ]}
              width={180}
            />
          </div>

          {exportFns && (
            <div style={{ position: 'relative' }}>
              <button
                ref={exportBtnRef}
                className="btn-industrial btn-primary"
                style={{ height: 28, padding: '0 10px', fontSize: '.72rem', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                onClick={openExportMenu}
              >
                <Download size={13} />
                XUẤT
                <ChevronDown size={12} />
              </button>
              {exportOpen && createPortal(
                <div
                  ref={exportMenuRef}
                  style={{
                    position: 'fixed',
                    top: menuPos.top,
                    left: menuPos.left,
                    minWidth: menuPos.width,
                    zIndex: 99999,
                    background: 'var(--admin-panel)',
                    border: '1px solid var(--admin-border)',
                    boxShadow: '0 14px 30px rgba(0,0,0,.45)',
                  }}
                >
                  {[
                    { label: 'Xuất XLSX', icon: <FileSpreadsheet size={14} />, fn: exportFns.xlsx },
                    { label: 'Xuất CSV',  icon: <FileText size={14} />,        fn: exportFns.csv  },
                    { label: 'Xuất PDF',  icon: <FileText size={14} />,        fn: exportFns.pdf  },
                  ].map(({ label, icon, fn }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => { setExportOpen(false); fn(); }}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', background: 'transparent', border: 'none', color: 'var(--admin-text)', fontSize: 12, textAlign: 'left', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.06)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      {icon} {label}
                    </button>
                  ))}
                </div>,
                document.body
              )}
            </div>
          )}
        </div>
      </div>

      <div className="analytics-content-area" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'cabinet' && <CabinetAnalyticsTab fromDate={fromDate} toDate={toDate} registerExport={registerExport} />}
        {activeTab === 'thermal' && <ThermalForecastTab fromDate={fromDate} toDate={toDate} registerExport={registerExport} />}
        {activeTab === 'pd' && <PdAnalyticsTab fromDate={fromDate} toDate={toDate} registerExport={registerExport} />}
      </div>
    </div>
  );
}
