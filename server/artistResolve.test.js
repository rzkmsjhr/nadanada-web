import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArtistBrowseIdFromRuns, buildArtistCacheKey } from './youtube.js';

test('extractArtistBrowseIdFromRuns picks exact MUSIC_PAGE_TYPE_ARTIST run matching preferred artist', () => {
  const runs = [
    {
      text: 'Ali',
      navigationEndpoint: {
        browseEndpoint: {
          browseId: 'UCiGIMST5EwJKOSgGYoaNN1Q',
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' },
          },
        },
      },
    },
    { text: ' • ' },
    {
      text: 'Malaka',
      navigationEndpoint: {
        browseEndpoint: {
          browseId: 'MPREb_9YUdJ2b8tos',
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ALBUM' },
          },
        },
      },
    },
  ];

  assert.equal(extractArtistBrowseIdFromRuns(runs, 'Ali'), 'UCiGIMST5EwJKOSgGYoaNN1Q');
});

test('extractArtistBrowseIdFromRuns prefers matching collaborator over first artist and ignores albums', () => {
  const runs = [
    {
      text: 'First Artist',
      navigationEndpoint: {
        browseEndpoint: {
          browseId: 'UC1111111111111111111111',
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' },
          },
        },
      },
    },
    { text: ', ' },
    {
      text: 'ALI',
      navigationEndpoint: {
        browseEndpoint: {
          browseId: 'UCcM2nwYSXoS0pRpljTefmpg',
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' },
          },
        },
      },
    },
    {
      text: 'Wild Side',
      navigationEndpoint: {
        browseEndpoint: {
          browseId: 'MPREb_fFkE4RZM27z',
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ALBUM' },
          },
        },
      },
    },
  ];

  assert.equal(extractArtistBrowseIdFromRuns(runs, 'ALI'), 'UCcM2nwYSXoS0pRpljTefmpg');
  assert.equal(
    extractArtistBrowseIdFromRuns(runs.slice(-1), 'Wild Side'),
    null,
    'Album browseId must not be returned as an artist browseId'
  );
});

test('buildArtistCacheKey isolates homonym artists Ali vs ALI across browseId, videoId, and track context', () => {
  const indoBrowseKey = buildArtistCacheKey({ name: 'Ali', browseId: 'UCiGIMST5EwJKOSgGYoaNN1Q' });
  const jpBrowseKey = buildArtistCacheKey({ name: 'ALI', browseId: 'UCcM2nwYSXoS0pRpljTefmpg' });
  assert.notEqual(indoBrowseKey, jpBrowseKey);

  const indoVidKey = buildArtistCacheKey({
    name: 'Ali',
    videoId: 'D-bieOIP5_E',
    trackTitle: 'Ya Shaams',
    album: 'Malaka',
  });
  const jpVidKey = buildArtistCacheKey({
    name: 'ALI',
    videoId: 'u5heWZ9occg',
    trackTitle: 'Wild Side',
    album: 'Wild Side',
  });
  assert.notEqual(indoVidKey, jpVidKey);

  // Non-YT ID (e.g. Monochrome numeric ID) must fall back to contextual title+album key rather than bare name
  const monoIndoKey = buildArtistCacheKey({
    name: 'Ali',
    videoId: '158530885965234176',
    trackTitle: 'Ya Shaams',
    album: 'Malaka',
  });
  const monoJpKey = buildArtistCacheKey({
    name: 'ALI',
    videoId: '9999999999',
    trackTitle: 'Wild Side',
    album: 'Wild Side',
  });
  const bareKey = buildArtistCacheKey({ name: 'Ali' });

  assert.notEqual(monoIndoKey, monoJpKey);
  assert.notEqual(monoIndoKey, bareKey);
  assert.equal(monoIndoKey, 'ctx:ali|ya shaams|malaka');
  assert.equal(bareKey, 'name:ali');
});
