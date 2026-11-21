import test from 'node:test';
import assert from 'node:assert/strict';
import { pickBestTrendingResult, buildCleanTrendingFallbackQuery } from '../src/utils/trendingMatcher.js';

test('prefers original P!nk ft. Nate Ruess studio track over top tribute and cover edits', () => {
  const entry = {
    artist: 'P!nk',
    title: 'Just Give Me a Reason (w/ Nate Ruess)',
    query: 'P!nk - Just Give Me a Reason (w/ Nate Ruess)',
  };
  const results = [
    {
      id: '1xhXVHV1j30',
      title: 'Just Give Me a Reason (Voicy Edit)',
      channel: 'Vince Benet & Givel White',
      album: 'Just Give Me a Reason : A Tribute to Pink',
    },
    {
      id: 'Cf0XHXGnHZQ',
      title: 'Just Give Me a Reason (Piano Version) [Made Famous by P!Nk and Nate Ruess]',
      channel: 'Relaxing Piano Covers',
      album: 'Piano Covers of Hit Songs, Vol. 4',
    },
    {
      id: 'MERqWkSURxU',
      title: 'Just Give Me a Reason (Cover of P!nk)',
      channel: 'Crash Destruction',
      album: 'The Best Of Cover Songs Vol. 1',
    },
    {
      id: 'a1pWN2ixeVY',
      title: 'Just Give Me a Reason (feat. Nate Ruess)',
      channel: 'P!NK',
      album: 'The Truth About Love',
    },
  ];

  const { item, score } = pickBestTrendingResult(results, entry);
  assert.equal(item.id, 'a1pWN2ixeVY');
  assert.ok(score > 100);
});

test('handles accented artist names and keeps official lead track first when clean', () => {
  const entry = {
    artist: 'eńau',
    title: 'Sesi Potret (w/ Ari Lesmana)',
    query: 'eńau - Sesi Potret (w/ Ari Lesmana)',
  };
  const results = [
    {
      id: 'abc12345678',
      title: 'Sesi Potret (feat. Ari Lesmana)',
      channel: 'eńau',
      album: 'Sesi Potret',
    },
    {
      id: 'def12345678',
      title: 'Sesi Potret (Karaoke Version)',
      channel: 'Indo Karaoke',
      album: 'Karaoke Hits',
    },
  ];
  const { item } = pickBestTrendingResult(results, entry);
  assert.equal(item.id, 'abc12345678');
});

test('builds clean fallback query stripping (w/ ...) and punctuation like P!nk', () => {
  const q = buildCleanTrendingFallbackQuery({
    artist: 'P!nk',
    title: 'Just Give Me a Reason (w/ Nate Ruess)',
  });
  assert.equal(q, 'pink just give me a reason nate ruess');
});
