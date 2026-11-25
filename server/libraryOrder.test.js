import test from 'node:test';
import assert from 'node:assert/strict';
import {
  promotePlaylistToTop,
  findMatchingSavedPlaylistId,
} from '../src/utils/libraryOrder.js';

test('promotePlaylistToTop moves middle or bottom playlist to index 0 while preserving other order', () => {
  const lists = [
    { id: 'pl_1', name: 'First' },
    { id: 'pl_2', name: 'Second' },
    { id: 'pl_3', name: 'Third' },
  ];

  const promotedBottom = promotePlaylistToTop(lists, 'pl_3', 1000);
  assert.deepEqual(
    promotedBottom.map((p) => p.id),
    ['pl_3', 'pl_1', 'pl_2']
  );
  assert.equal(promotedBottom[0].lastPlayedAt, 1000);

  const promotedMiddle = promotePlaylistToTop(promotedBottom, 'pl_1', 2000);
  assert.deepEqual(
    promotedMiddle.map((p) => p.id),
    ['pl_1', 'pl_3', 'pl_2']
  );
  assert.equal(promotedMiddle[0].lastPlayedAt, 2000);

  const updatedTop = promotePlaylistToTop(promotedMiddle, 'pl_1', 3000);
  assert.deepEqual(
    updatedTop.map((p) => p.id),
    ['pl_1', 'pl_3', 'pl_2']
  );
  assert.equal(updatedTop[0].lastPlayedAt, 3000);

  // Unknown id returns input untouched
  assert.deepEqual(promotePlaylistToTop(lists, 'pl_missing', 4000), lists);
});

test('findMatchingSavedPlaylistId matches saved albums by formatted name, plain name, or track overlap', () => {
  const playlists = [
    {
      id: 'pl_a',
      name: 'Avicii - TIM',
      tracks: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
    },
    {
      id: 'pl_b',
      name: 'Parcels - LOVED',
      tracks: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
    },
    {
      id: 'pl_c',
      name: 'Discovery',
      tracks: [{ id: 'd1' }, { id: 'd2' }],
    },
    {
      id: 'pl_d',
      name: 'Renamed Custom Album',
      tracks: [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }],
    },
  ];

  // 1. Matches "Artist - Album Title"
  assert.equal(
    findMatchingSavedPlaylistId(playlists, { albumTitle: 'LOVED', albumArtist: 'Parcels' }),
    'pl_b'
  );

  // 2. Matches plain Album Title
  assert.equal(
    findMatchingSavedPlaylistId(playlists, { albumTitle: 'Discovery', albumArtist: 'Daft Punk' }),
    'pl_c'
  );

  // 3. Matches renamed playlist via >= 2 shared track IDs
  assert.equal(
    findMatchingSavedPlaylistId(playlists, {
      albumTitle: 'Totally Different Title',
      albumArtist: 'Some Artist',
      albumTracks: [{ id: 'x1' }, { id: 'x3' }, { id: 'x9' }],
    }),
    'pl_d'
  );

  // 4. Returns null when unrelated (or only 1 track overlap on multi-track album)
  assert.equal(
    findMatchingSavedPlaylistId(playlists, {
      albumTitle: 'Unrelated Album',
      albumArtist: 'Other',
      albumTracks: [{ id: 'x1' }, { id: 'z2' }],
    }),
    null
  );
});
