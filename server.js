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
import { detectVisitorRegion } from './server/visitorGeo.js';
import {
  parseByteRangeHeader,
  computeYtAudioChunkRange,
  parseVideoMetadataForHifi,
} from './server/ytStreamUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

let isDraining = false;
let activeStreams = 0;

app.use((req, res, next) => {
  if (isDraining) {
    res.setHeader('Connection', 'close');
  }
  next();
});

function trackLongStream(handler) {
  return async (req, res, next) => {
    activeStreams += 1;
    let decremented = false;
    const done = () => {
      if (decremented) return;
      decremented = true;
      activeStreams = Math.max(0, activeStreams - 1);
      maybeFinishDrain();
    };
    res.on('close', done);
    res.on('finish', done);
    try {
      await handler(req, res, next);
    } catch (err) {
      done();
      next(err);
    }
  };
}

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
  if (isDraining) {
    return res.status(503).json({
      ok: false,
      draining: true,
      activeStreams,
      pid: process.pid,
    });
  }
  res.json({
    ok: true,
    draining: false,
    activeStreams,
    pid: process.pid,
    service: 'mysongs',
    node: process.version,
  });
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

app.get('/api/visitor-region', async (req, res) => {
  try {
    const info = await detectVisitorRegion(req);
    res.json(info);
  } catch (err) {
    res.status(200).json({ detected: false, region: null, countryCode: null, isExactMatch: false, source: 'error' });
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
    res.status(500).json({ matched: false, transient: true, reason: err.message || 'Hi-Fi resolve failed' });
  }
});

app.get('/hifi/stream', trackLongStream(handleHifiStream));
app.get('/hifi/:trackId', trackLongStream(handleHifiStream));

const ytAudioStreamCache = new Map();
const YT_AUDIO_CACHE_TTL_MS = 15 * 60 * 1000;

async function getCachedYouTubeAudioStream(videoId, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh) {
    const cached = ytAudioStreamCache.get(videoId);
    if (cached && now - cached.ts < YT_AUDIO_CACHE_TTL_MS) {
      return cached;
    }
  }
  const extracted = await extractYouTubeAudioUrl(videoId);
  const entry = {
    url: extracted.url,
    mimeType: extracted.mimeType || 'audio/mp4',
    userAgent: extracted.userAgent || CHROME_130_UA,
    contentLength: Number(extracted.contentLength) || 0,
    ts: now,
  };
  ytAudioStreamCache.set(videoId, entry);
  if (ytAudioStreamCache.size > 200) {
    const oldestKey = ytAudioStreamCache.keys().next().value;
    if (oldestKey) ytAudioStreamCache.delete(oldestKey);
  }
  return entry;
}

async function fetchBoundedYtAudioChunk(videoId, parsedRange, signal) {
  let streamInfo = await getCachedYouTubeAudioStream(videoId, false);
  let rangeSpec = computeYtAudioChunkRange(parsedRange, streamInfo.contentLength);
  if (rangeSpec.unsatisfiable) {
    return { unsatisfiable: true, total: rangeSpec.total };
  }

  let upstream = await fetchWithTimeout(
    streamInfo.url,
    { headers: { 'User-Agent': streamInfo.userAgent, Range: rangeSpec.header }, signal },
    45000
  );
  if (upstream.status === 403 || upstream.status === 404 || upstream.status === 410) {
    try { upstream.body?.cancel?.(); } catch {}
    ytAudioStreamCache.delete(videoId);
    streamInfo = await getCachedYouTubeAudioStream(videoId, true);
    rangeSpec = computeYtAudioChunkRange(parsedRange, streamInfo.contentLength);
    if (rangeSpec.unsatisfiable) {
      return { unsatisfiable: true, total: rangeSpec.total };
    }
    upstream = await fetchWithTimeout(
      streamInfo.url,
      { headers: { 'User-Agent': streamInfo.userAgent, Range: rangeSpec.header }, signal },
      45000
    );
  }

  const contentRange = upstream.headers.get('content-range');
  if (contentRange) {
    const slashMatch = contentRange.match(/\/(\d+)\s*$/);
    const total = slashMatch ? Number(slashMatch[1]) : 0;
    if (total > 0 && !streamInfo.contentLength) {
      streamInfo.contentLength = total;
    }
  }

  return { upstream, streamInfo, rangeSpec, contentRange };
}

async function pipeReadableToResponse(body, res, isAborted) {
  const reader = body.getReader();
  while (!isAborted() && !res.writableEnded) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0 && !isAborted() && !res.writableEnded) {
      const canContinue = res.write(Buffer.from(value));
      if (!canContinue) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  }
}

async function streamFullYtAudioChunks(videoId, res, { isAborted, signal, onFirstChunk }) {
  let offset = 0;
  let totalSize = 0;
  let started = false;

  while (!isAborted() && !res.writableEnded) {
    const result = await fetchBoundedYtAudioChunk(videoId, { start: offset, end: null }, signal);
    if (result.unsatisfiable) break;
    const { upstream, streamInfo, contentRange } = result;
    if (!upstream.ok || !upstream.body) {
      if (!started) {
        return { errorStatus: upstream.status };
      }
      break;
    }

    if (contentRange) {
      const m = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
      if (m && m[3] !== '*') totalSize = Number(m[3]) || totalSize;
    }
    if (!totalSize && streamInfo.contentLength > 0) {
      totalSize = streamInfo.contentLength;
    }

    if (!started) {
      started = true;
      const rawMime = String(upstream.headers.get('content-type') || streamInfo.mimeType || 'audio/mp4');
      onFirstChunk?.({ rawMime, totalSize });
    }

    const chunkBytes = Number(upstream.headers.get('content-length')) || 0;
    await pipeReadableToResponse(upstream.body, res, isAborted);

    if (chunkBytes <= 0) break;
    offset += chunkBytes;
    if (totalSize > 0 && offset >= totalSize) break;
  }

  if (!res.writableEnded) res.end();
  return { ok: true };
}

app.get('/api/stream-url', async (req, res) => {
  try {
    const videoId = String(req.query.videoId || '').trim();
    const extracted = await getCachedYouTubeAudioStream(videoId);
    res.json({ url: extracted.url, mimeType: extracted.mimeType });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Stream extraction failed' });
  }
});

const ytVideoMetaCache = new Map();
const ytVideoHifiCache = new Map();
const ytVideoHifiInflight = new Map();
const YT_VIDEO_HIFI_HIT_TTL_MS = 30 * 60 * 1000;
const YT_VIDEO_HIFI_MISS_TTL_MS = 5 * 60 * 1000;

function storeVideoMetaHint(videoId, hints = {}) {
  if (!videoId || !hints || typeof hints !== 'object') return;
  const prev = ytVideoMetaCache.get(videoId) || {};
  const next = {
    title: hints.title ? String(hints.title).trim() : prev.title || '',
    channel: hints.channel ? String(hints.channel).trim() : prev.channel || '',
    duration: hints.duration ? String(hints.duration).trim() : prev.duration || '',
    album: hints.album ? String(hints.album).trim() : prev.album || '',
  };
  ytVideoMetaCache.set(videoId, next);
  if (ytVideoMetaCache.size > 1000) {
    ytVideoMetaCache.delete(ytVideoMetaCache.keys().next().value);
  }
}

async function fetchYouTubeOembedMeta(videoId) {
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
      { headers: { 'User-Agent': CHROME_130_UA, Accept: 'application/json' } },
      4500
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
      title: String(data?.title || '').trim(),
      channel: String(data?.author_name || '').trim(),
    };
  } catch {
    return null;
  }
}

async function resolveVideoHifiFallback(videoId) {
  if (!videoId) return null;
  const cached = ytVideoHifiCache.get(videoId);
  if (cached) {
    const ttl = cached.hifiId ? YT_VIDEO_HIFI_HIT_TTL_MS : YT_VIDEO_HIFI_MISS_TTL_MS;
    if (Date.now() - cached.ts < ttl) {
      return cached.hifiId;
    }
  }
  if (ytVideoHifiInflight.has(videoId)) {
    return ytVideoHifiInflight.get(videoId);
  }

  const job = (async () => {
    try {
      let hints = ytVideoMetaCache.get(videoId) || {};
      if (!hints.title) {
        const oembed = await fetchYouTubeOembedMeta(videoId);
        if (oembed?.title) {
          storeVideoMetaHint(videoId, oembed);
          hints = ytVideoMetaCache.get(videoId) || oembed;
        }
      }
      const parsed = parseVideoMetadataForHifi(hints.title || '', hints.channel || '');
      if (!parsed.title) return null;
      const albumRaw = String(hints.album || '').trim();
      const validAlbum =
        albumRaw && albumRaw.toLowerCase() !== parsed.channel.toLowerCase() ? albumRaw : null;

      const resolved = await resolveHifiTrack({
        songId: `vidhifi:${videoId}`,
        title: parsed.title,
        channel: parsed.channel,
        duration: hints.duration || null,
        album: validAlbum,
        itemType: 'song',
        mode: 'play',
      });
      const hifiId = resolved?.matched && resolved?.hifi_id ? String(resolved.hifi_id) : null;
      ytVideoHifiCache.set(videoId, { hifiId, ts: Date.now() });
      if (ytVideoHifiCache.size > 500) {
        ytVideoHifiCache.delete(ytVideoHifiCache.keys().next().value);
      }
      return hifiId;
    } catch {
      return null;
    } finally {
      ytVideoHifiInflight.delete(videoId);
    }
  })();

  ytVideoHifiInflight.set(videoId, job);
  return job;
}

app.post('/api/audio-stream/prepare', async (req, res) => {
  const videoId = String(req.body?.videoId || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId' });
  }
  const skipHifi = Boolean(req.body?.skipHifi);
  if (skipHifi) {
    try {
      await getCachedYouTubeAudioStream(videoId);
    } catch {}
    return res.json({ ready: true, mode: 'yt', hifi_id: null });
  }
  storeVideoMetaHint(videoId, {
    title: req.body?.title,
    channel: req.body?.channel,
    duration: req.body?.duration,
    album: req.body?.album,
  });
  const hifiId = await resolveVideoHifiFallback(videoId);
  res.json({ ready: true, mode: hifiId ? 'hifi' : 'yt', hifi_id: hifiId || null });
});

app.get('/api/audio-stream', trackLongStream(async (req, res) => {
  const videoId = String(req.query.videoId || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId' });
  }
  const skipHifi = req.query.skipHifi === '1' || req.query.skipHifi === 'true';

  if (!skipHifi) {
    // Prefer full lossless Hi-Fi audio matching for music videos so multi-range <audio> playback
    // in background/minimized tabs never hits YouTube's >1 MiB unauthenticated 403 cutoff.
    const hifiId = await resolveVideoHifiFallback(videoId);
    if (hifiId) {
      req.query.id = hifiId;
      req.params.trackId = hifiId;
      return handleHifiStream(req, res);
    }
  }

  const parsedRange = parseByteRangeHeader(req.headers.range ? String(req.headers.range) : null);
  const controller = new AbortController();
  let clientClosed = false;
  req.on('close', () => {
    clientClosed = true;
    controller.abort();
  });

  try {
    if (!parsedRange) {
      const outcome = await streamFullYtAudioChunks(videoId, res, {
        isAborted: () => clientClosed,
        signal: controller.signal,
        onFirstChunk: ({ rawMime, totalSize }) => {
          res.status(200);
          res.setHeader('Content-Type', rawMime.includes('webm') ? 'audio/webm' : 'audio/mp4');
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Cache-Control', 'no-store');
          if (totalSize > 0) res.setHeader('Content-Length', String(totalSize));
        },
      });
      if (outcome?.errorStatus && !res.headersSent) {
        return res.status(502).json({ error: `Upstream audio returned HTTP ${outcome.errorStatus}` });
      }
      return undefined;
    }

    const result = await fetchBoundedYtAudioChunk(videoId, parsedRange, controller.signal);
    if (clientClosed || res.writableEnded) return undefined;
    if (result.unsatisfiable) {
      if (result.total > 0) res.setHeader('Content-Range', `bytes */${result.total}`);
      return res.status(416).end();
    }

    const { upstream, streamInfo, contentRange } = result;
    if (!upstream.ok || !upstream.body) {
      return res.status(upstream.status === 416 ? 416 : 502).json({
        error: `Upstream audio returned HTTP ${upstream.status}`,
      });
    }

    const rawMime = String(upstream.headers.get('content-type') || streamInfo.mimeType || 'audio/mp4');
    res.status(upstream.status === 206 ? 206 : 200);
    res.setHeader('Content-Type', rawMime.includes('webm') ? 'audio/webm' : 'audio/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    if (contentRange) res.setHeader('Content-Range', contentRange);

    await pipeReadableToResponse(upstream.body, res, () => clientClosed);
    if (!res.writableEnded) res.end();
  } catch (err) {
    if (clientClosed || err?.name === 'AbortError') return undefined;
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Audio stream proxy failed' });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}));

app.get('/api/download', trackLongStream(async (req, res) => {
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

  const controller = new AbortController();
  let clientClosed = false;
  req.on('close', () => {
    clientClosed = true;
    controller.abort();
  });

  try {
    const outcome = await streamFullYtAudioChunks(id, res, {
      isAborted: () => clientClosed,
      signal: controller.signal,
      onFirstChunk: ({ rawMime, totalSize }) => {
        const isWebm = String(rawMime).includes('webm');
        const ext = isWebm ? 'webm' : 'm4a';
        const filename = buildDownloadFilename(artist, title, ext);
        res.setHeader('Content-Type', isWebm ? 'audio/webm' : 'audio/mp4');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        if (totalSize > 0) res.setHeader('Content-Length', String(totalSize));
      },
    });
    if (outcome?.errorStatus && !res.headersSent) {
      return res.status(502).json({ error: `Upstream audio returned HTTP ${outcome.errorStatus}` });
    }
  } catch (err) {
    if (clientClosed || err?.name === 'AbortError') return;
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Download failed' });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}));

// Serve static Vite build in production (Altare / Node deploy)
const distDir = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
  app.use(
    express.static(distDir, {
      setHeaders(res, filePath) {
        if (filePath.endsWith(`${path.sep}index.html`) || filePath.endsWith('/index.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`) || filePath.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/hifi/')) return next();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

let drainForceTimer = null;

function maybeFinishDrain() {
  if (!isDraining) return;
  if (activeStreams === 0) {
    if (drainForceTimer) clearTimeout(drainForceTimer);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 250).unref();
  }
}

function beginGracefulDrain(signal) {
  if (isDraining) return;
  isDraining = true;
  console.log(`[drain] Received ${signal}; draining ${activeStreams} active stream(s)...`);
  httpServer.close(() => {
    if (activeStreams === 0) process.exit(0);
  });

  if (activeStreams === 0) {
    setTimeout(() => process.exit(0), 150).unref();
    return;
  }

  const maxWaitMs = Math.max(5000, parseInt(process.env.DRAIN_TIMEOUT_MS || '90000', 10) || 90000);
  drainForceTimer = setTimeout(() => {
    console.log(`[drain] Grace timeout elapsed with ${activeStreams} stream(s); exiting cleanly.`);
    process.exit(0);
  }, maxWaitMs);
  drainForceTimer.unref();
}

process.on('SIGTERM', () => beginGracefulDrain('SIGTERM'));
process.on('SIGINT', () => beginGracefulDrain('SIGINT'));
process.on('message', (msg) => {
  if (msg && msg.type === 'drain') {
    beginGracefulDrain('IPC');
  }
});
