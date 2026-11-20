import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CHROME_130_UA, fetchWithTimeout } from './http.js';
import {
  normalizeArabic,
  normalizeThai,
  stripLatinDiacritics,
  containsJapanese,
  kanaToRomaji,
  katakanaLoanwordPhoneticMatches,
  getArtistCrossScriptAliases,
  getTitleCrossScriptAliases,
  parseMultilingualMetadata,
} from './scriptUtils.js';

const TRACKS_BASE_URL = 'https://tracks.monochrome.st';
const KUWO_SEARCH_URL = 'https://flac.music.hi.cn/ajax.php?act=search';
const KUWO_GET_URL = 'https://flac.music.hi.cn/ajax.php?act=getUrl';
const MIN_VALID_FLAC_BYTES = 250_000;

const HIFI_CACHE_DIR = path.join(os.tmpdir(), 'mysongs_hifi_cache');
try {
  fs.mkdirSync(HIFI_CACHE_DIR, { recursive: true });
} catch {}

const directUrlCache = new Map();
const failureCooldownMap = new Map();
const rateLimitMap = new Map();
const activeCoordinators = new Map();

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
      12000
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
    12000
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
      const streamTarget = t.recordingId || id;
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
      const streamTarget = t.recordingId || id;
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

async function searchHiCnPlatform(platform, query, size = 12) {
  for (let attempt = 1; attempt <= 3; attempt++) {
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
        12000
      );
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      const data = await res.json();
      if (data?.code !== 0) return [];
      return data?.data?.list || [];
    } catch {
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return [];
}

async function getHiCnFlacUrl(platform, candidate, expectedDurSecs = 0) {
  const flacInfo = (candidate.minfo || [])
    .filter((m) => String(m.format || '').toLowerCase() === 'flac')
    .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];
  if (!flacInfo) return null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const body = new URLSearchParams({
        platform,
        songid: String(candidate.id),
        format: 'flac',
        bitrate: String(flacInfo.bitrate || 2000),
        time: String(candidate.time || ''),
        sign: String(candidate.sign || ''),
      });
      const res = await fetchWithTimeout(
        KUWO_GET_URL,
        { method: 'POST', headers: makeEphemeralHeaders(), body },
        12000
      );
      const data = await res.json();
      if (data?.code === -3) return null;
      const d = data?.data;
      const url = d?.url || '';
      const retFmt = String(d?.format || '').toLowerCase();
      const retBr = Number(d?.bitrate) || 0;
      const retDur = Number(d?.duration) || 0;

      // Lossy downgrade reject
      if ((retFmt && retFmt !== 'flac') || (retBr > 0 && retBr < 500) || !isValidKuwoFlacUrl(url)) {
        return null;
      }
      // Throttled substitute retry
      const isThrottled =
        (expectedDurSecs > 30 && retDur > 0 && (retDur < expectedDurSecs / 2 || Math.abs(expectedDurSecs - retDur) > 20)) ||
        retBr <= 1 ||
        url.toLowerCase().includes('/lx/resource/');
      if (isThrottled) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 400 * attempt + (attempt * 47) % 150));
          continue;
        }
        return null;
      }
      return url;
    } catch {
      if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  return null;
}

function cleanStringForMatch(str = '') {
  let s = String(str)
    .replace(/《[^》]*》(?:主题曲|插曲|片尾曲|片头曲|推广曲|OST)/g, ' ')
    .replace(/\b(?:feat\.?|ft\.?|featuring)\b.*$/i, ' ')
    .replace(/[\(\[\{（【][^\)\]\}）】]*[\)\]\}）】]/g, ' ');
  s = stripLatinDiacritics(normalizeArabic(normalizeThai(s)));
  return s.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');
}

const EDITION_TESTS = {
  remix: /\b(remix|rework|vip mix|club mix|radio edit|bootleg)\b/i,
  live: /\b(live|unplugged|mtv unplugged|concert)\b/i,
  acoustic: /\b(acoustic)\b/i,
  instrumental: /\b(instrumental|karaoke|off vocal)\b/i,
  soundtrack: /\b(soundtrack|ost|motion picture)\b/i,
  rerecorded: /\b(re-?record(?:ed)?|taylor'?s version)\b/i,
  cover: /\b(cover|tribute)\b/i,
};

function detectEditions(title = '', album = '') {
  const combined = `${title} ${album || ''}`;
  const set = new Set();
  for (const [key, re] of Object.entries(EDITION_TESTS)) {
    if (re.test(combined)) set.add(key);
  }
  return set;
}

function splitArtistList(s = '') {
  return String(s)
    .replace(/- Topic/gi, '')
    .replace(/vevo/gi, '')
    .split(/[,&/;|]|\b(?:feat\.?|ft\.?|featuring|with|and|x)\b/i)
    .map((p) => stripLatinDiacritics(p).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').trim())
    .filter(Boolean);
}

function doesArtistMatch(targetArtist, candArtist, targetTitle = '') {
  const tTokens = splitArtistList(targetArtist);
  const cTokens = splitArtistList(candArtist);
  if (tTokens.length === 0 || cTokens.length === 0) return false;

  const aliases = getArtistCrossScriptAliases(targetArtist).map((a) =>
    stripLatinDiacritics(a).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  );

  for (const tt of tTokens) {
    const ttNoThe = tt.replace(/^the/, '');
    for (const ct of cTokens) {
      const ctNoThe = ct.replace(/^the/, '');
      if (tt === ct || ttNoThe === ctNoThe) return true;
      if (tt.length >= 3 && ct.length >= 3 && (ct.includes(tt) || tt.includes(ct))) return true;
      if (aliases.includes(ct)) return true;
    }
  }

  const cleanTargetTitle = cleanStringForMatch(targetTitle);
  if (cTokens.some((ct) => ct.length >= 3 && cleanTargetTitle.includes(ct))) return true;
  return false;
}

function scoreTrackCandidate(cand, meta, targetArtist, targetTitle, targetAlbum, targetDur) {
  const id = String(cand.id || '');
  if (KNOWN_UPSTREAM_MISMATCHES.has(id)) return 0;
  if (/\b(virzha|ello|2021 remake)\b/i.test(cand.title || '') && !/\b(virzha|ello|2021|remake)\b/i.test(targetTitle)) {
    return 0;
  }

  const targetEd = detectEditions(targetTitle, targetAlbum);
  const candEd = detectEditions(cand.title, cand.album);
  if (targetEd.size === 0 && candEd.size > 0) return 0;
  if (targetEd.size > 0 && ([...targetEd].some((e) => !candEd.has(e)) || [...candEd].some((e) => !targetEd.has(e)))) {
    return 0;
  }

  if (/\b(feat\.?|ft\.)\b/i.test(cand.title || '') && !/\b(feat\.?|ft\.)\b/i.test(targetTitle)) {
    return 0;
  }

  if (!doesArtistMatch(targetArtist, cand.artist, targetTitle)) return 0;
  let score = 50;

  const cTitle = cleanStringForMatch(cand.title);
  const tTitle = cleanStringForMatch(meta.extractedTitle || targetTitle);
  const tAlt = meta.nativeTitle ? cleanStringForMatch(meta.nativeTitle) : '';
  const tLat = meta.latinTitle ? cleanStringForMatch(meta.latinTitle) : '';

  let titlePoints = 0;
  if (cTitle && cTitle === tTitle) {
    titlePoints = 100;
  } else if (cTitle && tTitle && (cTitle.includes(tTitle) || tTitle.includes(cTitle))) {
    const residue = Math.abs(cTitle.length - tTitle.length);
    titlePoints = residue <= 3 ? 85 : residue <= 8 ? 65 : 45;
  } else if (containsJapanese(targetTitle) || containsJapanese(cand.title)) {
    const rTarget = cleanStringForMatch(kanaToRomaji(targetTitle));
    const rCand = cleanStringForMatch(kanaToRomaji(cand.title));
    if (katakanaLoanwordPhoneticMatches(rCand, rTarget) || katakanaLoanwordPhoneticMatches(rTarget, rCand)) {
      titlePoints = 85;
    }
  } else if ((tAlt && cTitle === tAlt) || (tLat && cTitle === tLat)) {
    titlePoints = 85;
  } else {
    const tAliases = getTitleCrossScriptAliases(meta.extractedTitle || targetTitle).map(cleanStringForMatch);
    if (tAliases.includes(cTitle)) titlePoints = 85;
  }

  if (titlePoints === 0) return 0;
  score += titlePoints;

  if (targetDur > 0 && cand.duration > 0) {
    const diff = Math.abs(targetDur - cand.duration);
    const maxDiff = targetDur > 350 ? Math.min(12, Math.max(7, targetDur * 0.02)) : 7;
    if (diff > maxDiff) return 0;
    if (diff <= 2) score += 40;
    else if (diff <= 4) score += 15;
    else score -= 30;
  } else if (!cand.duration) {
    score -= 25;
  }

  if (targetAlbum && cand.album) {
    const cAlb = cleanStringForMatch(cand.album);
    const tAlb = cleanStringForMatch(targetAlbum);
    if (cAlb && tAlb) {
      if (cAlb === tAlb) score += 65;
      else if (cAlb.includes(tAlb) || tAlb.includes(cAlb)) score += 35;
      else score -= 25;
    }
  }
  return score;
}

export async function resolveHifiTrack({
  songId = null,
  title = '',
  channel = null,
  duration = null,
  itemType = null,
  isrc = null,
  album = null,
}) {
  if (!isEligibleTrack(title, channel, itemType)) {
    return { matched: false, reason: 'Track ineligible for Hi-Fi audio' };
  }
  if (songId && KNOWN_UPSTREAM_MISMATCHES.has(String(songId))) {
    return { matched: false, reason: 'Known mismatch override' };
  }

  const meta = parseMultilingualMetadata(title, channel || '');
  const targetArtist = meta.extractedArtist || (channel || '').replace(/\s*-\s*Topic$/i, '').trim();
  const targetTitle = meta.extractedTitle || meta.cleanTitle || title;
  const targetDur = parseDurationToSecs(duration);

  // 1. Kuwo & WYY via flac.music.hi.cn
  for (const platform of ['kuwo', 'wyy']) {
    const bestCandidates = [];
    for (const q of meta.searchQueries.slice(0, 4)) {
      const list = await searchHiCnPlatform(platform, q, 12);
      for (const raw of list) {
        const hasFlac = (raw.minfo || []).some((m) => String(m.format || '').toLowerCase() === 'flac');
        if (!hasFlac) continue;
        const cand = {
          id: `${platform}_${raw.id}`,
          raw,
          title: raw.name || '',
          artist: raw.artist || '',
          album: raw.album_name || '',
          duration: Number(raw.duration) || 0,
        };
        const sc = scoreTrackCandidate(cand, meta, targetArtist, targetTitle, album, targetDur);
        if (sc >= 140) bestCandidates.push({ cand, sc });
      }
      if (bestCandidates.some((b) => b.sc >= (album ? 200 : 170))) break;
    }

    bestCandidates.sort((a, b) => b.sc - a.sc);
    for (const { cand } of bestCandidates.slice(0, 4)) {
      const directUrl = await getHiCnFlacUrl(platform, cand.raw, targetDur);
      if (directUrl) {
        directUrlCache.set(cand.id, directUrl);
        return {
          matched: true,
          hifi_id: cand.id,
          stream_url: `/hifi/stream?id=${encodeURIComponent(cand.id)}`,
          title: cand.title,
          artist: cand.artist,
          album: cand.album,
          source: platform,
        };
      }
    }
  }

  // 2. Monochrome pool fallback
  for (const q of meta.searchQueries.slice(0, 3)) {
    try {
      const res = await fetchWithTimeout(
        `${TRACKS_BASE_URL}/search?q=${encodeURIComponent(q)}&limit=12`,
        { headers: { 'User-Agent': CHROME_130_UA, Accept: 'application/json' } },
        4000
      );
      if (!res.ok) continue;
      const data = await res.json();
      const tracks = data.tracks || [];
      const releaseMap = new Map((data.releases || []).map((r) => [r.releaseId || r.id, r.title]));

      const ranked = tracks
        .map((t) => {
          const trackId = t.recordingId || t.trackId || t.id;
          const artistStr =
            t.artistNames?.filter(Boolean).join(', ') ||
            t.artists?.map((a) => a.name || a.displayName).filter(Boolean).join(', ') ||
            '';
          const cand = {
            id: String(trackId),
            title: t.title || '',
            artist: artistStr,
            album: t.album_title || releaseMap.get(t.releaseId) || '',
            duration: t.duration ? parseDurationToSecs(t.duration) : 0,
            isrc: t.isrc,
          };
          const sc =
            isrc && cand.isrc && cand.isrc === isrc
              ? 200
              : scoreTrackCandidate(cand, meta, targetArtist, targetTitle, album, targetDur);
          return { cand, sc };
        })
        .filter((x) => x.sc >= 140)
        .sort((a, b) => b.sc - a.sc);

      for (const { cand } of ranked.slice(0, 3)) {
        const probe = await fetchWithTimeout(
          `${TRACKS_BASE_URL}/track/${encodeURIComponent(cand.id)}`,
          { headers: { 'User-Agent': CHROME_130_UA, Range: 'bytes=0-100' } },
          4000
        );
        if (probe.ok || probe.status === 206) {
          return {
            matched: true,
            hifi_id: cand.id,
            stream_url: `/hifi/stream?id=${encodeURIComponent(cand.id)}`,
            title: cand.title,
            artist: cand.artist,
            album: cand.album,
            source: 'monochrome',
          };
        }
      }
    } catch {}
  }

  return { matched: false, reason: 'No matching Hi-Fi FLAC track found' };
}

async function downloadAndCacheTrack(trackId) {
  if (activeCoordinators.has(trackId)) {
    return activeCoordinators.get(trackId);
  }

  const job = (async () => {
    let upstreamUrl = directUrlCache.get(trackId);
    if (!upstreamUrl) {
      if (trackId.startsWith('kuwo_') || trackId.startsWith('wyy_')) {
        throw new Error('Expired CDN link for cached track; re-resolve required');
      }
      upstreamUrl = `${TRACKS_BASE_URL}/track/${encodeURIComponent(trackId)}`;
    } else if (!isValidKuwoFlacUrl(upstreamUrl)) {
      directUrlCache.delete(trackId);
      throw new Error('Invalid non-FLAC upstream URL rejected');
    }

    const res = await fetchWithTimeout(
      upstreamUrl,
      { headers: { 'User-Agent': CHROME_130_UA, Accept: '*/*' } },
      60000
    );
    if (!res.ok) {
      const msg = `HTTP ${res.status}`;
      failureCooldownMap.set(trackId, Date.now() + (res.status === 429 ? 120_000 : 5_000));
      if (res.status === 403 || res.status === 410) directUrlCache.delete(trackId);
      throw new Error(msg);
    }

    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('audio/mpeg') || ct.includes('text/html')) {
      directUrlCache.delete(trackId);
      throw new Error(`Invalid upstream content-type: ${ct}`);
    }

    const arrBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrBuf);
    if (buf.length < MIN_VALID_FLAC_BYTES || !hasFlacMagicPrefix(buf)) {
      directUrlCache.delete(trackId);
      failureCooldownMap.set(trackId, Date.now() + 5_000);
      throw new Error(`Invalid FLAC payload (${buf.length} bytes)`);
    }

    const filePath = getCacheFilePath(trackId);
    const partPath = `${filePath}.${Date.now()}.part`;
    fs.writeFileSync(partPath, buf);
    fs.renameSync(partPath, filePath);
    return filePath;
  })();

  activeCoordinators.set(trackId, job);
  try {
    return await job;
  } finally {
    activeCoordinators.delete(trackId);
  }
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

  return downloadAndCacheTrack(trackId);
}

export async function handleHifiStream(req, res) {
  const trackId = String(req.query.id || req.params.trackId || '').replace(/\.flac$/i, '').trim();
  if (!trackId) return res.status(400).json({ error: 'Missing track id' });

  try {
    const filePath = await ensureCachedFlac(trackId, Boolean(req.query.retry));
    serveFileWithRange(req, res, filePath, 'audio/flac');
  } catch (err) {
    res.status(err.statusCode || 503).json({ error: err.message || 'Hi-Fi stream unavailable' });
  }
}
