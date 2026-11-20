import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Heart, Edit3, Trash2, Plus, ChevronUp, ChevronDown, Check } from 'lucide-react';
import { TRENDING_COUNTRIES } from '../utils/regionGeo';

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
  const [selectedCountry, setSelectedCountry] = useState(() =>
    trendingRegion && trendingRegion !== 'global' ? trendingRegion : 'id'
  );
  const [isCountryMenuOpen, setIsCountryMenuOpen] = useState(false);
  const [menuCoords, setMenuCoords] = useState(null);
  const countryBtnRef = useRef(null);
  const countryMenuRef = useRef(null);

  const selectedCountryName =
    TRENDING_COUNTRIES.find((c) => c.code === selectedCountry)?.name || 'Indonesia';

  useEffect(() => {
    if (trendingRegion && trendingRegion !== 'global') {
      setSelectedCountry(trendingRegion);
    }
  }, [trendingRegion]);

  useEffect(() => {
    if (isTrendingCollapsed) setIsCountryMenuOpen(false);
  }, [isTrendingCollapsed]);

  useEffect(() => {
    if (!isCountryMenuOpen) return;

    const updatePosition = () => {
      const rect = countryBtnRef.current?.getBoundingClientRect();
      if (!rect) return;
      const spaceBelow = window.innerHeight - rect.bottom - 16;
      const maxHeight = Math.min(280, Math.max(140, spaceBelow));
      setMenuCoords({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        maxHeight,
      });
    };

    updatePosition();

    const handleOutside = (e) => {
      if (
        countryBtnRef.current?.contains(e.target) ||
        countryMenuRef.current?.contains(e.target)
      ) {
        return;
      }
      setIsCountryMenuOpen(false);
    };

    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setIsCountryMenuOpen(false);
      }
    };

    window.addEventListener('resize', updatePosition);
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [isCountryMenuOpen]);

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
          <button
            type="button"
            className="bar-btn"
            id="toggleTrendingBtn"
            onClick={onToggleTrending}
            aria-expanded={!isTrendingCollapsed}
            aria-label={isTrendingCollapsed ? 'Expand Trending' : 'Collapse Trending'}
            title={isTrendingCollapsed ? 'Expand Trending' : 'Collapse Trending'}
          >
            {isTrendingCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>

        {!isTrendingCollapsed && (
          <div className="trending-filter-row">
            <button
              type="button"
              ref={countryBtnRef}
              id="trendingCountrySelect"
              className={`trending-select ${trendingRegion !== 'global' ? 'is-active' : ''}`}
              aria-haspopup="listbox"
              aria-expanded={isCountryMenuOpen}
              aria-label="Trending country"
              onClick={() => setIsCountryMenuOpen((o) => !o)}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedCountryName}
              </span>
              {isCountryMenuOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>

            <button
              type="button"
              id="trendingGlobalBtn"
              className={`btn ${trendingRegion === 'global' ? 'btn-accent' : ''}`}
              aria-pressed={trendingRegion === 'global'}
              onClick={() => {
                setIsCountryMenuOpen(false);
                onChangeTrendingRegion(trendingRegion === 'global' ? selectedCountry : 'global');
              }}
              title="Global Top 50"
              style={{ minHeight: 28, padding: '3px 10px', fontSize: '0.75rem' }}
            >
              Global
            </button>

            {isCountryMenuOpen &&
              menuCoords &&
              createPortal(
                <div
                  ref={countryMenuRef}
                  id="trendingCountryMenu"
                  className="trending-dropdown-menu"
                  role="listbox"
                  aria-label="Select trending country"
                  style={{
                    top: menuCoords.top,
                    left: menuCoords.left,
                    width: menuCoords.width,
                    maxHeight: menuCoords.maxHeight,
                  }}
                >
                  {TRENDING_COUNTRIES.map((c) => {
                    const isSelected = c.code === selectedCountry && trendingRegion !== 'global';
                    return (
                      <button
                        key={c.code}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`trending-dropdown-option ${isSelected ? 'is-selected' : ''}`}
                        onClick={() => {
                          setSelectedCountry(c.code);
                          setIsCountryMenuOpen(false);
                          onChangeTrendingRegion(c.code);
                        }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.name}
                        </span>
                        {isSelected && <Check size={13} />}
                      </button>
                    );
                  })}
                </div>,
                document.body
              )}
          </div>
        )}

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
