import { useEffect, useRef } from 'react';
import { getRealtimeHub, startRealtimeHub } from '@/services/realtime.service';
import { HubConnection } from '@microsoft/signalr';

interface RealtimeHandlers {
  onSensorUpdate?: (data: any[]) => void;
  onAlertNew?: (data: any) => void;
  onAlertUpdated?: (data: any) => void;
}

/** Hook quản lý vòng đời kết nối SignalR WebSocket: tự động connect khi mount, cleanup khi unmount. */
export function useRealtime(handlers: RealtimeHandlers, dependencies: any[] = []) {
  const hubRef = useRef<HubConnection | null>(null);

  useEffect(() => {
    const hub = getRealtimeHub();
    hubRef.current = hub;

    if (handlers.onSensorUpdate) {
      hub.on('SensorUpdate', handlers.onSensorUpdate);
    }
    if (handlers.onAlertNew) {
      hub.on('AlertNew', handlers.onAlertNew);
    }
    if (handlers.onAlertUpdated) {
      hub.on('AlertUpdated', handlers.onAlertUpdated);
    }

    let isMounted = true;
    const startHub = async () => {
      try {
        await startRealtimeHub();
      } catch (err) {
        console.warn('[useRealtime] SignalR Connection failed, retrying in 5s...', err);
        if (isMounted) {
          setTimeout(startHub, 5000);
        }
      }
    };
    startHub();

    return () => {
      isMounted = false;
      if (handlers.onSensorUpdate) {
        hub.off('SensorUpdate', handlers.onSensorUpdate);
      }
      if (handlers.onAlertNew) {
        hub.off('AlertNew', handlers.onAlertNew);
      }
      if (handlers.onAlertUpdated) {
        hub.off('AlertUpdated', handlers.onAlertUpdated);
      }
      hubRef.current = null;
    };
  }, dependencies);

  return hubRef.current;
}
