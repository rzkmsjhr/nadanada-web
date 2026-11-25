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

    // 4. Upstream drops TCP mid-stream at 128 KB -> server automatically issues Range resume and completes 320 KB FLAC
    let rangeHeaderSeen = null;
    const dropServer = http.createServer((req, res) => {
      if (req.headers.range) {
        rangeHeaderSeen = req.headers.range;
        const start = 128 * 1024;
        const slice = payload.subarray(start);
        res.writeHead(206, {
          'Content-Type': 'audio/flac',
          'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
          'Content-Length': String(slice.length),
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'audio/flac',
        'Content-Length': String(payload.length),
      });
      res.write(payload.subarray(0, 128 * 1024));
      setTimeout(() => {
        res.socket?.destroy();
      }, 25);
    });
    await new Promise((r) => dropServer.listen(0, '127.0.0.1', r));
    try {
      const { port: dropPort } = dropServer.address();
      fs.writeFileSync(
        directUrlsPath,
        JSON.stringify({
          kuwo_drop_resume: { url: `http://127.0.0.1:${dropPort}/drop.flac`, ts: Date.now() },
        })
      );
      const resumedPath = await ensureCachedFlac('kuwo_drop_resume', true);
      assert.equal(rangeHeaderSeen, `bytes=${128 * 1024}-`);
      assert.equal(fs.statSync(resumedPath).size, payload.length);
      assert.equal(fs.readFileSync(resumedPath).equals(payload), true);
    } finally {
      await new Promise((r) => dropServer.close(r));
    }

    // 5. Upstream refuses Range resume (returns 200 instead of 206 after early cut) -> incomplete file rejected, not finalized
    const truncServer = http.createServer((req, res) => {
      if (req.headers.range) {
        res.writeHead(200, {
          'Content-Type': 'audio/flac',
          'Content-Length': String(payload.length),
        });
        res.end(payload);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'audio/flac',
        'Content-Length': String(payload.length),
      });
      res.write(payload.subarray(0, 128 * 1024));
      setTimeout(() => {
        res.socket?.destroy();
      }, 25);
    });
    await new Promise((r) => truncServer.listen(0, '127.0.0.1', r));
    try {
      const { port: truncPort } = truncServer.address();
      fs.writeFileSync(
        directUrlsPath,
        JSON.stringify({
          kuwo_trunc_fail: { url: `http://127.0.0.1:${truncPort}/trunc.flac`, ts: Date.now() },
        })
      );
      await assert.rejects(() => ensureCachedFlac('kuwo_trunc_fail', true), /Incomplete FLAC download/i);
      assert.equal(fs.existsSync(path.join(tmpCacheDir, 'kuwo_trunc_fail.flac')), false);
    } finally {
      await new Promise((r) => truncServer.close(r));
    }

    // 6. Stalled upstream exceeding HIFI_CHUNK_IDLE_TIMEOUT_MS fails fast rather than hanging 120s
    process.env.HIFI_CHUNK_IDLE_TIMEOUT_MS = '250';
    process.env.HIFI_COORDINATOR_STALL_MS = '500';
    const stallServer = http.createServer((req, res) => {
      if (req.headers.range) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'audio/flac',
        'Content-Length': String(payload.length),
      });
      res.write(payload.subarray(0, 64 * 1024));
      // Intentionally keep socket open without sending remaining bytes
    });
    await new Promise((r) => stallServer.listen(0, '127.0.0.1', r));
    try {
      const { port: stallPort } = stallServer.address();
      fs.writeFileSync(
        directUrlsPath,
        JSON.stringify({
          kuwo_stall_fast: { url: `http://127.0.0.1:${stallPort}/stall.flac`, ts: Date.now() },
        })
      );
      const { ensureCachedFlac: ensureFastFail } = await import('./hifi.js?stalltest=' + Date.now());
      const started = Date.now();
      await assert.rejects(() => ensureFastFail('kuwo_stall_fast', true));
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 5000, `expected fast stall failure (<5000ms), got ${elapsed}ms`);
    } finally {
      stallServer.closeAllConnections?.();
      await new Promise((r) => stallServer.close(r));
      delete process.env.HIFI_CHUNK_IDLE_TIMEOUT_MS;
      delete process.env.HIFI_COORDINATOR_STALL_MS;
    }
  } finally {
    if (server) await new Promise((r) => server.close(r));
    try { fs.rmSync(tmpCacheDir, { recursive: true, force: true }); } catch {}
    delete process.env.HIFI_CACHE_DIR;
    delete process.env.MAX_HIFI_CACHE_MB;
  }
});
