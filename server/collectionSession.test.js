import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIsolatedSession,
  adjustIsolatedSessionOnRemove,
  mergeSessionTrackOverrides,
  resolveSessionAfterClearAll,
} from '../src/utils/collectionSession.js';

test('buildIsolatedSession isolates album/playlist sessions and preserves overrides only within same collection', () => {
  const s1 = buildIsolatedSession(null, {
    mode: 'album',
    key: 'alb_1',
    index: 2,
    tracks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  });
  assert.equal(s1.mode, 'album');
  assert.equal(s1.key, 'alb_1');
  assert.equal(s1.index, 2);
  assert.equal(s1.tracks.length, 3);

  const withOverrides = mergeSessionTrackOverrides(s1, [{ id: 'a', stream_url: '/hifi/a' }]);
  assert.equal(withOverrides.overrides.a.stream_url, '/hifi/a');

  const sameAlbumNext = buildIsolatedSession(withOverrides, {
    mode: 'album',
    key: 'alb_1',
    index: 0,
    tracks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  });
  assert.equal(sameAlbumNext.overrides.a.stream_url, '/hifi/a');

  const differentAlbum = buildIsolatedSession(withOverrides, {
    mode: 'album',
    key: 'alb_2',
    index: 1,
    tracks: [{ id: 'x' }, { id: 'y' }],
  });
  assert.deepEqual(differentAlbum.overrides, {});
  assert.equal(differentAlbum.tracks.length, 2);
});

test('adjustIsolatedSessionOnRemove shifts indices and terminates empty album/playlist sessions', () => {
  const albumSession = {
    mode: 'album',
    key: 'alb_1',
    index: 1,
    tracks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    overrides: {},
  };
  const afterEarlierDelete = adjustIsolatedSessionOnRemove(albumSession, {
    mode: 'album',
    key: 'alb_1',
    removedIdx: 0,
  });
  assert.equal(afterEarlierDelete.index, 0);
  assert.deepEqual(
    afterEarlierDelete.tracks.map((t) => t.id),
    ['b', 'c']
  );

  const afterOtherCollection = adjustIsolatedSessionOnRemove(albumSession, {
    mode: 'album',
    key: 'other',
    removedIdx: 0,
  });
  assert.equal(afterOtherCollection, albumSession);

  const singleItem = { mode: 'playlist', key: 'pl_1', index: 0, overrides: {} };
  assert.equal(
    adjustIsolatedSessionOnRemove(singleItem, { mode: 'playlist', key: 'pl_1', removedIdx: 0, nextTracks: [] }),
    null
  );
});

test('resolveSessionAfterClearAll preserves playing album/playlist when clearing main queue or other views', () => {
  const albumSession = {
    mode: 'album',
    key: 'alb_1',
    index: 1,
    tracks: [{ id: 'a' }, { id: 'b' }],
    overrides: {},
  };
  const playlistSession = {
    mode: 'playlist',
    key: 'pl_1',
    index: 0,
    overrides: {},
  };

  assert.equal(
    resolveSessionAfterClearAll(albumSession, {
      centerMode: 'queue',
      selectedPlaylistId: null,
      activeAlbumKey: 'alb_1',
    }),
    albumSession
  );
  assert.equal(
    resolveSessionAfterClearAll(playlistSession, {
      centerMode: 'queue',
      selectedPlaylistId: 'pl_1',
      activeAlbumKey: null,
    }),
    playlistSession
  );
  assert.equal(
    resolveSessionAfterClearAll(albumSession, {
      centerMode: 'liked',
      selectedPlaylistId: null,
      activeAlbumKey: 'alb_1',
    }),
    albumSession
  );
  assert.equal(
    resolveSessionAfterClearAll(albumSession, {
      centerMode: 'album',
      selectedPlaylistId: null,
      activeAlbumKey: 'alb_2',
    }),
    albumSession
  );
  assert.equal(
    resolveSessionAfterClearAll(playlistSession, {
      centerMode: 'playlist',
      selectedPlaylistId: 'pl_2',
      activeAlbumKey: null,
    }),
    playlistSession
  );

  assert.equal(
    resolveSessionAfterClearAll(albumSession, {
      centerMode: 'album',
      selectedPlaylistId: null,
      activeAlbumKey: 'alb_1',
    }),
    null
  );
  assert.equal(
    resolveSessionAfterClearAll(playlistSession, {
      centerMode: 'playlist',
      selectedPlaylistId: 'pl_1',
      activeAlbumKey: null,
    }),
    null
  );
});
