/**
 * Optional Cloudflare Worker relay for upstream music metadata/search requests.
 * Helps avoid single-origin IP throttling while automatically falling back on direct server fetch if quota runs out.
 */
const ALLOWED_TARGET_HOSTS = new Set([
  'music.youtube.com',
  'www.youtube.com',
  'tracks.monochrome.st',
  'flac.music.hi.cn',
  'kworb.net',
]);

const STRIPPED_REQ_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'x-target-url',
  'x-target-method',
  'x-relay-secret',
  'x-forwarded-proto',
  'x-real-ip',
  'true-client-ip',
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method !== 'POST' || url.pathname !== '/relay') {
      return new Response('Not found', { status: 404 });
    }

    const expectedSecret = String(env?.RELAY_SECRET || '').trim();
    if (expectedSecret) {
      const provided = String(request.headers.get('X-Relay-Secret') || '').trim();
      if (provided !== expectedSecret) {
        return new Response(JSON.stringify({ error: 'Unauthorized relay request' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const targetUrlRaw = String(request.headers.get('X-Target-Url') || '').trim();
    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrlRaw);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid X-Target-Url' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (
      parsedTarget.protocol !== 'https:' ||
      !ALLOWED_TARGET_HOSTS.has(parsedTarget.hostname.toLowerCase())
    ) {
      return new Response(JSON.stringify({ error: 'Target host not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const method = String(request.headers.get('X-Target-Method') || 'GET').toUpperCase();
    const outHeaders = new Headers();
    for (const [k, v] of request.headers.entries()) {
      const lk = k.toLowerCase();
      if (STRIPPED_REQ_HEADERS.has(lk) || lk.startsWith('cf-')) continue;
      outHeaders.set(k, v);
    }

    const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();
    const upstreamRes = await fetch(parsedTarget.toString(), {
      method,
      headers: outHeaders,
      body,
    });

    const respHeaders = new Headers(upstreamRes.headers);
    respHeaders.delete('content-encoding');
    respHeaders.delete('content-length');
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: respHeaders,
    });
  },
};
