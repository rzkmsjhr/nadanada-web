export function normalizeTrackText(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/\s*-\s*topic$/i, '')
    .replace(/\s*[\(\[]\s*(feat\.?|ft\.?|with|w\/|official\s*(?:music\s*)?(?:video|audio|lyric(?:s)?(?:\s*video)?|visualizer)|lyrics?|audio|hd|4k|remaster(?:ed)?|explicit)[^\)\]]*[\)\]]/gi, ' ')
    .replace(/\.\.\.+$/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildTrendingKey(title = '', artist = '') {
  return `${normalizeTrackText(title)}::${normalizeTrackText(artist)}`;
}

function hasTokenPhrase(haystack = '', needle = '') {
  if (!haystack || !needle) return false;
  return haystack === needle || ` ${haystack} `.includes(` ${needle} `);
}

function stripArtistFromNormalizedTitle(normTitle = '', normArtist = '') {
  if (!normTitle || !normArtist || normTitle === normArtist) return normTitle;
  const prefix = `${normArtist} `;
  if (normTitle.startsWith(prefix)) return normTitle.slice(prefix.length).trim();
  const suffix = ` ${normArtist}`;
  if (normTitle.endsWith(suffix)) return normTitle.slice(0, -suffix.length).trim();
  return normTitle;
}

export function buildQueueMatcher(queue = []) {
  const ids = new Set();
  const trendingKeys = new Set();
  const entries = [];

  for (const item of queue) {
    if (!item) continue;
    if (item.id) ids.add(String(item.id));
    if (item._trendingKey) trendingKeys.add(item._trendingKey);

    const normTitle = normalizeTrackText(item.title || '');
    const normArtist = normalizeTrackText(item.channel || item.artist || '');
    if (normTitle) {
      entries.push({ normTitle, normArtist });
    }
  }

  return { ids, trendingKeys, entries };
}

export function isTrackInQueue(matcher, candidate) {
  if (!matcher || !candidate) return false;
  const candId = candidate.id !== undefined && candidate.id !== null ? String(candidate.id).trim() : '';
  if (candId) {
    return matcher.ids.has(candId);
  }

  const rawTitle = String(candidate.title || '');
  const rawArtist = String(candidate.channel || candidate.artist || '');
  const tKey = buildTrendingKey(rawTitle, rawArtist);
  if (tKey !== '::' && matcher.trendingKeys.has(tKey)) {
    return true;
  }

  const candTitle = normalizeTrackText(rawTitle);
  const candArtist = normalizeTrackText(rawArtist);
  if (!candTitle) return false;
  const isTruncated = rawTitle.trim().endsWith('...');

  return matcher.entries.some((entry) => {
    const strippedEntryTitle = candArtist
      ? stripArtistFromNormalizedTitle(entry.normTitle, candArtist)
      : entry.normTitle;

    const titleMatches =
      entry.normTitle === candTitle ||
      (isTruncated && candTitle.length >= 4 && entry.normTitle.startsWith(candTitle)) ||
      (candArtist && strippedEntryTitle !== entry.normTitle && strippedEntryTitle === candTitle);

    if (!titleMatches) return false;
    if (!candArtist || !entry.normArtist) return true;
    return (
      hasTokenPhrase(entry.normArtist, candArtist) ||
      hasTokenPhrase(candArtist, entry.normArtist) ||
      hasTokenPhrase(entry.normTitle, candArtist)
    );
  });
}
