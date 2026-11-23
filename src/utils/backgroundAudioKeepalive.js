/**
 * Silent Web Audio keepalive so Chromium keeps the tab's audio exemption and timer cadence
 * active across track gaps and Pre-Play Hi-Fi resolution while backgrounded.
 */

let audioCtx = null;
let keepaliveSource = null;
let keepaliveGain = null;
let silentBuffer = null;

function getAudioContextCtor() {
  if (typeof window === 'undefined') return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

function getOrCreateContext() {
  if (audioCtx && audioCtx.state !== 'closed') return audioCtx;
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  try {
    audioCtx = new Ctor();
    silentBuffer = null;
    return audioCtx;
  } catch {
    return null;
  }
}

export function primeAudioKeepalive() {
  const ctx = getOrCreateContext();
  if (!ctx) return;
  try {
    ctx.resume?.().catch(() => {});
  } catch {}
}

export function startAudioKeepalive() {
  const ctx = getOrCreateContext();
  if (!ctx) return;
  try {
    ctx.resume?.().catch(() => {});
    if (keepaliveSource) return;

    if (!silentBuffer) {
      const sampleRate = Math.max(8000, ctx.sampleRate || 44100);
      silentBuffer = ctx.createBuffer(1, sampleRate, sampleRate);
    }

    const source = ctx.createBufferSource();
    source.buffer = silentBuffer;
    source.loop = true;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(0);

    keepaliveSource = source;
    keepaliveGain = gain;
  } catch {
    keepaliveSource = null;
    keepaliveGain = null;
  }
}

export function stopAudioKeepalive() {
  if (keepaliveSource) {
    try {
      keepaliveSource.stop();
    } catch {}
    try {
      keepaliveSource.disconnect();
    } catch {}
    keepaliveSource = null;
  }
  if (keepaliveGain) {
    try {
      keepaliveGain.disconnect();
    } catch {}
    keepaliveGain = null;
  }
}
