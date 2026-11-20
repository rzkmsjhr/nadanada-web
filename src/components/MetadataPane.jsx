import React, { useState, useEffect, useRef } from 'react';
import { Heart, Play, Pause, Plus, Download, ChevronLeft, Disc } from 'lucide-react';
import AlbumArtDisplay from './AlbumArtDisplay';
import VinylBox from './VinylBox';
import SpinningVinyl from './SpinningVinyl';

export default function MetadataPane({
  isMobileActive,
  currentSong,
  nextSong,
  isPlaying,
  isCrossfading,
  albumInfo,
  visualizerMode,
  onChangeVisualizerMode,
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
  onDownloadSong,
  onOpenAlbum,
}) {
  const [showFullBio, setShowFullBio] = useState(false);
  const lyricsScrollRef = useRef(null);

  useEffect(() => {
    setShowFullBio(false);
  }, [selectedArtist]);

  const effectiveTime = (currentTime || 0) + (syncOffset || 0);
  const lines = lyricsData?.isSynced ? lyricsData.lines : [];
  let activeLyricIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (effectiveTime >= lines[i].time) activeLyricIdx = i;
    else break;
  }

  useEffect(() => {
    if (activeLyricIdx < 0 || !lyricsScrollRef.current) return;
    const row = lyricsScrollRef.current.querySelector(`[data-lyric-idx="${activeLyricIdx}"]`);
    if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeLyricIdx]);

  const artistLabel =
    albumInfo?.artist ||
    (currentSong?.channel || currentSong?.artist || '').replace(/\s*-\s*Topic$/i, '') ||
    'Unknown Artist';
  const albumLabel = albumInfo?.album || currentSong?.album || '';

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
                            s.plays || s.duration || ''
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Add to queue"
                        onClick={(e) => {
                          e.stopPropagation();
                          onQueueArtistSong(s);
                        }}
                      >
                        <Plus size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Download"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDownloadSong({
                            id: s.id,
                            title: s.title,
                            channel: s.artist || artistDetails?.name,
                            thumbnail: s.thumbnail,
                          });
                        }}
                      >
                        <Download size={14} />
                      </button>
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
        {/* Top Card: Cover / VinylBox / Turntable */}
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
            onClick={() => currentSong && onTogglePlay()}
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
                      onClick={() => onOpenArtist(artistLabel)}
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

        {/* Bottom Card: Lyrics */}
        <div className="flat-card" style={{ flex: 1, minHeight: 0 }}>
          <div className="card-bar">
            <h2 className="card-bar-title">Lyrics</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                className="bar-btn"
                onClick={() => onSyncChange((s) => s - 0.5)}
              >
                -0.5s
              </button>
              <span style={{ fontSize: '0.7rem', fontVariantNumeric: 'tabular-nums' }}>
                {syncOffset > 0 ? `+${syncOffset.toFixed(1)}s` : `${syncOffset.toFixed(1)}s`}
              </span>
              <button
                type="button"
                className="bar-btn"
                onClick={() => onSyncChange((s) => s + 0.5)}
              >
                +0.5s
              </button>
            </div>
          </div>

          <div className="card-scroll" ref={lyricsScrollRef} style={{ padding: '6px 0' }}>
            {!currentSong ? (
              <div className="state-box">Play a track to load synced lyrics.</div>
            ) : isFetchingLyrics ? (
              <div className="state-box">Fetching lyrics...</div>
            ) : lyricsData?.isInstrumental ? (
              <div className="state-box">Instrumental track</div>
            ) : lines.length > 0 ? (
              lines.map((line, i) => (
                <button
                  key={`${line.time}_${i}`}
                  type="button"
                  data-lyric-idx={i}
                  className={`lyric-line ${i === activeLyricIdx ? 'is-active' : ''}`}
                  onClick={() => onSeekTo(Math.max(0, line.time - (syncOffset || 0)))}
                >
                  {line.text}
                </button>
              ))
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
