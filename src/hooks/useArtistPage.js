import { useState, useRef, useCallback } from 'react';
import { api } from '../services/api';

export function useArtistPage() {
  const [selectedArtist, setSelectedArtist] = useState(null);
  const [artistDetails, setArtistDetails] = useState(null);
  const [isLoadingArtist, setIsLoadingArtist] = useState(false);
  const [artistError, setArtistError] = useState(null);
  const [isLoadingMoreSongs, setIsLoadingMoreSongs] = useState(false);

  const artistCacheRef = useRef(new Map());
  const activeReqRef = useRef(0);
  const lastRequestRef = useRef(null);

  const openArtistPage = useCallback(async (artistName, browseIdOrContext = null) => {
    if (!artistName || !artistName.trim()) return;
    const cleanName = artistName.replace(/\s*-\s*Topic$/i, '').replace(/\bVEVO$/i, '').trim();
    const isObj = browseIdOrContext && typeof browseIdOrContext === 'object';
    const artistBrowseId = isObj ? browseIdOrContext.browseId || null : browseIdOrContext || null;
    const context = isObj
      ? {
          videoId: browseIdOrContext.videoId || null,
          trackTitle: browseIdOrContext.trackTitle || null,
          album: browseIdOrContext.album || null,
        }
      : {};

    let cacheKey;
    if (artistBrowseId) {
      cacheKey = `id:${String(artistBrowseId).trim()}`;
    } else if (context.videoId && /^[A-Za-z0-9_-]{11}$/.test(String(context.videoId).trim())) {
      cacheKey = `vid:${String(context.videoId).trim()}|name:${cleanName.toLowerCase()}`;
    } else if (context.trackTitle) {
      cacheKey = `ctx:${cleanName.toLowerCase()}|${String(context.trackTitle).trim().toLowerCase()}|${String(context.album || '').trim().toLowerCase()}`;
    } else {
      cacheKey = `name:${cleanName.toLowerCase()}`;
    }

    lastRequestRef.current = {
      name: cleanName,
      browseId: artistBrowseId,
      context,
      cacheKey,
    };

    const reqId = ++activeReqRef.current;

    setSelectedArtist(cleanName);
    setArtistError(null);

    if (artistCacheRef.current.has(cacheKey)) {
      setArtistDetails(artistCacheRef.current.get(cacheKey));
      setIsLoadingArtist(false);
      return;
    }

    setIsLoadingArtist(true);
    setArtistDetails(null);

    try {
      const details = await api.getArtistDetails(cleanName, artistBrowseId, context);
      if (reqId !== activeReqRef.current) return;
      artistCacheRef.current.set(cacheKey, details);
      if (details?.browse_id) {
        artistCacheRef.current.set(`id:${details.browse_id}`, details);
      }
      setArtistDetails(details);
    } catch (err) {
      if (reqId !== activeReqRef.current) return;
      setArtistError(err?.message || String(err));
    } finally {
      if (reqId === activeReqRef.current) setIsLoadingArtist(false);
    }
  }, []);

  const retryArtistPage = useCallback(() => {
    const last = lastRequestRef.current;
    if (!last?.name) return;
    openArtistPage(last.name, { browseId: last.browseId, ...last.context });
  }, [openArtistPage]);

  const closeArtistPage = useCallback(() => {
    activeReqRef.current++;
    setSelectedArtist(null);
    setArtistDetails(null);
    setArtistError(null);
  }, []);

  const loadMoreTopSongs = useCallback(async () => {
    if (!artistDetails?.top_songs_playlist_id || isLoadingMoreSongs) return;
    setIsLoadingMoreSongs(true);
    try {
      const moreSongs = await api.getArtistTopSongs(artistDetails.top_songs_playlist_id);
      if (moreSongs?.length) {
        setArtistDetails((prev) => {
          if (!prev) return prev;
          const updated = { ...prev, top_songs: moreSongs, has_loaded_all: true };
          if (lastRequestRef.current?.cacheKey) {
            artistCacheRef.current.set(lastRequestRef.current.cacheKey, updated);
          }
          if (prev.browse_id) {
            artistCacheRef.current.set(`id:${prev.browse_id}`, updated);
          }
          return updated;
        });
      }
    } catch (err) {
      console.error('Failed to load all artist top songs:', err);
    } finally {
      setIsLoadingMoreSongs(false);
    }
  }, [artistDetails, isLoadingMoreSongs]);

  return {
    selectedArtist,
    artistDetails,
    isLoadingArtist,
    artistError,
    isLoadingMoreSongs,
    openArtistPage,
    retryArtistPage,
    closeArtistPage,
    loadMoreTopSongs,
  };
}
