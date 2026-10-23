// Plane geometry for drawings: vectors, intersections, transformations, clipping.
import type { Shape, Vec } from './types';

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec) => a.x * b.y - a.y * b.x;
export const len = (a: Vec) => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
export const dir = (angle: number): Vec => ({ x: Math.cos(angle), y: Math.sin(angle) });
export const angleOf = (a: Vec) => Math.atan2(a.y, a.x);
export const perp = (a: Vec): Vec => ({ x: -a.y, y: a.x });
export const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export function unit(a: Vec): Vec {
  const l = len(a);
  return l > 0 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}
export function rotate(p: Vec, angle: number, c: Vec = { x: 0, y: 0 }): Vec {
  const s = Math.sin(angle);
  const k = Math.cos(angle);
  const d = sub(p, c);
  return { x: c.x + d.x * k - d.y * s, y: c.y + d.x * s + d.y * k };
}
/** The signed turn from a to b, in (−π, π]. */
export function turn(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d <= -Math.PI) d += 2 * Math.PI;
  if (d > Math.PI) d -= 2 * Math.PI;
  return d;
}

export const isLineLike = (s: Shape): s is Extract<Shape, { type: 'segment' | 'ray' | 'line' | 'vector' }> =>
  s.type === 'segment' || s.type === 'ray' || s.type === 'line' || s.type === 'vector';

/** P(t) = a + t·(b − a) with the range of t the figure covers. */
export function lineParams(s: Shape): { a: Vec; d: Vec; t0: number; t1: number } {
  if (!isLineLike(s)) throw new Error('нужна прямая, отрезок, луч или вектор');
  const d = sub(s.b, s.a);
  if (len(d) < 1e-12) throw new Error('две точки совпадают — через них не провести прямую');
  if (s.type === 'line') return { a: s.a, d, t0: -Infinity, t1: Infinity };
  if (s.type === 'ray') return { a: s.a, d, t0: 0, t1: Infinity };
  return { a: s.a, d, t0: 0, t1: 1 };
}

function onArc(s: Shape, p: Vec): boolean {
  if (s.type !== 'arc') return true;
  const a = turn(s.from, angleOf(sub(p, s.c)));
  const t = s.sweep >= 0 ? (a + 2 * Math.PI) % (2 * Math.PI) : (-a + 2 * Math.PI) % (2 * Math.PI);
  return t <= Math.abs(s.sweep) + 1e-9 || t >= 2 * Math.PI - 1e-9;
}

const EPS = 1e-9;
const inRange = (t: number, t0: number, t1: number) => t >= t0 - EPS && t <= t1 + EPS;

function lineLine(s1: Shape, s2: Shape): Vec[] {
  const l1 = lineParams(s1);
  const l2 = lineParams(s2);
  const den = cross(l1.d, l2.d);
  if (Math.abs(den) < 1e-12) return [];
  const w = sub(l2.a, l1.a);
  const t = cross(w, l2.d) / den;
  const u = cross(w, l1.d) / den;
  if (!inRange(t, l1.t0, l1.t1) || !inRange(u, l2.t0, l2.t1)) return [];
  return [add(l1.a, mul(l1.d, t))];
}

function lineCircle(sl: Shape, sc: Extract<Shape, { type: 'circle' | 'arc' }>): Vec[] {
  const l = lineParams(sl);
  const f = sub(l.a, sc.c);
  const A = dot(l.d, l.d);
  const B = 2 * dot(f, l.d);
  const C = dot(f, f) - sc.r * sc.r;
  const disc = B * B - 4 * A * C;
  if (disc < -1e-12) return [];
  const sq = Math.sqrt(Math.max(0, disc));
  const ts = disc < 1e-12 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  return ts
    .filter((t) => inRange(t, l.t0, l.t1))
    .map((t) => add(l.a, mul(l.d, t)))
    .filter((p) => onArc(sc, p));
}

function circleCircle(a: Extract<Shape, { type: 'circle' | 'arc' }>, b: Extract<Shape, { type: 'circle' | 'arc' }>): Vec[] {
  const d = dist(a.c, b.c);
  if (d < 1e-12 || d > a.r + b.r + 1e-9 || d < Math.abs(a.r - b.r) - 1e-9) return [];
  const x = (a.r * a.r - b.r * b.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.r * a.r - x * x));
  const u = unit(sub(b.c, a.c));
  const base = add(a.c, mul(u, x));
  const pts = h < 1e-9 ? [base] : [add(base, mul(perp(u), h)), sub(base, mul(perp(u), h))];
  return pts.filter((p) => onArc(a, p) && onArc(b, p)).sort((p, q) => p.x - q.x || p.y - q.y);
}

/** Zeros of h on [a, b]: sign changes and touching points; poles are not zeros. */
export function roots(h: (x: number) => number, a: number, b: number, n = 4000): number[] {
  const out: number[] = [];
  const push = (x: number) => {
    if (!out.some((r) => Math.abs(r - x) < (b - a) * 1e-7)) out.push(x);
  };
  const xs: number[] = [];
  const hs: number[] = [];
  for (let i = 0; i <= n; i++) {
    const x = a + ((b - a) * i) / n;
    xs.push(x);
    hs.push(h(x));
  }
  for (let i = 0; i <= n; i++) {
    const hx = hs[i];
    if (!Number.isFinite(hx)) continue;
    if (hx === 0) {
      push(xs[i]);
      continue;
    }
    if (i > 0 && Number.isFinite(hs[i - 1]) && hs[i - 1] * hx < 0) {
      let lo = xs[i - 1];
      let hi = xs[i];
      let hlo = hs[i - 1];
      for (let k = 0; k < 80; k++) {
        const m = (lo + hi) / 2;
        const hm = h(m);
        if (!Number.isFinite(hm)) break;
        if (hlo * hm <= 0) hi = m;
        else {
          lo = m;
          hlo = hm;
        }
      }
      const r = (lo + hi) / 2;
      // A sign change across a pole (tan x) leaves a huge value behind, not a zero.
      if (Math.abs(h(r)) < 1e-6 * (1 + Math.abs(hs[i - 1]) + Math.abs(hx))) push(r);
      continue;
    }
    // Touching without crossing (x² and the x-axis): a dip of |h| down to zero.
    if (i > 0 && i < n && Math.abs(hx) < Math.abs(hs[i - 1]) && Math.abs(hx) <= Math.abs(hs[i + 1]) && hs[i - 1] * hs[i + 1] > 0) {
      let lo = xs[i - 1];
      let hi = xs[i + 1];
      for (let k = 0; k < 100; k++) {
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) / 3;
        if (Math.abs(h(m1)) < Math.abs(h(m2))) hi = m2;
        else lo = m1;
      }
      const r = (lo + hi) / 2;
      if (Math.abs(h(r)) < 1e-9 * (1 + Math.abs(hs[i - 1]))) push(r);
    }
  }
  return out.sort((p, q) => p - q);
}

function graphLine(f: (x: number) => number, sl: Shape, range: [number, number]): Vec[] {
  const l = lineParams(sl);
  if (Math.abs(l.d.x) < 1e-12) {
    const y = f(l.a.x);
    if (!Number.isFinite(y)) return [];
    return inRange((y - l.a.y) / l.d.y, l.t0, l.t1) ? [{ x: l.a.x, y }] : [];
  }
  const k = l.d.y / l.d.x;
  return roots((x) => f(x) - (l.a.y + (x - l.a.x) * k), range[0], range[1])
    .filter((x) => inRange((x - l.a.x) / l.d.x, l.t0, l.t1))
    .map((x) => ({ x, y: f(x) }));
}

function edges(s: Extract<Shape, { type: 'polygon' }>): Shape[] {
  return s.pts.map((p, i) => ({ type: 'segment', a: p, b: s.pts[(i + 1) % s.pts.length] }));
}

/** All the points where two figures meet, in a stable order. */
export function intersect(s1: Shape, s2: Shape, range: [number, number]): Vec[] {
  if (s1.type === 'polygon' || s2.type === 'polygon') {
    const [poly, other] = s1.type === 'polygon' ? [s1, s2] : [s2 as Extract<Shape, { type: 'polygon' }>, s1];
    const pts: Vec[] = [];
    for (const e of edges(poly)) {
      for (const p of intersect(e, other, range)) if (!pts.some((q) => dist(p, q) < 1e-9)) pts.push(p);
    }
    return pts;
  }
  const round = (s: Shape) => s.type === 'circle' || s.type === 'arc';
  if (isLineLike(s1) && isLineLike(s2)) return lineLine(s1, s2);
  if (isLineLike(s1) && round(s2)) return lineCircle(s1, s2 as Extract<Shape, { type: 'circle' | 'arc' }>);
  if (round(s1) && isLineLike(s2)) return lineCircle(s2, s1 as Extract<Shape, { type: 'circle' | 'arc' }>);
  if (round(s1) && round(s2)) {
    return circleCircle(s1 as Extract<Shape, { type: 'circle' | 'arc' }>, s2 as Extract<Shape, { type: 'circle' | 'arc' }>);
  }
  if (s1.type === 'graph' && s2.type === 'graph') {
    const [a, b] = clampRange(range, s1.domain, s2.domain);
    return roots((x) => s1.f(x) - s2.f(x), a, b).map((x) => ({ x, y: s1.f(x) }));
  }
  if (s1.type === 'graph' && isLineLike(s2)) return graphLine(s1.f, s2, clampRange(range, s1.domain));
  if (s2.type === 'graph' && isLineLike(s1)) return graphLine(s2.f, s1, clampRange(range, s2.domain));
  throw new Error('пересечение таких объектов пока не считается: попробуйте прямые, отрезки, окружности и графики');
}

function clampRange(range: [number, number], ...domains: ([number, number] | null)[]): [number, number] {
  let [a, b] = range;
  for (const d of domains) {
    if (!d) continue;
    a = Math.max(a, d[0]);
    b = Math.min(b, d[1]);
  }
  return [a, b];
}

/** Distance from p to a figure made of straight lines or a point. */
export function distanceTo(p: Vec, s: Shape): number {
  if (s.type === 'point') return dist(p, s.p);
  if (s.type === 'circle') return Math.abs(dist(p, s.c) - s.r);
  const l = lineParams(s);
  const t = Math.min(Math.max(dot(sub(p, l.a), l.d) / dot(l.d, l.d), l.t0), l.t1);
  return dist(p, add(l.a, mul(l.d, t)));
}

/**
 * The figure moved by a map of the plane. `flip` tells that the map mirrors
 * (arcs then run the other way), `scale` how lengths change.
 */
export function mapShape(s: Shape, m: (p: Vec) => Vec, flip: boolean, scale: number, range: [number, number]): Shape {
  const angleAt = (c: Vec, a: number) => angleOf(sub(m(add(c, dir(a))), m(c)));
  switch (s.type) {
    case 'point':
      return { type: 'point', p: m(s.p) };
    case 'segment':
    case 'ray':
    case 'line':
    case 'vector':
      return { type: s.type, a: m(s.a), b: m(s.b) };
    case 'circle':
      return { type: 'circle', c: m(s.c), r: s.r * Math.abs(scale) };
    case 'arc':
      return { type: 'arc', c: m(s.c), r: s.r * Math.abs(scale), from: angleAt(s.c, s.from), sweep: flip ? -s.sweep : s.sweep };
    case 'angle':
      return { type: 'angle', v: m(s.v), from: angleAt(s.v, s.from), sweep: flip ? -s.sweep : s.sweep };
    case 'polygon':
      return { type: 'polygon', pts: s.pts.map(m) };
    case 'text':
      return { type: 'text', text: s.text, at: s.at && m(s.at) };
    case 'space':
      throw new Error('повороты, переносы и отражения работают с фигурами на листе, а не в пространстве');
    case 'graph': {
      const f = s.f;
      const [t0, t1] = s.domain ?? range;
      return { type: 'curve', f: (t) => m({ x: t, y: f(t) }), t0, t1 };
    }
    case 'curve': {
      const f = s.f;
      return { type: 'curve', f: (t) => m(f(t)), t0: s.t0, t1: s.t1 };
    }
  }
}

/** Points that must stay in view when the window is chosen automatically. */
export function extentPoints(s: Shape): Vec[] {
  switch (s.type) {
    case 'point':
      return [s.p];
    case 'segment':
    case 'ray':
    case 'line':
    case 'vector':
      return [s.a, s.b];
    case 'circle':
      return [add(s.c, vec(-s.r, -s.r)), add(s.c, vec(s.r, s.r))];
    case 'arc': {
      const out: Vec[] = [s.c];
      for (let i = 0; i <= 16; i++) out.push(add(s.c, mul(dir(s.from + (s.sweep * i) / 16), s.r)));
      return out;
    }
    case 'polygon':
      return s.pts;
    case 'angle':
      return [s.v];
    case 'text':
      return s.at ? [s.at] : [];
    case 'space':
      return [];
    case 'curve': {
      const out: Vec[] = [];
      for (let i = 0; i <= 200; i++) {
        const p = s.f(s.t0 + ((s.t1 - s.t0) * i) / 200);
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) out.push(p);
      }
      return out;
    }
    case 'graph':
      return [];
  }
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The part of a + t·d with t in [t0, t1] inside the rectangle (Liang–Barsky), or null. */
export function clipLine(a: Vec, d: Vec, t0: number, t1: number, r: Rect): [Vec, Vec] | null {
  let lo = t0;
  let hi = t1;
  const check = (p: number, q: number) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
    return lo <= hi;
  };
  if (
    !check(-d.x, a.x - r.x0) ||
    !check(d.x, r.x1 - a.x) ||
    !check(-d.y, a.y - r.y0) ||
    !check(d.y, r.y1 - a.y) ||
    !Number.isFinite(lo) ||
    !Number.isFinite(hi)
  ) {
    return null;
  }
  return [add(a, mul(d, lo)), add(a, mul(d, hi))];
}

/** A polyline cut to the rectangle: the pieces that are inside. */
export function clipPolyline(pts: Vec[], r: Rect): Vec[][] {
  const out: Vec[][] = [];
  let cur: Vec[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = clipLine(a, sub(b, a), 0, 1, r);
    if (!seg) {
      if (cur.length > 1) out.push(cur);
      cur = [];
      continue;
    }
    const [p, q] = seg;
    if (cur.length && dist(cur[cur.length - 1], p) < 1e-6) cur.push(q);
    else {
      if (cur.length > 1) out.push(cur);
      cur = [p, q];
    }
    // The segment left the rectangle: the next one starts a new piece.
    if (dist(q, b) > 1e-6) {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}
