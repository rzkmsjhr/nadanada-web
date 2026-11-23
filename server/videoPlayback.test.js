import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractVideoId,
  isTabHidden,
  buildVideoAudioStreamUrl,
  createBackgroundVideoTrack,
  createHiddenSongAudioTrack,
  shouldUseBackgroundVideoAudio,
  shouldUseHiddenSongAudioFallback,
} from '../src/utils/videoPlayback.js';

test('extractVideoId validates 11-char YouTube IDs across id and youtube_id fields', () => {
  assert.equal(extractVideoId({ id: 'dQw4w9WgXcQ' }), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId({ id: 'custom_uid', youtube_id: 'fJ9rUzIMcZQ' }), 'fJ9rUzIMcZQ');
  assert.equal(extractVideoId({ id: 'bad-id' }), null);
  assert.equal(extractVideoId(null), null);
});

test('isTabHidden and shouldUseBackgroundVideoAudio detect inactive-tab video transitions', () => {
  assert.equal(isTabHidden({ visibilityState: 'hidden', hasFocus: () => true }), true);
  assert.equal(isTabHidden({ visibilityState: 'visible', hasFocus: () => false }), true);
  assert.equal(isTabHidden({ visibilityState: 'visible', hasFocus: () => true }), false);
  assert.equal(isTabHidden(null), false);

  assert.equal(shouldUseBackgroundVideoAudio({ isVideo: true, isHidden: true }), true);
  assert.equal(shouldUseBackgroundVideoAudio({ isVideo: true, isHidden: false }), false);
  assert.equal(shouldUseBackgroundVideoAudio({ isVideo: false, isHidden: true }), false);
});

test('createBackgroundVideoTrack builds same-origin audio-stream fallback track preserving seek position', () => {
  const track = {
    id: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up (Official Video)',
    item_type: 'video',
    uid: 'v1',
  };
  const bg = createBackgroundVideoTrack(track, 42.8, 123456);
  assert.equal(bg._fallbackAudioUrl, '/api/audio-stream?videoId=dQw4w9WgXcQ');
  assert.equal(bg._isBackgroundVideoAudio, true);
  assert.equal(bg._seekOnLoad, 42);
  assert.equal(bg._recoveryNonce, 123456);
  assert.equal(buildVideoAudioStreamUrl({ id: 'invalid' }), null);
});

test('createHiddenSongAudioTrack and shouldUseHiddenSongAudioFallback handle non-FLAC songs in hidden tabs', () => {
  const track = {
    id: 'fJ9rUzIMcZQ',
    title: 'Bohemian Rhapsody',
    item_type: 'song',
    stream_url: null,
  };

  assert.equal(
    buildVideoAudioStreamUrl(track, { skipHifi: true }),
    '/api/audio-stream?videoId=fJ9rUzIMcZQ&skipHifi=1'
  );

  const hiddenFb = createHiddenSongAudioTrack(track, 19.7, 98765);
  assert.equal(hiddenFb.stream_url, null);
  assert.equal(hiddenFb._fallbackAudioUrl, '/api/audio-stream?videoId=fJ9rUzIMcZQ&skipHifi=1');
  assert.equal(hiddenFb._isHiddenYtFallback, true);
  assert.equal(hiddenFb._isBackgroundVideoAudio, false);
  assert.equal(hiddenFb._seekOnLoad, 19);
  assert.equal(hiddenFb._recoveryNonce, 98765);
  assert.equal(createHiddenSongAudioTrack({ id: 'bad' }), null);

  assert.equal(shouldUseHiddenSongAudioFallback(track, { isHidden: true, isAudioMode: false }), true);
  assert.equal(shouldUseHiddenSongAudioFallback(track, { isHidden: false, isAudioMode: false }), false);
  assert.equal(shouldUseHiddenSongAudioFallback(track, { isHidden: true, isAudioMode: true }), false);
  assert.equal(
    shouldUseHiddenSongAudioFallback({ ...track, _bgAudioFailed: true }, { isHidden: true, isAudioMode: false }),
    false
  );
  assert.equal(
    shouldUseHiddenSongAudioFallback({ id: 'custom_non_yt' }, { isHidden: true, isAudioMode: false }),
    false
  );
});
