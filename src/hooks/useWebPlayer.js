import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import {
  isHifiEligibleTrack,
  getCachedHifi,
  resolveHifiForTrack,
  parseDurationToSecs,
} from '../services/hifiResolver';

export function useWebPlayer({
  currentSong,
  nextSong,
  hasNext,
  isHifiEnabled,
  crossfadeDuration,
  repeatMode,
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
  const deckUnlockedRef = useRef([false, false]);
  const hifiRetryRef = useRef(new Map());
  const failedHifiIdsRef = useRef(new Set());
  const recoveryTimersRef = useRef(new Map());
  const isRecoveringRef = useRef(false);
  const stallTrackerRef = useRef({ key: null, lastTime: -1, ticks: 0 });
  const handleAudioErrorRef = useRef(null);
  const handleTrackEndRef = useRef(null);

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

  // Prime inactive audio deck during a user gesture so mobile/background crossfades retain autoplay permission
  const unlockAudioDecks = useCallback(() => {
    const SILENT_WAV =
      'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
    [0, 1].forEach((idx) => {
      if (deckUnlockedRef.current[idx]) return;
      const el = audioRefs[idx]?.current;
      if (!el) return;
      if (deckSongsRef.current[idx]) {
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
            if (!deckSongsRef.current[idx]) {
              el.pause();
              el.removeAttribute('src');
              el.load();
              el.muted = isMutedRef.current;
            }
          }).catch(() => {
            deckUnlockedRef.current[idx] = false;
            if (!deckSongsRef.current[idx]) {
              el.removeAttribute('src');
              el.muted = isMutedRef.current;
            }
          });
        }
      } catch {
        deckUnlockedRef.current[idx] = false;
      }
    });
  }, []);

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

  const updateDeckSong = useCallback((deckIdx, nextVal) => {
    setDeckSongs((prev) => {
      const copy = [...prev];
      copy[deckIdx] = nextVal;
      deckSongsRef.current = copy;
      return copy;
    });
  }, []);

  const cancelCrossfade = useCallback(() => {
    const wasActive = isCrossfadingRef.current || isPreloadingRef.current;
    clearCrossfadeTimers();
    if (wasActive) {
      const inactive = 1 - activeDeckRef.current;
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
          newAudio.play?.().catch((err) => {
            if (err?.name !== 'AbortError') {
              setPlayingState(false);
            }
          });
        }
      }
    }
    setPlayCount(0);
    hasTriggeredEndCrossfadeRef.current = false;
    onNextRef.current?.({ fromCrossfade: true });
  }, [clearCrossfadeTimers, stopDeckMedia, updateDeckSong, applyDeckVolume, getDeckMode, setPlayingState]);

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

      // In background tabs browsers throttle timers and may block secondary-deck autoplay; let native ended advance instead
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

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
    stallTrackerRef.current = { key: null, lastTime: -1, ticks: 0 };

    const curDeck = activeDeckRef.current;
    const otherDeck = 1 - curDeck;
    stopDeckMedia(otherDeck);
    updateDeckSong(otherDeck, null);

    let activeCopy = { ...currentSong };
    if (isHifiEnabled && isHifiEligibleTrack(activeCopy) && !activeCopy.stream_url && !activeCopy._userForcedYoutube) {
      const cached = getCachedHifi(activeCopy);
      if (cached) activeCopy = { ...activeCopy, ...cached };
    }

    updateDeckSong(curDeck, activeCopy);
    setDeckOpacities(curDeck === 0 ? [1, 0] : [0, 1]);
    // Never auto-play a restored queue track on page load; keep the button in Play state until the user starts it
    if (isInitialHydration) {
      setPlayingState(false);
      setIsBuffering(false);
    } else {
      setPlayingState(true);
      setIsBuffering(true);
    }
    applyDeckVolume(curDeck, isMutedRef.current ? 0 : masterVolRef.current);

    // Resolve Hi-Fi in background if not yet cached
    if (isHifiEnabled && isHifiEligibleTrack(activeCopy) && !activeCopy.stream_url && !activeCopy._userForcedYoutube && !failedHifiIdsRef.current.has(String(activeCopy.id))) {
      resolveHifiForTrack(activeCopy, { mode: 'play' }).then((resolved) => {
        if (resolved?.stream_url && deckSongsRef.current[activeDeckRef.current]?.id === activeCopy.id) {
          const d = activeDeckRef.current;
          const upgraded = { ...deckSongsRef.current[d], ...resolved };
          onSongHifiResolved?.(upgraded);
          const audioPos = audioRefs[d]?.current?.currentTime > 0.25 ? audioRefs[d].current.currentTime : 0;
          const ytPos = ytRefs[d]?.current?.getCurrentTime?.() || 0;
          const pos = Math.max(audioPos, ytPos, currentTimeRef.current || 0);
          if (pos < 30) {
            isRecoveringRef.current = pos > 0;
            try { ytRefs[d]?.current?.stopVideo?.(); } catch {}
            updateDeckSong(d, { ...upgraded, _seekOnLoad: pos, _recoveryNonce: Date.now() });
          }
        }
      });
    }
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
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      updateDeckSong(curDeck, {
        ...deckSong,
        stream_url: null,
        _userForcedYoutube: currentSong._userForcedYoutube,
        _hifiFailed: currentSong._hifiFailed,
        _seekOnLoad: Math.floor(pos),
        _recoveryNonce: Date.now(),
      });
    } else if (isHifiEnabled && currentSong.stream_url && !deckSong.stream_url && !currentSong._userForcedYoutube && !currentSong._hifiFailed) {
      const audio = audioRefs[curDeck]?.current;
      const yt = ytRefs[curDeck]?.current;
      const audioPos = audio?.currentTime > 0.25 ? audio.currentTime : 0;
      const pos = Math.max(audioPos, yt?.getCurrentTime?.() || 0, currentTimeRef.current || 0);
      if (pos < 30 || currentSong._manualHifiRetry) {
        if (currentSong._manualHifiRetry) {
          failedHifiIdsRef.current.delete(String(currentSong.id));
          hifiRetryRef.current.delete(String(currentSong.id));
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
          _seekOnLoad: pos,
          _recoveryNonce: Date.now(),
        });
      }
    }
  }, [currentSong?.stream_url, currentSong?._userForcedYoutube, currentSong?._hifiFailed, currentSong?._manualHifiRetry, isHifiEnabled, clearRecoveryTimers]);

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

  // 100ms timer polling active deck progress + triggering lyrics sync, stall recovery & auto-crossfade
  useEffect(() => {
    const interval = setInterval(() => {
      if (!isPlayingRef.current || isDraggingRef.current) return;
      const d = activeDeckRef.current;
      const s = deckSongsRef.current[d];
      if (!s) return;

      let time = 0;
      let dur = 0;
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

          // Recover cleanly via unified handleAudioError if stream stalls silently mid-track (~8s)
          const sKey = `${s.uid || s.id}:${audio.currentSrc || ''}`;
          const st = stallTrackerRef.current;
          if (st.key !== sKey) {
            stallTrackerRef.current = { key: sKey, lastTime: time, ticks: 0 };
          } else if (!audio.paused && dur > 10 && time < dur - 1.2) {
            if (Math.abs(time - st.lastTime) < 0.05) {
              st.ticks += 1;
              if (st.ticks >= 80) {
                st.ticks = 0;
                const resumeAt = Math.max(time, currentTimeRef.current || 0);
                handleAudioErrorRef.current?.(d, resumeAt);
                return;
              }
            } else {
              // Healthy progress resumed: reset stall counter and retry budget once advancing steadily
              if (time - st.lastTime > 0.05 && time > (s._seekOnLoad || 0) + 2) {
                hifiRetryRef.current.delete(String(s.id));
              }
              st.lastTime = time;
              st.ticks = 0;
            }
          } else {
            st.lastTime = time;
            st.ticks = 0;
          }
        }
      } else {
        const yt = ytRefs[d]?.current;
        if (yt) {
          try {
            if (yt.getPlayerState?.() === 0) {
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
          p.catch((err) => {
            if (err?.name !== 'AbortError') {
              setPlayingState(false);
            }
          });
        }
      } else {
        audio.pause();
        setPlayingState(false);
      }
    } else {
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
  }, [getDeckMode, unlockAudioDecks, setPlayingState]);

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
      if (repeatModeRef.current === 1) {
        seekTo(0);
        const s = deckSongsRef.current[deckIdx];
        if (getDeckMode(s) === 'audio') audioRefs[deckIdx]?.current?.play?.().catch(() => {});
        else ytRefs[deckIdx]?.current?.playVideo?.();
        setPlayingState(true);
        return;
      }
      if (repeatModeRef.current === 2 && playCountRef.current < 1) {
        setPlayCount(1);
        seekTo(0);
        const s = deckSongsRef.current[deckIdx];
        if (getDeckMode(s) === 'audio') audioRefs[deckIdx]?.current?.play?.().catch(() => {});
        else ytRefs[deckIdx]?.current?.playVideo?.();
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
    [finishCrossfade, seekTo, getDeckMode, setPlayingState]
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
        isRecoveringRef.current = false;
        onNextRef.current?.({ fromError: true });
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

      // 2. Recovery exhausted or fatal error: seamlessly fall back to YouTube at the exact preserved position
      failedHifiIdsRef.current.add(idKey);
      if (s.hifi_id) failedHifiIdsRef.current.add(String(s.hifi_id));
      isRecoveringRef.current = pos > 0;
      if (audioEl) {
        try {
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
      updateDeckSong(deckIdx, downgraded);
      onSongHifiFailed?.(downgraded);
    },
    [updateDeckSong, onSongHifiFailed]
  );
  handleAudioErrorRef.current = handleAudioError;

  const handleYouTubeError = useCallback(
    async (deckIdx, errorCode) => {
      const s = deckSongsRef.current[deckIdx];
      if (!s) return;
      if (errorCode === 101 || errorCode === 150) {
        try {
          const res = await api.getStreamUrl(s.youtube_id || s.id);
          if (res?.url && deckSongsRef.current[deckIdx]?.id === s.id) {
            const pos = deckIdx === activeDeckRef.current ? currentTimeRef.current || 0 : 0;
            isRecoveringRef.current = deckIdx === activeDeckRef.current && pos > 0;
            updateDeckSong(deckIdx, {
              ...s,
              _fallbackAudioUrl: res.url,
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

  // Recover missed track ends or paused decks when returning from background tab/sleep
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || !isPlayingRef.current) return;
      const d = activeDeckRef.current;
      const s = deckSongsRef.current[d];
      if (!s) return;
      if (getDeckMode(s) === 'audio') {
        const audio = audioRefs[d]?.current;
        if (!audio) return;
        if (audio.ended) {
          handleTrackEndRef.current?.(d);
        } else if (audio.paused && !isRecoveringRef.current && audio.getAttribute('src')) {
          audio.play().catch((err) => {
            if (err?.name !== 'AbortError') setPlayingState(false);
          });
        }
      } else {
        const yt = ytRefs[d]?.current;
        try {
          if (yt?.getPlayerState?.() === 0) {
            handleTrackEndRef.current?.(d);
          }
        } catch {}
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [getDeckMode, setPlayingState]);

  // Keep OS / mobile lock-screen MediaSession controls synchronized for background playback
  useEffect(() => {
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
  }, [currentSong?.id, currentSong?.title, currentSong?.channel, currentSong?.artist, currentSong?.album, currentSong?.thumbnail, isPlaying]);

  useEffect(() => {
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
  }, [togglePlay, seekTo]);

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
    setIsBuffering,
    setIsPlaying: setPlayingState,
    isRecoveringRef,
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
    handleTrackEnd,
    handleAudioError,
    handleYouTubeError,
  };
}
