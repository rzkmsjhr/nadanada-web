import test from 'node:test';
import assert from 'node:assert/strict';
import { createResponseCache } from './responseCache.js';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('responseCache returns cached values until TTL expires', async () => {
    const cache = createResponseCache({ maxEntries: 10, defaultTtlMs: 40 });
    let fetchCount = 0;

    const first = await cache.getOrFetch('k1', async () => {
        fetchCount += 1;
        return { value: 'hello', count: fetchCount };
    });
    assert.deepEqual(first, { value: 'hello', count: 1 });
    assert.equal(cache.size(), 1);

    const second = await cache.getOrFetch('k1', async () => {
        fetchCount += 1;
        return { value: 'hello', count: fetchCount };
    });
    assert.deepEqual(second, { value: 'hello', count: 1 });
    assert.equal(fetchCount, 1);

    await delay(60);
    assert.equal(cache.get('k1'), undefined);

    const third = await cache.getOrFetch('k1', async () => {
        fetchCount += 1;
        return { value: 'refreshed', count: fetchCount };
    });
    assert.deepEqual(third, { value: 'refreshed', count: 2 });
    assert.equal(fetchCount, 2);
});

test('responseCache evicts least recently used entry when maxEntries exceeded', async () => {
    const cache = createResponseCache({ maxEntries: 2, defaultTtlMs: 5000 });

    await cache.getOrFetch('a', async () => 1);
    await cache.getOrFetch('b', async () => 2);
    // Touch 'a' so 'b' becomes LRU
    assert.equal(cache.get('a'), 1);

    await cache.getOrFetch('c', async () => 3);
    assert.equal(cache.size(), 2);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('c'), 3);
});

test('responseCache deduplicates concurrent in-flight fetches', async () => {
    const cache = createResponseCache({ maxEntries: 10, defaultTtlMs: 5000 });
    let calls = 0;

    const results = await Promise.all([
        cache.getOrFetch('same', async () => {
            calls += 1;
            await delay(25);
            return { ok: true, calls };
        }),
        cache.getOrFetch('same', async () => {
            calls += 1;
            return { ok: false };
        }),
        cache.getOrFetch('same', async () => {
            calls += 1;
            return { ok: false };
        }),
    ]);

    assert.equal(calls, 1);
    assert.deepEqual(results, [
        { ok: true, calls: 1 },
        { ok: true, calls: 1 },
        { ok: true, calls: 1 },
    ]);
});

test('responseCache skips storing when shouldCache returns false', async () => {
    const cache = createResponseCache({ maxEntries: 10, defaultTtlMs: 5000 });
    let calls = 0;

    const first = await cache.getOrFetch(
        'empty',
        async () => {
            calls += 1;
            return [];
        },
        { shouldCache: (val) => Array.isArray(val) && val.length > 0 }
    );
    assert.deepEqual(first, []);
    assert.equal(cache.size(), 0);

    const second = await cache.getOrFetch(
        'empty',
        async () => {
            calls += 1;
            return ['item'];
        },
        { shouldCache: (val) => Array.isArray(val) && val.length > 0 }
    );
    assert.deepEqual(second, ['item']);
    assert.equal(calls, 2);
    assert.equal(cache.size(), 1);
});
