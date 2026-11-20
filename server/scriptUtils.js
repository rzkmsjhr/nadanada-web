const VIDEO_NOISE_REGEX =
  /\b(official\s*(?:music\s*)?video|official\s*audio|official\s*visualizer|lyrics?\s*(?:video)?|music\s*video|audio|visualizer|hd|hq|4k|1080p|720p|topic|clip\s*officiel|video\s*oficial|mv|m\/v|full\s*ver(?:sion)?|dance\s*practice|teaser|trailer)\b/gi;
const BRACKET_STRIP_REGEX = /[\(\[\{【〔〈《「『].*?[\)\]\}】〕〉》」』]/g;
const BRACKET_CONTENT_REGEX = /[\(\[\{【〔〈《「『]([^\)\]\}】〕〉》」』]+)[\)\]\}】〕〉》」』]/g;

export function containsCjk(s = '') {
  return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF\uAC00-\uD7AF\u1100-\u11FF]/.test(s);
}

export function containsJapanese(s = '') {
  return /[\u3040-\u309F\u30A0-\u30FF]/.test(s);
}

export function containsArabic(s = '') {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(s);
}

export function containsThai(s = '') {
  return /[\u0E00-\u0E7F]/.test(s);
}

export function containsCyrillic(s = '') {
  return /[\u0400-\u04FF]/.test(s);
}

export function containsNonLatin(s = '') {
  return containsCjk(s) || containsArabic(s) || containsThai(s) || containsCyrillic(s);
}

export function containsLatin(s = '') {
  return /[a-zA-Z]/.test(s);
}

const DIACRITICS_MAP = {
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a', ā: 'a', ă: 'a', ą: 'a',
  À: 'A', Á: 'A', Â: 'A', Ã: 'A', Ä: 'A', Å: 'A', Ā: 'A', Ă: 'A', Ą: 'A',
  è: 'e', é: 'e', ê: 'e', ë: 'e', ē: 'e', ĕ: 'e', ė: 'e', ę: 'e', ě: 'e',
  È: 'E', É: 'E', Ê: 'E', Ë: 'E', Ē: 'E', Ĕ: 'E', Ė: 'E', Ę: 'E', Ě: 'E',
  ì: 'i', í: 'i', î: 'i', ï: 'i', ī: 'i', ĭ: 'i', į: 'i', ı: 'i',
  Ì: 'I', Í: 'I', Î: 'I', Ï: 'I', Ī: 'I', Ĭ: 'I', Į: 'I', İ: 'I',
  ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o', ø: 'o', ō: 'o', ŏ: 'o', ő: 'o',
  Ò: 'O', Ó: 'O', Ô: 'O', Õ: 'O', Ö: 'O', Ø: 'O', Ō: 'O', Ŏ: 'O', Ő: 'O',
  ù: 'u', ú: 'u', û: 'u', ü: 'u', ū: 'u', ŭ: 'u', ů: 'u', ű: 'u', ų: 'u',
  Ù: 'U', Ú: 'U', Û: 'U', Ü: 'U', Ū: 'U', Ŭ: 'U', Ů: 'U', Ű: 'U', Ų: 'U',
  ý: 'y', ỳ: 'y', ŷ: 'y', ÿ: 'y', Ý: 'Y', Ỳ: 'Y', Ŷ: 'Y', Ÿ: 'Y',
  ñ: 'n', ń: 'n', ņ: 'n', ň: 'n', Ñ: 'N', Ń: 'N', Ņ: 'N', Ň: 'N',
  ç: 'c', ć: 'c', ĉ: 'c', ċ: 'c', č: 'c', Ç: 'C', Ć: 'C', Ĉ: 'C', Ċ: 'C', Č: 'C',
  ś: 's', ŝ: 's', ş: 's', ș: 's', š: 's', Ś: 'S', Ŝ: 'S', Ş: 'S', Ș: 'S', Š: 'S',
  ź: 'z', ż: 'z', ž: 'z', Ź: 'Z', Ż: 'Z', Ž: 'Z',
  ð: 'd', đ: 'd', Ð: 'D', Đ: 'D', ł: 'l', Ł: 'L', ß: 's',
};

export function stripLatinDiacritics(s = '') {
  return [...s].map((c) => DIACRITICS_MAP[c] || c).join('');
}

export function normalizeArabic(s = '') {
  let out = '';
  for (const c of s) {
    const code = c.charCodeAt(0);
    if ((code >= 0x064b && code <= 0x0652) || code === 0x0670 || code === 0x0640) continue;
    if (c === 'أ' || c === 'إ' || c === 'آ' || c === 'ٱ') out += 'ا';
    else if (c === 'ة') out += 'ه';
    else if (c === 'ى') out += 'ي';
    else out += c;
  }
  return out;
}

export function normalizeThai(s = '') {
  return s.replace(/[\u0E48-\u0E4E]/g, '');
}

const SINGLE_KANA = {
  あ: 'a', ア: 'a', い: 'i', イ: 'i', う: 'u', ウ: 'u', え: 'e', エ: 'e', お: 'o', オ: 'o',
  か: 'ka', カ: 'ka', き: 'ki', キ: 'ki', く: 'ku', ク: 'ku', け: 'ke', ケ: 'ke', こ: 'ko', コ: 'ko',
  が: 'ga', ガ: 'ga', ぎ: 'gi', ギ: 'gi', ぐ: 'gu', グ: 'gu', げ: 'ge', ゲ: 'ge', ご: 'go', ゴ: 'go',
  さ: 'sa', サ: 'sa', し: 'shi', シ: 'shi', す: 'su', ス: 'su', せ: 'se', セ: 'se', そ: 'so', ソ: 'so',
  ざ: 'za', ザ: 'za', じ: 'ji', ジ: 'ji', ず: 'zu', ズ: 'zu', ぜ: 'ze', ゼ: 'ze', ぞ: 'zo', ゾ: 'zo',
  た: 'ta', タ: 'ta', ち: 'chi', チ: 'chi', つ: 'tsu', ツ: 'tsu', て: 'te', テ: 'te', と: 'to', ト: 'to',
  だ: 'da', ダ: 'da', ぢ: 'ji', ヂ: 'ji', づ: 'zu', ヅ: 'zu', で: 'de', デ: 'de', ど: 'do', ド: 'do',
  な: 'na', ナ: 'na', に: 'ni', ニ: 'ni', ぬ: 'nu', ヌ: 'nu', ね: 'ne', ネ: 'ne', の: 'no', ノ: 'no',
  は: 'ha', ハ: 'ha', ひ: 'hi', ヒ: 'hi', ふ: 'fu', フ: 'fu', へ: 'he', ヘ: 'he', ほ: 'ho', ホ: 'ho',
  ば: 'ba', バ: 'ba', び: 'bi', ビ: 'bi', ぶ: 'bu', ブ: 'bu', べ: 'be', ベ: 'be', ぼ: 'bo', ボ: 'bo',
  ぱ: 'pa', パ: 'pa', ぴ: 'pi', ピ: 'pi', ぷ: 'pu', プ: 'pu', ぺ: 'pe', ペ: 'pe', ぽ: 'po', ポ: 'po',
  ま: 'ma', マ: 'ma', み: 'mi', ミ: 'mi', む: 'mu', ム: 'mu', め: 'me', メ: 'me', も: 'mo', モ: 'mo',
  や: 'ya', ヤ: 'ya', ゆ: 'yu', ユ: 'yu', よ: 'yo', ヨ: 'yo',
  ら: 'ra', ラ: 'ra', り: 'ri', リ: 'ri', る: 'ru', ル: 'ru', れ: 're', レ: 're', ろ: 'ro', ロ: 'ro',
  わ: 'wa', ワ: 'wa', を: 'wo', ヲ: 'wo', ん: 'n', ン: 'n',
};

const PAIR_KANA = {
  しゃ: 'sha', シャ: 'sha', しゅ: 'shu', シュ: 'shu', しょ: 'sho', ショ: 'sho',
  じゃ: 'ja', ジャ: 'ja', じゅ: 'ju', ジュ: 'ju', じょ: 'jo', ジョ: 'jo',
  ちゃ: 'cha', チャ: 'cha', ちゅ: 'chu', チュ: 'chu', ちょ: 'cho', チョ: 'cho',
  きゃ: 'kya', キャ: 'kya', きゅ: 'kyu', キュ: 'kyu', きょ: 'kyo', キョ: 'kyo',
  ぎゃ: 'gya', ギャ: 'gya', ぎゅ: 'gyu', ギュ: 'gyu', ぎょ: 'gyo', ギョ: 'gyo',
  にゃ: 'nya', ニャ: 'nya', にゅ: 'nyu', ニュ: 'nyu', にょ: 'nyo', ニョ: 'nyo',
  ひゃ: 'hya', ヒャ: 'hya', ひゅ: 'hyu', ヒュ: 'hyu', ひょ: 'hyo', ヒョ: 'hyo',
  びゃ: 'bya', ビャ: 'bya', びゅ: 'byu', ビュ: 'byu', びょ: 'byo', ビョ: 'byo',
  ぴゃ: 'pya', ピャ: 'pya', ぴゅ: 'pyu', ピュ: 'pyu', ぴょ: 'pyo', ピョ: 'pyo',
  みゃ: 'mya', ミャ: 'mya', みゅ: 'myu', ミュ: 'myu', みょ: 'myo', ミョ: 'myo',
  りゃ: 'rya', リャ: 'rya', りゅ: 'ryu', リュ: 'ryu', りょ: 'ryo', リョ: 'ryo',
  てぃ: 'ti', ティ: 'ti', でぃ: 'di', ディ: 'di',
  ふぇ: 'fe', フェ: 'fe', ふぉ: 'fo', フォ: 'fo', ふぁ: 'fa', ファ: 'fa', ふぃ: 'fi', フィ: 'fi',
  うぇ: 'we', ウェ: 'we', うぉ: 'wo', ウォ: 'wo', うぃ: 'wi', ウィ: 'wi',
};

export function kanaToRomaji(s = '') {
  const chars = [...s];
  let result = '';
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    const next = i + 1 < chars.length ? chars[i + 1] : '';
    if (next && PAIR_KANA[c + next]) {
      result += PAIR_KANA[c + next];
      i += 2;
      continue;
    }
    if (c === 'っ' || c === 'ッ') {
      const nextR = SINGLE_KANA[next];
      if (nextR) result += nextR[0];
      i += 1;
      continue;
    }
    if (c === 'ー' || c === '―' || c === '‐') {
      const last = result[result.length - 1];
      if (last && 'aiueo'.includes(last)) result += last;
      i += 1;
      continue;
    }
    result += SINGLE_KANA[c] || c;
    i += 1;
  }
  return result;
}

export function katakanaLoanwordPhoneticMatches(romajiKana = '', english = '') {
  const k = romajiKana.toLowerCase().replace(/[\s\-_'・]/g, '');
  const e = english.toLowerCase().replace(/[\s\-_'・]/g, '');
  if (!k || !e) return false;
  if (k === e || k.includes(e) || e.includes(k)) return true;

  const loanwordK = k
    .replace(/shinguru/g, 'single')
    .replace(/singuru/g, 'single')
    .replace(/agein/g, 'again')
    .replace(/gein/g, 'gain')
    .replace(/purasutikku/g, 'plastic')
    .replace(/rabu/g, 'love')
    .replace(/rarabai/g, 'lullaby')
    .replace(/sutei/g, 'stay')
    .replace(/doa/g, 'door')
    .replace(/wizu/g, 'with')
    .replace(/mii/g, 'me')
    .replace(/dansu/g, 'dance')
    .replace(/bohemiang/g, 'bohemian')
    .replace(/rapusodi/g, 'rhapsody');

  if (loanwordK === e || loanwordK.includes(e) || e.includes(loanwordK)) return true;

  const simpK = loanwordK
    .replace(/sh/g, 's').replace(/ch/g, 'c').replace(/ts/g, 't')
    .replace(/ru/g, 'l').replace(/ri/g, 'li').replace(/ra/g, 'la').replace(/ro/g, 'lo')
    .replace(/r/g, 'l').replace(/zu/g, 'th').replace(/ji/g, 'zi');
  const simpE = e.replace(/sh/g, 's').replace(/ch/g, 'c').replace(/r/g, 'l').replace(/th/g, 's');
  return simpK === simpE || simpK.includes(simpE) || simpE.includes(simpK);
}

const ARTIST_ALIAS_TABLE = [
  [['mariya takeuchi', 'takeuchi mariya', 'mariyatakeuchi'], ['竹内まりや']],
  [['miki matsubara', 'matsubara miki', 'mikimatsubara'], ['松原みき']],
  [['hiromi iwasaki', 'iwasaki hiromi', 'hiromiiwasaki'], ['岩崎宏美']],
  [['tatsuro yamashita', 'yamashita tatsuro', 'tatsuroyamashita'], ['山下達郎']],
  [['akina nakamori', 'nakamori akina', 'akinanakamori'], ['中森明菜']],
  [['seiko matsuda', 'matsuda seiko', 'seikomatsuda'], ['松田聖子']],
  [['taeko ohnuki', 'taeko onuki', 'onuki taeko', 'taekoonuki'], ['大貫妙子']],
  [['anri'], ['杏里']],
  [['hikaru utada', 'utada hikaru', 'hikaruutada'], ['宇多田ヒカル']],
  [['toshiki kadomatsu', 'kadomatsu toshiki'], ['角松敏生']],
  [['kenshi yonezu', 'yonezu kenshi'], ['米津玄師']],
  [['fujii kaze', 'kaze fujii'], ['藤井風']],
  [['yoasobi'], ['夜に駆ける', 'ヨアソビ']],
  [['aimer'], ['エメ']],
  [['lisa'], ['リサ']],
  [['radwimps'], ['ラッドウィンプス']],
  [['king gnu'], ['キングヌー']],
  [['official hige dandism', 'officialhigedandism'], ['official髭男dism']],
  [['vaundy'], ['バウンディ']],
  [['yuuri'], ['優里']],
  [['zutomayo'], ['ずっと真夜中でいいのに。']],
  [['yorushika'], ['ヨルシカ']],
  [['ryuichi sakamoto', 'sakamoto ryuichi'], ['坂本龍一']],
  [['joe hisaishi', 'hisaishi joe'], ['久石譲']],
  [['sheena ringo', 'ringo sheena'], ['椎名林檎']],
  [['iu', 'lee jieun'], ['아이유', '이지은']],
  [['bts', 'bangtan', 'bangtan boys'], ['방탄소년단']],
  [['blackpink'], ['블랙핑크']],
  [['newjeans'], ['뉴진스']],
  [['twice'], ['트와이스']],
  [['exo'], ['엑소']],
  [['bol4', 'bolbbalgan4'], ['볼빨간사춘기']],
  [['psy'], ['싸이']],
  [['taeyeon'], ['태연']],
  [['seventeen'], ['세븐틴']],
  [['stray kids'], ['스트레이 키즈']],
  [['heize'], ['헤이즈']],
  [['crush'], ['크러쉬']],
  [['zion t', 'zion.t'], ['자이언티']],
  [['akmu', 'akdong musician'], ['악뮤', '악동뮤지션']],
  [['red velvet'], ['레드벨벳']],
  [['aespa'], ['에스파']],
  [['ive'], ['아이브']],
  [['le sserafim'], ['르세라핌']],
  [['g-dragon', 'gdragon'], ['지드래곤', '권지용']],
  [['amr diab'], ['عمرو دياب']],
  [['nancy ajram'], ['نانسي عجرم']],
  [['fairuz', 'fayrouz'], ['فيروز']],
  [['elissa'], ['اليسا']],
  [['sherine', 'sherine abdel wahab'], ['شيرين', 'شيرين عبد الوهاب']],
  [['saad lamjarred'], ['سعد لمجرد']],
  [['tamer hosny'], ['تامر حسني']],
  [['mohamed hamaki'], ['محمد حماقي']],
  [['assala', 'assala nasri'], ['اصالة', 'اصالة نصري']],
  [['majid al mohandis', 'majed al mohandes'], ['ماجد المهندس']],
  [['hussain al jassmi'], ['حسين الجسمي']],
  [['cairokee'], ['كايروكي']],
  [['nont tanont', 'tanont chumroen'], ['นนท์ ธนนท์']],
  [['billkin', 'putthipong assaratanakul'], ['บิวกิ้น']],
  [['pp krit', 'krit amnuaydechkorn'], ['พีพี กฤษฏ์']],
  [['bowkylion'], ['โบกี้ไลออน']],
  [['ink waruntorn'], ['อิ้งค์ วรันธร']],
  [['three man down'], ['ทรีแมนดาว']],
  [['tilly birds'], ['ทิลลี่เบิร์ดส์']],
  [['youngohm'], ['ยังโอม']],
  [['violette wautier'], ['วิโอเลต วอเทียร์']],
  [['cocktail'], ['ค็อกเทล']],
  [['bodyslam'], ['บอดี้สแลม']],
  [['palmy'], ['ปาล์มมี่']],
  [['stamp', 'stamp apiwat'], ['แสตมป์']],
  [['scrubb'], ['สครับบ์']],
  [['anatomy rabbit'], ['อนาโตมี่ แรบบิท']],
  [['jay chou', 'chou jay'], ['周杰伦', '周杰倫']],
  [['eason chan'], ['陈奕迅', '陳奕迅']],
  [['jj lin'], ['林俊杰', '林俊傑']],
  [['teresa teng'], ['邓丽君', '鄧麗君', 'テレサ・テン']],
  [['faye wong'], ['王菲']],
  [['jacky cheung'], ['张学友', '張學友']],
  [['gem', 'g.e.m.'], ['邓紫棋', '鄧紫棋']],
  [['mayday'], ['五月天']],
  [['leehom wang', 'wang leehom'], ['王力宏']],
  [['eric chou'], ['周兴哲', '周興哲']],
  [['accusefive'], ['告五人']],
  [['jolin tsai'], ['蔡依林']],
  [['stefanie sun'], ['孙燕姿', '孫燕姿']],
  [['david tao'], ['陶喆']],
];

export function getArtistCrossScriptAliases(artist = '') {
  const lower = artist.toLowerCase().trim();
  const clean = lower.replace(/[\-_.']/g, ' ');
  const compact = clean.replace(/\s+/g, '');
  const aliases = [];

  for (const [latins, natives] of ARTIST_ALIAS_TABLE) {
    const isLatinMatch = latins.some((l) => {
      const lClean = l.replace(/[\-_.']/g, ' ');
      return lower === l || clean === lClean || compact === lClean.replace(/\s+/g, '');
    });
    const isNativeMatch = natives.some((n) => {
      return lower === n.toLowerCase() || compact === n.replace(/\s+/g, '');
    });
    if (isLatinMatch) {
      aliases.push(...natives, ...latins.filter((l) => l !== artist));
    } else if (isNativeMatch) {
      aliases.push(...latins, ...natives.filter((n) => n !== artist));
    }
  }
  return aliases;
}

const TITLE_ALIAS_TABLE = [
  [['single again', 'singleagain'], ['シングルアゲイン', 'シングル・アゲイン']],
  [['plastic love', 'plasticlove'], ['プラスティックラブ', 'プラスティック・ラヴ', 'プラスティック・ラブ']],
  [['stay with me', 'staywithme'], ['真夜中のドア', '真夜中のドア stay with me']],
  [['madonna tachi no lullaby', 'madonnatachinolullaby'], ['聖母たちのララバイ']],
  [['first love', 'firstlove'], ['初恋', '初戀']],
  [['racing into the night', 'yoruni kakeru', 'yorunikakeru'], ['夜に駆ける']],
  [['lemon'], ['レモン']],
  [['pretender'], ['プリテンダー']],
  [['through the night', 'throughthenight'], ['밤편지']],
  [['spring day', 'springday'], ['봄날']],
  [['love scenario', 'lovescenario'], ['사랑을 했다']],
  [['palette'], ['팔레트']],
  [['eight'], ['에잇']],
  [['celebrity'], ['셀러브리티']],
  [['dynamite'], ['다이너마イト'.replace('イト', '이트')]],
  [['butter'], ['버터']],
  [['hype boy', 'hypeboy'], ['하입보이']],
  [['ditto'], ['디토']],
  [['omg'], ['오엠지']],
  [['tamally maak', 'tamallymaak', 'tamali maak'], ['تملي معاك']],
  [['nour el ain', 'nourelain'], ['نور العين']],
  [['wayah'], ['وياه']],
  [['habibi ya nour el ain'], ['حبيبي يا نور العين']],
  [['el leila'], ['الليلة']],
  [['enta eih'], ['انت ايه']],
  [['ya tabtab'], ['يا طبطب']],
  [['phing', 'ping'], ['พิง']],
  [['i told sunset about you'], ['แปลรักฉันด้วยใจเธอ']],
  [['melt'], ['โต๊ะริม']],
];

export function getTitleCrossScriptAliases(title = '') {
  const lower = title.toLowerCase().trim();
  const clean = lower.replace(/[\-_.'\s]/g, '');
  const aliases = [];

  for (const [latins, natives] of TITLE_ALIAS_TABLE) {
    const isLatin = latins.some((l) => clean === l.replace(/[\-_.'\s]/g, '') || lower === l);
    const isNative = natives.some((n) => clean === n.replace(/[\-_.'\s・]/g, '') || lower === n.toLowerCase());
    if (isLatin) aliases.push(...natives);
    else if (isNative) aliases.push(...latins);
  }
  return aliases;
}

export function parseMultilingualMetadata(rawTitle = '', rawChannel = '') {
  const titleWithoutNoise = rawTitle.replace(VIDEO_NOISE_REGEX, ' ');
  let bracketLatin = null;
  let bracketNative = null;

  for (const m of titleWithoutNoise.matchAll(BRACKET_CONTENT_REGEX)) {
    const bText = (m[1] || '').trim();
    if (bText && !VIDEO_NOISE_REGEX.test(bText)) {
      if (containsLatin(bText) && containsNonLatin(rawTitle)) bracketLatin = bText;
      else if (containsNonLatin(bText) && containsLatin(rawTitle)) bracketNative = bText;
    }
    VIDEO_NOISE_REGEX.lastIndex = 0;
  }

  const cleanTitle = titleWithoutNoise.replace(BRACKET_STRIP_REGEX, ' ').replace(/\s+/g, ' ').trim();
  const channel = (rawChannel || '').replace(/- Topic/gi, '').replace(/\bTopic\b/g, '').trim();
  const isGenericChannel = !channel ||
    channel.toLowerCase() === 'topic' ||
    /개인소장|Collection|Official|VEVO|Channel|Music/i.test(channel);

  let extractedArtist = isGenericChannel ? null : channel;
  let extractedTitle = cleanTitle;
  let nativeTitle = null;
  let latinTitle = null;
  let majorSectionMatched = false;

  for (const md of [' | ', ' // ']) {
    if (cleanTitle.includes(md)) {
      const sections = cleanTitle.split(md).map((s) => s.trim()).filter(Boolean);
      if (sections.length >= 2) {
        const [s1, s2] = sections;
        const s1L = containsLatin(s1) && !containsNonLatin(s1);
        const s2L = containsLatin(s2) && !containsNonLatin(s2);
        const s1N = containsNonLatin(s1);
        const s2N = containsNonLatin(s2);
        if ((s1L && s2N) || (s2L && s1N)) {
          const [latSec, natSec] = s1L ? [s1, s2] : [s2, s1];
          const latParts = latSec.split(' - ').map((s) => s.trim()).filter(Boolean);
          if (latParts.length >= 2) {
            extractedArtist = latParts[0];
            extractedTitle = latParts[1];
            latinTitle = latParts[1];
          } else {
            latinTitle = latSec;
          }
          const natParts = natSec.split(' - ').map((s) => s.trim()).filter(Boolean);
          nativeTitle = natParts.length >= 2 ? natParts[1] : natSec;
          majorSectionMatched = true;
          break;
        }
      }
    }
  }

  if (!majorSectionMatched) {
    for (const d of [' - ', ' – ', ' — ', ' | ', ' / ', '／', ' ~ ']) {
      if (cleanTitle.includes(d)) {
        const parts = cleanTitle.split(d).map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
          const [p1, p2] = parts;
          const p1L = containsLatin(p1) && !containsNonLatin(p1);
          const p2L = containsLatin(p2) && !containsNonLatin(p2);
          const p1N = containsNonLatin(p1);
          const p2N = containsNonLatin(p2);
          if (p1L && p2N) {
            extractedArtist = p1;
            extractedTitle = p2;
            nativeTitle = p2;
          } else if (p1N && p2L) {
            nativeTitle = p1;
            latinTitle = p2;
            extractedTitle = p1;
          } else if (!extractedArtist || isGenericChannel) {
            extractedArtist = p1;
            extractedTitle = p2;
          }
          break;
        }
      }
    }
  }

  if (!extractedArtist || isGenericChannel) {
    const words = cleanTitle.split(/\s+/).filter(Boolean);
    const latinWords = words.filter((w) => containsLatin(w) && !containsNonLatin(w));
    const nativeWords = words.filter((w) => containsNonLatin(w));
    if (latinWords.length && nativeWords.length) {
      extractedArtist = latinWords.join(' ');
      extractedTitle = nativeWords.join(' ');
      nativeTitle = extractedTitle;
    }
  }

  if (!latinTitle) latinTitle = bracketLatin;
  if (!nativeTitle) nativeTitle = bracketNative;

  const queries = [];
  const pushQ = (q) => {
    const trimmed = q.replace(/\s+/g, ' ').trim();
    if (trimmed && !queries.includes(trimmed)) queries.push(trimmed);
  };

  const effArtist = extractedArtist || channel;
  const effTitle = extractedTitle || cleanTitle;
  pushQ(`${effArtist} ${effTitle}`);

  const aliases = getArtistCrossScriptAliases(effArtist);
  for (const a of aliases) pushQ(`${a} ${effTitle}`);

  const deArtist = stripLatinDiacritics(effArtist);
  const deTitle = stripLatinDiacritics(effTitle);
  if (deArtist !== effArtist || deTitle !== effTitle) pushQ(`${deArtist} ${deTitle}`);

  if (containsJapanese(effTitle)) {
    const romaji = kanaToRomaji(effTitle).trim();
    if (romaji) {
      pushQ(`${effArtist} ${romaji}`);
      const loan = romaji
        .replace(/shinguru/g, 'single').replace(/singuru/g, 'single')
        .replace(/agein/g, 'again').replace(/gein/g, 'gain')
        .replace(/purasutikku/g, 'plastic').replace(/rabu/g, 'love')
        .replace(/rarabai/g, 'lullaby').replace(/sutei/g, 'stay')
        .replace(/doa/g, 'door').replace(/wizu/g, 'with').replace(/mii/g, 'me');
      if (loan !== romaji) {
        pushQ(`${effArtist} ${loan}`);
        for (const a of aliases) pushQ(`${a} ${loan}`);
      }
    }
  }

  if (latinTitle) {
    pushQ(`${effArtist} ${latinTitle}`);
    for (const a of aliases) pushQ(`${a} ${latinTitle}`);
  }
  if (nativeTitle) pushQ(`${effArtist} ${nativeTitle}`);

  for (const tAlias of getTitleCrossScriptAliases(effTitle)) {
    pushQ(`${effArtist} ${tAlias}`);
    for (const a of aliases) pushQ(`${a} ${tAlias}`);
  }
  if (effTitle) pushQ(effTitle);

  return { cleanTitle, extractedArtist, extractedTitle, nativeTitle, latinTitle, searchQueries: queries };
}
