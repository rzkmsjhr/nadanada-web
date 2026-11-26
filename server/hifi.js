import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { CHROME_130_UA, decodeHtmlEntities, fetchWithTimeout } from './http.js';
import { detachString } from './runtimeLimits.js';
import {
  isR2Enabled,
  hasKnownR2Track,
  checkR2ObjectExists,
  getR2PublicUrl,
  uploadFileToR2,
} from './r2Cache.js';
import { stripLatinDiacritics, parseMultilingualMetadata } from './scriptUtils.js';
import {
  KNOWN_UPSTREAM_MISMATCHES,
  applyDuplicateTitleTrackPenalty,
  buildExcludedEditionDurationMap,
  computeAlbumTitleMinIds,
  detectEditions,
  isExcludedDurationByCrossProviderOracle,
  parseNumericTrackId,
  resolveEffectiveCandidateTitle,
  scoreTrackCandidate,
} from './hifiMatcher.js';

export { KNOWN_UPSTREAM_MISMATCHES };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TRACKS_BASE_URL = 'https://tracks.monochrome.st';
const KUWO_SEARCH_URL = 'https://flac.music.hi.cn/ajax.php?act=search';
const KUWO_GET_URL = 'https://flac.music.hi.cn/ajax.php?act=getUrl';
const MIN_VALID_FLAC_BYTES = 250_000;

const HIFI_CACHE_DIR = process.env.HIFI_CACHE_DIR
  ? path.resolve(process.env.HIFI_CACHE_DIR)
  : path.resolve(__dirname, '..', '.hifi_cache');
const MAX_HIFI_CACHE_BYTES =
  Math.max(50, parseInt(process.env.MAX_HIFI_CACHE_MB || '200', 10) || 200) * 1024 * 1024;
const DIRECT_URL_FILE = path.join(HIFI_CACHE_DIR, 'direct-urls.json');
const DIRECT_URL_TTL_MS = 15 * 60 * 1000;
const DIRECT_URL_CACHE_MAX = 2000;
const COOLDOWN_MAP_MAX = 2000;
const RATE_LIMIT_MAP_MAX = 2000;
const RESOLVED_CACHE_MAX = 5000;
const UNMATCHED_CACHE_MAX = 5000;
const UNMATCHED_TTL_MS = 30 * 60 * 1000;
const KUWO_ALBUM_CACHE_MAX = 500;
const KUWO_ALBUM_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CHUNK_IDLE_TIMEOUT_MS = Math.max(200, parseInt(process.env.HIFI_CHUNK_IDLE_TIMEOUT_MS || '12000', 10) || 12000);
const COORDINATOR_STALL_EVICT_MS = Math.max(500, parseInt(process.env.HIFI_COORDINATOR_STALL_MS || '15000', 10) || 15000);
const MAX_UPSTREAM_RANGE_RESUMES = 3;

function pruneStalePartFiles() {
  try {
    const cutoff = Date.now() - 60_000;
    for (const name of fs.readdirSync(HIFI_CACHE_DIR)) {
      if (!name.endsWith('.part')) continue;
      const fullPath = path.join(HIFI_CACHE_DIR, name);
      try {
        const st = fs.statSync(fullPath);
        if (st.mtimeMs < cutoff) fs.unlinkSync(fullPath);
      } catch {}
    }
  } catch {}
}

try {
  fs.mkdirSync(HIFI_CACHE_DIR, { recursive: true });
  pruneStalePartFiles();
} catch {}

const directUrlCache = new Map();
const failureCooldownMap = new Map();
const rateLimitMap = new Map();
const activeCoordinators = new Map();
const resolvedTrackCache = new Map();
const unmatchedTrackCache = new Map();
const inFlightServerResolves = new Map();
const kuwoAlbumCache = new Map();
const kuwoAlbumInFlight = new Map();

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
        setBoundedMapEntry(directUrlCache, k, entry, DIRECT_URL_CACHE_MAX);
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
  setBoundedMapEntry(directUrlCache, trackId, { url, ts: Date.now() }, DIRECT_URL_CACHE_MAX);
  schedulePersistDirectUrls();
}

function pruneHifiCache(protectedFilePath) {
  try {
    const entries = fs.readdirSync(HIFI_CACHE_DIR);
    const activePartPaths = new Set();
    for (const c of activeCoordinators.values()) {
      if (c?.partPath) activePartPaths.add(c.partPath);
    }
    const orphanCutoff = Date.now() - 10 * 60 * 1000;
    let totalBytes = 0;
    const files = [];
    for (const name of entries) {
      const fullPath = path.join(HIFI_CACHE_DIR, name);
      if (name.endsWith('.part')) {
        if (!activePartPaths.has(fullPath)) {
          try {
            const st = fs.statSync(fullPath);
            if (st.mtimeMs < orphanCutoff) fs.unlinkSync(fullPath);
          } catch {}
        }
        continue;
      }
      if (!name.endsWith('.flac')) continue;
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

/**
 * Hydrate unstripped track titles and official album track numbers from Kuwo's album catalog
 * because flac.music.hi.cn strips edition tags such as "(Instrumental)" or "(sped up)".
 */
async function fetchKuwoAlbumTrackMap(albumId) {
  const id = String(albumId || '').trim();
  if (!id || id === '0') return null;

  const cached = kuwoAlbumCache.get(id);
  if (cached && Date.now() - cached.ts < KUWO_ALBUM_CACHE_TTL_MS) {
    return cached.tracks;
  }
  if (kuwoAlbumInFlight.has(id)) {
    return kuwoAlbumInFlight.get(id);
  }

  const job = (async () => {
    const query = `stype=albuminfo&albumid=${encodeURIComponent(id)}&show_copyright_off=1&vipver=MUSIC_8.0.3.0_BCS75&mobi=1&ft=music&rformat=json`;
    const headers = { 'User-Agent': CHROME_130_UA, Accept: 'application/json, text/plain, */*' };
    const attempts = [
      { url: `https://search.kuwo.cn/r.s?${query}`, timeoutMs: 3500 },
      { url: `http://search.kuwo.cn/r.s?${query}`, timeoutMs: 3000 },
    ];

    for (const { url, timeoutMs } of attempts) {
      try {
        const res = await fetchWithTimeout(url, { headers }, timeoutMs);
        if (!res.ok) {
          try { await res.body?.cancel?.(); } catch {}
          continue;
        }
        const rawText = await res.text();
        if (!rawText) continue;
        const data = JSON.parse(rawText);
        const list = Array.isArray(data?.musiclist) ? data.musiclist : null;
        if (!list) return null;

        const trackMap = new Map();
        for (const m of list) {
          const mid = String(m?.id ?? '').trim();
          if (!mid) continue;
          const rawName = String(m?.name || m?.songname || '').trim();
          trackMap.set(detachString(mid), {
            name: detachString(decodeHtmlEntities(rawName)),
            track: parseInt(String(m?.track || '0'), 10) || 0,
            duration: Number(m?.duration) || 0,
          });
        }

        setBoundedMapEntry(kuwoAlbumCache, id, { ts: Date.now(), tracks: trackMap }, KUWO_ALBUM_CACHE_MAX);
        return trackMap;
      } catch {}
    }
    return null;
  })();

  kuwoAlbumInFlight.set(id, job);
  try {
    return await job;
  } finally {
    if (kuwoAlbumInFlight.get(id) === job) {
      kuwoAlbumInFlight.delete(id);
    }
  }
}

async function hydrateKuwoRawCandidates(rawList, qualified) {
  if (!Array.isArray(qualified) || qualified.length === 0) return false;

  const topSorted = [...qualified].sort((a, b) => b.score - a.score);
  const albumIds = [];
  for (const { cand } of topSorted) {
    const albId = String(cand.raw?.album_id || '').trim();
    if (!albId || albId === '0' || cand.raw?._kuwoAlbumHydrated) continue;
    if (!albumIds.includes(albId)) {
      albumIds.push(albId);
      if (albumIds.length >= 4) break;
    }
  }
  if (albumIds.length === 0) return false;

  const fetched = await Promise.all(albumIds.map((albId) => fetchKuwoAlbumTrackMap(albId)));
  const albumTrackMaps = new Map();
  for (let i = 0; i < albumIds.length; i++) {
    if (fetched[i]) albumTrackMaps.set(albumIds[i], fetched[i]);
  }

  let changed = false;
  for (const raw of rawList) {
    const albId = String(raw?.album_id || '').trim();
    if (!albId || !albumIds.includes(albId)) continue;
    raw._kuwoAlbumHydrated = true;
    const trackMap = albumTrackMaps.get(albId);
    if (!trackMap) continue;
    const info = trackMap.get(String(raw.id ?? '').trim());
    if (!info) continue;

    const nextEffective = resolveEffectiveCandidateTitle(raw.name || '', info.name, raw.album_name || '');
    if (info.track > 0 && raw._kuwoTrackNum !== info.track) {
      raw._kuwoTrackNum = info.track;
      changed = true;
    }
    if (info.name) {
      raw._kuwoOfficialName = info.name;
    }
    if (nextEffective && nextEffective !== (raw.effective_name || raw.name || '')) {
      raw.effective_name = nextEffective;
      changed = true;
    }
  }
  return changed;
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
        if (raw._searchIndex === undefined) raw._searchIndex = rawList.length;
        rawList.push(raw);
      }
    };

    const targetEditions = detectEditions(cleanTitle, targetAlbum);

    const evaluateHiCnCandidates = (platform, rawList, referenceList) => {
      const albumTitleGroups = computeAlbumTitleMinIds(rawList, targetEditions);
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
          title: raw.effective_name || raw.name || '',
          artist: raw.artist || '',
          album: raw.album_name || '',
          albumId: String(raw.album_id || '').trim(),
          trackNum: Number(raw._kuwoTrackNum) || 0,
          searchIndex: Number.isInteger(raw._searchIndex) ? raw._searchIndex : Number.MAX_SAFE_INTEGER,
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
        sc = applyDuplicateTitleTrackPenalty(
          sc,
          cand.title,
          cand.album,
          rawId,
          albumTitleGroups,
          cand.duration,
          cand.trackNum,
          cand.searchIndex
        );
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

    const compareSameAlbumTrackOrder = (a, b) => {
      if (a.albumId && a.albumId === b.albumId && a.trackNum > 0 && b.trackNum > 0) {
        return a.trackNum - b.trackNum;
      }
      return 0;
    };

    const tryQualifiedHiCnPlatform = async (platform, qualified) => {
      if (qualified.length === 0) return null;
      qualified.sort(
        (a, b) =>
          b.score - a.score ||
          durDistanceFromTarget(a.cand) - durDistanceFromTarget(b.cand) ||
          compareSameAlbumTrackOrder(a.cand, b.cand) ||
          a.cand.searchIndex - b.cand.searchIndex ||
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

    const evaluateKuwoWithHydration = async () => {
      let evalRes = evaluateHiCnCandidates('kuwo', kuwoRawList, wyyRawList);
      if (evalRes.qualified.length > 0 && (await hydrateKuwoRawCandidates(kuwoRawList, evalRes.qualified))) {
        evalRes = evaluateHiCnCandidates('kuwo', kuwoRawList, wyyRawList);
      }
      return evalRes;
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

      let kuwoEval = await evaluateKuwoWithHydration();

      // Finish remaining Kuwo passes (2..4) unless Pass 1 already cleared early-exit threshold
      for (const q of passQueries.slice(1)) {
        if (kuwoEval.bestScore >= earlyExitThreshold) break;
        const res = await searchHiCnPlatform('kuwo', q, 12);
        if (res.ok) {
          anyProviderSucceeded = true;
          collectHiCnRawBatch(res.list, kuwoRawList, kuwoSeen);
          kuwoEval = await evaluateKuwoWithHydration();
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

async function writeBufferAtOffset(handle, buf, position) {
  let offset = 0;
  while (offset < buf.length) {
    const { bytesWritten } = await handle.write(buf, offset, buf.length - offset, position + offset);
    if (!bytesWritten) break;
    offset += bytesWritten;
  }
}

async function readChunkWithTimeout(reader, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error('Upstream FLAC stream stalled'), { code: 'CHUNK_TIMEOUT', statusCode: 504 }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function finalizePartFile(coord) {
  if (coord.filePath === coord.finalFilePath) return coord.finalFilePath;
  try {
    fs.renameSync(coord.partPath, coord.finalFilePath);
    coord.filePath = coord.finalFilePath;
    coord.pendingRename = false;
    pruneHifiCache(coord.finalFilePath);
    if (isR2Enabled()) {
      uploadFileToR2(coord.trackId, coord.finalFilePath).catch(() => {});
    }
    if (activeCoordinators.get(coord.trackId) === coord) {
      activeCoordinators.delete(coord.trackId);
    }
    return coord.finalFilePath;
  } catch (err) {
    if (err?.code === 'ENOENT' && fs.existsSync(coord.finalFilePath)) {
      coord.filePath = coord.finalFilePath;
      coord.pendingRename = false;
      if (isR2Enabled()) {
        uploadFileToR2(coord.trackId, coord.finalFilePath).catch(() => {});
      }
      if (activeCoordinators.get(coord.trackId) === coord) {
        activeCoordinators.delete(coord.trackId);
      }
      return coord.finalFilePath;
    }
    if (err?.code === 'EPERM' || err?.code === 'EBUSY') {
      coord.pendingRename = true;
      coord.filePath = coord.partPath;
      return coord.partPath;
    }
    throw err;
  }
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
  emitter.setMaxListeners(200);

  const partPath = `${cachedPath}.${process.pid}.${Date.now()}.part`;
  const coord = {
    trackId,
    partPath,
    finalFilePath: cachedPath,
    downloadedBytes: 0,
    totalLen: 0,
    isDone: false,
    isFailed: false,
    statusCode: 503,
    errorMsg: null,
    filePath: null,
    activeReaders: 0,
    pendingRename: false,
    unlinkOnDetach: false,
    lastDataAt: Date.now(),
    abort: null,
    emitter,
    promise: null,
  };

  activeCoordinators.set(trackId, coord);

  coord.promise = (async () => {
    const controller = new AbortController();
    coord.abort = () => controller.abort();
    const overallTimer = setTimeout(() => controller.abort(), 120_000);
    let connectTimer = null;
    let writeHandle = null;

    try {
      const headBuf = Buffer.alloc(64);
      let headLen = 0;
      let magicChecked = false;
      let completedCleanly = false;

      for (let resumeAttempt = 0; resumeAttempt <= MAX_UPSTREAM_RANGE_RESUMES; resumeAttempt++) {
        if (controller.signal.aborted) {
          throw Object.assign(new Error('Upstream FLAC download timed out'), { statusCode: 504 });
        }
        if (resumeAttempt > 0) {
          await new Promise((r) => setTimeout(r, 300 * resumeAttempt));
        }

        const isRangeResume = coord.downloadedBytes > 0 && magicChecked;
        let res = null;
        let lastErr = null;
        const maxConnectAttempts = isRangeResume ? 1 : 2;

        for (let attempt = 1; attempt <= maxConnectAttempts; attempt++) {
          connectTimer = setTimeout(() => controller.abort(), 15_000);
          try {
            const reqHeaders = { 'User-Agent': CHROME_130_UA, Accept: '*/*' };
            if (isRangeResume) {
              reqHeaders.Range = `bytes=${coord.downloadedBytes}-`;
            }
            res = await fetch(upstreamUrl, {
              headers: reqHeaders,
              signal: controller.signal,
            });
            clearTimeout(connectTimer);
            connectTimer = null;
            if (res.ok) break;
            if ((res.status === 429 || res.status >= 500) && attempt < maxConnectAttempts) {
              try { await res.body?.cancel?.(); } catch {}
              await new Promise((r) => setTimeout(r, 450));
              continue;
            }
            break;
          } catch (err) {
            lastErr = err;
            clearTimeout(connectTimer);
            connectTimer = null;
            if (attempt < maxConnectAttempts && !controller.signal.aborted) {
              await new Promise((r) => setTimeout(r, 350));
              continue;
            }
          }
        }

        if (!res) {
          if (isRangeResume && resumeAttempt < MAX_UPSTREAM_RANGE_RESUMES && !controller.signal.aborted) {
            continue;
          }
          setBoundedMapEntry(failureCooldownMap, trackId, Date.now() + 5_000, COOLDOWN_MAP_MAX);
          throw Object.assign(lastErr || new Error('Upstream connection failed'), { statusCode: 503 });
        }

        if (!res.ok) {
          try { await res.body?.cancel?.(); } catch {}
          if (isRangeResume && res.status === 416 && coord.totalLen > 0 && coord.downloadedBytes >= coord.totalLen) {
            completedCleanly = true;
            break;
          }
          if (isRangeResume && (res.status === 429 || res.status >= 500) && resumeAttempt < MAX_UPSTREAM_RANGE_RESUMES) {
            continue;
          }
          const msg = `HTTP ${res.status}`;
          setBoundedMapEntry(
            failureCooldownMap,
            trackId,
            Date.now() + (res.status === 429 ? 120_000 : 5_000),
            COOLDOWN_MAP_MAX
          );
          if (res.status === 403 || res.status === 410) directUrlCache.delete(trackId);
          throw Object.assign(new Error(msg), { statusCode: 503 });
        }

        // Reject HTML/JSON error pages early; do NOT reject audio/mpeg header because NetEase/WYY CDNs
        // serve real fLaC files with Content-Type: audio/mpeg. Byte magic check below verifies real fLaC bytes.
        const ct = String(res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('text/html') || ct.includes('application/json')) {
          try { await res.body?.cancel?.(); } catch {}
          directUrlCache.delete(trackId);
          throw Object.assign(new Error(`Invalid upstream content-type: ${ct}`), { statusCode: 503 });
        }

        if (isRangeResume) {
          const cr = String(res.headers.get('content-range') || '');
          const crm = /^bytes\s+(\d+)-(\d*)\/(\d+|\*)/i.exec(cr);
          if (res.status !== 206 || !crm || parseInt(crm[1], 10) !== coord.downloadedBytes) {
            try { await res.body?.cancel?.(); } catch {}
            throw Object.assign(
              new Error(`Incomplete FLAC download (${coord.downloadedBytes}/${coord.totalLen || '?'} bytes)`),
              { statusCode: 503 }
            );
          }
          if (crm[3] && crm[3] !== '*') {
            const totalFromCr = parseInt(crm[3], 10);
            if (Number.isFinite(totalFromCr) && totalFromCr > 0) {
              coord.totalLen = totalFromCr;
            }
          }
        } else {
          const contentLen = parseInt(res.headers.get('content-length') || '0', 10);
          if (Number.isFinite(contentLen) && contentLen > 0) {
            coord.totalLen = contentLen;
          }
        }

        if (!res.body) {
          const arrBuf = await res.arrayBuffer();
          const buf = Buffer.from(arrBuf);
          if (!isRangeResume) {
            if (buf.length < MIN_VALID_FLAC_BYTES || !hasFlacMagicPrefix(buf)) {
              directUrlCache.delete(trackId);
              setBoundedMapEntry(failureCooldownMap, trackId, Date.now() + 5_000, COOLDOWN_MAP_MAX);
              throw Object.assign(new Error(`Invalid FLAC payload (${buf.length} bytes)`), { statusCode: 503 });
            }
            buf.copy(headBuf, 0, 0, Math.min(64, buf.length));
            headLen = Math.min(64, buf.length);
            magicChecked = true;
            writeHandle = await fs.promises.open(partPath, 'w+');
            await writeBufferAtOffset(writeHandle, buf, 0);
            await writeHandle.close();
            writeHandle = null;
            coord.downloadedBytes = buf.length;
            if (!coord.totalLen) coord.totalLen = buf.length;
            coord.lastDataAt = Date.now();
            coord.emitter.emit('update');
          } else {
            if (writeHandle === null) writeHandle = await fs.promises.open(partPath, 'r+');
            if (buf.length > 0) {
              await writeBufferAtOffset(writeHandle, buf, coord.downloadedBytes);
              coord.downloadedBytes += buf.length;
              coord.lastDataAt = Date.now();
              coord.emitter.emit('update');
            }
            await writeHandle.close();
            writeHandle = null;
          }
        } else {
          const reader = res.body.getReader();
          let streamErr = null;
          try {
            if (isRangeResume && writeHandle === null) {
              writeHandle = await fs.promises.open(partPath, 'r+');
            }
            while (true) {
              const { done, value } = await readChunkWithTimeout(reader, CHUNK_IDLE_TIMEOUT_MS);
              if (done) break;
              if (!value || value.byteLength === 0) continue;
              const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);

              if (!magicChecked) {
                const take = Math.min(buf.length, headBuf.length - headLen);
                if (take > 0) {
                  buf.copy(headBuf, headLen, 0, take);
                  headLen += take;
                }
                if (headLen >= 16) {
                  magicChecked = true;
                  if (!hasFlacMagicPrefix(headBuf.subarray(0, headLen))) {
                    try { await reader.cancel(); } catch {}
                    directUrlCache.delete(trackId);
                    setBoundedMapEntry(failureCooldownMap, trackId, Date.now() + 5_000, COOLDOWN_MAP_MAX);
                    throw Object.assign(new Error('Upstream returned invalid non-FLAC payload'), { statusCode: 503 });
                  }
                  writeHandle = await fs.promises.open(partPath, 'w+');
                  const remainder = buf.subarray(take);
                  if (headLen > 0) await writeBufferAtOffset(writeHandle, headBuf.subarray(0, headLen), 0);
                  if (remainder.length > 0) await writeBufferAtOffset(writeHandle, remainder, headLen);
                  coord.downloadedBytes = headLen + remainder.length;
                  coord.lastDataAt = Date.now();
                  coord.emitter.emit('update');
                }
                continue;
              }

              await writeBufferAtOffset(writeHandle, buf, coord.downloadedBytes);
              coord.downloadedBytes += buf.length;
              coord.lastDataAt = Date.now();
              coord.emitter.emit('update');
            }
          } catch (err) {
            streamErr = err;
            try { await reader.cancel(); } catch {}
          } finally {
            if (writeHandle !== null) {
              try { await writeHandle.close(); } catch {}
              writeHandle = null;
            }
          }

          if (streamErr) {
            if (magicChecked && coord.downloadedBytes > 0 && resumeAttempt < MAX_UPSTREAM_RANGE_RESUMES && !controller.signal.aborted) {
              continue;
            }
            throw streamErr;
          }
        }

        if (!coord.totalLen || coord.downloadedBytes >= coord.totalLen) {
          completedCleanly = true;
          break;
        }
        if (!(magicChecked && coord.downloadedBytes > 0 && resumeAttempt < MAX_UPSTREAM_RANGE_RESUMES && !controller.signal.aborted)) {
          throw Object.assign(
            new Error(`Incomplete FLAC download (${coord.downloadedBytes}/${coord.totalLen} bytes)`),
            { statusCode: 503 }
          );
        }
      }

      if (writeHandle !== null) {
        await writeHandle.close();
        writeHandle = null;
      }

      if (
        !completedCleanly ||
        !magicChecked ||
        coord.downloadedBytes < MIN_VALID_FLAC_BYTES ||
        !hasFlacMagicPrefix(headBuf.subarray(0, headLen)) ||
        (coord.totalLen > 0 && coord.downloadedBytes < coord.totalLen)
      ) {
        if (coord.totalLen > 0 && coord.downloadedBytes < coord.totalLen) {
          throw Object.assign(
            new Error(`Incomplete FLAC download (${coord.downloadedBytes}/${coord.totalLen} bytes)`),
            { statusCode: 503 }
          );
        }
        directUrlCache.delete(trackId);
        setBoundedMapEntry(failureCooldownMap, trackId, Date.now() + 5_000, COOLDOWN_MAP_MAX);
        throw Object.assign(new Error(`Invalid FLAC payload (${coord.downloadedBytes} bytes)`), {
          statusCode: 503,
        });
      }

      const readyPath = finalizePartFile(coord);
      coord.isDone = true;
      coord.emitter.emit('update');
      return readyPath;
    } catch (err) {
      if (writeHandle !== null) {
        try { await writeHandle.close(); } catch {}
        writeHandle = null;
      }
      if (coord.activeReaders === 0) {
        try { if (fs.existsSync(partPath)) await fs.promises.unlink(partPath); } catch {}
      } else {
        coord.unlinkOnDetach = true;
      }
      coord.isFailed = true;
      coord.statusCode = err.statusCode || 503;
      coord.errorMsg = err.message || 'Hi-Fi stream download failed';
      coord.emitter.emit('update');
      if (activeCoordinators.get(trackId) === coord) {
        activeCoordinators.delete(trackId);
      }
      throw err;
    } finally {
      clearTimeout(overallTimer);
      if (connectTimer) clearTimeout(connectTimer);
      if (writeHandle !== null) {
        try { await writeHandle.close(); } catch {}
        writeHandle = null;
      }
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

async function openCoordReadHandle(coord) {
  const candidates = [];
  if (coord.filePath) candidates.push(coord.filePath);
  if (coord.partPath && coord.partPath !== coord.filePath) candidates.push(coord.partPath);
  if (coord.finalFilePath && !candidates.includes(coord.finalFilePath)) candidates.push(coord.finalFilePath);
  let lastErr;
  for (const p of candidates) {
    try {
      return await fs.promises.open(p, 'r');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Missing cached FLAC descriptor');
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
  res.setHeader('Cache-Control', 'no-store');
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
  let waitTimer = null;
  let readHandle = null;
  let readerCounted = false;
  let pumping = false;
  let repump = false;
  let openInFlight = false;
  let readInFlight = false;
  let closeInFlight = false;

  const clearWaitState = () => {
    if (waitTimer) {
      clearTimeout(waitTimer);
      waitTimer = null;
    }
    if (waitingListener) {
      coord.emitter.off('update', waitingListener);
      waitingListener = null;
    }
  };

  const scheduleWaitForUpdate = () => {
    if (closed || waitingListener) return;
    waitingListener = () => {
      clearWaitState();
      pump();
    };
    coord.emitter.once('update', waitingListener);
    waitTimer = setTimeout(() => {
      clearWaitState();
      detach();
      if (!stream.destroyed) stream.destroy(Object.assign(new Error('Upstream FLAC coordinator stalled'), { statusCode: 504 }));
      if (!res.destroyed) res.destroy();
    }, COORDINATOR_STALL_EVICT_MS);
  };

  const finalizeReader = () => {
    if (readerCounted) {
      readerCounted = false;
      coord.activeReaders = Math.max(0, coord.activeReaders - 1);
      if (coord.activeReaders === 0) {
        if (coord.pendingRename && coord.isDone) {
          try {
            finalizePartFile(coord);
          } catch {}
        } else if (coord.unlinkOnDetach && coord.partPath) {
          fs.promises.unlink(coord.partPath).catch(() => {});
        }
      }
    }
  };

  const closeReadHandleIfIdle = () => {
    if (!closed || openInFlight || readInFlight || closeInFlight) return;
    const handleToClose = readHandle;
    readHandle = null;
    if (handleToClose) {
      closeInFlight = true;
      handleToClose
        .close()
        .catch(() => {})
        .finally(() => {
          closeInFlight = false;
          finalizeReader();
        });
    } else {
      finalizeReader();
    }
  };

  const detach = () => {
    if (closed) {
      closeReadHandleIfIdle();
      return;
    }
    closed = true;
    clearWaitState();
    closeReadHandleIfIdle();
  };

  const stream = new Readable({
    read() {
      pump();
    },
    destroy(err, cb) {
      detach();
      cb(err);
    },
  });

  stream.on('error', () => {
    detach();
    if (!res.destroyed) res.destroy();
  });

  res.on('error', () => {
    detach();
    if (!stream.destroyed) stream.destroy();
  });

  const pump = async () => {
    if (closed) return;
    if (pumping) {
      repump = true;
      return;
    }
    pumping = true;
    try {
      do {
        repump = false;
        if (closed) return;
        if (coord.isFailed) {
          detach();
          if (!stream.destroyed) stream.destroy();
          if (!res.destroyed) res.destroy();
          return;
        }
        if (cursor > end) {
          detach();
          stream.push(null);
          return;
        }
        if (coord.downloadedBytes > cursor) {
          const len = Math.min(65536, coord.downloadedBytes - cursor, end - cursor + 1);
          if (len <= 0) {
            detach();
            stream.push(null);
            return;
          }
          try {
            if (readHandle === null) {
              openInFlight = true;
              let opened;
              try {
                opened = await openCoordReadHandle(coord);
              } finally {
                openInFlight = false;
              }
              if (closed) {
                await opened.close().catch(() => {});
                closeReadHandleIfIdle();
                return;
              }
              readHandle = opened;
              if (!readerCounted) {
                readerCounted = true;
                coord.activeReaders += 1;
              }
            }
            const buf = Buffer.allocUnsafe(len);
            readInFlight = true;
            let bytesRead = 0;
            try {
              const readRes = await readHandle.read(buf, 0, len, cursor);
              bytesRead = readRes.bytesRead;
            } finally {
              readInFlight = false;
              if (closed) {
                closeReadHandleIfIdle();
              }
            }
            if (closed) return;
            if (bytesRead > 0) {
              cursor += bytesRead;
              const slice = bytesRead === len ? buf : buf.subarray(0, bytesRead);
              const canPushMore = stream.push(slice);
              if (cursor > end) {
                detach();
                stream.push(null);
                return;
              }
              if (canPushMore && coord.downloadedBytes > cursor) {
                repump = true;
                continue;
              }
              if (coord.isDone && cursor >= coord.downloadedBytes) {
                detach();
                stream.push(null);
                return;
              }
              if (canPushMore && !coord.isDone && !waitingListener) {
                scheduleWaitForUpdate();
              }
              return;
            }
          } catch {
            detach();
            if (!stream.destroyed) stream.destroy();
            if (!res.destroyed) res.destroy();
            return;
          }
        }
        if (coord.isDone) {
          detach();
          stream.push(null);
          return;
        }
        if (!waitingListener) {
          scheduleWaitForUpdate();
        }
      } while (repump && !closed);
    } finally {
      pumping = false;
    }
  };

  res.on('close', () => {
    detach();
    if (!res.writableFinished && !stream.destroyed) {
      stream.destroy();
    }
  });

  stream.pipe(res);
}

function pipeRangeStream(filePath, streamOpts, res) {
  const rs = streamOpts ? fs.createReadStream(filePath, streamOpts) : fs.createReadStream(filePath);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (!rs.destroyed) rs.destroy();
    res.off?.('close', cleanup);
    res.off?.('error', cleanup);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
  rs.on('end', () => {
    res.off?.('close', cleanup);
    res.off?.('error', cleanup);
  });
  rs.on('error', () => {
    cleanup();
    if (!res.headersSent) {
      try {
        res.status(500).json({ error: 'File stream error' });
      } catch {}
    } else if (!res.destroyed) {
      res.destroy();
    }
  });
  rs.pipe(res);
}

export function serveFileWithRange(req, res, filePath, contentType = 'audio/flac', extraHeaders = {}) {
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const rangeHeader = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  if (contentType === 'audio/flac') {
    res.setHeader('Cache-Control', 'no-store');
  }
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
      pipeRangeStream(filePath, { start, end }, res);
      return;
    }
  }

  res.status(200);
  res.setHeader('Content-Length', total);
  pipeRangeStream(filePath, null, res);
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
    setBoundedMapEntry(rateLimitMap, trackId, Date.now(), RATE_LIMIT_MAP_MAX);
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
    if (isR2Enabled() && hasKnownR2Track(trackId)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, getR2PublicUrl(trackId));
    }

    const filePath = getCacheFilePath(trackId);
    if (fs.existsSync(filePath)) {
      if (isValidCachedFlacFile(filePath)) {
        if (isR2Enabled()) {
          uploadFileToR2(trackId, filePath).catch(() => {});
        }
        serveFileWithRange(req, res, filePath, 'audio/flac');
        return;
      }
      try { await fs.promises.unlink(filePath); } catch {}
    }

    let coord = activeCoordinators.get(trackId);
    if (coord && (coord.isFailed || (!coord.isDone && Date.now() - (coord.lastDataAt || 0) > COORDINATOR_STALL_EVICT_MS))) {
      try { coord.abort?.(); } catch {}
      if (activeCoordinators.get(trackId) === coord) {
        activeCoordinators.delete(trackId);
      }
      coord = null;
    }
    if (!coord && isR2Enabled()) {
      const existsInR2 = await checkR2ObjectExists(trackId);
      if (existsInR2) {
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, getR2PublicUrl(trackId));
      }
    }
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
        setBoundedMapEntry(rateLimitMap, trackId, Date.now(), RATE_LIMIT_MAP_MAX);
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
