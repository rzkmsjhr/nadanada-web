import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HIFI_MATCHER_VERSION,
  getCachedAlbumForSong,
  isHifiCoolingDown,
  isHifiEligibleTrack,
  resolveHifiForTrack,
} from '../services/hifiResolver';

function isNativeMonochromeItem(s) {
  return Boolean(
    s &&
      s.source === 'monochrome' &&
      s.stream_url &&
      (!s.hifi_id || String(s.hifi_id) === String(s.id))
  );
}

function needsHifiCheck(s, inFlightSet, albumCache) {
  if (!s || !s.id || s.is_playlist || s.item_type === 'album') return false;
  if (inFlightSet.has(String(s.id))) return false;
  if (s._userForcedYoutube || s._hifiFailed) return false;
  if (!isHifiEligibleTrack(s)) return false;
  if (isNativeMonochromeItem(s)) return false;

  if (s._hifiChecked && s._hifiVersion === HIFI_MATCHER_VERSION) {
    if (s._resolvedWithAlbum === false) {
      const alb = getCachedAlbumForSong(s, albumCache);
      if (alb) return true;
    }
    return false;
  }
  return true;
}

function applyHifiToTrack(track, hifi) {
  if (hifi?._hifiTransient) {
    return track;
  }

  if (hifi && hifi.stream_url) {
    const source =
      hifi.source ||
      (hifi.hifi_id && String(hifi.hifi_id).startsWith('wyy_')
        ? 'wyy'
        : hifi.hifi_id && String(hifi.hifi_id).startsWith('kuwo_')
        ? 'kuwo'
        : 'monochrome');
    return {
      ...track,
      stream_url: hifi.stream_url,
      source,
      hifi_id: hifi.hifi_id,
      album: track.album || hifi.album || null,
      _hifiFailed: false,
      _hifiChecked: true,
      _hifiVersion: HIFI_MATCHER_VERSION,
      _resolvedWithAlbum: Boolean(hifi._resolvedWithAlbum),
    };
  }

  if (track.stream_url) {
    // Preserve prior valid stream when an album-upgrade check finds no better match
    return {
      ...track,
      _hifiFailed: false,
      _hifiChecked: true,
      _hifiVersion: HIFI_MATCHER_VERSION,
      _resolvedWithAlbum: true,
    };
  }

  return {
    ...track,
    stream_url: null,
    source: null,
    hifi_id: null,
    _hifiFailed: false,
    _hifiChecked: true,
    _hifiVersion: HIFI_MATCHER_VERSION,
    _resolvedWithAlbum: false,
  };
}

function shouldApplyResult(existing, hifi) {
  if (!existing || hifi?._hifiTransient) return false;
  if (existing._hifiVersion !== HIFI_MATCHER_VERSION || !existing._hifiChecked) return true;
  if (existing._resolvedWithAlbum === false && hifi?._resolvedWithAlbum) return true;
  if (existing._resolvedWithAlbum === false && existing.stream_url && !hifi) return true;
  return false;
}

/**
 * Tiered background Hi-Fi FLAC resolver for the active Web queue:
 * - Tier 1 (currentIndex + upcomingIndex): mode 'play' (warms progressive download + verifies fLaC bytes).
 * - Tier 2 (currentIndex + 2, +3): mode 'probe' (lightweight Range header byte check, 300ms spacing).
 * - Tier 3 (rest of active queue): mode 'probe' (650ms spacing, pauses when tab hidden or cooling down).
 */
export function useHifiResolver({
  queue,
  setQueue,
  currentIndex,
  upcomingIndex,
  isHifiEnabled,
  albumCache,
}) {
  const inFlightRef = useRef(new Set());
  const isHifiEnabledRef = useRef(isHifiEnabled);
  isHifiEnabledRef.current = isHifiEnabled;

  const queueRef = useRef(queue);
  queueRef.current = queue;

  const albumCacheRef = useRef(albumCache);
  albumCacheRef.current = albumCache;

  const [visibilityTick, setVisibilityTick] = useState(0);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        setVisibilityTick((n) => n + 1);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const patchTrack = useCallback(
    (song, hifi) => {
      if (!isHifiEnabledRef.current || !song) return;
      setQueue((prev) => {
        let changed = false;
        const updated = prev.map((item) => {
          const matches =
            (item.uid && song.uid && item.uid === song.uid) ||
            (item.id && song.id && String(item.id) === String(song.id));
          if (matches && shouldApplyResult(item, hifi)) {
            changed = true;
            return applyHifiToTrack(item, hifi);
          }
          return item;
        });
        return changed ? updated : prev;
      });
    },
    [setQueue]
  );

  const activeNext =
    upcomingIndex !== undefined && upcomingIndex !== null && upcomingIndex >= 0
      ? upcomingIndex
      : currentIndex + 1;
  const curTrack = Array.isArray(queue) && currentIndex >= 0 ? queue[currentIndex] : null;
  const nextTrack = Array.isArray(queue) && activeNext >= 0 ? queue[activeNext] : null;
  const lookaheadTrack = Array.isArray(queue) && activeNext >= 0 ? queue[activeNext + 1] : null;

  // Tier 1 (current + upcoming track in play mode) + immediate lookahead probe:
  // runs immediately even in background tabs and never discards completed patches on unrelated renders.
  useEffect(() => {
    const list = queueRef.current;
    if (!isHifiEnabled || !Array.isArray(list) || list.length === 0) {
      return undefined;
    }

    const runTier1 = async () => {
      const currentList = queueRef.current || [];
      const tier1Indices = [...new Set([currentIndex, activeNext])].filter((idx) => {
        if (idx < 0 || idx >= currentList.length) return false;
        const s = currentList[idx];
        if (idx === currentIndex && s?.stream_url && s._hifiVersion === HIFI_MATCHER_VERSION) {
          return false;
        }
        return needsHifiCheck(s, inFlightRef.current, albumCacheRef.current);
      });

      const seenIds = new Set();
      const tier1Songs = [];
      for (const idx of tier1Indices) {
        const song = currentList[idx];
        const sid = String(song.id);
        if (!seenIds.has(sid)) {
          seenIds.add(sid);
          tier1Songs.push(song);
        }
      }

      if (tier1Songs.length > 0) {
        tier1Songs.forEach((song) => inFlightRef.current.add(String(song.id)));
        const results = await Promise.all(
          tier1Songs.map(async (song) => {
            try {
              const hifi = await resolveHifiForTrack(song, {
                mode: 'play',
                albumCacheMap: albumCacheRef.current,
              });
              return { song, hifi };
            } catch {
              return { song, hifi: { stream_url: null, _hifiTransient: true } };
            } finally {
              inFlightRef.current.delete(String(song.id));
            }
          })
        );
        for (const { song, hifi } of results) {
          patchTrack(song, hifi);
        }
      }

      const latestList = queueRef.current || [];
      const lookaheadIdx = activeNext >= 0 ? activeNext + 1 : -1;
      if (
        isHifiEnabledRef.current &&
        lookaheadIdx >= 0 &&
        lookaheadIdx < latestList.length &&
        lookaheadIdx !== currentIndex &&
        lookaheadIdx !== activeNext &&
        !isHifiCoolingDown()
      ) {
        const song = latestList[lookaheadIdx];
        if (needsHifiCheck(song, inFlightRef.current, albumCacheRef.current)) {
          inFlightRef.current.add(String(song.id));
          let hifi = null;
          try {
            hifi = await resolveHifiForTrack(song, {
              mode: 'probe',
              albumCacheMap: albumCacheRef.current,
            });
          } catch {
            hifi = { stream_url: null, _hifiTransient: true };
          } finally {
            inFlightRef.current.delete(String(song.id));
          }
          patchTrack(song, hifi);
        }
      }
    };

    runTier1();
    return undefined;
  }, [
    isHifiEnabled,
    currentIndex,
    activeNext,
    curTrack?.id,
    curTrack?._hifiChecked,
    curTrack?.stream_url,
    curTrack?._userForcedYoutube,
    curTrack?._hifiFailed,
    nextTrack?.id,
    nextTrack?._hifiChecked,
    nextTrack?.stream_url,
    nextTrack?._userForcedYoutube,
    nextTrack?._hifiFailed,
    lookaheadTrack?.id,
    lookaheadTrack?._hifiChecked,
    lookaheadTrack?.stream_url,
    patchTrack,
  ]);

  const albumCacheCount = albumCache ? Object.keys(albumCache).length : 0;

  // Tier 2 & Tier 3 progressive sweep
  useEffect(() => {
    if (!isHifiEnabled || !Array.isArray(queue) || queue.length === 0) {
      return undefined;
    }

    let isCancelled = false;

    const timer = setTimeout(async () => {
      // 2. Tier 2: Near lookahead (currentIndex + 2, +3) with lightweight byte probe
      const tier2Indices = [currentIndex + 2, currentIndex + 3].filter(
        (idx) =>
          idx >= 0 &&
          idx < queue.length &&
          idx !== activeNext &&
          needsHifiCheck(queue[idx], inFlightRef.current, albumCacheRef.current)
      );

      for (const idx of tier2Indices) {
        if (isCancelled || isHifiCoolingDown()) break;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') break;
        const song = queue[idx];
        if (!needsHifiCheck(song, inFlightRef.current, albumCacheRef.current)) continue;

        inFlightRef.current.add(String(song.id));
        let hifi = null;
        try {
          hifi = await resolveHifiForTrack(song, {
            mode: 'probe',
            albumCacheMap: albumCacheRef.current,
          });
        } catch {
          hifi = { stream_url: null, _hifiTransient: true };
        } finally {
          inFlightRef.current.delete(String(song.id));
        }

        if (isCancelled) break;
        patchTrack(song, hifi);
        await new Promise((r) => setTimeout(r, 300));
      }

      if (isCancelled) return;

      // 3. Tier 3: Active queue progressive sweep (mode: 'probe', polite spacing)
      const tier3Indices = [];
      const seenIdx = new Set([currentIndex, activeNext, currentIndex + 2, currentIndex + 3]);
      for (let i = Math.max(0, currentIndex + 4); i < queue.length; i++) {
        if (!seenIdx.has(i) && needsHifiCheck(queue[i], inFlightRef.current, albumCacheRef.current)) {
          tier3Indices.push(i);
          seenIdx.add(i);
        }
      }
      for (let i = 0; i < Math.min(Math.max(0, currentIndex), queue.length); i++) {
        if (!seenIdx.has(i) && needsHifiCheck(queue[i], inFlightRef.current, albumCacheRef.current)) {
          tier3Indices.push(i);
          seenIdx.add(i);
        }
      }

      for (const idx of tier3Indices) {
        if (isCancelled || isHifiCoolingDown()) break;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') break;
        const song = queue[idx];
        if (!needsHifiCheck(song, inFlightRef.current, albumCacheRef.current)) continue;

        inFlightRef.current.add(String(song.id));
        let hifi = null;
        try {
          hifi = await resolveHifiForTrack(song, {
            mode: 'probe',
            albumCacheMap: albumCacheRef.current,
          });
        } catch {
          hifi = { stream_url: null, _hifiTransient: true };
        } finally {
          inFlightRef.current.delete(String(song.id));
        }

        if (isCancelled) break;
        patchTrack(song, hifi);
        await new Promise((r) => setTimeout(r, 650));
      }
    }, 150);

    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [queue, currentIndex, activeNext, isHifiEnabled, patchTrack, albumCacheCount, visibilityTick]);
}
