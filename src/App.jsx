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
import { useArtistFact } from './hooks/useArtistFact';
import { useWebPlayer } from './hooks/useWebPlayer';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { isAlbumArtTrack } from './components/SpinningVinyl';
import LibraryPane from './components/LibraryPane';
import CenterPane from './components/CenterPane';
import MetadataPane from './components/MetadataPane';
import MiniPlayerDock from './components/MiniPlayerDock';
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

export default function App() {
  // Theme & Settings (strictly Light/Dark + HiFi + Crossfade)
  const [theme, setTheme] = useState(() => localStorage.getItem('mysongs-theme') || 'light');
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
  const [isFullscreen, setIsFullscreen] = useState(false);

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

  // Trending state (Left sidebar)
  const [trendingRegion, setTrendingRegion] = useState('id');
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
  const trendingReqIdRef = useRef(0);

  const showToast = useCallback((msg) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(''), 2600);
  }, []);

  // Persist theme & preferences
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('mysongs-theme', theme);
  }, [theme]);

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

  const currentSong =
    currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : null;

  const upcomingIndex = useMemo(() => {
    if (queue.length <= 1 || currentIndex < 0) return -1;
    if (isShuffle) {
      let rand = Math.floor(Math.random() * queue.length);
      if (rand === currentIndex) rand = (currentIndex + 1) % queue.length;
      return rand;
    }
    return currentIndex + 1 < queue.length ? currentIndex + 1 : -1;
  }, [queue.length, currentIndex, isShuffle]);

  const nextSong = upcomingIndex >= 0 ? queue[upcomingIndex] : null;

  const advanceToNext = useCallback(() => {
    if (queue.length === 0) return;
    if (upcomingIndex >= 0) {
      setCurrentIndex(upcomingIndex);
    }
  }, [queue.length, upcomingIndex]);

  const handleSongHifiResolved = useCallback((resolvedSong) => {
    setQueue((prev) =>
      prev.map((s) => (s.id === resolvedSong.id ? { ...s, ...resolvedSong } : s))
    );
  }, []);

  const handleSongHifiFailed = useCallback((failedSong) => {
    setQueue((prev) =>
      prev.map((s) =>
        s.id === failedSong.id ? { ...s, stream_url: null, source: null, _hifiFailed: true } : s
      )
    );
  }, []);

  const player = useWebPlayer({
    currentSong,
    nextSong,
    hasNext: upcomingIndex >= 0,
    isHifiEnabled,
    crossfadeDuration,
    repeatMode,
    onNext: advanceToNext,
    onSongHifiResolved: handleSongHifiResolved,
    onSongHifiFailed: handleSongHifiFailed,
  });

  const { albumInfo } = useAlbumInfo(queue, currentIndex);
  const artistFact = useArtistFact(currentSong, albumInfo);
  const lyrics = useLyrics(currentSong);
  const artistPage = useArtistPage();

  // Determine video split state (videos render 50/50 top/bottom in Center)
  const isVideoMode = useMemo(() => {
    if (!currentSong) return false;
    if (player.activeMode === 'audio') return false;
    return !isAlbumArtTrack(currentSong) || currentSong.item_type === 'video';
  }, [currentSong, player.activeMode]);

  // Prefetch next track's Hi-Fi FLAC stream AND warm server cache early so crossfade never pauses
  useEffect(() => {
    if (!isHifiEnabled || !nextSong || !isHifiEligibleTrack(nextSong) || nextSong._userForcedYoutube) {
      return;
    }
    const controller = new AbortController();
    const warmStream = (url) => {
      if (!url) return;
      fetch(url, { headers: { Range: 'bytes=0-1023' }, signal: controller.signal }).catch(() => {});
    };

    const t = setTimeout(() => {
      if (nextSong.stream_url) {
        warmStream(nextSong.stream_url);
      } else {
        resolveHifiForTrack(nextSong).then((res) => {
          if (res?.stream_url && !controller.signal.aborted) {
            handleSongHifiResolved({ ...nextSong, ...res });
            warmStream(res.stream_url);
          }
        });
      }
    }, 1200);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [nextSong?.id, nextSong?.stream_url, isHifiEnabled]);

  // Endless Play auto-append when reaching last 2 songs
  useEffect(() => {
    if (!isEndlessPlay || isShuffle || queue.length === 0 || currentIndex < 0) return;
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
          const candidate = mix.find((m) => m?.id && !existingIds.has(String(m.id)));
          if (!candidate) return prev;
          return [...prev, prepareTrackThroughGateSync({ ...candidate, isEndlessGenerated: true }, isHifiEnabled)];
        });
      })
      .catch(() => {})
      .finally(() => {
        endlessFetchingRef.current = false;
      });
  }, [isEndlessPlay, isShuffle, queue.length, currentIndex, isHifiEnabled]);

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
    const picked = results?.[0];
    if (!picked) throw new Error(`Could not find stream for ${entry.title}`);
    return prepareTrackThroughGateSync(
      { ...picked, item_type: picked.item_type || 'song' },
      isHifiEnabled
    );
  }, [isHifiEnabled]);

  const handlePlayTrendingTrack = useCallback(async (entry) => {
    if (resolvingTrendingRank) return;
    setResolvingTrendingRank(entry.rank);
    try {
      const resolved = await resolveTrendingEntry(entry);
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
  }, [resolvingTrendingRank, resolveTrendingEntry, queue, currentIndex, showToast]);

  const handleQueueTrendingTrack = useCallback(async (entry) => {
    if (resolvingTrendingRank) return;
    setResolvingTrendingRank(entry.rank);
    try {
      const resolved = await resolveTrendingEntry(entry);
      setQueue((prev) => {
        if (prev.length === 0) setCurrentIndex(0);
        return [...prev, resolved];
      });
      showToast(`Queued: ${resolved.title}`);
    } catch (err) {
      showToast(err?.message || 'Failed to queue track');
    } finally {
      setResolvingTrendingRank(null);
    }
  }, [resolvingTrendingRank, resolveTrendingEntry, showToast]);

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
    if (centerMode === 'queue') {
      if (idx === currentIndex) player.togglePlay();
      else setCurrentIndex(idx);
      return;
    }

    if (centerMode === 'liked' || centerMode === 'playlist' || centerMode === 'album') {
      const preparedList = visibleTracks.map((t) => prepareTrackThroughGateSync(t, isHifiEnabled));
      setQueue(preparedList);
      setCurrentIndex(idx);
      return;
    }

    // Search result click: insert after current track or append & play
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
  }, [centerMode, currentIndex, visibleTracks, isHifiEnabled, player]);

  const handleDeleteVisibleTrack = useCallback((track, idx) => {
    if (centerMode === 'liked') {
      library.removeFromLiked(track.id);
      return;
    }
    if (centerMode === 'playlist' && selectedPlaylistId) {
      library.removeTrackFromPlaylist(selectedPlaylistId, track.id);
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

  const handlePrev = useCallback(() => {
    if (player.currentTime > 4) {
      player.seekTo(0);
      return;
    }
    if (queue.length === 0) return;
    setCurrentIndex((idx) => (idx > 0 ? idx - 1 : queue.length - 1));
  }, [player, queue.length]);

  const handleToggleTrackSource = useCallback(() => {
    if (!currentSong) return;
    if (!isHifiEnabled) {
      showToast('Enable Hi-Fi Audio in Settings first');
      return;
    }
    const nextForceYt = !currentSong._userForcedYoutube && player.isPlayingHiFi;
    setUserYoutubeForced(currentSong.id, nextForceYt);
    setQueue((prev) =>
      prev.map((s) =>
        s.id === currentSong.id
          ? {
              ...s,
              _userForcedYoutube: nextForceYt,
              _hifiFailed: false,
            }
          : s
      )
    );
    showToast(nextForceYt ? 'Switched track to YouTube' : 'Retrying Hi-Fi FLAC stream...');
  }, [currentSong, isHifiEnabled, player.isPlayingHiFi, showToast]);

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

  const hasOpenModal = Boolean(
    showWelcome ||
      showSettings ||
      nameModal ||
      confirmModal ||
      addToPlaylistTrack ||
      showImportModal ||
      showArtworkModal
  );

  useKeyboardShortcuts({
    hasSong: Boolean(currentSong),
    onTogglePlay: player.togglePlay,
    onSeekBy: player.seekBy,
    onPrev: handlePrev,
    onNext: advanceToNext,
    onToggleMute: player.toggleMute,
    onToggleSearch: handleToggleSearch,
    onToggleFullscreen: () => {
      if (isVideoMode || isFullscreen) {
        setIsFullscreen((f) => !f);
      }
    },
    onEscape: () => {
      if (showWelcome) {
        handleDismissWelcome(true);
        return;
      }
      if (isFullscreen) setIsFullscreen(false);
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
            onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
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
                if (centerMode === 'playlist' && selectedPlaylistId === pl.id) {
                  setCenterMode('queue');
                  setSelectedPlaylistId(null);
                }
                setConfirmModal(null);
                showToast(`Deleted "${pl.name}"`);
              },
            })
          }
          trendingRegion={trendingRegion}
          onChangeTrendingRegion={setTrendingRegion}
          trendingTracks={trendingTracks}
          isTrendingLoading={isTrendingLoading}
          trendingError={trendingError}
          onRetryTrending={() => loadTrending(trendingRegion)}
          isTrendingCollapsed={isTrendingCollapsed}
          onToggleTrending={() => setIsTrendingCollapsed((c) => !c)}
          currentSongTitle={currentSong?.title}
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
                } else {
                  setQueue([]);
                  setCurrentIndex(-1);
                }
                setConfirmModal(null);
                showToast('Tracklist cleared');
              },
            })
          }
          currentSong={currentSong}
          nextSong={nextSong}
          player={player}
          visualizerMode={visualizerMode}
          isVideoMode={isVideoMode}
          isFullscreen={isFullscreen}
          onToggleFullscreen={() => setIsFullscreen((f) => !f)}
          isLiked={library.isLiked}
          onToggleLike={(track) => {
            const added = library.toggleLike(track);
            showToast(added ? 'Added to Liked Songs' : 'Removed from Liked Songs');
          }}
          onPlayTrack={handlePlayVisibleTrack}
          onOpenAlbum={handleOpenAlbum}
          onOpenArtist={(name) => {
            artistPage.openArtistPage(name);
            setMobilePane('metadata');
          }}
          onDownloadTrack={handleDownloadTrack}
          onAddToPlaylist={(track) => setAddToPlaylistTrack(track)}
          onQueueTrack={(track) => {
            const prepared = prepareTrackThroughGateSync(track, isHifiEnabled);
            setQueue((prev) => {
              if (prev.length === 0) setCurrentIndex(0);
              return [...prev, prepared];
            });
            showToast(`Added "${track.title}" to queue`);
          }}
          onDeleteTrack={handleDeleteVisibleTrack}
        />

        <MetadataPane
          isMobileActive={mobilePane === 'metadata'}
          currentSong={currentSong}
          nextSong={nextSong}
          isPlaying={player.isPlaying}
          isCrossfading={player.isCrossfading}
          albumInfo={albumInfo}
          visualizerMode={visualizerMode}
          onChangeVisualizerMode={setVisualizerMode}
          onOpenArtwork={() => setShowArtworkModal(true)}
          onTogglePlay={player.togglePlay}
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
            setCurrentIndex(idx);
            setCenterMode('queue');
          }}
          onPlayAllArtistTop={(songs) => {
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
            setQueue((prev) => {
              if (prev.length === 0) setCurrentIndex(0);
              return [...prev, prepared];
            });
            showToast(`Queued "${s.title}"`);
          }}
          onDownloadSong={handleDownloadTrack}
          onOpenAlbum={(al) => {
            handleOpenAlbum(al);
            setMobilePane('center');
          }}
        />
      </main>

      <MiniPlayerDock
        currentSong={currentSong}
        artistFact={artistFact}
        isPlaying={player.isPlaying}
        isShuffle={isShuffle}
        repeatMode={repeatMode}
        currentTime={player.currentTime}
        duration={player.duration}
        masterVolume={player.masterVolume}
        isMuted={player.isMuted}
        isPlayingHiFi={player.isPlayingHiFi}
        isHifiEnabled={isHifiEnabled}
        isVideoMode={isVideoMode}
        isFullscreen={isFullscreen}
        onToggleShuffle={() =>
          setIsShuffle((s) => {
            const next = !s;
            if (next) setIsEndlessPlay(false);
            return next;
          })
        }
        onPrev={handlePrev}
        onTogglePlay={player.togglePlay}
        onNext={advanceToNext}
        onCycleRepeat={() => setRepeatMode((m) => (m + 1) % 3)}
        onSeekStart={() => player.setDragging(true)}
        onSeekPreview={player.setPreviewTime}
        onSeekCommit={(t) => {
          player.setDragging(false);
          player.seekTo(t);
        }}
        onVolumeChange={player.handleVolumeChange}
        onToggleMute={player.toggleMute}
        onToggleTrackSource={handleToggleTrackSource}
        onToggleFullscreen={() => currentSong && setIsFullscreen((f) => !f)}
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
