/**
 * Network connectivity status helpers and server /api/health prober.
 */

export const CONNECTION_STATUS = {
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  OFFLINE: 'offline',
};

const LABELS = {
  [CONNECTION_STATUS.CONNECTED]: 'Connected',
  [CONNECTION_STATUS.RECONNECTING]: 'Reconnecting',
  [CONNECTION_STATUS.OFFLINE]: 'Connection lost',
};

export function getConnectionLabel(status) {
  return LABELS[status] || 'Connected';
}

export async function probeServerHealth(fetchImpl = globalThis.fetch, timeoutMs = 4000) {
  if (typeof fetchImpl !== 'function') return false;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(200, Number(timeoutMs) || 4000)) : null;

  try {
    const res = await fetchImpl('/api/health', {
      method: 'GET',
      cache: 'no-store',
      ...(controller ? { signal: controller.signal } : {}),
    });
    return Boolean(res && res.ok);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
