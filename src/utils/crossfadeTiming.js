/**
 * Timing, curve math, and background-safe ticker helpers for deck crossfades.
 */

export function computeCrossfadeVolumes(elapsedMs, totalMs, targetVol) {
  const safeTotal = Math.max(1, Number(totalMs) || 1);
  const safeElapsed = Math.max(0, Number(elapsedMs) || 0);
  const progress = Math.max(0, Math.min(1, safeElapsed / safeTotal));

  // Slightly front-loaded incoming ramp keeps perceived loudness steady through song outro fade-outs
  const factorOut = Math.cos(Math.pow(progress, 1.35) * (Math.PI / 2));
  const factorIn = Math.sin(Math.min(1, progress * 1.15) * (Math.PI / 2));
  const safeTarget = Math.max(0, Number(targetVol) || 0);

  return {
    progress,
    factorOut,
    factorIn,
    outVolume: safeTarget * factorOut,
    inVolume: safeTarget * factorIn,
    done: progress >= 1,
  };
}

export function shouldAllowBackgroundCrossfade({ activeMode, incomingMode, isHidden } = {}) {
  if (!isHidden) return true;
  return activeMode === 'audio' && incomingMode === 'audio';
}

/**
 * Run a periodic callback backed by an inline Blob Web Worker when available so
 * Chromium does not throttle background/minimized tab crossfade ramps to 1 Hz.
 */
export function startCrossfadeTicker(onTick, intervalMs = 30) {
  const safeInterval = Math.max(16, Math.round(Number(intervalMs) || 30));
  let stopped = false;
  let worker = null;
  let blobUrl = null;
  let fallbackInterval = null;

  const startFallbackInterval = () => {
    if (stopped || fallbackInterval !== null) return;
    fallbackInterval = setInterval(() => {
      if (!stopped) onTick();
    }, safeInterval);
  };

  const cleanupWorker = () => {
    if (worker) {
      try {
        worker.postMessage('stop');
      } catch {}
      try {
        worker.terminate();
      } catch {}
      worker = null;
    }
    if (blobUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {}
      blobUrl = null;
    }
  };

  const canUseWorker =
    typeof Worker !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function';

  if (canUseWorker) {
    try {
      const code = `const id = setInterval(() => self.postMessage(0), ${safeInterval}); self.onmessage = () => clearInterval(id);`;
      const blob = new Blob([code], { type: 'application/javascript' });
      blobUrl = URL.createObjectURL(blob);
      worker = new Worker(blobUrl);
      worker.onmessage = () => {
        if (!stopped) onTick();
      };
      worker.onerror = () => {
        cleanupWorker();
        startFallbackInterval();
      };
    } catch {
      cleanupWorker();
      startFallbackInterval();
    }
  } else {
    startFallbackInterval();
  }

  return function stopCrossfadeTicker() {
    if (stopped) return;
    stopped = true;
    cleanupWorker();
    if (fallbackInterval !== null) {
      clearInterval(fallbackInterval);
      fallbackInterval = null;
    }
  };
}
