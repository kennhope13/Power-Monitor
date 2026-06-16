// preload.js — sandbox bridge (không cần gì đặc biệt cho Streamlit wrapper)
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  version: process.versions.electron,
});
