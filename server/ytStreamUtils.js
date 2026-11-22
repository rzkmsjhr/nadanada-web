export const MAX_YT_AUDIO_CHUNK_BYTES = 1048576; // 1 MiB bounded chunk avoids YouTube CDN 403 throttling

/**
 * Parse an HTTP Range header (e.g. "bytes=0-", "bytes=0-1023") into { start, end }.
 */
export function parseByteRangeHeader(rangeHeader) {
  if (!rangeHeader || typeof rangeHeader !== 'string') return null;
  const m = rangeHeader.match(/bytes=(\d+)-(\d*)/i);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] !== '' ? Number(m[2]) : null;
  if (!Number.isFinite(start) || start < 0) return null;
  if (end !== null && (!Number.isFinite(end) || end < start)) return null;
  return { start, end };
}

/**
 * Compute an upstream bounded chunk range within [start, total - 1] and <= 1 MiB.
 * Prevents Google CDN 403s on open-ended (`bytes=0-`) or tail-overshooting Range requests.
 */
export function computeYtAudioChunkRange(
  parsedRange,
  contentLength = 0,
  maxChunkBytes = MAX_YT_AUDIO_CHUNK_BYTES
) {
  const total = Number(contentLength) > 0 ? Number(contentLength) : 0;
  const start = parsedRange?.start ?? 0;
  if (total > 0 && start >= total) {
    return { unsatisfiable: true, total };
  }
  const maxEndForChunk = start + maxChunkBytes - 1;
  const requestedEnd = parsedRange?.end != null ? parsedRange.end : maxEndForChunk;
  let end = Math.min(requestedEnd, maxEndForChunk);
  if (total > 0) {
    end = Math.min(end, total - 1);
  }
  return {
    unsatisfiable: false,
    start,
    end,
    total,
    header: `bytes=${start}-${end}`,
  };
}

const VIDEO_TAG_RE =
  /\s*[\(\[]\s*(?:(?:4k|hd|hq|remastered)\s+)*(?:(?:official\s*)?(?:(?:music|lyric|lyrics)\s*)?video|visualizer|official\s*visualizer|official\s*audio|audio|hd|4k|hq|mv|m\/v|live\s*video)\s*(?:[\s-]*(?:4k|hd|hq))?\s*[\)\]]/gi;
const VIDEO_TRAILING_DASH_RE =
  /\s*[-–|]\s*(?:official\s*(?:music\s*|lyric\s*|lyrics\s*)?video|music\s*video|lyric\s*video|visualizer|mv)\s*$/i;

/**
 * Strip YouTube music-video markers so video tracks can match studio Hi-Fi audio.
 */
export function cleanVideoTitleForHifi(rawTitle = '') {
  return String(rawTitle || '')
    .replace(VIDEO_TAG_RE, '')
    .replace(VIDEO_TRAILING_DASH_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a YouTube uploader/channel name (e.g. "Artist - Topic", "ArtistVEVO") to an artist string.
 */
export function cleanVideoChannelForHifi(rawChannel = '') {
  let ch = String(rawChannel || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s+Topic$/i, '')
    .replace(/\s+Official$/i, '')
    .replace(/\s+VEVO$/i, '')
    .trim();
  const gluedVevo = /^(.{2,})VEVO$/i.exec(ch);
  if (gluedVevo) {
    ch = gluedVevo[1].trim();
  }
  return ch;
}

/**
 * Derive clean { title, channel } hints from raw video metadata or oEmbed "Artist - Title" strings.
 */
export function parseVideoMetadataForHifi(rawTitle = '', rawChannel = '') {
  const cleanedChannel = cleanVideoChannelForHifi(rawChannel);
  let cleanedTitle = cleanVideoTitleForHifi(rawTitle);
  let resolvedChannel = cleanedChannel;

  const dashMatch = /^(.+?)\s+[-–]\s+(.+)$/.exec(cleanedTitle);
  if (dashMatch) {
    const leadArtist = dashMatch[1].trim();
    const trackPart = dashMatch[2].trim();
    if (leadArtist && trackPart) {
      cleanedTitle = cleanVideoTitleForHifi(trackPart) || trackPart;
      const rawLooksHandle =
        !resolvedChannel ||
        /vevo$/i.test(String(rawChannel || '').trim()) ||
        !/\s/.test(resolvedChannel);
      if (rawLooksHandle || leadArtist.toLowerCase() === resolvedChannel.toLowerCase()) {
        resolvedChannel = cleanVideoChannelForHifi(leadArtist) || leadArtist;
      }
    }
  }

  return {
    title: cleanedTitle,
    channel: resolvedChannel,
  };
}
