/**
 * Helpers for keeping video tracks playing reliably when the browser tab is
 * inactive/hidden (using unlocked HTML5 audio continuity) and resuming video
 * cleanly in the foreground popup when returning to the tab.
 */

const VALID_YT_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

export function extractVideoId(track) {
  if (!track || typeof track !== 'object') return null;
  const candidate = track.youtube_id || track.id || '';
  return VALID_YT_ID_RE.test(String(candidate)) ? String(candidate) : null;
}

export function isTabHidden(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return false;
  if (doc.visibilityState === 'hidden') return true;
  if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) return true;
  return false;
}

export function buildVideoAudioStreamUrl(track) {
  const videoId = extractVideoId(track);
  if (!videoId) return null;
  return `/api/audio-stream?videoId=${encodeURIComponent(videoId)}`;
}

export function createBackgroundVideoTrack(
  track,
  seekSeconds = 0,
  nonce = Date.now(),
  { autoPromoteOnVisible = true } = {}
) {
  const streamUrl = buildVideoAudioStreamUrl(track);
  if (!streamUrl) return null;
  return {
    ...track,
    _fallbackAudioUrl: streamUrl,
    _isBackgroundVideoAudio: true,
    _autoPromoteOnVisible: Boolean(autoPromoteOnVisible),
    _seekOnLoad: Math.max(0, Math.floor(Number(seekSeconds) || 0)),
    _recoveryNonce: nonce,
  };
}

export function shouldUseBackgroundVideoAudio({ isVideo, isHidden }) {
  return Boolean(isVideo && isHidden);
}
