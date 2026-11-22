import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseByteRangeHeader,
  computeYtAudioChunkRange,
  MAX_YT_AUDIO_CHUNK_BYTES,
  cleanVideoTitleForHifi,
  cleanVideoChannelForHifi,
  parseVideoMetadataForHifi,
} from './ytStreamUtils.js';

test('parseByteRangeHeader parses open and closed byte ranges', () => {
  assert.deepEqual(parseByteRangeHeader('bytes=0-'), { start: 0, end: null });
  assert.deepEqual(parseByteRangeHeader('bytes=1024-4095'), { start: 1024, end: 4095 });
  assert.equal(parseByteRangeHeader(''), null);
  assert.equal(parseByteRangeHeader('bytes=500-100'), null);
});

test('computeYtAudioChunkRange bounds open and tail requests below total size and 1 MiB', () => {
  const open = computeYtAudioChunkRange({ start: 0, end: null }, 4293443);
  assert.equal(open.unsatisfiable, false);
  assert.equal(open.header, `bytes=0-${MAX_YT_AUDIO_CHUNK_BYTES - 1}`);

  const tail = computeYtAudioChunkRange({ start: 4000000, end: null }, 4293443);
  assert.equal(tail.unsatisfiable, false);
  assert.equal(tail.header, 'bytes=4000000-4293442');

  const closedSmall = computeYtAudioChunkRange({ start: 0, end: 511 }, 4293443);
  assert.equal(closedSmall.header, 'bytes=0-511');

  const pastEnd = computeYtAudioChunkRange({ start: 4293443, end: null }, 4293443);
  assert.equal(pastEnd.unsatisfiable, true);
});

test('cleanVideoTitleForHifi and parseVideoMetadataForHifi normalize official music videos for Hi-Fi matching', () => {
  assert.equal(cleanVideoTitleForHifi('Blow Me (Official Video)'), 'Blow Me');
  assert.equal(cleanVideoTitleForHifi('The Great Escape (Official Lyric Video)'), 'The Great Escape');
  assert.equal(cleanVideoTitleForHifi('Linger (4K Official Music Video)'), 'Linger');
  assert.equal(cleanVideoChannelForHifi('PinkVEVO'), 'Pink');
  assert.equal(cleanVideoChannelForHifi('P!NK - Topic'), 'P!NK');

  assert.deepEqual(
    parseVideoMetadataForHifi('P!NK - Blow Me (Official Video)', 'PinkVEVO'),
    { title: 'Blow Me', channel: 'P!NK' }
  );
  assert.deepEqual(
    parseVideoMetadataForHifi('Try (Official Video)', 'P!nk'),
    { title: 'Try', channel: 'P!nk' }
  );
  assert.deepEqual(
    parseVideoMetadataForHifi('The Cranberries - Linger (4K Official Music Video)', 'TheCranberriesVEVO'),
    { title: 'Linger', channel: 'The Cranberries' }
  );
});
