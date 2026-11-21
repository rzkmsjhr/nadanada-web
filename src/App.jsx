import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Sun, Moon, Settings } from 'lucide-react';
import { api } from './services/api';
import {
  prepareTrackThroughGateSync,
  resolveHifiForTrack,
  isHifiEligibleTrack,
  setUserYoutubeForced,
} from './services/hifiResolver';
import { useLibrary } from './hooks/useLibrary';
import { useLyrics } from './hooks/useLyrics';
import { useArtistPage } from './hooks/useArtistPage';
import { useAlbumInfo } from './hooks/useAlbumInfo';
import { useHifiResolver } from './hooks/useHifiResolver';
import { useArtistFact } from './hooks/useArtistFact';
import { useWebPlayer } from './hooks/useWebPlayer';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { detectBrowserTrendingRegion, TRENDING_COUNTRY_CODES } from './utils/regionGeo';
import {
  buildQueueMatcher,
  buildTrendingKey,
  isTrackInQueue,
  isVideoTrack,
  reorderTracks,
  shiftIndexOnReorder,
} from './utils/queueUtils';
import { pickBestTrendingResult, buildCleanTrendingFallbackQuery } from './utils/trendingMatcher';
import LibraryPane from './components/LibraryPane';
import CenterPane from './components/CenterPane';
import MetadataPane from './components/MetadataPane';
import MiniPlayerDock from './components/MiniPlayerDock';
import VideoPopupModal from './components/VideoPopupModal';
import {
  SettingsModal,
  WelcomeModal,
  NamePromptModal,
  ConfirmModal,
  AddToPlaylistModal,
  ImportPlaylistModal,
  ArtworkModal,
} from './components/Modals';

function readBoolStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === 'true';
  } catch {
    return fallback;
  }
}

function getSystemTheme() {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function getSavedManualTheme() {
  try {
    const saved = localStorage.getItem('mysongs-theme');
    return saved === 'dark' || saved === 'light' ? saved : null;
  } catch {
    return null;
  }
}

function getSavedManualTrendingRegion() {
  try {
    const saved = localStorage.getItem('mysongs-trending-region');
    if (saved === 'global' || (saved && TRENDING_COUNTRY_CODES.has(saved))) {
      return saved;
    }
    return null;
  } catch {
    return null;
  }
}

export default function App() {
  // Theme & Settings (defaults to user's OS color scheme until manually toggled)
  const hasManualThemeRef = useRef(Boolean(getSavedManualTheme()));
  const [theme, setTheme] = useState(() => getSavedManualTheme() || getSystemTheme());
  const [isHifiEnabled, setIsHifiEnabled] = useState(() => readBoolStorage('mysongs-hifi-enabled', true));
  const [crossfadeDuration, setCrossfadeDuration] = useState(() => {
    const saved = parseInt(localStorage.getItem('mysongs-crossfade-duration') || '3', 10);
    return [0, 2, 3, 4, 5, 6].includes(saved) ? saved : 3;
  });
  const [visualizerMode, setVisualizerMode] = useState(
    () => localStorage.getItem('mysongs-visualizer-mode') || 'vinyl-box'
  );

  // Workspace navigation
  const [mobilePane, setMobilePane] = useState('center');
  const [centerMode, setCenterMode] = useState('queue'); // 'queue' | 'search' | 'liked' | 'playlist' | 'album'
  const [selectedPlaylistId, setSelectedPlaylistId] = useState(null);
  // Isolated direct playlist playback session (does not overwrite main Up Next queue)
  const [activePlaylistSession, setActivePlaylistSession] = useState(null);

  // Video Popup state (videos stay queueable in Up Next, but always play inside VideoPopupModal)
  const [videoModalTrack, setVideoModalTrack] = useState(null);
  const [isVideoMinimized, setIsVideoMinimized] = useState(false);
  const [isVideoFullscreen, setIsVideoFullscreen] = useState(false);
  const [videoIsPlaying, setVideoIsPlaying] = useState(false);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const videoYtRef = useRef(null);
  const videoStageRef = useRef(null);
  const videoDraggingRef = useRef(false);
  const videoRepeatCountRef = useRef(0);
  const openVideoPopupRef = useRef(null);
  const closeVideoPopupRef = useRef(null);
  const isVideoDockActive = Boolean(videoModalTrack && isVideoMinimized);

  // Queue & Playback flags
  const [queue, setQueue] = useState(() => {
    try {
      const raw = localStorage.getItem('mysongs-queue-v1');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [currentIndex, setCurrentIndex] = useState(() => {
    const idx = parseInt(localStorage.getItem('mysongs-queue-idx') || '-1', 10);
    return Number.isFinite(idx) ? idx : -1;
  });
  const [isShuffle, setIsShuffle] = useState(() => readBoolStorage('mysongs-shuffle', false));
  const [repeatMode, setRepeatMode] = useState(() => parseInt(localStorage.getItem('mysongs-repeat') || '0', 10) || 0);
  const [isEndlessPlay, setIsEndlessPlay] = useState(() => readBoolStorage('mysongs-endless', true));

  // Search state (collapsed by default)
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchTab, setSearchTab] = useState('song');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);

  // Album expansion state
  const [activeAlbumTitle, setActiveAlbumTitle] = useState('');
  const [albumTracks, setAlbumTracks] = useState([]);
  const [isAlbumLoading, setIsAlbumLoading] = useState(false);

  // Trending state (Left sidebar: defaults to visitor's country or nearest listed country)
  const hasManualTrendingRef = useRef(Boolean(getSavedManualTrendingRegion()));
  const [trendingRegion, setTrendingRegion] = useState(
    () => getSavedManualTrendingRegion() || detectBrowserTrendingRegion()
  );
  const [trendingTracks, setTrendingTracks] = useState([]);
  const [isTrendingLoading, setIsTrendingLoading] = useState(false);
  const [trendingError, setTrendingError] = useState(null);
  const [isTrendingCollapsed, setIsTrendingCollapsed] = useState(false);
  const [resolvingTrendingRank, setResolvingTrendingRank] = useState(null);

  // Modals & Toast
  const [showWelcome, setShowWelcome] = useState(() => !readBoolStorage('mysongs-welcome-seen', false));
  const [showSettings, setShowSettings] = useState(false);
  const [nameModal, setNameModal] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);
  const [addToPlaylistTrack, setAddToPlaylistTrack] = useState(null);
  const [showArtworkModal, setShowArtworkModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [isImportingPlaylist, setIsImportingPlaylist] = useState(false);
  const [importProgress, setImportProgress] = useState('');
  const [importError, setImportError] = useState(null);
  const [toastMsg, setToastMsg] = useState('');
  const toastTimerRef = useRef(null);
  const endlessFetchingRef = useRef(false);
  const pendingEndlessAdvanceRef = useRef(false);
  const handlePrevRef = useRef(null);
  const trendingReqIdRef = useRef(0);

  const showToast = useCallback((msg) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(''), 2600);
  }, []);

  // Apply theme & follow live OS theme changes when the user hasn't manually overridden it
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    if (hasManualThemeRef.current) {
      try {
        localStorage.setItem('mysongs-theme', theme);
      } catch {}
    }
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return undefined;
    const onSystemThemeChange = (e) => {
      if (!hasManualThemeRef.current) {
        setTheme(e.matches ? 'dark' : 'light');
      }
    };
    mq.addEventListener?.('change', onSystemThemeChange);
    return () => mq.removeEventListener?.('change', onSystemThemeChange);
  }, []);

  const handleToggleTheme = useCallback(() => {
    hasManualThemeRef.current = true;
    setTheme((t) => (t === 'light' ? 'dark' : 'light'));
  }, []);

  const handleChangeTrendingRegion = useCallback((nextRegion) => {
    hasManualTrendingRef.current = true;
    try {
      localStorage.setItem('mysongs-trending-region', nextRegion);
    } catch {}
    setTrendingRegion(nextRegion);
  }, []);

  // Refine default trending country via server IP geolocation if visitor has no manual override
  useEffect(() => {
    if (hasManualTrendingRef.current) return undefined;
    let cancelled = false;
    api
      .getVisitorRegion()
      .then((info) => {
        if (cancelled || hasManualTrendingRef.current) return;
        if (info?.detected && info.region && TRENDING_COUNTRY_CODES.has(info.region)) {
          setTrendingRegion((prev) => (prev === info.region ? prev : info.region));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('mysongs-hifi-enabled', String(isHifiEnabled));
  }, [isHifiEnabled]);

  useEffect(() => {
    localStorage.setItem('mysongs-crossfade-duration', String(crossfadeDuration));
  }, [crossfadeDuration]);

  useEffect(() => {
    localStorage.setItem('mysongs-visualizer-mode', visualizerMode);
  }, [visualizerMode]);

  useEffect(() => {
    try {
      localStorage.setItem('mysongs-queue-v1', JSON.stringify(queue));
      localStorage.setItem('mysongs-queue-idx', String(currentIndex));
    } catch {}
  }, [queue, currentIndex]);

  useEffect(() => {
    localStorage.setItem('mysongs-shuffle', String(isShuffle));
    localStorage.setItem('mysongs-repeat', String(repeatMode));
    localStorage.setItem('mysongs-endless', String(isEndlessPlay));
  }, [isShuffle, repeatMode, isEndlessPlay]);

  const library = useLibrary();

  const queueMatcher = useMemo(() => buildQueueMatcher(queue), [queue]);

  const activePlaylist = useMemo(
    () =>
      activePlaylistSession
        ? library.playlists.find((p) => p.id === activePlaylistSession.playlistId) || null
        : null,
    [library.playlists, activePlaylistSession]
  );

  const isPlaylistPlayback = Boolean(activePlaylist && activePlaylistSession);

  const activePlaylistTracks = useMemo(() => {
    if (!activePlaylist) return [];
    const overrides = activePlaylistSession?.overrides || {};
    return activePlaylist.tracks.map((t) => {
      const prepared = prepareTrackThroughGateSync(t, isHifiEnabled);
      const ov = t?.id ? overrides[String(t.id)] : null;
      return ov ? { ...prepared, ...ov } : prepared;
    });
  }, [activePlaylist, activePlaylistSession?.overrides, isHifiEnabled]);

  const isPlaylistPlaybackRef = useRef(false);
  const activePlaylistTracksRef = useRef([]);
  isPlaylistPlaybackRef.current = isPlaylistPlayback;
  activePlaylistTracksRef.current = activePlaylistTracks;

  // Clear isolated session automatically if the playing playlist is deleted
  useEffect(() => {
    if (activePlaylistSession && !activePlaylist) {
      setActivePlaylistSession(null);
    }
  }, [activePlaylistSession, activePlaylist]);

  const activeTrackList = isPlaylistPlayback ? activePlaylistTracks : queue;
  const activePlayIndex = isPlaylistPlayback
    ? activePlaylistSession?.index ?? -1
    : currentIndex;

  const currentSong =
    activePlayIndex >= 0 && activePlayIndex < activeTrackList.length
      ? activeTrackList[activePlayIndex]
      : null;

  const upcomingIndex = useMemo(() => {
    if (activeTrackList.length <= 1 || activePlayIndex < 0) return -1;
    if (isShuffle) {
      let rand = Math.floor(Math.random() * activeTrackList.length);
      if (rand === activePlayIndex) rand = (activePlayIndex + 1) % activeTrackList.length;
      return rand;
    }
    return activePlayIndex + 1 < activeTrackList.length ? activePlayIndex + 1 : -1;
  }, [activeTrackList.length, activePlayIndex, isShuffle]);

  const nextSong = upcomingIndex >= 0 ? activeTrackList[upcomingIndex] : null;
  const currentAudioSong = currentSong && !isVideoTrack(currentSong) ? currentSong : null;
  const nextAudioSong = nextSong && !isVideoTrack(nextSong) ? nextSong : null;

  const setActiveTrackList = useCallback((updater) => {
    if (isPlaylistPlaybackRef.current) {
      setActivePlaylistSession((prev) => {
        if (!prev) return prev;
        const nextList =
          typeof updater === 'function' ? updater(activePlaylistTracksRef.current) : updater;
        if (!Array.isArray(nextList)) return prev;
        const nextOverrides = { ...(prev.overrides || {}) };
        for (const item of nextList) {
          if (item?.id) nextOverrides[String(item.id)] = item;
        }
        return { ...prev, overrides: nextOverrides };
      });
      return;
    }
    setQueue(updater);
  }, []);

  const advanceToNext = useCallback(
    (meta) => {
      if (activeTrackList.length === 0) return false;
      if (upcomingIndex >= 0) {
        pendingEndlessAdvanceRef.current = false;
        const target = activeTrackList[upcomingIndex];
        if (isVideoTrack(target)) {
          openVideoPopupRef.current?.(target);
        } else {
          closeVideoPopupRef.current?.();
        }
        if (isPlaylistPlayback) {
          setActivePlaylistSession((prev) => (prev ? { ...prev, index: upcomingIndex } : prev));
        } else {
          setCurrentIndex(upcomingIndex);
        }
        return true;
      }
      if (!isPlaylistPlayback && meta?.fromEnd && isEndlessPlay && !isShuffle && endlessFetchingRef.current) {
        pendingEndlessAdvanceRef.current = true;
        return true;
      }
      return false;
    },
    [activeTrackList, upcomingIndex, isPlaylistPlayback, isEndlessPlay, isShuffle]
  );

  const handleSongHifiResolved = useCallback(
    (resolvedSong) => {
      setActiveTrackList((prev) =>
        prev.map((s) => (s.id === resolvedSong.id ? { ...s, ...resolvedSong } : s))
      );
    },
    [setActiveTrackList]
  );

  const handleSongHifiFailed = useCallback(
    (failedSong) => {
      setActiveTrackList((prev) =>
        prev.map((s) =>
          s.id === failedSong.id ? { ...s, stream_url: null, source: null, _hifiFailed: true } : s
        )
      );
    },
    [setActiveTrackList]
  );

  const player = useWebPlayer({
    currentSong: currentAudioSong,
    nextSong: nextAudioSong,
    hasNext: Boolean(nextAudioSong),
    isHifiEnabled,
    crossfadeDuration,
    repeatMode,
    suppressMediaSession: isVideoDockActive,
    onNext: advanceToNext,
    onPrevious: () => handlePrevRef.current?.(),
    onSongHifiResolved: handleSongHifiResolved,
    onSongHifiFailed: handleSongHifiFailed,
  });

  const exitVideoFullscreen = useCallback(() => {
    setIsVideoFullscreen(false);
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setIsVideoFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const openVideoPopup = useCallback(
    (track) => {
      if (!track) return;
      if (document.activeElement && document.activeElement !== document.body) {
        try {
          document.activeElement.blur?.();
        } catch {}
      }
      player.pause?.();
      exitVideoFullscreen();
      videoRepeatCountRef.current = 0;
      setVideoModalTrack(track);
      setIsVideoMinimized(false);
      setVideoIsPlaying(true);
      setVideoCurrentTime(0);
      setVideoDuration(0);
    },
    [player.pause, exitVideoFullscreen]
  );
  openVideoPopupRef.current = openVideoPopup;

  const closeVideoPopup = useCallback(() => {
    exitVideoFullscreen();
    try {
      videoYtRef.current?.stopVideo?.();
    } catch {}
    videoDraggingRef.current = false;
    setVideoModalTrack(null);
    setIsVideoMinimized(false);
    setVideoIsPlaying(false);
    setVideoCurrentTime(0);
    setVideoDuration(0);
  }, [exitVideoFullscreen]);
  closeVideoPopupRef.current = closeVideoPopup;

  const minimizeVideoPopup = useCallback(() => {
    exitVideoFullscreen();
    setIsVideoMinimized(true);
  }, [exitVideoFullscreen]);

  const restoreVideoPopup = useCallback(() => {
    setIsVideoMinimized(false);
  }, []);

  const handleToggleVideoFullscreen = useCallback(() => {
    if (!videoModalTrack) return;
    const currentlyFullscreen = Boolean(document.fullscreenElement) || isVideoFullscreen;
    if (currentlyFullscreen) {
      exitVideoFullscreen();
      return;
    }
    setIsVideoMinimized(false);
    setIsVideoFullscreen(true);
    const stageEl = videoStageRef.current;
    if (stageEl?.requestFullscreen && document.fullscreenEnabled && !document.fullscreenElement) {
      stageEl.requestFullscreen().catch(() => {});
    }
  }, [videoModalTrack, isVideoFullscreen, exitVideoFullscreen]);

  const handleVideoDockTogglePlay = useCallback(() => {
    const yt = videoYtRef.current;
    if (!yt) return;
    try {
      const state = yt.getPlayerState?.();
      if (state === 1 || state === 3) {
        yt.pauseVideo?.();
        setVideoIsPlaying(false);
      } else {
        yt.playVideo?.();
        setVideoIsPlaying(true);
      }
    } catch {}
  }, []);

  const handleVideoDockSeek = useCallback((targetTime) => {
    const secs = Math.max(0, Number(targetTime) || 0);
    setVideoCurrentTime(secs);
    try {
      videoYtRef.current?.seekTo?.(secs, true);
    } catch {}
  }, []);

  const handleVideoDockSeekBy = useCallback(
    (delta) => {
      const yt = videoYtRef.current;
      let cur = videoCurrentTime;
      try {
        if (typeof yt?.getCurrentTime === 'function') cur = Number(yt.getCurrentTime()) || 0;
      } catch {}
      const target = Math.max(0, Math.min(videoDuration || Number.MAX_SAFE_INTEGER, cur + delta));
      handleVideoDockSeek(target);
    },
    [videoCurrentTime, videoDuration, handleVideoDockSeek]
  );

  const handleMainTogglePlay = useCallback(() => {
    if (currentSong && isVideoTrack(currentSong)) {
      openVideoPopup(currentSong);
      return;
    }
    closeVideoPopup();
    player.togglePlay?.();
  }, [currentSong, openVideoPopup, closeVideoPopup, player.togglePlay]);

  const handleVideoEnded = useCallback(() => {
    if (!videoModalTrack) return;
    const isPlayingFromQueue =
      currentSong && String(currentSong.id) === String(videoModalTrack.id);
    if (!isPlayingFromQueue) return;

    if (repeatMode === 1 || (repeatMode === 2 && videoRepeatCountRef.current < 1)) {
      videoRepeatCountRef.current = repeatMode === 2 ? 1 : 0;
      handleVideoDockSeek(0);
      try {
        videoYtRef.current?.playVideo?.();
        setVideoIsPlaying(true);
      } catch {}
      return;
    }
    videoRepeatCountRef.current = 0;
    advanceToNext({ fromEnd: true });
  }, [videoModalTrack, currentSong, repeatMode, handleVideoDockSeek, advanceToNext]);

  // Hand OS MediaSession metadata & controls over to the minimized video when docked
  useEffect(() => {
    if (!isVideoDockActive || !videoModalTrack) return undefined;
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return undefined;
    const ms = navigator.mediaSession;
    try {
      const artist = (videoModalTrack.channel || videoModalTrack.artist || '').replace(/\s*-\s*Topic$/i, '').trim();
      const artwork = videoModalTrack.thumbnail
        ? [{ src: videoModalTrack.thumbnail, sizes: '512x512', type: 'image/jpeg' }]
        : [];
      if (typeof MediaMetadata !== 'undefined') {
        ms.metadata = new MediaMetadata({
          title: videoModalTrack.title || 'NadaNada Video',
          artist: artist || 'YouTube',
          album: '',
          artwork,
        });
      }
      ms.playbackState = videoIsPlaying ? 'playing' : 'paused';
    } catch {}
    return undefined;
  }, [isVideoDockActive, videoModalTrack?.id, videoModalTrack?.title, videoModalTrack?.channel, videoModalTrack?.artist, videoModalTrack?.thumbnail, videoIsPlaying]);

  useEffect(() => {
    if (!isVideoDockActive) return undefined;
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return undefined;
    const ms = navigator.mediaSession;
    const safeSet = (action, handler) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {}
    };
    safeSet('play', () => {
      try {
        videoYtRef.current?.playVideo?.();
        setVideoIsPlaying(true);
      } catch {}
    });
    safeSet('pause', () => {
      try {
        videoYtRef.current?.pauseVideo?.();
        setVideoIsPlaying(false);
      } catch {}
    });
    safeSet('previoustrack', () => handlePrevRef.current?.());
    safeSet('nexttrack', () => advanceToNext({ fromMediaSession: true }));
    safeSet('seekto', (details) => {
      if (typeof details?.seekTime === 'number') handleVideoDockSeek(details.seekTime);
    });
    return () => {
      safeSet('play', null);
      safeSet('pause', null);
      safeSet('previoustrack', null);
      safeSet('nexttrack', null);
      safeSet('seekto', null);
    };
  }, [isVideoDockActive, handleVideoDockSeek, advanceToNext]);

  const { albumInfo, albumCache } = useAlbumInfo(activeTrackList, activePlayIndex);
  const artistFact = useArtistFact(currentSong, albumInfo);
  const lyrics = useLyrics(currentSong);
  const artistPage = useArtistPage();

  // Tiered background Hi-Fi FLAC resolver (Tier 1: current+next play mode, Tier 2/3: active list probe mode)
  useHifiResolver({
    queue: activeTrackList,
    setQueue: setActiveTrackList,
    currentIndex: activePlayIndex,
    upcomingIndex,
    isHifiEnabled,
    albumCache,
  });

  // Warm next audio track's FLAC byte buffer early so crossfade never pauses
  useEffect(() => {
    if (!isHifiEnabled || !nextAudioSong || !isHifiEligibleTrack(nextAudioSong) || nextAudioSong._userForcedYoutube) {
      return;
    }
    const controller = new AbortController();
    const warmStream = (url) => {
      if (!url) return;
      fetch(url, { headers: { Range: 'bytes=0-1023' }, signal: controller.signal }).catch(() => {});
    };

    const t = setTimeout(() => {
      if (nextAudioSong.stream_url) {
        warmStream(nextAudioSong.stream_url);
      } else {
        resolveHifiForTrack(nextAudioSong, { mode: 'play', albumCacheMap: albumCache }).then((res) => {
          if (res?.stream_url && !controller.signal.aborted) {
            handleSongHifiResolved({ ...nextAudioSong, ...res });
            warmStream(res.stream_url);
          }
        });
      }
    }, 1200);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [nextAudioSong?.id, nextAudioSong?.stream_url, isHifiEnabled]);

  // Endless Play auto-append when reaching last 2 songs of main queue
  useEffect(() => {
    if (isPlaylistPlayback || !isEndlessPlay || isShuffle || queue.length === 0 || currentIndex < 0) return;
    if (currentIndex < queue.length - 2 || endlessFetchingRef.current) return;

    const anchor = queue[queue.length - 1];
    if (!anchor?.id || !/^[a-zA-Z0-9_-]{11}$/.test(String(anchor.id))) return;

    endlessFetchingRef.current = true;
    api
      .getYouTubeMix(anchor.id)
      .then((mix) => {
        if (!Array.isArray(mix) || mix.length === 0) return;
        setQueue((prev) => {
          const existingIds = new Set(prev.map((x) => String(x.id)));
          const candidate = mix.find((m) => m?.id && !existingIds.has(String(m.id)) && !isVideoTrack(m));
          if (!candidate) {
            pendingEndlessAdvanceRef.current = false;
            return prev;
          }
          if (pendingEndlessAdvanceRef.current) {
            pendingEndlessAdvanceRef.current = false;
            if (isVideoTrack(candidate)) {
              openVideoPopupRef.current?.(candidate);
            } else {
              closeVideoPopupRef.current?.();
            }
            setCurrentIndex(prev.length);
          }
          return [...prev, prepareTrackThroughGateSync({ ...candidate, isEndlessGenerated: true }, isHifiEnabled)];
        });
      })
      .catch(() => {})
      .finally(() => {
        endlessFetchingRef.current = false;
      });
  }, [isPlaylistPlayback, isEndlessPlay, isShuffle, queue.length, currentIndex, isHifiEnabled]);

  // Load Trending chart
  const loadTrending = useCallback(async (region) => {
    const reqId = ++trendingReqIdRef.current;
    setIsTrendingLoading(true);
    setTrendingError(null);
    try {
      const tracks = await api.getKworbChart(region);
      if (reqId !== trendingReqIdRef.current) return;
      setTrendingTracks(Array.isArray(tracks) ? tracks : []);
    } catch (err) {
      if (reqId !== trendingReqIdRef.current) return;
      setTrendingError(err?.message || 'Failed to load trending chart');
    } finally {
      if (reqId === trendingReqIdRef.current) {
        setIsTrendingLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadTrending(trendingRegion);
  }, [trendingRegion, loadTrending]);

  const resolveTrendingEntry = useCallback(async (entry) => {
    const query = entry.query || `${entry.title} ${entry.artist}`.trim();
    const results = await api.searchYouTube(query, 'song');
    let best = pickBestTrendingResult(results, entry);
    // If initial search returned only covers/unrelated channels, retry once with a cleaned artist+title query
    if (!best || best.score < 80) {
      const cleanQuery = buildCleanTrendingFallbackQuery(entry);
      if (cleanQuery && cleanQuery.toLowerCase() !== query.toLowerCase()) {
        const fallbackResults = await api.searchYouTube(cleanQuery, 'song').catch(() => []);
        const fallbackBest = pickBestTrendingResult(fallbackResults, entry);
        if (fallbackBest && (!best || fallbackBest.score > best.score)) {
          best = fallbackBest;
        }
      }
    }
    const picked = best?.item || results?.[0];
    if (!picked) throw new Error(`Could not find stream for ${entry.title}`);
    return prepareTrackThroughGateSync(
      { ...picked, item_type: picked.item_type || 'song' },
      isHifiEnabled
    );
  }, [isHifiEnabled]);

  const handlePlayTrendingTrack = useCallback(async (entry) => {
    if (resolvingTrendingRank) return;
    player.unlockAudioDecks?.();
    setResolvingTrendingRank(entry.rank);
    try {
      const resolved = {
        ...(await resolveTrendingEntry(entry)),
        _trendingKey: buildTrendingKey(entry.title, entry.artist),
      };
      if (isVideoTrack(resolved)) {
        openVideoPopup(resolved);
        return;
      }
      closeVideoPopup();
      setActivePlaylistSession(null);
      const existingIdx = queue.findIndex((s) => String(s.id) === String(resolved.id));
      if (existingIdx >= 0) {
        setCurrentIndex(existingIdx);
      } else {
        setQueue((prev) => {
          const nextIdx = currentIndex >= 0 ? currentIndex + 1 : prev.length;
          const copy = [...prev];
          copy.splice(nextIdx, 0, resolved);
          setCurrentIndex(nextIdx);
          return copy;
        });
      }
      setCenterMode('queue');
      showToast(`Playing: ${resolved.title}`);
    } catch (err) {
      showToast(err?.message || 'Failed to play trending track');
    } finally {
      setResolvingTrendingRank(null);
    }
  }, [resolvingTrendingRank, resolveTrendingEntry, queue, currentIndex, showToast, player, openVideoPopup, closeVideoPopup]);

  const handleQueueTrendingTrack = useCallback(async (entry) => {
    if (resolvingTrendingRank) return;
    setResolvingTrendingRank(entry.rank);
    try {
      const resolved = {
        ...(await resolveTrendingEntry(entry)),
        _trendingKey: buildTrendingKey(entry.title, entry.artist),
      };
      if (isVideoTrack(resolved)) {
        openVideoPopup(resolved);
      }
      let added = true;
      setQueue((prev) => {
        if (prev.some((s) => String(s.id) === String(resolved.id))) {
          added = false;
          return prev;
        }
        if (prev.length === 0) setCurrentIndex(0);
        return [...prev, resolved];
      });
      showToast(added ? `Queued: ${resolved.title}` : `Already in queue: ${resolved.title}`);
    } catch (err) {
      showToast(err?.message || 'Failed to queue track');
    } finally {
      setResolvingTrendingRank(null);
    }
  }, [resolvingTrendingRank, resolveTrendingEntry, showToast, openVideoPopup]);

  // Search handler
  const runSearch = useCallback(async (q, type) => {
    const clean = String(q || '').trim();
    if (!clean) return;
    setCenterMode('search');
    setIsSearching(true);
    setSearchError(null);
    try {
      let ytRes = [];
      let monoRes = [];
      if (type === 'video') {
        ytRes = await api.searchYouTube(clean, 'video');
      } else {
        [ytRes, monoRes] = await Promise.all([
          api.searchYouTube(clean, type).catch(() => []),
          isHifiEnabled ? api.searchMonochrome(clean, type).catch(() => []) : Promise.resolve([]),
        ]);
      }
      const seen = new Set();
      const merged = [];
      for (const item of [...ytRes, ...monoRes]) {
        if (!item?.id || seen.has(String(item.id))) continue;
        seen.add(String(item.id));
        merged.push(prepareTrackThroughGateSync(item, isHifiEnabled));
      }
      setSearchResults(merged);
    } catch (err) {
      setSearchError(err?.message || 'Search failed');
    } finally {
      setIsSearching(false);
    }
  }, [isHifiEnabled]);

  const handleOpenAlbum = useCallback(async (albumItem) => {
    if (!albumItem) return;
    setCenterMode('album');
    setActiveAlbumTitle(albumItem.title || 'Album');
    setIsAlbumLoading(true);
    setAlbumTracks([]);

    try {
      let tracks = [];
      if (albumItem.source === 'monochrome' && albumItem.id) {
        tracks = await api.getMonochromeAlbum(albumItem.id);
      } else if (albumItem.id) {
        tracks = await api.getYouTubePlaylist(albumItem.id, albumItem.first_video_id || '');
      } else if (albumItem.first_video_id) {
        const info = await api.getVideoAlbumInfo(albumItem.first_video_id);
        if (info?.album_playlist_id) {
          tracks = await api.getYouTubePlaylist(info.album_playlist_id, albumItem.first_video_id);
        }
      }
      if (tracks.length === 0 && albumItem.title) {
        const found = await api.searchYouTube(`${albumItem.title} ${albumItem.channel || ''}`, 'album');
        if (found[0]?.id) {
          tracks = await api.getYouTubePlaylist(found[0].id, found[0].first_video_id || '');
        }
      }
      setAlbumTracks(tracks.slice(0, 50).map((t) => prepareTrackThroughGateSync(t, isHifiEnabled)));
    } catch (err) {
      showToast(err?.message || 'Could not load album tracks');
    } finally {
      setIsAlbumLoading(false);
    }
  }, [isHifiEnabled, showToast]);

  const handleDownloadTrack = useCallback(async (track) => {
    if (!track?.id) return;
    showToast(`Preparing download: ${track.title}`);
    let streamUrl = track.stream_url;
    let hifiId = track.hifi_id;

    if (isHifiEnabled && isHifiEligibleTrack(track) && !streamUrl && !track._userForcedYoutube) {
      const resolved = await resolveHifiForTrack(track);
      if (resolved?.stream_url) {
        streamUrl = resolved.stream_url;
        hifiId = resolved.hifi_id;
      }
    }
    const cleanArtist = (track.channel || track.artist || '').replace(/\s*-\s*Topic$/i, '').trim();
    api.triggerBrowserDownload({
      id: track.id,
      title: track.title,
      artist: cleanArtist,
      hifiId,
      streamUrl,
    });
  }, [isHifiEnabled, showToast]);

  const handleImportPlaylist = useCallback(async () => {
    const raw = importUrl.trim();
    if (!raw || isImportingPlaylist) return;
    setIsImportingPlaylist(true);
    setImportError(null);
    setImportProgress('Fetching playlist...');

    try {
      const ytListMatch = raw.match(/[?&]list=([^&]+)/);
      const spotifyMatch = raw.match(/playlist\/([a-zA-Z0-9]+)/);

      if ((raw.includes('youtube.com/') || raw.includes('youtu.be/') || raw.includes('music.youtube.com/')) && ytListMatch?.[1]) {
        const playlistId = ytListMatch[1];
        const [songs, title] = await Promise.all([
          api.getYouTubePlaylist(playlistId, ''),
          api.getPlaylistTitle('youtube', playlistId).catch(() => 'Imported YouTube Playlist'),
        ]);
        if (!songs?.length) throw new Error('No songs found in YouTube playlist (private or empty).');
        const prepared = songs.map((s) => prepareTrackThroughGateSync(s, isHifiEnabled));
        const created = library.createPlaylist(title || 'Imported YouTube Playlist', prepared);
        if (created) {
          setSelectedPlaylistId(created.id);
          setCenterMode('playlist');
          setMobilePane('center');
        }
        setShowImportModal(false);
        setImportUrl('');
        showToast(`Imported "${title}" (${prepared.length} songs)`);
      } else if (raw.includes('spotify.com/playlist/') && spotifyMatch?.[1]) {
        const playlistId = spotifyMatch[1];
        const [spTracks, title] = await Promise.all([
          api.getSpotifyPlaylist(playlistId),
          api.getPlaylistTitle('spotify', playlistId).catch(() => 'Imported Spotify Playlist'),
        ]);
        if (!spTracks?.length) throw new Error('No tracks found in Spotify playlist (private or empty).');

        const imported = [];
        for (let i = 0; i < spTracks.length; i++) {
          const t = spTracks[i];
          setImportProgress(`Matching ${i + 1}/${spTracks.length}...`);
          try {
            let results = await api.searchYouTube(t.query, 'song');
            if (!results?.length) {
              results = await api.searchYouTube(t.query, 'video').catch(() => []);
            }
            const clean = results.find((r) => !/karaoke|instrumental/i.test(r.title || '')) || results[0];
            if (clean) imported.push(prepareTrackThroughGateSync(clean, isHifiEnabled));
          } catch {}
        }
        if (imported.length === 0) throw new Error('Could not match tracks from Spotify playlist.');
        const created = library.createPlaylist(title || 'Imported Spotify Playlist', imported);
        if (created) {
          setSelectedPlaylistId(created.id);
          setCenterMode('playlist');
          setMobilePane('center');
        }
        setShowImportModal(false);
        setImportUrl('');
        showToast(`Imported "${title}" (${imported.length}/${spTracks.length} songs)`);
      } else {
        throw new Error('Enter a valid YouTube playlist URL (?list=...) or Spotify playlist URL.');
      }
    } catch (err) {
      setImportError(err?.message || 'Failed to import playlist.');
    } finally {
      setIsImportingPlaylist(false);
      setImportProgress('');
    }
  }, [importUrl, isImportingPlaylist, isHifiEnabled, library, showToast]);

  // Displayed tracklist for Center pane
  const selectedPlaylist = useMemo(
    () => library.playlists.find((p) => p.id === selectedPlaylistId) || null,
    [library.playlists, selectedPlaylistId]
  );

  const visibleTracks = useMemo(() => {
    if (centerMode === 'search') return searchResults;
    if (centerMode === 'liked') return library.likedSongs;
    if (centerMode === 'playlist') return selectedPlaylist?.tracks || [];
    if (centerMode === 'album') return albumTracks;
    return queue;
  }, [centerMode, searchResults, library.likedSongs, selectedPlaylist, albumTracks, queue]);

  const contextTitle = useMemo(() => {
    if (centerMode === 'search') {
      return searchQuery ? `Results for "${searchQuery}" (${searchResults.length})` : 'Search';
    }
    if (centerMode === 'liked') return `Liked Songs (${library.likedSongs.length})`;
    if (centerMode === 'playlist') return `${selectedPlaylist?.name || 'Playlist'} (${selectedPlaylist?.tracks?.length || 0})`;
    if (centerMode === 'album') return `Album: ${activeAlbumTitle} (${albumTracks.length})`;
    return `Up Next (${queue.length})`;
  }, [centerMode, searchQuery, searchResults.length, library.likedSongs.length, selectedPlaylist, activeAlbumTitle, albumTracks.length, queue.length]);

  const handlePlayVisibleTrack = useCallback((track, idx) => {
    if (centerMode === 'playlist' && selectedPlaylistId) {
      player.unlockAudioDecks?.();
      const isSamePlaylistItem =
        isPlaylistPlayback &&
        activePlaylistSession?.playlistId === selectedPlaylistId &&
        activePlayIndex === idx;
      if (isVideoTrack(track)) {
        setActivePlaylistSession((prev) => ({
          playlistId: selectedPlaylistId,
          index: idx,
          overrides: prev?.playlistId === selectedPlaylistId ? prev.overrides : {},
        }));
        openVideoPopup(track);
        return;
      }
      closeVideoPopup();
      if (isSamePlaylistItem) {
        player.togglePlay();
        return;
      }
      setActivePlaylistSession((prev) => ({
        playlistId: selectedPlaylistId,
        index: idx,
        overrides: prev?.playlistId === selectedPlaylistId ? prev.overrides : {},
      }));
      return;
    }

    if (isVideoTrack(track)) {
      if (centerMode === 'queue') {
        setActivePlaylistSession(null);
        setCurrentIndex(idx);
      }
      openVideoPopup(track);
      return;
    }
    player.unlockAudioDecks?.();
    closeVideoPopup();
    if (centerMode === 'queue') {
      if (!isPlaylistPlayback && idx === currentIndex) {
        player.togglePlay();
      } else {
        setActivePlaylistSession(null);
        setCurrentIndex(idx);
        if (queue[idx]?.id && currentSong?.id && String(queue[idx].id) === String(currentSong.id) && !player.isPlaying) {
          player.togglePlay();
        }
      }
      return;
    }

    setActivePlaylistSession(null);
    if (centerMode === 'liked' || centerMode === 'album') {
      const preparedList = visibleTracks.map((t) => prepareTrackThroughGateSync(t, isHifiEnabled));
      setQueue(preparedList);
      setCurrentIndex(idx);
      return;
    }

    // Search result click: insert song after current track or append & play
    const prepared = prepareTrackThroughGateSync(track, isHifiEnabled);
    setQueue((prev) => {
      const existing = prev.findIndex((s) => String(s.id) === String(prepared.id));
      if (existing >= 0) {
        setCurrentIndex(existing);
        return prev;
      }
      const nextIdx = currentIndex >= 0 ? currentIndex + 1 : prev.length;
      const copy = [...prev];
      copy.splice(nextIdx, 0, prepared);
      setCurrentIndex(nextIdx);
      return copy;
    });
  }, [
    centerMode,
    selectedPlaylistId,
    isPlaylistPlayback,
    activePlaylistSession,
    activePlayIndex,
    currentIndex,
    queue,
    currentSong?.id,
    visibleTracks,
    isHifiEnabled,
    player,
    openVideoPopup,
    closeVideoPopup,
  ]);

  const handleDeleteVisibleTrack = useCallback((track, idx) => {
    if (centerMode === 'liked') {
      library.removeFromLiked(track.id);
      return;
    }
    if (centerMode === 'playlist' && selectedPlaylistId) {
      const nextLen = Math.max(0, (selectedPlaylist?.tracks?.length || 0) - 1);
      library.removeTrackFromPlaylist(selectedPlaylistId, track.id);
      setActivePlaylistSession((prev) => {
        if (!prev || prev.playlistId !== selectedPlaylistId) return prev;
        if (nextLen === 0) return null;
        if (idx < prev.index) return { ...prev, index: Math.max(0, prev.index - 1) };
        if (idx === prev.index) return { ...prev, index: Math.min(idx, nextLen - 1) };
        return prev;
      });
      return;
    }
    if (centerMode === 'search') {
      setSearchResults((prev) => prev.filter((_, i) => i !== idx));
      return;
    }
    if (centerMode === 'album') {
      setAlbumTracks((prev) => prev.filter((_, i) => i !== idx));
      return;
    }
    // Queue delete
    setQueue((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      if (next.length === 0) {
        setCurrentIndex(-1);
      } else if (idx < currentIndex) {
        setCurrentIndex((c) => Math.max(0, c - 1));
      } else if (idx === currentIndex) {
        setCurrentIndex(Math.min(idx, next.length - 1));
      }
      return next;
    });
  }, [centerMode, library, selectedPlaylistId, currentIndex]);

  const handleReorderQueue = useCallback((fromIdx, toIdx) => {
    if (!Number.isInteger(fromIdx) || !Number.isInteger(toIdx) || fromIdx === toIdx) return;
    setQueue((prev) => reorderTracks(prev, fromIdx, toIdx));
    setCurrentIndex((cur) => shiftIndexOnReorder(cur, fromIdx, toIdx));
  }, []);

  const handleReorderVisibleTracks = useCallback(
    (fromIdx, toIdx) => {
      if (centerMode === 'playlist' && selectedPlaylistId) {
        library.reorderPlaylistTracks(selectedPlaylistId, fromIdx, toIdx);
        setActivePlaylistSession((prev) => {
          if (!prev || prev.playlistId !== selectedPlaylistId) return prev;
          return { ...prev, index: shiftIndexOnReorder(prev.index, fromIdx, toIdx) };
        });
        return;
      }
      if (centerMode === 'queue') {
        handleReorderQueue(fromIdx, toIdx);
      }
    },
    [centerMode, selectedPlaylistId, library, handleReorderQueue]
  );

  const handleQueuePlaylist = useCallback(
    (pl) => {
      if (!pl?.tracks?.length) return;
      const preparedList = pl.tracks.map((t) => prepareTrackThroughGateSync(t, isHifiEnabled));
      const existingIds = new Set(queue.map((s) => String(s.id)));
      const toAdd = [];
      for (const item of preparedList) {
        const id = String(item.id || '');
        if (id && !existingIds.has(id) && !isTrackInQueue(queueMatcher, item)) {
          existingIds.add(id);
          toAdd.push(item);
        }
      }
      if (toAdd.length > 0) {
        setQueue((prev) => {
          if (prev.length === 0) setCurrentIndex(0);
          const prevIds = new Set(prev.map((s) => String(s.id)));
          const fresh = toAdd.filter((item) => !prevIds.has(String(item.id || '')));
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
      }
      showToast(
        toAdd.length > 0
          ? `Added ${toAdd.length} track${toAdd.length === 1 ? '' : 's'} from "${pl.name}" to queue`
          : `All tracks from "${pl.name}" are already in queue`
      );
    },
    [queue, queueMatcher, isHifiEnabled, showToast]
  );

  const handlePrev = useCallback(() => {
    if (isVideoDockActive) {
      if (videoCurrentTime > 4) {
        handleVideoDockSeek(0);
        return;
      }
    } else if (player.currentTime > 4) {
      player.seekTo(0);
      return;
    }
    if (activeTrackList.length === 0) return;
    const prevIdx = activePlayIndex > 0 ? activePlayIndex - 1 : activeTrackList.length - 1;
    const target = activeTrackList[prevIdx];
    if (isVideoTrack(target)) {
      openVideoPopupRef.current?.(target);
    } else {
      closeVideoPopupRef.current?.();
      if (prevIdx === activePlayIndex && !player.isPlaying) {
        player.togglePlay?.();
      }
    }
    if (isPlaylistPlayback) {
      setActivePlaylistSession((prev) => (prev ? { ...prev, index: prevIdx } : prev));
    } else {
      setCurrentIndex(prevIdx);
    }
  }, [
    isVideoDockActive,
    videoCurrentTime,
    handleVideoDockSeek,
    player,
    activeTrackList,
    activePlayIndex,
    isPlaylistPlayback,
  ]);
  handlePrevRef.current = handlePrev;

  const handleToggleTrackSource = useCallback(() => {
    if (!currentSong) return;
    if (player.isGatingHifi) return;
    if (!isHifiEnabled) {
      showToast('Enable Hi-Fi Audio in Settings first');
      return;
    }
    const nextForceYt = !currentSong._userForcedYoutube && player.isPlayingHiFi;
    setUserYoutubeForced(currentSong.id, nextForceYt);
    setActiveTrackList((prev) =>
      prev.map((s) =>
        s.id === currentSong.id
          ? {
              ...s,
              _userForcedYoutube: nextForceYt,
              _hifiFailed: false,
              ...(nextForceYt ? {} : { _hifiChecked: false }),
            }
          : s
      )
    );
    showToast(nextForceYt ? 'Switched track to YouTube' : 'Retrying Hi-Fi FLAC stream...');
    if (!nextForceYt) {
      resolveHifiForTrack(currentSong, {
        forceRefresh: true,
        ignoreBlacklist: true,
        mode: 'play',
        albumCacheMap: albumCache,
      }).then((resolved) => {
        if (resolved?.stream_url) {
          handleSongHifiResolved({
            ...currentSong,
            ...resolved,
            _userForcedYoutube: false,
            _hifiFailed: false,
            _manualHifiRetry: true,
          });
        }
      });
    }
  }, [currentSong, isHifiEnabled, player.isPlayingHiFi, showToast, albumCache, handleSongHifiResolved]);

  const handleToggleSearch = useCallback(() => {
    setShowSearch((prev) => {
      const next = !prev;
      if (next) {
        setMobilePane('center');
      } else if (centerMode === 'search' && searchResults.length === 0 && !isSearching) {
        setCenterMode('queue');
      }
      return next;
    });
  }, [centerMode, searchResults.length, isSearching]);

  const handleDismissWelcome = useCallback((persist = true) => {
    if (persist) {
      try {
        localStorage.setItem('mysongs-welcome-seen', 'true');
      } catch {}
    }
    setShowWelcome(false);
  }, []);

  const hasBlockingModal = Boolean(
    showWelcome ||
      showSettings ||
      nameModal ||
      confirmModal ||
      addToPlaylistTrack ||
      showImportModal ||
      showArtworkModal
  );

  const hasOpenModal = Boolean(hasBlockingModal || (videoModalTrack && !isVideoMinimized));

  useKeyboardShortcuts({
    hasSong: Boolean(isVideoDockActive ? videoModalTrack : currentSong),
    onTogglePlay: isVideoDockActive ? handleVideoDockTogglePlay : handleMainTogglePlay,
    onSeekBy: isVideoDockActive ? handleVideoDockSeekBy : player.seekBy,
    onPrev: handlePrev,
    onNext: advanceToNext,
    onToggleMute: player.toggleMute,
    onToggleSearch: handleToggleSearch,
    onToggleFullscreen: handleToggleVideoFullscreen,
    canToggleFullscreen: Boolean(!hasBlockingModal && videoModalTrack),
    hasOpenVideoPopup: Boolean(!hasBlockingModal && videoModalTrack && !isVideoMinimized),
    onEscape: () => {
      if (showWelcome) {
        handleDismissWelcome(true);
        return;
      }
      if (document.fullscreenElement || isVideoFullscreen) {
        exitVideoFullscreen();
        return;
      }
      if (videoModalTrack && !isVideoMinimized) {
        minimizeVideoPopup();
        return;
      }
      setShowSettings(false);
      setNameModal(null);
      setConfirmModal(null);
      setAddToPlaylistTrack(null);
      setShowArtworkModal(false);
      if (!isImportingPlaylist) setShowImportModal(false);
      if (showSearch) {
        setShowSearch(false);
        if (centerMode === 'search' && searchResults.length === 0 && !isSearching) {
          setCenterMode('queue');
        }
      }
    },
    hasOpenModal,
  });

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <img src="/app-icon.png" alt="NadaNada logo" className="brand-logo" />
          <span>NADANADA</span>
        </div>

        <div className="topbar-actions">
          <button
            type="button"
            className="topbar-btn"
            onClick={handleToggleTheme}
            aria-label="Switch Light or Dark theme"
          >
            {theme === 'light' ? <Sun size={14} /> : <Moon size={14} />}
            <span>{theme === 'light' ? 'Light' : 'Night'}</span>
          </button>

          <button type="button" className="topbar-btn" onClick={() => setShowSettings(true)}>
            <Settings size={14} />
            <span>Settings</span>
          </button>
        </div>
      </header>

      <nav className="mobile-nav" aria-label="Workspace sections">
        {[
          ['library', 'Library'],
          ['center', 'Queue'],
          ['metadata', 'Now Playing'],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="mobile-nav-btn"
            aria-selected={mobilePane === key}
            onClick={() => setMobilePane(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="workspace">
        <LibraryPane
          isMobileActive={mobilePane === 'library'}
          likedSongsCount={library.likedSongs.length}
          playlists={library.playlists}
          selectedPlaylistId={selectedPlaylistId}
          centerMode={centerMode}
          onOpenLiked={() => {
            setCenterMode('liked');
            setMobilePane('center');
          }}
          onOpenPlaylist={(plId) => {
            setSelectedPlaylistId(plId);
            setCenterMode('playlist');
            setMobilePane('center');
          }}
          onCreatePlaylist={(name) => {
            const created = library.createPlaylist(name);
            if (created) showToast(`Playlist "${created.name}" created`);
          }}
          onOpenImportModal={() => {
            setImportError(null);
            setShowImportModal(true);
          }}
          onRenamePlaylist={(pl) =>
            setNameModal({
              title: 'Rename Playlist',
              label: 'New playlist name',
              initialValue: pl.name,
              confirmLabel: 'Rename',
              onConfirm: (val) => {
                library.renamePlaylist(pl.id, val);
                setNameModal(null);
                showToast('Playlist renamed');
              },
            })
          }
          onDeletePlaylist={(pl) =>
            setConfirmModal({
              title: 'Delete Playlist',
              message: `Delete playlist "${pl.name}" and its ${pl.tracks.length} tracks?`,
              confirmLabel: 'Delete',
              onConfirm: () => {
                library.deletePlaylist(pl.id);
                if (activePlaylistSession?.playlistId === pl.id) {
                  setActivePlaylistSession(null);
                }
                if (centerMode === 'playlist' && selectedPlaylistId === pl.id) {
                  setCenterMode('queue');
                  setSelectedPlaylistId(null);
                }
                setConfirmModal(null);
                showToast(`Deleted "${pl.name}"`);
              },
            })
          }
          onQueuePlaylist={handleQueuePlaylist}
          trendingRegion={trendingRegion}
          onChangeTrendingRegion={handleChangeTrendingRegion}
          trendingTracks={trendingTracks}
          isTrendingLoading={isTrendingLoading}
          trendingError={trendingError}
          onRetryTrending={() => loadTrending(trendingRegion)}
          isTrendingCollapsed={isTrendingCollapsed}
          onToggleTrending={() => setIsTrendingCollapsed((c) => !c)}
          currentSongTitle={currentSong?.title}
          queueMatcher={queueMatcher}
          resolvingTrendingRank={resolvingTrendingRank}
          onPlayTrendingTrack={handlePlayTrendingTrack}
          onQueueTrendingTrack={handleQueueTrendingTrack}
        />

        <CenterPane
          isMobileActive={mobilePane === 'center'}
          showSearch={showSearch}
          onToggleSearch={handleToggleSearch}
          onCloseSearch={() => {
            setShowSearch(false);
            if (centerMode === 'search' && searchResults.length === 0 && !isSearching) {
              setCenterMode('queue');
            }
          }}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          searchTab={searchTab}
          onSearchTabChange={(tab) => {
            setSearchTab(tab);
            if (searchQuery.trim()) runSearch(searchQuery, tab);
          }}
          onSubmitSearch={(e) => {
            e.preventDefault();
            runSearch(searchQuery, searchTab);
          }}
          isSearching={isSearching}
          searchError={searchError}
          centerMode={centerMode}
          contextTitle={contextTitle}
          onBackToQueue={() => setCenterMode('queue')}
          tracks={visibleTracks}
          isAlbumLoading={isAlbumLoading}
          isEndlessPlay={isEndlessPlay}
          onToggleEndless={() =>
            setIsEndlessPlay((v) => {
              const next = !v;
              if (next) setIsShuffle(false);
              return next;
            })
          }
          onSaveAsPlaylist={() => {
            if (visibleTracks.length === 0) {
              showToast('Nothing in list to save');
              return;
            }
            setNameModal({
              title: 'Save as Playlist',
              label: `Save ${visibleTracks.length} tracks as`,
              initialValue: centerMode === 'album' ? activeAlbumTitle : 'My Mix',
              confirmLabel: 'Save Playlist',
              onConfirm: (name) => {
                const tracksOnly = visibleTracks.filter((t) => !t.is_playlist && t.item_type !== 'album');
                library.createPlaylist(name, tracksOnly);
                setNameModal(null);
                showToast(`Saved "${name}" (${tracksOnly.length} tracks)`);
              },
            });
          }}
          onDeleteAll={() =>
            setConfirmModal({
              title: 'Clear Tracklist',
              message:
                centerMode === 'liked'
                  ? 'Clear all Liked Songs?'
                  : centerMode === 'playlist'
                  ? `Remove all tracks from "${selectedPlaylist?.name || 'playlist'}"?`
                  : 'Reset and clear the entire Up Next queue?',
              confirmLabel: 'Delete All',
              onConfirm: () => {
                if (centerMode === 'liked') library.clearLikedSongs();
                else if (centerMode === 'playlist' && selectedPlaylistId) {
                  library.clearPlaylistTracks(selectedPlaylistId);
                  if (activePlaylistSession?.playlistId === selectedPlaylistId) {
                    setActivePlaylistSession(null);
                  }
                } else {
                  setActivePlaylistSession(null);
                  setQueue([]);
                  setCurrentIndex(-1);
                }
                setConfirmModal(null);
                showToast('Tracklist cleared');
              },
            })
          }
          currentSong={currentSong}
          player={player}
          isLiked={library.isLiked}
          onToggleLike={(track) => {
            const added = library.toggleLike(track);
            showToast(added ? 'Added to Liked Songs' : 'Removed from Liked Songs');
          }}
          onPlayTrack={handlePlayVisibleTrack}
          albumCache={albumCache}
          onOpenAlbum={handleOpenAlbum}
          onOpenArtist={(name) => {
            artistPage.openArtistPage(name);
            setMobilePane('metadata');
          }}
          onDownloadTrack={handleDownloadTrack}
          onAddToPlaylist={(track) => setAddToPlaylistTrack(track)}
          onQueueTrack={(track) => {
            const prepared = prepareTrackThroughGateSync(track, isHifiEnabled);
            let added = true;
            setQueue((prev) => {
              if (prev.some((s) => String(s.id) === String(prepared.id))) {
                added = false;
                return prev;
              }
              if (prev.length === 0) setCurrentIndex(0);
              return [...prev, prepared];
            });
            showToast(added ? `Added "${track.title}" to queue` : `Already in queue: ${track.title}`);
          }}
          queueMatcher={queueMatcher}
          onDeleteTrack={handleDeleteVisibleTrack}
          onReorderTracks={handleReorderVisibleTracks}
        />

        <MetadataPane
          isMobileActive={mobilePane === 'metadata'}
          currentSong={currentSong}
          nextSong={nextSong}
          queueMatcher={queueMatcher}
          isPlaying={player.isPlaying}
          isCrossfading={player.isCrossfading}
          albumInfo={albumInfo}
          visualizerMode={visualizerMode}
          onChangeVisualizerMode={setVisualizerMode}
          onOpenArtwork={() => setShowArtworkModal(true)}
          onTogglePlay={handleMainTogglePlay}
          isLiked={library.isLiked}
          onToggleLike={(track) => {
            const added = library.toggleLike(track);
            showToast(added ? 'Added to Liked Songs' : 'Removed from Liked Songs');
          }}
          lyricsData={lyrics.lyricsData}
          isFetchingLyrics={lyrics.isFetchingLyrics}
          lyricsError={lyrics.lyricsError}
          syncOffset={lyrics.syncOffset}
          onSyncChange={lyrics.setSyncOffset}
          onRetryLyrics={lyrics.handleRetry}
          currentTime={player.currentTime}
          onSeekTo={player.seekTo}
          selectedArtist={artistPage.selectedArtist}
          artistDetails={artistPage.artistDetails}
          isLoadingArtist={artistPage.isLoadingArtist}
          artistError={artistPage.artistError}
          isLoadingMoreSongs={artistPage.isLoadingMoreSongs}
          onOpenArtist={(name) => artistPage.openArtistPage(name)}
          onCloseArtist={artistPage.closeArtistPage}
          onRetryArtist={() => artistPage.openArtistPage(artistPage.selectedArtist)}
          onLoadMoreTopSongs={artistPage.loadMoreTopSongs}
          onPlayArtistSong={(songs, idx) => {
            const targetRaw = songs?.[idx];
            if (!targetRaw) return;
            player.unlockAudioDecks?.();
            closeVideoPopup();
            const prepared = prepareTrackThroughGateSync(
              {
                id: targetRaw.id,
                title: targetRaw.title,
                channel: targetRaw.artist || artistPage.selectedArtist,
                duration: targetRaw.duration || '',
                thumbnail: targetRaw.thumbnail,
                album: targetRaw.album || null,
                item_type: 'song',
              },
              isHifiEnabled
            );
            const existingIdx = queue.findIndex((s) => String(s.id) === String(prepared.id));
            if (existingIdx >= 0) {
              if (!isPlaylistPlayback && existingIdx === currentIndex && !player.isPlaying) {
                player.togglePlay();
              } else {
                setActivePlaylistSession(null);
                setCurrentIndex(existingIdx);
              }
            } else {
              setActivePlaylistSession(null);
              setQueue((prev) => {
                const nextIdx = currentIndex >= 0 ? currentIndex + 1 : prev.length;
                const copy = [...prev];
                copy.splice(nextIdx, 0, prepared);
                setCurrentIndex(nextIdx);
                return copy;
              });
            }
            setCenterMode('queue');
            showToast(`Playing: ${prepared.title}`);
          }}
          onPlayAllArtistTop={(songs) => {
            closeVideoPopup();
            setActivePlaylistSession(null);
            const prepared = songs.map((s) =>
              prepareTrackThroughGateSync(
                {
                  id: s.id,
                  title: s.title,
                  channel: s.artist || artistPage.selectedArtist,
                  duration: s.duration || '',
                  thumbnail: s.thumbnail,
                  album: s.album || null,
                  item_type: 'song',
                },
                isHifiEnabled
              )
            );
            setQueue(prepared);
            setCurrentIndex(0);
            setCenterMode('queue');
          }}
          onQueueAllArtistTop={(songs) => {
            const prepared = songs.map((s) =>
              prepareTrackThroughGateSync(
                {
                  id: s.id,
                  title: s.title,
                  channel: s.artist || artistPage.selectedArtist,
                  duration: s.duration || '',
                  thumbnail: s.thumbnail,
                  album: s.album || null,
                  item_type: 'song',
                },
                isHifiEnabled
              )
            );
            setQueue((prev) => {
              if (prev.length === 0) setCurrentIndex(0);
              return [...prev, ...prepared];
            });
            showToast(`Queued ${prepared.length} top songs`);
          }}
          onQueueArtistSong={(s) => {
            const prepared = prepareTrackThroughGateSync(
              {
                id: s.id,
                title: s.title,
                channel: s.artist || artistPage.selectedArtist,
                duration: s.duration || '',
                thumbnail: s.thumbnail,
                album: s.album || null,
                item_type: 'song',
              },
              isHifiEnabled
            );
            let added = true;
            setQueue((prev) => {
              if (prev.some((q) => String(q.id) === String(prepared.id))) {
                added = false;
                return prev;
              }
              if (prev.length === 0) setCurrentIndex(0);
              return [...prev, prepared];
            });
            showToast(added ? `Queued "${s.title}"` : `Already in queue: ${s.title}`);
          }}
          onOpenAlbum={(al) => {
            handleOpenAlbum(al);
            setMobilePane('center');
          }}
        />
      </main>

      <VideoPopupModal
        track={videoModalTrack}
        isMinimized={isVideoMinimized}
        isFullscreen={isVideoFullscreen}
        masterVolume={player.masterVolume}
        isMuted={player.isMuted}
        ytPlayerRef={videoYtRef}
        stageRef={videoStageRef}
        onPlayingChange={setVideoIsPlaying}
        onTimeUpdate={(t, d) => {
          if (!videoDraggingRef.current) setVideoCurrentTime(Number(t) || 0);
          if (d > 0) setVideoDuration(Number(d) || 0);
        }}
        onEnded={handleVideoEnded}
        onMinimize={minimizeVideoPopup}
        onExitFullscreen={exitVideoFullscreen}
        onClose={closeVideoPopup}
      />

      <MiniPlayerDock
        currentSong={isVideoDockActive ? videoModalTrack : currentSong}
        artistFact={
          isVideoDockActive
            ? `${(videoModalTrack?.channel || videoModalTrack?.artist || 'YouTube').replace(/\s*-\s*Topic$/i, '')} · Minimized video`
            : artistFact
        }
        isPlaying={isVideoDockActive ? videoIsPlaying : player.isPlaying}
        isShuffle={isShuffle}
        repeatMode={repeatMode}
        currentTime={isVideoDockActive ? videoCurrentTime : player.currentTime}
        duration={isVideoDockActive ? videoDuration : player.duration}
        masterVolume={player.masterVolume}
        isMuted={player.isMuted}
        isPlayingHiFi={isVideoDockActive ? false : player.isPlayingHiFi}
        isGatingHifi={isVideoDockActive ? false : player.isGatingHifi}
        isHifiEnabled={isHifiEnabled}
        isVideoDockActive={isVideoDockActive}
        onToggleShuffle={() =>
          setIsShuffle((s) => {
            const next = !s;
            if (next) setIsEndlessPlay(false);
            return next;
          })
        }
        onPrev={handlePrev}
        onTogglePlay={isVideoDockActive ? handleVideoDockTogglePlay : handleMainTogglePlay}
        onNext={advanceToNext}
        onCycleRepeat={() => setRepeatMode((m) => (m + 1) % 3)}
        onSeekStart={() => {
          if (isVideoDockActive) videoDraggingRef.current = true;
          else player.setDragging(true);
        }}
        onSeekPreview={(t) => {
          if (isVideoDockActive) setVideoCurrentTime(Number(t) || 0);
          else player.setPreviewTime(t);
        }}
        onSeekCommit={(t) => {
          if (isVideoDockActive) {
            videoDraggingRef.current = false;
            handleVideoDockSeek(t);
          } else {
            player.setDragging(false);
            player.seekTo(t);
          }
        }}
        onVolumeChange={player.handleVolumeChange}
        onToggleMute={player.toggleMute}
        onToggleTrackSource={handleToggleTrackSource}
        onRestoreVideo={restoreVideoPopup}
        onOpenArtist={(name) => {
          artistPage.openArtistPage(name);
          setMobilePane('metadata');
        }}
      />

      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        isHifiEnabled={isHifiEnabled}
        onToggleHifi={() => setIsHifiEnabled((v) => !v)}
        crossfadeDuration={crossfadeDuration}
        onChangeCrossfade={setCrossfadeDuration}
        onOpenWelcome={() => setShowWelcome(true)}
      />

      <WelcomeModal
        isOpen={showWelcome}
        onClose={handleDismissWelcome}
      />

      <NamePromptModal
        isOpen={Boolean(nameModal)}
        title={nameModal?.title || ''}
        label={nameModal?.label || ''}
        initialValue={nameModal?.initialValue || ''}
        confirmLabel={nameModal?.confirmLabel || 'Save'}
        onConfirm={(val) => nameModal?.onConfirm(val)}
        onClose={() => setNameModal(null)}
      />

      <ConfirmModal
        isOpen={Boolean(confirmModal)}
        title={confirmModal?.title || ''}
        message={confirmModal?.message || ''}
        confirmLabel={confirmModal?.confirmLabel || 'Confirm'}
        onConfirm={() => confirmModal?.onConfirm()}
        onClose={() => setConfirmModal(null)}
      />

      <AddToPlaylistModal
        isOpen={Boolean(addToPlaylistTrack)}
        track={addToPlaylistTrack}
        playlists={library.playlists}
        onAddToExisting={(plId) => {
          const ok = library.addTrackToPlaylist(plId, addToPlaylistTrack);
          setAddToPlaylistTrack(null);
          showToast(ok ? 'Added to playlist' : 'Already in playlist');
        }}
        onCreateAndAdd={(name) => {
          library.createPlaylist(name, [addToPlaylistTrack]);
          setAddToPlaylistTrack(null);
          showToast(`Created "${name}" with track`);
        }}
        onClose={() => setAddToPlaylistTrack(null)}
      />

      <ImportPlaylistModal
        isOpen={showImportModal}
        url={importUrl}
        onUrlChange={setImportUrl}
        isImporting={isImportingPlaylist}
        progress={importProgress}
        error={importError}
        onImport={handleImportPlaylist}
        onClose={() => !isImportingPlaylist && setShowImportModal(false)}
      />

      <ArtworkModal
        isOpen={showArtworkModal}
        song={currentSong}
        albumInfo={albumInfo}
        onClose={() => setShowArtworkModal(false)}
      />

      {toastMsg && (
        <div className="toast" role="status" aria-live="polite">
          {toastMsg}
        </div>
      )}
    </>
  );
}
