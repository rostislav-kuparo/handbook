// Points of a blank a click means: the centre of a printed point (a small
// circle or dot), where lines cross or meet at a corner, where a line ends.
// Looked for on the blank's own picture, near the click.
import { MM, type SheetSize } from '../editor/page';
import { blankRect, lum, pixels, tonerOf, type Blank } from './blank';

export type SnapKind = 'circle' | 'dot' | 'cross' | 'end' | 'free';

/** A point on the sheet, sheet px, and what it is. */
export interface SnapPoint {
  x: number;
  y: number;
  kind: SnapKind;
}

export interface Dark {
  w: number;
  h: number;
  /** 1 where the blank is printed. */
  on: Uint8Array;
}

const darks = new Map<string, Promise<Dark>>();

/** Where the blank is printed, at the size it is processed (cached). */
export function darkOf(b: Blank): Promise<Dark> {
  const key = `${b.id}|${b.white}`;
  let hit = darks.get(key);
  if (!hit) {
    hit = pixels(b.image).then(({ data, w, h }) => {
      const on = new Uint8Array(w * h);
      for (let i = 0; i < on.length; i++) on[i] = tonerOf(lum(data, i * 4), b.white) < 0.55 ? 1 : 0;
      return { w, h, on };
    });
    darks.set(key, hit);
    hit.catch(() => darks.delete(key));
  }
  return hit;
}

/** A connected blot of the printing: its box (processing px, inclusive) and how many pixels it has. */
export interface Blob {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  n: number;
}

/** Every connected blot of the printing (letters, digits, circles of points, whole drawings). */
export function forEachBlob(d: Dark, visit: (b: Blob) => void) {
  const seen = new Uint8Array(d.w * d.h);
  const stack: number[] = [];
  for (let start = 0; start < seen.length; start++) {
    if (seen[start] || !d.on[start]) continue;
    let [x0, y0, x1, y1, n] = [d.w, d.h, 0, 0, 0];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % d.w;
      const y = (i - x) / d.w;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      n++;
      for (const j of [i - 1, i + 1, i - d.w, i + d.w]) {
        if (j < 0 || j >= seen.length || seen[j] || !d.on[j] || Math.abs((j % d.w) - x) > 1) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    visit({ x0, y0, x1, y1, n });
  }
}

/** How far from the click a point is looked for, mm. */
const REACH = 2;
/** A found point beats a nearer one of a weaker kind by this much, mm. */
const BONUS: Record<SnapKind, number> = { circle: 1.2, dot: 1.2, cross: 0.7, end: 0.4, free: 0 };

/** Finds what a click at (sx, sy) on a sheet of size `sheet` (sheet px) means on blank `b`. */
export type Snap = (sx: number, sy: number, sheet: SheetSize) => SnapPoint;

export async function snapper(b: Blank): Promise<Snap> {
  const d = await darkOf(b);
  const D = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < d.w && yi < d.h && d.on[yi * d.w + xi] === 1;
  };
  const ring = (cx: number, cy: number, r: number, n: number) => {
    const out: boolean[] = [];
    for (let j = 0; j < n; j++) {
      const a = (2 * Math.PI * j) / n;
      out.push(D(cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }
    return out;
  };
  const share = (v: boolean[], want: boolean) => v.filter((x) => x === want).length / v.length;

  return (sx, sy, sheet) => {
    const r0 = blankRect(b, sheet);
    const k = d.w / r0.w;
    const pmm = MM * k;
    const px = (sx - r0.x) * k;
    const py = (sy - r0.y) * k;
    const toSheet = (x: number, y: number, kind: SnapKind): SnapPoint => ({ x: x / k + r0.x, y: y / k + r0.y, kind });
    const reach = REACH * pmm;
    const found: { x: number; y: number; kind: SnapKind; score: number }[] = [];
    const x0 = Math.floor(px - reach);
    const x1 = Math.ceil(px + reach);
    const y0 = Math.floor(py - reach);
    const y1 = Math.ceil(py + reach);
    const step = Math.max(1, Math.round(pmm / 8));

    // Printed points: a ring of ink round light (a small circle), or a dot of ink round which it is light.
    const radii: number[] = [];
    for (let r = Math.max(1.8, 0.25 * pmm); r <= 1.4 * pmm; r += Math.max(0.7, 0.1 * pmm)) radii.push(r);
    for (let cy = y0; cy <= y1; cy += step) {
      for (let cx = x0; cx <= x1; cx += step) {
        if ((cx - px) ** 2 + (cy - py) ** 2 > reach * reach) continue;
        const centre = D(cx, cy);
        for (const r of radii) {
          if (!centre) {
            // The ring may be a pixel off the sampled circle; most places are no ring at all (eight looks tell).
            const onRing = (n: number) => {
              const [a, b, c] = [ring(cx, cy, r, n), ring(cx, cy, r - 0.8, n), ring(cx, cy, r + 0.8, n)];
              return share(a.map((v, j) => v || b[j] || c[j]), true);
            };
            if (onRing(8) < 0.7) continue;
            const s = onRing(24);
            // Light inside: round the centre, or (a circle of a few pixels) the centre alone.
            const inner = r - 1.6;
            const light = inner < 0.8 ? !D(cx + 0.5, cy) || !D(cx, cy + 0.5) : share(ring(cx, cy, inner, 8), false) >= 0.85;
            if (s >= 0.8 && light) found.push({ x: cx, y: cy, kind: 'circle', score: s });
          } else if (r <= pmm) {
            const inner = Math.max(1.5, 0.25 * pmm);
            if (r <= inner + 1) continue;
            if (share(ring(cx, cy, inner, 8), true) === 1 && share(ring(cx, cy, r, 24), false) >= 0.75) found.push({ x: cx, y: cy, kind: 'dot', score: 1 });
          }
        }
      }
    }

    // Lines: around a point on one, how many arms of ink leave it — one at an end, three or more where lines
    // cross, two at an angle where they meet at a corner.
    const rho = Math.max(4, 0.9 * pmm);
    const n = 40;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!D(x, y) || (x - px) ** 2 + (y - py) ** 2 > reach * reach) continue;
        const v = ring(x, y, rho, n);
        // The arms: runs of ink round the ring, by their middle angle.
        const arms: number[] = [];
        const start = v.findIndex((on, j) => !on && v[(j + 1) % n]);
        if (start < 0) continue;
        for (let j = 1, run = -1; j <= n; j++) {
          const i = (start + j) % n;
          if (v[i] && run < 0) run = j;
          if (!v[i] && run >= 0) {
            arms.push(((2 * Math.PI) / n) * (start + (run + j - 1) / 2));
            run = -1;
          }
        }
        if (arms.length === 1) {
          // The very end: just behind it, no ink.
          const back = arms[0] + Math.PI;
          if (!D(x + 1.6 * Math.cos(back), y + 1.6 * Math.sin(back))) found.push({ x, y, kind: 'end', score: 1 });
        } else if (arms.length >= 3) {
          found.push({ x, y, kind: 'cross', score: 1 });
        } else if (arms.length === 2) {
          // How far the two arms are from going straight on (a straight line: opposite arms).
          const apart = (((arms[1] - arms[0]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          const turn = Math.abs(apart - Math.PI);
          if (turn > 0.5) found.push({ x, y, kind: 'cross', score: 1 });
        }
      }
    }
    // Lines leaving a printed point look like crossings round it: the point is what is meant.
    const points = found.filter((f) => f.kind === 'circle' || f.kind === 'dot');
    const kept = found.filter((f) => (f.kind !== 'cross' && f.kind !== 'end') || !points.some((q) => Math.hypot(f.x - q.x, f.y - q.y) < 1.6 * pmm));
    if (!kept.length) return { x: sx, y: sy, kind: 'free' };

    // The best: the nearest, the stronger kinds counted nearer.
    const cost = (f: (typeof kept)[number]) => Math.hypot(f.x - px, f.y - py) / pmm - BONUS[f.kind] - (f.score - 0.8);
    let best = kept.reduce((a, f) => (cost(f) < cost(a) ? f : a));
    if (best.kind === 'cross') {
      // Along each line near a crossing more than two arms show too; the crossing itself has the most ink round it.
      const disc = Math.max(2, 0.3 * pmm);
      const ink = (x: number, y: number) => {
        let n = 0;
        for (let dy = -Math.ceil(disc); dy <= disc; dy++) for (let dx = -Math.ceil(disc); dx <= disc; dx++) if (dx * dx + dy * dy <= disc * disc && D(x + dx, y + dy)) n++;
        return n;
      };
      const cluster = kept.filter((f) => f.kind === 'cross' && Math.hypot(f.x - best.x, f.y - best.y) <= 1.2 * pmm).map((f) => ({ ...f, score: ink(f.x, f.y) }));
      best = cluster.reduce((a, f) => (f.score > a.score ? f : a));
      const top = cluster.filter((f) => f.score === best.score);
      return toSheet(top.reduce((t, f) => t + f.x, 0) / top.length, top.reduce((t, f) => t + f.y, 0) / top.length, 'cross');
    }
    // Then the middle of its own cluster.
    const near = kept.filter((f) => f.kind === best.kind && Math.hypot(f.x - best.x, f.y - best.y) <= 0.45 * pmm && f.score >= best.score - 0.05);
    const cx = near.reduce((s, f) => s + f.x, 0) / near.length;
    const cy = near.reduce((s, f) => s + f.y, 0) / near.length;
    return toSheet(cx, cy, best.kind);
  };
}
