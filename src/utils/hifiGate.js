/**
 * Pre-Play Hi-Fi Gate helpers.
 *
 * Ensures audio tracks are checked/resolved to lossless FLAC *before* any
 * playback sound (either YouTube or HTML5 audio) starts, rather than swapping
 * sources mid-song after YouTube has already begun playing.
 */

export const PRE_PLAY_GATE_TIMEOUT_MS = 8000;

/**
 * Determine whether a track must pass through the async Pre-Play Hi-Fi gate
 * before audio or YouTube playback begins.
 */
export function shouldRunPrePlayGate(
  song,
  {
    isHifiEnabled = true,
    isEligible = true,
    isUserYoutubeForced = false,
    isFailedId = false,
    isCoolingDown = false,
    hifiVersion = null,
  } = {}
) {
  if (!song || !isHifiEnabled || !isEligible) return false;
  if (song.stream_url || song._fallbackAudioUrl) return false;
  if (song._userForcedYoutube || isUserYoutubeForced) return false;
  if (song._hifiFailed || isFailedId) return false;
  const alreadyCheckedCurrent = Boolean(
    song._hifiChecked && (hifiVersion == null || !song._hifiVersion || song._hifiVersion === hifiVersion)
  );
  if (alreadyCheckedCurrent) return false;
  if (isCoolingDown) return false;
  return true;
}

/**
 * Race Hi-Fi resolution against a bounded timeout so playback starts directly
 * in FLAC when available, or falls back cleanly to YouTube without stalling.
 */
export async function awaitPrePlayGateResolution(
  song,
  resolverFn,
  { timeoutMs = PRE_PLAY_GATE_TIMEOUT_MS, hifiVersion = null } = {}
) {
  let timerId = null;
  let timedOut = false;
  try {
    const resolved = await Promise.race([
      Promise.resolve().then(() => resolverFn(song)),
      new Promise((resolve) => {
        timerId = setTimeout(() => {
          timedOut = true;
          resolve({ stream_url: null, _hifiTransient: true, _gateTimedOut: true });
        }, timeoutMs);
      }),
    ]);

    const versionMeta = hifiVersion != null ? { _hifiVersion: hifiVersion } : {};

    if (resolved?.stream_url) {
      return {
        matched: true,
        timedOut: false,
        transient: false,
        track: {
          ...song,
          ...resolved,
          ...versionMeta,
          _hifiChecked: true,
          _hifiFailed: false,
          _userForcedYoutube: false,
        },
      };
    }

    return {
      matched: false,
      timedOut,
      transient: Boolean(resolved?._hifiTransient),
      track: {
        ...song,
        ...versionMeta,
        _hifiChecked: true,
      },
    };
  } catch {
    const versionMeta = hifiVersion != null ? { _hifiVersion: hifiVersion } : {};
    return {
      matched: false,
      timedOut: false,
      transient: true,
      track: {
        ...song,
        ...versionMeta,
        _hifiChecked: true,
      },
    };
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
}

/**
 * Decide whether a live Hi-Fi update on an already-mounted active deck may
 * swap its source. Mid-song YouTube->FLAC upgrades only happen when explicitly
 * requested by user manual retry, or before playback has begun.
 */
export function shouldApplyLiveHifiSwitch({
  isHifiEnabled,
  currentSong,
  deckSong,
  isPlaying,
  positionSecs,
}) {
  if (!isHifiEnabled || !currentSong?.stream_url || !deckSong) return false;
  if (deckSong.stream_url || currentSong._userForcedYoutube || currentSong._hifiFailed) {
    return false;
  }
  if (currentSong._manualHifiRetry) return true;
  return !isPlaying && (Number(positionSecs) || 0) < 0.25;
}
