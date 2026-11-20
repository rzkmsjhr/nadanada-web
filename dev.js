import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npx.cmd' : 'npx';

const serverProc = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: process.env.PORT || '3000' },
  stdio: 'inherit',
});

const viteProc = spawn(npmCmd, ['vite'], {
  env: process.env,
  stdio: 'inherit',
  shell: isWin,
});

function shutdown(code = 0) {
  try { serverProc.kill(); } catch {}
  try { viteProc.kill(); } catch {}
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

serverProc.on('exit', (code) => {
  if (code !== null && code !== 0) shutdown(code);
});

viteProc.on('exit', (code) => {
  shutdown(code || 0);
});
