import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let deploySecretSource = process.env.DEPLOY_SECRET ? 'process.env' : 'unset';

function loadDotEnv(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    const PROTECTED_ENV = new Set(['PORT', 'SERVER_PORT', 'BLUE_PORT', 'GREEN_PORT']);
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env) || !PROTECTED_ENV.has(key)) {
        process.env[key] = val;
        if (key === 'DEPLOY_SECRET' && val) {
          deploySecretSource = '.env';
        }
      }
    }
  } catch {}
}

loadDotEnv(path.join(__dirname, '.env'));

const PUBLIC_PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const BLUE_PORT = Number(process.env.BLUE_PORT || 3101);
const GREEN_PORT = Number(process.env.GREEN_PORT || 3102);
const BUILDS_DIR = path.join(__dirname, '.builds');
const DEFAULT_DIST_DIR = path.join(__dirname, 'dist');
const HIFI_CACHE_DIR = process.env.HIFI_CACHE_DIR
  ? path.resolve(process.env.HIFI_CACHE_DIR)
  : path.join(__dirname, '.hifi_cache');
const DRAIN_GRACE_MS = Math.max(10_000, parseInt(process.env.DRAIN_TIMEOUT_MS || '90000', 10) || 90000);

try {
  fs.mkdirSync(BUILDS_DIR, { recursive: true });
  fs.mkdirSync(HIFI_CACHE_DIR, { recursive: true });
} catch {}

let activeWorker = null;
const drainingWorkers = new Set();
let shuttingDown = false;
let crashRestartTimer = null;
let queuedRedeploy = false;

const deployState = {
  running: false,
  queued: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastSource: null,
  lastStatus: 'idle',
  lastError: null,
  activeRelease: null,
  activeCommit: null,
};

function runCommand(cmd, args, { env = process.env, cwd = __dirname, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!quiet) process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!quiet) process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function getFileHash(filePath) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return '';
  }
}

async function getGitFullSha() {
  try {
    const { stdout } = await runCommand('git', ['rev-parse', 'HEAD'], { quiet: true });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getGitShortSha() {
  try {
    const { stdout } = await runCommand('git', ['rev-parse', '--short', 'HEAD']);
    return stdout.trim() || 'nogit';
  } catch {
    return 'nogit';
  }
}

function findLatestStagedBuild() {
  const candidates = [];
  try {
    const entries = fs.readdirSync(BUILDS_DIR, { withFileTypes: true });
    for (const d of entries) {
      if (!d.isDirectory() || !d.name.startsWith('dist-')) continue;
      const full = path.join(BUILDS_DIR, d.name);
      const indexHtml = path.join(full, 'index.html');
      if (fs.existsSync(indexHtml)) {
        candidates.push({ full, mtimeMs: fs.statSync(indexHtml).mtimeMs });
      }
    }
  } catch {}

  const defaultIndex = path.join(DEFAULT_DIST_DIR, 'index.html');
  if (fs.existsSync(defaultIndex)) {
    candidates.push({ full: DEFAULT_DIST_DIR, mtimeMs: fs.statSync(defaultIndex).mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.full || null;
}

function pruneOldBuilds() {
  try {
    const protectedDirs = new Set();
    if (activeWorker?.distDir) protectedDirs.add(path.resolve(activeWorker.distDir));
    for (const w of drainingWorkers) {
      if (w.distDir) protectedDirs.add(path.resolve(w.distDir));
    }

    const entries = fs.readdirSync(BUILDS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('dist-')) continue;
      const full = path.resolve(path.join(BUILDS_DIR, entry.name));
      if (protectedDirs.has(full)) continue;
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

async function buildIntoStaging(tag = 'local') {
  const safeTag = tag.replace(/[^a-zA-Z0-9_-]/g, '') || 'rel';
  const outDir = path.join(BUILDS_DIR, `dist-${safeTag}-${Date.now()}`);
  const viteBin = path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js');
  const buildEnv = {
    ...process.env,
    NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=512',
  };
  await runCommand(process.execPath, [viteBin, 'build', '--outDir', outDir], { env: buildEnv });
  if (!fs.existsSync(path.join(outDir, 'index.html'))) {
    throw new Error(`Vite build succeeded but ${path.join(outDir, 'index.html')} is missing`);
  }
  return outDir;
}

function probeWorkerHealth(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: 1500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function spawnWorker(port, distDir) {
  const workerMaxHeapMb = Math.max(128, parseInt(process.env.WORKER_MAX_OLD_SPACE_MB || '256', 10) || 256);
  const existingNodeOpts = String(process.env.NODE_OPTIONS || '').trim();
  const nodeOptions = existingNodeOpts.includes('--max-old-space-size')
    ? existingNodeOpts
    : [existingNodeOpts, `--max-old-space-size=${workerMaxHeapMb}`].filter(Boolean).join(' ');

  const workerEnv = {
    ...process.env,
    PORT: String(port),
    SERVER_PORT: String(port),
    DIST_DIR: distDir,
    HIFI_CACHE_DIR,
    DRAIN_TIMEOUT_MS: String(DRAIN_GRACE_MS),
    NODE_OPTIONS: nodeOptions,
  };

  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: workerEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const worker = { port, distDir, proc, draining: false, exited: false };

  proc.stdout.on('data', (chunk) => process.stdout.write(`[w:${port}] ${chunk}`));
  proc.stderr.on('data', (chunk) => process.stderr.write(`[w:${port}] ${chunk}`));

  proc.on('exit', (code, signal) => {
    worker.exited = true;
    drainingWorkers.delete(worker);
    pruneOldBuilds();
    if (!shuttingDown && activeWorker === worker && !worker.draining) {
      console.error(`[runner] Active worker :${port} exited unexpectedly (code=${code}, signal=${signal}); restarting...`);
      activeWorker = null;
      if (crashRestartTimer) clearTimeout(crashRestartTimer);
      crashRestartTimer = setTimeout(() => {
        if (!shuttingDown && !activeWorker) {
          bootInitialWorker().catch((err) => {
            console.error('[runner] Crash recovery failed:', err.message);
          });
        }
      }, 1000);
    }
  });

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (worker.exited) {
      throw new Error(`Standby worker on :${port} exited before passing health check`);
    }
    if (await probeWorkerHealth(port)) {
      return worker;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  try { proc.kill('SIGKILL'); } catch {}
  throw new Error(`Standby worker on :${port} timed out waiting for /api/health`);
}

function drainWorker(worker) {
  if (!worker || worker.exited) return;
  worker.draining = true;
  drainingWorkers.add(worker);
  if (worker.proc.connected) {
    try {
      worker.proc.send({ type: 'drain' });
    } catch {
      try { worker.proc.kill('SIGTERM'); } catch {}
    }
  } else {
    try { worker.proc.kill('SIGTERM'); } catch {}
  }
  const killer = setTimeout(() => {
    if (!worker.exited) {
      try {
        worker.proc.kill('SIGKILL');
      } catch {}
    }
  }, DRAIN_GRACE_MS + 5_000);
  killer.unref();
}

async function syncGitWorkingTree() {
  if (!fs.existsSync(path.join(__dirname, '.git'))) return { pulled: false };

  let upstreamRef = '';
  try {
    const { stdout } = await runCommand('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      quiet: true,
    });
    upstreamRef = stdout.trim();
  } catch {}

  if (!upstreamRef) {
    // Altare / Pterodactyl containers may clone detached or without branch tracking; fall back to origin/<branch>
    try {
      await runCommand('git', ['remote', 'get-url', 'origin'], { quiet: true });
      let branch = (process.env.GIT_BRANCH || process.env.BRANCH || '').trim();
      if (!branch) {
        try {
          const { stdout } = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true });
          const cur = stdout.trim();
          if (cur && cur !== 'HEAD') branch = cur;
        } catch {}
      }
      if (!branch) {
        try {
          const { stdout } = await runCommand('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
            quiet: true,
          });
          branch = stdout.trim().replace(/^origin\//, '');
        } catch {}
      }
      upstreamRef = `origin/${branch || 'main'}`;
    } catch {}
  }

  if (!upstreamRef) {
    console.log('[deploy] No git remote/upstream configured; building current working tree.');
    return { pulled: false };
  }

  // Clear local tracked drift (e.g. package-lock.json touched by container npm install) before pulling
  await runCommand('git', ['reset', '--hard', 'HEAD']);
  const lockBefore =
    getFileHash(path.join(__dirname, 'package-lock.json')) + getFileHash(path.join(__dirname, 'package.json'));

  await runCommand('git', ['fetch', '--all', '--prune']);
  try {
    await runCommand('git', ['merge', '--ff-only', upstreamRef]);
  } catch {
    console.warn(`[deploy] Fast-forward to ${upstreamRef} failed; resetting cleanly to match remote.`);
    await runCommand('git', ['reset', '--hard', upstreamRef]);
  }
  return { pulled: true, lockBefore };
}

async function bootInitialWorker() {
  let distDir = findLatestStagedBuild();
  if (!distDir) {
    console.log('[runner] No prebuilt dist found; running initial Vite build...');
    distDir = await buildIntoStaging('init');
  }
  const targetPort = BLUE_PORT;
  const worker = await spawnWorker(targetPort, distDir);
  activeWorker = worker;
  deployState.activeRelease = path.basename(distDir);
  deployState.activeCommit = await getGitFullSha();
  console.log(`[runner] Ready: proxying public :${PUBLIC_PORT} -> active worker :${targetPort} (${deployState.activeRelease})`);
}

async function runZeroDowntimeDeploy({ source = 'manual', skipPull = false, skipBuild = false } = {}) {
  if (deployState.running) {
    console.log('[deploy] Deploy already in progress; queuing follow-up deploy.');
    queuedRedeploy = true;
    deployState.queued = true;
    return { started: false, alreadyRunning: true, queued: true, state: deployState };
  }

  deployState.running = true;
  deployState.queued = false;
  queuedRedeploy = false;
  deployState.lastStartedAt = new Date().toISOString();
  deployState.lastSource = source;
  deployState.lastStatus = 'running';
  deployState.lastError = null;

  let stagedDir = null;
  let standby = null;

  try {
    console.log(`[deploy] Starting zero-downtime deploy (source=${source})...`);
    let lockBefore = getFileHash(path.join(__dirname, 'package-lock.json')) + getFileHash(path.join(__dirname, 'package.json'));

    if (!skipPull) {
      const syncRes = await syncGitWorkingTree();
      if (syncRes.lockBefore) lockBefore = syncRes.lockBefore;
    }

    const lockAfter = getFileHash(path.join(__dirname, 'package-lock.json')) + getFileHash(path.join(__dirname, 'package.json'));
    if (!skipPull && lockBefore !== lockAfter) {
      console.log('[deploy] Dependencies changed; running npm install --ignore-scripts...');
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      await runCommand(npmBin, ['install', '--no-audit', '--no-fund', '--no-save', '--ignore-scripts']);
      if (fs.existsSync(path.join(__dirname, '.git'))) {
        try {
          await runCommand('git', ['checkout', '--', 'package-lock.json'], { quiet: true });
        } catch {}
      }
    }

    const sha = await getGitShortSha();
    const fullSha = await getGitFullSha();
    if (skipBuild) {
      stagedDir = activeWorker?.distDir || findLatestStagedBuild() || (await buildIntoStaging(sha));
    } else {
      stagedDir = await buildIntoStaging(sha);
    }

    const nextPort = activeWorker?.port === BLUE_PORT ? GREEN_PORT : BLUE_PORT;
    console.log(`[deploy] Starting standby worker on :${nextPort} (${path.basename(stagedDir)})...`);
    standby = await spawnWorker(nextPort, stagedDir);

    const previous = activeWorker;
    activeWorker = standby;
    deployState.activeRelease = path.basename(stagedDir);
    deployState.activeCommit = fullSha;
    console.log(`[deploy] Cutover complete: :${PUBLIC_PORT} -> :${nextPort} (${sha})`);

    if (previous) {
      console.log(`[deploy] Draining previous worker :${previous.port} cleanly...`);
      drainWorker(previous);
    } else {
      pruneOldBuilds();
    }

    deployState.lastStatus = 'succeeded';
    deployState.lastFinishedAt = new Date().toISOString();
    console.log(`[deploy] Zero-downtime deploy finished cleanly.`);
    return { started: true, state: deployState };
  } catch (err) {
    deployState.lastStatus = 'failed';
    deployState.lastError = err.message || 'Deploy failed';
    deployState.lastFinishedAt = new Date().toISOString();
    console.error(`[deploy] Aborted without interrupting live traffic: ${deployState.lastError}`);
    if (standby && standby !== activeWorker) {
      try { standby.proc.kill('SIGKILL'); } catch {}
    }
    if (stagedDir && stagedDir !== activeWorker?.distDir && stagedDir.startsWith(BUILDS_DIR)) {
      try { fs.rmSync(stagedDir, { recursive: true, force: true }); } catch {}
    }
    return { started: false, error: deployState.lastError, state: deployState };
  } finally {
    deployState.running = false;
    if (queuedRedeploy) {
      queuedRedeploy = false;
      deployState.queued = false;
      setImmediate(() => {
        runZeroDowntimeDeploy({ source: 'webhook-queued' }).catch(() => {});
      });
    }
  }
}

function safeEqualString(a = '', b = '') {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyDeployAuth(req, rawBody) {
  const secret = process.env.DEPLOY_SECRET;
  if (!secret) {
    return { ok: false, status: 403, message: 'DEPLOY_SECRET is not configured' };
  }

  const headerSecret = req.headers['x-deploy-secret'];
  if (typeof headerSecret === 'string' && safeEqualString(headerSecret, secret)) {
    return { ok: true };
  }

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && safeEqualString(auth.slice(7).trim(), secret)) {
    return { ok: true };
  }

  const ghSig = req.headers['x-hub-signature-256'];
  if (typeof ghSig === 'string' && rawBody) {
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    if (safeEqualString(ghSig, expected)) {
      return { ok: true };
    }
  }

  const receivedToken =
    (typeof headerSecret === 'string' && headerSecret) ||
    (typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
  console.warn(
    `[deploy] Unauthorized trigger: source=${deploySecretSource} expectedLen=${secret.length} expectedPrefix=${secret.slice(0, 4)} receivedLen=${receivedToken.length} receivedPrefix=${receivedToken.slice(0, 4)}`
  );
  return { ok: false, status: 401, message: 'Unauthorized deploy trigger' };
}

function readRequestBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const proxyServer = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (req.method === 'POST' && urlPath === '/_deploy') {
    let rawBody = Buffer.alloc(0);
    try {
      rawBody = await readRequestBody(req);
    } catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      return;
    }

    const auth = verifyDeployAuth(req, rawBody);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: auth.message }));
      return;
    }

    const alreadyRunning = deployState.running;
    if (!alreadyRunning) {
      runZeroDowntimeDeploy({ source: 'webhook' }).catch(() => {});
    } else {
      queuedRedeploy = true;
      deployState.queued = true;
    }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        accepted: !alreadyRunning,
        alreadyRunning,
        queued: deployState.queued,
        state: deployState,
      })
    );
    return;
  }

  if (req.method === 'GET' && urlPath === '/_deploy/status') {
    const auth = verifyDeployAuth(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: auth.message }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        publicPort: PUBLIC_PORT,
        activePort: activeWorker?.port || null,
        activePid: activeWorker?.proc?.pid || null,
        drainingCount: drainingWorkers.size,
        deploy: deployState,
      })
    );
    return;
  }

  const target = activeWorker;
  if (!target) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Service starting up' }));
    return;
  }

  const remoteIp = req.socket?.remoteAddress || '';
  const priorXff = req.headers['x-forwarded-for'];
  const forwardedFor = priorXff ? `${priorXff}, ${remoteIp}` : remoteIp;

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: target.port,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        'x-forwarded-host': req.headers.host || '',
        ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      },
    },
    (proxyRes) => {
      if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      }
      proxyRes.pipe(res);
    }
  );

  proxyReq.setTimeout(0);

  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    if (!res.destroyed) res.end(JSON.stringify({ error: 'Upstream proxy error' }));
  });

  res.on('close', () => {
    if (!res.writableFinished && !proxyReq.destroyed) {
      proxyReq.destroy();
    }
  });

  req.pipe(proxyReq);
});

proxyServer.requestTimeout = 0;

function shutdownRunner(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[runner] Received ${signal}; shutting down proxy and workers...`);
  if (crashRestartTimer) clearTimeout(crashRestartTimer);
  proxyServer.close(() => process.exit(0));
  if (activeWorker && !activeWorker.exited) {
    try { activeWorker.proc.kill('SIGTERM'); } catch {}
  }
  for (const w of drainingWorkers) {
    if (!w.exited) {
      try { w.proc.kill('SIGTERM'); } catch {}
    }
  }
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGTERM', () => shutdownRunner('SIGTERM'));
process.on('SIGINT', () => shutdownRunner('SIGINT'));

// Altare console command listener (> Type a command)
if (process.stdin && !process.stdin.destroyed) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (raw) => {
    const line = raw.trim().toLowerCase();
    if (!line) return;
    if (line === 'deploy') {
      runZeroDowntimeDeploy({ source: 'console' });
    } else if (line === 'rebuild' || line === 'deploy --no-pull') {
      runZeroDowntimeDeploy({ source: 'console', skipPull: true });
    } else if (line === 'restart' || line === 'reload') {
      runZeroDowntimeDeploy({ source: 'console', skipPull: true, skipBuild: true });
    } else if (line === 'status') {
      console.log(
        JSON.stringify({
          publicPort: PUBLIC_PORT,
          activePort: activeWorker?.port || null,
          activePid: activeWorker?.proc?.pid || null,
          drainingCount: drainingWorkers.size,
          deploySecretConfigured: Boolean(process.env.DEPLOY_SECRET),
          deploySecretSource,
          deploySecretLength: (process.env.DEPLOY_SECRET || '').length,
          deployState,
        })
      );
    } else if (line === 'help') {
      console.log('[runner] Commands: deploy | rebuild | restart | status | help');
    } else {
      console.log(`[runner] Unknown command "${line}". Try: deploy, rebuild, restart, status, help`);
    }
  });
}

proxyServer.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PUBLIC_PORT}`);
  bootInitialWorker().catch((err) => {
    console.error('[runner] Initial worker boot failed:', err.message);
    process.exit(1);
  });
});
