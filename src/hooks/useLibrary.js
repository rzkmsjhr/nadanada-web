import { useState, useEffect, useCallback, useMemo } from 'react';
import { reorderTracks } from '../utils/queueUtils';
import { promotePlaylistToTop } from '../utils/libraryOrder';

const LIKED_KEY = 'mysongs-liked-songs-v1';
const PLAYLISTS_KEY = 'mysongs-playlists-v1';

function readJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function useLibrary() {
  const [likedSongs, setLikedSongs] = useState(() => readJsonStorage(LIKED_KEY, []));
  const [playlists, setPlaylists] = useState(() => readJsonStorage(PLAYLISTS_KEY, []));

  useEffect(() => {
    try {
      localStorage.setItem(LIKED_KEY, JSON.stringify(likedSongs));
    } catch {}
  }, [likedSongs]);

  useEffect(() => {
    try {
      localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists));
    } catch {}
  }, [playlists]);

  const likedIdSet = useMemo(() => new Set(likedSongs.map((s) => String(s.id))), [likedSongs]);

  const isLiked = useCallback((songId) => Boolean(songId && likedIdSet.has(String(songId))), [likedIdSet]);

  const toggleLike = useCallback((song) => {
    if (!song?.id) return false;
    const targetId = String(song.id);
    let nowLiked = false;
    setLikedSongs((prev) => {
      if (prev.some((s) => String(s.id) === targetId)) {
        nowLiked = false;
        return prev.filter((s) => String(s.id) !== targetId);
      }
      nowLiked = true;
      return [{ ...song }, ...prev];
    });
    return nowLiked;
  }, []);

  const removeFromLiked = useCallback((songId) => {
    setLikedSongs((prev) => prev.filter((s) => String(s.id) !== String(songId)));
  }, []);

  const clearLikedSongs = useCallback(() => {
    setLikedSongs([]);
  }, []);

  const createPlaylist = useCallback((name, tracks = []) => {
    const cleanName = String(name || '').trim();
    if (!cleanName) return null;
    const pl = {
      id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: cleanName,
      tracks: Array.isArray(tracks) ? tracks.map((t) => ({ ...t })) : [],
      createdAt: Date.now(),
    };
    setPlaylists((prev) => [pl, ...prev]);
    return pl;
  }, []);

  const renamePlaylist = useCallback((playlistId, newName) => {
    const cleanName = String(newName || '').trim();
    if (!cleanName) return;
    setPlaylists((prev) =>
      prev.map((pl) => (pl.id === playlistId ? { ...pl, name: cleanName } : pl))
    );
  }, []);

  const deletePlaylist = useCallback((playlistId) => {
    setPlaylists((prev) => prev.filter((pl) => pl.id !== playlistId));
  }, []);

  const addTrackToPlaylist = useCallback((playlistId, track) => {
    if (!playlistId || !track?.id) return false;
    let added = false;
    setPlaylists((prev) =>
      prev.map((pl) => {
        if (pl.id !== playlistId) return pl;
        if (pl.tracks.some((t) => String(t.id) === String(track.id))) {
          return pl;
        }
        added = true;
        return { ...pl, tracks: [...pl.tracks, { ...track }] };
      })
    );
    return added;
  }, []);

  const removeTrackFromPlaylist = useCallback((playlistId, trackId) => {
    setPlaylists((prev) =>
      prev.map((pl) =>
        pl.id === playlistId
          ? { ...pl, tracks: pl.tracks.filter((t) => String(t.id) !== String(trackId)) }
          : pl
      )
    );
  }, []);

  const clearPlaylistTracks = useCallback((playlistId) => {
    setPlaylists((prev) =>
      prev.map((pl) => (pl.id === playlistId ? { ...pl, tracks: [] } : pl))
    );
  }, []);

  const reorderPlaylistTracks = useCallback((playlistId, fromIdx, toIdx) => {
    if (!playlistId || fromIdx === toIdx) return;
    setPlaylists((prev) =>
      prev.map((pl) =>
        pl.id === playlistId
          ? { ...pl, tracks: reorderTracks(pl.tracks, fromIdx, toIdx) }
          : pl
      )
    );
  }, []);

  const markPlaylistPlayed = useCallback((playlistId) => {
    if (!playlistId) return;
    setPlaylists((prev) => promotePlaylistToTop(prev, playlistId, Date.now()));
  }, []);

  return {
    likedSongs,
    playlists,
    isLiked,
    toggleLike,
    removeFromLiked,
    clearLikedSongs,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    clearPlaylistTracks,
    reorderPlaylistTracks,
    markPlaylistPlayed,
  };
}
