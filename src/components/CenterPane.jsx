import React, { useRef, useEffect, useMemo } from 'react';
import YouTube from 'react-youtube';
import {
  Search,
  Heart,
  Download,
  ListPlus,
  Trash2,
  Maximize2,
  Minimize2,
  Disc,
  Plus,
  X,
} from 'lucide-react';
import VinylBox from './VinylBox';
import SpinningVinyl from './SpinningVinyl';
import AlbumArtDisplay from './AlbumArtDisplay';

function DeckMediaLayer({
  deckIdx,
  deckSong,
  opacity,
  isActiveDeck,
  mode,
  player,
  isFullscreen,
}) {
  const audioRef = player.audioRefs[deckIdx];
  const ytRef = player.ytRefs[deckIdx];
  const warmedVideoIdRef = useRef(null);

  const ytOpts = useMemo(
    () => ({
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 0,
        controls: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
      },
    }),
    []
  );

  const pendingYtSeekRef = useRef(0);

  useEffect(() => {
    warmedVideoIdRef.current = null;
    pendingYtSeekRef.current = deckSong?._seekOnLoad > 0 ? Math.floor(deckSong._seekOnLoad) : 0;
  }, [deckSong?.id, deckSong?._recoveryNonce, deckSong?._seekOnLoad]);

  useEffect(() => {
    if (!deckSong || mode !== 'audio' || !audioRef.current) return undefined;
    const audio = audioRef.current;
    const targetSeek = Number(deckSong._seekOnLoad) || 0;
    let cancelled = false;
    let seekDone = targetSeek <= 0;

    const applySeek = () => {
      if (cancelled || targetSeek <= 0) return;
      try {
        const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Infinity;
        const clamped = Math.min(targetSeek, Math.max(0, dur - 0.5));
        if (Math.abs((audio.currentTime || 0) - clamped) > 1.2) {
          audio.currentTime = clamped;
        }
        seekDone = true;
      } catch {}
    };

    const startPlayback = () => {
      if (cancelled) return;
      if (isActiveDeck) {
        audio.muted = player.isMuted;
        audio.volume = player.isMuted ? 0 : player.masterVolume / 100;
        audio.play().catch(() => {});
      } else {
        audio.volume = 0;
      }
    };

    const handleLoadedMeta = () => {
      applySeek();
      startPlayback();
    };

    const handleCanPlaySeek = () => {
      if (targetSeek > 0 && Math.abs((audio.currentTime || 0) - targetSeek) > 1.5) {
        applySeek();
      }
      if (isActiveDeck) {
        player.clearRecovering?.(deckIdx);
      }
    };

    if (targetSeek > 0) {
      audio.addEventListener('loadedmetadata', handleLoadedMeta, { once: true });
      audio.addEventListener('canplay', handleCanPlaySeek, { once: true });
      if (audio.readyState >= 1) {
        handleLoadedMeta();
      } else if (!isActiveDeck) {
        audio.volume = 0;
        audio.load();
      }
    } else if (isActiveDeck) {
      startPlayback();
    } else {
      audio.volume = 0;
      audio.load();
    }

    return () => {
      cancelled = true;
      audio.removeEventListener('loadedmetadata', handleLoadedMeta);
      audio.removeEventListener('canplay', handleCanPlaySeek);
    };
  }, [
    deckSong?.id,
    deckSong?.stream_url,
    deckSong?._fallbackAudioUrl,
    deckSong?._recoveryNonce,
    mode,
    isActiveDeck,
  ]);

  if (!deckSong) return null;

  if (mode === 'audio') {
    const src = deckSong._fallbackAudioUrl || deckSong.stream_url;
    return (
      <audio
        ref={audioRef}
        src={src}
        preload="auto"
        onPlay={() => {
          if (isActiveDeck) {
            player.setIsPlaying(true);
            player.setIsBuffering(false);
          }
        }}
        onPause={() => {
          // Do not flip playback state to Paused while mid-recovery/reloading a dropped stream
          if (isActiveDeck && !player.isRecoveringRef?.current && !audioRef.current?.error) {
            player.setIsPlaying(false);
          }
        }}
        onWaiting={() => isActiveDeck && player.setIsBuffering(true)}
        onCanPlay={() => {
          if (isActiveDeck) player.setIsBuffering(false);
          player.markDeckReady(deckIdx);
        }}
        onCanPlayThrough={() => player.markDeckReady(deckIdx)}
        onEnded={() => player.handleTrackEnd(deckIdx)}
        onError={() => player.handleAudioError(deckIdx)}
        style={{ display: 'none' }}
      />
    );
  }

  const videoId = deckSong.youtube_id || deckSong.id;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;

  return (
    <div
      className="yt-deck-layer"
      style={{
        opacity,
        pointerEvents: isActiveDeck ? 'auto' : 'none',
        zIndex: isActiveDeck ? 2 : 1,
      }}
    >
      <YouTube
        videoId={videoId}
        opts={ytOpts}
        onReady={(e) => {
          ytRef.current = e.target;
          if (isActiveDeck || player.isCrossfading) {
            e.target.unMute?.();
            player.applyDeckVolume(
              deckIdx,
              player.isMuted ? 0 : player.isCrossfading && !isActiveDeck ? 0 : player.masterVolume
            );
            const seekSec = pendingYtSeekRef.current || Math.floor(deckSong._seekOnLoad || 0);
            if (seekSec > 0) {
              pendingYtSeekRef.current = seekSec;
              e.target.seekTo?.(seekSec, true);
            }
            if (player.isPlaying || player.isCrossfading || player.isRecoveringRef?.current) {
              e.target.playVideo?.();
            }
            player.markDeckReady(deckIdx);
          } else {
            warmedVideoIdRef.current = null;
            e.target.mute?.();
            e.target.setVolume?.(0);
            e.target.playVideo?.();
          }
        }}
        onStateChange={(e) => {
          if (!isActiveDeck) {
            if (e.data === 1) {
              if (player.isCrossfading) {
                if (!player.isMuted) e.target.unMute?.();
                player.markDeckReady(deckIdx);
              } else if (warmedVideoIdRef.current !== videoId) {
                warmedVideoIdRef.current = videoId;
                e.target.pauseVideo?.();
                e.target.seekTo?.(0, true);
                if (!player.isMuted) e.target.unMute?.();
                e.target.setVolume?.(0);
                player.markDeckReady(deckIdx);
              }
            }
            return;
          }
          if (e.data === 1) {
            if (pendingYtSeekRef.current > 0) {
              const targetSec = pendingYtSeekRef.current;
              const curSec = e.target.getCurrentTime?.() || 0;
              pendingYtSeekRef.current = 0;
              if (Math.abs(curSec - targetSec) > 2) {
                e.target.seekTo?.(targetSec, true);
              }
            }
            player.clearRecovering?.(deckIdx);
            player.setIsPlaying(true);
            player.setIsBuffering(false);
          } else if (e.data === 2) {
            if (!player.isRecoveringRef?.current) {
              player.setIsPlaying(false);
            }
          } else if (e.data === 3) {
            player.setIsBuffering(true);
          } else if (e.data === 0) {
            player.handleTrackEnd(deckIdx);
          }
        }}
        onError={(e) => player.handleYouTubeError(deckIdx, e.data)}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}

export default function CenterPane({
  isMobileActive,
  showSearch,
  onToggleSearch,
  onCloseSearch,
  searchQuery,
  onSearchQueryChange,
  searchTab,
  onSearchTabChange,
  onSubmitSearch,
  isSearching,
  searchError,
  centerMode,
  contextTitle,
  onBackToQueue,
  tracks,
  isAlbumLoading,
  isEndlessPlay,
  onToggleEndless,
  onSaveAsPlaylist,
  onDeleteAll,
  currentSong,
  nextSong,
  player,
  visualizerMode,
  isVideoMode,
  isFullscreen,
  onToggleFullscreen,
  mediaStageRef,
  isLiked,
  onToggleLike,
  onPlayTrack,
  albumCache,
  onOpenAlbum,
  onOpenArtist,
  onDownloadTrack,
  onAddToPlaylist,
  onQueueTrack,
  onDeleteTrack,
}) {
  const searchInputRef = useRef(null);
  const searchPanelRef = useRef(null);
  const toggleSearchBtnRef = useRef(null);

  useEffect(() => {
    if (!showSearch) return;
    const focusTimer = setTimeout(() => searchInputRef.current?.focus(), 20);

    const handleDocumentClick = (e) => {
      if (
        searchPanelRef.current?.contains(e.target) ||
        toggleSearchBtnRef.current?.contains(e.target)
      ) {
        return;
      }
      onCloseSearch?.();
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onCloseSearch?.();
    };

    // Attach after the opening click finishes bubbling past React root
    const attachTimer = setTimeout(() => {
      document.addEventListener('click', handleDocumentClick);
    }, 0);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(focusTimer);
      clearTimeout(attachTimer);
      document.removeEventListener('click', handleDocumentClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showSearch, onCloseSearch]);

  const activeMode = player.activeMode;

  return (
    <section
      className={`pane ${isMobileActive ? 'is-mobile-active' : ''}`}
      id="pane-center"
      aria-label="Main stage and tracklist"
    >
      <div className="flat-card" style={{ flex: 1, minHeight: 0 }}>
        {/* Collapsible Search Drawer */}
        {showSearch && (
          <div className="search-panel" id="searchPanel" ref={searchPanelRef}>
            <form className="search-row" onSubmit={onSubmitSearch}>
              <input
                ref={searchInputRef}
                type="search"
                className="input"
                id="searchInput"
                value={searchQuery}
                onChange={(e) => onSearchQueryChange(e.target.value)}
                placeholder="Search songs, videos, or albums..."
                aria-label="Search music"
              />
              <button type="submit" className="btn btn-accent">
                {isSearching ? 'Searching...' : 'Search'}
              </button>
              <button
                type="button"
                className="btn"
                id="closeSearchBtn"
                onClick={onCloseSearch}
                aria-label="Close search"
                title="Close search"
                style={{ padding: '6px 8px' }}
              >
                <X size={15} />
              </button>
            </form>

            <div className="tab-row" role="tablist" aria-label="Search type">
              {[
                ['song', 'Songs'],
                ['video', 'Videos'],
                ['album', 'Albums'],
              ].map(([tabKey, label]) => (
                <button
                  key={tabKey}
                  type="button"
                  className="tab-btn"
                  role="tab"
                  aria-selected={searchTab === tabKey}
                  onClick={() => onSearchTabChange(tabKey)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Toolbar */}
        <div className="center-toolbar">
          <div className="center-context-row" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
            {centerMode !== 'queue' && (
              <button type="button" className="btn toolbar-back-btn" onClick={onBackToQueue}>
                <span className="hide-mobile">Back to Queue</span>
                <span className="show-mobile">Back</span>
              </button>
            )}
            <div className="center-context-title">{contextTitle}</div>
          </div>

          <div className="center-actions">
            <button
              ref={toggleSearchBtnRef}
              type="button"
              className={`btn ${showSearch ? 'btn-accent' : ''}`}
              id="toggleSearchBtn"
              aria-expanded={showSearch}
              aria-controls="searchPanel"
              onClick={onToggleSearch}
            >
              <Search size={13} />
              <span className="hide-mobile">Search</span>
            </button>

            <button
              type="button"
              id="endlessToggleBtn"
              role="switch"
              aria-checked={isEndlessPlay}
              className={`btn btn-toggle has-tooltip ${isEndlessPlay ? 'btn-accent' : ''}`}
              data-tooltip={
                isEndlessPlay
                  ? 'Endless Play ON: Automatically queues related songs near the end of your queue.'
                  : 'Endless Play OFF: Click to automatically queue related songs near the end of your queue.'
              }
              title="Endless Play: Automatically queues related songs near the end of your queue."
              onClick={onToggleEndless}
            >
              <span className="hide-mobile">Endless Play</span>
              <span className="show-mobile">Endless</span>
              <span className="inline-switch" aria-hidden="true">
                <span className="inline-switch-thumb" />
              </span>
            </button>

            <button type="button" className="btn btn-accent" onClick={onSaveAsPlaylist}>
              <span className="hide-mobile">Save as Playlist</span>
              <span className="show-mobile">Save</span>
            </button>

            <button type="button" className="btn btn-coral" onClick={onDeleteAll}>
              <span className="hide-mobile">Delete All</span>
              <span className="show-mobile">Clear</span>
            </button>
          </div>
        </div>

        {/* Body: Live Video/Audio Stage + Tracklist */}
        <div className={`center-body ${isVideoMode ? 'is-video-split' : ''}`}>
          {/* Dual-deck player container (kept mounted across audio-only, split, and fullscreen) */}
          <div
            ref={mediaStageRef}
            id="mediaStageHost"
            className={`media-stage-host ${isFullscreen ? 'is-fullscreen' : ''}`}
          >
            <div className="yt-deck-wrapper" style={{ position: 'relative', zIndex: 1, borderRadius: isFullscreen ? 0 : 3 }}>
              {[0, 1].map((deckIdx) => (
                <DeckMediaLayer
                  key={deckIdx}
                  deckIdx={deckIdx}
                  deckSong={player.deckSongs[deckIdx]}
                  opacity={player.deckOpacities[deckIdx]}
                  isActiveDeck={player.activeDeck === deckIdx}
                  mode={player.getDeckMode(player.deckSongs[deckIdx])}
                  player={player}
                  isFullscreen={isFullscreen}
                />
              ))}

              {/* Show visual artwork stage in Fullscreen if active track is Audio / HiFi */}
              {isFullscreen && activeMode === 'audio' && currentSong && (
                <div style={{ position: 'absolute', inset: 0, zIndex: 5 }}>
                  {visualizerMode === 'turntable' ? (
                    <SpinningVinyl
                      song={currentSong}
                      nextSong={nextSong}
                      isPlaying={player.isPlaying}
                      isCrossfading={player.isCrossfading}
                    />
                  ) : visualizerMode === 'vinyl-box' ? (
                    <VinylBox
                      song={currentSong}
                      nextSong={nextSong}
                      isPlaying={player.isPlaying}
                      isCrossfading={player.isCrossfading}
                    />
                  ) : (
                    <AlbumArtDisplay song={currentSong} />
                  )}
                </div>
              )}
            </div>

            {isFullscreen && (
              <button
                type="button"
                className="fs-exit-btn"
                id="exitFullscreenBtn"
                onClick={onToggleFullscreen}
              >
                <Minimize2 size={14} />
                <span>Exit Fullscreen (Esc)</span>
              </button>
            )}

            {isVideoMode && !isFullscreen && (
              <div className="video-flat-bar">
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  Video: {currentSong?.title || ''}
                </span>
                <button type="button" className="bar-btn" onClick={onToggleFullscreen}>
                  <Maximize2 size={12} />
                  <span>Fullscreen</span>
                </button>
              </div>
            )}
          </div>

          {/* Tracklist / Search Results / Album Tracks */}
          <div className="center-list-wrap" id="centerList">
            {(centerMode === 'search' && isSearching) || (centerMode === 'album' && isAlbumLoading) ? (
              <div className="state-box">Loading tracks...</div>
            ) : centerMode === 'search' && searchError ? (
              <div className="state-box">{searchError}</div>
            ) : tracks.length === 0 ? (
              <div className="state-box">
                <div>
                  {centerMode === 'search'
                    ? 'Type a song, video, or album query and click Search.'
                    : centerMode === 'liked'
                    ? 'No liked songs yet. Click any heart button to save tracks here.'
                    : centerMode === 'playlist'
                    ? 'This playlist is empty.'
                    : 'Queue is empty. Search or click any Trending song on the left.'}
                </div>
                {!showSearch && (
                  <button
                    type="button"
                    id="openSearchEmptyBtn"
                    className="btn btn-accent"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleSearch?.();
                    }}
                  >
                    Open Search
                  </button>
                )}
              </div>
            ) : (
              tracks.map((track, idx) => {
                const isAlbumItem = track.is_playlist || track.item_type === 'album';
                const isVideoItem = track.item_type === 'video';
                const isPlayingRow = !isAlbumItem && currentSong?.id && String(currentSong.id) === String(track.id);
                const cleanChannel = (track.channel || track.artist || '').replace(/\s*-\s*Topic$/i, '');
                const cachedAlbumInfo = albumCache?.[track.id] || null;
                const albumTitle = track.album || cachedAlbumInfo?.album || '';

                const handleRowActivate = (e) => {
                  if (e?.target?.closest('.inline-link, .track-actions')) return;
                  if (isAlbumItem) onOpenAlbum(track);
                  else onPlayTrack(track, idx);
                };

                return (
                  <div
                    key={`${track.uid || track.id}_${idx}`}
                    className={`track-row ${isPlayingRow ? 'is-playing' : ''}`}
                    onClick={handleRowActivate}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className={`track-thumb ${isVideoItem ? 'is-video-thumb' : ''}`}>
                      {track.thumbnail ? (
                        <img src={track.thumbnail} alt="" loading="lazy" />
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center' }}>
                          <Disc size={16} color="var(--text-muted)" />
                        </div>
                      )}
                    </div>

                    <div className="track-info">
                      <button type="button" className="track-title-btn">
                        {track.title}
                      </button>

                      <div className="track-sub">
                        <span className="type-tag">
                          {isAlbumItem
                            ? 'ALBUM'
                            : isVideoItem
                            ? 'VIDEO'
                            : track.source === 'kuwo' || track.source === 'wyy' || track.source === 'monochrome' || track.stream_url
                            ? 'FLAC'
                            : 'SONG'}
                        </span>

                        {cleanChannel ? (
                          <button
                            type="button"
                            className="inline-link"
                            onClick={() => onOpenArtist(cleanChannel)}
                          >
                            {cleanChannel}
                          </button>
                        ) : (
                          'Unknown Artist'
                        )}

                        {albumTitle && !isAlbumItem && (
                          <>
                            <span> · </span>
                            <button
                              type="button"
                              className="inline-link album-link"
                              title={`Browse "${albumTitle}" album`}
                              onClick={() =>
                                onOpenAlbum({
                                  id: cachedAlbumInfo?.albumPlaylistId || track.albumPlaylistId || null,
                                  title: albumTitle,
                                  channel: cleanChannel,
                                  first_video_id: track.id,
                                })
                              }
                            >
                              {albumTitle}
                            </button>
                          </>
                        )}
                        {track.track_count ? ` · ${track.track_count} tracks` : ''}
                        {track.duration ? ` · ${track.duration}` : ''}
                      </div>
                    </div>

                    <div className="track-actions">
                      {!isAlbumItem && (
                        <>
                          <button
                            type="button"
                            className={`icon-btn ${isLiked(track.id) ? 'is-liked' : ''}`}
                            title="Like"
                            aria-label={`Like ${track.title}`}
                            onClick={() => onToggleLike(track)}
                          >
                            <Heart size={15} fill={isLiked(track.id) ? 'currentColor' : 'none'} />
                          </button>

                          <button
                            type="button"
                            className="icon-btn"
                            title="Download"
                            aria-label={`Download ${track.title}`}
                            onClick={() => onDownloadTrack(track)}
                          >
                            <Download size={15} />
                          </button>

                          <button
                            type="button"
                            className="icon-btn"
                            title="Add to playlist"
                            aria-label={`Add ${track.title} to playlist`}
                            onClick={() => onAddToPlaylist(track)}
                          >
                            <ListPlus size={15} />
                          </button>

                          {centerMode !== 'queue' ? (
                            <button
                              type="button"
                              className="icon-btn"
                              title="Add to Up Next queue"
                              aria-label={`Queue ${track.title}`}
                              onClick={() => onQueueTrack(track)}
                            >
                              <Plus size={15} />
                            </button>
                          ) : null}

                          <button
                            type="button"
                            className="icon-btn is-danger"
                            title="Remove"
                            aria-label={`Remove ${track.title}`}
                            onClick={() => onDeleteTrack(track, idx)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </>
                      )}

                      {isAlbumItem && (
                        <button
                          type="button"
                          className="btn btn-accent"
                          style={{ minHeight: 28, padding: '4px 10px' }}
                          onClick={() => onOpenAlbum(track)}
                        >
                          Open
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
