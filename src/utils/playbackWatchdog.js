/**
 * Wall-clock playback stall & missed-end watchdogs resilient to background tab timer throttling.
 */

export const AUDIO_STALL_TIMEOUT_MS = 5000;
export const RECOVERY_STALL_TIMEOUT_MS = 10000;
export const NEAR_END_STALL_TIMEOUT_MS = 2500;
export const YT_END_OVERSHOOT_GRACE_MS = 2500;
export const YT_NEAR_END_STALL_TIMEOUT_MS = 2000;
export const YT_HIDDEN_STALL_TIMEOUT_MS = 3500;

export function evaluateRecoveryTimeout({
  isRecovering,
  recoveringSinceMs,
  nowMs,
  timeoutMs = RECOVERY_STALL_TIMEOUT_MS,
}) {
  if (!isRecovering || !(recoveringSinceMs > 0)) return false;
  return Math.max(0, nowMs - recoveringSinceMs) >= timeoutMs;
}

export function evaluateAudioWatchdog({
  key,
  time,
  duration,
  paused,
  seekOnLoad = 0,
  nowMs,
  tracker,
}) {
  if (!tracker || tracker.key !== key) {
    return {
      action: 'none',
      resetRetryBudget: false,
      nextTracker: { key, lastTime: time, sinceMs: nowMs },
    };
  }

  if (paused || !(duration > 10)) {
    return {
      action: 'none',
      resetRetryBudget: false,
      nextTracker: { key, lastTime: time, sinceMs: nowMs },
    };
  }

  if (Math.abs(time - tracker.lastTime) >= 0.05) {
    const resetRetryBudget = time - tracker.lastTime > 0.05 && time > seekOnLoad + 2;
    return {
      action: 'none',
      resetRetryBudget,
      nextTracker: { key, lastTime: time, sinceMs: nowMs },
    };
  }

  const stalledMs = Math.max(0, nowMs - tracker.sinceMs);
  if (time >= duration - 1.5) {
    if (stalledMs >= NEAR_END_STALL_TIMEOUT_MS) {
      return {
        action: 'ended',
        resetRetryBudget: false,
        nextTracker: { key, lastTime: time, sinceMs: nowMs },
      };
    }
  } else if (stalledMs >= AUDIO_STALL_TIMEOUT_MS) {
    return {
      action: 'recover',
      resetRetryBudget: false,
      nextTracker: { key, lastTime: time, sinceMs: nowMs },
    };
  }

  return {
    action: 'none',
    resetRetryBudget: false,
    nextTracker: tracker,
  };
}

export function evaluateYouTubeWatchdog({
  key,
  playerState,
  time,
  duration,
  isHidden,
  nowMs,
  tracker,
}) {
  if (playerState === 0) {
    return {
      action: 'ended',
      nextTracker: {
        key,
        lastTime: time,
        lastAdvanceMs: nowMs,
        stateSinceMs: nowMs,
        lastState: 0,
      },
    };
  }

  if (!tracker || tracker.key !== key) {
    return {
      action: 'none',
      nextTracker: {
        key,
        lastTime: time,
        lastAdvanceMs: nowMs,
        stateSinceMs: nowMs,
        lastState: playerState,
      },
    };
  }

  const advanced = time > tracker.lastTime + 0.05;
  const nextLastTime = advanced ? time : tracker.lastTime;
  const nextLastAdvanceMs = advanced ? nowMs : tracker.lastAdvanceMs;
  const nextStateSinceMs = playerState !== tracker.lastState ? nowMs : tracker.stateSinceMs;
  const nextTracker = {
    key,
    lastTime: nextLastTime,
    lastAdvanceMs: nextLastAdvanceMs,
    stateSinceMs: nextStateSinceMs,
    lastState: playerState,
  };

  if (duration > 10) {
    if (nextLastTime >= duration - 1.5 && nowMs - nextLastAdvanceMs >= YT_NEAR_END_STALL_TIMEOUT_MS) {
      return { action: 'ended', nextTracker };
    }
    if (
      playerState === 1 &&
      nextLastTime > 0 &&
      nextLastTime + (nowMs - nextLastAdvanceMs) / 1000 >= duration + YT_END_OVERSHOOT_GRACE_MS / 1000
    ) {
      return { action: 'ended', nextTracker };
    }
  }

  if (
    isHidden &&
    playerState !== 1 &&
    playerState !== 3 &&
    nowMs - nextStateSinceMs >= YT_HIDDEN_STALL_TIMEOUT_MS
  ) {
    return { action: 'fallback', nextTracker };
  }

  return { action: 'none', nextTracker };
}
