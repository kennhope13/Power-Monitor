export interface StationConfig {
  serverIp: string;
  stationName: string;
}

type ElectronApi = {
  invoke: (command: string, args?: unknown) => Promise<unknown>;
};

const getElectronApi = (): ElectronApi | undefined =>
  (window as typeof window & { electronAPI?: ElectronApi }).electronAPI;

/**
 * Read station identity from Electron's persistent user-data directory.
 * localStorage remains as a browser fallback and for existing components.
 */
export const loadPersistentStationConfig = async (): Promise<StationConfig> => {
  const localConfig: StationConfig = {
    serverIp: localStorage.getItem('server_ip')?.trim() || '',
    stationName: localStorage.getItem('station_name')?.trim() || '',
  };

  const electronApi = getElectronApi();
  if (!electronApi) return localConfig;

  try {
    const saved = await electronApi.invoke('get-station-config') as Partial<StationConfig> | null;
    const config = {
      serverIp: saved?.serverIp?.trim() || localConfig.serverIp,
      stationName: saved?.stationName?.trim() || localConfig.stationName,
    };

    if (config.serverIp) localStorage.setItem('server_ip', config.serverIp);
    if (config.stationName) localStorage.setItem('station_name', config.stationName);
    return config;
  } catch {
    return localConfig;
  }
};

/** Persist the values both in the renderer and in Electron's native config file. */
export const savePersistentStationConfig = async (config: StationConfig): Promise<void> => {
  const normalized = {
    serverIp: config.serverIp.trim(),
    stationName: config.stationName.trim(),
  };

  localStorage.setItem('server_ip', normalized.serverIp);
  localStorage.setItem('station_name', normalized.stationName);

  const electronApi = getElectronApi();
  if (electronApi) await electronApi.invoke('save-station-config', normalized);
};
