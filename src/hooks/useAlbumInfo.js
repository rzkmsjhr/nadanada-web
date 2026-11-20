import { useState, useEffect, useRef } from 'react';
import { api } from '../services/api';

export function useAlbumInfo(playlist, currentIndex) {
  const [albumCache, setAlbumCache] = useState(() => {
    try {
      const raw = localStorage.getItem('mysongs-album-cache-v1');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const queueRef = useRef([]);
  const isFetchingRef = useRef(false);
  const inFlightRef = useRef(new Set());

  useEffect(() => {
    try {
      localStorage.setItem('mysongs-album-cache-v1', JSON.stringify(albumCache));
    } catch {}
  }, [albumCache]);

  useEffect(() => {
    if (!playlist || playlist.length === 0) return;

    const order = [];
    if (currentIndex >= 0 && currentIndex < playlist.length) {
      order.push(playlist[currentIndex]);
      for (let i = currentIndex + 1; i < playlist.length; i++) order.push(playlist[i]);
      for (let i = 0; i < currentIndex; i++) order.push(playlist[i]);
    } else {
      order.push(...playlist);
    }

    const missing = order
      .map((s) => s?.id)
      .filter((id) => id && /^[a-zA-Z0-9_-]{11}$/.test(id) && !albumCache[id]);
    queueRef.current = [...new Set(missing)];

    const processQueue = async () => {
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;
      while (queueRef.current.length > 0) {
        const videoId = queueRef.current.shift();
        if (!videoId || inFlightRef.current.has(videoId)) continue;
        inFlightRef.current.add(videoId);
        try {
          const info = await api.getVideoAlbumInfo(videoId);
          setAlbumCache((prev) => ({
            ...prev,
            [videoId]: {
              album: (info?.album || '').trim(),
              artist: (info?.artist || '').replace(/\s*-\s*Topic$/i, '').trim(),
              albumPlaylistId: info?.album_playlist_id || '',
            },
          }));
        } catch {
          await new Promise((r) => setTimeout(r, 3000));
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      isFetchingRef.current = false;
    };

    processQueue();
  }, [playlist, currentIndex]);

  const currentSong =
    playlist && currentIndex >= 0 && currentIndex < playlist.length ? playlist[currentIndex] : null;
  const albumInfo = currentSong?.id ? albumCache[currentSong.id] : null;
  return { albumInfo, albumCache };
}
