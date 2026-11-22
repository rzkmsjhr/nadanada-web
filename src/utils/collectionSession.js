/**
 * Helpers for isolated collection playback sessions (Playlists and Albums)
 * that play tracks directly without modifying or overwriting the main Up Next queue.
 */

export function buildIsolatedSession(prev, { mode, key, index, tracks = null }) {
  const isSameCollection = Boolean(prev && prev.mode === mode && prev.key === key);
  const next = {
    mode,
    key,
    index,
    overrides: isSameCollection ? prev.overrides || {} : {},
  };
  if (mode === 'album') {
    next.tracks = Array.isArray(tracks) ? tracks : isSameCollection ? prev.tracks || [] : [];
  }
  return next;
}

export function adjustIsolatedSessionOnRemove(prev, { mode, key, removedIdx, nextTracks = null }) {
  if (!prev || prev.mode !== mode || prev.key !== key) return prev;
  const sourceTracks = Array.isArray(nextTracks)
    ? nextTracks
    : Array.isArray(prev.tracks)
    ? prev.tracks.filter((_, i) => i !== removedIdx)
    : [];
  const nextLen = sourceTracks.length;
  if (nextLen === 0) return null;

  let nextIdx = prev.index;
  if (removedIdx < prev.index) nextIdx = Math.max(0, prev.index - 1);
  else if (removedIdx === prev.index) nextIdx = Math.min(removedIdx, nextLen - 1);

  const updated = { ...prev, index: nextIdx };
  if (mode === 'album') {
    updated.tracks = sourceTracks;
  }
  return updated;
}

export function mergeSessionTrackOverrides(prev, updatedList) {
  if (!prev || !Array.isArray(updatedList)) return prev;
  const nextOverrides = { ...(prev.overrides || {}) };
  for (const item of updatedList) {
    if (item?.id) nextOverrides[String(item.id)] = item;
  }
  return { ...prev, overrides: nextOverrides };
}
