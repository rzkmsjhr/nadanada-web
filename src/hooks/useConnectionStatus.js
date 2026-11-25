import { useState, useEffect, useCallback, useRef } from 'react';
import {
  CONNECTION_STATUS,
  getConnectionLabel,
  probeServerHealth,
} from '../utils/connectionStatus';

export function useConnectionStatus() {
  const [status, setStatus] = useState(() =>
    typeof navigator !== 'undefined' && navigator.onLine === false
      ? CONNECTION_STATUS.OFFLINE
      : CONNECTION_STATUS.CONNECTED
  );
  const probingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const checkHealth = useCallback(async () => {
    if (probingRef.current) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      if (mountedRef.current) setStatus(CONNECTION_STATUS.OFFLINE);
      return false;
    }

    probingRef.current = true;
    if (mountedRef.current) setStatus(CONNECTION_STATUS.RECONNECTING);
    try {
      const ok = await probeServerHealth();
      if (mountedRef.current) {
        setStatus(ok ? CONNECTION_STATUS.CONNECTED : CONNECTION_STATUS.OFFLINE);
      }
      return ok;
    } finally {
      probingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onOffline = () => {
      if (mountedRef.current) setStatus(CONNECTION_STATUS.OFFLINE);
    };
    const onOnline = () => {
      checkHealth();
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [checkHealth]);

  useEffect(() => {
    if (status === CONNECTION_STATUS.CONNECTED) return undefined;
    const timer = setInterval(() => {
      checkHealth();
    }, 3000);
    return () => clearInterval(timer);
  }, [status, checkHealth]);

  const reportNetworkFailure = useCallback(() => {
    checkHealth();
  }, [checkHealth]);

  const reportNetworkSuccess = useCallback(() => {
    if (!mountedRef.current) return;
    setStatus((prev) => (prev === CONNECTION_STATUS.CONNECTED ? prev : CONNECTION_STATUS.CONNECTED));
  }, []);

  return {
    status,
    label: getConnectionLabel(status),
    isOffline: status === CONNECTION_STATUS.OFFLINE,
    isReconnecting: status === CONNECTION_STATUS.RECONNECTING,
    reportNetworkFailure,
    reportNetworkSuccess,
    retryNow: checkHealth,
  };
}
