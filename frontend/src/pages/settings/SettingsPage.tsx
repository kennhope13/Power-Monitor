// ============================================================
// SettingsPage.tsx — Cài đặt hệ thống (5 tab)
// Tab 0: Cài đặt chung    (GeneralTab)    — polling, health check, email, timezone
// Tab 1: Thông báo        (NotificationTab) — SMTP + email test
// Tab 2: Giao diện        (ThemeTab)       — theme light/dark
// Tab 3: Cloud Sync       (CloudSyncTab)   — đồng bộ Supabase
// Tab 4: Liên kết Camera  (LinkageTab)     — auto camera action khi có alert
// ============================================================

import { useState } from 'react';
import GeneralTab from './tabs/GeneralTab';
import NotificationTab from './tabs/NotificationTab';
import CloudSyncTab from './tabs/CloudSyncTab';
import VideoStorageTab from './tabs/VideoStorageTab';
import './SettingsPage.css';

const TABS = ['CHUNG', 'THÔNG BÁO', 'CLOUD SYNC', 'LƯU TRỮ VIDEO'];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState(0);

  return (
    <div className="admin-page-container">
      <div className="page-toolbar-row">
        <div className="page-title-cell">
          <h2>CÀI ĐẶT</h2>
        </div>
        <div className="page-toolbar-group">
          {TABS.map((t, idx) => (
            <button
              key={idx}
              onClick={() => setActiveTab(idx)}
              className={`btn-industrial ${activeTab === idx ? 'btn-primary' : ''}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="admin-card" style={{ flex: 1, overflow: 'auto', padding: '20px 24px', borderRadius: 4 }}>
        {activeTab === 0 && <GeneralTab />}
        {activeTab === 1 && <NotificationTab />}
        {activeTab === 2 && <CloudSyncTab />}
        {activeTab === 3 && <VideoStorageTab />}
      </div>
    </div>
  );
}
