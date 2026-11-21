import { isAlbumArtTrack } from '../components/SpinningVinyl';

export function isVideoTrack(song) {
  if (!song) return false;
  return !isAlbumArtTrack(song) || song.item_type === 'video';
}

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

export function buildQueueMatcher(queue = []) {
  const ids = new Set();
  const trendingKeys = new Set();
  const entries = [];

  for (const item of queue) {
    if (!item) continue;
    if (item.id) ids.add(String(item.id));
    if (item._trendingKey) trendingKeys.add(item._trendingKey);

    const rawTitle = String(item.title || '').toLowerCase();
    const normTitle = normalizeTrackText(item.title || '');
    const normArtist = normalizeTrackText(item.channel || item.artist || '');
    if (normTitle) {
      entries.push({ normTitle, normArtist, rawTitle });
    }
  }

  return { ids, trendingKeys, entries };
}

export function isTrackInQueue(matcher, candidate) {
  if (!matcher || !candidate) return false;
  if (candidate.id && matcher.ids.has(String(candidate.id))) {
    return true;
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
    const titleMatches =
      entry.normTitle === candTitle ||
      (isTruncated && candTitle.length >= 4 && entry.normTitle.startsWith(candTitle)) ||
      (candArtist && entry.normTitle.includes(candTitle) && (entry.normArtist.includes(candArtist) || entry.rawTitle.includes(candArtist)));

    if (!titleMatches) return false;
    if (!candArtist || !entry.normArtist) return true;
    return (
      entry.normArtist.includes(candArtist) ||
      candArtist.includes(entry.normArtist) ||
      entry.rawTitle.includes(candArtist)
    );
  });
}
