import React, { useState, useRef, useEffect } from 'react';
import {
  Shuffle,
  SkipBack,
  Play,
  Pause,
  SkipForward,
  Repeat,
  Repeat1,
  Volume2,
  VolumeX,
  Maximize2,
  Disc,
} from 'lucide-react';

function fmtTime(secs) {
  const n = Math.max(0, Math.floor(Number(secs) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

export default function MiniPlayerDock({
  currentSong,
  artistFact,
  isPlaying,
  isShuffle,
  repeatMode,
  currentTime,
  duration,
  masterVolume,
  isMuted,
  isPlayingHiFi,
  isHifiEnabled,
  isVideoDockActive,
  onToggleShuffle,
  onPrev,
  onTogglePlay,
  onNext,
  onCycleRepeat,
  onSeekStart,
  onSeekPreview,
  onSeekCommit,
  onVolumeChange,
  onToggleMute,
  onToggleTrackSource,
  onRestoreVideo,
  onOpenArtist,
}) {
  const cleanArtist = (currentSong?.channel || currentSong?.artist || '').replace(/\s*-\s*Topic$/i, '');
  const repeatTitle = repeatMode === 1 ? 'Repeat Track' : repeatMode === 2 ? 'Repeat Once' : 'Repeat Off';
  const effectiveVolume = isMuted ? 0 : masterVolume;
  const [showVolumePopover, setShowVolumePopover] = useState(false);
  const volumePopoverRef = useRef(null);

  useEffect(() => {
    if (!showVolumePopover) return undefined;
    const onPointerDown = (e) => {
      if (!volumePopoverRef.current?.contains(e.target)) {
        setShowVolumePopover(false);
      }
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setShowVolumePopover(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showVolumePopover]);

  return (
    <footer className="mini-dock" aria-label="Playback controls">
      <div className="dock-left">
        <div className="dock-thumb">
          {currentSong?.thumbnail ? (
            <img src={currentSong.thumbnail} alt="" />
          ) : (
            <Disc size={22} color="var(--dock-muted)" />
          )}
        </div>

        <div className="dock-meta">
          <div className="dock-title">{currentSong?.title || 'Select a track'}</div>
          <div className="dock-artist">
            {cleanArtist ? (
              <button type="button" className="inline-link" onClick={() => onOpenArtist(cleanArtist)}>
                {cleanArtist}
              </button>
            ) : (
              'Ready'
            )}
          </div>
          <div className="fact-ticker" title={artistFact || 'Artist Fact'}>
            <span className="fact-ticker-track">
              {artistFact || 'Artist fact updates automatically when a track plays.'}
            </span>
          </div>
        </div>
      </div>

      <div className="dock-center">
        <div className="transport-row">
          <button
            type="button"
            id="shuffleBtn"
            className={`dock-icon-btn ${isShuffle && !isVideoDockActive ? 'is-active' : ''}`}
            onClick={onToggleShuffle}
            disabled={isVideoDockActive}
            aria-label="Toggle shuffle"
            aria-pressed={isShuffle && !isVideoDockActive}
            title={isVideoDockActive ? 'Unavailable for minimized video' : 'Shuffle'}
          >
            <Shuffle size={15} />
          </button>

          <button
            type="button"
            className="dock-icon-btn"
            onClick={onPrev}
            disabled={isVideoDockActive}
            aria-label="Previous track"
            title={isVideoDockActive ? 'Unavailable for minimized video' : 'Previous'}
          >
            <SkipBack size={16} />
          </button>

          <button
            type="button"
            className="play-circle"
            onClick={onTogglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            title="Play / Pause"
          >
            {isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          </button>

          <button
            type="button"
            className="dock-icon-btn"
            onClick={onNext}
            disabled={isVideoDockActive}
            aria-label="Next track"
            title={isVideoDockActive ? 'Unavailable for minimized video' : 'Next'}
          >
            <SkipForward size={16} />
          </button>

          <button
            type="button"
            id="repeatBtn"
            className={`dock-icon-btn ${repeatMode > 0 && !isVideoDockActive ? 'is-active' : ''}`}
            onClick={onCycleRepeat}
            disabled={isVideoDockActive}
            aria-label={repeatTitle}
            title={isVideoDockActive ? 'Unavailable for minimized video' : repeatTitle}
          >
            {repeatMode === 2 ? <Repeat1 size={15} /> : <Repeat size={15} />}
          </button>
        </div>

        <div className="seek-row">
          <span>{fmtTime(currentTime)}</span>
          <input
            type="range"
            className="range-slider"
            min="0"
            max={Math.max(1, Math.floor(duration || 1))}
            value={Math.min(Math.floor(duration || 1), Math.floor(currentTime || 0))}
            aria-label="Seek track position"
            onMouseDown={onSeekStart}
            onTouchStart={onSeekStart}
            onChange={(e) => onSeekPreview(Number(e.target.value))}
            onMouseUp={(e) => onSeekCommit(Number(e.currentTarget.value))}
            onTouchEnd={(e) => onSeekCommit(Number(e.currentTarget.value))}
          />
          <span>{fmtTime(duration)}</span>
        </div>
      </div>

      <div className="dock-right">
        {isVideoDockActive ? (
          <button
            type="button"
            id="dockVideoOpenBtn"
            className="dock-open-video-btn"
            onClick={onRestoreVideo}
            aria-label="Open video popup"
            title="Reopen video popup (F for fullscreen)"
          >
            <Maximize2 size={13} />
            <span>Open</span>
          </button>
        ) : (
          <button
            type="button"
            className={`hifi-pill ${isPlayingHiFi ? 'is-flac' : ''}`}
            onClick={onToggleTrackSource}
            title={
              isPlayingHiFi
                ? 'Streaming lossless FLAC (click to switch this track to YouTube)'
                : isHifiEnabled
                ? 'Streaming YouTube (click to retry lossless FLAC)'
                : 'Hi-Fi disabled in Settings'
            }
          >
            <span>{isPlayingHiFi ? 'FLAC' : 'YT'}</span>
          </button>
        )}

        <div className="volume-group">
          <button
            type="button"
            className="dock-icon-btn"
            onClick={onToggleMute}
            aria-label={isMuted ? 'Unmute' : 'Mute'}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted || masterVolume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <input
            type="range"
            className="range-slider"
            min="0"
            max="100"
            value={effectiveVolume}
            aria-label="Volume"
            onChange={(e) => onVolumeChange(Number(e.target.value))}
          />
          <span className="volume-value" aria-live="off">
            {effectiveVolume}%
          </span>
        </div>

        <div className="volume-popover-wrap" ref={volumePopoverRef}>
          <button
            type="button"
            className={`dock-icon-btn volume-trigger-btn ${showVolumePopover ? 'is-active' : ''}`}
            onClick={() => setShowVolumePopover((open) => !open)}
            aria-label={`Volume ${effectiveVolume}%`}
            aria-expanded={showVolumePopover}
            aria-controls="dockVolumePopover"
            title={`Volume: ${effectiveVolume}%`}
          >
            {isMuted || masterVolume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          {showVolumePopover && (
            <div className="volume-popover" id="dockVolumePopover" role="dialog" aria-label="Volume control">
              <button
                type="button"
                className="dock-icon-btn volume-popover-mute"
                onClick={onToggleMute}
                aria-label={isMuted ? 'Unmute' : 'Mute'}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted || masterVolume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </button>
              <input
                type="range"
                className="range-slider"
                min="0"
                max="100"
                value={effectiveVolume}
                aria-label="Volume"
                onChange={(e) => onVolumeChange(Number(e.target.value))}
              />
              <span className="volume-value">{effectiveVolume}%</span>
            </div>
          )}
        </div>
      </div>
    </footer>
  );
}
