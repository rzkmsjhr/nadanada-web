import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import YouTube from 'react-youtube';
import {
  Search,
  Heart,
  Download,
  ListPlus,
  Trash2,
  Disc,
  Plus,
  Check,
  X,
  ArrowLeft,
  GripVertical,
} from 'lucide-react';
import { isTrackInQueue, isVideoTrack } from '../utils/queueUtils';

function computeDropEdge(clientY, rect, fromIdx, hoverIdx) {
  const relY = clientY - rect.top;
  if (fromIdx > hoverIdx) {
    return relY <= rect.height * 0.72 ? 'before' : 'after';
  }
  if (fromIdx < hoverIdx) {
    return relY < rect.height * 0.28 ? 'before' : 'after';
  }
  return relY < rect.height / 2 ? 'before' : 'after';
}

function computeReorderedIndex(fromIdx, hoverIdx, edge) {
  const rawInsertIdx = edge === 'after' ? hoverIdx + 1 : hoverIdx;
  return fromIdx < rawInsertIdx ? rawInsertIdx - 1 : rawInsertIdx;
}

function DeckMediaLayer({
  deckIdx,
  deckSong,
  opacity,
  isActiveDeck,
  mode,
  player,
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

  const audioSrc = mode === 'audio' ? (deckSong?._fallbackAudioUrl || deckSong?.stream_url || null) : null;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    if (!deckSong || mode !== 'audio' || !audioSrc) {
      // Removing src alone in HTML5 does not halt an already-playing <audio> element
      if (audio.getAttribute('src') || !audio.paused || audio.currentSrc) {
        try {
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
        } catch {}
      }
      return undefined;
    }
    const targetSeek = Number(deckSong._seekOnLoad) || 0;
    let cancelled = false;

    const applySeek = () => {
      if (cancelled || targetSeek <= 0) return;
      try {
        const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Infinity;
        const clamped = Math.min(targetSeek, Math.max(0, dur - 0.5));
        if (Math.abs((audio.currentTime || 0) - clamped) > 1.2) {
          audio.currentTime = clamped;
        }
      } catch {}
    };

    const startPlayback = () => {
      if (cancelled) return;
      if (isActiveDeck) {
        player.syncActiveDeckVolume(deckIdx);
        if (player.isPlayingRef?.current || player.isCrossfading || player.isRecoveringRef?.current) {
          const p = audio.play();
          if (p && typeof p.catch === 'function') {
            p.catch((err) => {
              if (err?.name !== 'AbortError' && isActiveDeck && !player.isRecoveringRef?.current) {
                player.setIsPlaying(false);
              }
            });
          }
        }
      } else {
        player.applyDeckVolume(deckIdx, 0);
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
        player.applyDeckVolume(deckIdx, 0);
        audio.load();
      }
    } else if (isActiveDeck) {
      startPlayback();
    } else {
      player.applyDeckVolume(deckIdx, 0);
      audio.load();
    }

    return () => {
      cancelled = true;
      audio.removeEventListener('loadedmetadata', handleLoadedMeta);
      audio.removeEventListener('canplay', handleCanPlaySeek);
    };
  }, [
    deckSong?.id,
    audioSrc,
    deckSong?._recoveryNonce,
    mode,
    isActiveDeck,
  ]);

  const videoId =
    deckSong && mode === 'youtube' && !isVideoTrack(deckSong)
      ? deckSong.youtube_id || deckSong.id
      : null;
  const hasValidVideo = Boolean(videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId));

  useEffect(() => {
    if (hasValidVideo) return undefined;
    if (ytRef.current) {
      try { ytRef.current.stopVideo?.(); } catch {}
      ytRef.current = null;
    }
    return undefined;
  }, [hasValidVideo]);

  return (
    <>
      <audio
        ref={audioRef}
        src={audioSrc || undefined}
        preload="auto"
        onPlay={() => {
          if (!deckSong || mode !== 'audio') return;
          if (isActiveDeck) {
            player.enforceSinglePlayback?.(deckIdx, 'audio');
            if (!player.isCrossfading) player.syncActiveDeckVolume(deckIdx);
            player.setIsPlaying(true);
            player.setIsBuffering(false);
          }
        }}
        onPause={() => {
          if (!deckSong || mode !== 'audio') return;
          // Do not flip playback state to Paused while mid-recovery, reloading, or at natural track end
          if (
            isActiveDeck &&
            !player.isRecoveringRef?.current &&
            !audioRef.current?.error &&
            !audioRef.current?.ended
          ) {
            player.setIsPlaying(false);
          }
        }}
        onTimeUpdate={() => {
          if (!deckSong || mode !== 'audio' || !isActiveDeck || !audioRef.current) return;
          player.syncAudioProgress?.(audioRef.current.currentTime, audioRef.current.duration);
        }}
        onWaiting={() => deckSong && mode === 'audio' && isActiveDeck && player.setIsBuffering(true)}
        onCanPlay={() => {
          if (!deckSong || mode !== 'audio') return;
          if (isActiveDeck) player.setIsBuffering(false);
          player.markDeckReady(deckIdx);
        }}
        onCanPlayThrough={() => deckSong && mode === 'audio' && player.markDeckReady(deckIdx)}
        onEnded={() => deckSong && mode === 'audio' && player.handleTrackEnd(deckIdx)}
        onError={() => deckSong && mode === 'audio' && player.handleAudioError(deckIdx)}
        style={{ display: 'none' }}
      />

      {hasValidVideo && (
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
                if (player.isCrossfading && !isActiveDeck) {
                  player.applyDeckVolume(deckIdx, 0);
                } else {
                  player.syncActiveDeckVolume(deckIdx);
                }
                const seekSec = pendingYtSeekRef.current || Math.floor(deckSong._seekOnLoad || 0);
                if (seekSec > 0) {
                  pendingYtSeekRef.current = seekSec;
                  e.target.seekTo?.(seekSec, true);
                }
                if (player.isPlayingRef?.current || player.isCrossfading || player.isRecoveringRef?.current) {
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
                player.enforceSinglePlayback?.(deckIdx, 'youtube');
                if (!player.isCrossfading) player.syncActiveDeckVolume(deckIdx);
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
      )}
    </>
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
  player,
  isLiked,
  onToggleLike,
  onPlayTrack,
  albumCache,
  onOpenAlbum,
  onOpenArtist,
  onDownloadTrack,
  onAddToPlaylist,
  onQueueTrack,
  queueMatcher,
  onDeleteTrack,
  onReorderTracks,
}) {
  const searchInputRef = useRef(null);
  const searchPanelRef = useRef(null);
  const toggleSearchBtnRef = useRef(null);
  const centerListRef = useRef(null);
  const dragIdxRef = useRef(null);
  const dropTargetRef = useRef(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const canReorder =
    (centerMode === 'queue' || centerMode === 'playlist') &&
    typeof onReorderTracks === 'function' &&
    tracks.length > 1;

  const clearDragState = useCallback(() => {
    dragIdxRef.current = null;
    dropTargetRef.current = null;
    setDragIdx(null);
    setDropTarget(null);
  }, []);

  const updateDropTargetFromPoint = useCallback((clientY, rowEl, hoverIdx) => {
    const activeFrom = dragIdxRef.current;
    if (activeFrom === null || !rowEl) return;
    const listEl = centerListRef.current;
    if (listEl) {
      const listRect = listEl.getBoundingClientRect();
      if (clientY < listRect.top + 36) listEl.scrollTop -= 12;
      else if (clientY > listRect.bottom - 36) listEl.scrollTop += 12;
    }
    const rect = rowEl.getBoundingClientRect();
    const edge = computeDropEdge(clientY, rect, activeFrom, hoverIdx);
    const nextFinalIdx = computeReorderedIndex(activeFrom, hoverIdx, edge);
    if (nextFinalIdx === activeFrom) {
      dropTargetRef.current = null;
      setDropTarget(null);
      return;
    }
    const next = { idx: hoverIdx, edge };
    dropTargetRef.current = next;
    setDropTarget((prev) =>
      prev && prev.idx === hoverIdx && prev.edge === edge ? prev : next
    );
  }, []);

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
                <ArrowLeft size={13} aria-hidden="true" />
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

        {/* Body: Hidden Audio-Fallback Stage + Tracklist (all videos play only in VideoPopupModal) */}
        <div className="center-body">
          <div id="mediaStageHost" className="media-stage-host" aria-hidden="true">
            <div className="yt-deck-wrapper">
              {[0, 1].map((deckIdx) => (
                <DeckMediaLayer
                  key={deckIdx}
                  deckIdx={deckIdx}
                  deckSong={player.deckSongs[deckIdx]}
                  opacity={player.deckOpacities[deckIdx]}
                  isActiveDeck={player.activeDeck === deckIdx}
                  mode={player.getDeckMode(player.deckSongs[deckIdx])}
                  player={player}
                />
              ))}
            </div>
          </div>

          {/* Tracklist / Search Results / Album Tracks */}
          <div className="center-list-wrap" id="centerList" ref={centerListRef}>
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
              (() => {
                const rowKeyCounts = new Map();
                return tracks.map((track, idx) => {
                const isAlbumItem = track.is_playlist || track.item_type === 'album';
                const isVideoItem = !isAlbumItem && isVideoTrack(track);
                const isPlayingRow = !isAlbumItem && currentSong?.id && String(currentSong.id) === String(track.id);
                const cleanChannel = (track.channel || track.artist || '').replace(/\s*-\s*Topic$/i, '');
                const cachedAlbumInfo = albumCache?.[track.id] || null;
                const albumTitle = track.album || cachedAlbumInfo?.album || '';
                const baseRowId = String(track.uid || track.id || 'row');
                const seenCount = rowKeyCounts.get(baseRowId) || 0;
                rowKeyCounts.set(baseRowId, seenCount + 1);
                const rowKey = seenCount === 0 ? baseRowId : `${baseRowId}__dup_${seenCount}`;

                const handleRowActivate = (e) => {
                  if (e?.target?.closest('.inline-link, .track-actions, .track-drag-handle')) return;
                  if (isAlbumItem) onOpenAlbum(track);
                  else onPlayTrack(track, idx);
                };

                const isDraggingThis = canReorder && dragIdx === idx;
                const dropClass =
                  canReorder && dropTarget?.idx === idx
                    ? dropTarget.edge === 'before'
                      ? 'is-drop-before'
                      : 'is-drop-after'
                    : '';

                return (
                  <div
                    key={rowKey}
                    data-reorder-idx={canReorder ? idx : undefined}
                    draggable={canReorder}
                    className={`track-row ${canReorder ? 'is-queue-draggable' : ''} ${isPlayingRow ? 'is-playing' : ''} ${
                      isDraggingThis ? 'is-dragging' : ''
                    } ${dropClass}`}
                    onClick={handleRowActivate}
                    onDragStart={(e) => {
                      if (!canReorder) return;
                      if (e.target.closest('button:not(.track-drag-handle), a, input')) {
                        e.preventDefault();
                        return;
                      }
                      dragIdxRef.current = idx;
                      setDragIdx(idx);
                      if (e.dataTransfer) {
                        e.dataTransfer.effectAllowed = 'move';
                        try {
                          e.dataTransfer.setData('text/plain', String(idx));
                        } catch {}
                      }
                    }}
                    onDragOver={(e) => {
                      if (!canReorder || dragIdxRef.current === null) return;
                      e.preventDefault();
                      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                      updateDropTargetFromPoint(e.clientY, e.currentTarget, idx);
                    }}
                    onDrop={(e) => {
                      if (!canReorder) return;
                      e.preventDefault();
                      const fromIdx = dragIdxRef.current;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const edge =
                        e.clientY > 0
                          ? computeDropEdge(e.clientY, rect, fromIdx, idx)
                          : dropTargetRef.current?.idx === idx
                          ? dropTargetRef.current.edge
                          : 'before';
                      const toIdx =
                        fromIdx !== null ? computeReorderedIndex(fromIdx, idx, edge) : null;
                      clearDragState();
                      if (fromIdx !== null && toIdx !== null && fromIdx !== toIdx) {
                        onReorderTracks(fromIdx, toIdx);
                      }
                    }}
                    onDragEnd={clearDragState}
                    style={{ cursor: 'pointer' }}
                  >
                    {canReorder && (
                      <button
                        type="button"
                        className="track-drag-handle"
                        aria-label={`Reorder ${track.title} (drag or use Up/Down arrows)`}
                        title="Drag to reorder (or focus and press Up/Down arrows)"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'ArrowUp' && idx > 0) {
                            e.preventDefault();
                            e.stopPropagation();
                            onReorderTracks(idx, idx - 1);
                          } else if (e.key === 'ArrowDown' && idx < tracks.length - 1) {
                            e.preventDefault();
                            e.stopPropagation();
                            onReorderTracks(idx, idx + 1);
                          }
                        }}
                        onTouchStart={(e) => {
                          if (!canReorder) return;
                          e.stopPropagation();
                          dragIdxRef.current = idx;
                          setDragIdx(idx);
                        }}
                        onTouchMove={(e) => {
                          if (!canReorder || dragIdxRef.current === null) return;
                          const touch = e.touches?.[0];
                          if (!touch) return;
                          const hit = document.elementFromPoint(touch.clientX, touch.clientY);
                          const targetRow = hit?.closest?.('[data-reorder-idx]');
                          if (!targetRow) return;
                          const hoverIdx = Number(targetRow.getAttribute('data-reorder-idx'));
                          if (Number.isInteger(hoverIdx)) {
                            updateDropTargetFromPoint(touch.clientY, targetRow, hoverIdx);
                          }
                        }}
                        onTouchEnd={() => {
                          const fromIdx = dragIdxRef.current;
                          const targetInfo = dropTargetRef.current;
                          const finalTarget =
                            fromIdx !== null && targetInfo
                              ? computeReorderedIndex(fromIdx, targetInfo.idx, targetInfo.edge)
                              : null;
                          clearDragState();
                          if (fromIdx !== null && finalTarget !== null && fromIdx !== finalTarget) {
                            onReorderTracks(fromIdx, finalTarget);
                          }
                        }}
                        onTouchCancel={clearDragState}
                      >
                        <GripVertical size={15} aria-hidden="true" />
                      </button>
                    )}

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

                          {centerMode !== 'queue' ? (() => {
                            const inQueue = isTrackInQueue(queueMatcher, track);
                            return (
                              <button
                                type="button"
                                className={`icon-btn ${inQueue ? 'is-in-queue' : ''}`}
                                title={inQueue ? 'Already in Up Next queue' : 'Add to Up Next queue'}
                                aria-label={inQueue ? `${track.title} is in queue` : `Queue ${track.title}`}
                                disabled={inQueue}
                                onClick={() => !inQueue && onQueueTrack(track)}
                              >
                                {inQueue ? <Check size={15} /> : <Plus size={15} />}
                              </button>
                            );
                          })() : null}

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
              });
              })()
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
