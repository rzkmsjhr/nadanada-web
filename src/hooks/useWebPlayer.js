import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import {
  HIFI_MATCHER_VERSION,
  isHifiEligibleTrack,
  getCachedHifi,
  isKnownUnmatchedHifi,
  resolveHifiForTrack,
  parseDurationToSecs,
  isHifiCoolingDown,
  isUserYoutubeForced,
} from '../services/hifiResolver';
import {
  shouldRunPrePlayGate,
  awaitPrePlayGateResolution,
  shouldApplyLiveHifiSwitch,
} from '../utils/hifiGate';
import {
  buildVideoAudioStreamUrl,
  createHiddenSongAudioTrack,
  isTabHidden,
  shouldUseHiddenSongAudioFallback,
} from '../utils/videoPlayback';
import {
  primeAudioKeepalive,
  startAudioKeepalive,
  stopAudioKeepalive,
} from '../utils/backgroundAudioKeepalive';
import {
  evaluateAudioWatchdog,
  evaluateYouTubeWatchdog,
} from '../utils/playbackWatchdog';

export function useWebPlayer({
  currentSong,
  nextSong,
  hasNext,
  isHifiEnabled,
  crossfadeDuration,
  repeatMode,
  suppressMediaSession = false,
  onNext,
  onPrevious,
  onSongHifiResolved,
  onSongHifiFailed,
}) {
  const [activeDeck, setActiveDeck] = useState(0);
  const [deckSongs, setDeckSongs] = useState([null, null]);
  const [deckOpacities, setDeckOpacities] = useState([1, 0]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isGatingHifi, setIsGatingHifi] = useState(false);
  const [isCrossfading, setIsCrossfading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [masterVolume, setMasterVolume] = useState(() => {
    const saved = localStorage.getItem('mysongs-volume');
    const v = saved !== null ? parseInt(saved, 10) : 100;
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
  });
  const [isMuted, setIsMuted] = useState(false);
  const [playCount, setPlayCount] = useState(0);

  const audioRefs = [useRef(null), useRef(null)];
  const ytRefs = [useRef(null), useRef(null)];
  const activeDeckRef = useRef(0);
  const deckSongsRef = useRef([null, null]);
  const isPlayingRef = useRef(false);
  const isCrossfadingRef = useRef(false);
  const isPreloadingRef = useRef(false);
  const hasPreloadedRef = useRef(false);
  const deckReadyRef = useRef([false, false]);
  const pendingCrossfadeRef = useRef(false);
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);
  const hasTriggeredEndCrossfadeRef = useRef(false);
  const justCrossfadedSongIdRef = useRef(null);
  const fadeIntervalRef = useRef(null);
  const preloadTimeoutRef = useRef(null);
  const isDraggingRef = useRef(false);
  const prevSongKeyRef = useRef(null);
  const isInitialMountRef = useRef(true);
  const gateSeqRef = useRef(0);
  const isGatedPendingRef = useRef(false);
  const gatedPlayWantedRef = useRef(false);
  const isGatingHifiRef = useRef(false);
  const deckUnlockedRef = useRef([false, false]);
  const hifiRetryRef = useRef(new Map());
  const failedHifiIdsRef = useRef(new Set());
  const recoveryTimersRef = useRef(new Map());
  const isRecoveringRef = useRef(false);
  const stallTrackerRef = useRef(null);
  const ytWatchdogRef = useRef(null);
  const pendingAutoplayResumeRef = useRef(false);
  const programmaticPauseUntilRef = useRef(0);
  const handleAudioErrorRef = useRef(null);
  const handleTrackEndRef = useRef(null);
  const handleYouTubeBackgroundFallbackRef = useRef(null);
  const unlockAudioDecksRef = useRef(null);
  const endedDeckKeyRef = useRef(null);

  const masterVolRef = useRef(masterVolume);
  const isMutedRef = useRef(isMuted);
  const repeatModeRef = useRef(repeatMode);
  const playCountRef = useRef(playCount);
  const nextSongRef = useRef(nextSong);
  const hasNextRef = useRef(hasNext);
  const onNextRef = useRef(onNext);
  const onPreviousRef = useRef(onPrevious);
  const crossfadeRef = useRef(crossfadeDuration);

  masterVolRef.current = masterVolume;
  isMutedRef.current = isMuted;
  repeatModeRef.current = repeatMode;
  playCountRef.current = playCount;
  nextSongRef.current = nextSong;
  hasNextRef.current = hasNext;
  onNextRef.current = onNext;
  onPreviousRef.current = onPrevious;
  crossfadeRef.current = crossfadeDuration;
  isPlayingRef.current = isPlaying;
  deckSongsRef.current = deckSongs;

  const setPlayingState = useCallback((nextVal) => {
    const boolVal = Boolean(nextVal);
    isPlayingRef.current = boolVal;
    setIsPlaying(boolVal);
  }, []);

  const setGatingHifiState = useCallback((nextVal) => {
    const boolVal = Boolean(nextVal);
    isGatingHifiRef.current = boolVal;
    setIsGatingHifi(boolVal);
  }, []);

  const handleAudioPlayRejected = useCallback(
    (deckIdx, err) => {
      if (!err || err.name === 'AbortError' || err.name === 'NotSupportedError') return;
      if (!isPlayingRef.current || deckIdx !== activeDeckRef.current || isRecoveringRef.current) return;
      if (err.name === 'NotAllowedError' && isTabHidden()) {
        pendingAutoplayResumeRef.current = true;
        return;
      }
      setPlayingState(false);
    },
    [setPlayingState]
  );

  const isSongHiFi = useCallback(
    (s) => {
      if (!isHifiEnabled || !s || !isHifiEligibleTrack(s)) return false;
      if (!s.stream_url || s._hifiFailed || s._userForcedYoutube) return false;
      if (failedHifiIdsRef.current.has(String(s.id))) return false;
      return true;
    },
    [isHifiEnabled]
  );

  const getDeckMode = useCallback(
    (s) => {
      if (!s) return 'none';
      if (s._fallbackAudioUrl || isSongHiFi(s)) return 'audio';
      return 'youtube';
    },
    [isSongHiFi]
  );

  const maybeWrapHiddenSongFallback = useCallback(
    (track, seekSecs = 0) => {
      if (
        track &&
        shouldUseHiddenSongAudioFallback(track, {
          isHidden: isTabHidden(),
          isAudioMode: getDeckMode(track) === 'audio',
        })
      ) {
        return createHiddenSongAudioTrack(track, seekSecs, Date.now()) || track;
      }
      return track;
    },
    [getDeckMode]
  );

  // Prime inactive audio deck and Web Audio keepalive during a user gesture so background transitions retain permission
  const unlockAudioDecks = useCallback(() => {
    primeAudioKeepalive();
    const SILENT_WAV =
      'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
    [0, 1].forEach((idx) => {
      if (deckUnlockedRef.current[idx]) return;
      const el = audioRefs[idx]?.current;
      if (!el) return;
      const deckSong = deckSongsRef.current[idx];
      if (deckSong && getDeckMode(deckSong) === 'audio') {
        deckUnlockedRef.current[idx] = true;
        return;
      }
      deckUnlockedRef.current[idx] = true;
      try {
        el.muted = true;
        el.src = SILENT_WAV;
        const p = el.play();
        if (p && typeof p.then === 'function') {
          p.then(() => {
            const latest = deckSongsRef.current[idx];
            if (!latest || getDeckMode(latest) !== 'audio') {
              programmaticPauseUntilRef.current = Date.now() + 300;
              el.pause();
              el.removeAttribute('src');
              el.load();
              el.muted = isMutedRef.current;
            }
          }).catch(() => {
            deckUnlockedRef.current[idx] = false;
            const latest = deckSongsRef.current[idx];
            if (!latest || getDeckMode(latest) !== 'audio') {
              el.removeAttribute('src');
              el.muted = isMutedRef.current;
            }
          });
        }
      } catch {
        deckUnlockedRef.current[idx] = false;
      }
    });
  }, [getDeckMode]);
  unlockAudioDecksRef.current = unlockAudioDecks;

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onFirstGesture = () => {
      unlockAudioDecksRef.current?.();
      window.removeEventListener('pointerdown', onFirstGesture, { capture: true });
      window.removeEventListener('keydown', onFirstGesture, { capture: true });
    };
    window.addEventListener('pointerdown', onFirstGesture, { capture: true, once: true });
    window.addEventListener('keydown', onFirstGesture, { capture: true, once: true });
    return () => {
      window.removeEventListener('pointerdown', onFirstGesture, { capture: true });
      window.removeEventListener('keydown', onFirstGesture, { capture: true });
    };
  }, []);

  useEffect(() => {
    if (isPlaying || isGatingHifi) {
      startAudioKeepalive();
    } else {
      stopAudioKeepalive();
    }
  }, [isPlaying, isGatingHifi]);

  useEffect(() => () => stopAudioKeepalive(), []);

  const canRunPrePlayGate = useCallback(
    (s) =>
      shouldRunPrePlayGate(s, {
        isHifiEnabled,
        isEligible: isHifiEligibleTrack(s),
        isUserYoutubeForced: Boolean(s?.id && isUserYoutubeForced(s.id)),
        isFailedId: Boolean(s?.id && failedHifiIdsRef.current.has(String(s.id))),
        isCoolingDown: isHifiCoolingDown(),
        hifiVersion: HIFI_MATCHER_VERSION,
      }),
    [isHifiEnabled]
  );

  const applyDeckVolume = useCallback((deckIdx, vol) => {
    const v = Math.max(0, Math.min(100, vol));
    const audio = audioRefs[deckIdx]?.current;
    if (audio) {
      audio.volume = v / 100;
      audio.muted = isMutedRef.current;
    }
    const yt = ytRefs[deckIdx]?.current;
    if (yt && typeof yt.setVolume === 'function') {
      try {
        yt.setVolume(Math.round(v));
        if (isMutedRef.current) yt.mute?.();
        else yt.unMute?.();
      } catch {}
    }
  }, []);

  const syncActiveDeckVolume = useCallback(
    (deckIdx) => {
      applyDeckVolume(deckIdx, isMutedRef.current ? 0 : masterVolRef.current);
    },
    [applyDeckVolume]
  );

  const clearCrossfadeTimers = useCallback(() => {
    if (fadeIntervalRef.current) {
      clearInterval(fadeIntervalRef.current);
      fadeIntervalRef.current = null;
    }
    if (preloadTimeoutRef.current) {
      clearTimeout(preloadTimeoutRef.current);
      preloadTimeoutRef.current = null;
    }
    isCrossfadingRef.current = false;
    isPreloadingRef.current = false;
    hasPreloadedRef.current = false;
    pendingCrossfadeRef.current = false;
    deckReadyRef.current[1 - activeDeckRef.current] = false;
    setIsCrossfading(false);
  }, []);

  const clearRecoveryTimers = useCallback(() => {
    for (const timer of recoveryTimersRef.current.values()) {
      clearTimeout(timer);
    }
    recoveryTimersRef.current.clear();
    isRecoveringRef.current = false;
  }, []);

  useEffect(() => () => clearRecoveryTimers(), [clearRecoveryTimers]);

  const stopDeckMedia = useCallback((deckIdx) => {
    programmaticPauseUntilRef.current = Date.now() + 300;
    const audio = audioRefs[deckIdx]?.current;
    if (audio) {
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch {}
    }
    const yt = ytRefs[deckIdx]?.current;
    if (yt) {
      try {
        yt.stopVideo?.();
      } catch {}
    }
  }, []);

  const enforceSinglePlayback = useCallback((deckIdx, mode) => {
    if (mode === 'audio') {
      const yt = ytRefs[deckIdx]?.current;
      if (yt) {
        try { yt.stopVideo?.(); } catch {}
      }
    } else if (mode === 'youtube') {
      const audio = audioRefs[deckIdx]?.current;
      if (audio && (!audio.paused || audio.getAttribute('src') || audio.currentSrc)) {
        try {
          programmaticPauseUntilRef.current = Date.now() + 300;
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
        } catch {}
      }
    }
    if (!isCrossfadingRef.current) {
      const otherDeck = 1 - deckIdx;
      const otherAudio = audioRefs[otherDeck]?.current;
      if (otherAudio && !otherAudio.paused) {
        try {
          programmaticPauseUntilRef.current = Date.now() + 300;
          otherAudio.pause();
        } catch {}
      }
      const otherYt = ytRefs[otherDeck]?.current;
      if (otherYt) {
        try {
          if (otherYt.getPlayerState?.() === 1) {
            otherYt.pauseVideo?.();
          }
        } catch {}
      }
    }
  }, []);

  const updateDeckSong = useCallback((deckIdx, nextVal) => {
    setDeckSongs((prev) => {
      const copy = [...prev];
      copy[deckIdx] = nextVal;
      deckSongsRef.current = copy;
      return copy;
    });
  }, []);

  const cancelCrossfade = useCallback(() => {
    const inactive = 1 - activeDeckRef.current;
    const wasActive =
      isCrossfadingRef.current ||
      isPreloadingRef.current ||
      hasPreloadedRef.current ||
      Boolean(deckSongsRef.current[inactive]);
    clearCrossfadeTimers();
    if (wasActive) {
      stopDeckMedia(inactive);
      updateDeckSong(inactive, null);
      setDeckOpacities(activeDeckRef.current === 0 ? [1, 0] : [0, 1]);
      applyDeckVolume(activeDeckRef.current, isMutedRef.current ? 0 : masterVolRef.current);
    }
  }, [clearCrossfadeTimers, stopDeckMedia, updateDeckSong, applyDeckVolume]);

  const finishCrossfade = useCallback(() => {
    const oldDeck = activeDeckRef.current;
    const newDeck = 1 - oldDeck;
    const incoming = deckSongsRef.current[newDeck];

    clearCrossfadeTimers();
    stopDeckMedia(oldDeck);
    updateDeckSong(oldDeck, null);

    activeDeckRef.current = newDeck;
    setActiveDeck(newDeck);
    setDeckOpacities(newDeck === 0 ? [1, 0] : [0, 1]);
    applyDeckVolume(newDeck, isMutedRef.current ? 0 : masterVolRef.current);

    if (incoming) {
      justCrossfadedSongIdRef.current = incoming.uid || incoming.id;
      if (getDeckMode(incoming) === 'audio') {
        const newAudio = audioRefs[newDeck]?.current;
        if (newAudio && newAudio.paused && isPlayingRef.current) {
          newAudio.play?.().catch((err) => handleAudioPlayRejected(newDeck, err));
        }
      }
    }
    setPlayCount(0);
    hasTriggeredEndCrossfadeRef.current = false;
    onNextRef.current?.({ fromCrossfade: true });
  }, [clearCrossfadeTimers, stopDeckMedia, updateDeckSong, applyDeckVolume, getDeckMode, handleAudioPlayRejected]);

  const startCrossfadeRamp = useCallback(
    (remainingSecs) => {
      const cfSecs = crossfadeRef.current;
      const effectiveSecs =
        Number.isFinite(remainingSecs) && remainingSecs > 0.4 ? Math.min(cfSecs, remainingSecs) : cfSecs;
      if (effectiveSecs <= 0) {
        finishCrossfade();
        return;
      }

      const oldDeck = activeDeckRef.current;
      const newDeck = 1 - oldDeck;
      const incoming = deckSongsRef.current[newDeck];
      if (!incoming) {
        clearCrossfadeTimers();
        return;
      }

      isCrossfadingRef.current = true;
      pendingCrossfadeRef.current = false;
      setIsCrossfading(true);

      const newAudio = audioRefs[newDeck]?.current;
      if (getDeckMode(incoming) === 'audio' && newAudio) {
        newAudio.volume = 0;
        newAudio.muted = isMutedRef.current;
        const p = newAudio.play?.();
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            if (err?.name !== 'AbortError' && isCrossfadingRef.current) {
              cancelCrossfade();
            }
          });
        }
      } else {
        const yt = ytRefs[newDeck]?.current;
        try {
          yt?.unMute?.();
          yt?.setVolume?.(0);
          yt?.playVideo?.();
        } catch {}
      }

      const startTime = performance.now();
      const totalMs = Math.max(400, effectiveSecs * 1000);
      if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current);

      fadeIntervalRef.current = setInterval(() => {
        const elapsed = performance.now() - startTime;
        const progress = Math.min(1, elapsed / totalMs);
        // Slightly front-loaded incoming ramp keeps perceived loudness steady through song outro fade-outs
        const factorOut = Math.cos(Math.pow(progress, 1.35) * (Math.PI / 2));
        const factorIn = Math.sin(Math.min(1, progress * 1.15) * (Math.PI / 2));
        const targetVol = isMutedRef.current ? 0 : masterVolRef.current;

        applyDeckVolume(oldDeck, targetVol * factorOut);
        applyDeckVolume(newDeck, targetVol * factorIn);
        setDeckOpacities(oldDeck === 0 ? [1 - progress, progress] : [progress, 1 - progress]);

        if (progress >= 1) {
          finishCrossfade();
        }
      }, 30);
    },
    [finishCrossfade, clearCrossfadeTimers, cancelCrossfade, getDeckMode, applyDeckVolume]
  );

  const preloadIncomingSong = useCallback(
    async (song) => {
      if (!song || isPreloadingRef.current || hasPreloadedRef.current) return;
      const preloadKey = song.uid || song.id;
      isPreloadingRef.current = true;
      const inDeck = 1 - activeDeckRef.current;
      deckReadyRef.current[inDeck] = false;

      let prepared = { ...song };
      if (isHifiEnabled && isHifiEligibleTrack(prepared) && !prepared.stream_url && !prepared._userForcedYoutube) {
        const cached = getCachedHifi(prepared);
        if (cached) {
          prepared = { ...prepared, ...cached };
        } else {
          const resolved = await resolveHifiForTrack(prepared);
          if (resolved?.stream_url) {
            prepared = { ...prepared, ...resolved };
            onSongHifiResolved?.(prepared);
          }
        }
      }

      // Abort if queue was reordered, skipped, or canceled while awaiting resolution
      const currentNextKey = nextSongRef.current ? nextSongRef.current.uid || nextSongRef.current.id : null;
      if (!isPreloadingRef.current || currentNextKey !== preloadKey || 1 - activeDeckRef.current !== inDeck) {
        return;
      }

      updateDeckSong(inDeck, prepared);
      applyDeckVolume(inDeck, 0);
      hasPreloadedRef.current = true;
      isPreloadingRef.current = false;

      if (preloadTimeoutRef.current) clearTimeout(preloadTimeoutRef.current);
      preloadTimeoutRef.current = setTimeout(() => {
        if (!isCrossfadingRef.current && hasPreloadedRef.current && !deckReadyRef.current[inDeck]) {
          cancelCrossfade();
        }
      }, Math.max(crossfadeRef.current + 16, 22) * 1000);
    },
    [isHifiEnabled, onSongHifiResolved, updateDeckSong, applyDeckVolume, cancelCrossfade]
  );

  const markDeckReady = useCallback(
    (deckIdx) => {
      deckReadyRef.current[deckIdx] = true;
      const inDeck = 1 - activeDeckRef.current;
      if (
        deckIdx === inDeck &&
        pendingCrossfadeRef.current &&
        !hasTriggeredEndCrossfadeRef.current &&
        !isCrossfadingRef.current
      ) {
        const remaining = durationRef.current - currentTimeRef.current;
        if (remaining > 0.4) {
          hasTriggeredEndCrossfadeRef.current = true;
          pendingCrossfadeRef.current = false;
          startCrossfadeRamp(Math.min(crossfadeRef.current, remaining));
        }
      }
    },
    [startCrossfadeRamp]
  );

  const checkAutoCrossfade = useCallback(
    (time, dur) => {
      currentTimeRef.current = time;
      durationRef.current = dur;
      const cf = crossfadeRef.current;
      if (!cf || cf <= 0 || !dur || dur <= 10 || time < 5 || time < cf + 2) return;
      if (!hasNextRef.current || !nextSongRef.current) return;
      const looping = repeatModeRef.current === 1 || (repeatModeRef.current === 2 && playCountRef.current < 1);
      if (looping) return;

      // In background/unfocused tabs timers are throttled and secondary-deck autoplay can be blocked; let ended advance instead
      if (isTabHidden()) return;

      const remaining = dur - time;
      const preloadAt = Math.max(cf + 12, 15);
      if (
        remaining <= preloadAt &&
        remaining > cf + 0.5 &&
        !isPreloadingRef.current &&
        !hasPreloadedRef.current &&
        !isCrossfadingRef.current
      ) {
        preloadIncomingSong(nextSongRef.current);
      }

      // Trigger slightly early (+0.8s) to overlap silent outro tails smoothly
      const triggerAt = cf + 0.8;
      if (remaining <= triggerAt && remaining > 0.35 && !hasTriggeredEndCrossfadeRef.current && !isCrossfadingRef.current) {
        const inDeck = 1 - activeDeckRef.current;
        if (!hasPreloadedRef.current && !isPreloadingRef.current) {
          preloadIncomingSong(nextSongRef.current);
        }
        if (deckReadyRef.current[inDeck]) {
          hasTriggeredEndCrossfadeRef.current = true;
          pendingCrossfadeRef.current = false;
          startCrossfadeRamp(Math.min(cf, remaining));
        } else {
          pendingCrossfadeRef.current = true;
        }
      }
    },
    [preloadIncomingSong, startCrossfadeRamp]
  );

  // Load currentSong onto activeDeck whenever track identity changes
  useEffect(() => {
    const isInitialHydration = isInitialMountRef.current;
    isInitialMountRef.current = false;

    if (!currentSong) {
      gateSeqRef.current += 1;
      isGatedPendingRef.current = false;
      gatedPlayWantedRef.current = false;
      setGatingHifiState(false);
      clearRecoveryTimers();
      cancelCrossfade();
      stopDeckMedia(0);
      stopDeckMedia(1);
      setDeckSongs([null, null]);
      deckSongsRef.current = [null, null];
      setPlayingState(false);
      setCurrentTime(0);
      currentTimeRef.current = 0;
      setDuration(0);
      durationRef.current = 0;
      prevSongKeyRef.current = null;
      stallTrackerRef.current = null;
      ytWatchdogRef.current = null;
      pendingAutoplayResumeRef.current = false;
      return;
    }

    const key = currentSong.uid || currentSong.id;
    if (key === justCrossfadedSongIdRef.current) {
      justCrossfadedSongIdRef.current = null;
      prevSongKeyRef.current = key;
      return;
    }
    if (prevSongKeyRef.current === key) return;
    prevSongKeyRef.current = key;
    endedDeckKeyRef.current = null;

    clearRecoveryTimers();
    cancelCrossfade();
    hasTriggeredEndCrossfadeRef.current = false;
    setPlayCount(0);
    setCurrentTime(0);
    currentTimeRef.current = 0;
    const initDur = parseDurationToSecs(currentSong.duration);
    setDuration(initDur);
    durationRef.current = initDur;
    hifiRetryRef.current.delete(String(currentSong.id));
    hifiRetryRef.current.delete(`fb:${currentSong.id}`);
    stallTrackerRef.current = null;
    ytWatchdogRef.current = null;
    pendingAutoplayResumeRef.current = false;

    const curDeck = activeDeckRef.current;
    const otherDeck = 1 - curDeck;
    stopDeckMedia(otherDeck);
    updateDeckSong(otherDeck, null);

    let activeCopy = { ...currentSong };
    if (
      isHifiEnabled &&
      isHifiEligibleTrack(activeCopy) &&
      !activeCopy.stream_url &&
      !activeCopy._userForcedYoutube &&
      !isUserYoutubeForced(activeCopy.id)
    ) {
      const cached = getCachedHifi(activeCopy);
      if (cached) activeCopy = { ...activeCopy, ...cached, _hifiChecked: true };
    }
    if (!activeCopy.stream_url && isKnownUnmatchedHifi(activeCopy)) {
      activeCopy = { ...activeCopy, _hifiChecked: true, _hifiVersion: HIFI_MATCHER_VERSION };
    }

    // Never auto-play a restored queue track on page load; keep the button in Play state until the user starts it
    if (!isInitialHydration && canRunPrePlayGate(activeCopy)) {
      // Pre-Play Hi-Fi Gate: halt current sound immediately and resolve FLAC before mounting any player
      stopDeckMedia(curDeck);
      updateDeckSong(curDeck, null);
      setDeckOpacities(curDeck === 0 ? [1, 0] : [0, 1]);
      setPlayingState(true);
      setIsBuffering(true);
      setGatingHifiState(true);

      const gateSeq = ++gateSeqRef.current;
      isGatedPendingRef.current = true;
      gatedPlayWantedRef.current = true;
      let cancelled = false;

      awaitPrePlayGateResolution(
        activeCopy,
        (track) => resolveHifiForTrack(track, { mode: 'play' }),
        { hifiVersion: HIFI_MATCHER_VERSION }
      ).then((gateResult) => {
        if (cancelled || gateSeqRef.current !== gateSeq) return;
        isGatedPendingRef.current = false;
        setGatingHifiState(false);

        const finalTrack = gateResult.track;
        onSongHifiResolved?.(finalTrack);

        const targetDeck = activeDeckRef.current;
        const other = 1 - targetDeck;
        stopDeckMedia(other);
        updateDeckSong(other, null);
        setDeckOpacities(targetDeck === 0 ? [1, 0] : [0, 1]);

        const shouldPlay = Boolean(gatedPlayWantedRef.current);
        setPlayingState(shouldPlay);
        setIsBuffering(shouldPlay);
        applyDeckVolume(targetDeck, isMutedRef.current ? 0 : masterVolRef.current);

        const deckTrack = shouldPlay ? maybeWrapHiddenSongFallback(finalTrack, 0) : finalTrack;
        if (getDeckMode(deckTrack) !== 'audio') {
          const curAudio = audioRefs[targetDeck]?.current;
          if (curAudio && (!curAudio.paused || curAudio.getAttribute('src') || curAudio.currentSrc)) {
            try {
              programmaticPauseUntilRef.current = Date.now() + 300;
              curAudio.pause();
              curAudio.removeAttribute('src');
              curAudio.load();
            } catch {}
          }
        } else {
          try { ytRefs[targetDeck]?.current?.stopVideo?.(); } catch {}
        }
        updateDeckSong(targetDeck, deckTrack);
      });

      return () => {
        cancelled = true;
        gateSeqRef.current += 1;
        isGatedPendingRef.current = false;
        setGatingHifiState(false);
      };
    }

    gateSeqRef.current += 1;
    isGatedPendingRef.current = false;
    setGatingHifiState(false);

    const deckTrack = isInitialHydration
      ? activeCopy
      : maybeWrapHiddenSongFallback(activeCopy, Number(activeCopy._seekOnLoad) || 0);
    const nextMode = getDeckMode(deckTrack);
    if (nextMode !== 'audio') {
      const curAudio = audioRefs[curDeck]?.current;
      if (curAudio && (!curAudio.paused || curAudio.getAttribute('src') || curAudio.currentSrc)) {
        try {
          programmaticPauseUntilRef.current = Date.now() + 300;
          curAudio.pause();
          curAudio.removeAttribute('src');
          curAudio.load();
        } catch {}
      }
    } else {
      try { ytRefs[curDeck]?.current?.stopVideo?.(); } catch {}
    }

    updateDeckSong(curDeck, deckTrack);
    setDeckOpacities(curDeck === 0 ? [1, 0] : [0, 1]);
    if (isInitialHydration) {
      setPlayingState(false);
      setIsBuffering(false);
    } else {
      setPlayingState(true);
      setIsBuffering(true);
    }
    applyDeckVolume(curDeck, isMutedRef.current ? 0 : masterVolRef.current);
    return undefined;
  }, [currentSong?.uid, currentSong?.id]);

  // Reflect live HiFi resolution or manual YT/HiFi switch on active track
  useEffect(() => {
    if (!currentSong) return;
    const curDeck = activeDeckRef.current;
    const deckSong = deckSongsRef.current[curDeck];
    if (!deckSong || deckSong.id !== currentSong.id) return;

    const shouldFallbackToYt = Boolean(currentSong._userForcedYoutube || currentSong._hifiFailed || (!isHifiEnabled && deckSong.stream_url));
    if (shouldFallbackToYt && deckSong.stream_url) {
      clearRecoveryTimers();
      const audio = audioRefs[curDeck]?.current;
      const pos = Math.max(audio?.currentTime > 0.25 ? audio.currentTime : 0, currentTimeRef.current || 0);
      isRecoveringRef.current = pos > 0;
      if (audio) {
        programmaticPauseUntilRef.current = Date.now() + 300;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      const downgraded = maybeWrapHiddenSongFallback(
        {
          ...deckSong,
          stream_url: null,
          source: null,
          _fallbackAudioUrl: null,
          _isHiddenYtFallback: false,
          _userForcedYoutube: currentSong._userForcedYoutube,
          _hifiFailed: currentSong._hifiFailed,
          _seekOnLoad: Math.floor(pos),
          _recoveryNonce: Date.now(),
        },
        pos
      );
      updateDeckSong(curDeck, downgraded);
    } else if (currentSong._fallbackAudioUrl && deckSong._fallbackAudioUrl !== currentSong._fallbackAudioUrl) {
      const yt = ytRefs[curDeck]?.current;
      try { yt?.stopVideo?.(); } catch {}
      const pos = Math.max(yt?.getCurrentTime?.() || 0, currentTimeRef.current || 0);
      const targetSeek = currentSong._seekOnLoad > 0 ? currentSong._seekOnLoad : Math.floor(pos);
      isRecoveringRef.current = targetSeek > 0;
      updateDeckSong(curDeck, {
        ...deckSong,
        ...currentSong,
        _seekOnLoad: targetSeek,
        _recoveryNonce: currentSong._recoveryNonce || Date.now(),
      });
    } else {
      const audio = audioRefs[curDeck]?.current;
      const yt = ytRefs[curDeck]?.current;
      const audioPos = audio?.currentTime > 0.25 ? audio.currentTime : 0;
      const pos = Math.max(audioPos, yt?.getCurrentTime?.() || 0, currentTimeRef.current || 0);
      if (
        shouldApplyLiveHifiSwitch({
          isHifiEnabled,
          currentSong,
          deckSong,
          isPlaying: isPlayingRef.current,
          positionSecs: pos,
        })
      ) {
        if (currentSong._manualHifiRetry) {
          failedHifiIdsRef.current.delete(String(currentSong.id));
          hifiRetryRef.current.delete(String(currentSong.id));
          hifiRetryRef.current.delete(`fb:${currentSong.id}`);
        }
        isRecoveringRef.current = pos > 0;
        try { yt?.stopVideo?.(); } catch {}
        updateDeckSong(curDeck, {
          ...deckSong,
          stream_url: currentSong.stream_url,
          hifi_id: currentSong.hifi_id,
          source: currentSong.source,
          _hifiFailed: false,
          _userForcedYoutube: false,
          _fallbackAudioUrl: null,
          _isHiddenYtFallback: false,
          _isBackgroundVideoAudio: false,
          _seekOnLoad: pos,
          _recoveryNonce: Date.now(),
        });
      }
    }
  }, [
    currentSong?.stream_url,
    currentSong?._userForcedYoutube,
    currentSong?._hifiFailed,
    currentSong?._manualHifiRetry,
    currentSong?._fallbackAudioUrl,
    currentSong?._recoveryNonce,
    isHifiEnabled,
    clearRecoveryTimers,
    maybeWrapHiddenSongFallback,
  ]);

  // Invalidate any preloaded or crossfading incoming deck if nextSong changes via queue reorder or video insertion
  useEffect(() => {
    const nextKey = nextSong ? String(nextSong.uid || nextSong.id) : null;
    const inDeck = 1 - activeDeckRef.current;
    const inSong = deckSongsRef.current[inDeck];
    const inKey = inSong ? String(inSong.uid || inSong.id) : null;
    const hasPendingOrActive =
      isPreloadingRef.current ||
      hasPreloadedRef.current ||
      isCrossfadingRef.current ||
      pendingCrossfadeRef.current;
    if (hasPendingOrActive && inKey !== nextKey) {
      cancelCrossfade();
      hasTriggeredEndCrossfadeRef.current = false;
    }
  }, [nextSong?.uid, nextSong?.id, cancelCrossfade]);

  const syncAudioProgress = useCallback(
    (time, dur) => {
      if (!isPlayingRef.current || isDraggingRef.current || isRecoveringRef.current) return;
      const safeTime = Number(time) || 0;
      const safeDur = Number.isFinite(dur) && dur > 0 ? dur : durationRef.current || 0;
      if (safeTime > 0.25 || currentTimeRef.current < 0.5) {
        currentTimeRef.current = safeTime;
      }
      setCurrentTime(currentTimeRef.current);
      if (safeDur > 0) {
        durationRef.current = safeDur;
        setDuration(safeDur);
      }
      window.dispatchEvent(new CustomEvent('timeupdate', { detail: currentTimeRef.current }));
      checkAutoCrossfade(currentTimeRef.current, safeDur);
    },
    [checkAutoCrossfade]
  );

  // 100ms timer polling active deck progress + triggering lyrics sync, wall-clock stall/end watchdogs & auto-crossfade
  useEffect(() => {
    const interval = setInterval(() => {
      if (!isPlayingRef.current || isDraggingRef.current) return;
      const d = activeDeckRef.current;
      const s = deckSongsRef.current[d];
      if (!s) return;

      let time = 0;
      let dur = 0;
      const nowMs = Date.now();
      if (getDeckMode(s) === 'audio') {
        const audio = audioRefs[d]?.current;
        if (audio) {
          if (audio.ended) {
            handleTrackEndRef.current?.(d);
            return;
          }
          time = audio.currentTime || 0;
          dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : parseDurationToSecs(s.duration);

          // While recovering/seeking back to resume position, preserve currentTimeRef instead of overwriting with 0
          if (isRecoveringRef.current) {
            if (time > 0.25 && (!s._seekOnLoad || Math.abs(time - s._seekOnLoad) <= 3)) {
              isRecoveringRef.current = false;
            } else {
              return;
            }
          }

          const sKey = `${s.uid || s.id}:${audio.currentSrc || ''}`;
          const wd = evaluateAudioWatchdog({
            key: sKey,
            time,
            duration: dur,
            paused: audio.paused,
            seekOnLoad: s._seekOnLoad || 0,
            nowMs,
            tracker: stallTrackerRef.current,
          });
          stallTrackerRef.current = wd.nextTracker;
          if (wd.resetRetryBudget) {
            hifiRetryRef.current.delete(String(s.id));
          }
          if (wd.action === 'ended') {
            handleTrackEndRef.current?.(d);
            return;
          }
          if (wd.action === 'recover') {
            const resumeAt = Math.max(time, currentTimeRef.current || 0);
            handleAudioErrorRef.current?.(d, resumeAt);
            return;
          }
        }
      } else {
        const yt = ytRefs[d]?.current;
        let ytState = -1;
        if (yt) {
          try {
            ytState = yt.getPlayerState?.();
            if (ytState === 0) {
              handleTrackEndRef.current?.(d);
              return;
            }
            time = yt.getCurrentTime?.() || 0;
            dur = yt.getDuration?.() || parseDurationToSecs(s.duration);
          } catch {}
        }
        if (isRecoveringRef.current) {
          if (time > 0.25 && (!s._seekOnLoad || Math.abs(time - s._seekOnLoad) <= 4)) {
            isRecoveringRef.current = false;
          } else {
            return;
          }
        }
        if (yt) {
          const yKey = `${s.uid || s.id}:${s._recoveryNonce || 0}`;
          const ywd = evaluateYouTubeWatchdog({
            key: yKey,
            playerState: ytState,
            time,
            duration: dur,
            isHidden: isTabHidden(),
            nowMs,
            tracker: ytWatchdogRef.current,
          });
          ytWatchdogRef.current = ywd.nextTracker;
          if (ywd.action === 'ended') {
            handleTrackEndRef.current?.(d);
            return;
          }
          if (ywd.action === 'fallback') {
            const resumeAt = Math.max(time, currentTimeRef.current || 0);
            handleYouTubeBackgroundFallbackRef.current?.(d, resumeAt);
            return;
          }
        }
      }

      if (time > 0.25 || currentTimeRef.current < 0.5) {
        currentTimeRef.current = time;
      }
      setCurrentTime(currentTimeRef.current);
      if (dur > 0) {
        durationRef.current = dur;
        setDuration(dur);
      }
      window.dispatchEvent(new CustomEvent('timeupdate', { detail: currentTimeRef.current }));
      checkAutoCrossfade(currentTimeRef.current, dur);
    }, 100);
    return () => clearInterval(interval);
  }, [getDeckMode, checkAutoCrossfade]);

  const togglePlay = useCallback(() => {
    unlockAudioDecks();
    if (isGatedPendingRef.current) {
      const nextWanted = !gatedPlayWantedRef.current;
      gatedPlayWantedRef.current = nextWanted;
      setPlayingState(nextWanted);
      setIsBuffering(nextWanted);
      return;
    }

    const d = activeDeckRef.current;
    const s = deckSongsRef.current[d];
    if (!s) return;
    if (getDeckMode(s) === 'audio') {
      const audio = audioRefs[d]?.current;
      if (!audio) return;
      if (audio.paused) {
        setPlayingState(true);
        const p = audio.play();
        if (p && typeof p.catch === 'function') {
          p.catch((err) => handleAudioPlayRejected(d, err));
        }
      } else {
        audio.pause();
        setPlayingState(false);
      }
    } else {
      if (!isPlayingRef.current) {
        // Pre-Play Hi-Fi Gate for paused tracks (e.g. restored session track before first play)
        if (isHifiEnabled && isHifiEligibleTrack(s) && !s._userForcedYoutube && !isUserYoutubeForced(s.id)) {
          const cached = getCachedHifi(s);
          if (cached?.stream_url) {
            const upgraded = { ...s, ...cached, _hifiChecked: true, _hifiFailed: false };
            onSongHifiResolved?.(upgraded);
            setPlayingState(true);
            setIsBuffering(true);
            applyDeckVolume(d, isMutedRef.current ? 0 : masterVolRef.current);
            updateDeckSong(d, { ...upgraded, _recoveryNonce: Date.now() });
            return;
          }
        }

        if (canRunPrePlayGate(s)) {
          const gateSeq = ++gateSeqRef.current;
          isGatedPendingRef.current = true;
          gatedPlayWantedRef.current = true;
          setGatingHifiState(true);
          setPlayingState(true);
          setIsBuffering(true);

          awaitPrePlayGateResolution(
            s,
            (track) => resolveHifiForTrack(track, { mode: 'play' }),
            { hifiVersion: HIFI_MATCHER_VERSION }
          ).then((gateResult) => {
            if (gateSeqRef.current !== gateSeq) return;
            isGatedPendingRef.current = false;
            setGatingHifiState(false);

            const curDeck = activeDeckRef.current;
            const latestSong = deckSongsRef.current[curDeck];
            if (!latestSong || latestSong.id !== s.id) return;

            const finalTrack = { ...latestSong, ...gateResult.track };
            onSongHifiResolved?.(finalTrack);

            const shouldPlay = Boolean(gatedPlayWantedRef.current);
            setPlayingState(shouldPlay);
            setIsBuffering(shouldPlay);
            applyDeckVolume(curDeck, isMutedRef.current ? 0 : masterVolRef.current);

            if (finalTrack.stream_url) {
              updateDeckSong(curDeck, { ...finalTrack, _recoveryNonce: Date.now() });
            } else {
              const deckTrack = shouldPlay ? maybeWrapHiddenSongFallback(finalTrack, 0) : finalTrack;
              updateDeckSong(curDeck, deckTrack);
              if (shouldPlay && getDeckMode(deckTrack) !== 'audio') {
                ytRefs[curDeck]?.current?.playVideo?.();
              }
            }
          });
          return;
        }

        const deckTrack = maybeWrapHiddenSongFallback(s, currentTimeRef.current || 0);
        if (getDeckMode(deckTrack) === 'audio') {
          setPlayingState(true);
          setIsBuffering(true);
          applyDeckVolume(d, isMutedRef.current ? 0 : masterVolRef.current);
          updateDeckSong(d, deckTrack);
          return;
        }
      }

      const yt = ytRefs[d]?.current;
      if (!yt) {
        setPlayingState(!isPlayingRef.current);
        return;
      }
      if (isPlayingRef.current) {
        yt.pauseVideo?.();
        setPlayingState(false);
      } else {
        yt.playVideo?.();
        setPlayingState(true);
      }
    }
  }, [getDeckMode, canRunPrePlayGate, isHifiEnabled, onSongHifiResolved, applyDeckVolume, updateDeckSong, unlockAudioDecks, setPlayingState, setGatingHifiState, handleAudioPlayRejected, maybeWrapHiddenSongFallback]);

  const pause = useCallback(() => {
    cancelCrossfade();
    if (isGatedPendingRef.current) {
      gatedPlayWantedRef.current = false;
      setIsBuffering(false);
    }
    programmaticPauseUntilRef.current = Date.now() + 300;
    const d = activeDeckRef.current;
    const other = 1 - d;
    try {
      audioRefs[d]?.current?.pause();
      audioRefs[other]?.current?.pause();
    } catch {}
    try {
      ytRefs[d]?.current?.pauseVideo?.();
      ytRefs[other]?.current?.pauseVideo?.();
    } catch {}
    setPlayingState(false);
  }, [cancelCrossfade, setPlayingState]);

  const seekTo = useCallback(
    (targetTime) => {
      cancelCrossfade();
      const d = activeDeckRef.current;
      const s = deckSongsRef.current[d];
      if (!s) return;
      const clamped = Math.max(0, Number(targetTime) || 0);
      isRecoveringRef.current = false;
      currentTimeRef.current = clamped;
      setCurrentTime(clamped);
      window.dispatchEvent(new CustomEvent('timeupdate', { detail: clamped }));
      hasTriggeredEndCrossfadeRef.current = false;

      if (getDeckMode(s) === 'audio') {
        const audio = audioRefs[d]?.current;
        if (audio) audio.currentTime = clamped;
      } else {
        const yt = ytRefs[d]?.current;
        yt?.seekTo?.(clamped, true);
      }
    },
    [cancelCrossfade, getDeckMode]
  );

  const seekBy = useCallback(
    (delta) => {
      seekTo(currentTime + delta);
    },
    [seekTo, currentTime]
  );

  const handleVolumeChange = useCallback(
    (val) => {
      const v = Math.max(0, Math.min(100, Number(val)));
      setMasterVolume(v);
      masterVolRef.current = v;
      localStorage.setItem('mysongs-volume', String(v));
      if (v > 0 && isMutedRef.current) {
        setIsMuted(false);
        isMutedRef.current = false;
      }
      applyDeckVolume(activeDeckRef.current, v);
    },
    [applyDeckVolume]
  );

  const toggleMute = useCallback(() => {
    const next = !isMutedRef.current;
    setIsMuted(next);
    isMutedRef.current = next;
    applyDeckVolume(activeDeckRef.current, next ? 0 : masterVolRef.current);
  }, [applyDeckVolume]);

  const handleTrackEnd = useCallback(
    (deckIdx) => {
      if (deckIdx !== activeDeckRef.current) return;
      if (isCrossfadingRef.current) {
        finishCrossfade();
        return;
      }
      const s = deckSongsRef.current[deckIdx];
      if (!s) return;
      const endKey = `${deckIdx}:${s.uid || s.id}`;
      if (endedDeckKeyRef.current === endKey) return;
      endedDeckKeyRef.current = endKey;

      if (repeatModeRef.current === 1) {
        endedDeckKeyRef.current = null;
        seekTo(0);
        if (getDeckMode(s) === 'audio') {
          audioRefs[deckIdx]?.current?.play?.().catch((err) => handleAudioPlayRejected(deckIdx, err));
        } else {
          ytRefs[deckIdx]?.current?.playVideo?.();
        }
        setPlayingState(true);
        return;
      }
      if (repeatModeRef.current === 2 && playCountRef.current < 1) {
        endedDeckKeyRef.current = null;
        setPlayCount(1);
        seekTo(0);
        if (getDeckMode(s) === 'audio') {
          audioRefs[deckIdx]?.current?.play?.().catch((err) => handleAudioPlayRejected(deckIdx, err));
        } else {
          ytRefs[deckIdx]?.current?.playVideo?.();
        }
        setPlayingState(true);
        return;
      }
      setPlayCount(0);
      if (!hasNextRef.current) {
        const handled = onNextRef.current?.({ fromEnd: true });
        if (handled === false) {
          setPlayingState(false);
        }
        return;
      }
      onNextRef.current?.({ fromEnd: true });
    },
    [finishCrossfade, seekTo, getDeckMode, setPlayingState, handleAudioPlayRejected]
  );
  handleTrackEndRef.current = handleTrackEnd;

  const clearRecovering = useCallback((deckIdx) => {
    if (deckIdx === activeDeckRef.current) {
      isRecoveringRef.current = false;
    }
  }, []);

  const handleAudioError = useCallback(
    async (deckIdx, failedTime = 0) => {
      const s = deckSongsRef.current[deckIdx];
      if (!s) return;

      const audioEl = audioRefs[deckIdx]?.current;
      // Ignore spurious error events emitted when a deck's src was intentionally cleared
      if (!failedTime && audioEl && !audioEl.getAttribute('src')) {
        return;
      }

      // Inactive / preload deck failure: degrade only the preload deck without interrupting active playback
      if (deckIdx !== activeDeckRef.current) {
        const fallbackSong = {
          ...s,
          stream_url: null,
          source: null,
          _fallbackAudioUrl: null,
          _hifiFailed: true,
        };
        if (audioEl) {
          try {
            audioEl.pause();
            audioEl.removeAttribute('src');
            audioEl.load();
          } catch {}
        }
        updateDeckSong(deckIdx, fallbackSong);
        if (s.stream_url) onSongHifiFailed?.(fallbackSong);
        return;
      }

      if (s._fallbackAudioUrl) {
        const fbKey = `fb:${s.id}`;
        const fbAttempts = hifiRetryRef.current.get(fbKey) || 0;
        const pos = Math.max(
          0,
          Number(failedTime) || 0,
          audioEl?.currentTime > 0.25 ? audioEl.currentTime : 0,
          currentTimeRef.current || 0
        );
        if (fbAttempts < 1) {
          hifiRetryRef.current.set(fbKey, fbAttempts + 1);
          isRecoveringRef.current = pos > 0;
          setIsBuffering(true);
          const retryBase = String(s._fallbackAudioUrl).replace(/([?&])(retry|t)=[^&]*/g, '').replace(/[?&]+$/, '');
          const sep = retryBase.includes('?') ? '&' : '?';
          updateDeckSong(deckIdx, {
            ...s,
            _fallbackAudioUrl: `${retryBase}${sep}retry=${fbAttempts + 1}&t=${Date.now()}`,
            _seekOnLoad: Math.floor(pos),
            _recoveryNonce: Date.now(),
          });
          return;
        }
        if (audioEl) {
          try {
            programmaticPauseUntilRef.current = Date.now() + 300;
            audioEl.pause();
            audioEl.removeAttribute('src');
            audioEl.load();
          } catch {}
        }
        if (s._isHiddenYtFallback && !isTabHidden() && !s._ytFailed) {
          isRecoveringRef.current = pos > 0;
          updateDeckSong(deckIdx, {
            ...s,
            stream_url: null,
            _fallbackAudioUrl: null,
            _isHiddenYtFallback: false,
            _bgAudioFailed: true,
            _seekOnLoad: Math.floor(pos),
            _recoveryNonce: Date.now(),
          });
          return;
        }
        isRecoveringRef.current = false;
        onNextRef.current?.({ fromError: true, failedSong: s });
        return;
      }

      const idKey = String(s.id);
      const pos = Math.max(
        0,
        Number(failedTime) || 0,
        audioEl?.currentTime > 0.25 ? audioEl.currentTime : 0,
        currentTimeRef.current || 0
      );
      const errorCode = audioEl?.error?.code || 0;
      const attempts = hifiRetryRef.current.get(idKey) || 0;

      // Mirror Tauri usePlayerCore.js: Decode error (3) is fatal immediately;
      // SRC_NOT_SUPPORTED (4, including HTTP 403/410/429/503) gets up to 2 URL-refreshed retries;
      // Network hiccups/stalls get up to 4 staggered retries preserving exact playback position.
      const isFatal = errorCode === 3 || (errorCode === 4 && attempts >= 2) || (pos < 1.5 && attempts >= 2);
      const maxAttempts = 4;

      if (!isFatal && attempts < maxAttempts && s.stream_url && !failedHifiIdsRef.current.has(idKey)) {
        // Avoid stacking duplicate recovery timers for the same track
        if (recoveryTimersRef.current.has(idKey)) return;

        hifiRetryRef.current.set(idKey, attempts + 1);
        isRecoveringRef.current = true;
        setIsBuffering(true);

        const delays = [1000, 2500, 4500, 7000];
        const delay = delays[Math.min(attempts, delays.length - 1)];

        const timer = setTimeout(async () => {
          recoveryTimersRef.current.delete(idKey);
          if (activeDeckRef.current !== deckIdx || deckSongsRef.current[deckIdx]?.id !== s.id) {
            return;
          }

          let baseStreamUrl = String(s.stream_url || '').replace(/([?&])(retry|t)=[^&]*/g, '').replace(/[?&]+$/, '');
          // Refresh signed upstream URL on SRC_NOT_SUPPORTED, stall, or attempt >= 2
          if (errorCode === 4 || attempts >= 1 || failedTime > 0) {
            try {
              const refreshed = await resolveHifiForTrack(s, {
                forceRefresh: true,
                ignoreBlacklist: true,
                mode: 'play',
              });
              if (refreshed?.stream_url) {
                baseStreamUrl = refreshed.stream_url;
              }
            } catch {}
          }

          if (activeDeckRef.current !== deckIdx || deckSongsRef.current[deckIdx]?.id !== s.id) {
            return;
          }

          if (!baseStreamUrl) {
            handleAudioErrorRef.current?.(deckIdx, pos);
            return;
          }

          const sep = baseStreamUrl.includes('?') ? '&' : '?';
          const retryUrl = `${baseStreamUrl}${sep}retry=${attempts + 1}&t=${Date.now()}`;
          updateDeckSong(deckIdx, {
            ...deckSongsRef.current[deckIdx],
            stream_url: retryUrl,
            _seekOnLoad: pos,
            _recoveryNonce: Date.now(),
          });
        }, delay);

        recoveryTimersRef.current.set(idKey, timer);
        return;
      }

      // 2. Recovery exhausted or fatal error: seamlessly fall back to YouTube (or background audio if tab is hidden)
      failedHifiIdsRef.current.add(idKey);
      if (s.hifi_id) failedHifiIdsRef.current.add(String(s.hifi_id));
      isRecoveringRef.current = pos > 0;
      if (audioEl) {
        try {
          programmaticPauseUntilRef.current = Date.now() + 300;
          audioEl.pause();
          audioEl.removeAttribute('src');
          audioEl.load();
        } catch {}
      }

      const downgraded = {
        ...s,
        stream_url: null,
        source: null,
        _hifiFailed: true,
        _seekOnLoad: Math.floor(pos),
        _recoveryNonce: Date.now(),
      };
      const deckDowngraded = maybeWrapHiddenSongFallback(downgraded, pos);
      updateDeckSong(deckIdx, deckDowngraded);
      onSongHifiFailed?.(downgraded);
    },
    [updateDeckSong, onSongHifiFailed, maybeWrapHiddenSongFallback]
  );
  handleAudioErrorRef.current = handleAudioError;

  const handleYouTubeBackgroundFallback = useCallback(
    (deckIdx, resumeSecs = 0) => {
      if (deckIdx !== activeDeckRef.current) return;
      const s = deckSongsRef.current[deckIdx];
      if (!s || getDeckMode(s) !== 'youtube') return;

      if (!s._bgAudioFailed) {
        const pos = Math.max(0, Number(resumeSecs) || currentTimeRef.current || 0);
        const fb = createHiddenSongAudioTrack(s, pos, Date.now());
        if (fb) {
          try {
            ytRefs[deckIdx]?.current?.stopVideo?.();
          } catch {}
          isRecoveringRef.current = fb._seekOnLoad > 0;
          setIsBuffering(true);
          updateDeckSong(deckIdx, fb);
          return;
        }
      }

      if (isTabHidden()) {
        isRecoveringRef.current = false;
        onNextRef.current?.({ fromError: true, failedSong: s });
      }
    },
    [getDeckMode, updateDeckSong]
  );
  handleYouTubeBackgroundFallbackRef.current = handleYouTubeBackgroundFallback;

  const handleYouTubeError = useCallback(
    async (deckIdx, errorCode) => {
      const s = deckSongsRef.current[deckIdx];
      if (!s) return;
      if (!s._bgAudioFailed && (errorCode === 101 || errorCode === 150 || errorCode === 2 || errorCode === 5)) {
        try {
          const proxyUrl = buildVideoAudioStreamUrl(s, { skipHifi: true });
          const fallbackUrl = proxyUrl || (await api.getStreamUrl(s.youtube_id || s.id))?.url;
          if (fallbackUrl && deckSongsRef.current[deckIdx]?.id === s.id) {
            const pos = deckIdx === activeDeckRef.current ? currentTimeRef.current || 0 : 0;
            isRecoveringRef.current = deckIdx === activeDeckRef.current && pos > 0;
            updateDeckSong(deckIdx, {
              ...s,
              _fallbackAudioUrl: fallbackUrl,
              _isHiddenYtFallback: true,
              _ytFailed: true,
              _seekOnLoad: Math.floor(pos),
              _recoveryNonce: Date.now(),
            });
            return;
          }
        } catch {}
      }
      if (deckIdx === activeDeckRef.current) {
        isRecoveringRef.current = false;
        onNextRef.current?.({ fromError: true });
      }
    },
    [updateDeckSong]
  );

  // Recover missed track ends or paused decks when returning from background tab/sleep, and finish crossfades on hide
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const recoverVisiblePlayback = () => {
      if (document.visibilityState !== 'visible') return;
      if (!isPlayingRef.current && !pendingAutoplayResumeRef.current) return;
      pendingAutoplayResumeRef.current = false;

      const d = activeDeckRef.current;
      const s = deckSongsRef.current[d];
      if (!s) return;
      if (getDeckMode(s) === 'audio') {
        const audio = audioRefs[d]?.current;
        if (!audio) return;
        if (audio.ended) {
          handleTrackEndRef.current?.(d);
        } else if (audio.paused && !isRecoveringRef.current && audio.getAttribute('src')) {
          audio.play().catch((err) => handleAudioPlayRejected(d, err));
        }
      } else {
        const yt = ytRefs[d]?.current;
        try {
          const state = yt?.getPlayerState?.();
          if (state === 0) {
            handleTrackEndRef.current?.(d);
          } else if (state !== 1 && state !== 3) {
            yt?.playVideo?.();
          }
        } catch {}
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (isCrossfadingRef.current) {
          finishCrossfade();
        }
        return;
      }
      recoverVisiblePlayback();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window?.addEventListener?.('focus', recoverVisiblePlayback);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window?.removeEventListener?.('focus', recoverVisiblePlayback);
    };
  }, [getDeckMode, handleAudioPlayRejected, finishCrossfade]);

  // Keep OS / mobile lock-screen MediaSession controls synchronized for background playback
  useEffect(() => {
    if (suppressMediaSession) return undefined;
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return undefined;
    const ms = navigator.mediaSession;
    if (!currentSong) {
      try {
        ms.metadata = null;
        ms.playbackState = 'none';
      } catch {}
      return undefined;
    }
    try {
      const artist = (currentSong.channel || currentSong.artist || '').replace(/\s*-\s*Topic$/i, '').trim();
      const artwork = currentSong.thumbnail
        ? [{ src: currentSong.thumbnail, sizes: '512x512', type: 'image/jpeg' }]
        : [];
      if (typeof MediaMetadata !== 'undefined') {
        ms.metadata = new MediaMetadata({
          title: currentSong.title || 'NadaNada',
          artist: artist || 'NadaNada',
          album: currentSong.album || '',
          artwork,
        });
      }
      ms.playbackState = isPlaying ? 'playing' : 'paused';
    } catch {}
    return undefined;
  }, [suppressMediaSession, currentSong?.id, currentSong?.title, currentSong?.channel, currentSong?.artist, currentSong?.album, currentSong?.thumbnail, isPlaying]);

  useEffect(() => {
    if (suppressMediaSession) return undefined;
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return undefined;
    const ms = navigator.mediaSession;
    const safeSet = (action, handler) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {}
    };
    safeSet('play', () => {
      if (!isPlayingRef.current) togglePlay();
    });
    safeSet('pause', () => {
      if (isPlayingRef.current) togglePlay();
    });
    safeSet('previoustrack', () => onPreviousRef.current?.());
    safeSet('nexttrack', () => onNextRef.current?.({ fromMediaSession: true }));
    safeSet('seekto', (details) => {
      if (typeof details?.seekTime === 'number') seekTo(details.seekTime);
    });
    return () => {
      safeSet('play', null);
      safeSet('pause', null);
      safeSet('previoustrack', null);
      safeSet('nexttrack', null);
      safeSet('seekto', null);
    };
  }, [suppressMediaSession, togglePlay, seekTo]);

  const activeDeckSong = deckSongs[activeDeck];
  const activeMode = getDeckMode(activeDeckSong);
  const isPlayingHiFi = isSongHiFi(activeDeckSong);

  return {
    activeDeck,
    deckSongs,
    deckOpacities,
    audioRefs,
    ytRefs,
    isPlaying,
    isPlayingRef,
    isDraggingRef,
    isBuffering,
    isGatingHifi,
    isGatingHifiRef,
    setIsBuffering,
    setIsPlaying: setPlayingState,
    isRecoveringRef,
    programmaticPauseUntilRef,
    clearRecovering,
    isCrossfading,
    currentTime,
    duration,
    masterVolume,
    isMuted,
    activeMode,
    isPlayingHiFi,
    getDeckMode,
    isSongHiFi,
    togglePlay,
    pause,
    seekTo,
    seekBy,
    setDragging: (v) => { isDraggingRef.current = v; },
    setPreviewTime: (t) => setCurrentTime(Number(t) || 0),
    syncAudioProgress,
    unlockAudioDecks,
    handleVolumeChange,
    toggleMute,
    applyDeckVolume,
    syncActiveDeckVolume,
    markDeckReady,
    enforceSinglePlayback,
    handleTrackEnd,
    handleAudioError,
    handleYouTubeBackgroundFallback,
    handleAudioPlayRejected,
    handleYouTubeError,
  };
}
