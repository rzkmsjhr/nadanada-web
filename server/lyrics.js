import { LRCLIB_UA, YTM_UA, fetchWithTimeout } from './http.js';

const lyricsCache = new Map();

const LRCLIB_HEADERS = {
  'User-Agent': LRCLIB_UA,
  'Lrclib-Client': 'NadaNada (Web App)',
};

const RE_BRACKET_NOISE =
  /[\(\[\{（【](?:official(?:\s+(?:music|lyric|audio))?\s*(?:video|audio|mv)?|music\s*video|lyric\s*video|lyrics?|audio|hd|hq|4k|1080p|720p|mv|m\/v|topic|explicit|clean|remaster(?:ed)?(?:\s*\d{4})?|live(?:\s+at\s+[^\)\]\}]+)?|acoustic(?:\s+version)?|feat\.?\s+[^\)\]\}]*)[\)\]\}）】]/gi;
const RE_TRAILING_META =
  /\s*[-–—|]\s*(?:official(?:\s+(?:music|lyric|audio))?\s*(?:video|audio)|lyrics?|hd|hq|topic).*$/i;
const RE_NOISE_WORDS = /\b(?:official|music\s*video|lyric\s*video|audio|hd|hq|mv|m\/v)\b/gi;

function sanitizeTitle(title = '') {
  return String(title)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(RE_BRACKET_NOISE, ' ')
    .replace(RE_TRAILING_META, ' ')
    .replace(RE_NOISE_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripParentheticals(s = '') {
  return s.replace(/[\(\[\{（【][^\)\]\}）】]*[\)\]\}）】]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractParentheticalContents(s = '') {
  const out = [];
  for (const m of s.matchAll(/[\(\[（【]([^\)\]）】]+)[\)\]）】]/g)) {
    const t = m[1].trim();
    if (t && t.length <= 60 && !/official|video|audio|hd|hq|lyrics|mv|remaster/i.test(t)) {
      out.push(t);
    }
  }
  return out;
}

function sanitizeArtist(artist = '') {
  let clean = String(artist)
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*Official$/i, '')
    .replace(/\s*VEVO$/i, '')
    .trim();
  const dotIdx = clean.search(/[·•]/);
  if (dotIdx !== -1) clean = clean.slice(0, dotIdx).trim();

  const parts = clean.split(',').map((p) => p.trim()).filter(Boolean);
  const uniq = [...new Set(parts.map((p) => p.toLowerCase()))].map(
    (low) => parts.find((p) => p.toLowerCase() === low)
  );
  return uniq.join(', ').replace(/\s+/g, ' ').trim();
}

function extractSubArtists(artist = '') {
  const clean = sanitizeArtist(artist);
  if (!clean) return [];
  const subs = clean
    .split(/\s+(?:and|&|feat\.?|ft\.?|x|with)\s+|[,/]\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([clean, ...subs])];
}

function withTheVariants(title = '') {
  const out = [title];
  if (/^the\s+/i.test(title)) out.push(title.replace(/^the\s+/i, '').trim());
  else if (title) out.push(`The ${title}`);
  return out;
}

function normComp(s = '') {
  return stripParentheticals(s)
    .toLowerCase()
    .replace(/^the\s+/i, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function isArtistMatch(target, itemArtist) {
  if (!target || !itemArtist) return false;
  const tNorm = normComp(target);
  const iNorm = normComp(itemArtist);
  return Boolean(tNorm && iNorm && (tNorm === iNorm || (tNorm.length >= 3 && iNorm.includes(tNorm)) || (iNorm.length >= 3 && tNorm.includes(iNorm))));
}

function isTitleMatch(cand, itemTrack) {
  const cNorm = normComp(cand);
  const iNorm = normComp(itemTrack);
  if (!cNorm || !iNorm) return [false, false];
  if (cNorm === iNorm) return [true, true];
  if (iNorm.startsWith(cNorm) || cNorm.startsWith(iNorm)) return [true, false];
  return [false, false];
}

function isArtistMatchFlexible(candidateArtists, itemArtist) {
  if (!candidateArtists || candidateArtists.length === 0) return [true, false];
  for (const ca of candidateArtists) {
    const subs = extractSubArtists(ca);
    for (const s of subs) {
      if (normComp(s) === normComp(itemArtist)) return [true, true];
    }
    if (isArtistMatch(ca, itemArtist)) return [true, false];
  }
  return [false, false];
}

function extractCandidates(cleanTitle, cleanArtist) {
  const exactPairs = [];
  const candidateTitles = new Set();
  const candidateArtists = new Set(cleanArtist ? extractSubArtists(cleanArtist) : []);

  const addTitle = (t) => {
    for (const v of withTheVariants(t)) {
      if (v) candidateTitles.add(v);
      const core = stripParentheticals(v);
      if (core) candidateTitles.add(core);
      for (const p of extractParentheticalContents(v)) candidateTitles.add(p);
    }
  };

  addTitle(cleanTitle);

  const delimiters = [' - ', ' – ', ' — ', ' | ', ' ~ ', ' // ', ' / ', ' : '];
  for (const d of delimiters) {
    if (cleanTitle.includes(d)) {
      const idx = cleanTitle.indexOf(d);
      const left = cleanTitle.slice(0, idx).trim();
      const right = cleanTitle.slice(idx + d.length).trim();
      if (left && right) {
        if (cleanArtist && isArtistMatch(cleanArtist, left)) {
          candidateArtists.add(left);
          addTitle(right);
          exactPairs.push([right, left]);
        } else if (cleanArtist && isArtistMatch(cleanArtist, right)) {
          candidateArtists.add(right);
          addTitle(left);
          exactPairs.push([left, right]);
        } else {
          candidateArtists.add(left);
          candidateArtists.add(right);
          addTitle(right);
          addTitle(left);
          exactPairs.push([right, left], [left, right]);
        }
      }
      break;
    }
  }

  for (const t of candidateTitles) {
    if (candidateArtists.size > 0) {
      for (const a of candidateArtists) exactPairs.push([t, a]);
    }
  }

  const dedupPairs = [];
  const pairSeen = new Set();
  for (const [t, a] of exactPairs) {
    const key = `${t.toLowerCase()}:::${a.toLowerCase()}`;
    if (t && a && !pairSeen.has(key)) {
      pairSeen.add(key);
      dedupPairs.push([t, a]);
    }
  }

  const queries = [];
  const primaryTrack = stripParentheticals(cleanTitle) || cleanTitle;
  if (cleanArtist) {
    queries.push(`${cleanArtist} ${primaryTrack}`, `${cleanArtist} ${cleanTitle}`, `${primaryTrack} ${cleanArtist}`);
    const firstArtistWord = cleanArtist.split(/\s+/)[0];
    if (firstArtistWord) queries.push(`${primaryTrack} ${firstArtistWord}`);
  } else {
    queries.push(primaryTrack, cleanTitle);
  }

  return {
    exactPairs: dedupPairs.slice(0, 6),
    candidateTitles: [...candidateTitles],
    candidateArtists: [...candidateArtists],
    searchQueries: [...new Set(queries.map((q) => q.trim()).filter(Boolean))],
  };
}

function scoreCandidate(item, candidateTitles, candidateArtists, targetDuration) {
  let score = 0;
  const hasSynced = Boolean(item.syncedLyrics && item.syncedLyrics.trim());
  if (hasSynced) score += 1000;
  else if (item.instrumental) score += 200;
  else if (item.plainLyrics && item.plainLyrics.trim()) score += 100;
  else return { ok: false, durDiff: 9999, score: -10000 };

  const [aMatch, aExact] = isArtistMatchFlexible(candidateArtists, item.artistName || '');
  if (candidateArtists.length > 0 && !aMatch) return { ok: false, durDiff: 9999, score: -10000 };
  if (candidateArtists.length > 0) score += aExact ? 800 : 500;

  let tMatch = false;
  let tExact = false;
  for (const ct of candidateTitles) {
    const [m, ex] = isTitleMatch(ct, item.trackName || '');
    if (m) {
      tMatch = true;
      if (ex) tExact = true;
    }
  }
  if (candidateTitles.length > 0 && !tMatch) return { ok: false, durDiff: 9999, score: -10000 };
  score += tExact ? 800 : 400;

  let durDiff = 0;
  if (targetDuration && item.duration) {
    durDiff = Math.abs(Number(item.duration) - Number(targetDuration));
    if (durDiff <= 1.5) score += 1500 - durDiff * 20;
    else if (durDiff <= 3.5) score += 1000 - durDiff * 25;
    else if (durDiff <= 6.0) score += 500 - durDiff * 20;
    else if (durDiff <= 10.0) score += 150;
    else if (durDiff <= 20.0) score -= 200;
    else score -= 1000;
  }

  return { ok: true, durDiff, score };
}

async function fetchLrclib(cleanTitle, cleanArtist, targetDuration) {
  const { exactPairs, candidateTitles, candidateArtists, searchQueries } = extractCandidates(
    cleanTitle,
    cleanArtist
  );

  // Stage 1: Exact GET
  for (const [track, artist] of exactPairs) {
    try {
      let url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`;
      if (targetDuration && targetDuration > 0) {
        url += `&duration=${Math.round(targetDuration)}`;
      }
      const res = await fetchWithTimeout(url, { headers: LRCLIB_HEADERS }, 6000);
      if (res.ok) {
        const item = await res.json();
        if (item?.syncedLyrics?.trim()) {
          return {
            success: true,
            synced_lyrics: item.syncedLyrics,
            plain_lyrics: item.plainLyrics || null,
            source: 'LRCLIB',
            instrumental: Boolean(item.instrumental),
            error: null,
          };
        }
        if (item?.instrumental) {
          return {
            success: true,
            synced_lyrics: null,
            plain_lyrics: null,
            source: 'LRCLIB',
            instrumental: true,
            error: null,
          };
        }
      }
    } catch {}
  }

  // Stage 2: Targeted Search
  let bestItem = null;
  let bestScore = -10000;
  let bestDurDiff = 9999;

  for (const q of searchQueries.slice(0, 4)) {
    try {
      const res = await fetchWithTimeout(
        `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`,
        { headers: LRCLIB_HEADERS },
        6000
      );
      if (!res.ok) continue;
      const items = await res.json();
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const sc = scoreCandidate(item, candidateTitles, candidateArtists, targetDuration);
        if (!sc.ok) continue;
        if (item.syncedLyrics?.trim() && sc.durDiff <= 2.5 && sc.score > 2000) {
          return {
            success: true,
            synced_lyrics: item.syncedLyrics,
            plain_lyrics: item.plainLyrics || null,
            source: 'LRCLIB',
            instrumental: Boolean(item.instrumental),
            error: null,
          };
        }
        if (sc.score > bestScore) {
          bestScore = sc.score;
          bestDurDiff = sc.durDiff;
          bestItem = item;
        }
      }
    } catch {}
  }

  // Stage 3: Title-only Search if artist unknown
  if (candidateArtists.length === 0 && targetDuration > 10) {
    for (const ct of candidateTitles.slice(0, 2)) {
      try {
        const res = await fetchWithTimeout(
          `https://lrclib.net/api/search?track_name=${encodeURIComponent(ct)}`,
          { headers: LRCLIB_HEADERS },
          6000
        );
        if (!res.ok) continue;
        const items = await res.json();
        if (!Array.isArray(items)) continue;
        const matched = items
          .filter((it) => {
            if (!it.syncedLyrics?.trim() || !it.duration) return false;
            const [m, ex] = isTitleMatch(ct, it.trackName || '');
            return m && ex && Math.abs(it.duration - targetDuration) <= 2.0;
          })
          .sort((a, b) => Math.abs(a.duration - targetDuration) - Math.abs(b.duration - targetDuration))[0];
        if (matched) {
          return {
            success: true,
            synced_lyrics: matched.syncedLyrics,
            plain_lyrics: matched.plainLyrics || null,
            source: 'LRCLIB',
            instrumental: false,
            error: null,
          };
        }
      } catch {}
    }
  }

  // Stage 4: Best-scored fallback
  if (
    bestItem &&
    (!targetDuration || bestDurDiff <= 5.0) &&
    ((bestItem.syncedLyrics?.trim() && bestScore > 1500) || (bestItem.instrumental && bestScore > 500))
  ) {
    return {
      success: true,
      synced_lyrics: bestItem.syncedLyrics || null,
      plain_lyrics: bestItem.plainLyrics || null,
      source: 'LRCLIB',
      instrumental: Boolean(bestItem.instrumental),
      error: null,
    };
  }

  return null;
}

async function fetchYouTubeCaptions(videoId) {
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        headers: {
          'User-Agent': YTM_UA,
          'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
        },
      },
      10000
    );
    const html = await res.text();
    const m = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!m) return null;
    const tracks = JSON.parse(m[1]);
    if (!Array.isArray(tracks) || tracks.length === 0) return null;

    const picked =
      tracks.find((t) => /^(en|id)/i.test(t.languageCode || '')) || tracks[0];
    if (!picked?.baseUrl) return null;

    const jsonUrl = picked.baseUrl.includes('fmt=') ? picked.baseUrl : `${picked.baseUrl}&fmt=json3`;
    const capRes = await fetchWithTimeout(jsonUrl, { headers: { 'User-Agent': YTM_UA } }, 8000);
    if (!capRes.ok) return null;
    const capData = await capRes.json();

    const lines = [];
    for (const ev of capData?.events || []) {
      const startMs = ev.tStartMs;
      if (typeof startMs !== 'number') continue;
      const text = (ev.segs || [])
        .map((s) => s.utf8 || '')
        .join('')
        .replace(/\n/g, ' ')
        .trim();
      if (!text) continue;
      const totalSecs = startMs / 1000;
      const mins = Math.floor(totalSecs / 60);
      const secs = (totalSecs % 60).toFixed(2).padStart(5, '0');
      lines.push(`[${String(mins).padStart(2, '0')}:${secs}] ${text}`);
    }

    if (lines.length === 0) return null;
    return {
      success: true,
      synced_lyrics: lines.join('\n'),
      plain_lyrics: null,
      source: 'YouTube Captions',
      instrumental: false,
      error: null,
    };
  } catch {
    return null;
  }
}

export async function getLyrics(title = '', artist = '', duration = null, videoId = null) {
  const cleanTitle = sanitizeTitle(title);
  const cleanArtist = sanitizeArtist(artist);
  const durNum = duration ? Number(duration) : null;
  const cacheKey = videoId || `${cleanTitle}:::${cleanArtist}`;

  if (lyricsCache.has(cacheKey)) {
    return lyricsCache.get(cacheKey);
  }

  let res = await fetchLrclib(cleanTitle, cleanArtist, durNum);
  if (!res && videoId) {
    res = await fetchYouTubeCaptions(videoId);
  }

  const finalRes = res || {
    success: false,
    synced_lyrics: null,
    plain_lyrics: null,
    source: 'None',
    instrumental: false,
    error: 'No synced lyrics found for this track.',
  };

  if (finalRes.success) {
    if (lyricsCache.size > 500) {
      lyricsCache.delete(lyricsCache.keys().next().value);
    }
    lyricsCache.set(cacheKey, finalRes);
  }
  return finalRes;
}
