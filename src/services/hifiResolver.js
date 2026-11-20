import { api } from './api.js';

const STORAGE_KEY = 'mysongs-hifi-cache-v1';
const YT_OVERRIDE_KEY = 'mysongs-user-youtube-overrides';
const MAX_CACHE_ENTRIES = 2000;

export const VIDEO_TITLE_KEYWORDS = [
  'official music video',
  'official video',
  'music video',
  'official audio video',
  'lyric video',
  'lyrics video',
  'visualizer',
  'official visualizer',
  'performance video',
  'live performance',
  'dance practice',
  'live at',
  'live in',
  'live from',
  'live concert',
  'full concert',
  'trailer',
  'teaser',
  '[mv]',
  '(mv)',
  '[m/v]',
  '(m/v)',
  '[official video]',
  '(official video)',
  '[official music video]',
  '(official music video)',
  '(video)',
  '[video]',
];

export const KNOWN_UPSTREAM_MISMATCHES = new Set([
  '168395054749057024',
  '168589766881927168',
  '168395069831774208',
  '168395062953115648',
  '5266278',
  'kuwo_5266278',
  '196763238',
  'kuwo_196763238',
  '198259372',
  'kuwo_198259372',
  '238687094',
  'kuwo_238687094',
  '238687044',
  'kuwo_238687044',
]);

export function normalizeFlacStreamUrl(url, trackId) {
  if (!url && !trackId) return null;
  let targetId = null;
  if (typeof url === 'string') {
    const m =
      url.match(/\/flac\/([a-zA-Z0-9_-]+)/i) ||
      url.match(/\/track\/([a-zA-Z0-9_-]+)/i) ||
      url.match(/[?&]id=([a-zA-Z0-9_-]+)/i);
    if (m?.[1]) targetId = m[1];
  }
  if (!targetId && trackId) targetId = trackId;
  return targetId ? `/hifi/stream?id=${encodeURIComponent(targetId)}` : url;
}

export function isUserYoutubeForced(songId) {
  if (!songId || typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(YT_OVERRIDE_KEY);
    if (!raw) return false;
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.includes(String(songId));
  } catch {
    return false;
  }
}

export function setUserYoutubeForced(songId, forced) {
  if (!songId || typeof localStorage === 'undefined') return;
  try {
    const idStr = String(songId);
    let list = JSON.parse(localStorage.getItem(YT_OVERRIDE_KEY) || '[]');
    if (!Array.isArray(list)) list = [];
    list = forced ? [...new Set([...list, idStr])] : list.filter((x) => x !== idStr);
    localStorage.setItem(YT_OVERRIDE_KEY, JSON.stringify(list));
  } catch {}
}

export function isHifiEligibleTrack(song) {
  if (!song) return false;
  if (song.source === 'monochrome' || song.is_monochrome) return true;
  const itemType = String(song.item_type || '').toLowerCase().trim();
  const channel = String(song.channel || '').toLowerCase().trim();
  const title = String(song.title || '').toLowerCase().trim();

  if (itemType === 'video') return false;
  if (channel.includes('vevo')) return false;
  if (VIDEO_TITLE_KEYWORDS.some((k) => title.includes(k))) return false;
  if (/\b(mv|m\/v)\b/i.test(title)) return false;
  return true;
}

export function parseDurationToSecs(dur) {
  if (!dur) return 0;
  if (typeof dur === 'number') return dur > 1000 ? Math.round(dur / 1000) : Math.round(dur);
  const parts = String(dur).split(':').map(Number);
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  return 0;
}

function loadPersistentCache() {
  const map = new Map();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      for (const item of JSON.parse(raw)) {
        if (Array.isArray(item) && item.length === 2 && item[1]?.stream_url) {
          map.set(item[0], item[1]);
        }
      }
    }
  } catch {}
  return map;
}

export const hifiCache = loadPersistentCache();
export const sessionUnmatchedSet = new Set();
const inFlightResolutions = new Map();
let saveTimer = null;

function persistCacheDebounced() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      let entries = Array.from(hifiCache.entries());
      if (entries.length > MAX_CACHE_ENTRIES) entries = entries.slice(-MAX_CACHE_ENTRIES);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {}
  }, 350);
}

export function getCachedHifi(song) {
  if (!song || !isHifiEligibleTrack(song)) return null;
  if (song._hifiFailed || song._userForcedYoutube) return null;
  const idKey = song.id ? String(song.id) : null;
  if (idKey && (isUserYoutubeForced(idKey) || sessionUnmatchedSet.has(idKey))) return null;
  const cached = idKey && hifiCache.get(idKey);
  if (!cached || !cached.stream_url) return null;
  return {
    ...cached,
    stream_url: normalizeFlacStreamUrl(cached.stream_url, cached.hifi_id),
  };
}

export function prepareTrackThroughGateSync(song, isHifiEnabled = true) {
  if (!song || typeof song !== 'object') return song;
  const uid = song.uid || `${song.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  if (!isHifiEnabled || !isHifiEligibleTrack(song)) {
    return { ...song, uid, stream_url: null, source: null, hifi_id: null };
  }
  if (song.id && isUserYoutubeForced(song.id)) {
    return { ...song, uid, stream_url: null, source: null, hifi_id: null, _userForcedYoutube: true };
  }
  const cached = getCachedHifi(song);
  if (cached) {
    return {
      ...song,
      uid,
      stream_url: cached.stream_url,
      hifi_id: cached.hifi_id,
      source: cached.source || 'hifi',
      _hifiChecked: true,
    };
  }
  return {
    ...song,
    uid,
    stream_url: song.stream_url ? normalizeFlacStreamUrl(song.stream_url, song.hifi_id) : null,
  };
}

export async function resolveHifiForTrack(song, { forceRefresh = false } = {}) {
  if (!song || !isHifiEligibleTrack(song)) return null;
  const idKey = song.id ? String(song.id) : null;
  if (!forceRefresh) {
    const cached = getCachedHifi(song);
    if (cached) return cached;
    if (idKey && sessionUnmatchedSet.has(idKey)) return null;
  }
  if (idKey && inFlightResolutions.has(idKey)) {
    return inFlightResolutions.get(idKey);
  }

  const job = (async () => {
    try {
      const res = await api.resolveHifiTrack({
        songId: idKey,
        title: song.title || '',
        channel: song.channel || song.artist || null,
        duration: song.duration || null,
        itemType: song.item_type || null,
        album: song.album || null,
      });
      if (res?.matched && res.stream_url) {
        const entry = {
          hifi_id: res.hifi_id,
          stream_url: normalizeFlacStreamUrl(res.stream_url, res.hifi_id),
          source: res.source || 'hifi',
          album: res.album || song.album || null,
        };
        if (idKey) {
          hifiCache.set(idKey, entry);
          sessionUnmatchedSet.delete(idKey);
          persistCacheDebounced();
        }
        return entry;
      }
      if (idKey) sessionUnmatchedSet.add(idKey);
      return null;
    } catch {
      return null;
    } finally {
      if (idKey) inFlightResolutions.delete(idKey);
    }
  })();

  if (idKey) inFlightResolutions.set(idKey, job);
  return job;
}
