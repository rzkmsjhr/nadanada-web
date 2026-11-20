export const TRENDING_COUNTRIES = [
  { code: 'id', name: 'Indonesia', lat: -2.5, lon: 118.0 },
  { code: 'us', name: 'United States', lat: 39.8, lon: -98.6 },
  { code: 'gb', name: 'United Kingdom', lat: 54.0, lon: -2.5 },
  { code: 'jp', name: 'Japan', lat: 36.2, lon: 138.3 },
  { code: 'kr', name: 'South Korea', lat: 36.5, lon: 127.9 },
  { code: 'my', name: 'Malaysia', lat: 4.2, lon: 101.9 },
  { code: 'sg', name: 'Singapore', lat: 1.35, lon: 103.8 },
  { code: 'ph', name: 'Philippines', lat: 12.9, lon: 121.8 },
  { code: 'th', name: 'Thailand', lat: 15.9, lon: 100.9 },
  { code: 'vn', name: 'Vietnam', lat: 14.1, lon: 108.3 },
  { code: 'in', name: 'India', lat: 20.6, lon: 78.9 },
  { code: 'au', name: 'Australia', lat: -25.3, lon: 133.8 },
  { code: 'br', name: 'Brazil', lat: -14.2, lon: -51.9 },
  { code: 'de', name: 'Germany', lat: 51.2, lon: 10.4 },
  { code: 'fr', name: 'France', lat: 46.2, lon: 2.2 },
  { code: 'ca', name: 'Canada', lat: 56.1, lon: -106.3 },
  { code: 'mx', name: 'Mexico', lat: 23.6, lon: -102.5 },
  { code: 'tw', name: 'Taiwan', lat: 23.7, lon: 121.0 },
];

export const TRENDING_COUNTRY_CODES = new Set(TRENDING_COUNTRIES.map((c) => c.code));

// ISO 3166-1 alpha-2 centroids [lat, lon] for non-listed countries so nearest listed country can be computed via Haversine
const COUNTRY_CENTROIDS = {
  // Southeast Asia & Oceania
  tl: [-8.87, 125.73], // Timor-Leste -> Indonesia
  bn: [4.54, 114.73], // Brunei
  kh: [12.57, 104.99], // Cambodia
  la: [19.86, 102.5], // Laos
  mm: [21.91, 95.96], // Myanmar
  pg: [-6.31, 143.96], // Papua New Guinea
  nz: [-40.9, 174.89], // New Zealand
  fj: [-17.71, 178.07], // Fiji
  sb: [-9.65, 160.16], // Solomon Islands
  vu: [-15.38, 166.96], // Vanuatu
  nc: [-20.9, 165.62], // New Caledonia
  ws: [-13.76, -172.1], // Samoa
  to: [-21.18, -175.2], // Tonga
  gu: [13.44, 144.79], // Guam
  // East & South & Central Asia
  hk: [22.32, 114.17], // Hong Kong
  mo: [22.2, 113.54], // Macau
  cn: [35.86, 104.2], // China
  mn: [46.86, 103.85], // Mongolia
  kp: [40.34, 127.51], // North Korea
  bd: [23.68, 90.36], // Bangladesh
  pk: [30.38, 69.35], // Pakistan
  lk: [7.87, 80.77], // Sri Lanka
  np: [28.39, 84.12], // Nepal
  bt: [27.51, 90.43], // Bhutan
  mv: [3.2, 73.22], // Maldives
  af: [33.94, 67.71], // Afghanistan
  kz: [48.02, 66.92], // Kazakhstan
  uz: [41.38, 64.59], // Uzbekistan
  kg: [41.2, 74.77], // Kyrgyzstan
  tj: [38.86, 71.28], // Tajikistan
  tm: [38.97, 59.56], // Turkmenistan
  // Middle East
  ae: [23.42, 53.85], // UAE
  sa: [23.89, 45.08], // Saudi Arabia
  qa: [25.35, 51.18], // Qatar
  kw: [29.31, 47.48], // Kuwait
  bh: [26.07, 50.56], // Bahrain
  om: [21.51, 55.92], // Oman
  ye: [15.55, 48.52], // Yemen
  ir: [32.43, 53.69], // Iran
  iq: [33.22, 43.68], // Iraq
  jo: [30.59, 36.24], // Jordan
  lb: [33.85, 35.86], // Lebanon
  sy: [34.8, 39.0], // Syria
  il: [31.05, 34.85], // Israel
  ps: [31.95, 35.23], // Palestine
  tr: [38.96, 35.24], // Turkey
  cy: [35.13, 33.43], // Cyprus
  ge: [42.32, 43.36], // Georgia
  am: [40.07, 45.04], // Armenia
  az: [40.14, 47.58], // Azerbaijan
  // South & Central America & Caribbean
  ar: [-38.42, -63.62], // Argentina -> Brazil
  cl: [-35.68, -71.54], // Chile
  uy: [-32.52, -55.77], // Uruguay
  py: [-23.44, -58.44], // Paraguay
  bo: [-16.29, -63.59], // Bolivia
  pe: [-9.19, -75.02], // Peru
  ec: [-1.83, -78.18], // Ecuador
  co: [4.57, -74.3], // Colombia
  ve: [6.42, -66.59], // Venezuela
  gy: [4.86, -58.93], // Guyana
  sr: [3.92, -56.03], // Suriname
  gf: [3.93, -53.13], // French Guiana
  pa: [8.54, -80.78], // Panama
  cr: [9.75, -83.75], // Costa Rica
  ni: [12.87, -85.21], // Nicaragua
  hn: [15.2, -86.24], // Honduras
  sv: [13.79, -88.9], // El Salvador
  gt: [15.78, -90.23], // Guatemala
  bz: [17.19, -88.5], // Belize
  cu: [21.52, -77.78], // Cuba
  jm: [18.11, -77.3], // Jamaica
  do: [18.74, -70.16], // Dominican Republic
  ht: [18.97, -72.29], // Haiti
  pr: [18.22, -66.59], // Puerto Rico
  bs: [25.03, -77.4], // Bahamas
  tt: [10.69, -61.22], // Trinidad and Tobago
  bb: [13.19, -59.54], // Barbados
  // Europe
  ie: [53.41, -8.24], // Ireland
  is: [64.96, -19.02], // Iceland
  es: [40.46, -3.75], // Spain
  pt: [39.4, -8.22], // Portugal
  ad: [42.55, 1.6], // Andorra
  be: [50.5, 4.47], // Belgium
  nl: [52.13, 5.29], // Netherlands
  lu: [49.82, 6.13], // Luxembourg
  ch: [46.82, 8.23], // Switzerland
  at: [47.52, 14.55], // Austria
  it: [41.87, 12.57], // Italy
  pl: [51.92, 19.15], // Poland
  cz: [49.82, 15.47], // Czechia
  sk: [48.67, 19.7], // Slovakia
  hu: [47.16, 19.5], // Hungary
  dk: [56.26, 9.5], // Denmark
  no: [60.47, 8.47], // Norway
  se: [60.13, 18.64], // Sweden
  fi: [61.92, 25.75], // Finland
  ee: [58.6, 25.01], // Estonia
  lv: [56.88, 24.6], // Latvia
  lt: [55.17, 23.88], // Lithuania
  ro: [45.94, 24.97], // Romania
  bg: [42.73, 25.49], // Bulgaria
  gr: [39.07, 21.82], // Greece
  hr: [45.1, 15.2], // Croatia
  si: [46.15, 15.0], // Slovenia
  rs: [44.02, 21.01], // Serbia
  ba: [43.92, 17.68], // Bosnia
  al: [41.15, 20.17], // Albania
  mk: [41.61, 21.75], // North Macedonia
  ua: [48.38, 31.17], // Ukraine
  by: [53.71, 27.95], // Belarus
  md: [47.41, 28.37], // Moldova
  ru: [61.52, 105.32], // Russia
  mt: [35.94, 14.38], // Malta
  // Africa
  ma: [31.79, -7.09], // Morocco
  dz: [28.03, 1.66], // Algeria
  tn: [33.89, 9.54], // Tunisia
  ly: [26.34, 17.23], // Libya
  eg: [26.82, 30.8], // Egypt
  ng: [9.08, 8.68], // Nigeria
  gh: [7.95, -1.02], // Ghana
  ke: [-0.02, 37.91], // Kenya
  tz: [-6.37, 34.89], // Tanzania
  et: [9.15, 40.49], // Ethiopia
  za: [-30.56, 22.94], // South Africa
  sn: [14.5, -14.45], // Senegal
  ci: [7.54, -5.55], // Cote d'Ivoire
  cm: [7.37, 12.35], // Cameroon
  ug: [1.37, 32.29], // Uganda
  ao: [-11.2, 17.87], // Angola
  mz: [-18.67, 35.53], // Mozambique
  zw: [-19.02, 29.15], // Zimbabwe
  mu: [-20.35, 57.55], // Mauritius
};

// High-signal IANA timezone -> ISO-2 country mappings for instant 0ms client detection & localhost fallback
const TIMEZONE_TO_COUNTRY = {
  // Listed countries
  'Asia/Jakarta': 'id',
  'Asia/Pontianak': 'id',
  'Asia/Makassar': 'id',
  'Asia/Jayapura': 'id',
  'Asia/Kuala_Lumpur': 'my',
  'Asia/Kuching': 'my',
  'Asia/Singapore': 'sg',
  'Asia/Manila': 'ph',
  'Asia/Bangkok': 'th',
  'Asia/Ho_Chi_Minh': 'vn',
  'Asia/Saigon': 'vn',
  'Asia/Tokyo': 'jp',
  'Asia/Seoul': 'kr',
  'Asia/Taipei': 'tw',
  'Asia/Kolkata': 'in',
  'Asia/Calcutta': 'in',
  'Australia/Sydney': 'au',
  'Australia/Melbourne': 'au',
  'Australia/Brisbane': 'au',
  'Australia/Perth': 'au',
  'Australia/Adelaide': 'au',
  'Australia/Darwin': 'au',
  'Australia/Hobart': 'au',
  'Europe/London': 'gb',
  'Europe/Berlin': 'de',
  'Europe/Paris': 'fr',
  'America/Sao_Paulo': 'br',
  'America/Fortaleza': 'br',
  'America/Recife': 'br',
  'America/Bahia': 'br',
  'America/Belem': 'br',
  'America/Manaus': 'br',
  'America/Mexico_City': 'mx',
  'America/Cancun': 'mx',
  'America/Monterrey': 'mx',
  'America/Tijuana': 'mx',
  'America/Toronto': 'ca',
  'America/Vancouver': 'ca',
  'America/Edmonton': 'ca',
  'America/Winnipeg': 'ca',
  'America/Halifax': 'ca',
  'America/Montreal': 'ca',
  'America/New_York': 'us',
  'America/Chicago': 'us',
  'America/Denver': 'us',
  'America/Los_Angeles': 'us',
  'America/Phoenix': 'us',
  'America/Anchorage': 'us',
  'Pacific/Honolulu': 'us',
  // Non-listed neighbors
  'Asia/Dili': 'tl',
  'Asia/Brunei': 'bn',
  'Asia/Phnom_Penh': 'kh',
  'Asia/Vientiane': 'la',
  'Asia/Yangon': 'mm',
  'Asia/Rangoon': 'mm',
  'Asia/Hong_Kong': 'hk',
  'Asia/Macau': 'mo',
  'Asia/Shanghai': 'cn',
  'Asia/Chongqing': 'cn',
  'Asia/Dhaka': 'bd',
  'Asia/Karachi': 'pk',
  'Asia/Colombo': 'lk',
  'Asia/Kathmandu': 'np',
  'Asia/Dubai': 'ae',
  'Asia/Riyadh': 'sa',
  'Asia/Qatar': 'qa',
  'Asia/Kuwait': 'kw',
  'Asia/Tehran': 'ir',
  'Asia/Baghdad': 'iq',
  'Asia/Jerusalem': 'il',
  'Asia/Amman': 'jo',
  'Asia/Beirut': 'lb',
  'Europe/Istanbul': 'tr',
  'Pacific/Auckland': 'nz',
  'Pacific/Port_Moresby': 'pg',
  'Pacific/Fiji': 'fj',
  'America/Argentina/Buenos_Aires': 'ar',
  'America/Buenos_Aires': 'ar',
  'America/Argentina/Cordoba': 'ar',
  'America/Argentina/Mendoza': 'ar',
  'America/Argentina/Salta': 'ar',
  'America/Argentina/Tucuman': 'ar',
  'America/Santiago': 'cl',
  'America/Montevideo': 'uy',
  'America/Asuncion': 'py',
  'America/La_Paz': 'bo',
  'America/Lima': 'pe',
  'America/Guayaquil': 'ec',
  'America/Bogota': 'co',
  'America/Caracas': 've',
  'America/Panama': 'pa',
  'America/Costa_Rica': 'cr',
  'America/Guatemala': 'gt',
  'America/Havana': 'cu',
  'America/Santo_Domingo': 'do',
  'America/Puerto_Rico': 'pr',
  'America/Jamaica': 'jm',
  'Europe/Dublin': 'ie',
  'Atlantic/Reykjavik': 'is',
  'Europe/Madrid': 'es',
  'Europe/Lisbon': 'pt',
  'Europe/Brussels': 'be',
  'Europe/Amsterdam': 'nl',
  'Europe/Zurich': 'ch',
  'Europe/Vienna': 'at',
  'Europe/Rome': 'it',
  'Europe/Warsaw': 'pl',
  'Europe/Prague': 'cz',
  'Europe/Budapest': 'hu',
  'Europe/Copenhagen': 'dk',
  'Europe/Oslo': 'no',
  'Europe/Stockholm': 'se',
  'Europe/Helsinki': 'fi',
  'Europe/Bucharest': 'ro',
  'Europe/Athens': 'gr',
  'Europe/Kyiv': 'ua',
  'Europe/Kiev': 'ua',
  'Europe/Moscow': 'ru',
  'Africa/Cairo': 'eg',
  'Africa/Casablanca': 'ma',
  'Africa/Lagos': 'ng',
  'Africa/Nairobi': 'ke',
  'Africa/Johannesburg': 'za',
};

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function findNearestListedByCoords(lat, lon) {
  const nLat = Number(lat);
  const nLon = Number(lon);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLon)) return null;

  let bestCode = TRENDING_COUNTRIES[0].code;
  let bestDist = Infinity;
  for (const c of TRENDING_COUNTRIES) {
    const dist = haversineKm(nLat, nLon, c.lat, c.lon);
    if (dist < bestDist) {
      bestDist = dist;
      bestCode = c.code;
    }
  }
  return bestCode;
}

function extractCountryFromTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return null;
  const clean = tz.trim();
  if (TIMEZONE_TO_COUNTRY[clean]) return TIMEZONE_TO_COUNTRY[clean];
  if (clean.startsWith('America/Argentina/')) return 'ar';
  if (clean.startsWith('Australia/')) return 'au';
  if (clean.startsWith('America/Indiana/') || clean.startsWith('America/Kentucky/') || clean.startsWith('US/')) {
    return 'us';
  }
  if (clean.startsWith('Canada/')) return 'ca';
  if (clean.startsWith('Brazil/')) return 'br';
  if (clean.startsWith('Mexico/')) return 'mx';
  return null;
}

function extractCountryFromLocale(locale) {
  if (!locale || typeof locale !== 'string') return null;
  // Match BCP-47 region subtag, e.g. "es-AR", "pt-TL", "en-US", "zh-Hant-TW"
  const parts = locale.trim().replace(/_/g, '-').split('-');
  for (let i = parts.length - 1; i >= 1; i--) {
    if (/^[a-zA-Z]{2}$/.test(parts[i])) {
      return parts[i].toLowerCase();
    }
  }
  return null;
}

export function resolveNearestTrendingRegion({
  countryCode = null,
  lat = null,
  lon = null,
  timeZone = null,
  locale = null,
  fallback = 'id',
} = {}) {
  const code = countryCode ? String(countryCode).trim().toLowerCase() : null;

  // 1. Direct exact match against the 18 listed countries
  if (code && TRENDING_COUNTRY_CODES.has(code)) {
    return code;
  }

  // 2. Exact coordinate Haversine distance when lat/lon is known (IP geolocation)
  if (lat !== null && lon !== null && lat !== undefined && lon !== undefined) {
    const nearest = findNearestListedByCoords(lat, lon);
    if (nearest) return nearest;
  }

  // 3. ISO-2 country centroid lookup -> Haversine nearest listed country
  if (code && COUNTRY_CENTROIDS[code]) {
    const [cLat, cLon] = COUNTRY_CENTROIDS[code];
    const nearest = findNearestListedByCoords(cLat, cLon);
    if (nearest) return nearest;
  }

  // 4. IANA timezone fallback
  const tzCountry = extractCountryFromTimeZone(timeZone);
  if (tzCountry) {
    if (TRENDING_COUNTRY_CODES.has(tzCountry)) return tzCountry;
    if (COUNTRY_CENTROIDS[tzCountry]) {
      const [cLat, cLon] = COUNTRY_CENTROIDS[tzCountry];
      const nearest = findNearestListedByCoords(cLat, cLon);
      if (nearest) return nearest;
    }
  }

  // 5. Locale region subtag fallback (e.g. es-AR -> ar -> br)
  const locCountry = extractCountryFromLocale(locale);
  if (locCountry) {
    if (TRENDING_COUNTRY_CODES.has(locCountry)) return locCountry;
    if (COUNTRY_CENTROIDS[locCountry]) {
      const [cLat, cLon] = COUNTRY_CENTROIDS[locCountry];
      const nearest = findNearestListedByCoords(cLat, cLon);
      if (nearest) return nearest;
    }
  }

  // 6. Coarse continent timezone fallback when city isn't in TIMEZONE_TO_COUNTRY
  if (typeof timeZone === 'string') {
    if (timeZone.startsWith('Europe/')) return 'de';
    if (timeZone.startsWith('America/')) return 'us';
    if (timeZone.startsWith('Australia/') || timeZone.startsWith('Pacific/')) return 'au';
    if (timeZone.startsWith('Asia/')) return 'id';
    if (timeZone.startsWith('Africa/')) return 'fr';
  }

  return fallback;
}

export function detectBrowserTrendingRegion() {
  let timeZone = null;
  let locale = null;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {}
  try {
    locale = (Array.isArray(navigator.languages) && navigator.languages[0]) || navigator.language || null;
  } catch {}
  return resolveNearestTrendingRegion({ timeZone, locale, fallback: 'id' });
}
