import { api } from './api.js';
import { sanitizeTrackAlbum } from '../utils/albumMetadata.js';

export const HIFI_MATCHER_VERSION = 18;
const STORAGE_KEY = 'mysongs-hifi-cache-v18';
const LEGACY_STORAGE_KEYS = [
  'mysongs-hifi-cache-v1',
  'mysongs-hifi-cache-v15',
  'mysongs-hifi-cache-v16',
  'mysongs-hifi-cache-v17',
];
const YT_OVERRIDE_KEY = 'mysongs-user-youtube-overrides';
const ALBUM_CACHE_KEY = 'mysongs-album-cache-v2';
const MAX_CACHE_ENTRIES = 3000;
const DIRECT_URL_FRESH_MS = 12 * 60 * 1000;

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
  '162001181',
  'kuwo_162001181',
  '228981606',
  'kuwo_228981606',
  '228983127',
  'kuwo_228983127',
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
  '662121810',
  'kuwo_662121810',
]);

let transientCooldownUntil = 0;

export function isHifiCoolingDown() {
  return Date.now() < transientCooldownUntil;
}

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
  if (typeof dur === 'number') {
    if (!Number.isFinite(dur) || dur <= 0) return 0;
    return dur > 1000 ? Math.round(dur / 1000) : Math.round(dur);
  }
  const raw = String(dur).trim();
  if (/^\d+$/.test(raw)) return parseInt(raw, 10) || 0;
  const parts = raw.split(':').map(Number);
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  return 0;
}

export function formatTrackDuration(dur) {
  if (dur === null || dur === undefined || dur === '') return '';
  if (typeof dur === 'string') {
    const trimmed = dur.trim();
    if (/^\d+:\d{2}(?::\d{2})?$/.test(trimmed)) return trimmed;
  }
  const secs = parseDurationToSecs(dur);
  if (!secs || secs <= 0) return '';
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const remSecs = secs % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(remSecs).padStart(2, '0')}`;
  }
  return `${mins}:${String(remSecs).padStart(2, '0')}`;
}

export function getCachedAlbumForSong(song, albumCacheMap = null) {
  if (!song) return null;
  const idStr = song.id ? String(song.id) : null;
  if (idStr && albumCacheMap && albumCacheMap[idStr]?.album) {
    const a = String(albumCacheMap[idStr].album).trim();
    if (a) return a;
  }
  if (idStr && typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(ALBUM_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const a = parsed?.[idStr]?.album ? String(parsed[idStr].album).trim() : '';
        if (a) return a;
      }
    } catch {}
  }
  const direct = sanitizeTrackAlbum(song.album || song.album_name || '', song);
  return direct || null;
}

function makeTextKey(song) {
  if (!song?.title) return null;
  const ch = String(song.channel || song.artist || '').trim().toLowerCase();
  const ti = String(song.title || '').trim().toLowerCase();
  return ch && ti ? `${ch}:::${ti}` : null;
}

function loadPersistentCache() {
  const map = new Map();
  if (typeof localStorage === 'undefined') return map;
  for (const legacyKey of LEGACY_STORAGE_KEYS) {
    try {
      localStorage.removeItem(legacyKey);
    } catch {}
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      for (const item of JSON.parse(raw)) {
        if (
          Array.isArray(item) &&
          item.length === 2 &&
          item[1]?.stream_url &&
          item[1]?._hifiVersion === HIFI_MATCHER_VERSION &&
          !KNOWN_UPSTREAM_MISMATCHES.has(String(item[1]?.hifi_id || ''))
        ) {
          const { album: _ignoredAlbum, ...rest } = item[1];
          map.set(item[0], rest);
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

export function isKnownUnmatchedHifi(song) {
  if (!song) return false;
  const idKey = song.id ? String(song.id) : null;
  const textKey = makeTextKey(song);
  if (idKey && sessionUnmatchedSet.has(idKey)) return true;
  if (textKey && sessionUnmatchedSet.has(textKey)) return true;
  return false;
}

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
  const textKey = makeTextKey(song);
  if (idKey && (isUserYoutubeForced(idKey) || sessionUnmatchedSet.has(idKey))) return null;
  if (textKey && sessionUnmatchedSet.has(textKey)) return null;

  const cached = (idKey && hifiCache.get(idKey)) || (textKey && hifiCache.get(textKey)) || null;
  if (!cached || !cached.stream_url) return null;
  if (cached._hifiVersion !== HIFI_MATCHER_VERSION) return null;
  if (cached.hifi_id && KNOWN_UPSTREAM_MISMATCHES.has(String(cached.hifi_id))) return null;
  const { album: _ignoredAlbum, ...rest } = cached;
  return {
    ...rest,
    duration: cached.duration ? formatTrackDuration(cached.duration) : cached.duration,
    stream_url: normalizeFlacStreamUrl(cached.stream_url, cached.hifi_id),
  };
}

export function prepareTrackThroughGateSync(song, isHifiEnabled = true, albumCacheMap = null) {
  if (!song || typeof song !== 'object') return song;
  const uid = song.uid || `${song.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const effectiveAlbum = getCachedAlbumForSong(song, albumCacheMap);
  const currentAlbum = sanitizeTrackAlbum(song.album, song);
  const nextAlbum = effectiveAlbum || currentAlbum || null;
  const enriched = nextAlbum !== (song.album || null) ? { ...song, album: nextAlbum } : song;

  if (!isHifiEnabled || !isHifiEligibleTrack(enriched)) {
    return {
      ...enriched,
      uid,
      stream_url: null,
      source: null,
      hifi_id: null,
      _hifiChecked: true,
      _hifiVersion: HIFI_MATCHER_VERSION,
    };
  }
  if (enriched.id && isUserYoutubeForced(enriched.id)) {
    return {
      ...enriched,
      uid,
      stream_url: null,
      source: null,
      hifi_id: null,
      _userForcedYoutube: true,
      _hifiChecked: true,
      _hifiVersion: HIFI_MATCHER_VERSION,
    };
  }

  // Native Monochrome search/album track is already lossless
  if (
    enriched.source === 'monochrome' &&
    enriched.stream_url &&
    (!enriched.hifi_id || String(enriched.hifi_id) === String(enriched.id))
  ) {
    return {
      ...enriched,
      uid,
      stream_url: normalizeFlacStreamUrl(enriched.stream_url, enriched.hifi_id || enriched.id),
      _hifiChecked: true,
      _hifiVersion: HIFI_MATCHER_VERSION,
      _resolvedWithAlbum: true,
    };
  }

  const cached = getCachedHifi(enriched);
  if (cached) {
    return {
      ...enriched,
      uid,
      stream_url: cached.stream_url,
      hifi_id: cached.hifi_id,
      source: cached.source || 'kuwo',
      album:
        sanitizeTrackAlbum(enriched.album, {
          ...enriched,
          source: cached.source || 'kuwo',
          hifi_id: cached.hifi_id,
        }) || null,
      _hifiChecked: true,
      _hifiVersion: HIFI_MATCHER_VERSION,
      _resolvedWithAlbum: Boolean(cached._resolvedWithAlbum),
    };
  }

  // Drop stale/blacklisted stream fields from older matcher versions so track gets cleanly re-verified
  if (
    (enriched.hifi_id && KNOWN_UPSTREAM_MISMATCHES.has(String(enriched.hifi_id))) ||
    (enriched._hifiVersion && enriched._hifiVersion !== HIFI_MATCHER_VERSION)
  ) {
    return {
      ...enriched,
      uid,
      stream_url: null,
      source: null,
      hifi_id: null,
      _hifiChecked: false,
      _hifiVersion: undefined,
      _resolvedWithAlbum: false,
    };
  }

  return {
    ...enriched,
    uid,
    stream_url: enriched.stream_url ? normalizeFlacStreamUrl(enriched.stream_url, enriched.hifi_id) : null,
  };
}

export async function resolveHifiForTrack(
  song,
  { forceRefresh = false, mode = 'play', ignoreBlacklist = false, albumCacheMap = null } = {}
) {
  if (!song || !isHifiEligibleTrack(song)) return null;

  // Native Monochrome item already points directly at lossless stream
  if (
    song.source === 'monochrome' &&
    song.id &&
    (!song.hifi_id || String(song.hifi_id) === String(song.id))
  ) {
    const targetId = song.hifi_id || song.id;
    return {
      hifi_id: targetId,
      stream_url: normalizeFlacStreamUrl(song.stream_url, targetId),
      source: 'monochrome',
      _hifiVersion: HIFI_MATCHER_VERSION,
      _resolvedWithAlbum: true,
      _ts: Date.now(),
    };
  }

  const idKey = song.id ? String(song.id) : null;
  const textKey = makeTextKey(song);
  const effectiveAlbum = getCachedAlbumForSong(song, albumCacheMap);
  const existingCached = getCachedHifi(song);

  if (!forceRefresh) {
    if (!ignoreBlacklist) {
      if (idKey && sessionUnmatchedSet.has(idKey)) return null;
      if (textKey && sessionUnmatchedSet.has(textKey)) return null;
    }

    if (existingCached) {
      const needsAlbumUpgrade = Boolean(effectiveAlbum && !existingCached._resolvedWithAlbum);
      const isHiCn = existingCached.source === 'kuwo' || existingCached.source === 'wyy';
      const needsPlayRefresh =
        mode === 'play' && isHiCn && (!existingCached._ts || Date.now() - existingCached._ts > DIRECT_URL_FRESH_MS);
      if (!needsAlbumUpgrade && !needsPlayRefresh) {
        return existingCached;
      }
    }
  }

  const dedupeKey = `${idKey || textKey || song.title}|${mode}|${effectiveAlbum || ''}`;
  if (inFlightResolutions.has(dedupeKey)) {
    return inFlightResolutions.get(dedupeKey);
  }

  const job = (async () => {
    try {
      const res = await api.resolveHifiTrack({
        songId: idKey,
        title: song.title || '',
        channel: song.channel || song.artist || null,
        duration: song.duration || (song.duration_ms ? String(Math.round(song.duration_ms / 1000)) : null),
        itemType: song.item_type || null,
        isrc: song.isrc || null,
        album: effectiveAlbum || null,
        mode,
        forceRefresh,
      });

      if (res?.matched && res.stream_url && res.hifi_id) {
        const entry = {
          hifi_id: res.hifi_id,
          stream_url: normalizeFlacStreamUrl(res.stream_url, res.hifi_id),
          source: res.source || (String(res.hifi_id).startsWith('wyy_') ? 'wyy' : String(res.hifi_id).startsWith('kuwo_') ? 'kuwo' : 'monochrome'),
          duration: formatTrackDuration(res.duration || song.duration) || '',
          is_cached: Boolean(res.is_cached),
          _hifiVersion: HIFI_MATCHER_VERSION,
          _resolvedWithAlbum: Boolean(res.resolved_with_album ?? effectiveAlbum),
          _ts: Date.now(),
        };
        if (idKey) {
          hifiCache.set(idKey, entry);
          sessionUnmatchedSet.delete(idKey);
        }
        if (textKey) {
          hifiCache.set(textKey, entry);
          sessionUnmatchedSet.delete(textKey);
        }
        persistCacheDebounced();
        return entry;
      }

      if (res?.transient) {
        transientCooldownUntil = Date.now() + 4000;
        if (existingCached?.stream_url) return existingCached;
        return { stream_url: null, _hifiTransient: true };
      }

      // Preserve prior valid cached stream if an album-upgrade re-query found no better candidate
      if (existingCached?.stream_url && !forceRefresh) {
        const preserved = { ...existingCached, _resolvedWithAlbum: true, _ts: Date.now() };
        if (idKey) hifiCache.set(idKey, preserved);
        if (textKey) hifiCache.set(textKey, preserved);
        persistCacheDebounced();
        return preserved;
      }

      // Deterministic no-match: safe to cache in sessionUnmatchedSet
      if (!ignoreBlacklist) {
        if (idKey) sessionUnmatchedSet.add(idKey);
        if (textKey) sessionUnmatchedSet.add(textKey);
      }
      return null;
    } catch {
      transientCooldownUntil = Date.now() + 4000;
      if (existingCached?.stream_url) return existingCached;
      return { stream_url: null, _hifiTransient: true };
    } finally {
      inFlightResolutions.delete(dedupeKey);
    }
  })();

  inFlightResolutions.set(dedupeKey, job);
  return job;
}
