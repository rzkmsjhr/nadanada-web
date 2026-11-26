import {
  containsArabic,
  containsJapanese,
  containsThai,
  getArtistCrossScriptAliases,
  getTitleCrossScriptAliases,
  kanaToRomaji,
  katakanaLoanwordPhoneticMatches,
  normalizeArabic,
  normalizeThai,
  parseMultilingualMetadata,
  stripLatinDiacritics,
} from './scriptUtils.js';

const FEAT_REGEX = /\b(feat|featuring|ft)\.?\s+.*$/i;
const BRACKETS_REGEX = /[\(\[\{【〔〈《「『].*?[\)\]\}】〕〉》」』]/g;
const NON_ALPHANUM_REGEX = /[^\p{L}\p{N}\p{M}]/gu;
const MULTI_SPACE_REGEX = /\s+/g;
const ARTIST_SPLIT_REGEX = /[,&/;|]|(?:\s+(?:feat\.?|ft\.?|featuring|with|x|and)\s+)/i;
const YOUTUBE_NOISE_REGEX =
  /\b(official\s*(?:music\s*)?video|official\s*audio|official\s*visualizer|lyrics?\s*(?:video)?|music\s*video|audio|visualizer|hd|hq|4k|1080p|720p|topic|clip\s*officiel|video\s*oficial|mv)\b/gi;

// Universal Edition Classifiers (ported 1:1 from Tauri matcher.rs)
const REMIX_REGEX =
  /\b(remix(?:es)?|club\s*mix|extended\s*mix|vip\s*mix|dub\s*mix|dance\s*mix|dance\s*remix|electro\s*mix|rework|bootleg|mashup|sped\s*up|speed\s*up|slow\s*version|slowed(?:\s*(?:&|and|\+)?\s*reverb)?|nightcore)\b|(?:[\(\[\{]\s*[^)\]\}]+?\s+edit\s*[\)\]\}]|\s+-\s+[^-]+?\s+edit\b|\b(?:radio|single|clean|dirty|explicit|dj|club|extended|short|long|album|video)\s+edit\b)/i;
const LIVE_REGEX =
  /\b(live\s*at|live\s*version|in\s*concert|live\s*in|live\s*from|tour\s*version|festival\s*live|hits\s+alive|alive\s*vol\w*|alive\s*\d{4}|live\s*sessions?|(?:london|red\s*rocks|vegas|mtv\s*unplugged|bbc|spotify|itunes|aol)\s+sessions?)\b|[\(\[\{]\s*(?:live|live\s+[^)\]\}]+)\s*[\)\]\}]|\s+-\s+live\b|(现场|演唱会|秀场音乐|秀场|现场版)/i;
const ACOUSTIC_REGEX =
  /\b(acoustic|unplugged|stripped|piano\s*version|orchestral\s*version)\b|[\(\[\{]\s*(?:acoustic|piano|orchestral)\s*[\)\]\}]|(?:\s+-\s+(?:acoustic|unplugged)\b)/i;
const INSTRUMENTAL_REGEX =
  /\b(instrumental|instrumen|karaoke|karoke|backing\s*track|minus\s*(?:one|1)|minusone|minus-one|minus-1|off[\s-]*vocals?|no\s*(?:lead\s*)?vocals?|without\s*(?:lead\s*)?vocals?|w\/o\s*(?:lead\s*)?vocals?|with\s*backing\s*vocals?|backing\s*vocals?\s*only|(?:lead\s*)?vocal\s*removed|accompaniment|singback|performance\s*track|tv\s*track|tanpa\s*vokal)\b|\binst(?:\.(?!\w)|\b)|(?:\s|^|[\(\[\{])-\s*1(?:\s|$|[\)\]\}])|(伴奏|原版伴奏|纯音乐|純音樂|輕音樂|轻音乐|器樂|器乐|伴唱|消音)/i;
const SOLO_INSTRUMENT_ALBUM_REGEX = /(?:鋼琴|钢琴|薩克斯|萨克斯|小提琴|八音盒|古箏|古筝|吉他曲|純吉他|纯吉他)/i;
const SOUNDTRACK_REGEX =
  /\b(soundtrack|ost|motion\s*picture)\b|(电影主题曲|电视剧主题曲|影视原声|电影原声)/i;
const RERECORDED_REGEX = /\b(re-record\w*|rerecord\w*|re-cut|recut|taylor'?s\s+version)\b/i;
const COVER_REGEX =
  /\b(originally\s*performed\s*by|made\s*popular\s*by|in\s*the\s*style\s*of|tribute\s*version|tribute\s*to)\b|[\(\[\{]\s*cover\s*[\)\]\}]|\s+-\s+cover\b/i;
const DEMO_REGEX =
  /[\(\[\{]\s*(?:demo|rough\s*mix|work\s*tape)\b|\b(?:demo\s*version|early\s*demo)\b|\s+-\s+demo\b/i;
const ADVISORY_TAG_REGEX = /[\(\[\{]\s*(?:explicit|clean)\s*[\)\]\}]/gi;

export const DELUXE_ALBUM_REGEX =
  /\b(expanded(\s*edition)?|super\s*deluxe(\s*edition)?|deluxe(\s*edition)?|special\s*edition|bonus\s*track\s*edition|anniversary(\s*edition)?|collector('?s)?\s*edition|tour\s*edition)\b/i;
export const COMPILATION_ALBUM_REGEX =
  /\b(greatest\s*hits|best\s*of|hits\s*vol\w*|volume\s*\d+|vol\.\s*\d+|the\s*collection|anthology|compilation|various\s*artists|essential|the\s+ultimate|ultimate\s+(?:collection|hits|love\s+songs|best)|the\s+singles|now\s+that'?s\s+what\s+i\s+call|top\s+hits|hits\s*&\s*ballads)\b|(?:合集|珍藏|精选|精選|推荐金曲|推薦金曲|金曲|老歌)/i;
const CN_MEDIA_TIE_IN_REGEX =
  /(?:\s*[-—–]\s*)?《[^》]+》\s*(?:动画|电影|电视剧|网剧|动漫|游戏|影视|综艺|纪录片|舞台剧|音乐剧|广播剧)?\s*(?:主题曲|插曲|片尾曲|片头曲|推广曲|宣传曲|原声|配乐|背景音乐|概念曲|印象曲|片中曲|同名曲|ost)*/gi;

export const KNOWN_UPSTREAM_MISMATCHES = new Set([
  '168395054749057024', // Dewa 19 - Aku Milikmu (2021 Virzha)
  '168589766881927168', // Dewa 19 feat. Virzha - Aku Milikmu
  '168395069831774208', // Dewa 19 - Tak Kan Ada Cinta Yang Lain (2021 Ello)
  '168395062953115648', // Dewa 19 - Mahameru (2021 Virzha)
  '162001181', // Kuwo fake tag: Panem. The Land sound-alike cover of Feel It Still
  'kuwo_162001181',
  '228981606', // Kuwo mislabeled: Andra & The Backbone - Main Hati (audio is Kepayang)
  'kuwo_228981606',
  '228983127', // Kuwo mislabeled: Andra & The Backbone - Kepayang (audio is Hitamku)
  'kuwo_228983127',
  '5266278', // Kuwo: Maroon 5 - Animals (2015 Victoria's Secret runway music)
  'kuwo_5266278',
  '196763238', // Kuwo: Imagine Dragons - Demons (TELYKast Remix)
  'kuwo_196763238',
  '198259372', // Kuwo: Imagine Dragons - Demons (Live From Red Rocks / Hits Alive Vol.4)
  'kuwo_198259372',
  '238687094', // Kuwo: Imagine Dragons - Demons (Live London Sessions / Super Deluxe)
  'kuwo_238687094',
  '238687044', // Kuwo: Imagine Dragons - Demons (TELYKast Remix on Super Deluxe)
  'kuwo_238687044',
  '662121810', // Kuwo: Bon Jovi - It's My Life (2003 acoustic/piano remake mislabeled as original)
  'kuwo_662121810',
]);

export function cleanString(str = '') {
  const lower = String(str || '').toLowerCase();
  const withoutTieIn = lower.replace(CN_MEDIA_TIE_IN_REGEX, '');
  const withoutFeat = withoutTieIn.replace(FEAT_REGEX, '');
  const withoutBrackets = withoutFeat.replace(BRACKETS_REGEX, '');
  const deaccented = stripLatinDiacritics(withoutBrackets);
  let normalized = deaccented;
  if (containsArabic(normalized)) normalized = normalizeArabic(normalized);
  else if (containsThai(normalized)) normalized = normalizeThai(normalized);
  return normalized.replace(NON_ALPHANUM_REGEX, '').trim();
}

export function normalizeComparableTitle(rawTitle = '') {
  const lower = String(rawTitle || '').toLowerCase();
  const withoutTieIn = lower.replace(CN_MEDIA_TIE_IN_REGEX, ' ');
  const withoutNoise = withoutTieIn.replace(YOUTUBE_NOISE_REGEX, ' ');
  const deaccented = stripLatinDiacritics(withoutNoise);
  let normalized = deaccented;
  if (containsArabic(normalized)) normalized = normalizeArabic(normalized);
  else if (containsThai(normalized)) normalized = normalizeThai(normalized);
  return normalized.replace(NON_ALPHANUM_REGEX, '').trim();
}

export function detectEditions(title = '', album = null) {
  const rawTitle = String(title || '');
  const rawAlbum = album ? String(album) : '';
  const rawText = rawAlbum ? `${rawTitle} ${rawAlbum}` : rawTitle;
  const isAlbumSoundtrack = rawAlbum ? SOUNDTRACK_REGEX.test(rawAlbum) : false;
  const effectiveTitle = isAlbumSoundtrack ? rawTitle : rawTitle.replace(CN_MEDIA_TIE_IN_REGEX, '');
  const text = rawAlbum ? `${effectiveTitle} ${rawAlbum}` : effectiveTitle;

  const editions = new Set();
  if (REMIX_REGEX.test(text)) editions.add('remix');
  if (LIVE_REGEX.test(text)) editions.add('live');
  if (ACOUSTIC_REGEX.test(text)) editions.add('acoustic');
  if (INSTRUMENTAL_REGEX.test(text)) editions.add('instrumental');
  if (rawAlbum && SOLO_INSTRUMENT_ALBUM_REGEX.test(rawAlbum) && !SOLO_INSTRUMENT_ALBUM_REGEX.test(rawTitle)) {
    editions.add('instrumental');
  }
  // Check soundtrack against raw text so Chinese movie theme tie-ins (e.g. "《九层妖塔》电影主题曲") are caught
  if (SOUNDTRACK_REGEX.test(rawText)) editions.add('soundtrack');
  if (RERECORDED_REGEX.test(text)) editions.add('rerecorded');
  if (COVER_REGEX.test(text)) editions.add('cover');
  if (DEMO_REGEX.test(text)) editions.add('demo');
  return editions;
}

export function evaluateEditionCompatibility(targetEditions, candEditions) {
  if (targetEditions.size === 0) {
    return candEditions.size === 0;
  }
  if (targetEditions.size !== candEditions.size) return false;
  for (const e of targetEditions) {
    if (!candEditions.has(e)) return false;
  }
  return true;
}

function normalizeArtistToken(s = '') {
  const lower = String(s || '').toLowerCase();
  const noTopic = lower.replace(/- topic/g, '').replace(/\btopic\b/g, '');
  const noVevo = noTopic.replace(/vevo/g, '');
  const deaccented = stripLatinDiacritics(noVevo);
  const alnum = deaccented.replace(NON_ALPHANUM_REGEX, ' ');
  return alnum.replace(MULTI_SPACE_REGEX, ' ').trim();
}

export function splitArtistList(s = '') {
  const raw = String(s || '').trim();
  if (!raw) return [];
  const parts = raw
    .split(ARTIST_SPLIT_REGEX)
    .map(normalizeArtistToken)
    .filter(Boolean);
  const full = normalizeArtistToken(raw);
  if (full && !parts.includes(full)) parts.push(full);
  return parts;
}

export function doesArtistMatch(targetArtist = '', candidateArtist = '', targetTitle = '') {
  const targetList = splitArtistList(targetArtist);
  const candList = splitArtistList(candidateArtist);

  // 1. Bidirectional cross-script alias check
  const targetAliases = getArtistCrossScriptAliases(targetArtist);
  const candAliases = getArtistCrossScriptAliases(candidateArtist);

  for (const c of candList) {
    const cClean = cleanString(c);
    if (cClean && targetAliases.some((a) => cleanString(a) === cClean)) return true;
  }
  for (const t of targetList) {
    const tClean = cleanString(t);
    if (tClean && candAliases.some((a) => cleanString(a) === tClean)) return true;
  }

  // 2. Check if target title contains candidate artist or its cross-script aliases
  const lowerTitle = String(targetTitle || '').toLowerCase();
  for (const a of candAliases) {
    if (a && lowerTitle.includes(a.toLowerCase())) return true;
  }
  for (const c of candList) {
    if (c && lowerTitle.includes(c.toLowerCase())) return true;
  }

  if (targetList.length === 0 || candList.length === 0) return false;

  let hasPrimaryMatch = false;
  for (const t of targetList) {
    const tClean = cleanString(t);
    const tCompact = t.replace(/\s+/g, '');
    const tNoThe = t.startsWith('the ') ? t.slice(4).trim() : t;

    for (const c of candList) {
      if (t === c || (tClean && tClean === cleanString(c))) {
        hasPrimaryMatch = true;
        break;
      }
      const cCompact = c.replace(/\s+/g, '');
      if (tCompact.length >= 2 && tCompact === cCompact) {
        hasPrimaryMatch = true;
        break;
      }
      const cNoThe = c.startsWith('the ') ? c.slice(4).trim() : c;
      if (tNoThe.length >= 3 && tNoThe === cNoThe) {
        hasPrimaryMatch = true;
        break;
      }
    }
    if (hasPrimaryMatch) break;
  }

  if (!hasPrimaryMatch) return false;

  // 3. Reject candidate artist introducing feat./ft. when target did not request it
  const lowerTarget = `${targetArtist} ${targetTitle}`.toLowerCase();
  const lowerCand = String(candidateArtist || '').toLowerCase();
  if (
    (lowerCand.includes('feat') || lowerCand.includes('ft.')) &&
    !lowerTarget.includes('feat') &&
    !lowerTarget.includes('ft.')
  ) {
    return false;
  }

  return true;
}

export function isKnownUpstreamMismatch(id = '', candTitle = '', targetTitle = '') {
  const idStr = String(id || '').trim();
  const rawNumeric = idStr.replace(/^(?:kuwo_|wyy_)/i, '');
  const candLower = String(candTitle || '').toLowerCase();
  const targetLower = String(targetTitle || '').toLowerCase();

  const targetRequestedRemake =
    targetLower.includes('virzha') ||
    targetLower.includes('ello') ||
    targetLower.includes('2021') ||
    targetLower.includes('remake');

  if (KNOWN_UPSTREAM_MISMATCHES.has(idStr) || (rawNumeric && KNOWN_UPSTREAM_MISMATCHES.has(rawNumeric))) {
    if (!targetRequestedRemake) return true;
  }

  if (
    !targetRequestedRemake &&
    (candLower.includes('virzha') ||
      candLower.includes('ello') ||
      candLower.includes('2021') ||
      candLower.includes('remake'))
  ) {
    return true;
  }

  return false;
}

export function scoreTrackCandidate({
  targetTitle = '',
  targetArtist = '',
  targetDurSecs = 0,
  targetIsrc = null,
  targetAlbum = null,
  candId = '',
  candTitle = '',
  candArtist = '',
  candDurSecs = 0,
  candIsrc = null,
  candAlbum = null,
  parsedMeta = null,
}) {
  // 0. Known upstream catalog corruption / remake blacklist
  if (isKnownUpstreamMismatch(candId, candTitle, targetTitle)) {
    return 0;
  }

  // 1. Universal Edition Matrix Compatibility
  const targetEditions = detectEditions(targetTitle, targetAlbum);
  const candEditions = detectEditions(candTitle, candAlbum);
  if (!evaluateEditionCompatibility(targetEditions, candEditions)) {
    return 0;
  }

  // 1b. Reject unwanted feature in candidate title when target did not request it
  const lowerTarget = `${targetArtist} ${targetTitle}`.toLowerCase();
  const lowerCandTitle = String(candTitle || '').toLowerCase();
  if (
    (lowerCandTitle.includes('feat.') ||
      lowerCandTitle.includes('feat ') ||
      lowerCandTitle.includes('ft.') ||
      lowerCandTitle.includes('ft ')) &&
    !lowerTarget.includes('feat') &&
    !lowerTarget.includes('ft.') &&
    !lowerTarget.includes('ft ')
  ) {
    return 0;
  }

  // 2. Exact ISRC match is definitive (after blacklist + edition + unwanted-feat gates)
  if (targetIsrc && candIsrc) {
    const tCleanIsrc = String(targetIsrc).trim().toLowerCase();
    const cCleanIsrc = String(candIsrc).trim().toLowerCase();
    if (tCleanIsrc && tCleanIsrc === cCleanIsrc) {
      return 200;
    }
  }

  // 3. Artist match check
  if (!doesArtistMatch(targetArtist, candArtist, targetTitle)) {
    return 0;
  }

  let score = 50; // Base score for artist match

  // Penalize extra unrequested collaborators in candidate artist (e.g. DJ edits / parody collabs)
  const targetList = splitArtistList(targetArtist);
  const candIndividualArtists = String(candArtist || '')
    .split(ARTIST_SPLIT_REGEX)
    .map(normalizeArtistToken)
    .filter(Boolean);
  const lowerTitleAndAlbum = `${targetTitle} ${targetAlbum || ''}`.toLowerCase();
  const targetArtistAliases = getArtistCrossScriptAliases(targetArtist);
  let unrequestedArtists = 0;
  for (const c of candIndividualArtists) {
    const cClean = cleanString(c);
    const inTargetList = targetList.some((t) => t === c || (cClean && cleanString(t) === cClean));
    const inTargetTitle = lowerTitleAndAlbum.includes(c.toLowerCase());
    if (!inTargetList && !inTargetTitle) {
      const isTargetAlias = cClean && targetArtistAliases.some((a) => cleanString(a) === cClean);
      const candSelfAliases = getArtistCrossScriptAliases(c);
      const isCandAliasInTarget = candSelfAliases.some(
        (a) =>
          (a && lowerTitleAndAlbum.includes(a.toLowerCase())) ||
          targetList.some((t) => cleanString(t) === cleanString(a))
      );
      if (!isTargetAlias && !isCandAliasInTarget) unrequestedArtists += 1;
    }
  }
  if (unrequestedArtists > 0) {
    score = Math.max(0, score - unrequestedArtists * 45);
  }

  // 4. Title comparison
  const targetClean = cleanString(targetTitle);
  const candClean = cleanString(candTitle);
  let titleMatched = false;

  if (targetClean && candClean) {
    if (targetClean === candClean) {
      score += 100;
      titleMatched = true;
    } else if (candClean.includes(targetClean) || targetClean.includes(candClean)) {
      const residue = Math.abs(targetClean.length - candClean.length);
      if (residue <= 3) score += 85;
      else if (residue <= 8) score += 65;
      else score += 45;
      titleMatched = true;
    }
  }

  const getMeta = () => parsedMeta || parseMultilingualMetadata(targetTitle, targetArtist);

  // 4b. Japanese Katakana / Romaji loanword check
  if (!titleMatched && (containsJapanese(targetTitle) || containsJapanese(candTitle))) {
    const meta = getMeta();
    const titleVariants = [targetClean, meta.extractedTitle, meta.nativeTitle].filter(Boolean);
    for (const variant of titleVariants) {
      const variantClean = cleanString(variant);
      if (!variantClean) continue;
      const romajiTarget = kanaToRomaji(variantClean);
      const romajiCand = kanaToRomaji(candClean);

      if (
        romajiTarget &&
        candClean &&
        (romajiTarget === candClean || romajiCand === variantClean || romajiTarget === romajiCand)
      ) {
        score += 90;
        titleMatched = true;
        break;
      }
      if (
        katakanaLoanwordPhoneticMatches(romajiTarget, candClean) ||
        katakanaLoanwordPhoneticMatches(romajiCand, variantClean)
      ) {
        score += 85;
        titleMatched = true;
        break;
      }
    }
  }

  // 4c. Bilingual title check (nativeTitle / extractedTitle / latinTitle)
  if (!titleMatched) {
    const meta = getMeta();
    if (meta.nativeTitle) {
      const natClean = cleanString(meta.nativeTitle);
      if (natClean && candClean && (natClean === candClean || candClean.includes(natClean) || natClean.includes(candClean))) {
        score += 85;
        titleMatched = true;
      }
    }
    if (!titleMatched && meta.extractedTitle) {
      const extClean = cleanString(meta.extractedTitle);
      if (extClean && candClean && (extClean === candClean || candClean.includes(extClean) || extClean.includes(candClean))) {
        score += 85;
        titleMatched = true;
      }
    }
    if (!titleMatched && meta.latinTitle) {
      const latClean = cleanString(meta.latinTitle);
      if (latClean && candClean && (latClean === candClean || candClean.includes(latClean) || latClean.includes(candClean))) {
        score += 80;
        titleMatched = true;
      }
    }
  }

  // 4d. Bidirectional cross-script title alias check
  if (!titleMatched) {
    const meta = getMeta();
    const effectiveTitle = meta.extractedTitle || targetTitle;
    const tAliases = getTitleCrossScriptAliases(effectiveTitle);
    const cAliases = getTitleCrossScriptAliases(candTitle);

    for (const a of tAliases) {
      const aClean = cleanString(a);
      if (aClean && candClean && (aClean === candClean || candClean.includes(aClean) || aClean.includes(candClean))) {
        score += 85;
        titleMatched = true;
        break;
      }
    }
    if (!titleMatched) {
      for (const a of cAliases) {
        const aClean = cleanString(a);
        if (aClean && targetClean && (aClean === targetClean || targetClean.includes(aClean) || aClean.includes(targetClean))) {
          score += 85;
          titleMatched = true;
          break;
        }
      }
    }
  }

  // Title match is mandatory
  if (!titleMatched) {
    return 0;
  }

  // 5. Strict studio duration comparison
  if (targetDurSecs > 0 && candDurSecs > 0) {
    const diff = Math.abs(targetDurSecs - candDurSecs);
    const maxAllowedDiff =
      targetDurSecs > 350 ? Math.min(12, Math.max(7, Math.floor(targetDurSecs * 0.02))) : 7;

    if (diff > maxAllowedDiff) {
      return 0;
    }
    if (diff <= 2) score += 40;
    else if (diff <= 4) score += 15;
    else score = Math.max(0, score - 30);
  } else if (targetDurSecs > 0 && candDurSecs === 0) {
    score = Math.max(0, score - 25);
  }

  // 6. Tiered album comparison & compilation penalty
  if (candAlbum) {
    const cLower = String(candAlbum).toLowerCase();
    const targetIsComp = targetAlbum ? COMPILATION_ALBUM_REGEX.test(String(targetAlbum).toLowerCase()) : false;

    if (!targetIsComp && COMPILATION_ALBUM_REGEX.test(cLower)) {
      score = Math.max(0, score - 45);
    }

    if (targetAlbum) {
      const tClean = cleanString(targetAlbum);
      const cClean = cleanString(candAlbum);
      if (tClean && cClean) {
        const tHasDeluxe = DELUXE_ALBUM_REGEX.test(String(targetAlbum).toLowerCase());
        const cHasDeluxe = DELUXE_ALBUM_REGEX.test(cLower);

        if (tClean === cClean) {
          score += !cHasDeluxe ? 65 : tHasDeluxe ? 45 : 30;
        } else if (tClean.includes(cClean) || cClean.includes(tClean)) {
          score += !cHasDeluxe ? 35 : tHasDeluxe ? 25 : 20;
        } else {
          score = Math.max(0, score - 25);
        }
      }
    }
  }

  return score;
}

/**
 * Normalize an album title for exact edition bucketing: strips only (Explicit)/(Clean) tags
 * so canonical editions stay separate from Deluxe/Anniversary multi-disc boxsets while matching across providers.
 */
export function normalizeExactAlbumKey(rawAlbum = '') {
  const lower = String(rawAlbum || '').toLowerCase();
  const withoutAdvisory = lower.replace(ADVISORY_TAG_REGEX, '');
  const deaccented = stripLatinDiacritics(withoutAdvisory);
  let normalized = deaccented;
  if (containsArabic(normalized)) normalized = normalizeArabic(normalized);
  else if (containsThai(normalized)) normalized = normalizeThai(normalized);
  return normalized.replace(NON_ALPHANUM_REGEX, '').trim();
}

/**
 * Restore stripped edition tags (e.g. "(Instrumental)", "(Live)", "(Demo)") from an official
 * album track title while preserving any edition classifiers already present on rawTitle.
 */
export function resolveEffectiveCandidateTitle(rawTitle = '', officialTitle = '', album = null) {
  const raw = String(rawTitle || '').trim();
  const official = String(officialTitle || '').trim();
  if (!official) return raw;
  if (!raw) return official;

  const rawEd = detectEditions(raw, album);
  const offEd = detectEditions(official, album);

  for (const ed of offEd) {
    if (!rawEd.has(ed)) return official;
  }
  for (const ed of rawEd) {
    if (!offEd.has(ed)) return raw;
  }
  return official;
}

/**
 * Collects (idNum, durationSecs, trackNum, searchIndex) entries per (cleanTitle, exactAlbumKey) inside a hi.cn search batch.
 * Keeps canonical 1-disc studio albums isolated from Deluxe/Anniversary multi-cut re-issues.
 */
export function computeAlbumTitleMinIds(candidates = [], targetEditions = null) {
  const groupMap = new Map();
  for (let idx = 0; idx < candidates.length; idx++) {
    const c = candidates[idx];
    const effectiveTitle = c?.effective_name || c?.name || c?.title || '';
    const rawAlbum = c?.album_name || c?.album || '';
    const ct = cleanString(effectiveTitle);
    const ca = normalizeExactAlbumKey(rawAlbum);
    if (!ct || !ca) continue;
    if (targetEditions && !evaluateEditionCompatibility(targetEditions, detectEditions(effectiveTitle, rawAlbum))) {
      continue;
    }
    const key = `${ct}:::${ca}`;
    const idNum = parseNumericTrackId(c?.id);
    const dur = Number(c?.duration) || 0;
    const trackNum = Number(c?.trackNum ?? c?._kuwoTrackNum) || 0;
    const searchIndex = Number.isInteger(c?.searchIndex)
      ? c.searchIndex
      : Number.isInteger(c?._searchIndex)
        ? c._searchIndex
        : idx;
    let list = groupMap.get(key);
    if (!list) {
      list = [];
      groupMap.set(key, list);
    }
    list.push({ idNum, dur, trackNum, searchIndex });
  }
  return groupMap;
}

export function applyDuplicateTitleTrackPenalty(
  score,
  candTitle,
  candAlbum,
  candId,
  albumTitleGroups,
  candDurSecs = 0,
  candTrackNum = 0,
  candSearchIndex = -1
) {
  if (!albumTitleGroups || score <= 0) return score;
  const ct = cleanString(candTitle || '');
  const ca = normalizeExactAlbumKey(candAlbum || '');
  if (!ct || !ca) return score;
  const entries = albumTitleGroups.get(`${ct}:::${ca}`);
  if (!entries || entries.length < 2) return score;

  const idNum = parseNumericTrackId(candId);
  const dur = Number(candDurSecs) || 0;
  const isMatchingDurationSibling = (e) => {
    if (dur > 0 && e.dur > 0) {
      return Math.abs(dur - e.dur) <= 8;
    }
    return true;
  };

  const selfEntry = entries.find((e) => e.idNum === idNum);
  const effectiveTrackNum = candTrackNum > 0 ? candTrackNum : selfEntry?.trackNum || 0;
  const effectiveSearchIndex = candSearchIndex >= 0 ? candSearchIndex : (selfEntry?.searchIndex ?? -1);

  const sameDurSiblings = entries.filter((e) => e.idNum !== idNum && isMatchingDurationSibling(e));
  if (sameDurSiblings.length === 0) return score;

  // Sub-rule A1: authoritative official album track order (Track 1 beats Track 2+ even when Track 2 has a lower numeric ID)
  const sameDurSiblingsWithTrackNum = sameDurSiblings.filter((e) => e.trackNum > 0);
  if (effectiveTrackNum > 0 && sameDurSiblingsWithTrackNum.length > 0) {
    if (sameDurSiblingsWithTrackNum.some((e) => e.trackNum < effectiveTrackNum)) {
      return Math.max(0, score - 60);
    }
  } else {
    // Sub-rule A2: adjacent-ID fallback when official track numbers are unavailable (prefer search relevance rank over lower numeric ID)
    const adjacentSiblings = sameDurSiblings.filter((e) => Math.abs(idNum - e.idNum) <= 50);
    if (adjacentSiblings.length > 0) {
      const adjacentWithRank = adjacentSiblings.filter((e) => e.searchIndex >= 0);
      if (effectiveSearchIndex >= 0 && adjacentWithRank.length > 0) {
        if (adjacentWithRank.some((e) => e.searchIndex < effectiveSearchIndex)) {
          return Math.max(0, score - 60);
        }
      } else if (adjacentSiblings.some((e) => e.idNum < idNum)) {
        return Math.max(0, score - 60);
      }
    }
  }

  // Sub-rule B: multi-million-apart multi-cut boxset ambiguity when official track numbers aren't known
  if (effectiveTrackNum === 0 || sameDurSiblingsWithTrackNum.length === 0) {
    const hasDistantMultiCutSibling = sameDurSiblings.some((e) => Math.abs(idNum - e.idNum) > 50);
    if (hasDistantMultiCutSibling) {
      return Math.max(0, score - 35);
    }
  }
  return score;
}

/**
 * Index compatible vs excluded edition durations from a well-labelled reference provider catalog
 * so unlabelled Kuwo cuts at an excluded edition's exact duration can be filtered out.
 */
export function buildExcludedEditionDurationMap(
  referenceCandidates = [],
  targetTitle = '',
  targetArtist = '',
  targetAlbum = null
) {
  const oracleMap = new Map();
  if (!Array.isArray(referenceCandidates) || referenceCandidates.length === 0) return oracleMap;

  const targetEditions = detectEditions(targetTitle, targetAlbum);
  const recordKey = (key, dur, isCompatible) => {
    let bucket = oracleMap.get(key);
    if (!bucket) {
      bucket = { cleanDurs: new Set(), excludedDurs: new Set() };
      oracleMap.set(key, bucket);
    }
    if (isCompatible) bucket.cleanDurs.add(dur);
    else bucket.excludedDurs.add(dur);
  };

  for (const r of referenceCandidates) {
    if (!r || typeof r !== 'object') continue;
    const rTitle = r.effective_name || r.name || r.title || '';
    const rArtist = r.artist || '';
    if (!doesArtistMatch(targetArtist, rArtist, targetTitle)) continue;

    const ct = cleanString(rTitle);
    const rawAlb = r.album_name || r.album || '';
    const exactAlb = normalizeExactAlbumKey(rawAlb);
    if (!ct || !exactAlb) continue;

    const dur = Math.round(Number(r.duration) || 0);
    if (!(dur > 0)) continue;

    const candEditions = detectEditions(rTitle, rawAlb || null);
    const isCompatible = evaluateEditionCompatibility(targetEditions, candEditions);
    recordKey(`exact:${ct}:::${exactAlb}`, dur, isCompatible);

    const baseAlb = cleanString(rawAlb);
    if (baseAlb) {
      recordKey(`base:${ct}:::${baseAlb}`, dur, isCompatible);
    }
  }
  return oracleMap;
}

export function isExcludedDurationByCrossProviderOracle(candTitle, candAlbum, candDurSecs, oracleMap) {
  if (!oracleMap || oracleMap.size === 0 || !(candDurSecs > 0)) return false;
  const ct = cleanString(candTitle || '');
  const exactAlb = normalizeExactAlbumKey(candAlbum || '');
  if (!ct || !exactAlb) return false;

  const baseAlb = cleanString(candAlbum || '');
  const bucket =
    oracleMap.get(`exact:${ct}:::${exactAlb}`) ||
    (baseAlb ? oracleMap.get(`base:${ct}:::${baseAlb}`) : null);
  if (!bucket) return false;

  const dur = Math.round(Number(candDurSecs) || 0);
  return bucket.excludedDurs.has(dur) && !bucket.cleanDurs.has(dur);
}

export function parseNumericTrackId(id) {
  const stripped = String(id ?? '').replace(/^(?:kuwo_|wyy_)/i, '').trim();
  const n = Number(stripped);
  return Number.isFinite(n) && stripped !== '' ? n : Number.MAX_SAFE_INTEGER;
}
