import React, { useState, useEffect, useRef } from 'react';
import { Heart, Plus, Check, ChevronLeft, Disc, ChevronUp, ChevronDown } from 'lucide-react';
import AlbumArtDisplay from './AlbumArtDisplay';
import VinylBox from './VinylBox';
import SpinningVinyl from './SpinningVinyl';
import { isTrackInQueue } from '../utils/queueUtils';
import { formatTrackDuration } from '../services/hifiResolver';
import { resolveDisplayAlbumTitle } from '../utils/albumMetadata';

export default function MetadataPane({
  isMobileActive,
  currentSong,
  nextSong,
  queueMatcher,
  isPlaying,
  isCrossfading,
  albumInfo,
  visualizerMode,
  onChangeVisualizerMode,
  onOpenArtwork,
  onTogglePlay,
  isLiked,
  onToggleLike,
  lyricsData,
  isFetchingLyrics,
  lyricsError,
  syncOffset,
  onSyncChange,
  onRetryLyrics,
  currentTime,
  onSeekTo,
  selectedArtist,
  artistDetails,
  isLoadingArtist,
  artistError,
  isLoadingMoreSongs,
  onOpenArtist,
  onCloseArtist,
  onRetryArtist,
  onLoadMoreTopSongs,
  onPlayArtistSong,
  onPlayAllArtistTop,
  onQueueAllArtistTop,
  onQueueArtistSong,
  onOpenAlbum,
}) {
  const [showFullBio, setShowFullBio] = useState(false);
  const [isLyricsExpanded, setIsLyricsExpanded] = useState(false);
  const lyricsScrollRef = useRef(null);

  useEffect(() => {
    setShowFullBio(false);
  }, [selectedArtist]);

  const effectiveTime = (currentTime || 0) + (syncOffset || 0);
  const formattedSync = `${syncOffset > 0 ? '+' : ''}${Number(syncOffset || 0).toFixed(2)}s`;
  const lines = lyricsData?.isSynced ? lyricsData.lines : [];
  let activeLyricIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (effectiveTime >= lines[i].time) activeLyricIdx = i;
    else break;
  }

  const activeLyricIdxRef = useRef(-1);
  activeLyricIdxRef.current = activeLyricIdx;

  const scrollActiveLyricIntoView = (behavior = 'smooth') => {
    const container = lyricsScrollRef.current;
    const idx = activeLyricIdxRef.current;
    if (idx < 0 || !container || container.clientHeight <= 0) return;
    const row = container.querySelector(`[data-lyric-idx="${idx}"]`);
    if (!row) return;
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (containerRect.height <= 0 || rowRect.height <= 0) return;
    const targetTop =
      container.scrollTop +
      (rowRect.top - containerRect.top) -
      container.clientHeight / 2 +
      rowRect.height / 2;
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    const clampedTop = Math.max(0, Math.min(maxScroll, targetTop));
    container.scrollTo({ top: clampedTop, behavior });
  };

  // Smoothly track active lyric advances while the panel is visible
  useEffect(() => {
    if (activeLyricIdx < 0) return undefined;
    const raf = requestAnimationFrame(() => scrollActiveLyricIntoView('smooth'));
    return () => cancelAnimationFrame(raf);
  }, [activeLyricIdx, lines.length, currentSong?.id]);

  // Snap active lyric to center immediately when panel visibility or expanded height changes
  useEffect(() => {
    if (activeLyricIdx < 0) return undefined;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      scrollActiveLyricIntoView('auto');
      raf2 = requestAnimationFrame(() => scrollActiveLyricIntoView('auto'));
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [isLyricsExpanded, isMobileActive, selectedArtist]);

  // Re-center active lyric if container height changes (e.g. mobile viewport resize or layout reflow)
  useEffect(() => {
    const container = lyricsScrollRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return undefined;
    let lastHeight = container.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = container.clientHeight;
      if (nextHeight > 0 && nextHeight !== lastHeight) {
        lastHeight = nextHeight;
        scrollActiveLyricIntoView('auto');
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [selectedArtist]);

  const artistLabel =
    albumInfo?.artist ||
    (currentSong?.channel || currentSong?.artist || '').replace(/\s*-\s*Topic$/i, '') ||
    'Unknown Artist';
  const albumLabel = resolveDisplayAlbumTitle(currentSong, albumInfo);

  if (selectedArtist) {
    const rawBio = artistDetails?.description || '';
    const cleanBio = rawBio.replace(/\s*From Wikipedia.*$/i, '').trim();
    const truncatedBio =
      !showFullBio && cleanBio.length > 220 ? `${cleanBio.slice(0, 220)}...` : cleanBio;

    return (
      <section
        className={`pane ${isMobileActive ? 'is-mobile-active' : ''}`}
        id="pane-metadata"
        aria-label="Artist profile"
      >
        <div className="flat-card" style={{ flex: 1, minHeight: 0 }}>
          <div className="card-bar">
            <h2 className="card-bar-title">Artist</h2>
            <button type="button" className="bar-btn" onClick={onCloseArtist}>
              <ChevronLeft size={13} />
              <span>Back</span>
            </button>
          </div>

          <div
            style={{
              padding: 12,
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              background: 'var(--surface-alt)',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: '50%',
                  overflow: 'hidden',
                  border: '2px solid var(--accent)',
                  background: 'var(--surface)',
                  flexShrink: 0,
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                {artistDetails?.avatar || artistDetails?.background_image ? (
                  <img
                    src={artistDetails.avatar || artistDetails.background_image}
                    alt={selectedArtist}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <Disc size={22} />
                )}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: '0.95rem',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {artistDetails?.name || selectedArtist}
                </div>
                <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                  {artistDetails?.monthly_audience || artistDetails?.subscribers || 'Artist'}
                </div>
              </div>
            </div>

            {artistDetails?.top_songs?.length > 0 && (
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-accent"
                  style={{ flex: 1 }}
                  onClick={() => onPlayAllArtistTop(artistDetails.top_songs)}
                >
                  Play Top
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1 }}
                  onClick={() => onQueueAllArtistTop(artistDetails.top_songs)}
                >
                  Queue All
                </button>
              </div>
            )}
          </div>

          <div className="card-scroll">
            {isLoadingArtist ? (
              <div className="state-box">Loading artist profile...</div>
            ) : artistError ? (
              <div className="state-box">
                <div>{artistError}</div>
                <button type="button" className="btn btn-accent" onClick={onRetryArtist}>
                  Retry
                </button>
              </div>
            ) : (
              <>
                {cleanBio && (
                  <div
                    style={{
                      padding: '10px 12px',
                      borderBottom: '1px solid var(--border)',
                      fontSize: '0.78rem',
                      color: 'var(--text-muted)',
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: '0.72rem',
                        textTransform: 'uppercase',
                        color: 'var(--text)',
                        marginBottom: 4,
                      }}
                    >
                      About
                    </div>
                    <div>{truncatedBio}</div>
                    {cleanBio.length > 220 && (
                      <button
                        type="button"
                        className="inline-link"
                        style={{ marginTop: 4, color: 'var(--accent-text)', fontWeight: 700 }}
                        onClick={() => setShowFullBio((v) => !v)}
                      >
                        {showFullBio ? 'Less' : 'More'}
                      </button>
                    )}
                  </div>
                )}

                <div
                  style={{
                    padding: '8px 12px',
                    fontWeight: 700,
                    fontSize: '0.72rem',
                    textTransform: 'uppercase',
                    color: 'var(--text-muted)',
                    background: 'var(--surface-alt)',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  Top Songs ({artistDetails?.top_songs?.length || 0})
                </div>

                {(artistDetails?.top_songs || []).map((s, idx) => {
                  const active = currentSong?.id === s.id;
                  const inQueue = isTrackInQueue(queueMatcher, {
                    ...s,
                    channel: s.artist || artistDetails?.name,
                  });
                  return (
                    <div
                      key={`${s.id}_${idx}`}
                      className={`flat-list-item ${active ? 'is-selected' : ''}`}
                      style={{ cursor: 'pointer' }}
                      onClick={() => onPlayArtistSong(artistDetails.top_songs, idx)}
                    >
                      <span className="trending-rank">{idx + 1}</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="item-label-trunc">{s.title}</div>
                        <div className="track-sub">
                          {s.album ? (
                            <button
                              type="button"
                              className="inline-link"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenAlbum({
                                  id: s.album_playlist_id || s.album_id,
                                  title: s.album,
                                  channel: s.artist || artistDetails?.name,
                                  first_video_id: s.id,
                                  source: 'youtube',
                                });
                              }}
                            >
                              {s.album}
                            </button>
                          ) : (
                            formatTrackDuration(s.duration)
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`icon-btn ${inQueue ? 'is-in-queue' : ''}`}
                        title={inQueue ? 'Already in Up Next queue' : 'Add to queue'}
                        aria-label={inQueue ? `${s.title} is in queue` : `Add ${s.title} to queue`}
                        disabled={inQueue}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!inQueue) onQueueArtistSong(s);
                        }}
                      >
                        {inQueue ? <Check size={14} /> : <Plus size={14} />}
                      </button>
                      {s.plays && (
                        <span className="artist-song-plays" title={s.plays}>
                          {s.plays}
                        </span>
                      )}
                    </div>
                  );
                })}

                {artistDetails?.top_songs_playlist_id && !artistDetails?.has_loaded_all && (
                  <div style={{ padding: 10 }}>
                    <button
                      type="button"
                      className="btn"
                      style={{ width: '100%' }}
                      disabled={isLoadingMoreSongs}
                      onClick={onLoadMoreTopSongs}
                    >
                      {isLoadingMoreSongs ? 'Loading...' : 'Show all songs'}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`pane ${isMobileActive ? 'is-mobile-active' : ''}`}
      id="pane-metadata"
      aria-label="Track metadata and lyrics"
    >
      <div className="meta-default">
        {/* Top Card: Cover / VinylBox / Turntable (hidden when Lyrics expanded to full height) */}
        {!isLyricsExpanded && (
          <div className="flat-card" style={{ flex: '0 0 auto' }}>
          <div className="card-bar">
            <h2 className="card-bar-title">Now Playing</h2>
            <div className="vis-switch" role="group" aria-label="Cover visualizer style">
              <button
                type="button"
                aria-pressed={visualizerMode === 'cover'}
                onClick={() => onChangeVisualizerMode('cover')}
              >
                Cover
              </button>
              <button
                type="button"
                aria-pressed={visualizerMode === 'vinyl-box'}
                onClick={() => onChangeVisualizerMode('vinyl-box')}
              >
                Box
              </button>
              <button
                type="button"
                aria-pressed={visualizerMode === 'turntable'}
                onClick={() => onChangeVisualizerMode('turntable')}
              >
                Deck
              </button>
            </div>
          </div>

          <div
            className="cover-stage"
            id="coverStage"
            role={currentSong ? 'button' : undefined}
            tabIndex={currentSong ? 0 : undefined}
            aria-label={currentSong ? 'View full album cover' : undefined}
            title={currentSong ? 'View full album cover' : undefined}
            onClick={() => currentSong && onOpenArtwork?.()}
            onKeyDown={(e) => {
              if (currentSong && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                onOpenArtwork?.();
              }
            }}
            style={{ cursor: currentSong ? 'pointer' : 'default' }}
          >
            {visualizerMode === 'turntable' ? (
              <SpinningVinyl
                song={currentSong}
                nextSong={nextSong}
                isPlaying={isPlaying}
                isCrossfading={isCrossfading}
              />
            ) : visualizerMode === 'vinyl-box' ? (
              <VinylBox
                song={currentSong}
                nextSong={nextSong}
                isPlaying={isPlaying}
                isCrossfading={isCrossfading}
              />
            ) : (
              <AlbumArtDisplay song={currentSong} />
            )}
          </div>

          <div style={{ padding: 10, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontWeight: 700,
                  fontSize: '0.88rem',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {currentSong ? currentSong.title : 'Nothing playing'}
              </div>
              <div
                style={{
                  fontSize: '0.74rem',
                  color: 'var(--text-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {currentSong ? (
                  <>
                    <button
                      type="button"
                      className="inline-link"
                      onClick={() =>
                        onOpenArtist(artistLabel, {
                          browseId: currentSong?.artist_browse_id || null,
                          videoId: currentSong?.id || null,
                          trackTitle: currentSong?.title || null,
                          album: albumLabel || currentSong?.album || null,
                        })
                      }
                    >
                      {artistLabel}
                    </button>
                    {albumLabel ? (
                      <>
                        <span> · </span>
                        <button
                          type="button"
                          className="inline-link"
                          onClick={() =>
                            onOpenAlbum({
                              id: albumInfo?.albumPlaylistId || null,
                              title: albumLabel,
                              channel: artistLabel,
                              first_video_id: currentSong.id,
                            })
                          }
                        >
                          {albumLabel}
                        </button>
                      </>
                    ) : null}
                  </>
                ) : (
                  'Pick a track from Trending or Search'
                )}
              </div>
            </div>
            <button
              type="button"
              className={`icon-btn ${currentSong && isLiked(currentSong.id) ? 'is-liked' : ''}`}
              disabled={!currentSong}
              onClick={() => currentSong && onToggleLike(currentSong)}
              title="Like current track"
              aria-label="Like current track"
            >
              <Heart
                size={16}
                fill={currentSong && isLiked(currentSong.id) ? 'currentColor' : 'none'}
              />
            </button>
          </div>
        </div>
        )}

        {/* Bottom Card: Lyrics */}
        <div className={`flat-card lyrics-card ${isLyricsExpanded ? 'is-expanded' : ''}`} style={{ flex: 1, minHeight: 0 }}>
          <div className="card-bar lyrics-card-bar">
            <h2 className="card-bar-title">Lyrics</h2>
            <div className="lyrics-bar-controls">
              <div className="sync-pill" role="group" aria-label="Lyrics sync offset">
                <span className="sync-pill-label">Sync:</span>
                <button
                  type="button"
                  className="sync-pill-btn"
                  disabled={!currentSong}
                  title="Delay lyrics by 0.25s"
                  aria-label="Delay lyrics by 0.25s"
                  onClick={() => onSyncChange((s) => Math.max(-30, Number((s - 0.25).toFixed(2))))}
                >
                  -
                </button>
                <button
                  type="button"
                  className={`sync-pill-val ${syncOffset !== 0 ? 'is-modified' : ''}`}
                  disabled={!currentSong || syncOffset === 0}
                  title={syncOffset !== 0 ? 'Click to reset sync offset to 0s' : 'Lyrics sync offset'}
                  aria-label={
                    syncOffset !== 0
                      ? `Sync offset ${formattedSync}, click to reset to 0.00s`
                      : 'Lyrics sync offset 0.00s'
                  }
                  onClick={() => onSyncChange(0)}
                >
                  {formattedSync}
                </button>
                <button
                  type="button"
                  className="sync-pill-btn"
                  disabled={!currentSong}
                  title="Advance lyrics by 0.25s"
                  aria-label="Advance lyrics by 0.25s"
                  onClick={() => onSyncChange((s) => Math.min(30, Number((s + 0.25).toFixed(2))))}
                >
                  +
                </button>
              </div>
              <button
                type="button"
                className="bar-btn"
                id="toggleLyricsFullBtn"
                aria-pressed={isLyricsExpanded}
                aria-label={isLyricsExpanded ? 'Collapse full-height lyrics' : 'Expand lyrics to full panel'}
                title={isLyricsExpanded ? 'Collapse lyrics' : 'Full panel lyrics'}
                onClick={() => setIsLyricsExpanded((v) => !v)}
              >
                {isLyricsExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </button>
            </div>
          </div>

          <div className="card-scroll lyrics-scroll" ref={lyricsScrollRef}>
            {!currentSong ? (
              <div className="state-box">Play a track to load synced lyrics.</div>
            ) : isFetchingLyrics ? (
              <div className="state-box">Fetching lyrics...</div>
            ) : lyricsData?.isInstrumental ? (
              <div className="state-box">Instrumental track</div>
            ) : lines.length > 0 ? (
              <div className="lyrics-list">
                {lines.map((line, i) => (
                  <button
                    key={`${line.time}_${i}`}
                    type="button"
                    data-lyric-idx={i}
                    className={`lyric-line ${i === activeLyricIdx ? 'is-active' : ''}`}
                    onClick={() => onSeekTo(Math.max(0, line.time - (syncOffset || 0)))}
                  >
                    {line.text}
                  </button>
                ))}
              </div>
            ) : (
              <div className="state-box">
                <div>{lyricsError || 'No synced lyrics found.'}</div>
                <button type="button" className="btn btn-accent" onClick={onRetryLyrics}>
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
