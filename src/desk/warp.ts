// Where a point of the sheet lies in the photo — the same model as
// crates/desk-core/src/warp.rs: the flat sheet's perspective, the bow of its
// curved sides spread over it (a Coons patch), and a grid of corrections.
import { apply, homography, type Mat3, type Pt } from './homography';

/** Corrections at grid nodes, photo px; nodes row by row, `nx` across, `ny` down. */
export interface Grid {
  nx: number;
  ny: number;
  d: Pt[];
}

export interface Warp {
  /** Top-left, top-right, bottom-right, bottom-left, clockwise on screen. */
  corners: Pt[];
  /** Bow of each side (top, right, bottom, left) from its chord: cubic in the fraction along it, photo px outward. */
  bulge?: number[][] | null;
  grid?: Grid | null;
}

export const GRID_NX = 5;
export const GRID_NY = 7;

export const zeroGrid = (nx = GRID_NX, ny = GRID_NY): Grid => ({ nx, ny, d: Array.from({ length: nx * ny }, () => [0, 0] as Pt) });

export const poly = (c: number[], t: number) => c[0] + t * (c[1] + t * (c[2] + t * c[3]));

const catmullRom = (t: number) => {
  const [t2, t3] = [t * t, t * t * t];
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
};

/** Catmull-Rom interpolation of the grid (passes through its nodes). */
export function gridAt(g: Grid, u: number, v: number): Pt {
  const axis = (t: number, n: number) => {
    const f = Math.min(1, Math.max(0, t)) * (n - 1);
    const i = Math.min(Math.floor(f), n - 2);
    return [i, catmullRom(f - i)] as const;
  };
  const [i, wx] = axis(u, g.nx);
  const [j, wy] = axis(v, g.ny);
  let x = 0;
  let y = 0;
  for (let b = 0; b < 4; b++) {
    const row = Math.min(g.ny - 1, Math.max(0, j + b - 1));
    for (let a = 0; a < 4; a++) {
      const col = Math.min(g.nx - 1, Math.max(0, i + a - 1));
      const d = g.d[row * g.nx + col];
      x += wx[a] * wy[b] * d[0];
      y += wx[a] * wy[b] * d[1];
    }
  }
  return [x, y];
}

export type WarpMap = ((u: number, v: number) => Pt) & { h: Mat3 };

/** The warp ready to be evaluated: sheet (u, v in 0..1) → photo px. */
export function warpMap(w: Warp): WarpMap {
  const c = w.corners;
  const h = homography([[0, 0], [1, 0], [1, 1], [0, 1]], c);
  const sides = c.map((a, k) => {
    const b = c[(k + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
    const d: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    return { a, d, n: [d[1], -d[0]] as Pt, len };
  });
  const side = (k: number, q: Pt): Pt => {
    const s = sides[k];
    const t = Math.min(1, Math.max(0, ((q[0] - s.a[0]) * s.d[0] + (q[1] - s.a[1]) * s.d[1]) / s.len));
    const m = poly(w.bulge![k], t);
    return [s.n[0] * m, s.n[1] * m];
  };
  const map = ((u: number, v: number): Pt => {
    const p = apply(h, [u, v]);
    if (w.bulge) {
      const top = side(0, apply(h, [u, 0]));
      const right = side(1, apply(h, [1, v]));
      const bottom = side(2, apply(h, [u, 1]));
      const left = side(3, apply(h, [0, v]));
      for (const i of [0, 1]) p[i] += (1 - v) * top[i] + u * right[i] + v * bottom[i] + (1 - u) * left[i];
    }
    if (w.grid) {
      const d = gridAt(w.grid, u, v);
      p[0] += d[0];
      p[1] += d[1];
    }
    return p;
  }) as WarpMap;
  map.h = h;
  return map;
}
