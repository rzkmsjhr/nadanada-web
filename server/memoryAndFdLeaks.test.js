import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  detachString,
  createConcurrencyLimiter,
  detectContainerMemoryMb,
  computeWorkerMaxHeapMb,
} from './runtimeLimits.js';

function createAbortableMockRes({ closeAfterWrites = 0 } = {}) {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = 200;
  res.headersSent = false;
  res.writableFinished = false;
  res.destroyed = false;
  let writeCount = 0;

  res.setHeader = (k, v) => {
    res.headers[String(k).toLowerCase()] = v;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.headersSent = true;
    res.end(Buffer.from(JSON.stringify(obj)));
    return res;
  };
  res.write = () => {
    res.headersSent = true;
    writeCount += 1;
    if (closeAfterWrites > 0 && writeCount >= closeAfterWrites && !res.destroyed) {
      res.destroyed = true;
      res.emit('close');
      return false;
    }
    return true;
  };
  res.end = () => {
    res.headersSent = true;
    res.writableFinished = true;
    res.emit('finish');
  };
  res.destroy = () => {
    if (!res.destroyed) {
      res.destroyed = true;
      res.emit('close');
    }
  };
  return res;
}

test('detachString preserves ASCII/Unicode values while returning independent string instances', () => {
  assert.equal(detachString(null), '');
  assert.equal(detachString(undefined), '');
  assert.equal(detachString('short'), 'short');

  const samples = [
    'OLAK5uy_ldg_UUKSKemf6g6lkAFu2ZLVFd5_u-N_Q',
    'LOVE YOURSELF 轉 Tear',
    '綠鋼琴 李察篇 第五輯 — 정국 (Jung Kook) 🎵',
  ];

  for (const s of samples) {
    const bigParent = `${'x'.repeat(50_000)}|${s}|${'y'.repeat(50_000)}`;
    const m = bigParent.match(/\|([^|]+)\|/);
    assert.ok(m?.[1]);
    const detached = detachString(m[1]);
    assert.equal(detached, s);
  }
});

test('createConcurrencyLimiter strictly bounds active concurrency across rejections and queued jobs', async () => {
  const limiter = createConcurrencyLimiter(3);
  let active = 0;
  let peak = 0;
  const completed = [];

  const tasks = Array.from({ length: 12 }, (_, idx) =>
    limiter.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      if (idx % 4 === 2) {
        throw new Error(`boom-${idx}`);
      }
      completed.push(idx);
      return idx;
    })
  );

  const settled = await Promise.allSettled(tasks);
  assert.ok(peak <= 3 && peak >= 2, `Expected peak in [2, 3], got ${peak}`);
  assert.equal(limiter.activeCount(), 0);
  assert.equal(limiter.pendingCount(), 0);
  assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 9);
  assert.equal(settled.filter((r) => r.status === 'rejected').length, 3);
  assert.equal(completed.length, 9);
});

test('computeWorkerMaxHeapMb and detectContainerMemoryMb scale safely for 1GB-2GB containers', () => {
  assert.equal(computeWorkerMaxHeapMb(1024), 384);
  assert.equal(computeWorkerMaxHeapMb(1536), 512);
  assert.equal(computeWorkerMaxHeapMb(2048), 768);
  assert.equal(computeWorkerMaxHeapMb(2048, '640'), 640);
  assert.equal(computeWorkerMaxHeapMb(2048, '64'), 128);
  assert.equal(computeWorkerMaxHeapMb(2048, ''), 768);

  const cgroupV2Fs = {
    existsSync: (p) => p === '/sys/fs/cgroup/memory.max',
    readFileSync: () => String(2048 * 1024 * 1024),
  };
  assert.equal(detectContainerMemoryMb(cgroupV2Fs, { totalmem: () => 8192 * 1024 * 1024 }), 2048);

  const cgroupMaxFallbackFs = {
    existsSync: (p) => p === '/sys/fs/cgroup/memory.max',
    readFileSync: () => 'max',
  };
  assert.equal(detectContainerMemoryMb(cgroupMaxFallbackFs, { totalmem: () => 2048 * 1024 * 1024 }), 2048);

  const cgroupV1Fs = {
    existsSync: (p) => p === '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    readFileSync: () => String(1024 * 1024 * 1024),
  };
  assert.equal(detectContainerMemoryMb(cgroupV1Fs, { totalmem: () => 4096 * 1024 * 1024 }), 1024);
});

test('mid-stream client aborts on handleHifiStream and serveFileWithRange emit zero DEP0137 FD leak warnings', async () => {
  const warnings = [];
  const onWarning = (w) => {
    const msg = `${w?.code || ''} ${w?.message || w}`;
    if (/DEP0137|file descriptor/i.test(msg)) warnings.push(msg);
  };
  process.on('warning', onWarning);

  const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysongs-fdleak-'));
  process.env.HIFI_CACHE_DIR = tmpCacheDir;
  process.env.MAX_HIFI_CACHE_MB = '50';

  // 1 MB valid FLAC payload so progressive coordinator stays mid-stream across abort cycles
  const payload = Buffer.alloc(1024 * 1024, 0x42);
  Buffer.from('fLaC\x00\x00\x00\x22\x10\x00\x10\x00\x00\x00\x00\x00').copy(payload, 0);

  let server;
  try {
    server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'audio/flac',
        'Content-Length': String(payload.length),
      });
      res.write(payload.subarray(0, 256 * 1024));
      let offset = 256 * 1024;
      const timer = setInterval(() => {
        if (offset >= payload.length || res.destroyed) {
          clearInterval(timer);
          if (!res.writableEnded && !res.destroyed) res.end();
          return;
        }
        const next = Math.min(offset + 128 * 1024, payload.length);
        res.write(payload.subarray(offset, next));
        offset = next;
      }, 25);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    fs.writeFileSync(
      path.join(tmpCacheDir, 'direct-urls.json'),
      JSON.stringify({
        kuwo_aborttest1: { url: `http://127.0.0.1:${port}/abort.flac`, ts: Date.now() },
      })
    );

    const { handleHifiStream, ensureCachedFlac, serveFileWithRange } = await import(
      './hifi.js?fdleak=' + Date.now()
    );

    // Trigger 4 progressive reads and immediately abort each client mid-stream
    for (let i = 0; i < 4; i++) {
      const req = Object.assign(new EventEmitter(), {
        query: { id: 'kuwo_aborttest1' },
        params: {},
        headers: { range: 'bytes=0-524287' },
      });
      const res = createAbortableMockRes({ closeAfterWrites: 1 });
      await handleHifiStream(req, res);
      await new Promise((r) => setTimeout(r, 30));
    }

    const cachedFile = await ensureCachedFlac('kuwo_aborttest1', true);
    assert.equal(fs.existsSync(cachedFile), true);

    // Also test serveFileWithRange aborting immediately after first chunk
    for (let i = 0; i < 4; i++) {
      const req = Object.assign(new EventEmitter(), { headers: { range: 'bytes=0-' } });
      const res = createAbortableMockRes({ closeAfterWrites: 1 });
      serveFileWithRange(req, res, cachedFile, 'audio/flac');
      await new Promise((r) => setTimeout(r, 25));
    }

    await new Promise((r) => setTimeout(r, 150));
    if (typeof global.gc === 'function') global.gc();
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(warnings, [], `Unexpected FD GC warnings: ${warnings.join('; ')}`);
  } finally {
    process.off('warning', onWarning);
    if (server) await new Promise((r) => server.close(r));
    try { fs.rmSync(tmpCacheDir, { recursive: true, force: true }); } catch {}
    delete process.env.HIFI_CACHE_DIR;
    delete process.env.MAX_HIFI_CACHE_MB;
  }
});
