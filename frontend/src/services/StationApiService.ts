// ============================================================
// StationApiService — Facade tổng hợp toàn bộ API của hệ thống
// Mọi component chỉ cần import từ đây, không import trực tiếp
// từ các service con trong api/ để dễ refactor sau này.
// ============================================================

import { stationService } from './api/StationService';
import { deviceService } from './api/DeviceService';
import { sensorService } from './api/SensorService';
import { alertService } from './api/AlertService';
import { sldService } from './api/SldService';
import { analyticsService } from './api/AnalyticsService';
import { systemService } from './api/SystemService';
import { ruleService } from './api/RuleService';
import { logService } from './api/LogService';
import { boundaryService } from './api/BoundaryService';
import { aiService, type PredictionHistoryPoint, type TrainingStatus } from './api/AiService';
import { eventService } from './api/EventService';

import type {
  Station, Device, CameraDevice, RoiPoint, CameraType, SensorPoint, Rule, AlertItem,
  AlertHistoryEntry, AuditLogEntry, LoginLogEntry, NotifyLogEntry, RuleTriggerLogEntry, UserItem,
  SldPoint, SldUnpinnedDevice, SldData, ReportItem, MaintenanceTask, MaintenanceSuggestion,
  SmtpConfig, HealthScore, TrendItem, SyncStatus, Boundary
} from '@/types/api.types';

// Re-export tất cả types để component không cần import từ 2 nơi
export type {
  Station, Device, CameraDevice, RoiPoint, CameraType, SensorPoint, Rule, AlertItem,
  AlertHistoryEntry, AuditLogEntry, LoginLogEntry, NotifyLogEntry, RuleTriggerLogEntry, UserItem,
  SldPoint, SldUnpinnedDevice, SldData, ReportItem, MaintenanceTask, MaintenanceSuggestion,
  SmtpConfig, HealthScore, TrendItem, SyncStatus, Boundary,
  PredictionHistoryPoint, TrainingStatus
};

/**
 * Facade tổng hợp toàn bộ API của hệ thống.
 * Mọi component chỉ cần import từ đây thay vì từ các service con trong api/.
 */
class StationApiService {
  // ── AI Engine ──────────────────────────────────────────────
  getAiPredictionHistory = aiService.getPredictionHistory.bind(aiService);
  getAiTrainingStatus = aiService.getTrainingStatus.bind(aiService);
  triggerAiRetrain = aiService.triggerRetrain.bind(aiService);

  // ── Stations ──────────────────────────────────────────────
  getStations = stationService.getStations.bind(stationService);
  getFirstStationId = stationService.getFirstStationId.bind(stationService);
  createStation = stationService.createStation.bind(stationService);
  updateStation = stationService.updateStation.bind(stationService);
  deleteStation = stationService.deleteStation.bind(stationService);

  // ── Devices ───────────────────────────────────────────────
  getDevices = deviceService.getDevices.bind(deviceService);
  createDevice = deviceService.createDevice.bind(deviceService);
  updateDevice = deviceService.updateDevice.bind(deviceService);
  deleteDevice = deviceService.deleteDevice.bind(deviceService);
  testConnection = deviceService.testConnection.bind(deviceService);
  getCredentials = deviceService.getCredentials.bind(deviceService);
  getCameras = deviceService.getCameras.bind(deviceService);
  scanLan = deviceService.scanLan.bind(deviceService);
  discoverOnvif = deviceService.discoverOnvif.bind(deviceService);
  testProtocolConnection = deviceService.testProtocolConnection.bind(deviceService);
  discoverHikvision = deviceService.discoverHikvision.bind(deviceService);
  autoConfigure = deviceService.autoConfigure.bind(deviceService);
  importCabinetTemplate = deviceService.importCabinetTemplate.bind(deviceService);
  getRelated = deviceService.getRelated.bind(deviceService);

  // ── ROI Points ────────────────────────────────────────────
  getRoiPoints = deviceService.getRoiPoints.bind(deviceService);
  createRoiPoint = deviceService.createRoiPoint.bind(deviceService);
  updateRoiPoint = deviceService.updateRoiPoint.bind(deviceService);
  deleteRoiPoint = deviceService.deleteRoiPoint.bind(deviceService);
  getThermalReadings = deviceService.getThermalReadings.bind(deviceService);
  getCameraSnapshot = deviceService.getCameraSnapshot.bind(deviceService);
  getThermalMapping = deviceService.getThermalMapping.bind(deviceService);
  syncThermalConfig = deviceService.syncThermalConfig.bind(deviceService);

  // ── Boundaries ───────────────────────────────────────────
  getBoundaries = boundaryService.getBoundaries.bind(boundaryService);
  getBoundary = boundaryService.getBoundary.bind(boundaryService);
  createBoundary = boundaryService.createBoundary.bind(boundaryService);
  updateBoundary = boundaryService.updateBoundary.bind(boundaryService);
  deleteBoundary = boundaryService.deleteBoundary.bind(boundaryService);

  /** Lấy danh sách camera từ trạm đầu tiên (fallback cho UI khi chưa chọn trạm). */
  async getCamerasFromFirstStation(): Promise<CameraDevice[]> {
    const stations = await this.getStations();
    if (!stations[0]) return [];
    return this.getCameras(stations[0].id);
  }

  // ── Sensors ───────────────────────────────────────────────
  getLatestPoints = sensorService.getLatestPoints.bind(sensorService);
  getHistory = sensorService.getHistory.bind(sensorService);
  getHistoryBulk = sensorService.getHistoryBulk.bind(sensorService);

  // ── Rules ─────────────────────────────────────────────────
  getRules = ruleService.getRules.bind(ruleService);
  createRule = ruleService.createRule.bind(ruleService);
  updateRule = ruleService.updateRule.bind(ruleService);
  deleteRule = ruleService.deleteRule.bind(ruleService);
  toggleRule = ruleService.toggleRule.bind(ruleService);

  // ── Alerts ────────────────────────────────────────────────
  getAlerts = alertService.getAlerts.bind(alertService);
  ackAlert = alertService.ackAlert.bind(alertService);
  closeAlert = alertService.closeAlert.bind(alertService);
  getAlertDetail = alertService.getAlertDetail.bind(alertService);
  exportAlertsCsv = alertService.exportCsv.bind(alertService);
  sendAlertCentral = alertService.sendCentral.bind(alertService);

  // ── Logs ──────────────────────────────────────────────────
  getAuditLogs = logService.getAuditLogs.bind(logService);
  getLoginLogs = logService.getLoginLogs.bind(logService);
  getNotifyLogs = logService.getNotifyLogs.bind(logService);
  getRuleTriggerLogs = logService.getRuleTriggerLogs.bind(logService);

  // ── Events ────────────────────────────────────────────────
  getEvents = eventService.getEvents.bind(eventService);
  getEventContext = eventService.getEventContext.bind(eventService);
  getEventVideoUrl = eventService.getEventVideoUrl.bind(eventService);
  getEventBundleUrl = eventService.getEventBundleUrl.bind(eventService);

  // ── Systems ───────────────────────────────────────────────
  getUsers = systemService.getUsers.bind(systemService);
  createUser = systemService.createUser.bind(systemService);
  updateUser = systemService.updateUser.bind(systemService);
  deactivateUser = systemService.deleteUser.bind(systemService);
  changePassword = systemService.changePassword.bind(systemService);

  // ── SLD ───────────────────────────────────────────────────
  getSld = sldService.getSld.bind(sldService);
  uploadSldSvg = sldService.uploadSldSvg.bind(sldService);
  addSldPoint = sldService.addSldPoint.bind(sldService);
  updateSldPoint = sldService.updateSldPoint.bind(sldService);
  deleteSldPoint = sldService.deleteSldPoint.bind(sldService);

  // ── Analytics & Reports ───────────────────────────────────
  generateReport = analyticsService.generateReport.bind(analyticsService);
  getReports = analyticsService.getReports.bind(analyticsService);
  downloadReport = analyticsService.downloadReport.bind(analyticsService);
  getDownloadUrl = analyticsService.getDownloadUrl.bind(analyticsService);
  deleteReport = analyticsService.deleteReport.bind(analyticsService);
  getMaintenance = analyticsService.getMaintenance.bind(analyticsService);
  createMaintenance = analyticsService.createMaintenance.bind(analyticsService);
  updateMaintenance = analyticsService.updateMaintenance.bind(analyticsService);
  deleteMaintenance = analyticsService.deleteMaintenance.bind(analyticsService);
  startMaintenance = analyticsService.startMaintenance.bind(analyticsService);
  completeMaintenance = analyticsService.completeMaintenance.bind(analyticsService);
  getMaintenanceSuggestions = analyticsService.getMaintenanceSuggestions.bind(analyticsService);
  getHealthScores = analyticsService.getHealthScores.bind(analyticsService);
  getTrends = analyticsService.getTrends.bind(analyticsService);

  // ── System ────────────────────────────────────────────────
  getSettings = systemService.getSettings.bind(systemService);
  updateSetting = systemService.updateSetting.bind(systemService);
  getSyncStatus = systemService.getSyncStatus.bind(systemService);
  triggerSync = systemService.triggerSync.bind(systemService);
  getSmtpConfig = systemService.getSmtpConfig.bind(systemService);
  sendTestEmail = systemService.sendTestEmail.bind(systemService);
  getDetections = systemService.getDetections.bind(systemService);
  getLicenseStatus = systemService.getLicenseStatus.bind(systemService);
  activateLicense = systemService.activateLicense.bind(systemService);
}

export const stationApi = new StationApiService();
