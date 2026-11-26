import { isAlbumArtTrack } from '../components/SpinningVinyl';

export function isVideoTrack(song) {
  if (!song) return false;
  return !isAlbumArtTrack(song) || song.item_type === 'video';
}

export function reorderTracks(list, fromIdx, toIdx) {
  if (
    !Array.isArray(list) ||
    !Number.isInteger(fromIdx) ||
    !Number.isInteger(toIdx) ||
    fromIdx === toIdx ||
    fromIdx < 0 ||
    toIdx < 0 ||
    fromIdx >= list.length ||
    toIdx >= list.length
  ) {
    return list;
  }
  const copy = [...list];
  const [moved] = copy.splice(fromIdx, 1);
  copy.splice(toIdx, 0, moved);
  return copy;
}

export function shiftIndexOnReorder(cur, fromIdx, toIdx) {
  if (cur < 0) return cur;
  if (cur === fromIdx) return toIdx;
  if (fromIdx < cur && toIdx >= cur) return cur - 1;
  if (fromIdx > cur && toIdx <= cur) return cur + 1;
  return cur;
}

export {
  normalizeTrackText,
  buildTrendingKey,
  buildQueueMatcher,
  isTrackInQueue,
} from './queueMatcher.js';
