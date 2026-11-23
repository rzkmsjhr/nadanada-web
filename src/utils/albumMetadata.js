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
