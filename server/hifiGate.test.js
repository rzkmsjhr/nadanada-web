import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldRunPrePlayGate,
  awaitPrePlayGateResolution,
  shouldApplyLiveHifiSwitch,
} from '../src/utils/hifiGate.js';

test('shouldRunPrePlayGate allows unchecked eligible tracks and skips already resolved or excluded ones', () => {
  const baseTrack = { id: 'yt_123', title: 'Track A', duration: '3:30' };

  assert.equal(shouldRunPrePlayGate(baseTrack, { isHifiEnabled: true, hifiVersion: 15 }), true);

  assert.equal(
    shouldRunPrePlayGate({ ...baseTrack, stream_url: '/hifi/123' }, { isHifiEnabled: true, hifiVersion: 15 }),
    false
  );
  assert.equal(shouldRunPrePlayGate(baseTrack, { isHifiEnabled: false, hifiVersion: 15 }), false);
  assert.equal(shouldRunPrePlayGate(baseTrack, { isHifiEnabled: true, isEligible: false }), false);
  assert.equal(shouldRunPrePlayGate(baseTrack, { isHifiEnabled: true, isUserYoutubeForced: true }), false);
  assert.equal(shouldRunPrePlayGate({ ...baseTrack, _userForcedYoutube: true }, { isHifiEnabled: true }), false);
  assert.equal(shouldRunPrePlayGate({ ...baseTrack, _hifiFailed: true }, { isHifiEnabled: true }), false);
  assert.equal(shouldRunPrePlayGate(baseTrack, { isHifiEnabled: true, isFailedId: true }), false);
  assert.equal(shouldRunPrePlayGate(baseTrack, { isHifiEnabled: true, isCoolingDown: true }), false);

  assert.equal(
    shouldRunPrePlayGate(
      { ...baseTrack, _hifiChecked: true, _hifiVersion: 15 },
      { isHifiEnabled: true, hifiVersion: 15 }
    ),
    false
  );
  assert.equal(
    shouldRunPrePlayGate(
      { ...baseTrack, _hifiChecked: true, _hifiVersion: 14 },
      { isHifiEnabled: true, hifiVersion: 15 }
    ),
    true
  );
});

test('awaitPrePlayGateResolution resolves FLAC before playback and handles fallback or timeout cleanly', async () => {
  const baseTrack = { id: 'yt_456', title: 'Test Song' };

  const matched = await awaitPrePlayGateResolution(
    baseTrack,
    async () => ({ hifi_id: 'kw_1', stream_url: '/hifi/kw_1', source: 'kuwo' }),
    { timeoutMs: 200, hifiVersion: 15 }
  );
  assert.equal(matched.matched, true);
  assert.equal(matched.timedOut, false);
  assert.equal(matched.track.stream_url, '/hifi/kw_1');
  assert.equal(matched.track._hifiChecked, true);
  assert.equal(matched.track._hifiVersion, 15);
  assert.equal(matched.track._hifiFailed, false);

  const missed = await awaitPrePlayGateResolution(
    baseTrack,
    async () => null,
    { timeoutMs: 200, hifiVersion: 15 }
  );
  assert.equal(missed.matched, false);
  assert.equal(missed.timedOut, false);
  assert.equal(missed.track.stream_url, undefined);
  assert.equal(missed.track._hifiChecked, true);

  const timedOut = await awaitPrePlayGateResolution(
    baseTrack,
    () => new Promise(() => {}),
    { timeoutMs: 30, hifiVersion: 15 }
  );
  assert.equal(timedOut.matched, false);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.transient, true);
  assert.equal(timedOut.track._hifiChecked, true);

  const errored = await awaitPrePlayGateResolution(
    baseTrack,
    async () => {
      throw new Error('network error');
    },
    { timeoutMs: 200, hifiVersion: 15 }
  );
  assert.equal(errored.matched, false);
  assert.equal(errored.transient, true);
  assert.equal(errored.track._hifiChecked, true);
});

test('shouldApplyLiveHifiSwitch blocks mid-song YouTube->FLAC jumps unless manually retried or still paused at 0s', () => {
  const resolvedSong = { id: '1', stream_url: '/hifi/1' };
  const ytDeckSong = { id: '1', stream_url: null };

  assert.equal(
    shouldApplyLiveHifiSwitch({
      isHifiEnabled: true,
      currentSong: resolvedSong,
      deckSong: ytDeckSong,
      isPlaying: true,
      positionSecs: 8.5,
    }),
    false
  );

  assert.equal(
    shouldApplyLiveHifiSwitch({
      isHifiEnabled: true,
      currentSong: resolvedSong,
      deckSong: ytDeckSong,
      isPlaying: false,
      positionSecs: 1.5,
    }),
    false
  );

  assert.equal(
    shouldApplyLiveHifiSwitch({
      isHifiEnabled: true,
      currentSong: resolvedSong,
      deckSong: ytDeckSong,
      isPlaying: false,
      positionSecs: 0,
    }),
    true
  );

  assert.equal(
    shouldApplyLiveHifiSwitch({
      isHifiEnabled: true,
      currentSong: { ...resolvedSong, _manualHifiRetry: true },
      deckSong: ytDeckSong,
      isPlaying: true,
      positionSecs: 42,
    }),
    true
  );
});
