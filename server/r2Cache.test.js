import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    getR2Config,
    isR2Enabled,
    getR2ObjectKey,
    getR2PublicUrl,
    signR2Request,
    hasKnownR2Track,
    checkR2ObjectExists,
    pruneR2BucketIfNeeded,
    uploadFileToR2,
    enqueueR2Upload,
    setR2BackgroundDeferCheck,
    isFileProtectedByR2,
    resetR2CacheStateForTest,
} from './r2Cache.js';

const R2_ENV_KEYS = [
    'R2_ENDPOINT',
    'R2_BUCKET',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_PUBLIC_URL',
    'R2_MAX_CACHE_MB',
];

function snapshotEnv() {
    const saved = {};
    for (const key of R2_ENV_KEYS) {
        saved[key] = process.env[key];
    }
    return saved;
}

function restoreEnv(saved) {
    for (const key of R2_ENV_KEYS) {
        if (saved[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = saved[key];
        }
    }
}

test('signR2Request generates AWS4-HMAC-SHA256 headers and canonical signature', () => {
    const signed = signR2Request({
        method: 'PUT',
        url: 'https://example.r2.cloudflarestorage.com/my-bucket/hifi/track1.flac',
        headers: { 'content-type': 'audio/flac' },
        payloadHash: 'UNSIGNED-PAYLOAD',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
        now: new Date('2026-01-02T03:04:05.000Z'),
    });

    assert.match(signed.Authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key\/20260102\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(signed['x-amz-date'], '20260102T030405Z');
    assert.equal(signed['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
});

test('r2Cache uploads, checks HEAD, signs requests, and prunes oldest objects above quota', async () => {
    const savedEnv = snapshotEnv();
    resetR2CacheStateForTest();

    const requests = [];
    const deletedKeys = [];
    const uploadedObjects = new Map([
        ['hifi/old1.flac', { size: 40 * 1024 * 1024, lastModified: '2026-01-01T00:00:00.000Z' }],
        ['hifi/old2.flac', { size: 25 * 1024 * 1024, lastModified: '2026-01-02T00:00:00.000Z' }],
    ]);

    const server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url, 'http://127.0.0.1');
        requests.push({
            method: req.method,
            path: reqUrl.pathname,
            search: reqUrl.search,
            auth: req.headers.authorization || '',
            amzDate: req.headers['x-amz-date'] || '',
            amzSha: req.headers['x-amz-content-sha256'] || '',
        });

        if (req.method === 'GET' && reqUrl.searchParams.get('list-type') === '2') {
            const contents = [...uploadedObjects.entries()].map(([key, meta]) => `
                <Contents>
                    <Key>${key}</Key>
                    <LastModified>${meta.lastModified}</LastModified>
                    <Size>${meta.size}</Size>
                </Contents>
            `).join('');
            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <IsTruncated>false</IsTruncated>${contents}
</ListBucketResult>`;
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            res.end(xml);
            return;
        }

        const keyPrefix = '/test-bucket/';
        const key = reqUrl.pathname.startsWith(keyPrefix)
            ? decodeURIComponent(reqUrl.pathname.slice(keyPrefix.length))
            : '';

        if (req.method === 'PUT' && key) {
            const chunks = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', () => {
                uploadedObjects.set(key, {
                    size: Buffer.concat(chunks).length,
                    lastModified: '2026-01-03T00:00:00.000Z',
                });
                res.writeHead(200);
                res.end();
            });
            return;
        }

        if (req.method === 'HEAD' && key) {
            if (uploadedObjects.has(key)) {
                res.writeHead(200, { 'Content-Length': String(uploadedObjects.get(key).size) });
            } else {
                res.writeHead(404);
            }
            res.end();
            return;
        }

        if (req.method === 'DELETE' && key) {
            deletedKeys.push(key);
            uploadedObjects.delete(key);
            res.writeHead(204);
            res.end();
            return;
        }

        res.writeHead(400);
        res.end('Unhandled');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const tmpFile = path.join(os.tmpdir(), `r2-cache-test-${Date.now()}.flac`);
    fs.writeFileSync(tmpFile, Buffer.from('fLaC' + 'x'.repeat(256)));

    try {
        process.env.R2_ENDPOINT = `http://127.0.0.1:${port}`;
        process.env.R2_BUCKET = 'test-bucket';
        process.env.R2_ACCESS_KEY_ID = 'ak-test';
        process.env.R2_SECRET_ACCESS_KEY = 'sk-test';
        process.env.R2_PUBLIC_URL = 'https://cdn.example.com';
        process.env.R2_MAX_CACHE_MB = '1';

        assert.equal(isR2Enabled(), true);
        assert.equal(getR2Config().maxBytes, 50 * 1024 * 1024);
        assert.equal(getR2ObjectKey('track:123'), 'hifi/track123.flac');
        assert.equal(getR2PublicUrl('track:123'), 'https://cdn.example.com/hifi/track123.flac');

        const missingBefore = await checkR2ObjectExists('track:123');
        assert.equal(missingBefore, false);
        assert.equal(hasKnownR2Track('track:123'), false);

        const ok = await uploadFileToR2('track:123', tmpFile, { forcePrune: false });
        assert.equal(ok, true);
        assert.equal(hasKnownR2Track('track:123'), true);

        const existsAfter = await checkR2ObjectExists('track:123');
        assert.equal(existsAfter, true);

        await pruneR2BucketIfNeeded({ force: true, protectedKey: 'hifi/track123.flac' });

        const putReq = requests.find((r) => r.method === 'PUT');
        assert.ok(putReq);
        assert.match(putReq.auth, /^AWS4-HMAC-SHA256 Credential=ak-test\//);
        assert.equal(putReq.amzSha, 'UNSIGNED-PAYLOAD');
        assert.match(putReq.amzDate, /^\d{8}T\d{6}Z$/);

        assert.deepEqual(deletedKeys, ['hifi/old1.flac']);
        assert.equal(uploadedObjects.has('hifi/old1.flac'), false);
        assert.equal(uploadedObjects.has('hifi/old2.flac'), true);
        assert.equal(uploadedObjects.has('hifi/track123.flac'), true);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        if (fs.existsSync(tmpFile)) {
            fs.unlinkSync(tmpFile);
        }
        resetR2CacheStateForTest();
        restoreEnv(savedEnv);
    }
});

test('r2Cache enqueueR2Upload serializes uploads, respects defer check, protects files, and coalesces HEAD checks', async () => {
    const savedEnv = snapshotEnv();
    resetR2CacheStateForTest();

    let activePuts = 0;
    let maxConcurrentPuts = 0;
    let putCount = 0;
    let headCountForMissing = 0;
    const uploadedOrder = [];

    const server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url, 'http://127.0.0.1');
        const keyPrefix = '/test-bucket/';
        const key = reqUrl.pathname.startsWith(keyPrefix)
            ? decodeURIComponent(reqUrl.pathname.slice(keyPrefix.length))
            : '';

        if (req.method === 'HEAD' && key) {
            if (key === 'hifi/missing.flac') headCountForMissing += 1;
            setTimeout(() => {
                res.writeHead(404);
                res.end();
            }, 30);
            return;
        }

        if (req.method === 'PUT' && key) {
            activePuts += 1;
            if (activePuts > maxConcurrentPuts) maxConcurrentPuts = activePuts;
            putCount += 1;
            req.on('data', () => {});
            req.on('end', () => {
                setTimeout(() => {
                    uploadedOrder.push(key);
                    activePuts -= 1;
                    res.writeHead(200);
                    res.end();
                }, 40);
            });
            return;
        }

        res.writeHead(404);
        res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-queue-test-'));
    const f1 = path.join(tmpDir, 't1.flac');
    const f2 = path.join(tmpDir, 't2.flac');
    fs.writeFileSync(f1, Buffer.from('fLaC' + 'a'.repeat(128)));
    fs.writeFileSync(f2, Buffer.from('fLaC' + 'b'.repeat(128)));

    try {
        process.env.R2_ENDPOINT = `http://127.0.0.1:${port}`;
        process.env.R2_BUCKET = 'test-bucket';
        process.env.R2_ACCESS_KEY_ID = 'ak-test';
        process.env.R2_SECRET_ACCESS_KEY = 'sk-test';
        process.env.R2_PUBLIC_URL = 'https://cdn.example.com';

        // 1. Concurrent HEAD requests for same track coalesce into 1 upstream HEAD, and 404 miss is cached
        const headResults = await Promise.all([
            checkR2ObjectExists('missing'),
            checkR2ObjectExists('missing'),
            checkR2ObjectExists('missing'),
        ]);
        assert.deepEqual(headResults, [false, false, false]);
        assert.equal(headCountForMissing, 1);

        const repeatMissing = await checkR2ObjectExists('missing');
        assert.equal(repeatMissing, false);
        assert.equal(headCountForMissing, 1);

        // 2. enqueueR2Upload defers while check returns true, protects files while queued, and serializes PUTs
        let deferActive = true;
        setR2BackgroundDeferCheck(() => deferActive);
        setTimeout(() => {
            deferActive = false;
        }, 120);

        const p1 = enqueueR2Upload('t1', f1);
        const p2 = enqueueR2Upload('t2', f2);
        assert.equal(isFileProtectedByR2(f1), true);
        assert.equal(isFileProtectedByR2(f2), true);
        assert.equal(putCount, 0);

        const results = await Promise.all([p1, p2]);
        assert.deepEqual(results, [true, true]);
        assert.equal(maxConcurrentPuts, 1);
        assert.equal(putCount, 2);
        assert.deepEqual(uploadedOrder, ['hifi/t1.flac', 'hifi/t2.flac']);
        assert.equal(isFileProtectedByR2(f1), false);
        assert.equal(isFileProtectedByR2(f2), false);

        // 3. Re-enqueuing an already-known track skips PUT completely
        const cachedOk = await enqueueR2Upload('t1', f1);
        assert.equal(cachedOk, true);
        assert.equal(putCount, 2);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        resetR2CacheStateForTest();
        restoreEnv(savedEnv);
    }
});
