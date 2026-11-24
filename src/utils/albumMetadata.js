const CJK_OR_HANGUL_REGEX =
  /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF\uAC00-\uD7AF\u1100-\u11FF]/;

const HIFI_COMPILATION_REGEX =
  /(?:合集|珍藏|精选|精選|英文|欧美|歐美|金曲|老歌|天籁|天籟|系列|第[一二三四五六七八九十\d]+[辑輯]|팝송|베스트|모음|컴필레이션)/i;

/**
 * Check whether a track is backed by Kuwo or NetEase (WYY) Hi-Fi streams.
 */
export function isKuwoOrWyyTrack(track) {
  if (!track || typeof track !== 'object') return false;
  if (track.source === 'kuwo' || track.source === 'wyy') return true;
  const hifiId = String(track.hifi_id || '');
  return hifiId.startsWith('kuwo_') || hifiId.startsWith('wyy_');
}

/**
 * Detect Chinese/Korean compilation album strings leaked from Kuwo/WYY onto
 * non-CJK tracks while preserving legitimate CJK tracks and mixed-script albums.
 */
export function isLikelyPoisonedHifiAlbum(album, track) {
  const cleanAlbum = String(album || '').trim();
  if (!cleanAlbum || !track || !isKuwoOrWyyTrack(track)) return false;

  const trackIdentity = `${track.title || ''} ${track.channel || ''} ${track.artist || ''}`;
  if (CJK_OR_HANGUL_REGEX.test(trackIdentity)) return false;
  if (!CJK_OR_HANGUL_REGEX.test(cleanAlbum)) return false;

  return !/[A-Za-z]/.test(cleanAlbum) || HIFI_COMPILATION_REGEX.test(cleanAlbum);
}

/**
 * Return a trimmed album string or empty string if poisoned by Kuwo/WYY compilation metadata.
 */
export function sanitizeTrackAlbum(album, track) {
  const trimmed = String(album || '').trim();
  if (!trimmed) return '';
  if (isLikelyPoisonedHifiAlbum(trimmed, track)) return '';
  return trimmed;
}

/**
 * Prefer authoritative YouTube album metadata over stored track.album,
 * filtering out leaked Kuwo/WYY compilation names when YouTube info is absent.
 */
export function resolveDisplayAlbumTitle(track, cachedAlbumInfo = null) {
  const authoritative = String(cachedAlbumInfo?.album || '').trim();
  if (authoritative) return authoritative;
  return sanitizeTrackAlbum(track?.album, track);
}

const GENERIC_ARTIST_NAMES = new Set(['unknown artist', 'various artists', 'youtube', 'album']);
const RELEASE_TYPE_TOKENS = new Set([
  'album',
  'ep',
  'single',
  'live album',
  'compilation',
  'soundtrack',
  'playlist',
  'song',
  'video',
]);

function isMetadataSubtitleSegment(part) {
  const clean = String(part || '').trim();
  if (!clean) return true;
  if (RELEASE_TYPE_TOKENS.has(clean.toLowerCase())) return true;
  if (/^(?:19|20)\d{2}$/.test(clean)) return true;
  if (/^\d+\s+(?:songs?|tracks?)$/i.test(clean)) return true;
  return false;
}

function cleanArtistLabel(raw) {
  let text = String(raw || '').trim();
  if (/[•·]/.test(text)) {
    const candidates = text
      .split(/\s*[•·]\s*/)
      .map((part) => part.trim())
      .filter((part) => !isMetadataSubtitleSegment(part));
    text = candidates[0] || '';
  }

  const cleaned = text
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\bVEVO$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || GENERIC_ARTIST_NAMES.has(cleaned.toLowerCase())) return '';
  return cleaned;
}

/**
 * Format default library save name for an album as "Artist - Album Title",
 * inferring the dominant artist from tracks if the album artist is absent.
 */
export function buildAlbumLibraryName({ albumTitle = '', albumArtist = '', tracks = [] } = {}) {
  let artist = cleanArtistLabel(albumArtist);
  if (!artist && Array.isArray(tracks) && tracks.length > 0) {
    const counts = new Map();
    for (const track of tracks) {
      const candidate = cleanArtistLabel(track?.artist || track?.channel);
      if (!candidate) continue;
      counts.set(candidate, (counts.get(candidate) || 0) + 1);
    }
    let bestCount = 0;
    for (const [candidate, count] of counts.entries()) {
      if (count > bestCount) {
        bestCount = count;
        artist = candidate;
      }
    }
  }

  const title = String(albumTitle || '')
    .replace(/^\s*Album:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (artist && title) {
    if (title.toLowerCase().startsWith(`${artist.toLowerCase()} - `)) {
      return title;
    }
    return `${artist} - ${title}`;
  }
  return title || artist || 'My Album';
}
