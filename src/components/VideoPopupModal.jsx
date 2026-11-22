import React, { useEffect, useMemo, useRef } from 'react';
import YouTube from 'react-youtube';
import { Minimize2, X } from 'lucide-react';

const VALID_YT_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function parseValidVideoId(candidate) {
  const id = String(candidate || '').trim();
  return VALID_YT_ID_RE.test(id) ? id : null;
}

export default function VideoPopupModal({
  track,
  standbyVideoId = null,
  isMinimized,
  isFullscreen,
  masterVolume,
  isMuted,
  ytPlayerRef,
  stageRef,
  desiredPlayingRef,
  onPlayingChange,
  onTimeUpdate,
  onEnded,
  onError,
  onBackgroundSuspend,
  onAutoplayStalled,
  onMinimize,
  onExitFullscreen,
  onClose,
}) {
  const isSeekingGuardRef = useRef(false);
  const hasStartedPlayingRef = useRef(false);
  const loadedVideoIdRef = useRef(null);
  const warmedStandbyIdRef = useRef(null);
  const standbyPauseAtRef = useRef(0);
  const persistedVideoIdRef = useRef(null);
  const initialVideoIdRef = useRef(null);
  const cardRef = useRef(null);

  const trackRef = useRef(track);
  trackRef.current = track;
  const masterVolumeRef = useRef(masterVolume);
  masterVolumeRef.current = masterVolume;
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  const onPlayingChangeRef = useRef(onPlayingChange);
  onPlayingChangeRef.current = onPlayingChange;
  const onTimeUpdateRef = useRef(onTimeUpdate);
  onTimeUpdateRef.current = onTimeUpdate;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onBackgroundSuspendRef = useRef(onBackgroundSuspend);
  onBackgroundSuspendRef.current = onBackgroundSuspend;
  const onAutoplayStalledRef = useRef(onAutoplayStalled);
  onAutoplayStalledRef.current = onAutoplayStalled;

  const activeVideoId = parseValidVideoId(track?.youtube_id || track?.id);
  const validStandbyId = parseValidVideoId(standbyVideoId);
  const standbyVideoIdRef = useRef(validStandbyId);
  standbyVideoIdRef.current = validStandbyId;
  const targetVideoId = activeVideoId || validStandbyId;
  if (targetVideoId) {
    persistedVideoIdRef.current = targetVideoId;
    if (!initialVideoIdRef.current) {
      initialVideoIdRef.current = targetVideoId;
    }
  }
  const shouldRenderPlayer = Boolean(initialVideoIdRef.current);

  const startSecs = Math.max(0, Math.floor(Number(track?._videoStartAt) || 0));
  const shouldAutoPlay = track?._videoAutoPlay !== false;
  const startSecsRef = useRef(startSecs);
  startSecsRef.current = startSecs;
  const shouldAutoPlayRef = useRef(shouldAutoPlay);
  shouldAutoPlayRef.current = shouldAutoPlay;

  // Keep opts stable after initial mount so react-youtube never tears down and recreates the iframe
  const ytOpts = useMemo(
    () => ({
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: track ? (shouldAutoPlay ? 1 : 0) : 1,
        mute: track ? 0 : 1,
        controls: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shouldRenderPlayer]
  );

  // Progress polling only runs while a video track is active in the modal
  useEffect(() => {
    if (!track) return undefined;
    const timer = setInterval(() => {
      const yt = ytPlayerRef.current;
      if (!yt || isSeekingGuardRef.current || !trackRef.current) return;
      try {
        const cur = yt.getCurrentTime?.() || 0;
        const dur = yt.getDuration?.() || 0;
        onTimeUpdateRef.current?.(cur, dur);
      } catch {}
    }, 250);
    return () => clearInterval(timer);
  }, [track?.id, ytPlayerRef]);

  // Sync volume when active; keep muted when idle/standby
  useEffect(() => {
    const yt = ytPlayerRef.current;
    if (!yt) return;
    try {
      if (!track) {
        yt.mute?.();
        yt.setVolume?.(0);
        return;
      }
      yt.setVolume?.(Math.round(isMuted ? 0 : masterVolume));
      if (isMuted) yt.mute?.();
      else yt.unMute?.();
    } catch {}
  }, [track, masterVolume, isMuted, ytPlayerRef]);

  // Load or resume target video inside the existing persistent iframe whenever track or standby changes
  useEffect(() => {
    const yt = ytPlayerRef.current;
    if (!yt) return;

    try {
      if (activeVideoId) {
        if (isMutedRef.current) yt.mute?.();
        else yt.unMute?.();
        yt.setVolume?.(Math.round(isMutedRef.current ? 0 : masterVolumeRef.current));

        const wasLoaded = loadedVideoIdRef.current === activeVideoId;
        const wasPrewarmed = warmedStandbyIdRef.current === activeVideoId;
        standbyPauseAtRef.current = 0;

        if (!wasLoaded) {
          loadedVideoIdRef.current = activeVideoId;
          warmedStandbyIdRef.current = null;
          if (shouldAutoPlay) {
            yt.loadVideoById?.({ videoId: activeVideoId, startSeconds: startSecs });
            yt.playVideo?.();
          } else {
            yt.cueVideoById?.({ videoId: activeVideoId, startSeconds: startSecs });
          }
        } else {
          if (wasPrewarmed || startSecs > 0) {
            yt.seekTo?.(startSecs, true);
          }
          warmedStandbyIdRef.current = null;
          if (shouldAutoPlay) {
            yt.playVideo?.();
          } else {
            yt.pauseVideo?.();
          }
        }
      } else if (validStandbyId) {
        if (warmedStandbyIdRef.current !== validStandbyId || loadedVideoIdRef.current !== validStandbyId) {
          loadedVideoIdRef.current = validStandbyId;
          warmedStandbyIdRef.current = null;
          yt.mute?.();
          yt.setVolume?.(0);
          yt.loadVideoById?.({ videoId: validStandbyId, startSeconds: 0 });
        }
      } else {
        loadedVideoIdRef.current = null;
        warmedStandbyIdRef.current = null;
        yt.mute?.();
        yt.stopVideo?.();
      }
    } catch {}
  }, [activeVideoId, validStandbyId, track?._videoStartAt, track?._videoAutoPlay, ytPlayerRef]);

  useEffect(() => {
    if (!track || isMinimized) return;
    const t = setTimeout(() => {
      const card = cardRef.current;
      if (card && !card.contains(document.activeElement)) {
        try {
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
          card.focus({ preventScroll: true });
        } catch {}
      }
    }, 0);
    return () => clearTimeout(t);
  }, [track?.id, isMinimized]);

  // Watchdog: if YouTube fails to enter PLAYING (or gets blocked while hidden), fall back cleanly to Hi-Fi/audio continuity
  useEffect(() => {
    hasStartedPlayingRef.current = false;
    if (!track || !shouldAutoPlay) return undefined;
    const stallTimer = setTimeout(() => {
      if (hasStartedPlayingRef.current || !trackRef.current) return;
      if (desiredPlayingRef && !desiredPlayingRef.current) return;
      let ytState = -1;
      let resumeSecs = startSecs;
      try {
        const yt = ytPlayerRef.current;
        if (yt) {
          ytState = yt.getPlayerState?.();
          resumeSecs = Math.max(startSecs, Math.floor(yt.getCurrentTime?.() || startSecs));
        }
      } catch {}
      if (ytState !== 1 && !track._bgAudioFailed) {
        onAutoplayStalledRef.current?.(track, resumeSecs);
      }
    }, 2800);
    return () => clearTimeout(stallTimer);
  }, [track?.id, track?._videoStartAt, track?._videoAutoPlay, startSecs, shouldAutoPlay, ytPlayerRef, desiredPlayingRef]);

  // Recover YouTube video playback if tab visibility returns after browser suspension
  useEffect(() => {
    if (!track || typeof document === 'undefined') return undefined;
    const onVis = () => {
      if (document.visibilityState !== 'visible' || !trackRef.current) return;
      const yt = ytPlayerRef.current;
      if (!yt || !desiredPlayingRef?.current) return;
      try {
        const state = yt.getPlayerState?.();
        if (state === 0) {
          onEndedRef.current?.();
        } else if (state !== 1 && state !== 3) {
          yt.playVideo?.();
        }
      } catch {}
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [track?.id, ytPlayerRef, desiredPlayingRef]);

  if (!shouldRenderPlayer) return null;

  const visualMinimized = !track || isMinimized;
  const activeFullscreen = Boolean(track && isFullscreen && !isMinimized);

  return (
    <div
      className={`video-popup-backdrop ${visualMinimized ? 'is-minimized' : ''} ${
        activeFullscreen ? 'is-fullscreen' : ''
      }`}
      role={visualMinimized ? undefined : 'dialog'}
      aria-modal={visualMinimized ? undefined : 'true'}
      aria-labelledby={visualMinimized ? undefined : 'videoPopupHeading'}
      aria-hidden={visualMinimized ? 'true' : undefined}
      onClick={() => {
        if (!visualMinimized && !activeFullscreen) onMinimize?.();
      }}
    >
      <div
        ref={cardRef}
        tabIndex={visualMinimized ? undefined : -1}
        className={`modal-card video-popup-card ${activeFullscreen ? 'is-fullscreen' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {!activeFullscreen && track && (
          <div className="card-bar">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
              <span className="video-popup-badge">VIDEO</span>
              <h2 className="card-bar-title" id="videoPopupHeading">
                {track.title || 'Video Player'}
              </h2>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <button
                type="button"
                className="bar-btn"
                id="videoPopupMinimizeBtn"
                onClick={onMinimize}
                aria-label="Minimize video"
                title="Minimize video (keeps playing; miniplayer takes over)"
              >
                <Minimize2 size={13} />
                <span className="hide-mobile">Minimize</span>
              </button>
              <button
                type="button"
                className="bar-btn"
                id="videoPopupCloseBtn"
                onClick={onClose}
                aria-label="Close video"
                title="Close video"
              >
                <X size={13} />
                <span className="hide-mobile">Close</span>
              </button>
            </div>
          </div>
        )}

        <div ref={stageRef} className="video-popup-stage">
          <YouTube
            key="persistent-video-popup"
            videoId={initialVideoIdRef.current}
            opts={ytOpts}
            onReady={(e) => {
              ytPlayerRef.current = e.target;
              const liveTrack = trackRef.current;
              const liveActiveId = parseValidVideoId(liveTrack?.youtube_id || liveTrack?.id);
              const liveStandbyId = standbyVideoIdRef.current;
              try {
                if (liveActiveId) {
                  loadedVideoIdRef.current = liveActiveId;
                  warmedStandbyIdRef.current = null;
                  e.target.setVolume?.(Math.round(isMutedRef.current ? 0 : masterVolumeRef.current));
                  if (isMutedRef.current) e.target.mute?.();
                  else e.target.unMute?.();
                  if (liveActiveId !== initialVideoIdRef.current) {
                    if (shouldAutoPlayRef.current) {
                      e.target.loadVideoById?.({ videoId: liveActiveId, startSeconds: startSecsRef.current });
                      e.target.playVideo?.();
                    } else {
                      e.target.cueVideoById?.({ videoId: liveActiveId, startSeconds: startSecsRef.current });
                    }
                  } else {
                    if (startSecsRef.current > 0) e.target.seekTo?.(startSecsRef.current, true);
                    if (shouldAutoPlayRef.current) e.target.playVideo?.();
                    else e.target.pauseVideo?.();
                  }
                } else if (liveStandbyId) {
                  loadedVideoIdRef.current = liveStandbyId;
                  warmedStandbyIdRef.current = null;
                  e.target.mute?.();
                  e.target.setVolume?.(0);
                  if (liveStandbyId !== initialVideoIdRef.current) {
                    e.target.loadVideoById?.({ videoId: liveStandbyId, startSeconds: 0 });
                  } else {
                    e.target.playVideo?.();
                  }
                } else {
                  e.target.mute?.();
                  e.target.stopVideo?.();
                }
              } catch {}
            }}
            onStateChange={(e) => {
              const liveTrack = trackRef.current;
              if (!liveTrack) {
                const liveStandbyId = standbyVideoIdRef.current;
                if (e.data === 1 && liveStandbyId && warmedStandbyIdRef.current !== liveStandbyId) {
                  warmedStandbyIdRef.current = liveStandbyId;
                  standbyPauseAtRef.current = Date.now();
                  try {
                    e.target.pauseVideo?.();
                    e.target.seekTo?.(0, true);
                  } catch {}
                }
                return;
              }

              if (e.data === 1) {
                standbyPauseAtRef.current = 0;
                hasStartedPlayingRef.current = true;
                try {
                  e.target.setVolume?.(Math.round(isMutedRef.current ? 0 : masterVolumeRef.current));
                  if (isMutedRef.current) e.target.mute?.();
                  else e.target.unMute?.();
                } catch {}
                if (desiredPlayingRef) desiredPlayingRef.current = true;
                onPlayingChangeRef.current?.(true);
              } else if (e.data === 2) {
                if (
                  standbyPauseAtRef.current &&
                  Date.now() - standbyPauseAtRef.current < 1500 &&
                  desiredPlayingRef?.current
                ) {
                  standbyPauseAtRef.current = 0;
                  try {
                    if (!isMutedRef.current) e.target.unMute?.();
                    e.target.setVolume?.(Math.round(isMutedRef.current ? 0 : masterVolumeRef.current));
                    e.target.playVideo?.();
                  } catch {}
                  return;
                }
                if (
                  typeof document !== 'undefined' &&
                  document.visibilityState === 'hidden' &&
                  desiredPlayingRef?.current &&
                  onBackgroundSuspendRef.current &&
                  !liveTrack._bgAudioFailed
                ) {
                  let resumeSecs = 0;
                  try {
                    resumeSecs = Math.max(0, Math.floor(e.target.getCurrentTime?.() || 0));
                  } catch {}
                  onBackgroundSuspendRef.current(liveTrack, resumeSecs);
                  return;
                }
                if (desiredPlayingRef) desiredPlayingRef.current = false;
                onPlayingChangeRef.current?.(false);
              } else if (e.data === 0) {
                if (desiredPlayingRef) desiredPlayingRef.current = false;
                onPlayingChangeRef.current?.(false);
                onEndedRef.current?.();
              }
            }}
            onError={(e) => {
              const liveTrack = trackRef.current;
              if (!liveTrack) return;
              let resumeSecs = startSecsRef.current;
              try {
                resumeSecs = Math.max(0, Math.floor(e.target.getCurrentTime?.() || startSecsRef.current));
              } catch {}
              onErrorRef.current?.(liveTrack, e.data, resumeSecs);
            }}
            style={{ width: '100%', height: '100%' }}
          />
          {activeFullscreen && (
            <button
              type="button"
              className="video-fs-exit-btn"
              id="videoExitFullscreenBtn"
              onClick={onExitFullscreen}
              title="Exit fullscreen (F / Esc)"
            >
              <Minimize2 size={14} />
              <span>Exit Fullscreen <span className="hide-mobile">(F / Esc)</span></span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
