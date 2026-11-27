import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { YTM_UA, YT_HTML_UA, YTM_CONTEXT, fetchWithTimeout, decodeHtmlEntities } from './http.js';
import { detachString, createConcurrencyLimiter } from './runtimeLimits.js';

const htmlScrapeLimiter = createConcurrencyLimiter(
  Math.max(2, parseInt(process.env.MAX_CONCURRENT_HTML_SCRAPES || '6', 10) || 6)
);

const execFileAsync = promisify(execFile);

const VIDEO_MARKERS = [
  'official music video',
  'official video',
  'music video',
  'lyric video',
  'visualizer',
  '[mv]',
  '(mv)',
];

const BAD_KARAOKE_PHRASES = [
  'karaoke',
  'off vocal',
  'backing track',
  'no vocal',
  'vocal removed',
  'instrumental',
  'synthesia',
  'piano cover',
  'guitar cover',
  'drum cover',
  'violin cover',
  'sax cover',
  'ukulele cover',
  'slowed',
  'reverb',
  'sped up',
  'nightcore',
  '8d audio',
  'koplo',
  'remix',
  'bootleg',
  'mashup',
  'lyric video',
  'lyrics video',
  '歌ってみた',
  'カラオケ',
];

const STOPWORDS = new Set([
  'no', 'oh', 'to', 'in', 'on', 'at', 'of', 'me', 'my', 'is',
  'it', 'de', 'na', 'ga', 'ni', 'wa', 'ha', 'a', 'an', 'the',
]);

const SEARCH_PARAMS = {
  album: 'EgWKAQIYAWoOEAQQAxAFEAkQEBAKEBU%3D',
  video: 'EgWKAQIQAWoOEAQQAxAFEAkQEBAKEBU%3D',
  song: 'EgWKAQIIAWoOEAQQAxAFEAkQEBAKEBU%3D',
};

const YTM_HEADERS = {
  'User-Agent': YTM_UA,
  Referer: 'https://music.youtube.com/',
  Origin: 'https://music.youtube.com',
  'Content-Type': 'application/json',
};

const YT_HTML_HEADERS = {
  'User-Agent': YT_HTML_UA,
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+478',
};

function ytmPost(endpoint, payload, timeoutMs = 15000) {
  return fetchWithTimeout(
    `https://music.youtube.com/youtubei/v1/${endpoint}`,
    {
      method: 'POST',
      headers: YTM_HEADERS,
      body: JSON.stringify({ context: YTM_CONTEXT, ...payload }),
    },
    timeoutMs
  ).then(async (res) => {
    if (!res.ok) throw new Error(`YTM ${endpoint} HTTP ${res.status}`);
    return res.json();
  });
}

function extractBalancedJsonWithEnd(html, startIdx) {
  if (startIdx < 0 || startIdx >= html.length) return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = startIdx; i < html.length; i++) {
    const ch = html[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return { value: JSON.parse(html.slice(startIdx, i + 1)), endIdx: i };
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

function extractBalancedJson(html, markerRegex) {
  const match = markerRegex.exec(html);
  if (!match) return null;
  const startIdx = html.indexOf('{', match.index);
  if (startIdx === -1) return null;
  const parsed = extractBalancedJsonWithEnd(html, startIdx);
  return parsed ? parsed.value : null;
}

function extractAllBalancedJson(html, markerRegex, maxMatches = 8) {
  const results = [];
  if (!html || !markerRegex) return results;
  const flags = markerRegex.flags.includes('g') ? markerRegex.flags : `${markerRegex.flags}g`;
  const re = new RegExp(markerRegex.source, flags);
  let match;
  while (results.length < maxMatches && (match = re.exec(html)) !== null) {
    const startIdx = html.indexOf('{', match.index);
    if (startIdx === -1) break;
    const parsed = extractBalancedJsonWithEnd(html, startIdx);
    if (parsed) {
      results.push(parsed.value);
      re.lastIndex = Math.max(match.index + 1, parsed.endIdx + 1);
    } else {
      re.lastIndex = Math.max(match.index + 1, startIdx + 1);
    }
  }
  return results;
}

function inferVideoOrSongType(title = '', channel = '', fallback = 'song') {
  const lt = title.toLowerCase();
  const lc = channel.toLowerCase();
  if (lc.includes('vevo') || VIDEO_MARKERS.some((m) => lt.includes(m))) return 'video';
  if (lc.endsWith('- topic')) return 'song';
  return fallback;
}

export function parseDurationSecs(dur = '') {
  if (!dur) return 0;
  const raw = String(dur).trim();
  if (/^\d+$/.test(raw)) return parseInt(raw, 10) || 0;
  const parts = raw.split(':').map((n) => parseInt(n, 10) || 0);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function cleanTitleForMatching(title = '') {
  return title
    .replace(/[\(\[\（\【].*?[\)\]\）\】]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSpotifyTitle(title = '') {
  return cleanTitleForMatching(title)
    .replace(/\s*[-–—]\s*(?:\d{4}\s+)?(?:remaster(?:ed)?|mix|edit|version|mono|stereo|anniversary|live).*$/i, '')
    .trim();
}

/**
 * Pick the most relevant MUSIC_PAGE_TYPE_ARTIST browseId from YTM flex/byline runs.
 */
export function extractArtistBrowseIdFromRuns(runs = [], preferredArtistName = '') {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  const candidates = [];
  for (const run of runs) {
    const browse = run?.navigationEndpoint?.browseEndpoint;
    const browseId = browse?.browseId;
    if (!browseId) continue;
    const pageType =
      browse?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';
    if (
      pageType &&
      pageType !== 'MUSIC_PAGE_TYPE_ARTIST' &&
      pageType !== 'MUSIC_PAGE_TYPE_USER_CHANNEL'
    ) {
      continue;
    }
    if (!pageType && !browseId.startsWith('UC')) continue;
    candidates.push({
      text: String(run.text || '').trim(),
      browseId,
      isArtistPage: pageType === 'MUSIC_PAGE_TYPE_ARTIST',
    });
  }
  if (candidates.length === 0) return null;

  const target = String(preferredArtistName || '').trim().toLowerCase();
  if (target) {
    const primaryTarget = target.split(/\s*(?:,|&|feat\.?|ft\.?|x)\s*/i)[0]?.trim() || target;
    const exact = candidates.find((c) => c.text.toLowerCase() === target);
    if (exact) return exact.browseId;
    const primaryMatch = candidates.find((c) => c.text.toLowerCase() === primaryTarget);
    if (primaryMatch) return primaryMatch.browseId;
  }

  const artistPage = candidates.find((c) => c.isArtistPage);
  return artistPage ? artistPage.browseId : candidates[0].browseId;
}

/**
 * Build a context-scoped cache key so homonym artists (e.g. Ali vs ALI) never collide.
 */
export function buildArtistCacheKey({
  name = '',
  browseId = null,
  videoId = null,
  trackTitle = null,
  album = null,
} = {}) {
  const cleanId = String(browseId || '').trim();
  if (cleanId) return `id:${cleanId}`;
  const cleanName = String(name || '').trim().toLowerCase();
  const cleanVid = String(videoId || '').trim();
  const cleanTitle = String(trackTitle || '').trim().toLowerCase();
  const cleanAlbum = String(album || '').trim().toLowerCase();
  if (/^[A-Za-z0-9_-]{11}$/.test(cleanVid)) return `vid:${cleanVid}|name:${cleanName}`;
  if (cleanTitle) return `ctx:${cleanName}|${cleanTitle}|${cleanAlbum}`;
  return `name:${cleanName}`;
}

function parseYtmItemWithType(r, defaultType = 'song') {
  if (!r) return null;
  const playEndpoint =
    r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint;
  const col0 = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer;
  const col0Runs = col0?.text?.runs || col0?.title?.runs || [];
  const id =
    r.playlistItemData?.videoId ||
    playEndpoint?.watchEndpoint?.videoId ||
    col0Runs[0]?.navigationEndpoint?.watchEndpoint?.videoId ||
    null;
  if (!id) return null;

  const title = col0Runs[0]?.text || 'Unknown';
  const fixedDur =
    r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '';
  const col1 = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer;
  const col1Runs = col1?.text?.runs || col1?.title?.runs || [];

  let album = null;
  for (const run of col1Runs) {
    const pageType =
      run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType;
    if (pageType === 'MUSIC_PAGE_TYPE_ALBUM' && run.text?.trim()) {
      album = run.text.trim();
      break;
    }
  }

  const joinedMeta = col1Runs.map((x) => x.text || '').join('');
  const parts = joinedMeta.split(' • ').map((p) => p.trim()).filter(Boolean);
  const channel = parts[0] || col1Runs[0]?.text || '';
  const artistBrowseId = extractArtistBrowseIdFromRuns(col1Runs, channel);
  let duration = fixedDur;
  if (!duration && parts.length > 0 && parts[parts.length - 1].includes(':')) {
    duration = parts[parts.length - 1];
  }
  if (!album && parts.length >= 3) {
    const cand = parts[1];
    if (cand && !cand.includes(':') && !/views|plays|subscribers/i.test(cand)) {
      album = cand;
    }
  }

  const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  const thumbnail = (thumbs[thumbs.length - 1] || thumbs[0])?.url || '';
  const mvType =
    playEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig
      ?.musicVideoType ||
    col0Runs[0]?.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs
      ?.watchEndpointMusicConfig?.musicVideoType ||
    '';
  const normalizedMvType = mvType ? mvType.replace(/^MUSIC_VIDEO_TYPE_/, '') : null;

  let itemType;
  if (mvType === 'MUSIC_VIDEO_TYPE_ATV') {
    itemType = 'song';
  } else if (mvType === 'MUSIC_VIDEO_TYPE_OMV' || mvType === 'MUSIC_VIDEO_TYPE_UGC') {
    itemType = 'video';
  } else {
    itemType =
      defaultType === 'song' || defaultType === 'video' || defaultType === 'album'
        ? defaultType
        : inferVideoOrSongType(title, channel, 'song');
  }

  return {
    id,
    title,
    thumbnail,
    duration,
    channel,
    artist_browse_id: artistBrowseId,
    is_playlist: false,
    track_count: null,
    first_video_id: null,
    item_type: itemType,
    music_video_type: normalizedMvType,
    stream_url: null,
    source: null,
    album,
  };
}

function parseYtmAlbumItem(r) {
  if (!r) return null;
  const col0 = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer;
  const col0Runs = col0?.text?.runs || col0?.title?.runs || [];
  const title = col0Runs[0]?.text || 'Unknown Album';
  const playEndpoint =
    r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint;
  const playlistId =
    playEndpoint?.watchPlaylistEndpoint?.playlistId ||
    r.navigationEndpoint?.browseEndpoint?.browseId ||
    col0Runs[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
    playEndpoint?.watchEndpoint?.playlistId;
  if (!playlistId) return null;

  const firstVideoId =
    playEndpoint?.watchEndpoint?.videoId || playEndpoint?.watchPlaylistEndpoint?.videoId || null;
  const col1 = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer;
  const col1Runs = col1?.text?.runs || col1?.title?.runs || [];
  const channel = col1Runs.map((x) => x.text || '').join('').trim();
  const artistBrowseId = extractArtistBrowseIdFromRuns(col1Runs, channel);
  const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  const thumbnail = (thumbs[thumbs.length - 1] || thumbs[0])?.url || '';

  return {
    id: playlistId,
    title,
    thumbnail,
    duration: '',
    channel,
    artist_browse_id: artistBrowseId,
    is_playlist: true,
    track_count: null,
    first_video_id: firstVideoId,
    item_type: 'album',
    stream_url: null,
    source: null,
    album: null,
  };
}

async function searchYouTubeMusic(query, searchType = 'song') {
  const params = SEARCH_PARAMS[searchType] || SEARCH_PARAMS.song;
  const data = await ytmPost('search', { query, params });
  const sections =
    data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer
      ?.contents || [];

  const results = [];
  for (const s of sections) {
    const items = s?.musicShelfRenderer?.contents || [];
    for (const item of items) {
      if (results.length >= 20) break;
      const renderer = item.musicResponsiveListItemRenderer;
      if (!renderer) continue;
      const parsed =
        searchType === 'album'
          ? parseYtmAlbumItem(renderer)
          : parseYtmItemWithType(renderer, searchType || 'song');
      if (parsed) results.push(parsed);
    }
  }
  return results;
}

async function scrapeRegularYouTubeSearch(query, searchType = 'song') {
  let url;
  if (searchType === 'album') {
    url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAw%3D%3D`;
  } else if (searchType === 'video') {
    url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`;
  } else {
    url = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${query} topic`)}`;
  }

  const data = await htmlScrapeLimiter.run(async () => {
    const res = await fetchWithTimeout(url, { headers: YT_HTML_HEADERS }, 15000);
    if (!res.ok) {
      try { await res.body?.cancel?.(); } catch {}
      throw new Error(`YouTube search HTTP ${res.status}`);
    }
    const html = await res.text();
    return extractBalancedJson(html, /var ytInitialData\s*=/);
  });
  if (!data) return [];

  const sections =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
  const results = [];
  const seen = new Set();

  for (const sec of sections) {
    const items = sec?.itemSectionRenderer?.contents || [];
    for (const item of items) {
      if (results.length >= 25) break;

      if (item.videoRenderer && searchType !== 'album') {
        const v = item.videoRenderer;
        const id = v.videoId;
        if (!id || seen.has(id)) continue;
        const title = v.title?.runs?.[0]?.text || 'Unknown';
        const channel = v.ownerText?.runs?.[0]?.text || '';
        const snippetText = (v.detailedMetadataSnippets?.[0]?.snippetText?.runs || [])
          .map((x) => x.text || '')
          .join('');
        const isAutoTopicAudio =
          /-\s*topic$/i.test(channel.trim()) ||
          /^(?:Provided to YouTube|Auto-generated by YouTube)\b/i.test(snippetText.trim());
        if (searchType === 'video' && isAutoTopicAudio) continue;
        if (searchType === 'song' && inferVideoOrSongType(title, channel, 'song') !== 'song') continue;

        seen.add(id);
        const thumbs = v.thumbnail?.thumbnails || [];
        results.push({
          id,
          title,
          thumbnail: thumbs[0]?.url || '',
          duration: v.lengthText?.simpleText || '',
          channel,
          is_playlist: false,
          track_count: null,
          first_video_id: null,
          item_type: searchType === 'song' ? 'song' : 'video',
          stream_url: null,
          source: null,
          album: null,
        });
      } else if (item.playlistRenderer && searchType === 'album') {
        const p = item.playlistRenderer;
        const id = p.playlistId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        results.push({
          id,
          title: p.title?.simpleText || 'Unknown Album',
          thumbnail: p.thumbnails?.[0]?.thumbnails?.[0]?.url || '',
          duration: '',
          channel: p.shortBylineText?.runs?.[0]?.text || '',
          is_playlist: true,
          track_count: p.videoCount || null,
          first_video_id: p.navigationEndpoint?.watchEndpoint?.videoId || null,
          item_type: 'album',
          stream_url: null,
          source: null,
          album: null,
        });
      } else if (item.lockupViewModel && searchType === 'album') {
        const vm = item.lockupViewModel;
        const meta = vm.metadata?.lockupMetadataViewModel;
        const runs = meta?.metadata?.runs || [];
        const ep = runs[0]?.navigationEndpoint?.watchEndpoint;
        const id = ep?.playlistId || vm.contentId || null;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const countRun = runs[0]?.text || '';
        const countMatch = countRun.match(/(\d+)\s+videos?/i);
        results.push({
          id,
          title: meta?.title?.content || 'Unknown Album',
          thumbnail:
            vm.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image
              ?.sources?.[0]?.url || '',
          duration: '',
          channel: runs[0]?.text?.split('•')?.[0]?.trim() || '',
          is_playlist: true,
          track_count: countMatch ? countMatch[1] : null,
          first_video_id: ep?.videoId || null,
          item_type: 'album',
          stream_url: null,
          source: null,
          album: null,
        });
      }
    }
  }
  return results;
}

function isKaraokeOrDerivative(title = '', channel = '', rawQuery = '') {
  const lt = title.toLowerCase();
  const lc = channel.toLowerCase();
  const lq = rawQuery.toLowerCase();
  if (lq.includes('karaoke') || lq.includes('カラオケ') || lq.includes('instrumental')) return false;
  if (/歌っちゃ王|karafun|sing king|生音風カラオケ|カラオケ/.test(lc)) return true;
  for (const phrase of BAD_KARAOKE_PHRASES) {
    if (lt.includes(phrase) && !lq.includes(phrase)) return true;
  }
  if (/[+-]\s*\d{1,2}\s*(key|キー)/i.test(lt)) return true;
  return false;
}

function scoreSearchCandidate(v, queryWords, rawQuery) {
  const cleanTitle = cleanTitleForMatching(v.title);
  const lowerRaw = (v.title || '').toLowerCase();
  const chLower = (v.channel || '').toLowerCase().replace(/- topic|vevo|official|channel/g, '').trim();
  const chWords = chLower.split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  let matchedTitleWords = 0;
  let matchedChannelWords = 0;

  for (const w of queryWords) {
    if (cleanTitle.includes(w) || lowerRaw.includes(w)) matchedTitleWords++;
    if (w.length >= 3 && !STOPWORDS.has(w) && chWords.some((cw) => cw === w || cw.includes(w) || w.includes(cw))) {
      matchedChannelWords++;
    }
  }

  const titleMatched = matchedTitleWords > 0;
  const artistMatched = matchedChannelWords > 0 || cleanTitle.includes(chLower);
  let score = Math.max(0, queryWords.length - (matchedTitleWords + matchedChannelWords)) * 40;
  if (!titleMatched) score += artistMatched ? 50 : 500;
  if (!artistMatched) score += 500;
  if (parseDurationSecs(v.duration) > 600) score += 1500;
  if (isKaraokeOrDerivative(v.title, v.channel, rawQuery)) score += 1000;
  if (v.item_type === 'song' && titleMatched && artistMatched) score -= 150;
  else if (v.item_type !== 'song') score += 50;
  return score;
}

export async function searchYouTube(query, searchType = 'song') {
  const cleanQuery = cleanTitleForMatching(query);
  const effectiveQuery = (/[\(\[]/.test(query) && cleanQuery) ? cleanQuery : query;
  const queryWords = cleanQuery.split(/\s+/).filter(Boolean);

  if (searchType === 'video') {
    try {
      const scraped = (await scrapeRegularYouTubeSearch(effectiveQuery, 'video')).filter(
        (v) => !v.is_playlist && v.item_type === 'video'
      );
      if (scraped.length > 0) return scraped;
    } catch {}
    return (await searchYouTubeMusic(effectiveQuery, 'video')).filter(
      (v) => !v.is_playlist && v.item_type === 'video'
    );
  }

  if (searchType === 'album') {
    try {
      const ytm = (await searchYouTubeMusic(effectiveQuery, 'album')).filter(
        (v) => v.is_playlist || v.item_type === 'album'
      );
      if (ytm.length > 0) return ytm;
    } catch {}
    return (await scrapeRegularYouTubeSearch(effectiveQuery, 'album')).filter(
      (v) => v.is_playlist || v.item_type === 'album'
    );
  }

  try {
    const ytm = (await searchYouTubeMusic(effectiveQuery, 'song')).filter(
      (v) => !v.is_playlist && v.item_type === 'song'
    );
    if (ytm.length > 0) {
      if (queryWords.length >= 2) {
        ytm.sort((a, b) => scoreSearchCandidate(a, queryWords, query) - scoreSearchCandidate(b, queryWords, query));
      }
      return ytm;
    }
  } catch {}
  return (await scrapeRegularYouTubeSearch(effectiveQuery, 'song')).filter(
    (v) => !v.is_playlist && v.item_type === 'song'
  );
}

function normArtistKey(v) {
  let ch = (v.channel || '').toLowerCase().replace(/-\s*topic|vevo|official/g, '').trim();
  if (!ch && v.title) {
    const m = v.title.split(/\s+[-~]\s+/);
    if (m.length > 1) ch = m[0].trim().toLowerCase();
  }
  return ch.replace(/[^\p{L}\p{N}]/gu, '');
}

function spaceOutArtistTracks(videos) {
  if (!videos || videos.length <= 2) return videos;
  const pool = [...videos];
  const out = [pool.shift()];
  while (pool.length > 0) {
    const recentKeys = out.slice(-7).map(normArtistKey).filter(Boolean);
    let pickIdx = pool.findIndex((cand) => {
      const ck = normArtistKey(cand);
      if (!ck) return true;
      return !recentKeys.some(
        (rk) => rk === ck || (rk.length > 3 && ck.length > 3 && (rk.includes(ck) || ck.includes(rk)))
      );
    });
    if (pickIdx === -1) pickIdx = 0;
    out.push(pool.splice(pickIdx, 1)[0]);
  }
  return out;
}

export async function getYouTubeMix(videoId) {
  if (!videoId) return [];
  try {
    const data = await ytmPost('next', {
      videoId,
      playlistId: `RDAMVM${videoId}`,
      isAudioOnly: true,
    });
    const contents =
      data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer
        ?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents || [];
    const videos = [];
    let mixRank = 0;
    for (const item of contents) {
      if (videos.length >= 50) break;
      const r = item.playlistPanelVideoRenderer;
      if (!r?.videoId) continue;
      const rank = mixRank++;
      const title = r.title?.runs?.[0]?.text || r.title?.simpleText || 'Unknown';
      const bylineRuns = r.longBylineText?.runs || r.shortBylineText?.runs || [];
      const channel = bylineRuns[0]?.text || '';
      const artistBrowseId = extractArtistBrowseIdFromRuns(bylineRuns, channel);
      const duration = r.lengthText?.runs?.[0]?.text || r.lengthText?.simpleText || '';
      if (r.videoId !== videoId) {
        if (isKaraokeOrDerivative(title, channel, '')) continue;
        const durSecs = parseDurationSecs(duration);
        if (durSecs > 0 && (durSecs < 90 || durSecs > 600)) continue;
      }
      const thumbs = r.thumbnail?.thumbnails || [];
      videos.push({
        id: r.videoId,
        title,
        thumbnail: (thumbs[thumbs.length - 1] || thumbs[0])?.url || '',
        duration,
        channel,
        artist_browse_id: artistBrowseId,
        is_playlist: false,
        item_type: inferVideoOrSongType(title, channel, 'song'),
        mix_rank: rank,
      });
    }
    if (videos.length > 0) return spaceOutArtistTracks(videos);
  } catch {}

  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&list=RD${encodeURIComponent(videoId)}`;
  const contents = await htmlScrapeLimiter.run(async () => {
    const res = await fetchWithTimeout(url, { headers: YT_HTML_HEADERS }, 15000);
    if (!res.ok) {
      try { await res.body?.cancel?.(); } catch {}
      return [];
    }
    const html = await res.text();
    const playlistBox = extractBalancedJson(html, /"playlist"\s*:\s*\{\s*"playlist"\s*:\s*\{/);
    if (Array.isArray(playlistBox?.playlist?.contents) && playlistBox.playlist.contents.length > 0) {
      return playlistBox.playlist.contents;
    }
    const data = extractBalancedJson(html, /var ytInitialData\s*=/);
    return data?.contents?.twoColumnWatchNextResults?.playlist?.playlist?.contents || [];
  });
  const videos = [];
  let mixRank = 0;
  for (const item of contents) {
    if (videos.length >= 25) break;
    const r = item.playlistPanelVideoRenderer;
    if (!r?.videoId) continue;
    const rank = mixRank++;
    const title = r.title?.runs?.[0]?.text || r.title?.simpleText || 'Unknown';
    const bylineRuns = r.longBylineText?.runs || r.shortBylineText?.runs || [];
    const channel = bylineRuns[0]?.text || '';
    const artistBrowseId = extractArtistBrowseIdFromRuns(bylineRuns, channel);
    const duration = r.lengthText?.simpleText || '';
    if (r.videoId !== videoId) {
      if (isKaraokeOrDerivative(title, channel, '')) continue;
      const durSecs = parseDurationSecs(duration);
      if (durSecs > 0 && (durSecs < 90 || durSecs > 600)) continue;
    }
    videos.push({
      id: r.videoId,
      title,
      thumbnail: r.thumbnail?.thumbnails?.[0]?.url || '',
      duration,
      channel,
      artist_browse_id: artistBrowseId,
      is_playlist: false,
      item_type: channel.toLowerCase().endsWith('- topic') ? 'song' : 'video',
      mix_rank: rank,
    });
  }
  return spaceOutArtistTracks(videos);
}

export async function getYouTubePlaylist(playlistId, firstVideoId = '') {
  if (!playlistId) return [];
  try {
    const browseId =
      playlistId.startsWith('VL') || playlistId.startsWith('MPRE') ? playlistId : `VL${playlistId}`;
    const data = await ytmPost('browse', { browseId });
    const hdr =
      data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
        ?.sectionListRenderer?.contents?.[0]?.musicResponsiveHeaderRenderer ||
      data?.header?.musicDetailHeaderRenderer ||
      null;
    const headerTitle = (hdr?.title?.runs || []).map((r) => r.text).join('').trim();
    const headerArtist = (hdr?.straplineTextOne?.runs || []).map((r) => r.text).join('').trim();
    const headerArtistBrowseId = extractArtistBrowseIdFromRuns(
      hdr?.straplineTextOne?.runs || [],
      headerArtist
    );
    const items =
      data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents?.[0]
        ?.musicPlaylistShelfRenderer?.contents ||
      data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer
        ?.contents?.[0]?.musicPlaylistShelfRenderer?.contents ||
      data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents?.[0]
        ?.musicShelfRenderer?.contents ||
      [];
    const tracks = [];
    for (const item of items) {
      if (tracks.length >= 200) break;
      const parsed = parseYtmItemWithType(item.musicResponsiveListItemRenderer, 'song');
      if (parsed) {
        if (headerArtist && (!parsed.channel || parsed.channel === 'Unknown Artist')) {
          parsed.channel = headerArtist;
        }
        if (!parsed.artist_browse_id && headerArtistBrowseId) {
          if (!headerArtist || parsed.channel?.toLowerCase().includes(headerArtist.toLowerCase())) {
            parsed.artist_browse_id = headerArtistBrowseId;
          }
        }
        if (
          headerTitle &&
          (!parsed.album || (headerArtist && parsed.album.toLowerCase() === headerArtist.toLowerCase()))
        ) {
          parsed.album = headerTitle;
        }
        tracks.push(parsed);
      }
    }
    if (tracks.length > 0) return tracks;
  } catch {}

  const url = firstVideoId
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(firstVideoId)}&list=${encodeURIComponent(playlistId)}`
    : `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
  const data = await htmlScrapeLimiter.run(async () => {
    const res = await fetchWithTimeout(url, { headers: YT_HTML_HEADERS }, 15000);
    if (!res.ok) {
      try { await res.body?.cancel?.(); } catch {}
      return null;
    }
    const html = await res.text();
    return extractBalancedJson(html, /var ytInitialData\s*=/);
  });
  if (!data) return [];

  const panelItems = data?.contents?.twoColumnWatchNextResults?.playlist?.playlist?.contents || [];
  const tracks = [];
  if (panelItems.length > 0) {
    for (const item of panelItems) {
      if (tracks.length >= 200) break;
      const r = item.playlistPanelVideoRenderer;
      if (!r?.videoId) continue;
      const channel = r.shortBylineText?.runs?.[0]?.text || '';
      tracks.push({
        id: r.videoId,
        title: r.title?.simpleText || r.title?.runs?.[0]?.text || 'Unknown',
        thumbnail: r.thumbnail?.thumbnails?.[0]?.url || '',
        duration: r.lengthText?.simpleText || '',
        channel,
        is_playlist: false,
        item_type: channel.toLowerCase().endsWith('- topic') ? 'song' : 'video',
      });
    }
    return tracks;
  }

  const listItems =
    data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer
      ?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents || [];
  for (const item of listItems) {
    if (tracks.length >= 200) break;
    const r = item.playlistVideoRenderer;
    if (!r?.videoId) continue;
    const channel = r.shortBylineText?.runs?.[0]?.text || '';
    tracks.push({
      id: r.videoId,
      title: r.title?.runs?.[0]?.text || 'Unknown',
      thumbnail: r.thumbnail?.thumbnails?.[0]?.url || '',
      duration: r.lengthText?.simpleText || '',
      channel,
      is_playlist: false,
      item_type: channel.toLowerCase().endsWith('- topic') ? 'song' : 'video',
    });
  }
  return tracks;
}

export async function getSpotifyPlaylist(playlistId) {
  const url = `https://open.spotify.com/embed/playlist/${encodeURIComponent(playlistId)}`;
  const res = await fetchWithTimeout(
    url,
    { headers: { 'User-Agent': YT_HTML_UA, 'Accept-Language': 'en-US,en;q=0.9' } },
    15000
  );
  if (!res.ok) throw new Error(`Spotify embed HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Spotify embed __NEXT_DATA__ not found');
  const nextData = JSON.parse(m[1]);
  const list = nextData?.props?.pageProps?.state?.data?.entity?.trackList || [];
  return list.map((t) => {
    const title = t.title || '';
    const artist = t.subtitle || '';
    const searchTitle = cleanSpotifyTitle(title) || title;
    return {
      title,
      artist,
      query: `${searchTitle} ${artist}`.trim(),
      duration_ms: Number(t.duration) || 0,
    };
  });
}

export async function getPlaylistTitle(platform, playlistId) {
  if (platform === 'spotify') {
    try {
      const res = await fetchWithTimeout(
        `https://open.spotify.com/embed/playlist/${encodeURIComponent(playlistId)}`,
        { headers: { 'User-Agent': YT_HTML_UA } },
        10000
      );
      if (!res.ok) {
        try { await res.body?.cancel?.(); } catch {}
      } else {
        const html = await res.text();
        const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
        if (m) {
          const nextData = JSON.parse(m[1]);
          const name = nextData?.props?.pageProps?.state?.data?.entity?.name;
          if (name) return detachString(name);
        }
      }
    } catch {}
    return 'Imported Spotify Playlist';
  }

  try {
    const title = await htmlScrapeLimiter.run(async () => {
      const res = await fetchWithTimeout(
        `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`,
        { headers: YT_HTML_HEADERS },
        10000
      );
      if (!res.ok) {
        try { await res.body?.cancel?.(); } catch {}
        return '';
      }
      const html = await res.text();
      const data = extractBalancedJson(html, /var ytInitialData\s*=/);
      return data?.header?.playlistHeaderRenderer?.title?.simpleText || '';
    });
    if (title) return detachString(title);
  } catch {}
  return 'Imported YouTube Playlist';
}

const SUPPORTED_KWORB_REGIONS = new Set([
  'global', 'id', 'us', 'gb', 'jp', 'kr', 'my', 'sg', 'ph',
  'th', 'vn', 'in', 'au', 'br', 'de', 'fr', 'ca', 'mx', 'tw',
]);

const KWORB_CHART_TTL_MS = 15 * 60 * 1000;
const SPOTIFY_THUMB_TTL_MS = 24 * 60 * 60 * 1000;
const SPOTIFY_THUMB_CACHE_MAX = 2000;
const kworbChartCache = new Map();
const kworbChartInFlight = new Map();
const spotifyThumbCache = new Map();

function setSpotifyThumbCache(spotifyId, url) {
  const cleanId = detachString(spotifyId);
  const cleanUrl = detachString(url);
  if (spotifyThumbCache.has(cleanId)) spotifyThumbCache.delete(cleanId);
  spotifyThumbCache.set(cleanId, { url: cleanUrl, ts: Date.now() });
  if (spotifyThumbCache.size > SPOTIFY_THUMB_CACHE_MAX) {
    const oldest = spotifyThumbCache.keys().next().value;
    if (oldest !== undefined) spotifyThumbCache.delete(oldest);
  }
}

async function fetchSpotifyTrackThumbnail(spotifyId) {
  if (!spotifyId) return null;
  const cached = spotifyThumbCache.get(spotifyId);
  if (cached && Date.now() - cached.ts < SPOTIFY_THUMB_TTL_MS) {
    return cached.url;
  }
  try {
    const res = await fetchWithTimeout(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${spotifyId}`)}`,
      { headers: { 'User-Agent': YTM_UA, Accept: 'application/json' } },
      2500
    );
    if (!res.ok) return null;
    const data = await res.json();
    const thumb = typeof data?.thumbnail_url === 'string' && data.thumbnail_url.trim()
      ? data.thumbnail_url.trim()
      : null;
    if (thumb) setSpotifyThumbCache(spotifyId, thumb);
    return thumb;
  } catch {
    return null;
  }
}

async function enrichTracksWithThumbnails(tracks, concurrency = 12) {
  const pending = tracks.filter((t) => t.spotify_id);
  if (pending.length === 0) return;

  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      item.thumbnail = await fetchSpotifyTrackThumbnail(item.spotify_id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
}

function formatCompactPlays(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e9) {
    const val = n / 1e9;
    return `${val >= 10 ? Math.round(val) : Number(val.toFixed(1))}B plays`;
  }
  if (n >= 1e6) {
    const val = n / 1e6;
    return `${val >= 10 ? Math.round(val) : Number(val.toFixed(1))}M plays`;
  }
  if (n >= 1e3) {
    const val = n / 1e3;
    return `${val >= 10 ? Math.round(val) : Number(val.toFixed(1))}K plays`;
  }
  return `${Math.round(n)} plays`;
}

export async function getKworbChart(region = 'id') {
  const clean = String(region || 'id').trim().toLowerCase().replace(/[^a-z]/g, '');
  const code = SUPPORTED_KWORB_REGIONS.has(clean) ? clean : 'id';

  const cached = kworbChartCache.get(code);
  if (cached && Date.now() - cached.ts < KWORB_CHART_TTL_MS) {
    return cached.tracks;
  }

  if (kworbChartInFlight.has(code)) {
    return kworbChartInFlight.get(code);
  }

  const job = (async () => {
    const url = `https://kworb.net/spotify/country/${code}_daily.html`;
    const res = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': YTM_UA, 'Accept-Language': 'en-US,en;q=0.9' } },
      15000
    );
    if (!res.ok) {
      try { await res.body?.cancel?.(); } catch {}
      throw new Error(`Kworb HTTP ${res.status}`);
    }
    const html = await res.text();

    const tracks = [];
    const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
    let rowMatch;
    while ((rowMatch = rowRe.exec(html)) !== null && tracks.length < 50) {
      const rowHtml = rowMatch[1];
      const cellMatch = rowHtml.match(/<td class="text mp"><div>([\s\S]*?)<\/div><\/td>/);
      if (!cellMatch) continue;
      const cellHtml = cellMatch[1];
      const raw = detachString(decodeHtmlEntities(cellHtml.replace(/<[^>]*>/g, ' ').replace(/[\n\r]/g, ' ')));
      if (!raw) continue;
      const dashIdx = raw.indexOf(' - ');
      const artist = dashIdx !== -1 ? detachString(raw.slice(0, dashIdx).trim()) : '';
      const title = dashIdx !== -1 ? detachString(raw.slice(dashIdx + 3).trim()) : raw;
      const spotifyMatch = cellHtml.match(/\/track\/([a-zA-Z0-9]+)\.html/);
      const tds = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
        decodeHtmlEntities(m[1].replace(/<[^>]*>/g, ' ').replace(/[\n\r]/g, ' ')).trim()
      );
      const dailyNum = parseInt(String(tds[6] || '').replace(/,/g, ''), 10);
      const totalNum = parseInt(String(tds[tds.length - 1] || '').replace(/,/g, ''), 10);
      const totalStreams = Number.isFinite(totalNum) && totalNum > 0 ? totalNum : null;
      const dailyStreams = Number.isFinite(dailyNum) && dailyNum > 0 ? dailyNum : null;
      tracks.push({
        rank: tracks.length + 1,
        artist,
        title,
        query: raw,
        spotify_id: spotifyMatch?.[1] ? detachString(spotifyMatch[1]) : null,
        thumbnail: null,
        total_streams: totalStreams,
        daily_streams: dailyStreams,
        plays: formatCompactPlays(totalStreams),
      });
    }

    await enrichTracksWithThumbnails(tracks);
    kworbChartCache.set(code, { tracks, ts: Date.now() });
    return tracks;
  })();

  kworbChartInFlight.set(code, job);
  try {
    return await job;
  } finally {
    kworbChartInFlight.delete(code);
  }
}

export async function getVideoAlbumInfo(videoId) {
  if (!videoId) return { album: '', artist: '', album_playlist_id: '' };

  let album = '';
  let artist = '';
  let albumPlaylistId = '';

  try {
    const extracted = await htmlScrapeLimiter.run(async () => {
      const res = await fetchWithTimeout(
        `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
        { headers: YT_HTML_HEADERS },
        10000
      );
      if (!res.ok) {
        try { await res.body?.cancel?.(); } catch {}
        return null;
      }
      const html = await res.text();
      const olakMatch = html.match(/OLAK5uy_[a-zA-Z0-9_-]+/);
      let localPlaylistId = olakMatch ? detachString(olakMatch[0]) : '';

      const details = extractBalancedJson(html, /"videoDetails"\s*:\s*\{/);
      const micro =
        !details || !details.shortDescription
          ? extractBalancedJson(html, /"playerMicroformatRenderer"\s*:\s*\{/)
          : null;
      let localArtist = detachString(
        (details?.author || micro?.ownerChannelName || '').replace(/\s*-\s*Topic$/i, '').trim()
      );

      const desc = details?.shortDescription || micro?.description?.simpleText || '';
      const descMatch = desc.match(
        /(?:Auto-generated by YouTube\.|Provided to YouTube by)[\s\S]*?\n\n([^\n·]+)[\s\S]*?\n\n([^\n]+)\n/
      );
      let localAlbum = descMatch ? detachString((descMatch[2] || '').trim()) : '';

      const cardRenderers = extractAllBalancedJson(html, /"horizontalCardListRenderer"\s*:\s*\{/g, 6);
      for (const renderer of cardRenderers) {
        const cards = renderer?.cards || [];
        for (const c of cards) {
          const m = c?.videoAttributeViewModel;
          if (!m) continue;
          if (!localAlbum && m.secondarySubtitle?.content) {
            localAlbum = detachString(m.secondarySubtitle.content.trim());
          }
          if (m.subtitle && (!localArtist || /vevo$/i.test(localArtist))) {
            localArtist = detachString(m.subtitle.trim());
          }
          if (!localPlaylistId) {
            const cardPid =
              m.secondarySubtitle?.commandRuns?.[0]?.onTap?.innertubeCommand?.watchPlaylistEndpoint?.playlistId;
            if (cardPid) localPlaylistId = detachString(cardPid);
          }
        }
      }

      return {
        album: localAlbum,
        artist: localArtist,
        albumPlaylistId: localPlaylistId,
      };
    });

    if (extracted) {
      album = extracted.album || '';
      artist = extracted.artist || '';
      albumPlaylistId = extracted.albumPlaylistId || '';
    }
  } catch {}

  if (!album) {
    try {
      const searchRes = await searchYouTubeMusic(videoId, 'song');
      if (searchRes[0]?.album) album = detachString(searchRes[0].album);
      if (!artist && searchRes[0]?.channel) artist = detachString(searchRes[0].channel);
    } catch {}
  }

  return {
    album: album || '',
    artist: artist || '',
    album_playlist_id: albumPlaylistId || '',
  };
}

function parseArtistSong(c, defaultArtist = '') {
  const r = c?.musicResponsiveListItemRenderer || c;
  if (!r) return null;
  const col0Runs = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const id =
    r.playlistItemData?.videoId ||
    r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint
      ?.watchEndpoint?.videoId ||
    col0Runs[0]?.navigationEndpoint?.watchEndpoint?.videoId;
  if (!id) return null;

  const title = col0Runs[0]?.text || 'Unknown';
  const col1Runs = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const artist = col1Runs.map((x) => x.text || '').join('').trim() || defaultArtist;
  const artistBrowseId = extractArtistBrowseIdFromRuns(col1Runs, artist);

  let plays = null;
  let album = null;
  let albumId = null;
  let albumPlaylistId = null;

  for (const colIdx of [2, 3]) {
    const runs = r.flexColumns?.[colIdx]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const text = runs.map((x) => x.text || '').join('').trim();
    if (!text) continue;
    if (/play|view/i.test(text)) {
      plays = text;
    } else if (!album) {
      album = text;
    }
    for (const run of runs) {
      const browse = run.navigationEndpoint?.browseEndpoint;
      const pid = run.navigationEndpoint?.watchEndpoint?.playlistId;
      if (pid && pid.startsWith('OLAK5uy_')) albumPlaylistId = pid;
      if (browse?.browseId && browse.browseId.startsWith('MPREb_')) albumId = browse.browseId;
    }
  }

  const duration =
    r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || null;
  const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  const thumbnail = (thumbs[thumbs.length - 1] || thumbs[0])?.url || '';

  return {
    id,
    title,
    artist,
    artist_browse_id: artistBrowseId,
    plays,
    album,
    album_id: albumId,
    album_playlist_id: albumPlaylistId,
    duration,
    thumbnail,
  };
}

function normArtistToken(v) {
  return String(v || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function songArtistMatches(candChannel, targetArtist) {
  const normTarget = normArtistToken(targetArtist);
  const normCand = normArtistToken(candChannel);
  if (!normTarget || !normCand) return false;
  if (normCand === normTarget) return true;
  const parts = normCand.split(/\s*(?:,|&|feat\.?|ft\.?|x)\s*/i).map((p) => p.trim());
  return parts.includes(normTarget);
}

async function resolveArtistBrowseIdFromContext(artistName, context = {}) {
  const videoId = String(context?.videoId || '').trim();
  const trackTitle = String(context?.trackTitle || '').trim();
  const album = String(context?.album || '').trim();

  // 1. Direct YTM `next` lookup for YouTube video IDs (carries exact MUSIC_PAGE_TYPE_ARTIST browseId)
  if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    try {
      const nextData = await ytmPost('next', { videoId, isAudioOnly: true });
      const panelItems =
        nextData?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
          ?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer
          ?.content?.playlistPanelRenderer?.contents || [];
      const matchItem =
        panelItems.find((it) => it?.playlistPanelVideoRenderer?.videoId === videoId) ||
        panelItems[0];
      const r = matchItem?.playlistPanelVideoRenderer;
      const bylineRuns = r?.longBylineText?.runs || r?.shortBylineText?.runs || [];
      const fromNext = extractArtistBrowseIdFromRuns(bylineRuns, artistName);
      if (fromNext) return fromNext;
    } catch {}
  }

  // 2. Contextual YTM song search (handles Monochrome IDs & older cached queue items)
  if (trackTitle) {
    try {
      const q = `${artistName} ${trackTitle}${album ? ` ${album}` : ''}`.trim();
      const songs = await searchYouTubeMusic(q, 'song');
      const normTitle = normArtistToken(trackTitle);
      const normAlbum = normArtistToken(album);
      const rawTarget = String(artistName || '').trim();

      let bestId = null;
      let bestScore = -1;
      for (const s of songs) {
        if (!s?.artist_browse_id) continue;
        if (!songArtistMatches(s.channel, artistName)) continue;

        const sTitle = normArtistToken(s.title);
        const sAlbum = normArtistToken(s.album);
        let score = 0;
        if (sTitle === normTitle) score += 10;
        else if (sTitle.includes(normTitle) || normTitle.includes(sTitle)) score += 5;
        else continue;

        if (normAlbum && sAlbum && (sAlbum === normAlbum || sAlbum.includes(normAlbum))) score += 6;
        if (String(s.channel || '').trim() === rawTarget) score += 4;
        if (normArtistToken(s.channel) === normArtistToken(artistName)) score += 3;

        if (score > bestScore) {
          bestScore = score;
          bestId = s.artist_browse_id;
        }
      }
      if (bestId) return bestId;
    } catch {}
  }

  return null;
}

export async function getArtistDetails(artistName, artistBrowseId = null, context = {}) {
  let browseId = artistBrowseId || null;
  let searchAvatar = null;

  if (!browseId && (context?.videoId || context?.trackTitle)) {
    browseId = await resolveArtistBrowseIdFromContext(artistName, context);
  }

  if (!browseId) {
    const searchData = await ytmPost('search', {
      query: artistName,
      params: 'EgWKAQIgAWoOEAQQAxAFEAkQEBAKEBU%3D',
    });
    const shelfItems =
      searchData?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
        ?.sectionListRenderer?.contents?.[0]?.musicShelfRenderer?.contents || [];
    const picked =
      shelfItems.find((it) => {
        const txt =
          it.musicResponsiveListItemRenderer?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
            ?.text?.runs?.[0]?.text || '';
        return txt.trim() === artistName.trim();
      }) ||
      shelfItems.find((it) => {
        const txt =
          it.musicResponsiveListItemRenderer?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
            ?.text?.runs?.[0]?.text || '';
        return txt.toLowerCase() === artistName.toLowerCase();
      }) ||
      shelfItems[0];

    const r = picked?.musicResponsiveListItemRenderer;
    browseId =
      r?.navigationEndpoint?.browseEndpoint?.browseId ||
      r?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint
        ?.browseEndpoint?.browseId ||
      null;
    const thumbs = r?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
    searchAvatar = (thumbs[thumbs.length - 1] || thumbs[0])?.url || null;
  }

  if (!browseId) throw new Error(`Artist not found: ${artistName}`);

  const browseData = await ytmPost('browse', { browseId });
  const header =
    browseData?.header?.musicImmersiveHeaderRenderer ||
    browseData?.header?.musicVisualHeaderRenderer ||
    browseData?.header?.musicHeaderRenderer;

  const resolvedName = header?.title?.runs?.[0]?.text || artistName;
  const hThumbs = header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  const bgImg = (hThumbs[hThumbs.length - 1] || hThumbs[0])?.url || searchAvatar;
  const subscribers =
    header?.subscriptionButton?.subscribeButtonRenderer?.subscriberCountText?.runs?.[0]?.text || null;
  const monthlyAudience = header?.monthlyListenerCount?.runs?.[0]?.text || null;

  let description =
    header?.description?.runs?.map((r) => r.text).join('') || header?.description?.simpleText || null;

  const sections =
    browseData?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents || [];

  let topSongs = [];
  let topSongsPlaylistId = null;

  for (const sec of sections) {
    if (!description && sec.musicDescriptionShelfRenderer) {
      const dr = sec.musicDescriptionShelfRenderer.description;
      description = dr?.runs?.map((r) => r.text).join('') || dr?.simpleText || null;
    }
    const shelf = sec.musicShelfRenderer;
    const shelfTitle = shelf?.title?.runs?.[0]?.text?.toLowerCase() || '';
    if (shelf && (shelfTitle.includes('song') || shelfTitle.includes('top')) && topSongs.length === 0) {
      topSongsPlaylistId = shelf.bottomEndpoint?.browseEndpoint?.browseId || null;
      topSongs = (shelf.contents || [])
        .map((c) => parseArtistSong(c, resolvedName))
        .filter(Boolean)
        .map((song) => ({
          ...song,
          artist_browse_id:
            song.artist_browse_id ||
            (songArtistMatches(song.artist || resolvedName, resolvedName) ? browseId : null),
        }));
    }
  }

  if (topSongs.length === 0) {
    const fallback = (await searchYouTubeMusic(resolvedName, 'song')).slice(0, 10);
    topSongs = fallback.map((v) => ({
      id: v.id,
      title: v.title,
      artist: v.channel || resolvedName,
      artist_browse_id:
        v.artist_browse_id ||
        (songArtistMatches(v.channel || resolvedName, resolvedName) ? browseId : null),
      plays: null,
      album: v.album || null,
      album_id: null,
      album_playlist_id: null,
      duration: v.duration || null,
      thumbnail: v.thumbnail,
    }));
  }

  return {
    name: resolvedName,
    browse_id: browseId,
    background_image: bgImg,
    avatar: searchAvatar || bgImg,
    subscribers,
    monthly_audience: monthlyAudience,
    description,
    top_songs: topSongs,
    top_songs_playlist_id: topSongsPlaylistId,
  };
}

export async function getArtistTopSongs(playlistId) {
  if (!playlistId) return [];
  const browseId = playlistId.startsWith('VL') ? playlistId : `VL${playlistId}`;
  try {
    const data = await ytmPost('browse', { browseId });
    const items =
      data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents?.[0]
        ?.musicPlaylistShelfRenderer?.contents ||
      data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents?.[0]
        ?.musicShelfRenderer?.contents ||
      data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer
        ?.contents?.[0]?.musicPlaylistShelfRenderer?.contents ||
      data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer
        ?.contents?.[0]?.musicShelfRenderer?.contents ||
      [];
    const songs = items.map((it) => parseArtistSong(it, '')).filter(Boolean);
    if (songs.length > 0) return songs;
  } catch {}

  const fallback = await getYouTubePlaylist(playlistId.replace(/^VL/, ''), '');
  return fallback.map((v) => ({
    id: v.id,
    title: v.title,
    artist: v.channel,
    plays: null,
    album: v.album || null,
    album_id: null,
    album_playlist_id: null,
    duration: v.duration || null,
    thumbnail: v.thumbnail,
  }));
}

export async function extractYouTubeAudioUrl(videoId) {
  if (!videoId) throw new Error('Missing videoId');

  // 1. Try InnerTube IOS / ANDROID / ANDROID_VR direct adaptive audio URL
  const clients = [
    {
      clientName: 'IOS',
      clientVersion: '20.10.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
      ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    },
    {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      deviceMake: 'Google',
      deviceModel: 'Pixel 8',
      osName: 'Android',
      osVersion: '14',
      ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
    },
    {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      osName: 'Android',
      osVersion: '12',
      ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; Quest 3 Build/SQ3A.220605.009.A1) gzip',
    },
  ];

  for (const c of clients) {
    try {
      const res = await fetchWithTimeout(
        'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': c.ua,
          },
          body: JSON.stringify({
            videoId,
            context: {
              client: {
                clientName: c.clientName,
                clientVersion: c.clientVersion,
                deviceMake: c.deviceMake,
                deviceModel: c.deviceModel,
                osName: c.osName,
                osVersion: c.osVersion,
                hl: 'en',
                gl: 'US',
              },
            },
          }),
        },
        10000
      );
      if (!res.ok) continue;
      const data = await res.json();
      const adaptive = data?.streamingData?.adaptiveFormats || [];
      const audioFormats = adaptive
        .filter((f) => f.url && String(f.mimeType || '').startsWith('audio/'))
        .sort((a, b) => {
          const aM4a = String(a.mimeType).includes('audio/mp4') ? 1 : 0;
          const bM4a = String(b.mimeType).includes('audio/mp4') ? 1 : 0;
          if (aM4a !== bM4a) return bM4a - aM4a;
          return (b.bitrate || 0) - (a.bitrate || 0);
        });
      if (audioFormats[0]?.url) {
        return {
          url: audioFormats[0].url,
          mimeType: audioFormats[0].mimeType || 'audio/mp4',
          userAgent: c.ua,
          contentLength: Number(audioFormats[0].contentLength) || 0,
        };
      }
    } catch {}
  }

  // 2. Fallback to yt-dlp if installed on the host
  try {
    const { stdout } = await execFileAsync(
      'yt-dlp',
      ['--encoding', 'utf-8', '-g', '-f', 'bestaudio[ext=m4a]/bestaudio', `https://www.youtube.com/watch?v=${videoId}`],
      { timeout: 25000 }
    );
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (lines[0]) {
      return { url: lines[0], mimeType: 'audio/mp4', userAgent: CHROME_130_UA };
    }
  } catch {}

  throw new Error('Could not extract YouTube audio stream URL');
}
