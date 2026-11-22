import React, { useEffect, useRef } from 'react';
import YouTube from 'react-youtube';
import { Minimize2, X } from 'lucide-react';

export default function VideoPopupModal({
  track,
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
  const onAutoplayStalledRef = useRef(onAutoplayStalled);
  onAutoplayStalledRef.current = onAutoplayStalled;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const cardRef = useRef(null);
  const startSecs = Math.max(0, Math.floor(Number(track?._videoStartAt) || 0));
  const shouldAutoPlay = track?._videoAutoPlay !== false;
  const ytOpts = {
    width: '100%',
    height: '100%',
    playerVars: {
      autoplay: shouldAutoPlay ? 1 : 0,
      ...(startSecs > 0 ? { start: startSecs } : {}),
      controls: 1,
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
    },
  };

  useEffect(() => {
    if (!track) {
      ytPlayerRef.current = null;
      return undefined;
    }
    const timer = setInterval(() => {
      const yt = ytPlayerRef.current;
      if (!yt || isSeekingGuardRef.current) return;
      try {
        const cur = yt.getCurrentTime?.() || 0;
        const dur = yt.getDuration?.() || 0;
        onTimeUpdate?.(cur, dur);
      } catch {}
    }, 250);
    return () => clearInterval(timer);
  }, [track?.id, ytPlayerRef, onTimeUpdate]);

  useEffect(() => {
    const yt = ytPlayerRef.current;
    if (!yt) return;
    try {
      yt.setVolume?.(Math.round(isMuted ? 0 : masterVolume));
      if (isMuted) yt.mute?.();
      else yt.unMute?.();
    } catch {}
  }, [masterVolume, isMuted, ytPlayerRef]);

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

  // Watchdog: if automatic YouTube video playback is stalled/blocked by browser policy, fall back to audio continuity
  useEffect(() => {
    hasStartedPlayingRef.current = false;
    if (!track || !shouldAutoPlay) return undefined;
    const stallTimer = setTimeout(() => {
      if (hasStartedPlayingRef.current) return;
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
    }, 2500);
    return () => clearTimeout(stallTimer);
  }, [track?.id, startSecs, shouldAutoPlay, ytPlayerRef, desiredPlayingRef]);

  // Recover YouTube video playback if tab visibility returns after browser suspension
  useEffect(() => {
    if (!track || typeof document === 'undefined') return undefined;
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
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

  if (!track) return null;

  const videoId = track.youtube_id || track.id;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;

  return (
    <div
      className={`video-popup-backdrop ${isMinimized ? 'is-minimized' : ''} ${
        isFullscreen && !isMinimized ? 'is-fullscreen' : ''
      }`}
      role={isMinimized ? undefined : 'dialog'}
      aria-modal={isMinimized ? undefined : 'true'}
      aria-labelledby={isMinimized ? undefined : 'videoPopupHeading'}
      aria-hidden={isMinimized ? 'true' : undefined}
      onClick={() => {
        if (!isMinimized && !isFullscreen) onMinimize?.();
      }}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        className={`modal-card video-popup-card ${isFullscreen && !isMinimized ? 'is-fullscreen' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {!isFullscreen && (
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
            key={videoId}
            videoId={videoId}
            opts={ytOpts}
            onReady={(e) => {
              ytPlayerRef.current = e.target;
              try {
                e.target.setVolume?.(Math.round(isMuted ? 0 : masterVolume));
                if (isMuted) e.target.mute?.();
                else e.target.unMute?.();
                if (startSecs > 0) e.target.seekTo?.(startSecs, true);
                if (shouldAutoPlay) e.target.playVideo?.();
                else e.target.pauseVideo?.();
              } catch {}
            }}
            onStateChange={(e) => {
              if (e.data === 1) {
                hasStartedPlayingRef.current = true;
                if (desiredPlayingRef) desiredPlayingRef.current = true;
                onPlayingChange?.(true);
              } else if (e.data === 2) {
                if (
                  typeof document !== 'undefined' &&
                  document.visibilityState === 'hidden' &&
                  desiredPlayingRef?.current &&
                  onBackgroundSuspend &&
                  !track._bgAudioFailed
                ) {
                  let resumeSecs = 0;
                  try {
                    resumeSecs = Math.max(0, Math.floor(e.target.getCurrentTime?.() || 0));
                  } catch {}
                  onBackgroundSuspend(track, resumeSecs);
                  return;
                }
                if (desiredPlayingRef) desiredPlayingRef.current = false;
                onPlayingChange?.(false);
              } else if (e.data === 0) {
                if (desiredPlayingRef) desiredPlayingRef.current = false;
                onPlayingChange?.(false);
                onEnded?.();
              }
            }}
            onError={(e) => {
              let resumeSecs = startSecs;
              try {
                resumeSecs = Math.max(0, Math.floor(e.target.getCurrentTime?.() || startSecs));
              } catch {}
              onError?.(track, e.data, resumeSecs);
            }}
            style={{ width: '100%', height: '100%' }}
          />
          {isFullscreen && !isMinimized && (
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
