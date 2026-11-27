import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';

const R2_KNOWN_HIT_TTL_MS = 30 * 60 * 1000;
const R2_KNOWN_MISS_TTL_MS = 10 * 60 * 1000;
const R2_KNOWN_MAX = 5000;
const R2_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

const r2KnownCache = new Map();
const r2InFlightChecks = new Map();
const r2InFlightUploads = new Map();
const r2UploadQueue = [];
const r2UploadQueuedIds = new Set();
const r2ProtectedFilePaths = new Set();
let r2UploadDrainRunning = false;
let r2DeferCheck = null;
let lastR2PruneAt = 0;
let r2InFlightPrune = null;

export function setR2BackgroundDeferCheck(fn) {
  r2DeferCheck = typeof fn === 'function' ? fn : null;
}

export function isFileProtectedByR2(filePath) {
  return Boolean(filePath && r2ProtectedFilePaths.has(filePath));
}

function unrefDelay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

async function waitWhileR2Deferred(maxWaitMs = 15000, stepMs = 1000) {
  if (typeof r2DeferCheck !== 'function') return;
  const start = Date.now();
  while (r2DeferCheck() && Date.now() - start < maxWaitMs) {
    await unrefDelay(stepMs);
  }
}

export function getR2Config() {
  const endpointRaw =
    process.env.R2_ENDPOINT ||
    (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com` : '');
  const endpoint = String(endpointRaw || '').replace(/\/+$/, '');
  const bucket = String(process.env.R2_BUCKET || '').trim();
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
  const publicUrl = String(process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
  const maxBytes = Math.max(50, parseInt(process.env.R2_MAX_CACHE_MB || '8500', 10) || 8500) * 1024 * 1024;
  return { endpoint, bucket, accessKeyId, secretAccessKey, publicUrl, maxBytes };
}

export function isR2Enabled() {
  const cfg = getR2Config();
  return Boolean(cfg.endpoint && cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey && cfg.publicUrl);
}

export function getR2ObjectKey(trackId) {
  const safeId = String(trackId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return `hifi/${safeId}.flac`;
}

export function getR2PublicUrl(trackId) {
  const { publicUrl } = getR2Config();
  return `${publicUrl}/${getR2ObjectKey(trackId)}`;
}

function setKnownCache(trackId, exists) {
  if (!trackId) return;
  const key = String(trackId);
  if (r2KnownCache.has(key)) r2KnownCache.delete(key);
  r2KnownCache.set(key, { exists: Boolean(exists), ts: Date.now() });
  while (r2KnownCache.size > R2_KNOWN_MAX) {
    const oldest = r2KnownCache.keys().next().value;
    if (oldest === undefined) break;
    r2KnownCache.delete(oldest);
  }
}

export function hasKnownR2Track(trackId) {
  if (!trackId) return false;
  const entry = r2KnownCache.get(String(trackId));
  if (!entry) return false;
  const ttl = entry.exists ? R2_KNOWN_HIT_TTL_MS : R2_KNOWN_MISS_TTL_MS;
  if (Date.now() - entry.ts >= ttl) {
    r2KnownCache.delete(String(trackId));
    return false;
  }
  return entry.exists;
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Pure AWS4-HMAC-SHA256 signer for Cloudflare R2 S3-compatible API (zero SDK dependency).
 */
export function signR2Request({
  method = 'GET',
  url,
  headers = {},
  payloadHash = 'UNSIGNED-PAYLOAD',
  accessKeyId,
  secretAccessKey,
  region = 'auto',
  service = 's3',
  now = new Date(),
}) {
  const parsed = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const upperMethod = String(method || 'GET').toUpperCase();

  const headerMap = new Map();
  headerMap.set('host', parsed.host);
  headerMap.set('x-amz-date', amzDate);
  headerMap.set('x-amz-content-sha256', payloadHash);
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === undefined || v === null) continue;
    headerMap.set(k.toLowerCase(), String(v).trim().replace(/\s+/g, ' '));
  }

  const canonicalUri = parsed.pathname
    .split('/')
    .map((seg) => encodeRfc3986(decodeURIComponent(seg)))
    .join('/');

  const queryPairs = [];
  for (const [k, v] of parsed.searchParams.entries()) {
    queryPairs.push([encodeRfc3986(k), encodeRfc3986(v)]);
  }
  queryPairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join('&');

  const sortedHeaderKeys = [...headerMap.keys()].sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headerMap.get(k)}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    upperMethod,
    canonicalUri || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const outHeaders = { ...headers };
  outHeaders.Host = parsed.host;
  outHeaders['x-amz-date'] = amzDate;
  outHeaders['x-amz-content-sha256'] = payloadHash;
  outHeaders.Authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return outHeaders;
}

async function r2Fetch(method, targetUrl, { headers = {}, body = undefined, timeoutMs = 15000, duplex = undefined } = {}) {
  const cfg = getR2Config();
  const signedHeaders = signR2Request({
    method,
    url: targetUrl,
    headers,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchOpts = { method, headers: signedHeaders, body, signal: controller.signal };
    if (duplex) fetchOpts.duplex = duplex;
    return await fetch(targetUrl, fetchOpts);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkR2ObjectExists(trackId, { timeoutMs = 1500 } = {}) {
  if (!isR2Enabled() || !trackId) return false;
  const keyStr = String(trackId);
  const cached = r2KnownCache.get(keyStr);
  if (cached) {
    const ttl = cached.exists ? R2_KNOWN_HIT_TTL_MS : R2_KNOWN_MISS_TTL_MS;
    if (Date.now() - cached.ts < ttl) return cached.exists;
  }

  if (r2InFlightChecks.has(keyStr)) {
    return r2InFlightChecks.get(keyStr);
  }

  const job = (async () => {
    const { endpoint, bucket } = getR2Config();
    const objectUrl = `${endpoint}/${bucket}/${getR2ObjectKey(keyStr)}`;
    try {
      const res = await r2Fetch('HEAD', objectUrl, { timeoutMs });
      await res.body?.cancel?.();
      const exists = res.status === 200;
      if (res.status === 200 || res.status === 404) {
        setKnownCache(keyStr, exists);
      }
      return exists;
    } catch {
      return false;
    } finally {
      if (r2InFlightChecks.get(keyStr) === job) {
        r2InFlightChecks.delete(keyStr);
      }
    }
  })();

  r2InFlightChecks.set(keyStr, job);
  return job;
}

function decodeXmlEntities(str = '') {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseListObjectsXml(xmlText = '') {
  const objects = [];
  for (const match of xmlText.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1];
    const keyMatch = /<Key>([\s\S]*?)<\/Key>/.exec(block);
    const modMatch = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block);
    const sizeMatch = /<Size>(\d+)<\/Size>/.exec(block);
    if (!keyMatch || !sizeMatch) continue;
    objects.push({
      key: decodeXmlEntities(keyMatch[1].trim()),
      lastModifiedMs: modMatch ? Date.parse(modMatch[1].trim()) || 0 : 0,
      size: Number(sizeMatch[1]) || 0,
    });
  }
  const isTruncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xmlText);
  const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xmlText);
  const nextToken = tokenMatch ? decodeXmlEntities(tokenMatch[1].trim()) : null;
  return { objects, isTruncated, nextToken };
}

export async function pruneR2BucketIfNeeded({ force = false, protectedKey = null } = {}) {
  if (!isR2Enabled()) return { pruned: 0, totalBytes: 0 };
  if (r2InFlightPrune) return r2InFlightPrune;
  const now = Date.now();
  if (!force && now - lastR2PruneAt < R2_PRUNE_INTERVAL_MS) {
    return { pruned: 0, skipped: true };
  }
  lastR2PruneAt = now;

  r2InFlightPrune = (async () => {
    if (!force) {
      await waitWhileR2Deferred(15000, 1000);
    }

    const { endpoint, bucket, maxBytes } = getR2Config();
    const allObjects = [];
    let continuationToken = null;

    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({ 'list-type': '2', prefix: 'hifi/' });
      if (continuationToken) params.set('continuation-token', continuationToken);
      const listUrl = `${endpoint}/${bucket}?${params.toString()}`;
      const res = await r2Fetch('GET', listUrl, { timeoutMs: 10000 });
      if (!res.ok) {
        await res.body?.cancel?.();
        throw new Error(`R2 list failed (${res.status})`);
      }
      const xml = await res.text();
      const parsed = parseListObjectsXml(xml);
      allObjects.push(...parsed.objects);
      if (!parsed.isTruncated || !parsed.nextToken) break;
      continuationToken = parsed.nextToken;
    }

    let totalBytes = allObjects.reduce((sum, item) => sum + item.size, 0);
    if (totalBytes <= maxBytes) {
      return { pruned: 0, totalBytes };
    }

    allObjects.sort((a, b) => a.lastModifiedMs - b.lastModifiedMs);
    let pruned = 0;

    for (const obj of allObjects) {
      if (totalBytes <= maxBytes) break;
      if (protectedKey && obj.key === protectedKey) continue;
      if (!force) {
        if (r2DeferCheck?.()) {
          await waitWhileR2Deferred(3000, 600);
        } else {
          await unrefDelay(150);
        }
      }
      const delUrl = `${endpoint}/${bucket}/${obj.key}`;
      try {
        const delRes = await r2Fetch('DELETE', delUrl, { timeoutMs: 8000 });
        await delRes.body?.cancel?.();
        if (delRes.ok || delRes.status === 204 || delRes.status === 404) {
          totalBytes -= obj.size;
          pruned += 1;
          const trackId = obj.key.replace(/^hifi\//, '').replace(/\.flac$/i, '');
          r2KnownCache.delete(trackId);
        }
      } catch {}
    }

    return { pruned, totalBytes };
  })();

  try {
    return await r2InFlightPrune;
  } finally {
    r2InFlightPrune = null;
  }
}

export async function uploadFileToR2(trackId, filePath, { forcePrune = false, forceUpload = false } = {}) {
  if (!isR2Enabled() || !trackId || !filePath) return false;
  const keyStr = String(trackId);
  if (!forceUpload && hasKnownR2Track(keyStr)) return true;
  if (r2InFlightUploads.has(keyStr)) {
    return r2InFlightUploads.get(keyStr);
  }

  r2ProtectedFilePaths.add(filePath);

  const job = (async () => {
    let fileStream = null;
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.size <= 0) return false;

      const { endpoint, bucket } = getR2Config();
      const objectKey = getR2ObjectKey(keyStr);
      const objectUrl = `${endpoint}/${bucket}/${objectKey}`;
      fileStream = fs.createReadStream(filePath);
      const bodyStream = Readable.toWeb(fileStream);

      const res = await r2Fetch('PUT', objectUrl, {
        headers: {
          'Content-Length': String(stat.size),
          'Content-Type': 'audio/flac',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
        body: bodyStream,
        duplex: 'half',
        timeoutMs: 60000,
      });
      await res.body?.cancel?.();
      if (!res.ok) return false;

      setKnownCache(keyStr, true);
      pruneR2BucketIfNeeded({ force: forcePrune, protectedKey: objectKey }).catch(() => {});
      return true;
    } catch {
      return false;
    } finally {
      if (fileStream && !fileStream.destroyed) {
        fileStream.destroy();
      }
      if (!r2UploadQueue.some((item) => item.filePath === filePath)) {
        r2ProtectedFilePaths.delete(filePath);
      }
      if (r2InFlightUploads.get(keyStr) === job) {
        r2InFlightUploads.delete(keyStr);
      }
    }
  })();

  r2InFlightUploads.set(keyStr, job);
  return job;
}

async function drainR2UploadQueue() {
  if (r2UploadDrainRunning) return;
  r2UploadDrainRunning = true;
  try {
    while (r2UploadQueue.length > 0) {
      const item = r2UploadQueue[0];
      let result = false;
      try {
        await waitWhileR2Deferred(15000, 1000);
        if (isR2Enabled()) {
          result = await uploadFileToR2(item.trackId, item.filePath, { forcePrune: false });
        }
      } catch {
        result = false;
      } finally {
        r2UploadQueue.shift();
        r2UploadQueuedIds.delete(item.trackId);
        if (!r2UploadQueue.some((entry) => entry.filePath === item.filePath)) {
          r2ProtectedFilePaths.delete(item.filePath);
        }
        item.resolve?.(result);
      }
    }
  } finally {
    r2UploadDrainRunning = false;
  }
}

export function enqueueR2Upload(trackId, filePath) {
  if (!isR2Enabled() || !trackId || !filePath) return Promise.resolve(false);
  const keyStr = String(trackId);
  if (hasKnownR2Track(keyStr)) return Promise.resolve(true);
  if (r2InFlightUploads.has(keyStr)) return r2InFlightUploads.get(keyStr);
  const existingQueued = r2UploadQueue.find((item) => item.trackId === keyStr);
  if (existingQueued) return existingQueued.promise;

  let resolveFn;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });

  r2UploadQueuedIds.add(keyStr);
  r2ProtectedFilePaths.add(filePath);
  r2UploadQueue.push({ trackId: keyStr, filePath, resolve: resolveFn, promise });
  drainR2UploadQueue();
  return promise;
}

export function resetR2CacheStateForTest() {
  r2KnownCache.clear();
  r2InFlightChecks.clear();
  r2InFlightUploads.clear();
  while (r2UploadQueue.length > 0) {
    const item = r2UploadQueue.shift();
    item?.resolve?.(false);
  }
  r2UploadQueuedIds.clear();
  r2ProtectedFilePaths.clear();
  r2UploadDrainRunning = false;
  r2DeferCheck = null;
  lastR2PruneAt = 0;
  r2InFlightPrune = null;
}
