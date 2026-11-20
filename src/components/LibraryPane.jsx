import React, { useState } from 'react';
import { Heart, Edit3, Trash2, Plus } from 'lucide-react';

export default function LibraryPane({
  isMobileActive,
  likedSongsCount,
  playlists,
  selectedPlaylistId,
  centerMode,
  onOpenLiked,
  onOpenPlaylist,
  onCreatePlaylist,
  onOpenImportModal,
  onRenamePlaylist,
  onDeletePlaylist,
  trendingRegion,
  onChangeTrendingRegion,
  trendingTracks,
  isTrendingLoading,
  trendingError,
  onRetryTrending,
  isTrendingCollapsed,
  onToggleTrending,
  currentSongTitle,
  resolvingTrendingRank,
  onPlayTrendingTrack,
  onQueueTrendingTrack,
}) {
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');

  const handleSubmitNew = (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    onCreatePlaylist(newName.trim());
    setNewName('');
    setShowNewForm(false);
  };

  return (
    <section
      className={`pane ${isMobileActive ? 'is-mobile-active' : ''}`}
      id="pane-library"
      aria-label="Library and trending"
    >
      {/* Top: Library CRUD */}
      <div className={`flat-card library-card-wrap ${isTrendingCollapsed ? '' : 'is-compressed'}`}>
        <div className="card-bar">
          <h2 className="card-bar-title">Library</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              className="bar-btn"
              id="importPlaylistBtn"
              onClick={onOpenImportModal}
              title="Import YouTube or Spotify playlist"
            >
              Import
            </button>
            <button
              type="button"
              className="bar-btn"
              id="newPlaylistBtn"
              onClick={() => setShowNewForm((v) => !v)}
            >
              + New
            </button>
          </div>
        </div>

        {showNewForm && (
          <form
            onSubmit={handleSubmitNew}
            style={{ padding: 8, borderBottom: '1px solid var(--border)', display: 'flex', gap: 4 }}
          >
            <input
              type="text"
              className="input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Playlist name..."
              aria-label="New playlist name"
              autoFocus
              style={{ height: 30, fontSize: '0.78rem' }}
            />
            <button type="submit" className="btn btn-accent" style={{ minHeight: 30, padding: '4px 8px' }}>
              Add
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => { setShowNewForm(false); setNewName(''); }}
              style={{ minHeight: 30, padding: '4px 8px' }}
            >
              X
            </button>
          </form>
        )}

        <div className="card-scroll">
          <div
            className={`flat-list-item ${centerMode === 'liked' ? 'is-selected' : ''}`}
            onClick={onOpenLiked}
            style={{ cursor: 'pointer' }}
          >
            <button
              type="button"
              className="flat-list-main"
              onClick={(e) => {
                e.stopPropagation();
                onOpenLiked();
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <Heart size={14} fill="var(--coral)" stroke="var(--coral)" style={{ flexShrink: 0 }} />
                <span className="item-label-trunc">Liked Songs</span>
              </span>
              <span className="count-pill is-coral">{likedSongsCount}</span>
            </button>
          </div>

          {playlists.length === 0 ? (
            <div style={{ padding: '12px 10px', color: 'var(--text-muted)', fontSize: '0.76rem' }}>
              No playlists yet. Click + New or Save as Playlist.
            </div>
          ) : (
            playlists.map((pl) => {
              const selected = centerMode === 'playlist' && selectedPlaylistId === pl.id;
              return (
                <div
                  key={pl.id}
                  className={`flat-list-item ${selected ? 'is-selected' : ''}`}
                  onClick={() => onOpenPlaylist(pl.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <button
                    type="button"
                    className="flat-list-main"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenPlaylist(pl.id);
                    }}
                  >
                    <span className="item-label-trunc">{pl.name}</span>
                    <span className="count-pill">{pl.tracks.length}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Rename playlist"
                    aria-label={`Rename ${pl.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRenamePlaylist(pl);
                    }}
                  >
                    <Edit3 size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn is-danger"
                    title="Delete playlist"
                    aria-label={`Delete ${pl.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeletePlaylist(pl);
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Bottom: Trending Chart (Slides Library up to top) */}
      <div className={`flat-card trending-card-wrap ${isTrendingCollapsed ? 'is-collapsed' : ''}`}>
        <div className="card-bar">
          <h2 className="card-bar-title">Trending</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              className={`bar-btn ${trendingRegion === 'id' ? 'is-active' : ''}`}
              onClick={() => onChangeTrendingRegion('id')}
              title="Indonesia Top 50"
            >
              ID
            </button>
            <button
              type="button"
              className={`bar-btn ${trendingRegion === 'global' ? 'is-active' : ''}`}
              onClick={() => onChangeTrendingRegion('global')}
              title="Global Top 50"
            >
              GLB
            </button>
            <button
              type="button"
              className="bar-btn"
              onClick={onToggleTrending}
              aria-expanded={!isTrendingCollapsed}
              title={isTrendingCollapsed ? 'Expand Trending' : 'Collapse Trending'}
            >
              {isTrendingCollapsed ? '+' : '-'}
            </button>
          </div>
        </div>

        {!isTrendingCollapsed && (
          <div className="card-scroll">
            {isTrendingLoading ? (
              <div className="state-box" style={{ fontSize: '0.78rem' }}>Loading charts...</div>
            ) : trendingError ? (
              <div className="state-box" style={{ fontSize: '0.78rem' }}>
                <div>{trendingError}</div>
                <button type="button" className="btn btn-accent" onClick={onRetryTrending}>
                  Retry
                </button>
              </div>
            ) : trendingTracks.length === 0 ? (
              <div className="state-box" style={{ fontSize: '0.78rem' }}>No trending tracks loaded.</div>
            ) : (
              trendingTracks.map((t) => {
                const isResolving = resolvingTrendingRank === t.rank;
                const isActive =
                  currentSongTitle &&
                  t.title &&
                  currentSongTitle.toLowerCase().includes(t.title.toLowerCase());
                return (
                  <div
                    key={`${trendingRegion}_${t.rank}_${t.title}`}
                    className={`trending-row ${isActive ? 'is-playing' : ''}`}
                    onClick={() => !isResolving && onPlayTrendingTrack(t)}
                  >
                    <span className="trending-rank">{t.rank}</span>
                    <button
                      type="button"
                      className="trending-play-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlayTrendingTrack(t);
                      }}
                      disabled={isResolving}
                    >
                      <span className="item-label-trunc">
                        {isResolving ? `Loading: ${t.title}` : t.title}
                      </span>
                      <span
                        style={{
                          fontSize: '0.7rem',
                          color: 'var(--text-muted)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {t.artist}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Add to queue"
                      aria-label={`Add ${t.title} to queue`}
                      disabled={isResolving}
                      onClick={(e) => {
                        e.stopPropagation();
                        onQueueTrendingTrack(t);
                      }}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </section>
  );
}
