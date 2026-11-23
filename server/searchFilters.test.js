import test from 'node:test';
import assert from 'node:assert/strict';

import { filterSearchResultsByTab } from '../src/utils/searchFilters.js';

test('filterSearchResultsByTab strictly isolates song, video, and album results without cross-tab leaks', () => {
  const isVideoMock = (item) =>
    item.item_type === 'video' || /official\s*video/i.test(item.title || '');

  const mixed = [
    { id: 's1', title: 'Different Lives', item_type: 'song', is_playlist: false },
    { id: 's2', title: 'Different Lives (Official Video)', item_type: 'song', is_playlist: false },
    { id: 'v1', title: 'Different Lives (Lyric Video)', item_type: 'video', is_playlist: false },
    { id: 'a1', title: 'Different Lives', item_type: 'album', is_playlist: true },
  ];

  const songs = filterSearchResultsByTab(mixed, 'song', isVideoMock);
  assert.deepEqual(songs.map((x) => x.id), ['s1']);

  const videos = filterSearchResultsByTab(mixed, 'video', isVideoMock);
  assert.deepEqual(videos.map((x) => x.id), ['v1']);

  const albums = filterSearchResultsByTab(mixed, 'album', isVideoMock);
  assert.deepEqual(albums.map((x) => x.id), ['a1']);
});
