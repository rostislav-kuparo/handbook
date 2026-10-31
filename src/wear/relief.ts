// The sheet is not flat: creases where the hand dragged it while writing, and
// the dents of the compasses' needle. One height field gives both what the
// light does on them and how far the printing and the ink move in the photo,
// so the two always agree.
import { MM, type SheetSize } from '../editor/page';
import { rng, type Rand } from '../sketch/pen';
import type { Vec } from '../sketch/types';
import { mergedPivots, type WearSettings } from './wear';

/** The height field's cell, mm: creases are a few millimetres wide, so this is fine enough. */
const CELL = 0.5;
/** Largest shift of the ink and the printing a crease makes in the photo, mm (what the shift texture holds). */
export const MAX_SHIFT = 1;
/** Pixels per sheet px of the light's picture (fine enough for the needle's dents). */
export const SHADE_SCALE = 2;

/** One crease: a slightly bowed band from an edge into the sheet, highest at the edge, fading inwards. */
interface Fold {
  pts: Vec[];
  /** mm; above zero a ridge, below a trough. */
  height: number;
  /** Half its width across, mm. */
  half: number;
  sharp: boolean;
  /** Where it reaches, mm: x0, y0, x1, y1. */
  box: [number, number, number, number];
}

export interface Relief {
  /** Coarse: R, G — the shift (0.5 ± shift / 2·MAX_SHIFT), B — the height (0.5 ± h / 2 mm). */
  shift: HTMLCanvasElement;
  /** Fine: the light on the sheet, grey 128 = as it was (value / 127.5 is the factor). */
  shade: HTMLCanvasElement;
  /** Nothing to show: a flat sheet. */
  flat: boolean;
}

const mix = (a: number, b: number) => Math.imul(a ^ b, 16777619) >>> 0;

/** Where the hand drags the sheet: creases start mostly at the edge under the hand (bottom and right for a right hand). */
function foldsOf(wMm: number, hMm: number, w: WearSettings, r: Rand): Fold[] {
  if (w.folds <= 0) return [];
  const n = Math.max(1, Math.round((1 + 3 * r()) * w.folds * 0.75));
  const out: Fold[] = [];
  for (let i = 0; i < n; i++) {
    // An edge: under the hand (bottom, then the writing side) more often than the others.
    const e = r();
    const side = e < 0.4 ? 'bottom' : e < 0.7 ? (w.hand === 'right' ? 'right' : 'left') : e < 0.85 ? 'top' : w.hand === 'right' ? 'left' : 'right';
    const t = 0.1 + 0.8 * r();
    const start: Vec =
      side === 'bottom' ? { x: t * wMm, y: hMm } : side === 'top' ? { x: t * wMm, y: 0 } : side === 'right' ? { x: wMm, y: t * hMm } : { x: 0, y: t * hMm };
    const inward = side === 'bottom' ? -Math.PI / 2 : side === 'top' ? Math.PI / 2 : side === 'right' ? Math.PI : 0;
    // 20–60° off the edge, either way.
    const off = ((20 + 40 * r()) * Math.PI) / 180;
    const ang = inward + (r() < 0.5 ? -1 : 1) * (Math.PI / 2 - off);
    const len = 40 + 160 * r();
    const end = { x: start.x + Math.cos(ang) * len, y: start.y + Math.sin(ang) * len };
    const bow = (r() - 0.5) * 0.2 * len;
    const mid = { x: (start.x + end.x) / 2 - Math.sin(ang) * bow, y: (start.y + end.y) / 2 + Math.cos(ang) * bow };
    const pts: Vec[] = [];
    for (let k = 0; k <= 32; k++) {
      const s = k / 32;
      pts.push({
        x: (1 - s) ** 2 * start.x + 2 * (1 - s) * s * mid.x + s * s * end.x,
        y: (1 - s) ** 2 * start.y + 2 * (1 - s) * s * mid.y + s * s * end.y,
      });
    }
    const sharp = w.sharp && r() < 0.35;
    const half = sharp ? 0.8 + 0.7 * r() : (6 + 14 * r()) / 2;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const m = half * 3;
    out.push({
      pts,
      height: (r() < 0.6 ? 1 : -1) * (sharp ? 0.2 + 0.3 * r() : 0.3 + 0.7 * r()) * Math.min(w.folds, 1.6),
      half,
      sharp,
      box: [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m],
    });
  }
  return out;
}

/** Height of the sheet at (x, y) mm from its creases. */
function heightAt(folds: Fold[], x: number, y: number): number {
  let h = 0;
  for (const f of folds) {
    if (x < f.box[0] || y < f.box[1] || x > f.box[2] || y > f.box[3]) continue;
    // Nearest point of the crease and how far along it (0 at its edge end).
    let best = Infinity;
    let along = 0;
    let at = 0;
    for (let i = 1; i < f.pts.length; i++) {
      const a = f.pts[i - 1];
      const b = f.pts[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / l2));
      const d = Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
      const l = Math.sqrt(l2);
      if (d < best) {
        best = d;
        along = at + t * l;
      }
      at += l;
    }
    if (best > f.half * 3) continue;
    const u = along / at;
    // Highest at the edge, gone at the inner end; the ends of the band rounded.
    const fade = Math.pow(1 - u, 0.8) * Math.min(1, u * 12 + 0.4);
    const across = f.sharp ? Math.max(0, 1 - best / f.half) : Math.exp(-((best / f.half) ** 2));
    h += f.height * fade * across;
  }
  return h;
}

/**
 * The relief of a sheet (`size` px) from its seed: creases, and the needle's
 * dents at `pivots`. `light`: where the light comes from on the sheet (y down).
 * A photo sees a raised point moved away from its centre (and a little down:
 * phones look at a desk from the writer's side).
 */
export function reliefOf(size: SheetSize, w: WearSettings, seed: number, pivots: Vec[], light: Vec = { x: -0.6, y: -0.8 }): Relief {
  const wMm = size.w / MM;
  const hMm = size.h / MM;
  const r = rng(mix(seed, mix(w.seed, 0xf01d)));
  const folds = w.on && w.show.folds ? foldsOf(wMm, hMm, w, r) : [];
  const nx = Math.ceil(wMm / CELL) + 1;
  const ny = Math.ceil(hMm / CELL) + 1;
  const hf = new Float32Array(nx * ny);
  if (folds.length) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) hf[j * nx + i] = heightAt(folds, i * CELL, j * CELL);
  const ll = Math.hypot(light.x, light.y) || 1;
  const L = { x: light.x / ll, y: light.y / ll };

  // The shift and the height, coarse (the GPU smooths it).
  const shift = document.createElement('canvas');
  shift.width = nx;
  shift.height = ny;
  const sd = new ImageData(nx, ny);
  // The light on the creases at the same cells.
  const light8 = new ImageData(nx, ny);
  const cx = wMm / 2;
  const cy = hMm / 2;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const h = hf[k];
      const hx = (hf[j * nx + Math.min(nx - 1, i + 1)] - hf[j * nx + Math.max(0, i - 1)]) / (2 * CELL);
      const hy = (hf[Math.min(ny - 1, j + 1) * nx + i] - hf[Math.max(0, j - 1) * nx + i]) / (2 * CELL);
      // Seen from about 35 cm above the middle, a little from below.
      const dx = h * ((i * CELL - cx) / 350);
      const dy = h * ((j * CELL - cy) / 350 + 0.12);
      sd.data[k * 4] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + dx / (2 * MAX_SHIFT))));
      sd.data[k * 4 + 1] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + dy / (2 * MAX_SHIFT))));
      sd.data[k * 4 + 2] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + h / 2)));
      sd.data[k * 4 + 3] = 255;
      // A slope towards the light is brighter: about 12 % per 0.1 of slope, no more than ±22 %.
      const s = Math.min(1.22, Math.max(0.78, 1 - 1.2 * (hx * L.x + hy * L.y)));
      const g = Math.round(127.5 * s);
      light8.data.set([g, g, g, 255], k * 4);
    }
  }
  shift.getContext('2d')!.putImageData(sd, 0, 0);

  // The light, fine: the creases' light smoothed up, then the needle's dents on top.
  const coarse = document.createElement('canvas');
  coarse.width = nx;
  coarse.height = ny;
  coarse.getContext('2d')!.putImageData(light8, 0, 0);
  const shade = document.createElement('canvas');
  shade.width = Math.max(1, Math.round(size.w * SHADE_SCALE));
  shade.height = Math.max(1, Math.round(size.h * SHADE_SCALE));
  const ctx = shade.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(coarse, 0, 0, (nx * CELL * MM * shade.width) / size.w, (ny * CELL * MM * shade.height) / size.h);
  const holes = w.on && w.show.wear && w.holes ? mergedPivots(pivots) : [];
  if (holes.length) {
    ctx.scale(SHADE_SCALE, SHADE_SCALE);
    const hr = rng(mix(seed, mix(w.seed, 0x401e)));
    for (const { p, n } of holes) {
      // The far wall of the dent faces the light: lit; the near one in shadow.
      const rc = (0.4 + 0.4 * hr()) * MM * w.depth * (1 + 0.12 * Math.min(n - 1, 4));
      const k = Math.min(2, w.depth * (1 + 0.15 * (n - 1)));
      const lit = { x: p.x - L.x * rc * 0.4, y: p.y - L.y * rc * 0.4 };
      const g = ctx.createRadialGradient(lit.x, lit.y, 0, lit.x, lit.y, rc * 0.7);
      g.addColorStop(0, `rgba(255,255,255,${(0.12 * k).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(p.x - rc, p.y - rc, 2 * rc, 2 * rc);
    }
  }
  return { shift, shade, flat: !folds.length && !holes.length };
}

/** The light of the relief as a see-through picture over a sheet: dark where it is darker, white where lighter. */
export function shadeOverlay(relief: Relief): HTMLCanvasElement {
  const src = relief.shade;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  if (relief.flat) return out;
  const data = src.getContext('2d')!.getImageData(0, 0, src.width, src.height);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const s = d[i] / 127.5;
    if (s < 1) {
      d[i] = d[i + 1] = d[i + 2] = 0;
      d[i + 3] = Math.round(255 * Math.min(1, 1 - s));
    } else {
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.round(255 * Math.min(1, (s - 1) * 1.5));
    }
  }
  out.getContext('2d')!.putImageData(data, 0, 0);
  return out;
}
