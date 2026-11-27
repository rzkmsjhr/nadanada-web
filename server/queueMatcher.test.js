import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQueueMatcher,
  buildTrendingKey,
  isTrackInQueue,
  normalizeTrackText,
} from '../src/utils/queueMatcher.js';

test('identified distinct song versions do not cross-match checkmarks (Separuh Nafas Kerajaan Cinta vs Bintang Lima)', () => {
  const matcher = buildQueueMatcher([
    {
      id: 'yt_dewa_kc',
      title: 'Separuh Nafas',
      channel: 'Dewa 19',
      album: 'Kerajaan Cinta',
      duration: '3:43',
    },
  ]);

  assert.equal(
    isTrackInQueue(matcher, {
      id: 'yt_dewa_kc',
      title: 'Separuh Nafas',
      channel: 'Dewa 19',
      album: 'Kerajaan Cinta',
      duration: '3:43',
    }),
    true
  );
  assert.equal(
    isTrackInQueue(matcher, {
      id: 'yt_dewa_bl',
      title: 'Separuh Nafas',
      channel: 'Dewa',
      album: 'Bintang Lima',
      duration: '5:01',
    }),
    false
  );
  assert.equal(
    isTrackInQueue(matcher, {
      id: 'cp_changes_v2',
      title: 'Changes',
      channel: 'Charlie Puth',
    }),
    false
  );
});

test('ID-less Trending entries: Changes does not falsely match Change (feat. James Taylor)', () => {
  const matcher = buildQueueMatcher([
    { id: 'cp_changes', title: 'Changes', channel: 'Charlie Puth' },
    { id: 'cp_beat', title: 'Beat Yourself Up', channel: 'Charlie Puth' },
  ]);

  assert.equal(isTrackInQueue(matcher, { id: 'cp_changes', title: 'Changes', channel: 'Charlie Puth' }), true);
  assert.equal(isTrackInQueue(matcher, { title: 'Changes', artist: 'Charlie Puth' }), true);
  assert.equal(isTrackInQueue(matcher, { title: 'Beat Yourself Up', artist: 'Charlie Puth' }), true);

  assert.equal(
    isTrackInQueue(matcher, {
      title: 'Change (feat. James Taylor)',
      artist: 'Charlie Puth',
    }),
    false
  );
  assert.equal(
    isTrackInQueue(matcher, {
      title: 'Change',
      artist: 'Charlie Puth',
    }),
    false
  );
});

test('prevents short-title and mid-word artist false positives on ID-less entries', () => {
  const matcher = buildQueueMatcher([
    { id: '1', title: 'Lovers', channel: 'Taylor Swift' },
    { id: '2', title: 'Someone Like You', channel: 'Adele' },
    { id: '3', title: 'Boy is a Liar', channel: 'PinkPantheress' },
  ]);

  assert.equal(isTrackInQueue(matcher, { title: 'Love', artist: 'Taylor Swift' }), false);
  assert.equal(isTrackInQueue(matcher, { title: 'You', artist: 'Adele' }), false);
  assert.equal(isTrackInQueue(matcher, { title: 'Boy is a Liar', artist: 'Pink' }), false);
});

test('preserves legitimate cross-source ID-less Trending matches, artist-prefixed video, truncated, ID, and trending key matches', () => {
  const matcher = buildQueueMatcher([
    {
      id: 'yt_video_1',
      title: 'Charlie Puth - Changes (Official Music Video)',
      channel: '7clouds',
    },
    {
      id: 'starship_1',
      title: "Nothing's Gonna Change My Love for You",
      channel: 'Starship - Topic',
    },
    {
      id: 'trend_1',
      title: 'Die With A Smile',
      channel: 'Lady Gaga & Bruno Mars',
      _trendingKey: buildTrendingKey('Die With A Smile', 'Lady Gaga & Bruno Mars'),
    },
  ]);

  assert.equal(isTrackInQueue(matcher, { title: 'Changes', artist: 'Charlie Puth' }), true);
  assert.equal(
    isTrackInQueue(matcher, { title: 'Change (feat. James Taylor)', artist: 'Charlie Puth' }),
    false
  );
  assert.equal(
    isTrackInQueue(matcher, { title: "Nothing's Gonna Change My Love...", artist: 'Starship' }),
    true
  );
  assert.equal(isTrackInQueue(matcher, { id: 'yt_video_1', title: 'Any', artist: 'Any' }), true);
  assert.equal(
    isTrackInQueue(matcher, { title: 'Die With A Smile', artist: 'Lady Gaga & Bruno Mars' }),
    true
  );
  assert.equal(normalizeTrackText('Charlie Puth - Topic'), 'charlie puth');
});
