import { extractVideoId } from './videoPlayback.js';

const SCRIPT_PATTERNS = [
  ['hangul', /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/],
  ['kana', /[\u3040-\u30FF]/],
  ['han', /[\u4E00-\u9FFF]/],
  ['cyrillic', /[\u0400-\u04FF]/],
  ['arabic', /[\u0600-\u06FF]/],
  ['thai', /[\u0E00-\u0E7F]/],
  ['devanagari', /[\u0900-\u097F]/],
];

const DERIVATIVE_MARKERS = [
  'karaoke',
  'off vocal',
  'backing track',
  'instrumental',
  'slowed',
  'reverb',
  'sped up',
  'nightcore',
  '8d audio',
  'mashup',
  'piano cover',
  'guitar cover',
  'drum cover',
  'lyric video',
  'lyrics video',
  'cover by',
];

export function parseTrackDurationSecs(dur) {
  if (!dur) return 0;
  if (typeof dur === 'number') {
    if (!Number.isFinite(dur) || dur <= 0) return 0;
    return dur > 1000 ? Math.round(dur / 1000) : Math.round(dur);
  }
  const raw = String(dur).trim();
  if (/^\d+$/.test(raw)) return parseInt(raw, 10) || 0;
  const parts = raw.split(':').map((n) => parseInt(n, 10) || 0);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

export function normalizeEndlessArtist(track) {
  if (!track) return '';
  let ch = String(track.channel || track.artist || '')
    .toLowerCase()
    .replace(/-\s*topic|vevo|\bofficial\b|\bchannel\b/gi, '')
    .trim();
  if (!ch && track.title) {
    const parts = String(track.title).split(/\s+[-–~]\s+/);
    if (parts.length > 1) ch = parts[0].trim().toLowerCase();
  }
  return ch.replace(/[^\p{L}\p{N}]/gu, '');
}

export function normalizeEndlessTitle(title = '') {
  return String(title || '')
    .toLowerCase()
    .replace(
      /\s*[\(\[]\s*(?:feat\.?|ft\.?|with|w\/|remaster(?:ed)?|official\s*(?:music\s*)?(?:video|audio)|lyric(?:s)?(?:\s*video)?|explicit|anniversary|deluxe)[^\)\]]*[\)\]]/gi,
      ' '
    )
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractEndlessSeedTracks(queue = [], { maxSeeds = 3 } = {}) {
  if (!Array.isArray(queue) || queue.length === 0) {
    return { seeds: [], userBlockTracks: [], seedSignature: '' };
  }

  let lastUserIdx = -1;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i] && !queue[i].isEndlessGenerated) {
      lastUserIdx = i;
      break;
    }
  }

  const userBlockTracks = [];
  if (lastUserIdx >= 0) {
    for (let i = lastUserIdx; i >= 0; i--) {
      const item = queue[i];
      if (!item || item.isEndlessGenerated) break;
      userBlockTracks.unshift(item);
    }
  }

  let validUserSeeds = userBlockTracks.filter((t) => Boolean(extractVideoId(t)));
  if (validUserSeeds.length === 0) {
    const fallback = queue.find((t) => Boolean(extractVideoId(t)));
    if (fallback) validUserSeeds = [fallback];
  }

  const seeds = [];
  const seenIds = new Set();
  const seenArtists = new Set();

  const tryAdd = (track, requireDistinctArtist = true) => {
    if (!track || seeds.length >= maxSeeds) return;
    const vid = extractVideoId(track);
    if (!vid || seenIds.has(vid)) return;
    const artist = normalizeEndlessArtist(track);
    if (requireDistinctArtist && artist && seenArtists.has(artist)) return;
    seenIds.add(vid);
    if (artist) seenArtists.add(artist);
    seeds.push(track);
  };

  if (validUserSeeds.length <= maxSeeds) {
    for (let i = validUserSeeds.length - 1; i >= 0; i--) {
      tryAdd(validUserSeeds[i], false);
    }
  } else {
    const last = validUserSeeds.length - 1;
    const first = 0;
    const middle = Math.floor(last / 2);
    const priorityIndices = [last, first, middle];

    for (const idx of priorityIndices) {
      tryAdd(validUserSeeds[idx], true);
    }
    for (let i = validUserSeeds.length - 1; i >= 0 && seeds.length < maxSeeds; i--) {
      tryAdd(validUserSeeds[i], true);
    }
    for (const idx of priorityIndices) {
      tryAdd(validUserSeeds[idx], false);
    }
    for (let i = validUserSeeds.length - 1; i >= 0 && seeds.length < maxSeeds; i--) {
      tryAdd(validUserSeeds[i], false);
    }
  }

  return {
    seeds,
    userBlockTracks,
    seedSignature: seeds.map(extractVideoId).filter(Boolean).join('|'),
  };
}

export function detectNonLatinScripts(text = '') {
  const found = new Set();
  const str = String(text || '');
  if (!str) return found;
  for (const [name, re] of SCRIPT_PATTERNS) {
    if (re.test(str)) found.add(name);
  }
  return found;
}

export function buildAllowedScripts(seedTracks = [], primaryMix = []) {
  const allowed = new Set();
  for (const t of seedTracks) {
    const scripts = detectNonLatinScripts(`${t?.title || ''} ${t?.channel || t?.artist || ''}`);
    for (const s of scripts) allowed.add(s);
  }

  // Permit scripts that dominate the primary mix top-10 (e.g. Romanized K-Pop/J-Pop seeds)
  const mixCounts = new Map();
  for (const t of (primaryMix || []).slice(0, 10)) {
    const scripts = detectNonLatinScripts(`${t?.title || ''} ${t?.channel || t?.artist || ''}`);
    for (const s of scripts) {
      mixCounts.set(s, (mixCounts.get(s) || 0) + 1);
    }
  }
  for (const [s, count] of mixCounts.entries()) {
    if (count >= 2) allowed.add(s);
  }
  return allowed;
}

export function computeMixCohesion(candidateMix = [], primaryMix = []) {
  if (!Array.isArray(candidateMix) || candidateMix.length === 0 || !Array.isArray(primaryMix) || primaryMix.length === 0) {
    return { overlapCount: 0, overlapRatio: 0 };
  }

  const primaryArtists = new Set(primaryMix.map(normalizeEndlessArtist).filter(Boolean));
  const candArtists = new Set(candidateMix.map(normalizeEndlessArtist).filter(Boolean));

  if (candArtists.size > 0 && primaryArtists.size > 0) {
    let overlapCount = 0;
    for (const a of candArtists) {
      if (primaryArtists.has(a)) overlapCount++;
    }
    return {
      overlapCount,
      overlapRatio: overlapCount / Math.max(1, candArtists.size),
    };
  }

  const primaryIds = new Set(primaryMix.map((t) => extractVideoId(t) || String(t?.id || '')).filter(Boolean));
  const candIds = new Set(candidateMix.map((t) => extractVideoId(t) || String(t?.id || '')).filter(Boolean));
  let overlapCount = 0;
  for (const id of candIds) {
    if (primaryIds.has(id)) overlapCount++;
  }
  return {
    overlapCount,
    overlapRatio: overlapCount / Math.max(1, candIds.size),
  };
}

export function isCohesiveExpansionMix(candidateMix, primaryMix) {
  const { overlapCount, overlapRatio } = computeMixCohesion(candidateMix, primaryMix);
  return overlapCount >= 2 || overlapRatio >= 0.12;
}

export function isLowQualityEndlessCandidate(track, userBlockTracks = []) {
  if (!track) return true;
  const text = `${track.title || ''} ${track.channel || track.artist || ''}`.toLowerCase();
  const userTexts = (userBlockTracks || []).map(
    (u) => `${u?.title || ''} ${u?.channel || u?.artist || ''}`.toLowerCase()
  );

  for (const marker of DERIVATIVE_MARKERS) {
    if (text.includes(marker) && !userTexts.some((ut) => ut.includes(marker))) {
      return true;
    }
  }

  const durSecs = parseTrackDurationSecs(track.duration);
  if (durSecs > 0) {
    if (
      durSecs < 105 &&
      !userBlockTracks.some((u) => {
        const d = parseTrackDurationSecs(u?.duration);
        return d > 0 && d < 110;
      })
    ) {
      return true;
    }
    if (durSecs > 540 && !userBlockTracks.some((u) => parseTrackDurationSecs(u?.duration) > 540)) {
      return true;
    }
  }

  return false;
}

export function pickCoreExpansionSeed(
  primaryMix = [],
  { usedSeedIds = new Set(), userBlockTracks = [], isVideoFn = null } = {}
) {
  if (!Array.isArray(primaryMix) || primaryMix.length === 0) return null;

  const usedArtists = new Set((userBlockTracks || []).map(normalizeEndlessArtist).filter(Boolean));
  for (const t of primaryMix) {
    const vid = extractVideoId(t);
    if (vid && usedSeedIds.has(vid)) {
      const a = normalizeEndlessArtist(t);
      if (a) usedArtists.add(a);
    }
  }

  const topOrdered = primaryMix
    .map((track, idx) => ({ track, rank: Number.isFinite(track?.mix_rank) ? track.mix_rank : idx }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 15)
    .map((x) => x.track);

  const eligible = topOrdered.filter((track) => {
    const vid = extractVideoId(track);
    if (!vid || usedSeedIds.has(vid)) return false;
    if (isVideoFn?.(track)) return false;
    if (isLowQualityEndlessCandidate(track, userBlockTracks)) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  const distinctArtistPick = eligible.find((t) => {
    const a = normalizeEndlessArtist(t);
    return a && !usedArtists.has(a);
  });
  return distinctArtistPick || eligible[0];
}

function artistsRoughlyMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a));
}

export function pickNextEndlessCandidate({
  queue = [],
  seedMixes = [],
  userBlockTracks = [],
  recentArtistWindow = 6,
  isVideoFn = null,
  isInQueueFn = null,
}) {
  if (!Array.isArray(seedMixes) || seedMixes.length === 0) return null;

  const existingIds = new Set();
  const existingTitleArtist = new Set();
  const allQueueArtists = new Set();

  for (const t of queue) {
    if (!t) continue;
    const vid = extractVideoId(t);
    if (vid) existingIds.add(vid);
    if (t.id) existingIds.add(String(t.id));
    const nt = normalizeEndlessTitle(t.title || '');
    const na = normalizeEndlessArtist(t);
    if (nt && na) existingTitleArtist.add(`${nt}::${na}`);
    if (na) allQueueArtists.add(na);
  }

  const recentArtists = queue.slice(-recentArtistWindow).map(normalizeEndlessArtist).filter(Boolean);
  const sessionArtistCounts = new Map();
  for (const t of queue.slice(-20)) {
    const a = normalizeEndlessArtist(t);
    if (a) sessionArtistCounts.set(a, (sessionArtistCounts.get(a) || 0) + 1);
  }

  const primaryMix = seedMixes.find((m) => !m?.isCoreNeighbor)?.tracks || seedMixes[0]?.tracks || [];
  const allowedScripts = buildAllowedScripts(userBlockTracks, primaryMix);
  const userAllowsVersionTag = (userBlockTracks || []).some((u) => /\bver\.?\b/i.test(u?.title || ''));

  const artistToMixIndices = new Map();
  const artistInUserSeedMix = new Set();
  const candidateMap = new Map();

  seedMixes.forEach((mix, mixIdx) => {
    if (!mix || !Array.isArray(mix.tracks)) return;
    const weight = Number.isFinite(mix.weight) ? mix.weight : 1;
    const isUserMix = !mix.isCoreNeighbor;
    const seenVidsInMix = new Set();

    mix.tracks.forEach((track, itemIdx) => {
      if (!track) return;
      const artist = normalizeEndlessArtist(track);
      if (artist) {
        if (!artistToMixIndices.has(artist)) artistToMixIndices.set(artist, new Set());
        artistToMixIndices.get(artist).add(mixIdx);
        if (isUserMix) artistInUserSeedMix.add(artist);
      }

      if (isVideoFn?.(track)) return;
      const vid = extractVideoId(track);
      if (!vid || seenVidsInMix.has(vid)) return;
      seenVidsInMix.add(vid);

      if (existingIds.has(vid)) return;
      const nt = normalizeEndlessTitle(track.title || '');
      if (nt && artist && existingTitleArtist.has(`${nt}::${artist}`)) return;
      if (isInQueueFn?.(track)) return;

      const rank = Number.isFinite(track.mix_rank) ? track.mix_rank : itemIdx;
      const rankContrib = Math.max(0, 24 - rank * 0.8) * weight;

      const existing = candidateMap.get(vid);
      if (existing) {
        existing.hitMixIndices.add(mixIdx);
        if (isUserMix) existing.inUserSeedMix = true;
        existing.bestRank = Math.min(existing.bestRank, rank);
        existing.rankScoreSum += rankContrib;
      } else {
        candidateMap.set(vid, {
          track,
          hitMixIndices: new Set([mixIdx]),
          inUserSeedMix: isUserMix,
          bestRank: rank,
          rankScoreSum: rankContrib,
        });
      }
    });
  });

  if (candidateMap.size === 0) return null;

  const scored = [];
  for (const entry of candidateMap.values()) {
    const { track, hitMixIndices, bestRank, rankScoreSum } = entry;
    const hitCount = hitMixIndices.size;
    const artist = normalizeEndlessArtist(track);
    const artistMixCount = artist ? artistToMixIndices.get(artist)?.size || 1 : 1;

    let score = rankScoreSum;
    score += (hitCount - 1) * 45;
    score += (artistMixCount - 1) * 28;
    if (entry.inUserSeedMix) score += 22;
    if (artist && artistInUserSeedMix.has(artist)) score += 16;
    if (seedMixes.length >= 2 && hitCount === 1 && artistMixCount === 1) score -= 30;

    const candScripts = detectNonLatinScripts(`${track.title || ''} ${track.channel || track.artist || ''}`);
    for (const sc of candScripts) {
      if (!allowedScripts.has(sc)) {
        score -= 80;
        break;
      }
    }

    const durSecs = parseTrackDurationSecs(track.duration);
    if (durSecs > 0 && durSecs < 130) score -= 25;
    if (!userAllowsVersionTag && /\([^)]*\bver\.?\b[^)]*\)/i.test(track.title || '')) {
      score -= 18;
    }

    if (artist) {
      if (recentArtists.some((ra) => artistsRoughlyMatch(ra, artist))) {
        score -= 70;
      }
      const sessCount = sessionArtistCounts.get(artist) || 0;
      if (sessCount >= 2) {
        score -= 25 * (sessCount - 1);
      }
      if (!allQueueArtists.has(artist)) {
        score += 8;
      }
    }

    scored.push({
      track,
      score,
      hitCount,
      bestRank,
      isLowQuality: isLowQualityEndlessCandidate(track, userBlockTracks),
    });
  }

  const clean = scored.filter((item) => !item.isLowQuality);
  const pool = clean.length > 0 ? clean : scored;

  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
    return a.bestRank - b.bestRank;
  });

  return pool[0]?.track || null;
}
