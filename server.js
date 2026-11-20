import dns from 'node:dns';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Avoid Node/undici IPv6 connect stalls on dual-stack ISPs
dns.setDefaultResultOrder('ipv4first');
import {
  searchYouTube,
  getYouTubeMix,
  getYouTubePlaylist,
  getSpotifyPlaylist,
  getPlaylistTitle,
  getKworbChart,
  getVideoAlbumInfo,
  getArtistDetails,
  getArtistTopSongs,
  extractYouTubeAudioUrl,
} from './server/youtube.js';
import { getLyrics } from './server/lyrics.js';
import {
  searchMonochrome,
  getMonochromeAlbum,
  resolveHifiTrack,
  handleHifiStream,
  ensureCachedFlac,
  serveFileWithRange,
} from './server/hifi.js';
import { CHROME_130_UA, fetchWithTimeout } from './server/http.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

function sanitizeFilenamePart(s = '') {
  return String(s).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

function buildDownloadFilename(artist = '', title = '', ext = 'flac') {
  const safeTitle = sanitizeFilenamePart(title) || 'Track';
  const safeArtist = sanitizeFilenamePart(artist);
  if (!safeArtist || /^(unknown|release)$/i.test(safeArtist)) {
    return `${safeTitle}.${ext}`;
  }
  return `${safeArtist} - ${safeTitle}.${ext}`;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'mysongs', node: process.version });
});

app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const type = String(req.query.type || 'song').trim();
    if (!q) return res.json([]);
    const results = await searchYouTube(q, type);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Search failed' });
  }
});

app.get('/api/mix', async (req, res) => {
  try {
    const videoId = String(req.query.videoId || '').trim();
    if (!videoId) return res.json([]);
    const results = await getYouTubeMix(videoId);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Mix fetch failed' });
  }
});

app.get('/api/playlist', async (req, res) => {
  try {
    const playlistId = String(req.query.playlistId || '').trim();
    const firstVideoId = String(req.query.firstVideoId || '').trim();
    if (!playlistId) return res.json([]);
    const results = await getYouTubePlaylist(playlistId, firstVideoId);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Playlist fetch failed' });
  }
});

app.get('/api/spotify-playlist', async (req, res) => {
  try {
    const playlistId = String(req.query.playlistId || '').trim();
    if (!playlistId) return res.json([]);
    const results = await getSpotifyPlaylist(playlistId);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Spotify playlist fetch failed' });
  }
});

app.get('/api/playlist-title', async (req, res) => {
  try {
    const platform = String(req.query.platform || 'youtube').trim();
    const playlistId = String(req.query.playlistId || '').trim();
    const title = await getPlaylistTitle(platform, playlistId);
    res.json({ title });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Playlist title fetch failed' });
  }
});

app.get('/api/trending', async (req, res) => {
  try {
    const region = String(req.query.region || 'id').trim();
    const tracks = await getKworbChart(region);
    res.json(tracks);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Trending chart fetch failed' });
  }
});

app.get('/api/album-info', async (req, res) => {
  try {
    const videoId = String(req.query.videoId || '').trim();
    const info = await getVideoAlbumInfo(videoId);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Album info fetch failed' });
  }
});

app.get('/api/artist', async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    const browseId = req.query.browseId ? String(req.query.browseId).trim() : null;
    if (!name && !browseId) return res.status(400).json({ error: 'Missing artist name' });
    const details = await getArtistDetails(name, browseId);
    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Artist fetch failed' });
  }
});

app.get('/api/artist-top-songs', async (req, res) => {
  try {
    const playlistId = String(req.query.playlistId || '').trim();
    const songs = await getArtistTopSongs(playlistId);
    res.json(songs);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Artist top songs fetch failed' });
  }
});

app.get('/api/lyrics', async (req, res) => {
  try {
    const title = String(req.query.title || '').trim();
    const artist = String(req.query.artist || '').trim();
    const duration = req.query.duration ? Number(req.query.duration) : null;
    const videoId = req.query.videoId ? String(req.query.videoId).trim() : null;
    const lyrics = await getLyrics(title, artist, duration, videoId);
    res.json(lyrics);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Lyrics fetch failed' });
  }
});

app.get('/api/monochrome/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const type = String(req.query.type || 'song').trim();
    const results = await searchMonochrome(q, type);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Monochrome search failed' });
  }
});

app.get('/api/monochrome/album', async (req, res) => {
  try {
    const releaseId = String(req.query.releaseId || '').trim();
    const results = await getMonochromeAlbum(releaseId);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Monochrome album fetch failed' });
  }
});

app.post('/api/hifi/resolve', async (req, res) => {
  try {
    const result = await resolveHifiTrack(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ matched: false, reason: err.message || 'Hi-Fi resolve failed' });
  }
});

app.get('/hifi/stream', handleHifiStream);
app.get('/hifi/:trackId', handleHifiStream);

app.get('/api/stream-url', async (req, res) => {
  try {
    const videoId = String(req.query.videoId || '').trim();
    const extracted = await extractYouTubeAudioUrl(videoId);
    res.json(extracted);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Stream extraction failed' });
  }
});

app.get('/api/download', async (req, res) => {
  const id = String(req.query.id || '').trim();
  const title = String(req.query.title || 'Track').trim();
  const artist = String(req.query.artist || '').trim();
  const hifiIdParam = String(req.query.hifiId || '').trim();
  const streamUrl = String(req.query.streamUrl || '').trim();

  let targetHifiId = hifiIdParam;
  if (!targetHifiId && streamUrl) {
    const m = streamUrl.match(/[?&]id=([^&]+)/) || streamUrl.match(/\/hifi\/([^/.?]+)/);
    if (m) targetHifiId = decodeURIComponent(m[1]);
  }

  if (targetHifiId) {
    try {
      const filePath = await ensureCachedFlac(targetHifiId, true);
      const filename = buildDownloadFilename(artist, title, 'flac');
      return serveFileWithRange(req, res, filePath, 'audio/flac', {
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      });
    } catch {
      // Fall through to YouTube audio download if Hi-Fi stream failed
    }
  }

  if (!id) return res.status(400).json({ error: 'Missing track id' });

  try {
    const { url, mimeType } = await extractYouTubeAudioUrl(id);
    const upstream = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': CHROME_130_UA } },
      120000
    );
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: `Upstream audio returned HTTP ${upstream.status}` });
    }
    const isWebm = String(mimeType).includes('webm');
    const ext = isWebm ? 'webm' : 'm4a';
    const filename = buildDownloadFilename(artist, title, ext);
    res.setHeader('Content-Type', isWebm ? 'audio/webm' : 'audio/mp4');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.writableEnded) res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Download failed' });
    }
  }
});

// Serve static Vite build in production (Altare / Node deploy)
const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/hifi/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
