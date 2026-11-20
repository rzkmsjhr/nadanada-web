import { fetchWithTimeout } from './http.js';
import { resolveNearestTrendingRegion, TRENDING_COUNTRY_CODES } from '../src/utils/regionGeo.js';

const IP_GEO_CACHE = new Map();
const IP_GEO_CACHE_MAX = 2000;
const IP_GEO_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeIp(raw = '') {
  let ip = String(raw || '').trim();
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  // Strip port on IPv4:port
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) {
    ip = ip.split(':')[0];
  }
  return ip;
}

export function isPrivateOrLoopbackIp(ip = '') {
  if (!ip) return true;
  const clean = normalizeIp(ip).toLowerCase();
  if (
    clean === '::1' ||
    clean === 'localhost' ||
    clean.startsWith('127.') ||
    clean.startsWith('10.') ||
    clean.startsWith('192.168.') ||
    clean.startsWith('169.254.') ||
    clean.startsWith('0.') ||
    clean.startsWith('fc') ||
    clean.startsWith('fd') ||
    clean.startsWith('fe80:')
  ) {
    return true;
  }
  const m172 = /^172\.(\d+)\./.exec(clean);
  if (m172) {
    const oct = parseInt(m172[1], 10);
    if (oct >= 16 && oct <= 31) return true;
  }
  return false;
}

export function extractVisitorIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  if (xff) {
    const candidates = xff.split(',').map((s) => normalizeIp(s)).filter(Boolean);
    const firstPublic = candidates.find((ip) => !isPrivateOrLoopbackIp(ip));
    if (firstPublic) return firstPublic;
  }
  const realIp = normalizeIp(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || '');
  if (realIp && !isPrivateOrLoopbackIp(realIp)) return realIp;

  const remote = normalizeIp(req.socket?.remoteAddress || req.ip || '');
  return isPrivateOrLoopbackIp(remote) ? '' : remote;
}

function getCachedGeo(ip) {
  const entry = IP_GEO_CACHE.get(ip);
  if (!entry) return null;
  if (Date.now() - entry.ts > IP_GEO_TTL_MS) {
    IP_GEO_CACHE.delete(ip);
    return null;
  }
  return entry.data;
}

function setCachedGeo(ip, data) {
  if (IP_GEO_CACHE.has(ip)) IP_GEO_CACHE.delete(ip);
  IP_GEO_CACHE.set(ip, { data, ts: Date.now() });
  if (IP_GEO_CACHE.size > IP_GEO_CACHE_MAX) {
    const oldest = IP_GEO_CACHE.keys().next().value;
    if (oldest !== undefined) IP_GEO_CACHE.delete(oldest);
  }
}

async function lookupIpGeo(ip) {
  const cached = getCachedGeo(ip);
  if (cached) return cached;

  // Provider 1: ipwho.is (HTTPS, no key, returns country_code + latitude + longitude)
  try {
    const res = await fetchWithTimeout(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      headers: { Accept: 'application/json' },
    }, 2500);
    if (res.ok) {
      const data = await res.json();
      if (data?.success && data?.country_code) {
        const result = {
          countryCode: String(data.country_code).toLowerCase(),
          lat: Number.isFinite(Number(data.latitude)) ? Number(data.latitude) : null,
          lon: Number.isFinite(Number(data.longitude)) ? Number(data.longitude) : null,
        };
        setCachedGeo(ip, result);
        return result;
      }
    }
  } catch {}

  // Provider 2 fallback: ip-api.com (no key, fast)
  try {
    const res = await fetchWithTimeout(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode,lat,lon`,
      { headers: { Accept: 'application/json' } },
      2500
    );
    if (res.ok) {
      const data = await res.json();
      if (data?.status === 'success' && data?.countryCode) {
        const result = {
          countryCode: String(data.countryCode).toLowerCase(),
          lat: Number.isFinite(Number(data.lat)) ? Number(data.lat) : null,
          lon: Number.isFinite(Number(data.lon)) ? Number(data.lon) : null,
        };
        setCachedGeo(ip, result);
        return result;
      }
    }
  } catch {}

  return null;
}

export async function detectVisitorRegion(req) {
  // 1. Instant proxy geo headers (Cloudflare, Vercel, etc.)
  const headerCountry = String(
    req.headers['cf-ipcountry'] ||
      req.headers['x-vercel-ip-country'] ||
      req.headers['x-country-code'] ||
      req.headers['x-geo-country'] ||
      ''
  )
    .trim()
    .toLowerCase();

  if (/^[a-z]{2}$/.test(headerCountry) && headerCountry !== 'xx' && headerCountry !== 't1') {
    const region = resolveNearestTrendingRegion({ countryCode: headerCountry });
    return {
      detected: true,
      region,
      countryCode: headerCountry,
      isExactMatch: TRENDING_COUNTRY_CODES.has(headerCountry),
      source: 'header',
    };
  }

  // 2. Public client IP lookup
  const ip = extractVisitorIp(req);
  if (ip) {
    const geo = await lookupIpGeo(ip);
    if (geo) {
      const region = resolveNearestTrendingRegion({
        countryCode: geo.countryCode,
        lat: geo.lat,
        lon: geo.lon,
      });
      return {
        detected: true,
        region,
        countryCode: geo.countryCode,
        isExactMatch: TRENDING_COUNTRY_CODES.has(geo.countryCode),
        source: 'ip',
      };
    }
  }

  // 3. Accept-Language header fallback if IP is loopback/private or geo APIs timed out
  const acceptLang = String(req.headers['accept-language'] || '').split(',')[0]?.split(';')[0]?.trim() || '';
  if (acceptLang) {
    const region = resolveNearestTrendingRegion({ locale: acceptLang, fallback: '' });
    if (region) {
      return {
        detected: false,
        region,
        countryCode: null,
        isExactMatch: false,
        source: 'accept-language',
      };
    }
  }

  return {
    detected: false,
    region: null,
    countryCode: null,
    isExactMatch: false,
    source: 'none',
  };
}
