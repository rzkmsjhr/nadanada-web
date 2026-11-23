import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { CHROME_130_UA, fetchWithTimeout } from './http.js';
import { stripLatinDiacritics, parseMultilingualMetadata } from './scriptUtils.js';
import {
  KNOWN_UPSTREAM_MISMATCHES,
  applyDuplicateTitleTrackPenalty,
  buildExcludedEditionDurationMap,
  computeAlbumTitleMinIds,
  isExcludedDurationByCrossProviderOracle,
  parseNumericTrackId,
  scoreTrackCandidate,
} from './hifiMatcher.js';

export { KNOWN_UPSTREAM_MISMATCHES };

const TRACKS_BASE_URL = 'https://tracks.monochrome.st';
const KUWO_SEARCH_URL = 'https://flac.music.hi.cn/ajax.php?act=search';
const KUWO_GET_URL = 'https://flac.music.hi.cn/ajax.php?act=getUrl';
const MIN_VALID_FLAC_BYTES = 250_000;

const HIFI_CACHE_DIR = process.env.HIFI_CACHE_DIR
  ? path.resolve(process.env.HIFI_CACHE_DIR)
  : path.join(os.tmpdir(), 'mysongs_hifi_cache');
const MAX_HIFI_CACHE_BYTES =
  Math.max(100, parseInt(process.env.MAX_HIFI_CACHE_MB || '600', 10) || 600) * 1024 * 1024;
const DIRECT_URL_FILE = path.join(HIFI_CACHE_DIR, 'direct-urls.json');
const DIRECT_URL_TTL_MS = 15 * 60 * 1000;
const RESOLVED_CACHE_MAX = 5000;
const UNMATCHED_CACHE_MAX = 5000;
const UNMATCHED_TTL_MS = 30 * 60 * 1000;

try {
  fs.mkdirSync(HIFI_CACHE_DIR, { recursive: true });
} catch {}

const directUrlCache = new Map();
const failureCooldownMap = new Map();
const rateLimitMap = new Map();
const activeCoordinators = new Map();
const resolvedTrackCache = new Map();
const unmatchedTrackCache = new Map();
const inFlightServerResolves = new Map();

// Monochrome outbound pacing & short escalating cooldown (mirrors Tauri instances.rs)
const monochromePoolState = {
  failCount: 0,
  cooldownUntil: 0,
  nextRequestSlot: 0,
};

async function paceMonochromeRequest() {
  const minSpacingMs = 350;
  const now = Date.now();
  const slot = Math.max(now, monochromePoolState.nextRequestSlot);
  monochromePoolState.nextRequestSlot = slot + minSpacingMs;
  const waitMs = slot - now;
  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

function recordMonochromeSuccess() {
  monochromePoolState.failCount = 0;
  monochromePoolState.cooldownUntil = 0;
}

function recordMonochromeFailure(isRateLimit = false) {
  monochromePoolState.failCount += 1;
  const capped = Math.min(monochromePoolState.failCount, 3);
  const cooldownMs = (isRateLimit ? 3000 : 2000) * capped;
  monochromePoolState.cooldownUntil = Date.now() + cooldownMs;
}

async function waitForMonochromeAvailability() {
  const now = Date.now();
  if (now >= monochromePoolState.cooldownUntil) return true;
  const remaining = monochromePoolState.cooldownUntil - now;
  if (remaining <= 3000) {
    await new Promise((r) => setTimeout(r, remaining));
    return true;
  }
  return false;
}

function setBoundedMapEntry(map, key, val, maxEntries) {
  if (!key) return;
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function getUnmatchedCache(key) {
  if (!key) return false;
  const ts = unmatchedTrackCache.get(key);
  if (!ts) return false;
  if (Date.now() - ts > UNMATCHED_TTL_MS) {
    unmatchedTrackCache.delete(key);
    return false;
  }
  return true;
}

function markUnmatchedCache(key) {
  setBoundedMapEntry(unmatchedTrackCache, key, Date.now(), UNMATCHED_CACHE_MAX);
}

function getResolvedCache(key) {
  if (!key) return null;
  return resolvedTrackCache.get(key) || null;
}

function setResolvedCache(key, info) {
  if (!key) return;
  unmatchedTrackCache.delete(key);
  setBoundedMapEntry(resolvedTrackCache, key, info, RESOLVED_CACHE_MAX);
}

function loadDirectUrlsFromDisk() {
  try {
    if (!fs.existsSync(DIRECT_URL_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DIRECT_URL_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, entry] of Object.entries(raw || {})) {
      if (entry?.url && entry?.ts && now - entry.ts < DIRECT_URL_TTL_MS && !directUrlCache.has(k)) {
        directUrlCache.set(k, entry);
      }
    }
  } catch {}
}

let persistDirectTimer = null;
function schedulePersistDirectUrls() {
  if (persistDirectTimer) return;
  persistDirectTimer = setTimeout(() => {
    persistDirectTimer = null;
    try {
      const now = Date.now();
      const obj = {};
      for (const [k, entry] of directUrlCache.entries()) {
        if (entry?.url && now - entry.ts < DIRECT_URL_TTL_MS) obj[k] = entry;
      }
      const tmp = `${DIRECT_URL_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, DIRECT_URL_FILE);
    } catch {}
  }, 400);
}

function setDirectUrl(trackId, url) {
  directUrlCache.set(trackId, { url, ts: Date.now() });
  schedulePersistDirectUrls();
}

function pruneHifiCache(protectedFilePath) {
  try {
    const entries = fs.readdirSync(HIFI_CACHE_DIR);
    let totalBytes = 0;
    const files = [];
    for (const name of entries) {
      if (!name.endsWith('.flac')) continue;
      const fullPath = path.join(HIFI_CACHE_DIR, name);
      try {
        const st = fs.statSync(fullPath);
        totalBytes += st.size;
        files.push({ fullPath, size: st.size, mtimeMs: st.mtimeMs });
      } catch {}
    }
    if (totalBytes <= MAX_HIFI_CACHE_BYTES) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of files) {
      if (totalBytes <= MAX_HIFI_CACHE_BYTES) break;
      if (f.fullPath === protectedFilePath) continue;
      try {
        fs.unlinkSync(f.fullPath);
        totalBytes -= f.size;
      } catch {}
    }
  } catch {}
}

loadDirectUrlsFromDisk();

const PUBLIC_OCTETS = [
  1, 8, 12, 14, 15, 23, 24, 27, 31, 36, 37, 39, 41, 42, 43, 45, 46, 47, 49, 50,
  52, 54, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 71, 72, 73, 74, 75, 76,
  80, 81, 82, 83, 84, 85, 86, 87, 88, 91, 93, 94, 95,
];

const EPHEMERAL_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/130.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
];

let ephemeralCounter = 0;

function makeEphemeralHeaders() {
  ephemeralCounter++;
  const seed = (Date.now() * 2654435761 + ephemeralCounter * 12345) >>> 0;
  const a = PUBLIC_OCTETS[seed % PUBLIC_OCTETS.length];
  const b = (seed >>> 8) & 0xff;
  const c = (seed >>> 16) & 0xff;
  const d = ((seed >>> 24) % 253) + 1;
  const ip = `${a}.${b}.${c}.${d}`;
  return {
    'User-Agent': EPHEMERAL_UAS[ephemeralCounter % EPHEMERAL_UAS.length],
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    Referer: 'https://flac.music.hi.cn/',
    Origin: 'https://flac.music.hi.cn',
    'X-Forwarded-For': ip,
    'X-Real-IP': ip,
    'Client-IP': ip,
    'True-Client-IP': ip,
  };
}

const VIDEO_KEYWORDS = [
  'official music video', 'official video', 'music video', 'official audio video',
  'lyric video', 'lyrics video', 'visualizer', 'official visualizer',
  'performance video', 'live performance', 'dance practice', 'full concert',
  '[mv]', '(mv)', '[m/v]', '(m/v)',
];

function formatDurationMs(ms = 0) {
  const total = Math.floor(ms / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function parseDurationToSecs(dur) {
  if (!dur) return 0;
  if (typeof dur === 'number') return dur > 1000 ? Math.round(dur / 1000) : Math.round(dur);
  const parts = String(dur).split(':').map((n) => parseInt(n, 10) || 0);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Number(dur) || 0;
}

export function isEligibleTrack(title = '', channel = '', itemType = '') {
  const lt = String(title).toLowerCase();
  const lc = String(channel || '').toLowerCase();
  const li = String(itemType || '').toLowerCase();
  if (li === 'video') return false;
  if (lc.includes('vevo')) return false;
  if (VIDEO_KEYWORDS.some((k) => lt.includes(k))) return false;
  if (/\b(mv|m\/v)\b/i.test(lt)) return false;
  return true;
}

export function isValidKuwoFlacUrl(rawUrl = '') {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const lower = rawUrl.toLowerCase();
  if (lower.includes('/lx/resource/') || lower.includes('2044590383')) return false;
  const pathPart = lower.split('?')[0];
  if (/\.(mp3|aac|m4a|ogg)$/.test(pathPart)) return false;
  return true;
}

export function hasFlacMagicPrefix(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return true; // fLaC
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33 && buf.length >= 10) {
    // ID3 tag header: compute syncsafe length
    const tagSize =
      ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    if (buf.length >= 14 + tagSize) {
      const p = 10 + tagSize;
      return buf[p] === 0x66 && buf[p + 1] === 0x4c && buf[p + 2] === 0x61 && buf[p + 3] === 0x43;
    }
    return true; // streamed prefix starts with ID3
  }
  return false;
}

function getCacheFilePath(trackId) {
  const safeId = String(trackId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(HIFI_CACHE_DIR, `${safeId}.flac`);
}

function isValidCachedFlacFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MIN_VALID_FLAC_BYTES) return false;
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    return hasFlacMagicPrefix(head);
  } catch {
    return false;
  }
}

export async function searchMonochrome(query, searchType = 'song') {
  const clean = (query || '').trim();
  if (!clean) return [];
  const headers = { 'User-Agent': CHROME_130_UA, Accept: 'application/json' };

  if (searchType === 'album') {
    const res = await fetchWithTimeout(
      `${TRACKS_BASE_URL}/search/releases?q=${encodeURIComponent(clean)}&limit=25`,
      { headers },
      5000
    );
    if (!res.ok) throw new Error(`Monochrome releases HTTP ${res.status}`);
    const data = await res.json();
    return (data.releases || [])
      .map((r) => {
        const id = r.releaseId || r.id;
        if (!id) return null;
        const ch =
          r.artistNames?.filter(Boolean).join(', ') ||
          r.artists?.map((a) => a.name || a.displayName).filter(Boolean).join(', ') ||
          'Unknown Artist';
        return {
          id,
          title: r.title || 'Unknown Album',
          thumbnail: r.artwork || '',
          duration: '',
          channel: ch,
          is_playlist: true,
          track_count: r.trackCount ? String(r.trackCount) : null,
          first_video_id: null,
          item_type: 'album',
          stream_url: null,
          source: 'monochrome',
          album: null,
        };
      })
      .filter(Boolean);
  }

  const res = await fetchWithTimeout(
    `${TRACKS_BASE_URL}/search/tracks?q=${encodeURIComponent(clean)}&limit=25`,
    { headers },
    5000
  );
  if (!res.ok) throw new Error(`Monochrome tracks HTTP ${res.status}`);
  const data = await res.json();
  return (data.tracks || [])
    .map((t) => {
      const id = t.trackId || t.id;
      if (!id) return null;
      const ch =
        t.artistNames?.filter(Boolean).join(', ') ||
        t.artists?.map((a) => a.name || a.displayName).filter(Boolean).join(', ') ||
        'Unknown Artist';
      const streamTarget = id;
      return {
        id,
        title: t.title || 'Unknown Title',
        thumbnail: t.artwork || t.cover || '',
        duration: t.duration ? formatDurationMs(t.duration) : '',
        channel: ch,
        is_playlist: false,
        track_count: null,
        first_video_id: null,
        item_type: 'song',
        stream_url: `/hifi/stream?id=${encodeURIComponent(streamTarget)}`,
        hifi_id: streamTarget,
        source: 'monochrome',
        album: null,
      };
    })
    .filter(Boolean);
}

export async function getMonochromeAlbum(releaseId) {
  const clean = (releaseId || '').trim();
  if (!clean) throw new Error('Invalid release ID');
  const res = await fetchWithTimeout(
    `${TRACKS_BASE_URL}/releases/${encodeURIComponent(clean)}`,
    { headers: { 'User-Agent': CHROME_130_UA, Accept: 'application/json' } },
    12000
  );
  if (!res.ok) throw new Error(`Monochrome release HTTP ${res.status}`);
  const r = await res.json();
  const albumCh =
    r.artistNames?.filter(Boolean).join(', ') ||
    r.artists?.map((a) => a.name || a.displayName).filter(Boolean).join(', ') ||
    'Unknown Artist';

  return (r.tracks || [])
    .map((t) => {
      const id = t.trackId || t.id;
      if (!id) return null;
      const ch =
        t.artistNames?.filter(Boolean).join(', ') ||
        t.artists?.map((a) => a.name || a.displayName).filter(Boolean).join(', ') ||
        albumCh;
      const streamTarget = id;
      return {
        id,
        title: t.title || 'Unknown Title',
        thumbnail: t.artwork || t.cover || r.artwork || '',
        duration: t.duration ? formatDurationMs(t.duration) : '',
        channel: ch,
        is_playlist: false,
        item_type: 'song',
        stream_url: `/hifi/stream?id=${encodeURIComponent(streamTarget)}`,
        hifi_id: streamTarget,
        source: 'monochrome',
        album: r.title || null,
      };
    })
    .filter(Boolean);
}

function hasPlayableBacking(trackId) {
  if (!trackId) return false;
  const cachedPath = getCacheFilePath(trackId);
  if (fs.existsSync(cachedPath) && isValidCachedFlacFile(cachedPath)) return true;
  if (activeCoordinators.has(trackId)) return true;
  if (!trackId.startsWith('kuwo_') && !trackId.startsWith('wyy_')) return true;
  let entry = directUrlCache.get(trackId);
  if (!entry || Date.now() - entry.ts >= DIRECT_URL_TTL_MS) {
    loadDirectUrlsFromDisk();
    entry = directUrlCache.get(trackId);
  }
  return Boolean(entry && Date.now() - entry.ts < DIRECT_URL_TTL_MS && isValidKuwoFlacUrl(entry.url));
}

async function searchHiCnPlatform(platform, query, size = 12) {
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      await new Promise((r) => setTimeout(r, 500 * (attempt - 1)));
    }
    try {
      const body = new URLSearchParams({
        platform,
        keyword: query,
        page: '1',
        size: String(size),
      });
      const res = await fetchWithTimeout(
        KUWO_SEARCH_URL,
        { method: 'POST', headers: makeEphemeralHeaders(), body },
        6000
      );
      if (!res.ok) {
        lastErr = `HTTP ${res.status} from ${platform} search`;
        if (res.status === 429 || res.status >= 500) continue;
        return { ok: false, list: [], error: lastErr };
      }
      const data = await res.json();
      if (data?.code !== 0) {
        lastErr = `${platform} search error code ${data?.code}: ${data?.msg || ''}`;
        continue;
      }
      return { ok: true, list: data?.data?.list || [], error: null };
    } catch (err) {
      lastErr = err?.message || `Network error querying ${platform} search`;
    }
  }
  return { ok: false, list: [], error: lastErr || `${platform} search failed` };
}

async function getHiCnFlacUrl(platform, candidate, expectedDurSecs = 0) {
  const flacInfo = (candidate.minfo || [])
    .filter((m) => String(m.format || '').toLowerCase() === 'flac')
    .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];
  if (!flacInfo) return { ok: false, url: null, transient: false, reason: 'No FLAC format in catalog' };

  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      await new Promise((r) => setTimeout(r, 400 * (attempt - 1) + ((attempt * 47) % 150)));
    }
    try {
      const body = new URLSearchParams({
        platform,
        songid: String(candidate.id),
        format: String(flacInfo.format || 'flac').trim() || 'flac',
        bitrate: String(flacInfo.bitrate || 2000),
        time: String(candidate.time ?? ''),
        sign: String(candidate.sign || ''),
      });
      const res = await fetchWithTimeout(
        KUWO_GET_URL,
        { method: 'POST', headers: makeEphemeralHeaders(), body },
        6000
      );
      if (!res.ok) {
        lastErr = `HTTP ${res.status} from ${platform} getUrl`;
        if (res.status === 429 || res.status >= 500) continue;
        return { ok: false, url: null, transient: true, reason: lastErr };
      }

      const data = await res.json();
      if (data?.code === -3) {
        return { ok: false, url: null, transient: false, reason: `${platform} getUrl error -3` };
      }
      if (data?.code !== 0) {
        lastErr = `${platform} getUrl code ${data?.code}: ${data?.msg || ''}`;
        continue;
      }

      const d = data?.data;
      const url = String(d?.url || '').trim();
      if (!url) {
        lastErr = `Empty stream URL in ${platform} getUrl response`;
        continue;
      }

      const retFmt = String(d?.format || '').trim().toLowerCase();
      const retBr = Number(d?.bitrate) || 0;
      const retDur = Number(d?.duration) || 0;

      // Throttled/substituted clip check -> retry with fresh ephemeral identity
      const durMismatch =
        expectedDurSecs > 30 &&
        retDur > 0 &&
        (retDur < expectedDurSecs / 2 || Math.abs(expectedDurSecs - retDur) > 20);
      const isThrottled = durMismatch || (d?.bitrate !== undefined && retBr <= 1) || url.toLowerCase().includes('/lx/resource/');
      if (isThrottled) {
        lastErr = `${platform} returned throttled/substituted clip (fmt=${retFmt}, br=${retBr}, dur=${retDur}s)`;
        continue;
      }

      // Deterministic lossy downgrade check (do NOT treat as transient error)
      if ((retFmt && retFmt !== 'flac') || (retBr > 0 && retBr < 500) || !isValidKuwoFlacUrl(url)) {
        return {
          ok: false,
          url: null,
          transient: false,
          reason: `${platform} downgraded track to lossy/invalid audio (fmt=${retFmt}, br=${retBr})`,
        };
      }

      return { ok: true, url, transient: false, reason: null };
    } catch (err) {
      lastErr = err?.message || `Network error querying ${platform} getUrl`;
    }
  }
  return { ok: false, url: null, transient: true, reason: lastErr || `${platform} getUrl failed` };
}

/**
 * Lightweight Range byte-header probe for background queue resolution (mode: 'probe').
 * Verifies real fLaC magic bytes, non-MP3 content-type, and >= 250KB file size
 * WITHOUT downloading the full 30-50 MB FLAC file into Altare RAM/disk.
 */
async function probeUpstreamFlacStream(trackId, directUrl = null) {
  const cachedPath = getCacheFilePath(trackId);
  if (fs.existsSync(cachedPath) && isValidCachedFlacFile(cachedPath)) {
    return { ok: true, isCached: true, transient: false };
  }
  if (activeCoordinators.has(trackId)) {
    return { ok: true, isCached: false, transient: false };
  }

  const isMonochrome = !directUrl && !trackId.startsWith('kuwo_') && !trackId.startsWith('wyy_');
  const url = directUrl || `${TRACKS_BASE_URL}/track/${encodeURIComponent(trackId)}`;
  if (directUrl && !isValidKuwoFlacUrl(directUrl)) {
    return { ok: false, isCached: false, transient: false };
  }

  if (isMonochrome) {
    const avail = await waitForMonochromeAvailability();
    if (!avail) return { ok: false, isCached: false, transient: true };
    await paceMonochromeRequest();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7500);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': CHROME_130_UA,
        Accept: '*/*',
        Range: 'bytes=0-127',
      },
      signal: controller.signal,
    });

    if (res.status === 404 || res.status === 410) {
      try { await res.body?.cancel(); } catch {}
      return { ok: false, isCached: false, transient: false };
    }
    if (res.status === 429 || res.status >= 500) {
      try { await res.body?.cancel(); } catch {}
      if (isMonochrome) recordMonochromeFailure(res.status === 429);
      return { ok: false, isCached: false, transient: true };
    }
    if (res.status !== 200 && res.status !== 206) {
      try { await res.body?.cancel(); } catch {}
      return { ok: false, isCached: false, transient: true };
    }

    // Reject HTML/JSON error pages early; do NOT reject audio/mpeg header because NetEase/WYY CDNs
    // (music.126.net) serve real 48 MB fLaC files with Content-Type: audio/mpeg. Byte magic check verifies real FLAC.
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html') || ct.includes('application/json')) {
      try { await res.body?.cancel(); } catch {}
      return { ok: false, isCached: false, transient: false };
    }

    const contentRange = String(res.headers.get('content-range') || '');
    const rangeTotalMatch = /\/(\d+)$/.exec(contentRange);
    const totalBytes = rangeTotalMatch
      ? parseInt(rangeTotalMatch[1], 10)
      : res.status === 200
      ? parseInt(res.headers.get('content-length') || '0', 10)
      : 0;
    if (Number.isFinite(totalBytes) && totalBytes > 0 && totalBytes < MIN_VALID_FLAC_BYTES) {
      try { await res.body?.cancel(); } catch {}
      return { ok: false, isCached: false, transient: false };
    }

    if (!res.body) {
      return { ok: false, isCached: false, transient: true };
    }

    const reader = res.body.getReader();
    const chunks = [];
    let collected = 0;
    try {
      while (collected < 16) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        chunks.push(buf);
        collected += buf.length;
      }
    } finally {
      try { await reader.cancel(); } catch {}
      controller.abort();
    }

    if (collected < 4) {
      return { ok: false, isCached: false, transient: true };
    }
    const head = Buffer.concat(chunks, Math.min(collected, 64));
    if (!hasFlacMagicPrefix(head)) {
      return { ok: false, isCached: false, transient: false };
    }

    if (directUrl) setDirectUrl(trackId, directUrl);
    if (isMonochrome) recordMonochromeSuccess();
    return { ok: true, isCached: false, transient: false };
  } catch {
    if (isMonochrome) recordMonochromeFailure(false);
    return { ok: false, isCached: false, transient: true };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMonochromeRaw(query) {
  const avail = await waitForMonochromeAvailability();
  if (!avail) return { ok: false, data: null, error: 'Monochrome in cooldown' };
  await paceMonochromeRequest();
  try {
    const res = await fetchWithTimeout(
      `${TRACKS_BASE_URL}/search?q=${encodeURIComponent(query)}&limit=12`,
      { headers: { 'User-Agent': CHROME_130_UA, Accept: 'application/json' } },
      5000
    );
    if (res.status === 429) {
      recordMonochromeFailure(true);
      return { ok: false, data: null, error: 'Monochrome HTTP 429' };
    }
    if (!res.ok) {
      recordMonochromeFailure(false);
      return { ok: false, data: null, error: `Monochrome HTTP ${res.status}` };
    }
    const data = await res.json();
    recordMonochromeSuccess();
    return { ok: true, data, error: null };
  } catch (err) {
    recordMonochromeFailure(false);
    return { ok: false, data: null, error: err?.message || 'Monochrome search error' };
  }
}

function buildSearchQueries(cleanTitle, channelStr, targetAlbum, meta) {
  const queries = [];
  const pushUnique = (q) => {
    const trimmed = String(q || '').replace(/\s+/g, ' ').trim();
    if (trimmed && !queries.includes(trimmed)) queries.push(trimmed);
  };

  // 1. Prioritize album query first when album is known (finds official album master immediately)
  if (targetAlbum) {
    const albClean = String(targetAlbum).trim();
    if (albClean) {
      pushUnique(`${channelStr} ${cleanTitle} ${albClean}`);
      const deCh = stripLatinDiacritics(channelStr);
      const deTi = stripLatinDiacritics(cleanTitle);
      const deAl = stripLatinDiacritics(albClean);
      if (deCh !== channelStr || deTi !== cleanTitle || deAl !== albClean) {
        pushUnique(`${deCh} ${deTi} ${deAl}`);
      }
    }
  }

  // 2. Base artist + title (+ de-accented variant)
  const baseQuery = `${channelStr} ${cleanTitle}`.replace(/\s+/g, ' ').trim();
  const deBase = `${stripLatinDiacritics(channelStr)} ${stripLatinDiacritics(cleanTitle)}`
    .replace(/\s+/g, ' ')
    .trim();
  if (deBase && deBase !== baseQuery) pushUnique(deBase);
  pushUnique(baseQuery);

  // 3. Multilingual / script / alias / Romaji queries
  for (const q of meta.searchQueries || []) {
    pushUnique(q);
  }
  return queries;
}

export async function resolveHifiTrack({
  songId = null,
  title = '',
  channel = null,
  duration = null,
  itemType = null,
  isrc = null,
  album = null,
  mode = 'play',
  forceRefresh = false,
}) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) {
    return { matched: false, transient: false, reason: 'Empty title' };
  }

  const channelStr = String(channel || '').trim();
  const targetAlbum = album && String(album).trim() ? String(album).trim() : null;
  const resolveMode = mode === 'probe' ? 'probe' : 'play';

  if (!isEligibleTrack(cleanTitle, channelStr, itemType)) {
    return { matched: false, transient: false, reason: 'Track ineligible for Hi-Fi audio' };
  }
  if (songId && KNOWN_UPSTREAM_MISMATCHES.has(String(songId))) {
    return { matched: false, transient: false, reason: 'Known mismatch override' };
  }

  const idKey = songId ? String(songId).trim() : '';
  const textKey = `${channelStr.toLowerCase()}:::${cleanTitle.toLowerCase()}`;
  const dedupeKey = `${idKey || textKey}|${(targetAlbum || '').toLowerCase()}|${resolveMode}|${forceRefresh ? '1' : '0'}`;

  if (inFlightServerResolves.has(dedupeKey)) {
    return inFlightServerResolves.get(dedupeKey);
  }

  const job = (async () => {
    const targetDur = parseDurationToSecs(duration);

    // 1. Check server-side positive & negative resolution caches
    let fallbackCached = null;
    if (!forceRefresh) {
      for (const cacheKey of [idKey, textKey].filter(Boolean)) {
        if (getUnmatchedCache(cacheKey)) {
          return { matched: false, transient: false, reason: 'Cached unmatched track' };
        }
        const cached = getResolvedCache(cacheKey);
        if (cached && hasPlayableBacking(cached.hifi_id)) {
          const needsAlbumUpgrade = !cached.resolvedWithAlbum && Boolean(targetAlbum);
          if (!needsAlbumUpgrade) {
            const isCachedOnDisk = isValidCachedFlacFile(getCacheFilePath(cached.hifi_id));
            if (resolveMode === 'play' && !isCachedOnDisk && !activeCoordinators.has(cached.hifi_id)) {
              startProgressiveDownload(cached.hifi_id);
            }
            return {
              matched: true,
              transient: false,
              hifi_id: cached.hifi_id,
              stream_url: `/hifi/stream?id=${encodeURIComponent(cached.hifi_id)}`,
              title: cached.title,
              artist: cached.artist,
              album: targetAlbum || null,
              duration: cached.duration,
              source: cached.source,
              match_score: cached.matchScore,
              is_cached: isCachedOnDisk,
              resolved_with_album: cached.resolvedWithAlbum,
            };
          }
          if (!fallbackCached) fallbackCached = cached;
        }
      }
    }

    const meta = parseMultilingualMetadata(cleanTitle, channelStr);
    const channelClean = channelStr.replace(/\s*-\s*Topic$/i, '').replace(/\bTopic\b/gi, '').trim();
    const targetArtist = channelClean || meta.extractedArtist || '';
    const queries = buildSearchQueries(cleanTitle, channelClean, targetAlbum, meta);

    let anyProviderSucceeded = false;
    let hadTransientError = false;

    const tryVerifyCandidate = async (cand, directUrl, source, score) => {
      if (resolveMode === 'probe') {
        const probed = await probeUpstreamFlacStream(cand.id, directUrl);
        if (!probed.ok) {
          if (probed.transient) hadTransientError = true;
          return null;
        }
        return {
          matched: true,
          transient: false,
          hifi_id: cand.id,
          stream_url: `/hifi/stream?id=${encodeURIComponent(cand.id)}`,
          title: cand.title,
          artist: cand.artist,
          album: targetAlbum || null,
          duration: cand.duration || targetDur,
          source,
          match_score: score,
          is_cached: probed.isCached,
          resolved_with_album: Boolean(targetAlbum),
        };
      }

      // mode === 'play': warm progressive download coordinator and verify real fLaC bytes
      if (directUrl) setDirectUrl(cand.id, directUrl);
      const isCachedOnDisk = isValidCachedFlacFile(getCacheFilePath(cand.id));
      const coord = startProgressiveDownload(cand.id);
      if (coord) {
        try {
          await waitForCoordinatorBytes(coord, 16, 7500);
        } catch {
          hadTransientError = true;
          return null;
        }
      }
      return {
        matched: true,
        transient: false,
        hifi_id: cand.id,
        stream_url: `/hifi/stream?id=${encodeURIComponent(cand.id)}`,
        title: cand.title,
        artist: cand.artist,
        album: targetAlbum || null,
        duration: cand.duration || targetDur,
        source,
        match_score: score,
        is_cached: isCachedOnDisk,
        resolved_with_album: Boolean(targetAlbum),
      };
    };

    const cacheMatchResult = (result) => {
      const entry = {
        hifi_id: result.hifi_id,
        title: result.title,
        artist: result.artist,
        album: result.album,
        duration: result.duration,
        source: result.source,
        matchScore: result.match_score,
        resolvedWithAlbum: Boolean(result.resolved_with_album),
        ts: Date.now(),
      };
      if (idKey) setResolvedCache(idKey, entry);
      setResolvedCache(textKey, entry);
      return result;
    };

    const collectHiCnRawBatch = (list, rawList, seenIds) => {
      for (const raw of list) {
        const hasFlac = (raw.minfo || []).some((m) => String(m.format || '').toLowerCase() === 'flac');
        if (!hasFlac) continue;
        const rawId = String(raw.id ?? '').trim();
        if (!rawId || seenIds.has(rawId)) continue;
        seenIds.add(rawId);
        rawList.push(raw);
      }
    };

    const evaluateHiCnCandidates = (platform, rawList, referenceList) => {
      const albumTitleGroups = computeAlbumTitleMinIds(rawList);
      const excludedOracle = buildExcludedEditionDurationMap(
        referenceList,
        cleanTitle,
        targetArtist,
        targetAlbum
      );
      const qualified = [];
      let bestScore = 0;

      for (const raw of rawList) {
        const rawId = String(raw.id ?? '').trim();
        const cand = {
          id: `${platform}_${rawId}`,
          rawId,
          raw,
          title: raw.name || '',
          artist: raw.artist || '',
          album: raw.album_name || '',
          duration: Number(raw.duration) || 0,
        };

        if (isExcludedDurationByCrossProviderOracle(cand.title, cand.album, cand.duration, excludedOracle)) {
          continue;
        }

        let sc = scoreTrackCandidate({
          targetTitle: cleanTitle,
          targetArtist,
          targetDurSecs: targetDur,
          targetIsrc: isrc,
          targetAlbum,
          candId: cand.id,
          candTitle: cand.title,
          candArtist: cand.artist,
          candDurSecs: cand.duration,
          candIsrc: null,
          candAlbum: cand.album || null,
          parsedMeta: meta,
        });
        if (sc === 0) continue;

        // Track-2 Minus-One / ambiguous multi-cut deluxe penalty
        sc = applyDuplicateTitleTrackPenalty(sc, cand.title, cand.album, rawId, albumTitleGroups, cand.duration);
        if (sc >= 140) {
          if (sc > bestScore) bestScore = sc;
          qualified.push({ cand, score: sc });
        }
      }
      return { qualified, bestScore };
    };

    const durDistanceFromTarget = (cand) => {
      if (targetDur <= 0) return 0;
      return cand.duration > 0 ? Math.abs(cand.duration - targetDur) : Number.MAX_SAFE_INTEGER;
    };

    const tryQualifiedHiCnPlatform = async (platform, qualified) => {
      if (qualified.length === 0) return null;
      qualified.sort(
        (a, b) =>
          b.score - a.score ||
          durDistanceFromTarget(a.cand) - durDistanceFromTarget(b.cand) ||
          parseNumericTrackId(a.cand.rawId) - parseNumericTrackId(b.cand.rawId)
      );

      for (const { cand, score } of qualified.slice(0, 4)) {
        const urlRes = await getHiCnFlacUrl(platform, cand.raw, cand.duration || targetDur);
        if (!urlRes.ok) {
          if (urlRes.transient) hadTransientError = true;
          continue;
        }
        const verified = await tryVerifyCandidate(cand, urlRes.url, platform, score);
        if (verified) return cacheMatchResult(verified);
      }
      return null;
    };

    const earlyExitThreshold = targetAlbum ? 220 : 170;
    const passQueries = queries.slice(0, 4);

    // 2. Primary Providers: Kuwo + WYY via flac.music.hi.cn (Pass 1 in parallel, Passes 2..4 up to early-exit threshold)
    const kuwoSeen = new Set();
    const wyySeen = new Set();
    const kuwoRawList = [];
    const wyyRawList = [];

    if (passQueries.length > 0) {
      const [kuwoPass1, wyyPass1] = await Promise.all([
        searchHiCnPlatform('kuwo', passQueries[0], 12),
        searchHiCnPlatform('wyy', passQueries[0], 12),
      ]);
      if (kuwoPass1.ok) {
        anyProviderSucceeded = true;
        collectHiCnRawBatch(kuwoPass1.list, kuwoRawList, kuwoSeen);
      }
      if (wyyPass1.ok) {
        anyProviderSucceeded = true;
        collectHiCnRawBatch(wyyPass1.list, wyyRawList, wyySeen);
      }

      let kuwoEval = evaluateHiCnCandidates('kuwo', kuwoRawList, wyyRawList);

      // Finish remaining Kuwo passes (2..4) unless Pass 1 already cleared early-exit threshold
      for (const q of passQueries.slice(1)) {
        if (kuwoEval.bestScore >= earlyExitThreshold) break;
        const res = await searchHiCnPlatform('kuwo', q, 12);
        if (res.ok) {
          anyProviderSucceeded = true;
          collectHiCnRawBatch(res.list, kuwoRawList, kuwoSeen);
          kuwoEval = evaluateHiCnCandidates('kuwo', kuwoRawList, wyyRawList);
        }
      }

      const kuwoWinner = await tryQualifiedHiCnPlatform('kuwo', kuwoEval.qualified);
      if (kuwoWinner) return kuwoWinner;

      let wyyEval = evaluateHiCnCandidates('wyy', wyyRawList, kuwoRawList);

      // Finish remaining WYY passes (2..4) unless Pass 1 already cleared early-exit threshold
      for (const q of passQueries.slice(1)) {
        if (wyyEval.bestScore >= earlyExitThreshold) break;
        const res = await searchHiCnPlatform('wyy', q, 12);
        if (res.ok) {
          anyProviderSucceeded = true;
          collectHiCnRawBatch(res.list, wyyRawList, wyySeen);
          wyyEval = evaluateHiCnCandidates('wyy', wyyRawList, kuwoRawList);
        }
      }

      const wyyWinner = await tryQualifiedHiCnPlatform('wyy', wyyEval.qualified);
      if (wyyWinner) return wyyWinner;
    }

    // 3. Fallback Provider: Monochrome (up to 3 query passes, early exit >= 170)
    const monoQueries = [];
    const pushMono = (q) => {
      const trimmed = String(q || '').replace(/\s+/g, ' ').trim();
      if (trimmed && !monoQueries.includes(trimmed)) monoQueries.push(trimmed);
    };
    pushMono(`${channelClean} ${cleanTitle}`);
    pushMono(`${stripLatinDiacritics(channelClean)} ${stripLatinDiacritics(cleanTitle)}`);
    for (const q of queries) pushMono(q);

    const monoSeen = new Set();
    const monoQualified = [];
    let monoBestScore = 0;

    for (const mq of monoQueries.slice(0, 3)) {
      const monoRes = await fetchMonochromeRaw(mq);
      if (!monoRes.ok || !monoRes.data) continue;
      anyProviderSucceeded = true;

      const tracks = monoRes.data.tracks || [];
      const releaseMap = new Map((monoRes.data.releases || []).map((r) => [r.releaseId || r.id, r.title]));
      for (const t of tracks) {
        // Match Tauri instances.rs: tracks.monochrome.st/track/:id expects trackId (not recordingId)
        const trackId = String(t.trackId || t.id || '').trim();
        const streamTarget = trackId;
        if (!streamTarget || monoSeen.has(streamTarget)) continue;

        const artistStr =
          t.artistNames?.filter(Boolean).join(', ') ||
          t.artists?.map((a) => a.name || a.displayName).filter(Boolean).join(', ') ||
          '';
        const cand = {
          id: streamTarget,
          rawId: trackId || streamTarget,
          title: t.title || '',
          artist: artistStr,
          album: t.album_title || releaseMap.get(t.releaseId) || '',
          duration: t.duration ? parseDurationToSecs(t.duration) : 0,
          isrc: t.isrc || null,
        };

        const sc = scoreTrackCandidate({
          targetTitle: cleanTitle,
          targetArtist,
          targetDurSecs: targetDur,
          targetIsrc: isrc,
          targetAlbum,
          candId: cand.rawId,
          candTitle: cand.title,
          candArtist: cand.artist,
          candDurSecs: cand.duration,
          candIsrc: cand.isrc,
          candAlbum: cand.album || null,
          parsedMeta: meta,
        });

        if (sc >= 140) {
          monoSeen.add(streamTarget);
          if (sc > monoBestScore) monoBestScore = sc;
          monoQualified.push({ cand, score: sc });
        }
      }
      if (monoBestScore >= 170) break;
    }

    if (monoQualified.length > 0) {
      monoQualified.sort(
        (a, b) => b.score - a.score || parseNumericTrackId(a.cand.rawId) - parseNumericTrackId(b.cand.rawId)
      );
      for (const { cand, score } of monoQualified.slice(0, 2)) {
        const verified = await tryVerifyCandidate(cand, null, 'monochrome', score);
        if (verified) return cacheMatchResult(verified);
      }
    }

    // 4. Preserve prior valid cached match if an album-upgrade re-query found no better candidate
    if (fallbackCached && hasPlayableBacking(fallbackCached.hifi_id)) {
      const isCachedOnDisk = isValidCachedFlacFile(getCacheFilePath(fallbackCached.hifi_id));
      return {
        matched: true,
        transient: false,
        hifi_id: fallbackCached.hifi_id,
        stream_url: `/hifi/stream?id=${encodeURIComponent(fallbackCached.hifi_id)}`,
        title: fallbackCached.title,
        artist: fallbackCached.artist,
        album: targetAlbum || null,
        duration: fallbackCached.duration,
        source: fallbackCached.source,
        match_score: fallbackCached.matchScore,
        is_cached: isCachedOnDisk,
        resolved_with_album: true,
      };
    }

    // 5. Only cache deterministic no-match when at least one search succeeded and no transient errors happened
    if (anyProviderSucceeded && !hadTransientError) {
      if (idKey) markUnmatchedCache(idKey);
      markUnmatchedCache(textKey);
      return { matched: false, transient: false, reason: 'No matching Hi-Fi FLAC track found' };
    }

    return {
      matched: false,
      transient: true,
      reason: `Transient Hi-Fi lookup failure (upstream_ok=${anyProviderSucceeded}, transient_error=${hadTransientError})`,
    };
  })();

  inFlightServerResolves.set(dedupeKey, job);
  try {
    return await job;
  } finally {
    inFlightServerResolves.delete(dedupeKey);
  }
}

function getUpstreamUrl(trackId) {
  let entry = directUrlCache.get(trackId);
  if (!entry || Date.now() - entry.ts >= DIRECT_URL_TTL_MS) {
    loadDirectUrlsFromDisk();
    entry = directUrlCache.get(trackId);
  }
  let upstreamUrl = entry && Date.now() - entry.ts < DIRECT_URL_TTL_MS ? entry.url : null;
  if (!upstreamUrl) {
    if (trackId.startsWith('kuwo_') || trackId.startsWith('wyy_')) {
      throw Object.assign(new Error('Expired CDN link for cached track; re-resolve required'), {
        statusCode: 503,
      });
    }
    upstreamUrl = `${TRACKS_BASE_URL}/track/${encodeURIComponent(trackId)}`;
  } else if (!isValidKuwoFlacUrl(upstreamUrl)) {
    directUrlCache.delete(trackId);
    throw Object.assign(new Error('Invalid non-FLAC upstream URL rejected'), { statusCode: 503 });
  }
  return upstreamUrl;
}

function startProgressiveDownload(trackId) {
  const cachedPath = getCacheFilePath(trackId);
  if (fs.existsSync(cachedPath) && isValidCachedFlacFile(cachedPath)) {
    return null;
  }
  if (activeCoordinators.has(trackId)) {
    return activeCoordinators.get(trackId);
  }

  let upstreamUrl;
  try {
    upstreamUrl = getUpstreamUrl(trackId);
  } catch (err) {
    return null;
  }

  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  const coord = {
    trackId,
    chunks: [],
    downloadedBytes: 0,
    totalLen: 0,
    isDone: false,
    isFailed: false,
    statusCode: 503,
    errorMsg: null,
    filePath: null,
    emitter,
    promise: null,
  };

  activeCoordinators.set(trackId, coord);

  coord.promise = (async () => {
    const controller = new AbortController();
    const overallTimer = setTimeout(() => controller.abort(), 120_000);
    let connectTimer = setTimeout(() => controller.abort(), 15_000);

    try {
      let res = null;
      let lastErr = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          res = await fetch(upstreamUrl, {
            headers: { 'User-Agent': CHROME_130_UA, Accept: '*/*' },
            signal: controller.signal,
          });
          clearTimeout(connectTimer);
          connectTimer = null;
          if (res.ok) break;
          if (res.status === 429 || res.status >= 500) {
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, 450));
              connectTimer = setTimeout(() => controller.abort(), 15_000);
              continue;
            }
          }
          break;
        } catch (err) {
          lastErr = err;
          clearTimeout(connectTimer);
          connectTimer = null;
          if (attempt < 2 && !controller.signal.aborted) {
            await new Promise((r) => setTimeout(r, 350));
            connectTimer = setTimeout(() => controller.abort(), 15_000);
            continue;
          }
        }
      }

      if (!res) {
        failureCooldownMap.set(trackId, Date.now() + 5_000);
        throw Object.assign(lastErr || new Error('Upstream connection failed'), { statusCode: 503 });
      }
      if (!res.ok) {
        const msg = `HTTP ${res.status}`;
        failureCooldownMap.set(trackId, Date.now() + (res.status === 429 ? 120_000 : 5_000));
        if (res.status === 403 || res.status === 410) directUrlCache.delete(trackId);
        throw Object.assign(new Error(msg), { statusCode: 503 });
      }

      // Reject HTML/JSON error pages early; do NOT reject audio/mpeg header because NetEase/WYY CDNs
      // serve real fLaC files with Content-Type: audio/mpeg. Byte magic check below verifies real fLaC bytes.
      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html') || ct.includes('application/json')) {
        directUrlCache.delete(trackId);
        throw Object.assign(new Error(`Invalid upstream content-type: ${ct}`), { statusCode: 503 });
      }

      const contentLen = parseInt(res.headers.get('content-length') || '0', 10);
      if (Number.isFinite(contentLen) && contentLen > 0) {
        coord.totalLen = contentLen;
      }

      if (!res.body) {
        const arrBuf = await res.arrayBuffer();
        const buf = Buffer.from(arrBuf);
        if (buf.length < MIN_VALID_FLAC_BYTES || !hasFlacMagicPrefix(buf)) {
          directUrlCache.delete(trackId);
          failureCooldownMap.set(trackId, Date.now() + 5_000);
          throw Object.assign(new Error(`Invalid FLAC payload (${buf.length} bytes)`), { statusCode: 503 });
        }
        coord.chunks.push(buf);
        coord.downloadedBytes = buf.length;
        if (!coord.totalLen) coord.totalLen = buf.length;
      } else {
        const reader = res.body.getReader();
        let magicChecked = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          coord.chunks.push(buf);
          coord.downloadedBytes += buf.length;

          if (!magicChecked && coord.downloadedBytes >= 16) {
            magicChecked = true;
            const head = Buffer.concat(coord.chunks, Math.min(coord.downloadedBytes, 64));
            if (!hasFlacMagicPrefix(head)) {
              try { await reader.cancel(); } catch {}
              directUrlCache.delete(trackId);
              failureCooldownMap.set(trackId, Date.now() + 5_000);
              throw Object.assign(new Error('Upstream returned invalid non-FLAC payload'), { statusCode: 503 });
            }
          }
          coord.emitter.emit('update');
        }
      }

      const fullBuf = Buffer.concat(coord.chunks, coord.downloadedBytes);
      if (fullBuf.length < MIN_VALID_FLAC_BYTES || !hasFlacMagicPrefix(fullBuf)) {
        directUrlCache.delete(trackId);
        failureCooldownMap.set(trackId, Date.now() + 5_000);
        throw Object.assign(new Error(`Invalid FLAC payload (${fullBuf.length} bytes)`), { statusCode: 503 });
      }

      const filePath = getCacheFilePath(trackId);
      const partPath = `${filePath}.${Date.now()}.part`;
      fs.writeFileSync(partPath, fullBuf);
      fs.renameSync(partPath, filePath);
      pruneHifiCache(filePath);
      coord.filePath = filePath;
      coord.isDone = true;
      coord.emitter.emit('update');

      setTimeout(() => {
        if (activeCoordinators.get(trackId) === coord) {
          coord.chunks = null;
          activeCoordinators.delete(trackId);
        }
      }, 5_000);

      return filePath;
    } catch (err) {
      coord.isFailed = true;
      coord.statusCode = err.statusCode || 503;
      coord.errorMsg = err.message || 'Hi-Fi stream download failed';
      coord.chunks = null;
      coord.emitter.emit('update');
      if (activeCoordinators.get(trackId) === coord) {
        activeCoordinators.delete(trackId);
      }
      throw err;
    } finally {
      clearTimeout(overallTimer);
      if (connectTimer) clearTimeout(connectTimer);
    }
  })();

  coord.promise.catch(() => {});
  return coord;
}

function waitForCoordinatorBytes(coord, minBytes, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    if (coord.isFailed) {
      reject(Object.assign(new Error(coord.errorMsg || 'Upstream failed'), { statusCode: coord.statusCode || 503 }));
      return;
    }
    if (coord.downloadedBytes >= minBytes || coord.isDone) {
      resolve();
      return;
    }

    let idleTimer = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        cleanup();
        reject(Object.assign(new Error('Timed out waiting for FLAC header bytes'), { statusCode: 504 }));
      }, timeoutMs);
    };

    const onUpdate = () => {
      if (coord.isFailed) {
        cleanup();
        reject(Object.assign(new Error(coord.errorMsg || 'Upstream failed'), { statusCode: coord.statusCode || 503 }));
      } else if (coord.downloadedBytes >= minBytes || coord.isDone) {
        cleanup();
        resolve();
      } else {
        resetIdle();
      }
    };

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      coord.emitter.off('update', onUpdate);
    };

    resetIdle();
    coord.emitter.on('update', onUpdate);
  });
}

function readCoordinatorRange(coord, startOffset, maxEnd) {
  if (!coord.chunks) return null;
  const availableEnd = Math.min(coord.downloadedBytes - 1, maxEnd);
  if (availableEnd < startOffset) return null;

  const needed = availableEnd - startOffset + 1;
  const parts = [];
  let offset = 0;
  let remaining = needed;

  for (const chunk of coord.chunks) {
    const chunkEnd = offset + chunk.length;
    if (chunkEnd <= startOffset) {
      offset = chunkEnd;
      continue;
    }
    const localStart = Math.max(0, startOffset - offset);
    const localEnd = Math.min(chunk.length, localStart + remaining);
    const slice = chunk.subarray(localStart, localEnd);
    parts.push(slice);
    remaining -= slice.length;
    offset = chunkEnd;
    if (remaining <= 0) break;
  }

  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}

function streamCoordinatorToResponse(req, res, coord) {
  const total = coord.totalLen;
  const rangeHeader = req.headers.range;
  let start = 0;
  let end = total > 0 ? total - 1 : Number.MAX_SAFE_INTEGER;
  let isPartial = false;

  if (rangeHeader && total > 0) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      start = parseInt(match[1], 10);
      end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
      if (start >= total || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
        return;
      }
      isPartial = true;
    }
  }

  res.setHeader('Content-Type', 'audio/flac');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (total > 0) {
    res.setHeader('Accept-Ranges', 'bytes');
  } else {
    res.setHeader('Accept-Ranges', 'none');
  }

  if (isPartial && total > 0) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
  } else {
    res.status(200);
    if (total > 0) res.setHeader('Content-Length', total);
  }

  let cursor = start;
  let closed = false;
  let waitingListener = null;
  let diskFd = null;

  const stream = new Readable({
    read() {
      pump();
    },
  });

  const detach = () => {
    closed = true;
    if (waitingListener) {
      coord.emitter.off('update', waitingListener);
      waitingListener = null;
    }
    if (diskFd !== null) {
      try {
        fs.closeSync(diskFd);
      } catch {}
      diskFd = null;
    }
  };

  stream.on('error', () => {
    detach();
    if (!res.destroyed) res.destroy();
  });

  res.on('error', () => {
    detach();
    stream.destroy();
  });

  const pump = () => {
    if (closed) return;
    if (coord.isFailed) {
      detach();
      stream.destroy();
      if (!res.destroyed) res.destroy();
      return;
    }
    if (cursor > end) {
      detach();
      stream.push(null);
      return;
    }
    if (coord.chunks && coord.downloadedBytes > cursor) {
      const slice = readCoordinatorRange(coord, cursor, end);
      if (slice && slice.length > 0) {
        cursor += slice.length;
        const canPushMore = stream.push(slice);
        if (cursor > end) {
          detach();
          stream.push(null);
          return;
        }
        if (canPushMore && (coord.downloadedBytes > cursor || coord.isDone)) {
          pump();
        }
        return;
      }
    }
    // Continue from completed disk cache once in-memory chunks are released after the grace window
    if (!coord.chunks && coord.filePath && fs.existsSync(coord.filePath)) {
      const len = Math.min(65536, end - cursor + 1);
      if (len <= 0) {
        detach();
        stream.push(null);
        return;
      }
      try {
        if (diskFd === null) diskFd = fs.openSync(coord.filePath, 'r');
        const buf = Buffer.allocUnsafe(len);
        const bytesRead = fs.readSync(diskFd, buf, 0, len, cursor);
        if (bytesRead > 0) {
          cursor += bytesRead;
          const slice = bytesRead === len ? buf : buf.subarray(0, bytesRead);
          const canPushMore = stream.push(slice);
          if (cursor > end) {
            detach();
            stream.push(null);
            return;
          }
          if (canPushMore) pump();
        } else {
          detach();
          stream.push(null);
        }
      } catch {
        detach();
        stream.destroy();
        if (!res.destroyed) res.destroy();
      }
      return;
    }
    if (coord.isDone) {
      detach();
      stream.push(null);
      return;
    }
    if (!waitingListener) {
      waitingListener = () => {
        waitingListener = null;
        pump();
      };
      coord.emitter.once('update', waitingListener);
    }
  };

  res.on('close', () => {
    if (!res.writableFinished) {
      detach();
      stream.destroy();
    }
  });

  stream.pipe(res);
}

export function serveFileWithRange(req, res, filePath, contentType = 'audio/flac', extraHeaders = {}) {
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const rangeHeader = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);

  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
      if (start >= total || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', end - start + 1);
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.status(200);
  res.setHeader('Content-Length', total);
  fs.createReadStream(filePath).pipe(res);
}

export async function ensureCachedFlac(trackId, skipCooldown = false) {
  if (!trackId || KNOWN_UPSTREAM_MISMATCHES.has(String(trackId))) {
    throw Object.assign(new Error('Blacklisted track mismatch'), { statusCode: 404 });
  }

  const filePath = getCacheFilePath(trackId);
  if (fs.existsSync(filePath)) {
    if (isValidCachedFlacFile(filePath)) return filePath;
    try { fs.unlinkSync(filePath); } catch {}
  }

  if (!skipCooldown) {
    const until = failureCooldownMap.get(trackId) || 0;
    if (Date.now() < until) {
      throw Object.assign(new Error('Upstream track in cooldown'), { statusCode: 503 });
    }
    const lastReq = rateLimitMap.get(trackId) || 0;
    if (Date.now() - lastReq < 2500 && !activeCoordinators.has(trackId)) {
      throw Object.assign(new Error('Track rate-limited'), { statusCode: 429 });
    }
    rateLimitMap.set(trackId, Date.now());
  }

  const coord = startProgressiveDownload(trackId);
  if (!coord) {
    if (fs.existsSync(filePath) && isValidCachedFlacFile(filePath)) return filePath;
    throw Object.assign(new Error('Expired CDN link for cached track; re-resolve required'), {
      statusCode: 503,
    });
  }
  return coord.promise;
}

export async function handleHifiStream(req, res) {
  const trackId = String(req.query.id || req.params.trackId || '').replace(/\.flac$/i, '').trim();
  if (!trackId) return res.status(400).json({ error: 'Missing track id' });

  if (KNOWN_UPSTREAM_MISMATCHES.has(trackId)) {
    return res.status(404).json({ error: 'Blacklisted track mismatch' });
  }

  try {
    const filePath = getCacheFilePath(trackId);
    if (fs.existsSync(filePath)) {
      if (isValidCachedFlacFile(filePath)) {
        serveFileWithRange(req, res, filePath, 'audio/flac');
        return;
      }
      try { fs.unlinkSync(filePath); } catch {}
    }

    let coord = activeCoordinators.get(trackId);
    if (!coord) {
      const skipCooldown = Boolean(req.query.retry);
      if (!skipCooldown) {
        const until = failureCooldownMap.get(trackId) || 0;
        if (Date.now() < until) {
          return res.status(503).json({ error: 'Upstream track in cooldown' });
        }
        const lastReq = rateLimitMap.get(trackId) || 0;
        if (Date.now() - lastReq < 1500) {
          return res.status(429).json({ error: 'Track rate-limited' });
        }
        rateLimitMap.set(trackId, Date.now());
      }
      getUpstreamUrl(trackId);
      coord = startProgressiveDownload(trackId);
    }

    // Wait only for the 64KB FLAC header before opening the audio stream
    await waitForCoordinatorBytes(coord, 65536, 15_000);
    if (coord.filePath && fs.existsSync(coord.filePath)) {
      serveFileWithRange(req, res, coord.filePath, 'audio/flac');
      return;
    }

    const rangeMatch = /bytes=(\d+)-/.exec(req.headers.range || '');
    const requestedStart = rangeMatch ? parseInt(rangeMatch[1], 10) : 0;
    if (coord.totalLen === 0 && requestedStart > 0 && !coord.isDone) {
      const donePath = await coord.promise;
      serveFileWithRange(req, res, donePath, 'audio/flac');
      return;
    }

    streamCoordinatorToResponse(req, res, coord);
  } catch (err) {
    if (!res.headersSent) {
      res.status(err.statusCode || 503).json({ error: err.message || 'Hi-Fi stream unavailable' });
    }
  }
}
