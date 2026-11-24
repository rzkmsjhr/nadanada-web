import fs from 'node:fs';
import os from 'node:os';

/**
 * Copy a regex capture or slice >= 12 chars out of its parent backing string
 * so V8 SlicedString references do not pin multi-megabyte HTML payloads in caches.
 */
export function detachString(str) {
  if (str === null || str === undefined) return '';
  const s = typeof str === 'string' ? str : String(str);
  if (s.length < 12) return s;
  return Buffer.from(s, 'utf8').toString('utf8');
}

/**
 * FIFO concurrency limiter that caps parallel heavy upstream scrapes/parses
 * so sudden concurrent bursts cannot spike V8 heap or allocate duplicate trees.
 */
export function createConcurrencyLimiter(maxConcurrent = 6) {
  const limit = Math.max(1, Number(maxConcurrent) || 6);
  let active = 0;
  const waiting = [];

  const next = () => {
    while (active < limit && waiting.length > 0) {
      const entry = waiting.shift();
      active += 1;
      entry.run();
    }
  };

  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        const execute = async () => {
          try {
            resolve(await fn());
          } catch (err) {
            reject(err);
          } finally {
            active = Math.max(0, active - 1);
            next();
          }
        };
        if (active < limit) {
          active += 1;
          execute();
        } else {
          waiting.push({ run: execute });
        }
      });
    },
    activeCount: () => active,
    pendingCount: () => waiting.length,
  };
}

/**
 * Detect container RAM limit in MB from Linux cgroup v2/v1, falling back to host totalmem.
 */
export function detectContainerMemoryMb(fsMod = fs, osMod = os) {
  const hostMb = Math.round((Number(osMod?.totalmem?.()) || 0) / (1024 * 1024));
  const candidates = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'];

  for (const p of candidates) {
    try {
      if (!fsMod.existsSync(p)) continue;
      const raw = String(fsMod.readFileSync(p, 'utf8') || '').trim();
      if (!raw || raw === 'max') continue;
      const bytes = Number(raw);
      if (Number.isFinite(bytes) && bytes > 0 && bytes < 1e14) {
        const mb = Math.round(bytes / (1024 * 1024));
        if (mb >= 64) {
          return hostMb > 0 ? Math.min(mb, hostMb) : mb;
        }
      }
    } catch {}
  }

  return hostMb > 0 ? hostMb : 1024;
}

/**
 * Choose worker --max-old-space-size (MB) based on container RAM while leaving
 * headroom for native buffers, runner proxy, and standby workers during deploys.
 */
export function computeWorkerMaxHeapMb(containerMb, envOverride = undefined) {
  if (envOverride !== undefined && envOverride !== null && String(envOverride).trim() !== '') {
    const parsed = parseInt(String(envOverride), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(128, parsed);
    }
  }
  const mb = Number(containerMb) || 0;
  if (mb >= 1800) return 768;
  if (mb >= 1200) return 512;
  return 384;
}
