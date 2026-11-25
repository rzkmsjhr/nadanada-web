import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIO_STALL_TIMEOUT_MS,
  RECOVERY_STALL_TIMEOUT_MS,
  NEAR_END_STALL_TIMEOUT_MS,
  YT_END_OVERSHOOT_GRACE_MS,
  YT_NEAR_END_STALL_TIMEOUT_MS,
  YT_HIDDEN_STALL_TIMEOUT_MS,
  evaluateAudioWatchdog,
  evaluateYouTubeWatchdog,
  evaluateRecoveryTimeout,
} from '../src/utils/playbackWatchdog.js';

test('evaluateAudioWatchdog resets retry budget on healthy progress and detects throttled or near-end stalls', () => {
  const key = 't1:/hifi/stream?id=1';

  let res = evaluateAudioWatchdog({
    key,
    time: 1.0,
    duration: 180,
    paused: false,
    seekOnLoad: 0,
    nowMs: 1000,
    tracker: null,
  });
  assert.equal(res.action, 'none');
  assert.equal(res.resetRetryBudget, false);

  res = evaluateAudioWatchdog({
    key,
    time: 3.5,
    duration: 180,
    paused: false,
    seekOnLoad: 0,
    nowMs: 3500,
    tracker: res.nextTracker,
  });
  assert.equal(res.action, 'none');
  assert.equal(res.resetRetryBudget, true);

  assert.equal(AUDIO_STALL_TIMEOUT_MS, 5000);
  // Simulate background timer throttling: single tick 5s later with unchanged currentTime
  res = evaluateAudioWatchdog({
    key,
    time: 3.5,
    duration: 180,
    paused: false,
    seekOnLoad: 0,
    nowMs: 3500 + AUDIO_STALL_TIMEOUT_MS,
    tracker: res.nextTracker,
  });
  assert.equal(res.action, 'recover');

  // Paused audio must never trigger stall recovery
  const pausedRes = evaluateAudioWatchdog({
    key,
    time: 3.5,
    duration: 180,
    paused: true,
    seekOnLoad: 0,
    nowMs: 50000,
    tracker: res.nextTracker,
  });
  assert.equal(pausedRes.action, 'none');

  // Near-end stall (within final 1.5s for 2.5s) advances as ended instead of stuck buffering
  let endRes = evaluateAudioWatchdog({
    key,
    time: 178.9,
    duration: 180,
    paused: false,
    seekOnLoad: 0,
    nowMs: 60000,
    tracker: pausedRes.nextTracker,
  });
  assert.equal(endRes.action, 'none');
  endRes = evaluateAudioWatchdog({
    key,
    time: 178.9,
    duration: 180,
    paused: false,
    seekOnLoad: 0,
    nowMs: 60000 + NEAR_END_STALL_TIMEOUT_MS,
    tracker: endRes.nextTracker,
  });
  assert.equal(endRes.action, 'ended');
});

test('evaluateYouTubeWatchdog detects ended state, near-end freeze, wall-clock overshoot, and hidden iframe stalls', () => {
  const key = 'yt1:0';

  const endedDirect = evaluateYouTubeWatchdog({
    key,
    playerState: 0,
    time: 120,
    duration: 120,
    isHidden: true,
    nowMs: 1000,
    tracker: null,
  });
  assert.equal(endedDirect.action, 'ended');

  // Near-end freeze while playerState stays 1 or 3
  let nearEnd = evaluateYouTubeWatchdog({
    key,
    playerState: 1,
    time: 198.7,
    duration: 200,
    isHidden: true,
    nowMs: 10000,
    tracker: null,
  });
  assert.equal(nearEnd.action, 'none');
  nearEnd = evaluateYouTubeWatchdog({
    key,
    playerState: 1,
    time: 198.7,
    duration: 200,
    isHidden: true,
    nowMs: 10000 + YT_NEAR_END_STALL_TIMEOUT_MS,
    tracker: nearEnd.nextTracker,
  });
  assert.equal(nearEnd.action, 'ended');

  // Wall-clock overshoot: iframe throttled state 0 while reporting stale state 1 & stale currentTime
  let overshoot = evaluateYouTubeWatchdog({
    key: 'yt2:0',
    playerState: 1,
    time: 190,
    duration: 200,
    isHidden: true,
    nowMs: 20000,
    tracker: null,
  });
  assert.equal(overshoot.action, 'none');
  overshoot = evaluateYouTubeWatchdog({
    key: 'yt2:0',
    playerState: 1,
    time: 190,
    duration: 200,
    isHidden: true,
    nowMs: 20000 + 10000 + YT_END_OVERSHOOT_GRACE_MS,
    tracker: overshoot.nextTracker,
  });
  assert.equal(overshoot.action, 'ended');

  // Hidden non-playing stall triggers fallback after 3.5s, visible non-playing does not
  let hiddenStall = evaluateYouTubeWatchdog({
    key: 'yt3:0',
    playerState: 2,
    time: 10,
    duration: 200,
    isHidden: true,
    nowMs: 30000,
    tracker: null,
  });
  assert.equal(hiddenStall.action, 'none');
  const visibleSame = evaluateYouTubeWatchdog({
    key: 'yt3:0',
    playerState: 2,
    time: 10,
    duration: 200,
    isHidden: false,
    nowMs: 30000 + YT_HIDDEN_STALL_TIMEOUT_MS,
    tracker: hiddenStall.nextTracker,
  });
  assert.equal(visibleSame.action, 'none');

  hiddenStall = evaluateYouTubeWatchdog({
    key: 'yt3:0',
    playerState: 2,
    time: 10,
    duration: 200,
    isHidden: true,
    nowMs: 30000 + YT_HIDDEN_STALL_TIMEOUT_MS,
    tracker: hiddenStall.nextTracker,
  });
  assert.equal(hiddenStall.action, 'fallback');
});

test('evaluateRecoveryTimeout bounds stuck audio recovery attempts cleanly', () => {
  assert.equal(RECOVERY_STALL_TIMEOUT_MS, 10000);
  assert.equal(evaluateRecoveryTimeout({ isRecovering: false, recoveringSinceMs: 1000, nowMs: 50000 }), false);
  assert.equal(evaluateRecoveryTimeout({ isRecovering: true, recoveringSinceMs: 1000, nowMs: 10000 }), false);
  assert.equal(
    evaluateRecoveryTimeout({ isRecovering: true, recoveringSinceMs: 1000, nowMs: 1000 + RECOVERY_STALL_TIMEOUT_MS }),
    true
  );
});
