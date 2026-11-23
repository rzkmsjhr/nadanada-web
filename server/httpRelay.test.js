import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RELAY_ALLOWED_HOSTS, getRelayUrls, fetchWithTimeout } from './http.js';

function snapshotRelayEnv() {
    return {
        UPSTREAM_RELAY_URLS: process.env.UPSTREAM_RELAY_URLS,
        UPSTREAM_RELAY_SECRET: process.env.UPSTREAM_RELAY_SECRET,
    };
}

function restoreRelayEnv(saved) {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
}

test('getRelayUrls parses and normalizes comma-separated worker URLs', () => {
    const saved = snapshotRelayEnv();
    try {
        delete process.env.UPSTREAM_RELAY_URLS;
        assert.deepEqual(getRelayUrls(), []);

        process.env.UPSTREAM_RELAY_URLS = ' https://r1.workers.dev/ , https://r2.workers.dev/// ,, ';
        assert.deepEqual(getRelayUrls(), ['https://r1.workers.dev', 'https://r2.workers.dev']);
    } finally {
        restoreRelayEnv(saved);
    }
});

test('fetchWithTimeout bypasses relay for non-allowlisted local hosts', async () => {
    const saved = snapshotRelayEnv();
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ direct: true, path: req.url }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        process.env.UPSTREAM_RELAY_URLS = 'https://unreachable-relay.invalid';
        assert.equal(RELAY_ALLOWED_HOSTS.has('127.0.0.1'), false);

        const res = await fetchWithTimeout(`http://127.0.0.1:${port}/local-check`, {}, 3000);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body, { direct: true, path: '/local-check' });
    } finally {
        await new Promise((resolve) => server.close(resolve));
        restoreRelayEnv(saved);
    }
});

test('fetchWithTimeout round-robins allowlisted hosts across relays and falls back to direct on 429 or error', async () => {
    const saved = snapshotRelayEnv();
    const originalFetch = globalThis.fetch;
    const calls = [];

    try {
        process.env.UPSTREAM_RELAY_URLS = 'https://relay-a.workers.dev/, https://relay-b.workers.dev';
        process.env.UPSTREAM_RELAY_SECRET = 'top-secret-key';

        globalThis.fetch = async (url, opts = {}) => {
            calls.push({ url: String(url), opts });
            const u = String(url);
            if (u.startsWith('https://relay-a.workers.dev/relay')) {
                return new Response(JSON.stringify({ via: 'relay-a' }), { status: 200 });
            }
            if (u.startsWith('https://relay-b.workers.dev/relay')) {
                // Simulate relay throttling to verify automatic fallback to direct fetch
                return new Response('rate limited', { status: 429 });
            }
            if (u === 'https://tracks.monochrome.st/track/2') {
                return new Response(JSON.stringify({ via: 'direct-fallback' }), { status: 200 });
            }
            if (u === 'https://tracks.monochrome.st/track/3') {
                return new Response(JSON.stringify({ via: 'direct-after-throw' }), { status: 200 });
            }
            return new Response('not found', { status: 404 });
        };

        // Call 1 -> hits relay-a
        const res1 = await fetchWithTimeout('https://tracks.monochrome.st/track/1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"x":1}',
        }, 3000);
        assert.equal(res1.status, 200);
        assert.deepEqual(await res1.json(), { via: 'relay-a' });
        assert.equal(calls[0].url, 'https://relay-a.workers.dev/relay');
        assert.equal(calls[0].opts.method, 'POST');
        assert.equal(calls[0].opts.headers['X-Target-Url'], 'https://tracks.monochrome.st/track/1');
        assert.equal(calls[0].opts.headers['X-Target-Method'], 'POST');
        assert.equal(calls[0].opts.headers['X-Relay-Secret'], 'top-secret-key');

        // Call 2 -> hits relay-b (429), automatically falls back to direct URL
        const res2 = await fetchWithTimeout('https://tracks.monochrome.st/track/2', {}, 3000);
        assert.equal(res2.status, 200);
        assert.deepEqual(await res2.json(), { via: 'direct-fallback' });
        assert.equal(calls[1].url, 'https://relay-b.workers.dev/relay');
        assert.equal(calls[2].url, 'https://tracks.monochrome.st/track/2');

        // Call 3 -> relay throws network error, falls back to direct URL
        globalThis.fetch = async (url, opts = {}) => {
            calls.push({ url: String(url), opts });
            if (String(url).includes('/relay')) {
                throw new Error('relay network down');
            }
            return new Response(JSON.stringify({ via: 'direct-after-throw' }), { status: 200 });
        };

        const res3 = await fetchWithTimeout('https://tracks.monochrome.st/track/3', {}, 3000);
        assert.equal(res3.status, 200);
        assert.deepEqual(await res3.json(), { via: 'direct-after-throw' });
    } finally {
        globalThis.fetch = originalFetch;
        restoreRelayEnv(saved);
    }
});
