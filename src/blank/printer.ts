// An ordinary office printer, not a perfect one: its black is a dark grey,
// edges soften and thin lines thicken, the density wanders — streaks along
// the feed from a worn drum, faint banding across, blotches, one side paler —
// the toner is grainy, a few specks land on the white, and sometimes the page
// shows a faint ghost of itself one drum turn further down. The same numbers
// drive the GPU (the photo) and the canvas (the sheets on screen and in files).
import { rng } from '../sketch/pen';
import type { PrinterKind } from '../wear/wear';

export interface PrinterLook {
  /** What solid toner still sends back of the light (linear), per channel: a dark grey, a little warm or cool. */
  tone: [number, number, number];
  /** Softening of the edges, mm. */
  gain: number;
  /** Streaks along the feed: centre and half width (shares of the page's width) and how much paler (below 0: darker). */
  bands: [number, number, number][];
  /** Banding across the feed: amount and period, mm. */
  banding: [number, number];
  /** Slow blotches of density, ±. */
  blotch: number;
  /** One side paler by this much: the left (−) or the right (+) one. */
  fade: number;
  /** Grain of the toner, ±. */
  grain: number;
  /** Specks of toner on the white, per cm² (more near the printing). */
  specks: number;
  /** A ghost of the page one drum turn down: how strong, and how far, mm. */
  ghost: [number, number];
  /** Raggedness of the edges. */
  rag: number;
  /** Seeds the noise. */
  seed: number;
}

const PRESETS: Record<PrinterKind, { tone: number; gain: number; bands: [number, number]; band: number; banding: number; blotch: number; fade: number; grain: number; specks: number; ghost: [number, number]; rag: number }> = {
  new: { tone: 0.07, gain: 0.05, bands: [0, 1], band: 0.06, banding: 0.015, blotch: 0.03, fade: 0.03, grain: 0.1, specks: 0.15, ghost: [0, 0.015], rag: 0.02 },
  usual: { tone: 0.14, gain: 0.08, bands: [1, 2], band: 0.13, banding: 0.035, blotch: 0.07, fade: 0.08, grain: 0.2, specks: 0.5, ghost: [0.3, 0.025], rag: 0.035 },
  tired: { tone: 0.21, gain: 0.11, bands: [2, 3], band: 0.22, banding: 0.06, blotch: 0.1, fade: 0.15, grain: 0.3, specks: 1.2, ghost: [0.5, 0.035], rag: 0.05 },
};

/** The printer of this kind and seed: the same seed, the same streaks and ghost. */
export function printerLook(kind: PrinterKind, seed: number): PrinterLook {
  const p = PRESETS[kind];
  const r = rng(Math.imul(seed + 7, 0x2c1b3c6d) >>> 0);
  const tint = (r() - 0.5) * 0.03;
  const t = p.tone * (0.85 + 0.3 * r());
  const nb = p.bands[0] + Math.floor(r() * (p.bands[1] - p.bands[0] + 1));
  const bands: [number, number, number][] = [];
  for (let i = 0; i < nb; i++) bands.push([0.05 + 0.9 * r(), (2.5 + 12.5 * r()) / 210, p.band * (0.5 + 0.5 * r()) * (r() < 0.8 ? 1 : -0.6)]);
  return {
    tone: [t * (1 + tint), t, t * (1 - tint)],
    gain: p.gain,
    bands,
    banding: [p.banding, 1 + 3 * r()],
    blotch: p.blotch,
    fade: p.fade * (r() < 0.5 ? -1 : 1),
    grain: p.grain,
    specks: p.specks,
    ghost: [r() < p.ghost[0] ? p.ghost[1] : 0, 75 + 20 * r()],
    rag: p.rag,
    seed: Math.floor(r() * 9973),
  };
}

// Smooth value noise, the same as the shader's (so a sheet looks alike on screen and in the photo, roughly).
const hash = (x: number, y: number, s: number) => {
  let h = Math.imul(x + 65536, 1973) ^ Math.imul(y + 65536 + s, 9277);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
};
function vnoise(x: number, y: number, s: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(i, j, s);
  const b = hash(i + 1, j, s);
  const c = hash(i, j + 1, s);
  const d = hash(i + 1, j + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** How dense the toner lies at (x, y) mm on a page `wMm` wide (1: as meant). */
export function densityAt(p: PrinterLook, x: number, y: number, wMm: number): number {
  const u = x / wMm;
  let d = 1;
  for (const [c, half, amp] of p.bands) d -= amp * Math.exp(-(((u - c) / half) ** 2));
  d += p.banding[0] * Math.sin((2 * Math.PI * y) / p.banding[1]);
  d += p.blotch * (vnoise(x / 40, y / 40, p.seed) * 2 - 1);
  d -= Math.abs(p.fade) * (p.fade > 0 ? u : 1 - u);
  return Math.min(1.2, Math.max(0.3, d));
}

const pictures = new Map<string, Promise<string>>();

/**
 * A blank's picture (its white is the paper's) as this printer prints it, at
 * most `maxSide` px: a JPEG data URL, for the sheets on screen and in files.
 * `widthMm`: how wide the picture is on the sheet.
 */
export function printedPicture(url: string, widthMm: number, look: PrinterLook, maxSide = 2400): Promise<string> {
  const key = `${url.length}|${url.slice(-64)}|${widthMm}|${JSON.stringify(look)}|${maxSide}`;
  let hit = pictures.get(key);
  if (!hit) {
    hit = print(url, widthMm, look, maxSide);
    pictures.set(key, hit);
    hit.catch(() => pictures.delete(key));
    if (pictures.size > 6) pictures.delete(pictures.keys().next().value!);
  }
  return hit;
}

async function print(url: string, widthMm: number, p: PrinterLook, maxSide: number): Promise<string> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const pxMm = w / widthMm;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const sharp = ctx.getImageData(0, 0, w, h);
  // The toner's spread: the same picture softened.
  ctx.filter = `blur(${Math.max(0.3, p.gain * pxMm).toFixed(2)}px)`;
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = 'none';
  const soft = ctx.getImageData(0, 0, w, h).data;
  const s = sharp.data;
  const out = new ImageData(w, h);
  const o = out.data;
  const ghostPx = Math.round(p.ghost[1] * pxMm);
  const cov = (d: Uint8ClampedArray, i: number) => 1 - (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < h; y++) {
    const ym = y / pxMm;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const xm = x / pxMm;
      const a = cov(s, i);
      const as = cov(soft, i);
      let c = a;
      if (a > 0.004 || as > 0.004) {
        const n = vnoise(xm / 0.04, ym / 0.04, p.seed + 3);
        c = Math.min(1, Math.max(0, a + (smooth(0.12 + p.rag * (n - 0.5) * 4, 0.72, as) - a) * 0.65));
        c *= densityAt(p, xm, ym, widthMm) * (1 + p.grain * (vnoise(xm / 0.08, ym / 0.08, p.seed + 11) * 2 - 1) * 0.5);
      }
      if (ghostPx > 0 && y >= ghostPx) c = Math.max(c, cov(s, i - ghostPx * w * 4) * p.ghost[0]);
      c = Math.min(1, c);
      // Where the toner lies the picture's colour, its black only as dark as the toner goes.
      const f = a > 0.004 ? c / a : c;
      for (let ch = 0; ch < 3; ch++) {
        const orig = a > 0.004 ? 255 - s[i + ch] : 255;
        o[i + ch] = Math.round(255 - Math.min(255, orig * f) * (1 - p.tone[ch] ** (1 / 2.2)));
      }
      o[i + 3] = 255;
    }
  }
  // Specks on the white.
  const r = rng(p.seed + 101);
  const specks = Math.round((p.specks * (widthMm * (h / pxMm))) / 100);
  for (let k2 = 0; k2 < specks; k2++) {
    const x = Math.floor(r() * w);
    const y = Math.floor(r() * h);
    const rad = Math.max(0.5, (0.025 + 0.075 * r()) * pxMm);
    const v = Math.round(255 * (0.35 + 0.4 * r()));
    for (let dy = -Math.ceil(rad); dy <= Math.ceil(rad); dy++) {
      for (let dx = -Math.ceil(rad); dx <= Math.ceil(rad); dx++) {
        if (dx * dx + dy * dy > rad * rad || x + dx < 0 || y + dy < 0 || x + dx >= w || y + dy >= h) continue;
        const i = ((y + dy) * w + x + dx) * 4;
        for (let ch = 0; ch < 3; ch++) o[i + ch] = Math.min(o[i + ch], v);
      }
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.92);
}
