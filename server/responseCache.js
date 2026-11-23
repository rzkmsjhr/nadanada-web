/**
 * Bounded LRU response cache with TTL and in-flight request deduplication.
 * Cuts duplicate upstream metadata requests under high concurrent traffic.
 */
export function createResponseCache({ maxEntries = 500, defaultTtlMs = 600_000 } = {}) {
  const cache = new Map();
  const inFlight = new Map();

  function setEntry(key, value, ttlMs) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, { value, ts: Date.now(), ttlMs });
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  }

  function get(key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts >= entry.ttlMs) {
      cache.delete(key);
      return undefined;
    }
    // Refresh LRU order
    cache.delete(key);
    cache.set(key, entry);
    return entry.value;
  }

  async function getOrFetch(key, fetcher, { ttlMs = defaultTtlMs, shouldCache = (v) => v != null } = {}) {
    const hit = get(key);
    if (hit !== undefined) return hit;

    if (inFlight.has(key)) {
      return inFlight.get(key);
    }

    const job = (async () => {
      const value = await fetcher();
      if (shouldCache(value)) {
        setEntry(key, value, ttlMs);
      }
      return value;
    })();

    inFlight.set(key, job);
    try {
      return await job;
    } finally {
      if (inFlight.get(key) === job) {
        inFlight.delete(key);
      }
    }
  }

  function clear() {
    cache.clear();
    inFlight.clear();
  }

  return {
    get,
    getOrFetch,
    clear,
    size: () => cache.size,
  };
}
