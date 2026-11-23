import test from 'node:test';
import assert from 'node:assert/strict';
import {
    cleanLrclibTitle,
    cleanLrclibArtist,
    fetchClientLrclib,
} from '../src/utils/clientLyrics.js';

test('cleanLrclibTitle and cleanLrclibArtist strip video suffixes and extra credits', () => {
    assert.equal(cleanLrclibTitle('Try (Official Video) [HD] (feat. Someone) - Lyrics'), 'Try');
    assert.equal(cleanLrclibArtist('P!nk - Topic'), 'P!nk');
    assert.equal(cleanLrclibArtist('P!nk feat. Nate Ruess'), 'P!nk');
});

test('fetchClientLrclib hits /api/get first without custom CORS headers', async () => {
    const seenRequests = [];
    const mockFetch = async (url, opts) => {
        seenRequests.push({ url, opts });
        return new Response(JSON.stringify({
            syncedLyrics: '[00:01.00] Line one',
            plainLyrics: 'Line one',
            instrumental: false,
        }), { status: 200 });
    };

    const result = await fetchClientLrclib('Try (Official Audio)', 'P!nk - Topic', 247, mockFetch);
    assert.equal(result?.success, true);
    assert.equal(result?.source, 'LRCLIB (Direct)');
    assert.equal(result?.synced_lyrics, '[00:01.00] Line one');
    assert.equal(seenRequests.length, 1);
    assert.match(seenRequests[0].url, /^https:\/\/lrclib\.net\/api\/get\?/);
    assert.equal(seenRequests[0].opts.headers, undefined);
    assert.ok(seenRequests[0].opts.signal);
});

test('fetchClientLrclib falls back to duration-filtered /api/search when /api/get lacks syncedLyrics', async () => {
    const seenUrls = [];
    const mockFetch = async (url) => {
        seenUrls.push(url);
        if (url.includes('/api/get')) {
            return new Response(JSON.stringify({ plainLyrics: 'unsynced only' }), { status: 200 });
        }
        return new Response(JSON.stringify([
            {
                id: 1,
                duration: 500, // outside +-15s tolerance for 200s track
                syncedLyrics: '[00:05.00] Wrong duration',
                plainLyrics: 'Wrong duration',
            },
            {
                id: 2,
                duration: 203,
                syncedLyrics: '[00:02.00] Matched line',
                plainLyrics: 'Matched line',
                instrumental: false,
            },
        ]), { status: 200 });
    };

    const result = await fetchClientLrclib('Song Name', 'Artist', 200, mockFetch);
    assert.equal(seenUrls.length, 2);
    assert.match(seenUrls[0], /\/api\/get\?/);
    assert.match(seenUrls[1], /\/api\/search\?/);
    assert.equal(result?.synced_lyrics, '[00:02.00] Matched line');
    assert.equal(result?.source, 'LRCLIB (Direct)');
});

test('fetchClientLrclib returns null on HTTP 404 or network error', async () => {
    const notFoundFetch = async () => new Response('not found', { status: 404 });
    assert.equal(await fetchClientLrclib('Missing', 'Unknown', 180, notFoundFetch), null);

    const throwingFetch = async () => {
        throw new Error('network failed');
    };
    assert.equal(await fetchClientLrclib('Error', 'Track', 180, throwingFetch), null);
});
