async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  searchYouTube: (query, searchType = 'song') =>
    fetchJson(`/api/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(searchType || 'song')}`),

  getYouTubeMix: (videoId) =>
    fetchJson(`/api/mix?videoId=${encodeURIComponent(videoId)}`),

  getYouTubePlaylist: (playlistId, firstVideoId = '') =>
    fetchJson(
      `/api/playlist?playlistId=${encodeURIComponent(playlistId)}&firstVideoId=${encodeURIComponent(firstVideoId || '')}`
    ),

  getSpotifyPlaylist: (playlistId) =>
    fetchJson(`/api/spotify-playlist?playlistId=${encodeURIComponent(playlistId)}`),

  getPlaylistTitle: async (platform, playlistId) => {
    const res = await fetchJson(
      `/api/playlist-title?platform=${encodeURIComponent(platform)}&playlistId=${encodeURIComponent(playlistId)}`
    );
    return res.title;
  },

  getKworbChart: (region = 'id') =>
    fetchJson(`/api/trending?region=${encodeURIComponent(region)}`),

  getVisitorRegion: () => fetchJson('/api/visitor-region'),

  getVideoAlbumInfo: (videoId) =>
    fetchJson(`/api/album-info?videoId=${encodeURIComponent(videoId)}`),

  getArtistDetails: (artistName, artistBrowseId = null) => {
    let url = `/api/artist?name=${encodeURIComponent(artistName || '')}`;
    if (artistBrowseId) url += `&browseId=${encodeURIComponent(artistBrowseId)}`;
    return fetchJson(url);
  },

  getArtistTopSongs: (playlistId) =>
    fetchJson(`/api/artist-top-songs?playlistId=${encodeURIComponent(playlistId)}`),

  getLyrics: (title, artist = '', duration = null, videoId = null) => {
    const params = new URLSearchParams({
      title: title || '',
      artist: artist || '',
    });
    if (duration) params.set('duration', String(duration));
    if (videoId) params.set('videoId', String(videoId));
    return fetchJson(`/api/lyrics?${params.toString()}`);
  },

  searchMonochrome: (query, searchType = 'song') =>
    fetchJson(`/api/monochrome/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(searchType)}`),

  getMonochromeAlbum: (releaseId) =>
    fetchJson(`/api/monochrome/album?releaseId=${encodeURIComponent(releaseId)}`),

  resolveHifiTrack: ({
    songId = null,
    title = '',
    channel = null,
    duration = null,
    itemType = null,
    isrc = null,
    album = null,
    mode = 'play',
    forceRefresh = false,
  }) =>
    fetchJson('/api/hifi/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        songId: songId ? String(songId) : null,
        title: title || '',
        channel: channel || null,
        duration: duration ? String(duration) : null,
        itemType: itemType || null,
        isrc: isrc || null,
        album: album || null,
        mode: mode === 'probe' ? 'probe' : 'play',
        forceRefresh: Boolean(forceRefresh),
      }),
    }),

  getStreamUrl: (videoId) =>
    fetchJson(`/api/stream-url?videoId=${encodeURIComponent(videoId)}`),

  triggerBrowserDownload: ({ id, title, artist, hifiId, streamUrl }) => {
    const params = new URLSearchParams({
      id: id || '',
      title: title || 'Track',
      artist: artist || '',
    });
    if (hifiId) params.set('hifiId', hifiId);
    if (streamUrl) params.set('streamUrl', streamUrl);

    const a = document.createElement('a');
    a.href = `/api/download?${params.toString()}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
};
