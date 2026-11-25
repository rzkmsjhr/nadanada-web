import { buildAlbumLibraryName } from './albumMetadata.js';

/**
 * Promote a played or queued playlist/saved-album entry to the top of the Library list
 * while preserving the relative order of all other entries.
 */
export function promotePlaylistToTop(playlists, playlistId, playedAt = Date.now()) {
  if (!Array.isArray(playlists) || !playlistId) return playlists;
  const idx = playlists.findIndex((pl) => pl && pl.id === playlistId);
  if (idx < 0) return playlists;

  const updated = { ...playlists[idx], lastPlayedAt: playedAt };
  if (idx === 0) {
    return [updated, ...playlists.slice(1)];
  }
  return [updated, ...playlists.slice(0, idx), ...playlists.slice(idx + 1)];
}

/**
 * Find the saved Library playlist ID matching an active Album view by name
 * ("Artist - Album Title" or "Album Title") or by shared track IDs.
 */
export function findMatchingSavedPlaylistId(
  playlists,
  { albumTitle = '', albumArtist = '', albumTracks = [] } = {}
) {
  if (!Array.isArray(playlists) || playlists.length === 0) return null;

  const norm = (s) => String(s || '').trim().toLowerCase();
  const formattedName = norm(
    buildAlbumLibraryName({ albumTitle, albumArtist, tracks: albumTracks })
  );
  const plainTitle = norm(String(albumTitle || '').replace(/^\s*Album:\s*/i, ''));
  const candidates = new Set([formattedName, plainTitle].filter(Boolean));

  for (const pl of playlists) {
    if (pl?.id && candidates.has(norm(pl.name))) {
      return pl.id;
    }
  }

  if (Array.isArray(albumTracks) && albumTracks.length > 0) {
    const albumIdSet = new Set(albumTracks.map((t) => String(t?.id || '')).filter(Boolean));
    if (albumIdSet.size === 0) return null;

    const minOverlap = Math.min(2, albumIdSet.size);
    let bestId = null;
    let bestOverlap = 0;

    for (const pl of playlists) {
      if (!pl?.id || !Array.isArray(pl.tracks) || pl.tracks.length === 0) continue;
      let overlap = 0;
      for (const t of pl.tracks) {
        if (albumIdSet.has(String(t?.id || ''))) overlap += 1;
      }
      if (overlap >= minOverlap && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestId = pl.id;
      }
    }
    return bestId;
  }

  return null;
}
