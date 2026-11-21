const COVER_OR_VARIANT_RE =
  /\b(tribute|cover|karaoke|instrumental|voicy|piano\s*ver(?:sion|ison)?|made\s*famous|lullaby|music\s*box|remix|edit|sped\s*up|slowed|reverb|8d|nightcore|ringtone|8-bit|parody|acoustic\s*version)\b/i;

const ARTIST_SPLIT_RE = /\s*(?:,|&|\/|;|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b|\bx\b|\band\b)\s*/i;

export function normalizeArtistText(str = '') {
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/([a-z0-9])!([a-z0-9])/g, '$1i$2')
    .replace(/\s*-\s*topic$/i, '')
    .replace(/\bvevo$/i, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTitleCore(str = '') {
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/([a-z0-9])!([a-z0-9])/g, '$1i$2')
    .replace(
      /\s*[\(\[]\s*(feat\.?|ft\.?|featuring|with|w\/|official\s*(?:music\s*)?(?:video|audio|lyric(?:s)?(?:\s*video)?|visualizer)|lyrics?|audio|hd|4k|remaster(?:ed)?|explicit)[^\)\]]*[\)\]]/gi,
      ' '
    )
    .replace(/\.\.\.+$/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFeaturedArtists(title = '') {
  const match = String(title).match(/\(\s*(?:w\/|with|feat\.?|ft\.?)\s*([^)]+)\)/i);
  if (!match) return [];
  return match[1]
    .split(ARTIST_SPLIT_RE)
    .map(normalizeArtistText)
    .filter((tok) => tok.length >= 2);
}

export function scoreTrendingCandidate(candidate, entry, idx = 0) {
  if (!candidate) return -999;
  const candTitleRaw = String(candidate.title || '');
  const candChannelRaw = String(candidate.channel || candidate.artist || '');
  const candAlbumRaw = String(candidate.album || '');
  const candMetaAll = `${candTitleRaw} ${candChannelRaw} ${candAlbumRaw}`;

  const targetTitleRaw = String(entry?.title || '');
  const targetArtist = normalizeArtistText(entry?.artist || '');
  const targetTitle = normalizeTitleCore(targetTitleRaw);
  const featArtists = extractFeaturedArtists(targetTitleRaw);

  let score = -idx * 0.5;

  // Reject tribute / cover / edit / piano / karaoke clones unless the chart entry itself asks for that variant
  if (COVER_OR_VARIANT_RE.test(candMetaAll) && !COVER_OR_VARIANT_RE.test(targetTitleRaw)) {
    score -= 250;
  }

  // Score artist match against candidate channel/artist
  if (targetArtist) {
    const candChannelNorm = normalizeArtistText(candChannelRaw);
    const candTokens = candChannelRaw
      .split(ARTIST_SPLIT_RE)
      .map(normalizeArtistText)
      .filter(Boolean);
    if (candTokens.some((tok) => tok === targetArtist)) {
      score += 120;
    } else if (candChannelNorm && (candChannelNorm.includes(targetArtist) || targetArtist.includes(candChannelNorm))) {
      score += 80;
    } else {
      score -= 80;
    }
  }

  // Score title similarity
  const candTitle = normalizeTitleCore(candTitleRaw);
  if (targetTitle && candTitle) {
    if (candTitle === targetTitle) {
      score += 60;
    } else if (candTitle.startsWith(targetTitle) || targetTitle.startsWith(candTitle)) {
      score += 40;
    } else {
      const targetWords = targetTitle.split(' ').filter(Boolean);
      const matched = targetWords.filter((w) => candTitle.includes(w)).length;
      score += targetWords.length > 0 ? Math.round((matched / targetWords.length) * 30) : 0;
    }
  }

  // Bonus when requested featured artists appear in candidate title/channel
  const candFullNorm = normalizeArtistText(`${candTitleRaw} ${candChannelRaw}`);
  for (const feat of featArtists) {
    if (candFullNorm.includes(feat)) score += 25;
  }

  return score;
}

export function pickBestTrendingResult(results, entry) {
  if (!Array.isArray(results) || results.length === 0) return null;
  let bestItem = results[0];
  let bestScore = -Infinity;
  results.forEach((cand, idx) => {
    const s = scoreTrendingCandidate(cand, entry, idx);
    if (s > bestScore) {
      bestScore = s;
      bestItem = cand;
    }
  });
  return { item: bestItem, score: bestScore };
}

export function buildCleanTrendingFallbackQuery(entry = {}) {
  const cleanArtist = normalizeArtistText(entry.artist || '');
  const cleanTitle = normalizeTitleCore(entry.title || '');
  const feats = extractFeaturedArtists(entry.title || '');
  return [cleanArtist, cleanTitle, ...feats].filter(Boolean).join(' ').trim();
}
