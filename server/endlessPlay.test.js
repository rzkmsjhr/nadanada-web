import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractEndlessSeedTracks,
  buildAllowedScripts,
  isCohesiveExpansionMix,
  pickCoreExpansionSeed,
  pickNextEndlessCandidate,
  parseTrackDurationSecs,
} from '../src/utils/endlessPlay.js';

function makeTrack(id, title, channel, duration = '3:45', extra = {}) {
  return { id, title, channel, duration, item_type: 'song', ...extra };
}

test('parseTrackDurationSecs handles numeric seconds, ms, and MM:SS / HH:MM:SS', () => {
  assert.equal(parseTrackDurationSecs('233'), 233);
  assert.equal(parseTrackDurationSecs('3:59'), 239);
  assert.equal(parseTrackDurationSecs('1:02:03'), 3723);
  assert.equal(parseTrackDurationSecs(233000), 233);
  assert.equal(parseTrackDurationSecs(233), 233);
});

test('screenshot regression: 2000s rock queue via Coldplay rejects ENHYPEN / BTS / Jung Kook drift', () => {
  const rockQueue = [
    makeTrack('rockSeed001', 'The Reason', 'Hoobastank', '233'),
    makeTrack('rockSeed002', 'Here Without You', '3 Doors Down', '3:59'),
    makeTrack('rockSeed003', 'Far Away', 'Nickelback', '3:59'),
    makeTrack('rockSeed004', 'Wherever You Will Go', 'The Calling', '3:29'),
    makeTrack('rockSeed005', 'Numb', 'Linkin Park', '3:08'),
    makeTrack('rockSeed006', 'Bring Me To Life', 'Evanescence', '3:56'),
    makeTrack('rockSeed007', 'Zombie', 'The Cranberries', '5:08'),
    makeTrack('rockSeed008', 'Creep', 'Radiohead', '3:59'),
    makeTrack('rockSeed009', 'Yellow', 'Coldplay', '4:27'),
  ];

  const { seeds, userBlockTracks } = extractEndlessSeedTracks(rockQueue, { maxSeeds: 3 });
  assert.equal(seeds.length, 3);
  // Spread across tail, start, and middle so Coldplay alone cannot dominate
  assert.deepEqual(
    seeds.map((s) => s.id),
    ['rockSeed009', 'rockSeed001', 'rockSeed005']
  );

  const coldplayMix = [
    makeTrack('kpopDrift01', 'I Want You (NI-KI Ver.)', 'ENHYPEN', '1:37', { mix_rank: 0 }),
    makeTrack('kpopDrift02', 'Love Maze', 'BTS', '3:42', { mix_rank: 1 }),
    makeTrack('kpopDrift03', 'Yes or No', '정국 (Jung Kook)', '2:28', { mix_rank: 2 }),
    makeTrack('rockCand001', 'Everlong', 'Foo Fighters', '4:10', { mix_rank: 6 }),
    makeTrack('rockCand002', 'Iris', 'Goo Goo Dolls', '4:49', { mix_rank: 8 }),
  ];
  const hoobastankMix = [
    makeTrack('rockCand002', 'Iris', 'Goo Goo Dolls', '4:49', { mix_rank: 2 }),
    makeTrack('rockCand001', 'Everlong', 'Foo Fighters', '4:10', { mix_rank: 4 }),
    makeTrack('rockCand003', 'Kryptonite', '3 Doors Down', '3:54', { mix_rank: 5 }),
  ];
  const linkinMix = [
    makeTrack('rockCand001', 'Everlong', 'Foo Fighters', '4:10', { mix_rank: 3 }),
    makeTrack('rockCand004', 'In the End', 'Linkin Park', '3:36', { mix_rank: 4 }),
  ];

  const picked = pickNextEndlessCandidate({
    queue: rockQueue,
    userBlockTracks,
    seedMixes: [
      { seedId: 'rockSeed009', weight: 1.0, tracks: coldplayMix, isCoreNeighbor: false },
      { seedId: 'rockSeed001', weight: 0.95, tracks: hoobastankMix, isCoreNeighbor: false },
      { seedId: 'rockSeed005', weight: 0.95, tracks: linkinMix, isCoreNeighbor: false },
    ],
  });

  assert.ok(picked);
  assert.equal(picked.id, 'rockCand001');
  assert.ok(!['kpopDrift01', 'kpopDrift02', 'kpopDrift03'].includes(picked.id));
});

test('single-seed anti-Markov-walk: ignores endless tracks and gates 1-hop expansion by mix cohesion', () => {
  const queue = [
    makeTrack('rockSeed001', 'The Reason', 'Hoobastank', '3:52'),
    makeTrack('rockGen0001', 'Here Without You', '3 Doors Down', '3:59', { isEndlessGenerated: true }),
    makeTrack('rockGen0002', 'Yellow', 'Coldplay', '4:27', { isEndlessGenerated: true }),
  ];

  const { seeds } = extractEndlessSeedTracks(queue, { maxSeeds: 3 });
  assert.deepEqual(seeds.map((s) => s.id), ['rockSeed001']);

  const primaryRockMix = [
    makeTrack('rockSeed001', 'The Reason', 'Hoobastank', '3:52', { mix_rank: 0 }),
    makeTrack('rockNbr0001', 'Wherever You Will Go', 'The Calling', '3:29', { mix_rank: 1 }),
    makeTrack('rockNbr0002', 'Iris', 'Goo Goo Dolls', '4:49', { mix_rank: 2 }),
    makeTrack('rockNbr0003', 'Lifehouse', 'Hanging By A Moment', '3:36', { mix_rank: 3 }),
  ];

  const coreNeighbor = pickCoreExpansionSeed(primaryRockMix, {
    usedSeedIds: new Set(['rockSeed001']),
    userBlockTracks: seeds,
  });
  assert.equal(coreNeighbor?.id, 'rockNbr0001');

  const cohesiveRockMix = [
    makeTrack('rockNbr0002', 'Iris', 'Goo Goo Dolls', '4:49', { mix_rank: 1 }),
    makeTrack('rockSeed001', 'The Reason', 'Hoobastank', '3:52', { mix_rank: 2 }),
    makeTrack('rockNbr0004', 'How You Remind Me', 'Nickelback', '3:43', { mix_rank: 4 }),
  ];
  const driftingKpopMix = [
    makeTrack('kpopMix0001', 'Love Maze', 'BTS', '3:42', { mix_rank: 0 }),
    makeTrack('kpopMix0002', 'Yes or No', 'Jung Kook', '2:28', { mix_rank: 1 }),
    makeTrack('kpopMix0003', 'Bite Me', 'ENHYPEN', '2:37', { mix_rank: 2 }),
  ];

  assert.equal(isCohesiveExpansionMix(cohesiveRockMix, primaryRockMix), true);
  assert.equal(isCohesiveExpansionMix(driftingKpopMix, primaryRockMix), false);
});

test('mid-session user vibe pivot anchors to new contiguous user block after endless tracks', () => {
  const queue = [
    makeTrack('rockSeed001', 'The Reason', 'Hoobastank', '3:52'),
    makeTrack('rockGen0001', 'Numb', 'Linkin Park', '3:08', { isEndlessGenerated: true }),
    makeTrack('rockGen0002', 'Yellow', 'Coldplay', '4:27', { isEndlessGenerated: true }),
    makeTrack('daftSeed001', 'Get Lucky', 'Daft Punk', '4:08'),
  ];

  const { seeds, userBlockTracks } = extractEndlessSeedTracks(queue, { maxSeeds: 3 });
  assert.deepEqual(userBlockTracks.map((s) => s.id), ['daftSeed001']);
  assert.deepEqual(seeds.map((s) => s.id), ['daftSeed001']);
});

test('multilingual K-Pop / J-Pop support preserves Hangul tracks when primary mix is Hangul-heavy', () => {
  const seeds = [makeTrack('btsSeed0001', 'Dynamite', 'BTS', '3:19')];
  const primaryMix = [
    makeTrack('btsMix00001', '봄날 (Spring Day)', 'BTS', '4:34', { mix_rank: 0 }),
    makeTrack('btsMix00002', '밤편지 (Through the Night)', '아이유 (IU)', '4:13', { mix_rank: 1 }),
    makeTrack('btsMix00003', 'Attention', 'NewJeans', '3:00', { mix_rank: 2 }),
  ];

  const allowed = buildAllowedScripts(seeds, primaryMix);
  assert.equal(allowed.has('hangul'), true);

  const picked = pickNextEndlessCandidate({
    queue: seeds,
    userBlockTracks: seeds,
    seedMixes: [{ seedId: 'btsSeed0001', weight: 1.0, tracks: primaryMix, isCoreNeighbor: false }],
  });
  assert.equal(picked?.id, 'btsMix00002');
});

test('artist spacing, normalized duplicate detection, and karaoke / short-clip filters work', () => {
  const queue = [
    makeTrack('seedTrack01', 'The Reason', 'Hoobastank', '3:52'),
    makeTrack('recentArt01', 'Crawling', 'Linkin Park', '3:29', { isEndlessGenerated: true }),
  ];

  const mix = [
    makeTrack('dupUpload01', 'The Reason (Remastered 2024)', 'Hoobastank - Topic', '3:52', { mix_rank: 0 }),
    makeTrack('karaoke0001', 'Iris (Karaoke Version)', 'Sing King', '4:45', { mix_rank: 1 }),
    makeTrack('shortClip01', 'Intro Interlude', 'Band X', '1:20', { mix_rank: 2 }),
    makeTrack('recentSpc01', 'Faint', 'Linkin Park', '2:42', { mix_rank: 3 }),
    makeTrack('freshRock01', 'Chasing Cars', 'Snow Patrol', '4:27', { mix_rank: 6 }),
  ];

  const picked = pickNextEndlessCandidate({
    queue,
    userBlockTracks: [queue[0]],
    seedMixes: [{ seedId: 'seedTrack01', weight: 1.0, tracks: mix, isCoreNeighbor: false }],
  });

  assert.equal(picked?.id, 'freshRock01');
});
