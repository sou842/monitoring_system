'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

/** Canvas size in pixels: tiny on purpose, the browser scales it up into a smooth blur. */
const SIZE = 48;
/** How long the colours take to glide to their next places. */
const SHIFT_MS = 520;
/** Where the four colour points sit (0..1), stepping one place per shift. Chosen for this wallpaper. */
const SPOTS: ReadonlyArray<readonly [number, number]> = [
  [0.82, 0.08], [0.62, 0.32], [0.88, 0.72], [0.62, 0.92], [0.18, 0.92], [0.38, 0.68], [0.12, 0.28], [0.38, 0.08],
];
/** Point i starts at spot i*2, so the four are spread around. */
const START = [0, 2, 4, 6];
/** How sharply each colour fades with distance (higher = more distinct patches). */
const FALLOFF = 2.6;

type RGB = [number, number, number];

function parseColor(value: string): RGB {
  const v = value.trim();
  if (v.startsWith('#')) {
    const hex = v.length === 4 ? v.slice(1).split('').map((c) => c + c).join('') : v.slice(1, 7);
    const n = Number.parseInt(hex, 16);
    if (!Number.isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = v.match(/\d+(\.\d+)?/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [200, 210, 190];
}

const ease = (t: number) => 1 - (1 - t) ** 3;

/** Lets the chat nudge the wallpaper (it shifts a little each time you send). */
export interface WallpaperHandle { shift: () => void }

/**
 * The conversation background: a four-colour gradient whose colours drift to new places on every shift,
 * under a repeating doodle pattern (CSS, chat.css `.tg-wall::after`). Colours come from the `--tg-wall-*`
 * tokens, so the light and dark themes each have their own; a theme change redraws it.
 */
export const Wallpaper = forwardRef<WallpaperHandle>(function Wallpaper(_, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const step = useRef(0);
  const frame = useRef(0);
  const colors = useRef<RGB[]>([]);
  const painter = useRef<{ draw: (points: Array<[number, number]>) => void; pointsAt: (s: number) => Array<[number, number]> } | null>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const image = ctx.createImageData(SIZE, SIZE);

    const readColors = () => {
      const style = getComputedStyle(el);
      colors.current = [1, 2, 3, 4].map((i) => parseColor(style.getPropertyValue(`--tg-wall-${i}`)));
    };
    const draw = (points: Array<[number, number]>) => {
      const cs = colors.current;
      const data = image.data;
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const px = x / (SIZE - 1);
          const py = y / (SIZE - 1);
          let r = 0, g = 0, b = 0, total = 0;
          for (let i = 0; i < 4; i++) {
            const dx = px - points[i][0];
            const dy = py - points[i][1];
            const w = 1 / Math.max(1e-4, Math.sqrt(dx * dx + dy * dy)) ** FALLOFF;
            r += cs[i][0] * w; g += cs[i][1] * w; b += cs[i][2] * w; total += w;
          }
          const o = (y * SIZE + x) * 4;
          data[o] = r / total; data[o + 1] = g / total; data[o + 2] = b / total; data[o + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, 0);
    };
    const pointsAt = (s: number) => START.map((start) => [...SPOTS[(start + s) % SPOTS.length]] as [number, number]);

    readColors();
    draw(pointsAt(step.current));
    painter.current = { draw, pointsAt };

    // The theme lives on <html data-theme>; redraw with the other colours when it changes.
    const observer = new MutationObserver(() => { readColors(); draw(pointsAt(step.current)); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current); painter.current = null; };
  }, []);

  useImperativeHandle(ref, () => ({
    shift() {
      const p = painter.current;
      if (!p) return;
      const { draw, pointsAt } = p;
      const from = pointsAt(step.current);
      step.current = (step.current + 1) % SPOTS.length;
      const to = pointsAt(step.current);
      cancelAnimationFrame(frame.current);
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { draw(to); return; }
      const started = performance.now();
      const tick = (now: number) => {
        const t = ease(Math.min(1, (now - started) / SHIFT_MS));
        draw(from.map((a, i) => [a[0] + (to[i][0] - a[0]) * t, a[1] + (to[i][1] - a[1]) * t]));
        if (t < 1) frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    },
  }), []);

  return (
    <div className="tg-wall" aria-hidden="true">
      <canvas ref={canvas} width={SIZE} height={SIZE} />
    </div>
  );
});
