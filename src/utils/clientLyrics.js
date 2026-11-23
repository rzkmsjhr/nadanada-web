const CLEAN_BRACKET_RE =
  /[\(\[\{（【](?:official(?:\s+(?:music|lyric|audio))?\s*(?:video|audio|mv)?|music\s*video|lyric\s*video|lyrics?|audio|hd|hq|4k|1080p|720p|mv|m\/v|topic|explicit|clean|remaster(?:ed)?(?:\s*\d{4})?|live(?:\s+at\s+[^\)\]\}]+)?|acoustic(?:\s+version)?|feat\.?\s+[^\)\]\}]*)[\)\]\}）】]/gi;
const CLEAN_TRAILING_RE =
  /\s*[-–—|]\s*(?:official(?:\s+(?:music|lyric|audio))?\s*(?:video|audio)|lyrics?|hd|hq|topic).*$/i;

export function cleanLrclibTitle(title = '') {
  return String(title || '')
    .replace(CLEAN_BRACKET_RE, ' ')
    .replace(CLEAN_TRAILING_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanLrclibArtist(artist = '') {
  return String(artist || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\bVEVO$/i, '')
    .replace(/\s*(?:&|and|feat\.?|ft\.?|,)\s*.+$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchSimpleJson(url, fetchImpl, timeoutMs = 3500) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    // Keep CORS request simple (no custom headers) so browser skips preflight OPTIONS
    const res = await fetchImpl(url, controller ? { signal: controller.signal } : {});
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toLyricsPayload(item) {
  if (!item) return null;
  const synced = item.syncedLyrics ? String(item.syncedLyrics).trim() : null;
  const plain = item.plainLyrics ? String(item.plainLyrics).trim() : null;
  const instrumental = Boolean(item.instrumental);
  if (!synced && !plain && !instrumental) return null;
  return {
    success: true,
    synced_lyrics: synced || null,
    plain_lyrics: plain || null,
    source: 'LRCLIB (Direct)',
    instrumental,
    error: null,
  };
}

/**
 * Queries LRCLIB directly from the visitor's browser (CORS Access-Control-Allow-Origin: *)
 * so lyrics traffic distributes across user IPs instead of the origin server.
 */
export async function fetchClientLrclib(
  title = '',
  artist = '',
  duration = null,
  fetchImpl = globalThis.fetch
) {
  if (typeof fetchImpl !== 'function') return null;
  const cleanTitle = cleanLrclibTitle(title);
  const cleanArtist = cleanLrclibArtist(artist);
  if (!cleanTitle) return null;

  const durNum = duration && Number.isFinite(Number(duration)) ? Math.round(Number(duration)) : null;

  if (cleanArtist) {
    const getParams = new URLSearchParams({
      track_name: cleanTitle,
      artist_name: cleanArtist,
    });
    if (durNum && durNum > 0) getParams.set('duration', String(durNum));
    const exact = await fetchSimpleJson(
      `https://lrclib.net/api/get?${getParams.toString()}`,
      fetchImpl,
      3500
    );
    const exactPayload = toLyricsPayload(exact);
    if (exactPayload && exactPayload.synced_lyrics) {
      return exactPayload;
    }

    const searchParams = new URLSearchParams({
      track_name: cleanTitle,
      artist_name: cleanArtist,
    });
    const list = await fetchSimpleJson(
      `https://lrclib.net/api/search?${searchParams.toString()}`,
      fetchImpl,
      3500
    );
    if (Array.isArray(list) && list.length > 0) {
      const withinDur = durNum
        ? list.filter((c) => !c.duration || Math.abs(Number(c.duration) - durNum) <= 10)
        : list;
      const pool = withinDur.length > 0 ? withinDur : list;
      const synced = pool.find((c) => c?.syncedLyrics && String(c.syncedLyrics).trim());
      if (synced) return toLyricsPayload(synced);
      const plain = pool.find((c) => c?.plainLyrics && String(c.plainLyrics).trim());
      if (plain) return exactPayload || toLyricsPayload(plain);
    }

    if (exactPayload) return exactPayload;
  }

  return null;
}
