import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { parseDurationToSecs } from '../services/hifiResolver';

export function parseLrc(lrcText) {
  if (!lrcText) return [];
  const lines = lrcText.split('\n');
  const result = [];
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:[.:](\d{2,3}))?\]/g;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const matches = [...trimmed.matchAll(timeRegex)];
    if (matches.length === 0) continue;
    const text = trimmed.replace(timeRegex, '').trim();
    if (!text) continue;
    for (const match of matches) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      result.push({ time: min * 60 + sec + ms / 1000, text });
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

export function useLyrics(currentSong) {
  const [lyricsData, setLyricsData] = useState(null);
  const [isFetchingLyrics, setIsFetchingLyrics] = useState(false);
  const [lyricsError, setLyricsError] = useState(null);
  const [syncOffset, setSyncOffset] = useState(0);

  const activeSongIdRef = useRef(currentSong?.id);
  activeSongIdRef.current = currentSong?.id;

  const fetchLyrics = useCallback(async (songToFetch) => {
    const target = songToFetch || currentSong;
    if (!target?.id) return;

    setIsFetchingLyrics(true);
    setLyricsError(null);
    try {
      const durationSec = parseDurationToSecs(target.duration);
      const res = await api.getLyrics(
        target.title || '',
        target.channel || target.artist || '',
        durationSec || null,
        /^[a-zA-Z0-9_-]{11}$/.test(String(target.id)) ? target.id : null
      );
      if (activeSongIdRef.current !== target.id) return;

      if (res?.success) {
        if (res.instrumental) {
          setLyricsData({
            isInstrumental: true,
            isSynced: false,
            lines: [],
            source: res.source,
            _songId: target.id,
          });
        } else if (res.synced_lyrics) {
          const parsedLines = parseLrc(res.synced_lyrics);
          if (parsedLines.length > 0) {
            setLyricsData({
              isInstrumental: false,
              isSynced: true,
              lines: parsedLines,
              source: res.source,
              _songId: target.id,
            });
          } else {
            setLyricsError('No synced lyrics available for this song.');
            setLyricsData({ _songId: target.id });
          }
        } else {
          setLyricsError('No synced lyrics available for this song.');
          setLyricsData({ _songId: target.id });
        }
      } else {
        setLyricsError(res?.error || 'No synced lyrics found.');
        setLyricsData({ _songId: target.id });
      }
    } catch (e) {
      if (activeSongIdRef.current !== target.id) return;
      setLyricsError(e?.message || 'Failed to fetch lyrics.');
      setLyricsData({ _songId: target.id });
    } finally {
      if (activeSongIdRef.current === target.id) setIsFetchingLyrics(false);
    }
  }, [currentSong]);

  useEffect(() => {
    if (!currentSong?.id) {
      setSyncOffset(0);
      setLyricsData(null);
      setLyricsError(null);
      return;
    }
    const saved = localStorage.getItem(`mysongs-lyrics-sync-${currentSong.id}`);
    setSyncOffset(saved ? parseFloat(saved) || 0 : 0);
    setLyricsData(null);
    setLyricsError(null);
    fetchLyrics(currentSong);
  }, [currentSong?.id]);

  const handleSyncChange = useCallback((updaterOrValue) => {
    const songId = activeSongIdRef.current;
    if (!songId) return;
    setSyncOffset((prev) => {
      const nextRaw = typeof updaterOrValue === 'function' ? updaterOrValue(prev) : updaterOrValue;
      const next = Math.max(-30, Math.min(30, Number(nextRaw.toFixed(2))));
      if (next !== 0) localStorage.setItem(`mysongs-lyrics-sync-${songId}`, String(next));
      else localStorage.removeItem(`mysongs-lyrics-sync-${songId}`);
      return next;
    });
  }, []);

  const handleRetry = useCallback(() => {
    if (currentSong) fetchLyrics(currentSong);
  }, [currentSong, fetchLyrics]);

  return {
    lyricsData,
    isFetchingLyrics,
    lyricsError,
    syncOffset,
    setSyncOffset: handleSyncChange,
    handleRetry,
  };
}
