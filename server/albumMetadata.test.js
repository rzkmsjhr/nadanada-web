import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isKuwoOrWyyTrack,
  isLikelyPoisonedHifiAlbum,
  sanitizeTrackAlbum,
  resolveDisplayAlbumTitle,
  buildAlbumLibraryName,
  isAlbumTracklistView,
} from '../src/utils/albumMetadata.js';
import { awaitPrePlayGateResolution } from '../src/utils/hifiGate.js';

test('resolveDisplayAlbumTitle prefers authoritative YouTube albumCache over stored track.album', () => {
  assert.equal(
    resolveDisplayAlbumTitle(
      {
        id: 'yt_queen',
        title: 'I Want to Break Free',
        channel: 'Queen',
        source: 'kuwo',
        album: 'Pop',
      },
      { album: 'The Works' }
    ),
    'The Works'
  );

  assert.equal(
    resolveDisplayAlbumTitle(
      {
        id: 'yt_bonnie',
        title: 'Total Eclipse of the Heart',
        channel: 'Bonnie Tyler',
        source: 'kuwo',
        hifi_id: 'kuwo_999',
        album: '世界上最动听的歌超级天籁系列合集 上',
      },
      { album: 'Faster Than the Speed of Night' }
    ),
    'Faster Than the Speed of Night'
  );
});

test('sanitizeTrackAlbum and isLikelyPoisonedHifiAlbum strip Chinese/Korean compilation titles on Western tracks', () => {
  const compilationTitles = [
    '世界上最动听的歌超级天籁系列合集 上',
    '綠鋼琴 李察篇 第五輯',
    '2002英文',
    '全球音乐极品珍藏集2',
    '추억의 팝송 모음',
    '欧美经典老歌 Best Hits',
  ];

  for (const album of compilationTitles) {
    const kuwoTrack = {
      id: 'yt_western',
      title: 'Right Here Waiting',
      channel: 'Richard Marx',
      source: 'kuwo',
      hifi_id: 'kuwo_12345',
      album,
    };
    const wyyTrack = {
      id: 'yt_western_wyy',
      title: 'Total Eclipse of the Heart',
      channel: 'Bonnie Tyler',
      hifi_id: 'wyy_67890',
      album,
    };

    assert.equal(isKuwoOrWyyTrack(kuwoTrack), true);
    assert.equal(isLikelyPoisonedHifiAlbum(album, kuwoTrack), true, `Expected poisoned: ${album}`);
    assert.equal(sanitizeTrackAlbum(album, kuwoTrack), '');
    assert.equal(resolveDisplayAlbumTitle(kuwoTrack, null), '');

    assert.equal(isKuwoOrWyyTrack(wyyTrack), true);
    assert.equal(isLikelyPoisonedHifiAlbum(album, wyyTrack), true, `Expected poisoned (WYY): ${album}`);
    assert.equal(sanitizeTrackAlbum(album, wyyTrack), '');
  }
});

test('preserves legitimate CJK/Korean/Japanese tracks and mixed-script K-Pop albums', () => {
  const cjkTracks = [
    {
      title: '稻香',
      artist: '周杰伦',
      source: 'kuwo',
      hifi_id: 'kuwo_1',
      album: '魔杰座',
    },
    {
      title: 'Standing Next to You',
      channel: '정국 (Jung Kook)',
      source: 'wyy',
      hifi_id: 'wyy_2',
      album: 'GOLDEN',
    },
    {
      title: '真夜中のドア / Stay With Me',
      artist: 'Miki Matsubara',
      source: 'kuwo',
      hifi_id: 'kuwo_3',
      album: 'Pocket Park',
    },
    {
      title: 'Plastic Love',
      artist: 'Mariya Takeuchi',
      source: 'kuwo',
      hifi_id: 'kuwo_4',
      album: 'VARIETY',
    },
    {
      title: 'Love Maze',
      channel: 'BTS',
      source: 'kuwo',
      hifi_id: 'kuwo_5',
      album: "LOVE YOURSELF 轉 'Tear'",
    },
  ];

  for (const track of cjkTracks) {
    assert.equal(isLikelyPoisonedHifiAlbum(track.album, track), false, `False positive on ${track.album}`);
    assert.equal(sanitizeTrackAlbum(track.album, track), track.album);
    assert.equal(resolveDisplayAlbumTitle(track, null), track.album);
  }
});

test('awaitPrePlayGateResolution preserves original song.album even if resolver returns a compilation album', async () => {
  const originalSong = {
    id: 'yt_marx',
    title: 'Right Here Waiting',
    channel: 'Richard Marx',
    album: 'Repeat Offender',
  };

  const result = await awaitPrePlayGateResolution(
    originalSong,
    async () => ({
      hifi_id: 'kuwo_555',
      stream_url: '/hifi/stream?id=kuwo_555',
      source: 'kuwo',
      album: '綠鋼琴 李察篇 第五輯',
    }),
    { timeoutMs: 200, hifiVersion: 15 }
  );

  assert.equal(result.matched, true);
  assert.equal(result.track.stream_url, '/hifi/stream?id=kuwo_555');
  assert.equal(result.track.album, 'Repeat Offender');

  const withoutOriginalAlbum = {
    id: 'yt_bonnie',
    title: 'Total Eclipse of the Heart',
    channel: 'Bonnie Tyler',
  };
  const noOverwriteResult = await awaitPrePlayGateResolution(
    withoutOriginalAlbum,
    async () => ({
      hifi_id: 'kuwo_777',
      stream_url: '/hifi/stream?id=kuwo_777',
      source: 'kuwo',
      album: '世界上最动听的歌超级天籁系列合集 上',
    }),
    { timeoutMs: 200, hifiVersion: 15 }
  );
  assert.equal(noOverwriteResult.matched, true);
  assert.equal(noOverwriteResult.track.album, undefined);
});

test('buildAlbumLibraryName formats Artist - Album Title and infers missing artist from tracks', () => {
  assert.equal(
    buildAlbumLibraryName({ albumTitle: 'LOVED', albumArtist: 'Parcels - Topic' }),
    'Parcels - LOVED'
  );

  assert.equal(
    buildAlbumLibraryName({ albumTitle: 'LOVED', albumArtist: 'Album • Parcels • 2025' }),
    'Parcels - LOVED'
  );

  assert.equal(
    buildAlbumLibraryName({ albumTitle: 'Live Vol. 1', albumArtist: 'EP • Parcels • 2024 • 5 tracks' }),
    'Parcels - Live Vol. 1'
  );

  assert.equal(
    buildAlbumLibraryName({
      albumTitle: 'LOVED',
      albumArtist: 'Album • 2025',
      tracks: [{ artist: 'Parcels' }],
    }),
    'Parcels - LOVED'
  );

  assert.equal(
    buildAlbumLibraryName({
      albumTitle: 'LOVED',
      albumArtist: 'Unknown Artist',
      tracks: [
        { title: 'Tobeloved', channel: 'Parcels - Topic' },
        { title: 'Ifyoucall', artist: 'Parcels' },
        { title: 'Sorry', channel: 'Guest' },
      ],
    }),
    'Parcels - LOVED'
  );

  assert.equal(
    buildAlbumLibraryName({
      albumTitle: 'Parcels - LOVED',
      albumArtist: 'Parcels',
    }),
    'Parcels - LOVED'
  );

  assert.equal(buildAlbumLibraryName({ albumTitle: 'Album: Discovery', albumArtist: '' }), 'Discovery');
  assert.equal(buildAlbumLibraryName({ albumTitle: '', albumArtist: '' }), 'My Album');
});

test('isAlbumTracklistView detects direct albums, tagged saved albums, and legacy saved album playlists', () => {
  const discoveryTracks = [
    { id: '1', title: 'One More Time', channel: 'Daft Punk', album: 'Discovery' },
    { id: '2', title: 'Aerodynamic', channel: 'Daft Punk', album: 'Discovery' },
  ];

  assert.equal(isAlbumTracklistView({ centerMode: 'album', tracks: discoveryTracks }), true);
  assert.equal(isAlbumTracklistView({ centerMode: 'queue', tracks: discoveryTracks }), false);
  assert.equal(isAlbumTracklistView({ centerMode: 'search', tracks: discoveryTracks }), false);
  assert.equal(isAlbumTracklistView({ centerMode: 'liked', tracks: discoveryTracks }), false);

  assert.equal(
    isAlbumTracklistView({
      centerMode: 'playlist',
      tracks: discoveryTracks,
      playlist: { id: 'pl_1', name: 'Daft Punk - Discovery' },
    }),
    true
  );

  assert.equal(
    isAlbumTracklistView({
      centerMode: 'playlist',
      tracks: discoveryTracks,
      playlist: { id: 'pl_2', name: 'My Favorite Album', isAlbum: true },
    }),
    true
  );

  assert.equal(
    isAlbumTracklistView({
      centerMode: 'playlist',
      tracks: [
        { id: '1', title: 'One More Time', channel: 'Daft Punk', album: 'Discovery' },
        { id: '2', title: 'Around the World', channel: 'Daft Punk', album: 'Homework' },
      ],
      playlist: { id: 'pl_3', name: 'Daft Punk - Discovery' },
    }),
    false
  );

  assert.equal(
    isAlbumTracklistView({
      centerMode: 'playlist',
      tracks: discoveryTracks,
      playlist: { id: 'pl_4', name: 'Workout Mix' },
    }),
    false
  );
});
