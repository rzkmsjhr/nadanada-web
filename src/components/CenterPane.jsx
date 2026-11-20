import React, { useRef, useEffect } from 'react';
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

  useEffect(() => {
    if (!deckSong || mode !== 'audio' || !audioRef.current) return;
    const audio = audioRef.current;
    if (deckSong._seekOnLoad > 0) {
      const handleLoadedMeta = () => {
        audio.currentTime = deckSong._seekOnLoad;
      };
      audio.addEventListener('loadedmetadata', handleLoadedMeta, { once: true });
    }
    if (isActiveDeck) {
      audio.volume = player.isMuted ? 0 : player.masterVolume / 100;
      audio.play().catch(() => {});
    }
  }, [deckSong?.id, deckSong?.stream_url, deckSong?._fallbackAudioUrl, mode, isActiveDeck]);

  if (!deckSong) return null;

  if (mode === 'audio') {
    const src = deckSong._fallbackAudioUrl || deckSong.stream_url;
    return (
      <audio
        ref={audioRef}
        src={src}
        preload="auto"
        onPlay={() => isActiveDeck && player.setIsPlaying(true)}
        onPause={() => isActiveDeck && player.setIsPlaying(false)}
        onWaiting={() => isActiveDeck && player.setIsBuffering(true)}
        onCanPlay={() => isActiveDeck && player.setIsBuffering(false)}
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
        opts={{
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: isActiveDeck ? 1 : 0,
            controls: isFullscreen || isActiveDeck ? 1 : 0,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            start: deckSong._seekOnLoad ? Math.floor(deckSong._seekOnLoad) : 0,
          },
        }}
        onReady={(e) => {
          ytRef.current = e.target;
          player.applyDeckVolume(deckIdx, isActiveDeck && !player.isMuted ? player.masterVolume : 0);
          if (isActiveDeck && player.isPlaying) {
            e.target.playVideo?.();
          }
        }}
        onStateChange={(e) => {
          if (!isActiveDeck) return;
          if (e.data === 1) {
            player.setIsPlaying(true);
            player.setIsBuffering(false);
          } else if (e.data === 2) {
            player.setIsPlaying(false);
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
  isLiked,
  onToggleLike,
  onPlayTrack,
  onOpenAlbum,
  onOpenArtist,
  onDownloadTrack,
  onAddToPlaylist,
  onQueueTrack,
  onDeleteTrack,
}) {
  const searchInputRef = useRef(null);

  useEffect(() => {
    if (showSearch) {
      setTimeout(() => searchInputRef.current?.focus(), 20);
    }
  }, [showSearch]);

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
          <div className="search-panel" id="searchPanel">
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
            {centerMode !== 'queue' && (
              <button type="button" className="btn" onClick={onBackToQueue}>
                Back to Queue
              </button>
            )}
            <div className="center-context-title">{contextTitle}</div>
          </div>

          <div className="center-actions">
            <button
              type="button"
              className={`btn ${showSearch ? 'btn-accent' : ''}`}
              id="toggleSearchBtn"
              aria-expanded={showSearch}
              aria-controls="searchPanel"
              onClick={onToggleSearch}
            >
              <Search size={13} />
              <span>Search</span>
            </button>

            <button
              type="button"
              className={`btn ${isEndlessPlay ? 'btn-accent' : ''}`}
              aria-pressed={isEndlessPlay}
              onClick={onToggleEndless}
            >
              Endless: {isEndlessPlay ? 'ON' : 'OFF'}
            </button>

            <button type="button" className="btn btn-accent" onClick={onSaveAsPlaylist}>
              Save as Playlist
            </button>

            <button type="button" className="btn btn-coral" onClick={onDeleteAll}>
              Delete All
            </button>
          </div>
        </div>

        {/* Body: Live Video/Audio Stage + Tracklist */}
        <div className={`center-body ${isVideoMode ? 'is-video-split' : ''}`}>
          {/* Dual-deck player container (kept mounted across audio-only, 50/50 split, and fullscreen) */}
          <div className={`media-stage-host ${isFullscreen ? 'is-fullscreen' : ''}`}>
            {isFullscreen && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  borderBottom: '1px solid #2f3946',
                  paddingBottom: 10,
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>
                    {currentSong?.title || 'Now Playing'}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#9ba7b4' }}>
                    {currentSong?.channel || currentSong?.artist || ''}
                  </div>
                </div>
                <button type="button" className="btn btn-coral" onClick={onToggleFullscreen}>
                  <Minimize2 size={14} />
                  <span>Exit Fullscreen (Esc)</span>
                </button>
              </div>
            )}

            <div className="yt-deck-wrapper" style={{ position: 'relative', borderRadius: 3 }}>
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
                  <button type="button" className="btn btn-accent" onClick={onToggleSearch}>
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

                return (
                  <div
                    key={`${track.uid || track.id}_${idx}`}
                    className={`track-row ${isPlayingRow ? 'is-playing' : ''}`}
                  >
                    <button
                      type="button"
                      className={`track-thumb ${isVideoItem ? 'is-video-thumb' : ''}`}
                      onClick={() => (isAlbumItem ? onOpenAlbum(track) : onPlayTrack(track, idx))}
                      aria-label={isAlbumItem ? `Open album ${track.title}` : `Play ${track.title}`}
                    >
                      {track.thumbnail ? (
                        <img src={track.thumbnail} alt="" loading="lazy" />
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center' }}>
                          <Disc size={16} color="var(--text-muted)" />
                        </div>
                      )}
                    </button>

                    <div className="track-info">
                      <button
                        type="button"
                        className="track-title-btn"
                        onClick={() => (isAlbumItem ? onOpenAlbum(track) : onPlayTrack(track, idx))}
                      >
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

                        {track.album && !isAlbumItem ? ` · ${track.album}` : ''}
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
