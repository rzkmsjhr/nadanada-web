export const YTM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
export const YT_HTML_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
export const CHROME_130_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const LRCLIB_UA = 'NadaNada/1.0.0 (https://github.com/rzkmsjhr/nadanada)';

export const YTM_CONTEXT = {
  client: {
    clientName: 'WEB_REMIX',
    clientVersion: '1.20240101.01.00',
    hl: 'en',
    gl: 'US',
  },
};

export const RELAY_ALLOWED_HOSTS = new Set([
  'music.youtube.com',
  'www.youtube.com',
  'tracks.monochrome.st',
  'flac.music.hi.cn',
  'kworb.net',
]);

let relayRoundRobinIdx = 0;

export function getRelayUrls() {
  return String(process.env.UPSTREAM_RELAY_URLS || '')
    .split(',')
    .map((u) => u.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function isRelayEligible(url, options = {}) {
  if (options?.bypassRelay) return false;
  const relays = getRelayUrls();
  if (relays.length === 0) return false;
  try {
    const parsed = new URL(url);
    return RELAY_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function buildCombinedSignal(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let onExternalAbort = null;

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      onExternalAbort = () => controller.abort();
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

function isRelayRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const { signal: externalSignal, bypassRelay: _ignored, ...restOptions } = options || {};
  const startedAt = Date.now();

  if (isRelayEligible(url, options)) {
    const relays = getRelayUrls();
    const relayBase = relays[relayRoundRobinIdx % relays.length];
    relayRoundRobinIdx = (relayRoundRobinIdx + 1) >>> 0;
    const relayUrl = `${relayBase}/relay`;
    const relaySecret = String(process.env.UPSTREAM_RELAY_SECRET || '').trim();

    const relayHeaders = { ...(restOptions.headers || {}) };
    relayHeaders['X-Target-Url'] = String(url);
    relayHeaders['X-Target-Method'] = String(restOptions.method || 'GET').toUpperCase();
    if (relaySecret) {
      relayHeaders['X-Relay-Secret'] = relaySecret;
    }

    const relayTimer = buildCombinedSignal(timeoutMs, externalSignal);
    try {
      const relayRes = await fetch(relayUrl, {
        ...restOptions,
        method: 'POST',
        headers: relayHeaders,
        signal: relayTimer.signal,
      });
      if (!isRelayRetryableStatus(relayRes.status)) {
        return relayRes;
      }
      await relayRes.body?.cancel?.();
    } catch {
      if (externalSignal?.aborted) throw new Error('Request aborted');
    } finally {
      relayTimer.cleanup();
    }
  }

  const remainingMs = Math.max(1000, timeoutMs - (Date.now() - startedAt));
  const directTimer = buildCombinedSignal(remainingMs, externalSignal);
  try {
    return await fetch(url, {
      ...restOptions,
      signal: directTimer.signal,
    });
  } finally {
    directTimer.cleanup();
  }
}

export function decodeHtmlEntities(str = '') {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}
