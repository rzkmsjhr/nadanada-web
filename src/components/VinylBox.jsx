import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Disc } from 'lucide-react';
import { getOptimizedThumbnail } from './SpinningVinyl';

const PALETTE_CACHE = new Map();

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
  ];
}

function extractAlbumPalette(src) {
  if (!src) return Promise.resolve(null);
  if (PALETTE_CACHE.has(src)) return Promise.resolve(PALETTE_CACHE.get(src));

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);

        let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
        let avgLumaSum = 0;
        const pixelCount = data.length / 4;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];
          if (a < 128) continue;

          const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          avgLumaSum += luma;

          const [, sat, light] = rgbToHsl(r, g, b);
          // Favor saturated / visible tones so dark covers still surface their accent hue (e.g. gold on black)
          const visibleFactor = light > 0.06 && light < 0.94 ? 1 : 0.2;
          const weight = (0.08 + sat * sat * 3.5) * (0.25 + luma * 0.9) * visibleFactor;

          sumR += r * weight;
          sumG += g * weight;
          sumB += b * weight;
          sumW += weight;
        }

        if (sumW <= 0 || pixelCount === 0) {
          resolve(null);
          return;
        }

        const avgLuma = avgLumaSum / pixelCount;
        const rawR = sumR / sumW;
        const rawG = sumG / sumW;
        const rawB = sumB / sumW;
        const [h, s] = rgbToHsl(rawR, rawG, rawB);

        const boostedSat = Math.min(0.82, Math.max(s * 1.15, s > 0.08 ? 0.34 : s));
        const glowRgb = hslToRgb(h, boostedSat, 0.34);
        const midRgb = hslToRgb(h, boostedSat * 0.92, 0.2);
        const edgeRgb = hslToRgb(h, boostedSat * 0.85, 0.1);

        const palette = {
          glow: `${glowRgb[0]}, ${glowRgb[1]}, ${glowRgb[2]}`,
          mid: `${midRgb[0]}, ${midRgb[1]}, ${midRgb[2]}`,
          edge: `${edgeRgb[0]}, ${edgeRgb[1]}, ${edgeRgb[2]}`,
          isDarkCover: avgLuma < 0.24
        };

        if (PALETTE_CACHE.size >= 60) {
          const firstKey = PALETTE_CACHE.keys().next().value;
          PALETTE_CACHE.delete(firstKey);
        }
        PALETTE_CACHE.set(src, palette);
        resolve(palette);
      } catch (_) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function buildThumbnailSources(rawThumb, imgErrorStep = 0) {
  if (!rawThumb) return null;
  const optimized = getOptimizedThumbnail(rawThumb) || rawThumb;
  const list = [];

  if (rawThumb.includes('i.ytimg.com')) {
    const maxres = rawThumb.replace(/(?:hq|mq|sd|default)\.jpg/i, 'maxresdefault.jpg');
    if (maxres !== rawThumb) list.push(maxres);
    list.push(rawThumb);
    const hq = rawThumb.replace(/(?:maxresdefault|mqdefault|sddefault|default)\.jpg/i, 'hqdefault.jpg');
    if (!list.includes(hq)) list.push(hq);
  } else {
    if (optimized) list.push(optimized);
    if (rawThumb && rawThumb !== optimized) list.push(rawThumb);
  }

  return list[imgErrorStep] || null;
}

/**
 * Option 2 Vinyl Visualization:
 * - Paused / Idle: Only the square vinyl box (album sleeve) is centered with the album cover.
 * - Playing: The vinyl box glides left and the vinyl disc slides out from inside the box,
 *   maintaining a centered 60% box / 40% exposed vinyl proportion across all window layouts.
 * - Song Changes / Crossfades: Smooth directional sleeve transitions synchronized with audio crossfades.
 */
export default function VinylBox({
  song,
  nextSong = null,
  isPlaying = false,
  isCrossfading = false,
  direction = 'forward',
  subtext = null
}) {
  const [displayedSong, setDisplayedSong] = useState(song || null);
  const [outgoingSong, setOutgoingSong] = useState(null);
  const [incomingSong, setIncomingSong] = useState(null);
  const [transitionPhase, setTransitionPhase] = useState('idle'); // 'idle' | 'swapping'
  const [transitionDirection, setTransitionDirection] = useState(direction || 'forward');
  const [outgoingSlidOut, setOutgoingSlidOut] = useState(isPlaying);
  const [incomingSlidOut, setIncomingSlidOut] = useState(false);

  // Track per-song image fallback step (0..sources.length); null/exhausted falls back to icon
  const [imgSteps, setImgSteps] = useState({});

  const transitionTimersRef = useRef([]);
  const prevSongIdRef = useRef(song?.id || null);
  const targetSongRef = useRef(song || null);
  const prevCrossfadeRef = useRef(false);
  const displayedSongRef = useRef(displayedSong);
  displayedSongRef.current = displayedSong;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const handleImgError = useCallback((songId) => {
    if (!songId) return;
    setImgSteps(prev => ({ ...prev, [songId]: (prev[songId] || 0) + 1 }));
  }, []);

  const getSongThumb = useCallback((s) => {
    if (!s) return null;
    const step = imgSteps[s.id] || 0;
    return buildThumbnailSources(s.thumbnail, step);
  }, [imgSteps]);

  const clearTimers = useCallback(() => {
    transitionTimersRef.current.forEach(t => clearTimeout(t));
    transitionTimersRef.current = [];
  }, []);

  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  const triggerTransition = useCallback((fromSong, toSong, dir = 'forward') => {
    if (!toSong || fromSong?.id === toSong?.id) return;

    clearTimers();
    targetSongRef.current = toSong;

    setTransitionDirection(dir);
    setOutgoingSong(fromSong);
    setIncomingSong(toSong);
    setOutgoingSlidOut(isPlayingRef.current);
    setIncomingSlidOut(false);

    // Preload incoming artwork before/during slide-in
    if (toSong?.thumbnail) {
      const preloadSrc = buildThumbnailSources(toSong.thumbnail, 0);
      if (preloadSrc) {
        const img = new Image();
        img.src = preloadSrc;
      }
    }

    setTransitionPhase('swapping');

    // Slide the incoming vinyl out of its sleeve shortly after the sleeve enters the stage
    const slideOutTimer = setTimeout(() => {
      if (isPlayingRef.current) {
        setIncomingSlidOut(true);
      }
    }, 100);
    transitionTimersRef.current.push(slideOutTimer);

    // Atomically commit displayedSong once the 820ms transition finishes
    const finishTimer = setTimeout(() => {
      targetSongRef.current = toSong;
      setDisplayedSong(toSong);
      setOutgoingSong(null);
      setIncomingSong(null);
      setTransitionPhase('idle');
    }, 820);
    transitionTimersRef.current.push(finishTimer);
  }, [clearTimers]);

  // Monitor song changes and auto-crossfade events
  useEffect(() => {
    const currentId = song?.id;
    const targetDir = direction || 'forward';

    if (isCrossfading && nextSong) {
      if (!prevCrossfadeRef.current && nextSong.id !== targetSongRef.current?.id) {
        prevCrossfadeRef.current = true;
        triggerTransition(targetSongRef.current || displayedSongRef.current || song, nextSong, targetDir);
        prevSongIdRef.current = nextSong.id;
      }
      return;
    }
    prevCrossfadeRef.current = isCrossfading;

    if (currentId && (currentId !== prevSongIdRef.current || currentId !== targetSongRef.current?.id)) {
      const prevId = prevSongIdRef.current;
      prevSongIdRef.current = currentId;

      if (!prevId) {
        targetSongRef.current = song;
        setDisplayedSong(song);
        return;
      }

      if (currentId !== targetSongRef.current?.id) {
        triggerTransition(targetSongRef.current || displayedSongRef.current, song, targetDir);
      }
    } else if (!currentId && prevSongIdRef.current) {
      clearTimers();
      prevSongIdRef.current = null;
      targetSongRef.current = null;
      setDisplayedSong(null);
      setOutgoingSong(null);
      setIncomingSong(null);
      setTransitionPhase('idle');
    }
  }, [song, isCrossfading, nextSong, direction, triggerTransition, clearTimers]);

  // Keep incoming vinyl slide state responsive if play/pause toggles mid-transition
  const prevIsPlayingInSwapRef = useRef(isPlaying);
  useEffect(() => {
    if (prevIsPlayingInSwapRef.current !== isPlaying) {
      prevIsPlayingInSwapRef.current = isPlaying;
      if (transitionPhase === 'swapping') {
        setIncomingSlidOut(isPlaying);
      }
    }
  }, [isPlaying, transitionPhase]);

  const activeBackdropSong = transitionPhase === 'swapping'
    ? (incomingSong || displayedSong || song)
    : (displayedSong || song);
  const activeBackdropThumb = getSongThumb(activeBackdropSong);
  const outgoingBackdropThumb = transitionPhase === 'swapping' ? getSongThumb(outgoingSong) : null;

  const [adaptivePalette, setAdaptivePalette] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!activeBackdropThumb) {
      setAdaptivePalette(null);
      return;
    }
    extractAlbumPalette(activeBackdropThumb).then((pal) => {
      if (!cancelled) {
        setAdaptivePalette(pal);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeBackdropThumb]);

  /**
   * Renders one complete Vinyl Box + Vinyl Disc unit sized to the square anchor S:
   * - When slidOut === false: box is centered (0%), disc is tucked inside behind the box (0%).
   * - When slidOut === true: box shifts -33.3333% and disc slides +36.3333%,
   *   centering the combined assembly with exact 60% box / 40% exposed vinyl proportions.
   */
  const renderBoxUnit = (unitSong, slidOut, spinEnabled, keyId) => {
    if (!unitSong) return null;
    const thumb = getSongThumb(unitSong);
    const shouldSpin = spinEnabled && isPlaying;

    return (
      <div
        key={keyId}
        className="vinyl-box-anchor"
        style={{
          position: 'relative',
          height: '92cqh',
          width: '92cqh',
          maxWidth: '55cqw',
          maxHeight: '55cqw',
          aspectRatio: '1 / 1',
          flexShrink: 0
        }}
      >
        {/* ── Sliding Vinyl Disc (tucked behind sleeve when paused, slides out 40% when playing) ── */}
        <div
          className="vinyl-box-disc-slider"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1,
            transform: slidOut ? 'translate3d(36.3333%, 0, 0)' : 'translate3d(0%, 0, 0)',
            opacity: slidOut ? 1 : 0,
            transition: slidOut
              ? 'transform 0.7s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease 0s'
              : 'transform 0.68s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease 0.48s',
            willChange: 'transform, opacity'
          }}
        >
          <div
            className="vinyl-record-wrapper"
            style={{
              position: 'relative',
              width: '94%',
              height: '94%',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              filter: 'drop-shadow(0 10px 22px rgba(0, 0, 0, 0.85))'
            }}
          >
            {/* Rotating grooved vinyl disc */}
            <div
              className="vinyl-disc"
              style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                borderRadius: '50%',
                animation: spinEnabled ? 'nadanada-vinyl-spin 16s linear infinite' : 'none',
                animationPlayState: shouldSpin ? 'running' : 'paused',
                willChange: 'transform',
                background: `
                  radial-gradient(circle closest-side at center,
                    #09090b 0%,
                    #0b0b0e 44%,
                    #15151a 46%,
                    #1b1b21 49.5%,
                    #0d0d11 52.8%,
                    #19191f 53.5%,
                    #141419 59%,
                    #1c1c22 63.2%,
                    #09090c 63.7%,
                    #0e0e12 64.6%,
                    #18181e 65.2%,
                    #121217 71%,
                    #1a1a21 75.2%,
                    #09090c 75.7%,
                    #0e0e12 76.6%,
                    #19191f 77.2%,
                    #131318 83%,
                    #1b1b22 86.9%,
                    #09090c 87.4%,
                    #0d0d11 88.2%,
                    #18181e 88.8%,
                    #131318 94%,
                    #1f1f26 96.4%,
                    #0c0c0f 97.6%,
                    #2a2a32 98.8%,
                    #08080a 100%
                  )
                `,
                boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.16), inset 0 0 18px rgba(0, 0, 0, 0.96)'
              }}
            >
              {/* High-definition concentric micro-grooves masked to recorded track zone */}
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: '50%',
                  background: `
                    repeating-radial-gradient(circle at center,
                      rgba(255, 255, 255, 0.065) 0px,
                      rgba(255, 255, 255, 0.015) 0.7px,
                      rgba(0, 0, 0, 0.55) 1.4px,
                      rgba(255, 255, 255, 0.04) 2.1px
                    )
                  `,
                  maskImage: 'radial-gradient(circle closest-side at center, transparent 44%, rgba(0,0,0,0.22) 51%, #000 53.5%, #000 96%, transparent 98.5%)',
                  WebkitMaskImage: 'radial-gradient(circle closest-side at center, transparent 44%, rgba(0,0,0,0.22) 51%, #000 53.5%, #000 96%, transparent 98.5%)',
                  pointerEvents: 'none'
                }}
              />

              {/* Secondary modulated groove density rings (simulates dynamic audio passages) */}
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: '50%',
                  background: `
                    repeating-radial-gradient(circle at center,
                      transparent 0px,
                      transparent 3px,
                      rgba(255, 255, 255, 0.045) 4px,
                      transparent 5.5px,
                      rgba(0, 0, 0, 0.4) 7px,
                      transparent 9px
                    )
                  `,
                  maskImage: 'radial-gradient(circle closest-side at center, transparent 53%, #000 55%, #000 63%, transparent 64%, #000 65%, #000 75%, transparent 76%, #000 77%, #000 87%, transparent 88%, #000 89%, #000 96%, transparent 97.5%)',
                  WebkitMaskImage: 'radial-gradient(circle closest-side at center, transparent 53%, #000 55%, #000 63%, transparent 64%, #000 65%, #000 75%, transparent 76%, #000 77%, #000 87%, transparent 88%, #000 89%, #000 96%, transparent 97.5%)',
                  pointerEvents: 'none'
                }}
              />

              {/* Subtle rotating PVC groove shimmer so motion is visible along the vinyl surface */}
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: '50%',
                  background: `
                    conic-gradient(
                      from 15deg at 50% 50%,
                      rgba(255, 255, 255, 0.05) 0deg,
                      transparent 28deg,
                      rgba(0, 0, 0, 0.22) 72deg,
                      rgba(255, 255, 255, 0.045) 115deg,
                      transparent 150deg,
                      rgba(255, 255, 255, 0.055) 195deg,
                      rgba(0, 0, 0, 0.2) 250deg,
                      rgba(255, 255, 255, 0.04) 305deg,
                      transparent 340deg,
                      rgba(255, 255, 255, 0.05) 360deg
                    )
                  `,
                  maskImage: 'radial-gradient(circle closest-side at center, transparent 44%, #000 47%, #000 97.5%, transparent 100%)',
                  WebkitMaskImage: 'radial-gradient(circle closest-side at center, transparent 44%, #000 47%, #000 97.5%, transparent 100%)',
                  pointerEvents: 'none'
                }}
              />

              {/* Precision vector track rills and rim catchlights */}
              <svg
                viewBox="0 0 200 200"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  pointerEvents: 'none'
                }}
                aria-hidden="true"
              >
                {/* Glossy track-divider rill edges */}
                <circle cx="100" cy="100" r="63.7" fill="none" stroke="rgba(255, 255, 255, 0.08)" strokeWidth="0.45" />
                <circle cx="100" cy="100" r="64.6" fill="none" stroke="rgba(0, 0, 0, 0.6)" strokeWidth="0.55" />
                <circle cx="100" cy="100" r="75.7" fill="none" stroke="rgba(255, 255, 255, 0.085)" strokeWidth="0.45" />
                <circle cx="100" cy="100" r="76.6" fill="none" stroke="rgba(0, 0, 0, 0.6)" strokeWidth="0.55" />
                <circle cx="100" cy="100" r="87.4" fill="none" stroke="rgba(255, 255, 255, 0.08)" strokeWidth="0.45" />
                <circle cx="100" cy="100" r="88.2" fill="none" stroke="rgba(0, 0, 0, 0.6)" strokeWidth="0.55" />
                {/* Lead-in outer bevel ring */}
                <circle cx="100" cy="100" r="96.6" fill="none" stroke="rgba(255, 255, 255, 0.1)" strokeWidth="0.45" />
                <circle cx="100" cy="100" r="98.6" fill="none" stroke="rgba(255, 255, 255, 0.12)" strokeWidth="0.4" />
              </svg>

              {/* Classic center record label featuring album cover + pressed stamper ring */}
              <div
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                  width: '44%',
                  height: '44%',
                  borderRadius: '50%',
                  overflow: 'hidden',
                  background: '#18181b',
                  boxShadow: '0 0 0 2px #09090b, 0 0 0 3.5px rgba(255, 255, 255, 0.15), inset 0 0 10px rgba(0, 0, 0, 0.65)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                {thumb ? (
                  <img
                    src={thumb}
                    alt={unitSong.title || 'Album Label'}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      display: 'block'
                    }}
                    onError={() => unitSong.id && handleImgError(unitSong.id)}
                  />
                ) : (
                  <Disc size="48%" style={{ color: 'var(--accent-color)', opacity: 0.9 }} />
                )}

                {/* Pressed paper stamper ring (classic circular ridge on LP labels) */}
                <div
                  style={{
                    position: 'absolute',
                    inset: '16%',
                    borderRadius: '50%',
                    border: '1px solid rgba(0, 0, 0, 0.35)',
                    boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.14), inset 0 1px 2px rgba(255, 255, 255, 0.12)',
                    pointerEvents: 'none'
                  }}
                />

                {/* Label inner rim */}
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: '50%',
                    boxShadow: 'inset 0 0 0 1.5px rgba(255, 255, 255, 0.22), inset 0 0 12px rgba(0, 0, 0, 0.32)',
                    pointerEvents: 'none'
                  }}
                />

                {/* Center Spindle Hole */}
                <div
                  style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: '14%',
                    height: '14%',
                    borderRadius: '50%',
                    background: '#060608',
                    border: '1.5px solid rgba(228, 228, 238, 0.72)',
                    boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 0.85)'
                  }}
                />
              </div>
            </div>

            {/* Stationary anisotropic bowtie light sheen across the vinyl grooves */}
            <div
              className="vinyl-reflection-sheen"
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                background: `
                  conic-gradient(
                    from 32deg at 50% 50%,
                    rgba(255, 255, 255, 0.02) 0deg,
                    rgba(255, 255, 255, 0.14) 14deg,
                    rgba(255, 255, 255, 0.24) 20deg,
                    rgba(255, 255, 255, 0.11) 28deg,
                    transparent 50deg,
                    transparent 150deg,
                    rgba(255, 255, 255, 0.03) 172deg,
                    rgba(255, 255, 255, 0.14) 192deg,
                    rgba(255, 255, 255, 0.22) 199deg,
                    rgba(255, 255, 255, 0.1) 208deg,
                    transparent 232deg,
                    transparent 340deg,
                    rgba(255, 255, 255, 0.02) 360deg
                  )
                `,
                maskImage: 'radial-gradient(circle closest-side at center, transparent 44%, rgba(0,0,0,0.45) 47%, #000 53%, #000 97%, rgba(0,0,0,0.6) 100%)',
                WebkitMaskImage: 'radial-gradient(circle closest-side at center, transparent 44%, rgba(0,0,0,0.45) 47%, #000 53%, #000 97%, rgba(0,0,0,0.6) 100%)',
                pointerEvents: 'none',
                mixBlendMode: 'screen'
              }}
            />
          </div>
        </div>

        {/* ── Vinyl Box / Album Jacket Sleeve (60% proportion when playing, centered when paused) ── */}
        <div
          className="vinyl-box-sleeve"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 2,
            borderRadius: '2.5%',
            overflow: 'hidden',
            background: '#121216',
            transform: slidOut ? 'translate3d(-33.3333%, 0, 0)' : 'translate3d(0%, 0, 0)',
            transition: 'transform 0.7s cubic-bezier(0.22, 1, 0.36, 1)',
            willChange: 'transform',
            boxShadow: '0 18px 46px rgba(0, 0, 0, 0.88), 0 4px 14px rgba(0, 0, 0, 0.65)',
            border: '1px solid rgba(255, 255, 255, 0.14)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          {thumb ? (
            <img
              src={thumb}
              alt={unitSong.title || 'Album Cover'}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block'
              }}
              onError={() => unitSong.id && handleImgError(unitSong.id)}
            />
          ) : (
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4cqh',
                padding: '8%',
                boxSizing: 'border-box',
                background: 'linear-gradient(145deg, #1b1c22 0%, #0e0e12 100%)',
                color: 'rgba(255, 255, 255, 0.8)'
              }}
            >
              <Disc size="32%" style={{ color: 'var(--accent-color)', opacity: 0.9 }} />
              <span
                style={{
                  fontSize: 'clamp(10px, 3.6cqh, 16px)',
                  fontWeight: 600,
                  maxWidth: '90%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  textAlign: 'center'
                }}
              >
                {unitSong.title || 'Hi-Fi Audio'}
              </span>
            </div>
          )}

          {/* Left Jacket Spine Crease for physical sleeve depth */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: '3.2%',
              width: '2px',
              background: 'linear-gradient(90deg, rgba(0, 0, 0, 0.45) 0%, rgba(255, 255, 255, 0.16) 100%)',
              pointerEvents: 'none'
            }}
          />

          {/* Subtle Diagonal Sleeve Laminate Sheen */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, transparent 42%, rgba(0, 0, 0, 0.16) 100%)',
              pointerEvents: 'none'
            }}
          />

          {/* Right Sleeve Opening Shadow Lip (signals vinyl emerges from inside the pocket) */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              right: 0,
              width: '5%',
              background: 'linear-gradient(90deg, transparent 0%, rgba(0, 0, 0, 0.45) 100%)',
              boxShadow: 'inset -1px 0 0 rgba(255, 255, 255, 0.14)',
              pointerEvents: 'none'
            }}
          />
        </div>
      </div>
    );
  };

  const stageBaseBackground = adaptivePalette
    ? `radial-gradient(ellipse 92% 88% at 50% 48%, rgba(${adaptivePalette.glow}, 0.96) 0%, rgba(${adaptivePalette.mid}, 0.98) 54%, rgb(${adaptivePalette.edge}) 100%)`
    : 'radial-gradient(ellipse 92% 88% at 50% 48%, #22232b 0%, #14151a 56%, #0b0b0e 100%)';

  return (
    <div
      className="vinyl-box-container"
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: 'inherit',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        isolation: 'isolate',
        transform: 'translateZ(0)',
        background: stageBaseBackground,
        transition: 'background 0.85s ease',
        userSelect: 'none',
        pointerEvents: 'none',
        containerType: 'size'
      }}
    >
      {/* Clipped backdrop layer stack so blurred / blended layers never bleed past rounded corners */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 'inherit',
          overflow: 'hidden',
          isolation: 'isolate',
          transform: 'translateZ(0)',
          pointerEvents: 'none'
        }}
      >
        {/* Outgoing blurred color wash during crossfade / song transition */}
        {outgoingBackdropThumb && outgoingBackdropThumb !== activeBackdropThumb && (
          <div
            key={`out-wash-${outgoingSong?.id || 'prev'}`}
            style={{
              position: 'absolute',
              inset: '-22%',
              backgroundImage: `url(${outgoingBackdropThumb})`,
              backgroundPosition: 'center',
              backgroundSize: 'cover',
              filter: 'blur(56px) saturate(1.85) brightness(0.78)',
              transform: 'scale(1.28)',
              animation: 'nadanada-backdrop-fade-out 0.75s ease forwards',
              pointerEvents: 'none'
            }}
          />
        )}

        {/* Primary adaptive blurred album color wash */}
        {activeBackdropThumb && (
          <div
            style={{
              position: 'absolute',
              inset: '-22%',
              backgroundImage: `url(${activeBackdropThumb})`,
              backgroundPosition: 'center',
              backgroundSize: 'cover',
              filter: adaptivePalette?.isDarkCover
                ? 'blur(54px) saturate(2) brightness(0.95)'
                : 'blur(56px) saturate(1.85) brightness(0.76)',
              transform: 'scale(1.28)',
              opacity: 0.82,
              transition: 'background-image 0.6s ease, opacity 0.6s ease, filter 0.6s ease',
              pointerEvents: 'none'
            }}
          />
        )}

        {/* Secondary highlight-lift bloom (pulls accent tones out of dark album covers) */}
        {activeBackdropThumb && (
          <div
            style={{
              position: 'absolute',
              inset: '-24%',
              backgroundImage: `url(${activeBackdropThumb})`,
              backgroundPosition: 'center',
              backgroundSize: 'cover',
              filter: 'blur(78px) saturate(2.2) contrast(1.4) brightness(0.92)',
              transform: 'scale(1.38) rotate(8deg)',
              opacity: adaptivePalette ? (adaptivePalette.isDarkCover ? 0.68 : 0.38) : 0.56,
              mixBlendMode: 'screen',
              transition: 'opacity 0.6s ease',
              pointerEvents: 'none'
            }}
          />
        )}

        {/* Soft edge framing vignette (preserves album color scheme without crushing to black) */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'radial-gradient(ellipse 90% 86% at center, rgba(0, 0, 0, 0.04) 38%, rgba(0, 0, 0, 0.38) 100%)',
            pointerEvents: 'none'
          }}
        />
      </div>

      {/* Stage for active, outgoing, and incoming vinyl boxes */}
      <div
        className="vinyl-box-stage"
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2
        }}
      >
        {transitionPhase === 'swapping' ? (
          <>
            {outgoingSong && (
              <div
                key={`box-out-${outgoingSong.id}`}
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  animation: `${
                    transitionDirection === 'backward'
                      ? 'nadanada-vinylbox-out-backward'
                      : 'nadanada-vinylbox-out-forward'
                  } 0.78s cubic-bezier(0.25, 1, 0.5, 1) forwards`,
                  willChange: 'transform, opacity',
                  zIndex: 1
                }}
              >
                {renderBoxUnit(outgoingSong, outgoingSlidOut, false, `out-${outgoingSong.id}`)}
              </div>
            )}

            {incomingSong && (
              <div
                key={`box-in-${incomingSong.id}`}
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  animation: `${
                    transitionDirection === 'backward'
                      ? 'nadanada-vinylbox-in-backward'
                      : 'nadanada-vinylbox-in-forward'
                  } 0.82s cubic-bezier(0.25, 1, 0.5, 1) forwards`,
                  willChange: 'transform, opacity',
                  zIndex: 2
                }}
              >
                {renderBoxUnit(incomingSong, incomingSlidOut, false, `in-${incomingSong.id}`)}
              </div>
            )}
          </>
        ) : (
          displayedSong && renderBoxUnit(displayedSong, isPlaying, true, `active-${displayedSong.id}`)
        )}
      </div>

      {/* Subtext Pill (e.g., Playing Offline / Audio Stream Fallback) */}
      {subtext && (
        <div
          style={{
            position: 'absolute',
            bottom: 'clamp(6px, 2.2cqh, 14px)',
            background: 'rgba(0, 0, 0, 0.72)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255, 255, 255, 0.14)',
            borderRadius: '12px',
            padding: 'clamp(2px, 0.6cqh, 4px) clamp(8px, 2cqh, 12px)',
            color: 'rgba(255, 255, 255, 0.82)',
            fontSize: 'clamp(9px, 2.2cqh, 12px)',
            letterSpacing: '0.4px',
            pointerEvents: 'none',
            zIndex: 10
          }}
        >
          {subtext}
        </div>
      )}
    </div>
  );
}
