import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_STATUS,
  getConnectionLabel,
  probeServerHealth,
} from '../src/utils/connectionStatus.js';

test('getConnectionLabel returns exact labels for connected, reconnecting, and connection lost', () => {
  assert.equal(getConnectionLabel(CONNECTION_STATUS.CONNECTED), 'Connected');
  assert.equal(getConnectionLabel(CONNECTION_STATUS.RECONNECTING), 'Reconnecting');
  assert.equal(getConnectionLabel(CONNECTION_STATUS.OFFLINE), 'Connection lost');
  assert.equal(getConnectionLabel('unknown'), 'Connected');
});

test('probeServerHealth handles 200 OK, 503 error, network failure, and timeout', async () => {
  let seenInit = null;
  const ok = await probeServerHealth(async (url, init) => {
    seenInit = { url, init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  assert.equal(ok, true);
  assert.equal(seenInit.url, '/api/health');
  assert.equal(seenInit.init.cache, 'no-store');

  const unhealthy = await probeServerHealth(async () => new Response('fail', { status: 503 }));
  assert.equal(unhealthy, false);

  const failed = await probeServerHealth(async () => {
    throw new Error('network error');
  });
  assert.equal(failed, false);

  const timedOut = await probeServerHealth(
    (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Aborted')));
      }),
    200
  );
  assert.equal(timedOut, false);
});
