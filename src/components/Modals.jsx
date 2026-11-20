import React, { useState, useEffect, useMemo } from 'react';
import { Disc } from 'lucide-react';
import { getOptimizedThumbnail } from './SpinningVinyl';

const CROSSFADE_STEPS = [0, 2, 3, 4, 5, 6];

export function SettingsModal({
  isOpen,
  onClose,
  isHifiEnabled,
  onToggleHifi,
  crossfadeDuration,
  onChangeCrossfade,
}) {
  if (!isOpen) return null;
  const sliderIndex = crossfadeDuration === 0 ? 0 : Math.max(1, CROSSFADE_STEPS.indexOf(crossfadeDuration));

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="settingsHeading" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-bar">
          <h2 className="card-bar-title" id="settingsHeading">Settings</h2>
          <button type="button" className="bar-btn" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body">
          <div className="setting-row">
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.86rem' }}>Hi-Fi Audio (Lossless FLAC)</div>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                Prefer lossless audio streams for eligible tracks
              </div>
            </div>
            <button
              type="button"
              className="switch-btn"
              role="switch"
              aria-checked={isHifiEnabled}
              aria-label="Toggle Hi-Fi Lossless FLAC"
              onClick={onToggleHifi}
            >
              <span className="switch-thumb" />
            </button>
          </div>

          <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700, fontSize: '0.86rem' }}>Crossfade</span>
              <span style={{ fontWeight: 700, color: 'var(--accent-text)' }}>
                {crossfadeDuration === 0 ? 'Off' : `${crossfadeDuration}s`}
              </span>
            </div>
            <input
              type="range"
              className="range-slider"
              min="0"
              max="5"
              step="1"
              value={sliderIndex}
              aria-label="Crossfade duration"
              onChange={(e) => {
                const idx = Number(e.target.value);
                onChangeCrossfade(CROSSFADE_STEPS[idx] ?? 0);
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              <span>Off</span><span>2s</span><span>3s</span><span>4s</span><span>5s</span><span>6s</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function NamePromptModal({ isOpen, title, label, initialValue = '', confirmLabel = 'Save', onConfirm, onClose }) {
  const [val, setVal] = useState(initialValue);

  useEffect(() => {
    if (isOpen) setVal(initialValue);
  }, [isOpen, initialValue]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-bar">
          <h2 className="card-bar-title">{title}</h2>
          <button type="button" className="bar-btn" onClick={onClose}>Cancel</button>
        </div>
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (!val.trim()) return;
            onConfirm(val.trim());
          }}
        >
          <label style={{ fontSize: '0.8rem', fontWeight: 700 }}>{label}</label>
          <input
            type="text"
            className="input"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            autoFocus
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-accent">{confirmLabel}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ConfirmModal({ isOpen, title, message, confirmLabel = 'Confirm', onConfirm, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-bar">
          <h2 className="card-bar-title">{title}</h2>
          <button type="button" className="bar-btn" onClick={onClose}>Cancel</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: '0.86rem' }}>{message}</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-coral" onClick={onConfirm}>{confirmLabel}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AddToPlaylistModal({ isOpen, track, playlists, onAddToExisting, onCreateAndAdd, onClose }) {
  const [newName, setNewName] = useState('');
  if (!isOpen || !track) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-bar">
          <h2 className="card-bar-title">Add to Playlist</h2>
          <button type="button" className="bar-btn" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{track.title}</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
            {playlists.length === 0 ? (
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>No playlists yet. Create one below.</div>
            ) : (
              playlists.map((pl) => (
                <button
                  key={pl.id}
                  type="button"
                  className="btn"
                  style={{ justifyContent: 'space-between', width: '100%' }}
                  onClick={() => onAddToExisting(pl.id)}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{pl.name}</span>
                  <span className="count-pill">{pl.tracks.length}</span>
                </button>
              ))
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!newName.trim()) return;
              onCreateAndAdd(newName.trim());
              setNewName('');
            }}
            style={{ display: 'flex', gap: 6 }}
          >
            <input
              type="text"
              className="input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New playlist name..."
            />
            <button type="submit" className="btn btn-accent">Create & Add</button>
          </form>
        </div>
      </div>
    </div>
  );
}

export function ImportPlaylistModal({
  isOpen,
  url,
  onUrlChange,
  isImporting,
  progress,
  error,
  onImport,
  onClose,
}) {
  if (!isOpen) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="importPlaylistHeading"
      onClick={() => !isImporting && onClose()}
    >
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-bar">
          <h2 className="card-bar-title" id="importPlaylistHeading">Import Playlist</h2>
          <button type="button" className="bar-btn" onClick={onClose} disabled={isImporting}>
            Close
          </button>
        </div>
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            onImport();
          }}
        >
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Paste a public YouTube or Spotify playlist URL.
          </div>
          <input
            type="url"
            className="input"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="https://open.spotify.com/playlist/... or YouTube playlist URL"
            aria-label="Playlist URL"
            disabled={isImporting}
            autoFocus
          />
          {error && (
            <div style={{ fontSize: '0.78rem', color: 'var(--coral)', fontWeight: 600 }}>
              {error}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '0.76rem', color: 'var(--accent-text)', fontWeight: 600 }}>
              {isImporting ? progress || 'Importing...' : ''}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" onClick={onClose} disabled={isImporting}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-accent"
                disabled={!url.trim() || isImporting}
              >
                {isImporting ? 'Importing...' : 'Import'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ArtworkModal({ isOpen, song, albumInfo, onClose }) {
  const [srcIdx, setSrcIdx] = useState(0);

  const sources = useMemo(() => {
    const raw = song?.thumbnail;
    if (!raw) return [];
    const opt = getOptimizedThumbnail(raw) || raw;
    const list = [];
    if (raw.includes('i.ytimg.com')) {
      const maxres = raw.replace(/(?:hq|mq|sd|default)\.jpg/i, 'maxresdefault.jpg');
      if (maxres !== raw) list.push(maxres);
      list.push(raw);
      const hq = raw.replace(/(?:maxresdefault|mqdefault|sddefault|default)\.jpg/i, 'hqdefault.jpg');
      if (!list.includes(hq)) list.push(hq);
    } else {
      if (opt) list.push(opt);
      if (raw !== opt) list.push(raw);
    }
    return list;
  }, [song?.thumbnail]);

  useEffect(() => {
    setSrcIdx(0);
  }, [song?.id, song?.thumbnail]);

  if (!isOpen || !song) return null;

  const activeSrc = sources[srcIdx] || null;
  const artist =
    albumInfo?.artist ||
    (song.channel || song.artist || '').replace(/\s*-\s*Topic$/i, '').trim() ||
    'Unknown Artist';
  const album = albumInfo?.album || song.album || '';

  return (
    <div
      className="modal-backdrop"
      id="artworkModal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="artworkModalHeading"
      onClick={onClose}
    >
      <div
        className="modal-card"
        style={{ width: 'auto', maxWidth: 'min(560px, 92vw)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-bar">
          <h2 className="card-bar-title" id="artworkModalHeading">Album Cover</h2>
          <button type="button" className="bar-btn" id="closeArtworkBtn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modal-body" style={{ gap: 10 }}>
          {activeSrc ? (
            <img
              src={activeSrc}
              alt={song.title || 'Album Cover'}
              onError={() => {
                if (srcIdx + 1 < sources.length) setSrcIdx((i) => i + 1);
              }}
              style={{
                width: 'min(526px, 68vh, calc(92vw - 34px))',
                aspectRatio: '1 / 1',
                objectFit: 'cover',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                display: 'block',
              }}
            />
          ) : (
            <div
              style={{
                width: 'min(526px, 68vh, calc(92vw - 34px))',
                aspectRatio: '1 / 1',
                background: 'var(--surface-alt)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Disc size={64} color="var(--accent-text)" />
            </div>
          )}
          <div style={{ width: 0, minWidth: '100%' }}>
            <div
              style={{
                fontWeight: 700,
                fontSize: '0.96rem',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {song.title}
            </div>
            <div
              style={{
                fontSize: '0.8rem',
                color: 'var(--text-muted)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {artist}
              {album ? ` · ${album}` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
