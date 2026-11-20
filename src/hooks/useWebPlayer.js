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
    const v = saved !== null ? parseInt(saved, 10) : 85;
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 85;
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
  const hasTriggeredEndCrossfadeRef = useRef(false);
  const justCrossfadedSongIdRef = useRef(null);
  const fadeIntervalRef = useRef(null);
  const preloadTimeoutRef = useRef(null);
  const isDraggingRef = useRef(false);
  const prevSongKeyRef = useRef(null);
  const hifiRetryRef = useRef(new Map());
  const failedHifiIdsRef = useRef(new Set());

  const masterVolRef = useRef(masterVolume);
  const isMutedRef = useRef(isMuted);
  const repeatModeRef = useRef(repeatMode);
  const playCountRef = useRef(playCount);
  const nextSongRef = useRef(nextSong);
  const hasNextRef = useRef(hasNext);
  const onNextRef = useRef(onNext);
  const crossfadeRef = useRef(crossfadeDuration);

  masterVolRef.current = masterVolume;
  isMutedRef.current = isMuted;
  repeatModeRef.current = repeatMode;
  playCountRef.current = playCount;
  nextSongRef.current = nextSong;
  hasNextRef.current = hasNext;
  onNextRef.current = onNext;
  crossfadeRef.current = crossfadeDuration;
  isPlayingRef.current = isPlaying;
  deckSongsRef.current = deckSongs;

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
      audio.muted = isMutedRef.current || v === 0;
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
    setIsCrossfading(false);
  }, []);

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
    }
    setPlayCount(0);
    hasTriggeredEndCrossfadeRef.current = false;
    onNextRef.current?.({ fromCrossfade: true });
  }, [clearCrossfadeTimers, stopDeckMedia, updateDeckSong, applyDeckVolume]);

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
      setIsCrossfading(true);

      const newAudio = audioRefs[newDeck]?.current;
      if (getDeckMode(incoming) === 'audio' && newAudio) {
        newAudio.volume = 0;
        newAudio.play?.().catch(() => {});
      } else {
        const yt = ytRefs[newDeck]?.current;
        yt?.setVolume?.(0);
        yt?.playVideo?.();
      }

      const startTime = performance.now();
      const totalMs = Math.max(400, effectiveSecs * 1000);
      if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current);

      fadeIntervalRef.current = setInterval(() => {
        const elapsed = performance.now() - startTime;
        const progress = Math.min(1, elapsed / totalMs);
        const factorOut = Math.cos(progress * (Math.PI / 2));
        const factorIn = Math.sin(progress * (Math.PI / 2));
        const targetVol = isMutedRef.current ? 0 : masterVolRef.current;

        applyDeckVolume(oldDeck, targetVol * factorOut);
        applyDeckVolume(newDeck, targetVol * factorIn);
        setDeckOpacities(oldDeck === 0 ? [1 - progress, progress] : [progress, 1 - progress]);

        if (progress >= 1) {
          finishCrossfade();
        }
      }, 30);
    },
    [finishCrossfade, clearCrossfadeTimers, getDeckMode, applyDeckVolume]
  );

  const preloadIncomingSong = useCallback(
    async (song) => {
      if (!song || isPreloadingRef.current || hasPreloadedRef.current) return;
      isPreloadingRef.current = true;
      const inDeck = 1 - activeDeckRef.current;

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
        if (!isCrossfadingRef.current && hasPreloadedRef.current && isPreloadingRef.current) {
          cancelCrossfade();
        }
      }, (crossfadeRef.current + 6) * 1000);
    },
    [isHifiEnabled, onSongHifiResolved, updateDeckSong, applyDeckVolume, cancelCrossfade]
  );

  const checkAutoCrossfade = useCallback(
    (time, dur) => {
      const cf = crossfadeRef.current;
      if (!cf || cf <= 0 || !dur || dur <= 10 || time < 5 || time < cf + 2) return;
      if (!hasNextRef.current || !nextSongRef.current) return;
      const looping = repeatModeRef.current === 1 || (repeatModeRef.current === 2 && playCountRef.current < 1);
      if (looping) return;

      const remaining = dur - time;
      if (
        remaining <= cf + 5 &&
        remaining > cf &&
        !isPreloadingRef.current &&
        !hasPreloadedRef.current &&
        !isCrossfadingRef.current
      ) {
        preloadIncomingSong(nextSongRef.current);
      }

      if (remaining <= cf && remaining > 0.1 && !hasTriggeredEndCrossfadeRef.current && !isCrossfadingRef.current) {
        hasTriggeredEndCrossfadeRef.current = true;
        if (hasPreloadedRef.current) {
          startCrossfadeRamp(remaining);
        } else {
          preloadIncomingSong(nextSongRef.current).then(() => startCrossfadeRamp(remaining));
        }
      }
    },
    [preloadIncomingSong, startCrossfadeRamp]
  );

  // Load currentSong onto activeDeck whenever track identity changes
  useEffect(() => {
    if (!currentSong) {
      cancelCrossfade();
      stopDeckMedia(0);
      stopDeckMedia(1);
      setDeckSongs([null, null]);
      deckSongsRef.current = [null, null];
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
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

    cancelCrossfade();
    hasTriggeredEndCrossfadeRef.current = false;
    setPlayCount(0);
    setCurrentTime(0);
    setDuration(parseDurationToSecs(currentSong.duration));

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
    setIsPlaying(true);
    setIsBuffering(true);
    applyDeckVolume(curDeck, isMutedRef.current ? 0 : masterVolRef.current);

    // Resolve Hi-Fi in background if not yet cached
    if (isHifiEnabled && isHifiEligibleTrack(activeCopy) && !activeCopy.stream_url && !activeCopy._userForcedYoutube && !failedHifiIdsRef.current.has(String(activeCopy.id))) {
      resolveHifiForTrack(activeCopy).then((resolved) => {
        if (resolved?.stream_url && deckSongsRef.current[activeDeckRef.current]?.id === activeCopy.id) {
          const upgraded = { ...deckSongsRef.current[activeDeckRef.current], ...resolved };
          onSongHifiResolved?.(upgraded);
          const pos = ytRefs[activeDeckRef.current]?.current?.getCurrentTime?.() || 0;
          if (pos < 30) {
            try { ytRefs[activeDeckRef.current]?.current?.stopVideo?.(); } catch {}
            updateDeckSong(activeDeckRef.current, { ...upgraded, _seekOnLoad: pos });
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
      const audio = audioRefs[curDeck]?.current;
      const pos = audio?.currentTime || 0;
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
      });
    } else if (isHifiEnabled && currentSong.stream_url && !deckSong.stream_url && !currentSong._userForcedYoutube && !currentSong._hifiFailed) {
      const yt = ytRefs[curDeck]?.current;
      const pos = yt?.getCurrentTime?.() || 0;
      if (pos < 30) {
        try { yt?.stopVideo?.(); } catch {}
        updateDeckSong(curDeck, {
          ...deckSong,
          stream_url: currentSong.stream_url,
          hifi_id: currentSong.hifi_id,
          source: currentSong.source,
          _seekOnLoad: pos,
        });
      }
    }
  }, [currentSong?.stream_url, currentSong?._userForcedYoutube, currentSong?._hifiFailed, isHifiEnabled]);

  // 100ms timer polling active deck progress + triggering lyrics sync & auto-crossfade
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
          time = audio.currentTime || 0;
          dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : parseDurationToSecs(s.duration);
        }
      } else {
        const yt = ytRefs[d]?.current;
        if (yt) {
          try {
            time = yt.getCurrentTime?.() || 0;
            dur = yt.getDuration?.() || parseDurationToSecs(s.duration);
          } catch {}
        }
      }

      setCurrentTime(time);
      if (dur > 0) setDuration(dur);
      window.dispatchEvent(new CustomEvent('timeupdate', { detail: time }));
      checkAutoCrossfade(time, dur);
    }, 100);
    return () => clearInterval(interval);
  }, [getDeckMode, checkAutoCrossfade]);

  const togglePlay = useCallback(() => {
    const d = activeDeckRef.current;
    const s = deckSongsRef.current[d];
    if (!s) return;
    if (getDeckMode(s) === 'audio') {
      const audio = audioRefs[d]?.current;
      if (!audio) return;
      if (audio.paused) {
        audio.play().catch(() => {});
        setIsPlaying(true);
      } else {
        audio.pause();
        setIsPlaying(false);
      }
    } else {
      const yt = ytRefs[d]?.current;
      if (!yt) return;
      if (isPlayingRef.current) {
        yt.pauseVideo?.();
        setIsPlaying(false);
      } else {
        yt.playVideo?.();
        setIsPlaying(true);
      }
    }
  }, [getDeckMode]);

  const seekTo = useCallback(
    (targetTime) => {
      cancelCrossfade();
      const d = activeDeckRef.current;
      const s = deckSongsRef.current[d];
      if (!s) return;
      const clamped = Math.max(0, Number(targetTime) || 0);
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
        if (getDeckMode(s) === 'audio') audioRefs[deckIdx]?.current?.play?.();
        else ytRefs[deckIdx]?.current?.playVideo?.();
        setIsPlaying(true);
        return;
      }
      if (repeatModeRef.current === 2 && playCountRef.current < 1) {
        setPlayCount(1);
        seekTo(0);
        const s = deckSongsRef.current[deckIdx];
        if (getDeckMode(s) === 'audio') audioRefs[deckIdx]?.current?.play?.();
        else ytRefs[deckIdx]?.current?.playVideo?.();
        setIsPlaying(true);
        return;
      }
      setPlayCount(0);
      onNextRef.current?.({ fromEnd: true });
    },
    [finishCrossfade, seekTo, getDeckMode]
  );

  const handleAudioError = useCallback(
    async (deckIdx) => {
      const s = deckSongsRef.current[deckIdx];
      if (!s) return;
      if (s._fallbackAudioUrl) {
        onNextRef.current?.({ fromError: true });
        return;
      }

      const idKey = String(s.id);
      const count = hifiRetryRef.current.get(idKey) || 0;
      if (count < 1 && s.stream_url) {
        hifiRetryRef.current.set(idKey, count + 1);
        const refreshed = await resolveHifiForTrack(s, { forceRefresh: true });
        if (refreshed?.stream_url && deckSongsRef.current[deckIdx]?.id === s.id) {
          updateDeckSong(deckIdx, {
            ...s,
            stream_url: `${refreshed.stream_url}&retry=1&t=${Date.now()}`,
          });
          return;
        }
      }

      failedHifiIdsRef.current.add(idKey);
      const pos = audioRefs[deckIdx]?.current?.currentTime || 0;
      const downgraded = {
        ...s,
        stream_url: null,
        source: null,
        _hifiFailed: true,
        _seekOnLoad: Math.floor(pos),
      };
      updateDeckSong(deckIdx, downgraded);
      onSongHifiFailed?.(downgraded);
    },
    [updateDeckSong, onSongHifiFailed]
  );

  const handleYouTubeError = useCallback(
    async (deckIdx, errorCode) => {
      const s = deckSongsRef.current[deckIdx];
      if (!s) return;
      if (errorCode === 101 || errorCode === 150) {
        try {
          const res = await api.getStreamUrl(s.youtube_id || s.id);
          if (res?.url && deckSongsRef.current[deckIdx]?.id === s.id) {
            updateDeckSong(deckIdx, { ...s, _fallbackAudioUrl: res.url });
            return;
          }
        } catch {}
      }
      if (deckIdx === activeDeckRef.current) {
        onNextRef.current?.({ fromError: true });
      }
    },
    [updateDeckSong]
  );

  const activeDeckSong = deckSongs[activeDeck];
  const activeMode = getDeckMode(activeDeckSong);
  const isPlayingHiFi = activeMode === 'audio' && !activeDeckSong?._fallbackAudioUrl;

  return {
    activeDeck,
    deckSongs,
    deckOpacities,
    audioRefs,
    ytRefs,
    isPlaying,
    isBuffering,
    setIsBuffering,
    setIsPlaying,
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
    handleVolumeChange,
    toggleMute,
    applyDeckVolume,
    handleTrackEnd,
    handleAudioError,
    handleYouTubeError,
  };
}
