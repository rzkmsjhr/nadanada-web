# Cloudflare Free Tier Scaling Setup

All features work out of the box with **zero** extra accounts. Add these optional Cloudflare Free integrations when scaling higher:

## 1. Cloudflare CDN Edge Caching (Free)
Point your domain's DNS to Cloudflare (Orange Cloud proxied) and create **Cache Rules** in Cloudflare Dashboard → *Caching* → *Cache Rules*:

1. **Cache read-only API JSON + assets (`Cache Everything`):**
   - Match: URI Path starts with `/api/search` OR `/api/artist` OR `/api/playlist` OR `/api/trending` OR `/api/lyrics` OR `/api/album-info` OR `/api/monochrome/` OR `/api/mix` OR `/assets/`
   - Cache eligibility: **Eligible for cache** (respect origin `Cache-Control` `s-maxage` headers).
2. **Bypass audio & dynamic endpoints (`Bypass Cache`):**
   - Match: URI Path starts with `/hifi/` OR `/api/audio-stream` OR `/api/download` OR `/api/hifi/` OR `/api/visitor-region`
   - Cache eligibility: **Bypass cache** (keeps large FLAC streams off Cloudflare's free CDN proxy).

---

## 2. Cloudflare R2 Free Tier FLAC Cache (`0` Egress Cost)
1. Enable **R2** in Cloudflare Dashboard (free quota: 10 GB storage, 1M writes/mo, 10M reads/mo, $0 egress).
2. Create a bucket (e.g. `mysongs-hifi`), enable **Public Development URL** (or attach a custom subdomain), and create an **R2 API Token** with *Object Read & Write* permissions for that bucket.
3. Add **CORS Policy** on the bucket:
   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["Range"],
       "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```
4. Set these `.env` / environment variables on your server:
   ```env
   R2_ACCOUNT_ID=your_cloudflare_account_id
   R2_BUCKET=mysongs-hifi
   R2_ACCESS_KEY_ID=your_r2_access_key_id
   R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
   R2_PUBLIC_URL=https://pub-xxxxxxxxxxxxxxxx.r2.dev
   R2_MAX_CACHE_MB=8500
   ```
   Cached tracks upload in the background after download and `/hifi/stream` automatically responds with `302` to R2. Oldest objects auto-prune once usage exceeds `R2_MAX_CACHE_MB` (default `8500` MB to stay safely under 10 GB free storage).

---

## 3. Cloudflare Worker Metadata Relay (Optional Multi-Egress Pool)
1. Deploy [relay-worker.js](./relay-worker.js) in Cloudflare Dashboard → *Workers & Pages* → *Create Worker* (free quota: 100k requests/day).
2. Optionally set secret `RELAY_SECRET` in the Worker settings.
3. Add to your server `.env`:
   ```env
   UPSTREAM_RELAY_URLS=https://your-relay.your-subdomain.workers.dev
   UPSTREAM_RELAY_SECRET=your_shared_secret
   ```
   You can list multiple comma-separated Worker URLs for round-robin distribution. If a relay hits quota (`429`) or fails, `fetchWithTimeout` automatically falls back to direct origin fetch.
