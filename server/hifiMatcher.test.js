import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDuplicateTitleTrackPenalty,
  buildExcludedEditionDurationMap,
  cleanString,
  computeAlbumTitleMinIds,
  detectEditions,
  doesArtistMatch,
  isExcludedDurationByCrossProviderOracle,
  normalizeExactAlbumKey,
  resolveEffectiveCandidateTitle,
  scoreTrackCandidate,
} from './hifiMatcher.js';
import { buildSearchQueries, hasFlacMagicPrefix, isValidKuwoFlacUrl } from './hifi.js';
import { parseMultilingualMetadata } from './scriptUtils.js';

test('cleanString strips noise, brackets, feat, diacritics, and preserves multilingual scripts', () => {
  assert.equal(cleanString('Bohemian Rhapsody (Remastered 2011)'), 'bohemianrhapsody');
  assert.equal(cleanString('Song feat. Artist'), 'song');
  assert.equal(cleanString('Title [Official Video]'), 'title');
  assert.equal(cleanString('シングル・アゲイン'), 'シングルアゲイン');
  assert.equal(cleanString('밤편지'), '밤편지');
  assert.equal(cleanString('พิง'), 'พิง');
  assert.equal(cleanString('عمرو دياب'), 'عمرو دياب'.replace(/\s+/g, ''));
});

test('cross-script bidirectional artist matching', () => {
  assert.equal(doesArtistMatch('竹内まりや', 'Mariya Takeuchi', 'Plastic Love'), true);
  assert.equal(doesArtistMatch('Mariya Takeuchi', '竹内まりや', 'Plastic Love'), true);
  assert.equal(doesArtistMatch('IU', '아이유', 'Through the Night'), true);
  assert.equal(doesArtistMatch('Amr Diab', 'عمرو دياب', 'Tamally Maak'), true);
  assert.equal(doesArtistMatch('Nont Tanont', 'นนท์ ธนนท์', 'พิง'), true);
});

test('Japanese Katakana loanword scoring (Single Again <-> シングル・アゲイン)', () => {
  const score = scoreTrackCandidate({
    targetTitle: 'シングル・アゲイン',
    targetArtist: 'Mariya Takeuchi',
    targetDurSecs: 265,
    candId: '1273467',
    candTitle: 'Single Again',
    candArtist: '竹内まりや',
    candDurSecs: 264,
  });
  assert.ok(score >= 140, `Expected >= 140, got ${score}`);
});

test('Korean, Thai, and Arabic cross-script scoring', () => {
  const koScore = scoreTrackCandidate({
    targetTitle: 'Through the Night',
    targetArtist: 'IU',
    targetDurSecs: 253,
    candId: '23497005',
    candTitle: '밤편지',
    candArtist: '아이유',
    candDurSecs: 253,
  });
  assert.ok(koScore >= 140, `Korean score was ${koScore}`);

  const thScore = scoreTrackCandidate({
    targetTitle: 'พิง',
    targetArtist: 'Nont Tanont',
    targetDurSecs: 235,
    candId: '193944050',
    candTitle: 'พิง',
    candArtist: 'นนท์ ธนนท์',
    candDurSecs: 235,
  });
  assert.ok(thScore >= 140, `Thai score was ${thScore}`);

  const arScore = scoreTrackCandidate({
    targetTitle: 'Amr Diab - Tamally Maak',
    targetArtist: 'Mazzika',
    targetDurSecs: 269,
    candId: '1511586',
    candTitle: 'تملي معاك',
    candArtist: 'عمرو دياب',
    candDurSecs: 269,
  });
  assert.ok(arScore >= 140, `Arabic score was ${arScore}`);
});

test('duration disqualification and original studio match (Sempurna)', () => {
  const remakeScore = scoreTrackCandidate({
    targetTitle: 'Sempurna',
    targetArtist: 'Andra And The Backbone',
    targetDurSecs: 268,
    candId: '163245492',
    candTitle: 'Sempurna(feat. Andra & the Backbone)',
    candArtist: 'Neillusion&Andra & The Backbone',
    candDurSecs: 181,
  });
  assert.equal(remakeScore, 0);

  const originalScore = scoreTrackCandidate({
    targetTitle: 'Sempurna',
    targetArtist: 'Andra And The Backbone',
    targetDurSecs: 268,
    targetAlbum: 'Andra And The BackBone',
    candId: '172473323077242880',
    candTitle: 'Sempurna',
    candArtist: 'Andra & The Backbone',
    candDurSecs: 268,
    candIsrc: 'IDAB30600441',
    candAlbum: 'Andra and The BackBone',
  });
  assert.ok(originalScore >= 180, `Expected >= 180, got ${originalScore}`);
});

test('album matching and Re-Recorded disqualification', () => {
  const rerecordedScore = scoreTrackCandidate({
    targetTitle: "Nothing's Gonna Stop Us Now",
    targetArtist: 'Starship',
    targetDurSecs: 266,
    targetAlbum: 'No Protection',
    candId: '45079884',
    candTitle: "Nothing's Gonna Stop Us Now",
    candArtist: 'Starship',
    candDurSecs: 264,
    candAlbum: "Greatest Hits of the '80s (Re-Recorded Versions)",
  });
  assert.equal(rerecordedScore, 0);

  const officialScore = scoreTrackCandidate({
    targetTitle: "Nothing's Gonna Stop Us Now",
    targetArtist: 'Starship',
    targetDurSecs: 266,
    targetAlbum: 'No Protection',
    candId: '1930566',
    candTitle: "Nothing's Gonna Stop Us Now",
    candArtist: 'Starship',
    candDurSecs: 270,
    candAlbum: 'No Protection',
  });
  assert.ok(officialScore >= 220, `Expected >= 220, got ${officialScore}`);
});

test('title match required and corrupt Kuwo Main Hati ID rejected', () => {
  const diffTitle = scoreTrackCandidate({
    targetTitle: 'Main Hati',
    targetArtist: 'Andra And The Backbone',
    targetDurSecs: 174,
    targetAlbum: 'Season 2',
    candId: 'non_blacklisted_id',
    candTitle: 'Kepayang',
    candArtist: 'Andra And The Backbone',
    candDurSecs: 174,
    candAlbum: 'Season 2',
  });
  assert.equal(diffTitle, 0);

  const corruptKuwo = scoreTrackCandidate({
    targetTitle: 'Main Hati',
    targetArtist: 'Andra And The Backbone',
    targetDurSecs: 174,
    targetAlbum: 'Season 2',
    candId: 'kuwo_228981606',
    candTitle: 'Main Hati',
    candArtist: 'Andra & The Backbone',
    candDurSecs: 174,
    candAlbum: 'Season 2',
  });
  assert.equal(corruptKuwo, 0);

  const genuine = scoreTrackCandidate({
    targetTitle: 'Main Hati',
    targetArtist: 'Andra And The Backbone',
    targetDurSecs: 239,
    targetAlbum: 'Season 2',
    candId: '165836656720859136',
    candTitle: 'Main Hati',
    candArtist: 'Andra & The Backbone',
    candDurSecs: 238,
    candIsrc: 'IDAB30800008',
    candAlbum: 'Season 2',
  });
  assert.ok(genuine >= 180, `Expected >= 180, got ${genuine}`);
});

test('remix album/title conflict symmetry (Alamak)', () => {
  const remixWhenOrig = scoreTrackCandidate({
    targetTitle: 'Alamak',
    targetArtist: 'Rizky Febian, Adrian Khalif',
    targetDurSecs: 209,
    targetAlbum: 'Alamak',
    candId: '518680784',
    candTitle: 'Alamak',
    candArtist: 'Rizky Febian&Adrian Khalif',
    candDurSecs: 211,
    candAlbum: 'Alamak (Dipha Barus Remix)',
  });
  assert.equal(remixWhenOrig, 0);

  const origWhenOrig = scoreTrackCandidate({
    targetTitle: 'Alamak',
    targetArtist: 'Rizky Febian, Adrian Khalif',
    targetDurSecs: 209,
    targetAlbum: 'Alamak',
    candId: '502382878',
    candTitle: 'Alamak',
    candArtist: 'Rizky Febian&Adrian Khalif',
    candDurSecs: 209,
    candAlbum: 'Alamak',
  });
  assert.ok(origWhenOrig >= 200, `Expected >= 200, got ${origWhenOrig}`);

  const origWhenRemix = scoreTrackCandidate({
    targetTitle: 'Alamak (Dipha Barus Remix)',
    targetArtist: 'Rizky Febian, Adrian Khalif',
    targetDurSecs: 211,
    targetAlbum: 'Alamak (Dipha Barus Remix)',
    candId: '502382878',
    candTitle: 'Alamak',
    candArtist: 'Rizky Febian&Adrian Khalif',
    candDurSecs: 209,
    candAlbum: 'Alamak',
  });
  assert.equal(origWhenRemix, 0);

  const remixWhenRemix = scoreTrackCandidate({
    targetTitle: 'Alamak (Dipha Barus Remix)',
    targetArtist: 'Rizky Febian, Adrian Khalif',
    targetDurSecs: 211,
    targetAlbum: 'Alamak (Dipha Barus Remix)',
    candId: '518680784',
    candTitle: 'Alamak',
    candArtist: 'Rizky Febian&Adrian Khalif',
    candDurSecs: 211,
    candAlbum: 'Alamak (Dipha Barus Remix)',
  });
  assert.ok(remixWhenRemix >= 200, `Expected >= 200, got ${remixWhenRemix}`);
});

test('live runway broadcast disqualification (Maroon 5 Animals)', () => {
  const score = scoreTrackCandidate({
    targetTitle: 'Animals',
    targetArtist: 'Maroon 5',
    targetDurSecs: 232,
    targetAlbum: 'V',
    candId: '5266278',
    candTitle: 'Animals-2015年维多利亚的秘密泳装秀秀场音乐',
    candArtist: 'Maroon 5',
    candDurSecs: 229,
  });
  assert.equal(score, 0);
});

test('Demons full suite + Melee diacritic matching', () => {
  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'Demons',
      targetArtist: 'Imagine Dragons',
      targetDurSecs: 176,
      targetAlbum: 'Night Visions',
      candId: '196763238',
      candTitle: 'Demons',
      candArtist: 'Imagine Dragons',
      candDurSecs: 176,
      candAlbum: 'Demons (TELYKast Remix)',
    }),
    0
  );

  const studioScore = scoreTrackCandidate({
    targetTitle: 'Demons',
    targetArtist: 'Imagine Dragons',
    targetDurSecs: 177,
    targetAlbum: 'Night Visions',
    candId: '69494807',
    candTitle: 'Demons',
    candArtist: 'Imagine Dragons',
    candDurSecs: 177,
    candAlbum: 'Night Visions',
  });
  assert.ok(studioScore >= 250, `Expected >= 250, got ${studioScore}`);

  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'Demons',
      targetArtist: 'Imagine Dragons',
      targetDurSecs: 177,
      targetAlbum: 'Night Visions',
      candId: '198259372',
      candTitle: 'Demons',
      candArtist: 'Imagine Dragons',
      candDurSecs: 183,
      candAlbum: 'Hits Alive Vol.4',
    }),
    0
  );

  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'Demons',
      targetArtist: 'Imagine Dragons',
      targetDurSecs: 177,
      targetAlbum: 'Night Visions',
      candId: '238687094',
      candTitle: 'Demons',
      candArtist: 'Imagine Dragons',
      candDurSecs: 187,
      candAlbum: 'Night Visions (Expanded Edition / Super Deluxe)',
    }),
    0
  );

  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'Demons',
      targetArtist: 'Imagine Dragons',
      targetDurSecs: 176,
      targetAlbum: 'Night Visions',
      candId: '1136550',
      candTitle: 'Demons-《九层妖塔》电影主题曲',
      candArtist: 'Imagine Dragons',
      candDurSecs: 175,
      candAlbum: 'Continued Silence',
    }),
    0
  );

  const meleeScore = scoreTrackCandidate({
    targetTitle: 'Built to Last',
    targetArtist: 'Mêlée',
    targetDurSecs: 222,
    targetAlbum: 'Built To Last',
    candId: '16483587',
    candTitle: 'Built To Last',
    candArtist: 'Melee',
    candDurSecs: 222,
    candAlbum: 'Devils & Angels (German Digital Bundle)',
  });
  assert.ok(meleeScore >= 140, `Expected >= 140, got ${meleeScore}`);
});

test('DJ edit and unrequested collaborator rejection (Fourtwnty MANGU)', () => {
  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'MANGU',
      targetArtist: 'Fourtwnty feat. Charita Utami',
      targetDurSecs: 264,
      targetAlbum: 'MANGU',
      candId: '475566563',
      candTitle: 'Mangu',
      candArtist: 'Fourtwnty&Whisnu Santika&Charita Utami',
      candDurSecs: 264,
      candAlbum: 'Mangu (Whisnu Santika Edit)',
    }),
    0
  );

  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'MANGU',
      targetArtist: 'Fourtwnty feat. Charita Utami',
      targetDurSecs: 264,
      targetAlbum: 'MANGU',
      candId: '2709291967',
      candTitle: 'Mangu (Whisnu Santika Edit)',
      candArtist: 'Fourtwnty',
      candDurSecs: 264,
      candAlbum: 'Mangu (Whisnu Santika Edit)',
    }),
    0
  );

  const wyyStudio = scoreTrackCandidate({
    targetTitle: 'MANGU',
    targetArtist: 'Fourtwnty feat. Charita Utami',
    targetDurSecs: 264,
    targetAlbum: 'MANGU',
    candId: '1941401299',
    candTitle: 'Mangu',
    candArtist: 'Fourtwnty',
    candDurSecs: 262,
    candAlbum: 'Mangu',
  });
  assert.ok(wyyStudio >= 200, `Expected >= 200, got ${wyyStudio}`);
});

test('sped up, slowed, Chinese/Indonesian karaoke, compilation penalty, and deluxe tiering', () => {
  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'Sekedar Teman',
      targetArtist: 'Faith',
      targetDurSecs: 195,
      candId: '999001',
      candTitle: 'Sekedar Teman (Sped Up)',
      candArtist: 'Faith',
      candDurSecs: 195,
    }),
    0
  );

  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'Sekedar Teman',
      targetArtist: 'Faith',
      targetDurSecs: 195,
      candId: '999002',
      candTitle: 'Sekedar Teman (Tanpa Vokal)',
      candArtist: 'Faith',
      candDurSecs: 195,
    }),
    0
  );

  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'Blue',
      targetArtist: 'Yung Kai',
      targetDurSecs: 214,
      candId: '999003',
      candTitle: 'Blue (原版伴奏)',
      candArtist: 'Yung Kai',
      candDurSecs: 214,
    }),
    0
  );

  const canonical = scoreTrackCandidate({
    targetTitle: 'Demons',
    targetArtist: 'Imagine Dragons',
    targetDurSecs: 177,
    targetAlbum: 'Night Visions',
    candId: '1001',
    candTitle: 'Demons',
    candArtist: 'Imagine Dragons',
    candDurSecs: 177,
    candAlbum: 'Night Visions',
  });
  const deluxe = scoreTrackCandidate({
    targetTitle: 'Demons',
    targetArtist: 'Imagine Dragons',
    targetDurSecs: 177,
    targetAlbum: 'Night Visions',
    candId: '1002',
    candTitle: 'Demons',
    candArtist: 'Imagine Dragons',
    candDurSecs: 177,
    candAlbum: 'Night Visions (Deluxe Edition)',
  });
  const compilation = scoreTrackCandidate({
    targetTitle: 'Demons',
    targetArtist: 'Imagine Dragons',
    targetDurSecs: 177,
    targetAlbum: 'Night Visions',
    candId: '1003',
    candTitle: 'Demons',
    candArtist: 'Imagine Dragons',
    candDurSecs: 177,
    candAlbum: 'Greatest Hits Vol. 1',
  });
  assert.ok(canonical > deluxe, `Canonical (${canonical}) should beat Deluxe (${deluxe})`);
  assert.ok(deluxe > compilation, `Deluxe (${deluxe}) should beat Compilation (${compilation})`);
});

test('Track-2 Minus-One duplicate title penalty (same duration only)', () => {
  const sameDurBatch = [
    { id: '50010', name: 'Plastic Love', album_name: 'Variety', duration: 292 },
    { id: '50011', name: 'Plastic Love', album_name: 'Variety', duration: 291 },
  ];
  const sameDurGroups = computeAlbumTitleMinIds(sameDurBatch);
  assert.equal(applyDuplicateTitleTrackPenalty(200, 'Plastic Love', 'Variety', '50010', sameDurGroups, 292), 200);
  assert.equal(applyDuplicateTitleTrackPenalty(200, 'Plastic Love', 'Variety', '50011', sameDurGroups, 291), 140);

  // Distinct-duration alternate cuts on the same album (e.g. 207s Version 2 vs 235s Original) must NOT be penalized
  const diffDurBatch = [
    { id: '186238177', name: 'Semenjak Ada Dirimu', album_name: 'Semenjak Ada Dirimu', duration: 207 },
    { id: '186238181', name: 'Semenjak Ada Dirimu', album_name: 'Semenjak Ada Dirimu', duration: 235 },
  ];
  const diffDurGroups = computeAlbumTitleMinIds(diffDurBatch);
  assert.equal(
    applyDuplicateTitleTrackPenalty(165, 'Semenjak Ada Dirimu', 'Semenjak Ada Dirimu', '186238181', diffDurGroups, 235),
    165
  );
});

test('FLAC magic bytes and Kuwo URL validation', () => {
  assert.equal(hasFlacMagicPrefix(Buffer.from('fLaC\x00\x00\x00\x22', 'binary')), true);
  assert.equal(hasFlacMagicPrefix(Buffer.from('\xff\xfb\x90\x00\x00\x00\x00\x00', 'binary')), false);
  assert.equal(hasFlacMagicPrefix(Buffer.from('<html>bad</html>', 'utf8')), false);
  assert.equal(
    hasFlacMagicPrefix(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00fLaC', 'binary')),
    true
  );

  assert.equal(isValidKuwoFlacUrl('https://other-er.kuwo.cn/track.flac?sign=abc'), true);
  assert.equal(isValidKuwoFlacUrl('https://other-er.kuwo.cn/track.mp3'), false);
  assert.equal(isValidKuwoFlacUrl('https://cdn.example/lx/resource/2044590383.flac'), false);
  assert.equal(isValidKuwoFlacUrl(''), false);
});

test('multi-cut boxset isolation, canonical preference, and cross-provider oracle for a-ha Take on Me', () => {
  const kuwoBatch = [
    { id: '6625437', name: 'Take on Me', artist: 'A-Ha', album_name: 'Hunting High and Low (30th Anniversary Edition)', duration: 229 },
    { id: '24739043', name: 'Take on Me', artist: 'A-Ha', album_name: 'Hunting High and Low (30th Anniversary Edition)', duration: 226 },
    { id: '45818637', name: 'Take on Me', artist: 'A-Ha', album_name: 'Hunting High and Low (30th Anniversary Edition)', duration: 228 },
    { id: '195815265', name: 'Take on Me', artist: 'A-Ha', album_name: 'Hunting High and Low', duration: 225 },
  ];
  const wyyBatch = [
    { id: '34834494', name: 'Take on Me (2015 Remaster)', artist: 'a-ha', album_name: 'Hunting High and Low (30th Anniversary Edition)', duration: 228 },
    { id: '34834527', name: 'Take on Me (1984 Single Mix) [2015 Remaster]', artist: 'a-ha', album_name: 'Hunting High and Low (30th Anniversary Edition)', duration: 226 },
    { id: '34834529', name: 'Take on Me (Instrumental) [2015 Remaster]', artist: 'a-ha', album_name: 'Hunting High and Low (30th Anniversary Edition)', duration: 229 },
    { id: '16481347', name: 'Take On Me', artist: 'a-ha', album_name: 'Hunting High and Low', duration: 225 },
  ];

  const groups = computeAlbumTitleMinIds(kuwoBatch);
  const canonicalKey = `takeonme:::${normalizeExactAlbumKey('Hunting High and Low')}`;
  const anniversaryKey = `takeonme:::${normalizeExactAlbumKey('Hunting High and Low (30th Anniversary Edition)')}`;
  assert.notEqual(canonicalKey, anniversaryKey);
  assert.equal(groups.get(canonicalKey)?.length, 1);
  assert.equal(groups.get(anniversaryKey)?.length, 3);

  const scoreFor = (c) => {
    const base = scoreTrackCandidate({
      targetTitle: 'Take on Me',
      targetArtist: 'a-ha',
      targetDurSecs: 226,
      targetAlbum: 'Hunting High and Low (30th Anniversary Edition)',
      candId: `kuwo_${c.id}`,
      candTitle: c.name,
      candArtist: c.artist,
      candDurSecs: c.duration,
      candAlbum: c.album_name,
    });
    return applyDuplicateTitleTrackPenalty(base, c.name, c.album_name, c.id, groups, c.duration);
  };

  const canonicalScore = scoreFor(kuwoBatch[3]);
  const anniversary226Score = scoreFor(kuwoBatch[1]);
  const anniversary228Score = scoreFor(kuwoBatch[2]);
  const anniversary229Score = scoreFor(kuwoBatch[0]);

  assert.equal(canonicalScore, 255);
  assert.equal(anniversary226Score, 200);
  assert.equal(anniversary228Score, 200);
  assert.equal(anniversary229Score, 175);
  assert.ok(canonicalScore > anniversary226Score);

  const oracle = buildExcludedEditionDurationMap(
    wyyBatch,
    'Take on Me',
    'a-ha',
    'Hunting High and Low (30th Anniversary Edition)'
  );
  assert.equal(
    isExcludedDurationByCrossProviderOracle('Take on Me', 'Hunting High and Low (30th Anniversary Edition)', 229, oracle),
    true
  );
  assert.equal(
    isExcludedDurationByCrossProviderOracle('Take on Me', 'Hunting High and Low (30th Anniversary Edition)', 226, oracle),
    false
  );
  assert.equal(
    isExcludedDurationByCrossProviderOracle('Take on Me', 'Hunting High and Low (30th Anniversary Edition)', 228, oracle),
    false
  );
  assert.equal(
    isExcludedDurationByCrossProviderOracle('Take on Me', 'Hunting High and Low', 225, oracle),
    false
  );
});

test('cross-provider oracle strips (Explicit) advisory tags and protects same-duration singles', () => {
  assert.equal(
    normalizeExactAlbumKey('Meteora 20th Anniversary Edition (Explicit)'),
    normalizeExactAlbumKey('Meteora 20th Anniversary Edition')
  );

  const wyyMeteora = [
    { id: '2036434778', name: 'Numb', artist: 'Linkin Park', album_name: 'Meteora 20th Anniversary Edition', duration: 187 },
    { id: '2036434596', name: 'Numb (Live In Texas)', artist: 'Linkin Park', album_name: 'Meteora 20th Anniversary Edition', duration: 194 },
  ];
  const numbOracle = buildExcludedEditionDurationMap(
    wyyMeteora,
    'Numb',
    'Linkin Park',
    'Meteora 20th Anniversary Edition (Explicit)'
  );
  assert.equal(
    isExcludedDurationByCrossProviderOracle('Numb', 'Meteora 20th Anniversary Edition (Explicit)', 194, numbOracle),
    true
  );
  assert.equal(
    isExcludedDurationByCrossProviderOracle('Numb', 'Meteora 20th Anniversary Edition (Explicit)', 187, numbOracle),
    false
  );

  // Single with identical 210s vocal and instrumental cuts must NOT veto the clean vocal cut
  const sameDurSingle = [
    { id: '1', name: 'Song X', artist: 'Artist X', album_name: 'Single X', duration: 210 },
    { id: '2', name: 'Song X (Instrumental)', artist: 'Artist X', album_name: 'Single X', duration: 210 },
  ];
  const singleOracle = buildExcludedEditionDurationMap(sameDurSingle, 'Song X', 'Artist X', 'Single X');
  assert.equal(isExcludedDurationByCrossProviderOracle('Song X', 'Single X', 210, singleOracle), false);
});

test('DEMO_REGEX detects (Demo) cuts without false positives on Demons', () => {
  assert.equal(detectEditions('Take on Me (Demo)').has('demo'), true);
  assert.equal(detectEditions('Take on Me (Demo) [2015 Remaster]').has('demo'), true);
  assert.equal(detectEditions('Demons').size, 0);
  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'Take on Me',
      targetArtist: 'a-ha',
      targetDurSecs: 226,
      candId: 'wyy_1358914679',
      candTitle: 'Take on Me (Demo)',
      candArtist: 'a-ha',
      candDurSecs: 226,
    }),
    0
  );
});

test('movie insert-song tie-in acceptance, Chinese solo-instrument rejection, and ultimate compilation penalty', () => {
  // Insert-song tie-in on canonical Repeat Offender is accepted (50 + 100 + 40 + 65 = 255)
  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'Right Here Waiting',
      targetArtist: 'Richard Marx',
      targetDurSecs: 265,
      targetAlbum: 'Repeat Offender',
      candId: 'kuwo_10813810',
      candTitle: 'Right Here Waiting-《玫瑰花床》电影插曲',
      candArtist: 'Richard Marx',
      candDurSecs: 264,
      candAlbum: 'Repeat Offender',
    }),
    255
  );

  // Solo piano / instrumental album (綠鋼琴 李察篇 第五輯) is disqualified on vocal targets
  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'Right Here Waiting',
      targetArtist: 'Richard Marx',
      targetDurSecs: 265,
      targetAlbum: 'Repeat Offender',
      candId: 'kuwo_141326929',
      candTitle: 'Right here waiting',
      candArtist: 'Richard Marx',
      candDurSecs: 268,
      candAlbum: '綠鋼琴 李察篇 第五輯',
    }),
    0
  );

  // Soundtrack album stays disqualified
  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'Take on Me',
      targetArtist: 'a-ha',
      targetDurSecs: 226,
      targetAlbum: 'Hunting High and Low',
      candId: 'kuwo_51149682',
      candTitle: 'Take on Me-《死侍2》 电影插曲',
      candArtist: 'A-Ha',
      candDurSecs: 254,
      candAlbum: 'Deadpool 2 (Original Motion Picture Soundtrack) [Deluxe - Super Duper Cut]',
    }),
    0
  );

  // Canonical studio album decisively beats "Time and Again: The Ultimate a-ha" with or without targetAlbum
  const canonicalNoAlb = scoreTrackCandidate({
    targetTitle: 'Take on Me',
    targetArtist: 'a-ha',
    targetDurSecs: 226,
    targetAlbum: null,
    candId: 'kuwo_195815265',
    candTitle: 'Take on Me',
    candArtist: 'A-Ha',
    candDurSecs: 225,
    candAlbum: 'Hunting High and Low',
  });
  const ultimateNoAlb = scoreTrackCandidate({
    targetTitle: 'Take on Me',
    targetArtist: 'a-ha',
    targetDurSecs: 226,
    targetAlbum: null,
    candId: 'kuwo_87918372',
    candTitle: 'Take on Me',
    candArtist: 'A-Ha',
    candDurSecs: 225,
    candAlbum: 'Time and Again: The Ultimate a-ha',
  });
  assert.equal(canonicalNoAlb, 190);
  assert.equal(ultimateNoAlb, 145);

  const canonicalWithAlb = scoreTrackCandidate({
    targetTitle: 'Take on Me',
    targetArtist: 'a-ha',
    targetDurSecs: 226,
    targetAlbum: 'Hunting High and Low',
    candId: 'kuwo_195815265',
    candTitle: 'Take on Me',
    candArtist: 'A-Ha',
    candDurSecs: 225,
    candAlbum: 'Hunting High and Low',
  });
  const ultimateWithAlb = scoreTrackCandidate({
    targetTitle: 'Take on Me',
    targetArtist: 'a-ha',
    targetDurSecs: 226,
    targetAlbum: 'Hunting High and Low',
    candId: 'kuwo_87918372',
    candTitle: 'Take on Me',
    candArtist: 'A-Ha',
    candDurSecs: 225,
    candAlbum: 'Time and Again: The Ultimate a-ha',
  });
  assert.equal(canonicalWithAlb, 255);
  assert.equal(ultimateWithAlb, 120);
});

test('expanded instrumental/speed edition regexes and resolveEffectiveCandidateTitle', () => {
  for (const title of [
    'Sekedar Teman (Inst.)',
    'Sekedar Teman (With Backing Vocals)',
    'Sekedar Teman (-1)',
    'Sekedar Teman (Minus 1)',
    'Sekedar Teman (Off-Vocal)',
    'Take on Me (Instrumental; 2015 Remaster)',
  ]) {
    assert.equal(detectEditions(title).has('instrumental'), true, `Expected instrumental on ${title}`);
  }
  assert.equal(detectEditions('Instead Of Me').has('instrumental'), false);
  assert.equal(detectEditions('Blink-182').has('instrumental'), false);
  assert.equal(detectEditions('Sekedar Teman (Slow Version)').has('remix'), true);
  assert.equal(detectEditions('blue (slowed down)').has('remix'), true);
  assert.equal(detectEditions('blue (Speed Up)').has('remix'), true);

  assert.equal(
    resolveEffectiveCandidateTitle('Sekedar Teman', 'Sekedar Teman (Instrumental)', 'Sekedar Teman'),
    'Sekedar Teman (Instrumental)'
  );
  assert.equal(
    resolveEffectiveCandidateTitle('blue', 'blue (sped up)', 'stay with the ocean'),
    'blue (sped up)'
  );
  assert.equal(
    resolveEffectiveCandidateTitle('Demons-《九层妖塔》电影主题曲', 'Demons', 'Night Visions'),
    'Demons-《九层妖塔》电影主题曲'
  );
});

test('Sekedar Teman inverted-ID vocal vs minus-one handling (hydrated, trackNum, and rank fallback)', () => {
  // 1. With hydrated official title ("Sekedar Teman (Instrumental)" on lower ID 452409736)
  const hydratedBatch = [
    { id: '452409738', name: 'Sekedar Teman', effective_name: 'Sekedar Teman', artist: 'Faith', album_name: 'Sekedar Teman', duration: 194, _kuwoTrackNum: 1, _searchIndex: 0 },
    { id: '452409736', name: 'Sekedar Teman', effective_name: 'Sekedar Teman (Instrumental)', artist: 'Faith', album_name: 'Sekedar Teman', duration: 194, _kuwoTrackNum: 2, _searchIndex: 1 },
  ];
  const targetEditions = detectEditions('Sekedar Teman', 'Sekedar Teman');
  const hydratedGroups = computeAlbumTitleMinIds(hydratedBatch, targetEditions);
  assert.equal(hydratedGroups.get('sekedarteman:::sekedarteman')?.length, 1);

  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'Sekedar Teman',
      targetArtist: 'faith',
      targetDurSecs: 195,
      targetAlbum: 'Sekedar Teman',
      candId: 'kuwo_452409736',
      candTitle: hydratedBatch[1].effective_name,
      candArtist: 'Faith',
      candDurSecs: 194,
      candAlbum: 'Sekedar Teman',
    }),
    0
  );
  const vocalHydrated = applyDuplicateTitleTrackPenalty(
    scoreTrackCandidate({
      targetTitle: 'Sekedar Teman',
      targetArtist: 'faith',
      targetDurSecs: 195,
      targetAlbum: 'Sekedar Teman',
      candId: 'kuwo_452409738',
      candTitle: hydratedBatch[0].effective_name,
      candArtist: 'Faith',
      candDurSecs: 194,
      candAlbum: 'Sekedar Teman',
    }),
    'Sekedar Teman',
    'Sekedar Teman',
    '452409738',
    hydratedGroups,
    194,
    1,
    0
  );
  assert.equal(vocalHydrated, 255);

  // 2. Unlabeled siblings with official trackNum (Track 1 wins even with higher numeric ID 452409738 > 452409736)
  const trackNumGroups = computeAlbumTitleMinIds([
    { id: '452409738', name: 'Sekedar Teman', album_name: 'Sekedar Teman', duration: 194, _kuwoTrackNum: 1, _searchIndex: 1 },
    { id: '452409736', name: 'Sekedar Teman', album_name: 'Sekedar Teman', duration: 194, _kuwoTrackNum: 2, _searchIndex: 0 },
  ]);
  assert.equal(applyDuplicateTitleTrackPenalty(255, 'Sekedar Teman', 'Sekedar Teman', '452409738', trackNumGroups, 194, 1, 1), 255);
  assert.equal(applyDuplicateTitleTrackPenalty(255, 'Sekedar Teman', 'Sekedar Teman', '452409736', trackNumGroups, 194, 2, 0), 195);

  // 3. Offline fallback without album hydration: searchIndex 0 beats searchIndex 1 even when ID 452409738 > 452409736
  const rankFallbackGroups = computeAlbumTitleMinIds([
    { id: '452409738', name: 'Sekedar Teman', album_name: 'Sekedar Teman', duration: 194, _searchIndex: 0 },
    { id: '452409736', name: 'Sekedar Teman', album_name: 'Sekedar Teman', duration: 194, _searchIndex: 1 },
  ]);
  assert.equal(applyDuplicateTitleTrackPenalty(255, 'Sekedar Teman', 'Sekedar Teman', '452409738', rankFallbackGroups, 194, 0, 0), 255);
  assert.equal(applyDuplicateTitleTrackPenalty(255, 'Sekedar Teman', 'Sekedar Teman', '452409736', rankFallbackGroups, 194, 0, 1), 195);
});

test('Avicii Tough Love: stripped-feat album queries, cross-artist bucket isolation, and workout/BGM compilation penalty', () => {
  // 1. buildSearchQueries emits stripped-feat album query first for canonical featured titles,
  // while preserving edition tags on remix targets.
  const toughLoveMeta = parseMultilingualMetadata('Tough Love (feat. Agnes & Vargas & Lagola)', 'Avicii');
  const toughLoveQueries = buildSearchQueries(
    'Tough Love (feat. Agnes & Vargas & Lagola)',
    'Avicii',
    'TIM',
    toughLoveMeta
  );
  assert.equal(toughLoveQueries[0], 'Avicii Tough Love TIM');
  assert.ok(toughLoveQueries.includes('Avicii Tough Love (feat. Agnes & Vargas & Lagola) TIM'));

  const remixTitle = 'Alamak (Dipha Barus Remix)';
  const remixMeta = parseMultilingualMetadata(remixTitle, 'Rizky Febian');
  const remixQueries = buildSearchQueries(remixTitle, 'Rizky Febian', 'Alamak (Dipha Barus Remix)', remixMeta);
  assert.equal(remixQueries[0], 'Rizky Febian Alamak (Dipha Barus Remix) Alamak (Dipha Barus Remix)');

  // 2. computeAlbumTitleMinIds with targetArtist='Avicii' isolates Sam Waller's TOUGH LOVE (671963506)
  // so Avicii's Tough Love (69086408) does not receive the -35 cross-artist multi-cut penalty.
  const crossArtistBatch = [
    { id: '69086408', name: 'Tough Love', artist: 'Avicii&Agnes&Vargas & Lagola', album_name: 'Tough Love', duration: 191, _searchIndex: 1 },
    { id: '671963506', name: 'TOUGH LOVE', artist: 'Sam Waller', album_name: 'TOUGH LOVE', duration: 194, _searchIndex: 9 },
  ];
  const isolatedGroups = computeAlbumTitleMinIds(
    crossArtistBatch,
    detectEditions('Tough Love (feat. Agnes & Vargas & Lagola)', 'TIM'),
    'Avicii',
    'Tough Love (feat. Agnes & Vargas & Lagola)'
  );
  assert.equal(isolatedGroups.get('toughlove:::toughlove')?.length, 1);

  const aviciiWithAlbumScore = scoreTrackCandidate({
    targetTitle: 'Tough Love (feat. Agnes & Vargas & Lagola)',
    targetArtist: 'Avicii',
    targetDurSecs: 192,
    targetAlbum: 'TIM',
    candId: 'kuwo_69086408',
    candTitle: 'Tough Love',
    candArtist: 'Avicii&Agnes&Vargas & Lagola',
    candDurSecs: 191,
    candAlbum: 'Tough Love',
  });
  assert.equal(
    applyDuplicateTitleTrackPenalty(aviciiWithAlbumScore, 'Tough Love', 'Tough Love', '69086408', isolatedGroups, 191, 0, 1),
    165
  );

  const aviciiNoAlbumScore = scoreTrackCandidate({
    targetTitle: 'Tough Love (feat. Agnes & Vargas & Lagola)',
    targetArtist: 'Avicii',
    targetDurSecs: 192,
    targetAlbum: null,
    candId: 'kuwo_69086408',
    candTitle: 'Tough Love',
    candArtist: 'Avicii&Agnes&Vargas & Lagola',
    candDurSecs: 191,
    candAlbum: 'Tough Love',
  });
  assert.equal(
    applyDuplicateTitleTrackPenalty(aviciiNoAlbumScore, 'Tough Love', 'Tough Love', '69086408', isolatedGroups, 191, 0, 1),
    190
  );

  // 3. Generic workout/BGM compilations receive -45 penalty without false positives on studio albums.
  const workoutScore = scoreTrackCandidate({
    targetTitle: 'Tough Love (feat. Agnes & Vargas & Lagola)',
    targetArtist: 'Avicii',
    targetDurSecs: 192,
    targetAlbum: 'TIM',
    candId: 'kuwo_143240279',
    candTitle: 'Tough Love',
    candArtist: 'Avicii&Agnes&Vargas & Lagola',
    candDurSecs: 193,
    candAlbum: 'Workout music hits 2020 (Explicit)',
  });
  assert.equal(workoutScore, 120);

  const gymBgmScore = scoreTrackCandidate({
    targetTitle: 'Tough Love (feat. Agnes & Vargas & Lagola)',
    targetArtist: 'Avicii',
    targetDurSecs: 192,
    targetAlbum: 'TIM',
    candId: 'kuwo_447094965',
    candTitle: 'Tough Love',
    candArtist: 'Avicii&Agnes&Vargas & Lagola',
    candDurSecs: 193,
    candAlbum: '健身BGM加油站 (Explicit)',
  });
  assert.equal(gymBgmScore, 120);

  for (const [album, dur, id] of [
    ['TIM', 191, 'kuwo_70188454'],
    ['Tough Love', 191, 'kuwo_69086408'],
  ]) {
    const cleanScore = scoreTrackCandidate({
      targetTitle: 'Tough Love (feat. Agnes & Vargas & Lagola)',
      targetArtist: 'Avicii',
      targetDurSecs: 192,
      targetAlbum: album,
      candId: id,
      candTitle: 'Tough Love',
      candArtist: 'Avicii&Agnes&Vargas & Lagola',
      candDurSecs: dur,
      candAlbum: album,
    });
    assert.equal(cleanScore, 255, `Expected 255 for ${album}, got ${cleanScore}`);
  }
  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'Demons',
      targetArtist: 'Imagine Dragons',
      targetDurSecs: 177,
      targetAlbum: 'Night Visions',
      candId: 'kuwo_69494807',
      candTitle: 'Demons',
      candArtist: 'Imagine Dragons',
      candDurSecs: 177,
      candAlbum: 'Night Visions',
    }),
    255
  );
  assert.equal(
    scoreTrackCandidate({
      targetTitle: 'Take on Me',
      targetArtist: 'a-ha',
      targetDurSecs: 226,
      targetAlbum: 'Hunting High and Low',
      candId: 'kuwo_195815265',
      candTitle: 'Take on Me',
      candArtist: 'A-Ha',
      candDurSecs: 225,
      candAlbum: 'Hunting High and Low',
    }),
    255
  );
});
