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
  scoreTrackCandidate,
} from './hifiMatcher.js';
import { hasFlacMagicPrefix, isValidKuwoFlacUrl } from './hifi.js';

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
