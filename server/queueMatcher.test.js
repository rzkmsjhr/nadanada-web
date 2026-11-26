import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQueueMatcher,
  buildTrendingKey,
  isTrackInQueue,
  normalizeTrackText,
} from '../src/utils/queueMatcher.js';

test('screenshot regression: Changes does not falsely match Change (feat. James Taylor)', () => {
  const matcher = buildQueueMatcher([
    { id: 'cp_changes', title: 'Changes', channel: 'Charlie Puth' },
    { id: 'cp_beat', title: 'Beat Yourself Up', channel: 'Charlie Puth' },
  ]);

  assert.equal(isTrackInQueue(matcher, { id: 'cp_changes', title: 'Changes', channel: 'Charlie Puth' }), true);
  assert.equal(isTrackInQueue(matcher, { id: 'alt_changes', title: 'Changes', artist: 'Charlie Puth' }), true);
  assert.equal(isTrackInQueue(matcher, { id: 'cp_beat', title: 'Beat Yourself Up', channel: 'Charlie Puth' }), true);

  assert.equal(
    isTrackInQueue(matcher, {
      id: 'cp_change_ft',
      title: 'Change (feat. James Taylor)',
      channel: 'Charlie Puth',
    }),
    false
  );
  assert.equal(
    isTrackInQueue(matcher, {
      id: 'cp_change',
      title: 'Change',
      channel: 'Charlie Puth',
    }),
    false
  );
});

test('prevents short-title and mid-word artist false positives', () => {
  const matcher = buildQueueMatcher([
    { id: '1', title: 'Lovers', channel: 'Taylor Swift' },
    { id: '2', title: 'Someone Like You', channel: 'Adele' },
    { id: '3', title: 'Boy is a Liar', channel: 'PinkPantheress' },
  ]);

  assert.equal(isTrackInQueue(matcher, { id: '10', title: 'Love', artist: 'Taylor Swift' }), false);
  assert.equal(isTrackInQueue(matcher, { id: '11', title: 'You', artist: 'Adele' }), false);
  assert.equal(isTrackInQueue(matcher, { id: '12', title: 'Boy is a Liar', artist: 'Pink' }), false);
});

test('preserves legitimate cross-source, artist-prefixed video, truncated, ID, and trending key matches', () => {
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

  assert.equal(isTrackInQueue(matcher, { id: 'other_1', title: 'Changes', artist: 'Charlie Puth' }), true);
  assert.equal(
    isTrackInQueue(matcher, { id: 'other_2', title: 'Change (feat. James Taylor)', artist: 'Charlie Puth' }),
    false
  );
  assert.equal(
    isTrackInQueue(matcher, { id: 'other_3', title: "Nothing's Gonna Change My Love...", artist: 'Starship' }),
    true
  );
  assert.equal(isTrackInQueue(matcher, { id: 'yt_video_1', title: 'Any', artist: 'Any' }), true);
  assert.equal(
    isTrackInQueue(matcher, { id: 'other_4', title: 'Die With A Smile', artist: 'Lady Gaga & Bruno Mars' }),
    true
  );
  assert.equal(normalizeTrackText('Charlie Puth - Topic'), 'charlie puth');
});
