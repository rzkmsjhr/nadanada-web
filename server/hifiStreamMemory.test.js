import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

function createMockRes() {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = 200;
  res.headersSent = false;
  res.writableFinished = false;
  res.destroyed = false;
  const chunks = [];
  let doneResolve;
  res.done = new Promise((r) => {
    doneResolve = r;
  });

  res.setHeader = (k, v) => {
    res.headers[String(k).toLowerCase()] = v;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.headersSent = true;
    chunks.push(Buffer.from(JSON.stringify(obj)));
    res.end();
    return res;
  };
  res.write = (chunk) => {
    res.headersSent = true;
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  };
  res.end = (chunk) => {
    res.headersSent = true;
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    res.writableFinished = true;
    res.emit('finish');
    doneResolve(Buffer.concat(chunks));
  };
  res.destroy = () => {
    res.destroyed = true;
    doneResolve(Buffer.concat(chunks));
  };
  return res;
}

test('handleHifiStream and ensureCachedFlac stream directly to disk without chunks buffering and prune cache', async () => {
  const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysongs-hifi-mem-'));
  process.env.HIFI_CACHE_DIR = tmpCacheDir;
  process.env.MAX_HIFI_CACHE_MB = '50';

  // Total 320 KB valid fLaC payload (> MIN_VALID_FLAC_BYTES = 250_000)
  const payload = Buffer.alloc(320 * 1024, 0x41);
  Buffer.from('fLaC\x00\x00\x00\x22\x10\x00\x10\x00\x00\x00\x00\x00').copy(payload, 0);

  let server;
  try {
    server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'audio/flac',
        'Content-Length': String(payload.length),
      });
      // Send in two chunks to exercise progressive streaming before download completes
      res.write(payload.subarray(0, 128 * 1024));
      setTimeout(() => {
        res.end(payload.subarray(128 * 1024));
      }, 40);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    const directUrlsPath = path.join(tmpCacheDir, 'direct-urls.json');
    fs.writeFileSync(
      directUrlsPath,
      JSON.stringify({
        kuwo_memtest1: { url: `http://127.0.0.1:${port}/song.flac`, ts: Date.now() },
        kuwo_memtest2: { url: `http://127.0.0.1:${port}/song2.flac`, ts: Date.now() },
      })
    );

    // Seed two sparse valid-prefix .flac files totaling ~56 MB (> 50 MB cap) to verify pruning
    const oldFile = path.join(tmpCacheDir, 'kuwo_old1.flac');
    const fd = fs.openSync(oldFile, 'w');
    fs.writeSync(fd, Buffer.from('fLaC\x00\x00\x00\x22\x10\x00\x10\x00\x00\x00\x00\x00'));
    fs.ftruncateSync(fd, 56 * 1024 * 1024);
    fs.closeSync(fd);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(oldFile, past, past);

    const { handleHifiStream, ensureCachedFlac } = await import('./hifi.js?memtest=' + Date.now());

    // 1. Progressive Range request while download is actively streaming
    const req1 = Object.assign(new EventEmitter(), {
      query: { id: 'kuwo_memtest1' },
      params: {},
      headers: { range: 'bytes=0-65535' },
    });
    const res1 = createMockRes();
    await handleHifiStream(req1, res1);
    const body1 = await res1.done;
    assert.equal(res1.statusCode, 206);
    assert.equal(res1.headers['content-type'], 'audio/flac');
    assert.equal(res1.headers['content-range'], `bytes 0-65535/${payload.length}`);
    assert.equal(body1.length, 65536);
    assert.equal(body1.equals(payload.subarray(0, 65536)), true);

    // Wait for background download completion & rename
    const cachedPath1 = await ensureCachedFlac('kuwo_memtest1', true);
    assert.equal(fs.existsSync(cachedPath1), true);
    assert.equal(fs.statSync(cachedPath1).size, payload.length);

    // Old 56 MB file should have been pruned under MAX_HIFI_CACHE_MB=50
    assert.equal(fs.existsSync(oldFile), false);

    // 2. Subsequent Range request served cleanly from finalized disk file
    const req2 = Object.assign(new EventEmitter(), {
      query: { id: 'kuwo_memtest1' },
      params: {},
      headers: { range: 'bytes=65536-131071' },
    });
    const res2 = createMockRes();
    await handleHifiStream(req2, res2);
    const body2 = await res2.done;
    assert.equal(res2.statusCode, 206);
    assert.equal(body2.length, 65536);
    assert.equal(body2.equals(payload.subarray(65536, 131072)), true);

    // 3. No leftover .part files
    const remainingParts = fs.readdirSync(tmpCacheDir).filter((n) => n.endsWith('.part'));
    assert.deepEqual(remainingParts, []);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    try { fs.rmSync(tmpCacheDir, { recursive: true, force: true }); } catch {}
    delete process.env.HIFI_CACHE_DIR;
    delete process.env.MAX_HIFI_CACHE_MB;
  }
});
