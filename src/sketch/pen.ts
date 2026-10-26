// The pen: lines as a hand draws them. A slight bow, a slow wobble, a little
// overshoot at the ends, pressure that thickens and thins the stroke. Strokes
// are filled outlines like the letters, so they print and export the same way.
import type { Vec } from './types';

export interface Pen {
  /** Stroke width, px (the handwriting's own pen width). */
  width: number;
  /** 0..1: how much the width breathes along the stroke. */
  pressure: number;
  /** 0..1: how much the hand wobbles. */
  jitter: number;
  /** Factor on all the shaking and bowing of the lines: 0 — as with a ruler (default 1). */
  wobble?: number;
  /** Factor on how far straight lines run past their ends (default 1). */
  overshoot?: number;
}

export type Rand = () => number;

/** Seeded random numbers in [0, 1). */
export function rng(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

function length(pts: Vec[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s;
}

/** Points every `step` px along the polyline (the corners kept). */
function resample(pts: Vec[], step: number): Vec[] {
  const out: Vec[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** Unit normals, smoothed over the neighbours. */
function normals(pts: Vec[]): Vec[] {
  return pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: -dy / l, y: dx / l };
  });
}

export interface StrokeOptions {
  /** A ruler-less straight line: it bows a little and overshoots. */
  straight?: boolean;
  /** Width factor (GeoGebra thickness / 5). */
  weight?: number;
}

/** The centre line of a stroke after the hand has touched it. */
export function wobble(pts: Vec[], r: Rand, pen: Pen, o: StrokeOptions = {}): Vec[] {
  let line = pts;
  const total = length(line);
  if (total < 0.5) return line;
  const k = Math.min(Math.max(pen.width / 1.4, 0.6), 2);
  const shake = pen.wobble ?? 1;
  if (o.straight) {
    // Overshoot (or stop a little short) at both ends.
    const ext = (p: Vec, q: Vec, by: number): Vec => {
      const d = Math.hypot(p.x - q.x, p.y - q.y) || 1;
      return { x: p.x + ((p.x - q.x) / d) * by, y: p.y + ((p.y - q.y) / d) * by };
    };
    const n = line.length;
    const over = (pen.overshoot ?? 1) * k;
    line = [ext(line[0], line[1], (r() * 2.2 - 0.6) * over), ...line.slice(1, -1), ext(line[n - 1], line[n - 2], (r() * 2.2 - 0.6) * over)];
  }
  const dense = resample(line, 2.5);
  const L = length(dense);
  const j = pen.jitter;
  const calm = (o.straight ? 1 : 0.6) * shake;
  const a1 = (0.25 + 0.7 * j) * k * calm;
  const l1 = 90 + r() * 120;
  const p1 = r() * Math.PI * 2;
  const a2 = 0.2 * j * k * calm;
  const l2 = 25 + r() * 25;
  const p2 = r() * Math.PI * 2;
  const bow = o.straight ? (r() * 2 - 1) * Math.min(2.5 * k, 0.008 * L) * (0.6 + j) * shake : 0;
  const ns = normals(dense);
  let s = 0;
  return dense.map((p, i) => {
    if (i > 0) s += Math.hypot(p.x - dense[i - 1].x, p.y - dense[i - 1].y);
    const u = L > 0 ? s / L : 0;
    // The slow wobble fades in from the ends, where the pen is still steady.
    const ease = Math.min(1, s / 12, (L - s) / 12);
    const off = bow * 4 * u * (1 - u) + ease * (a1 * Math.sin((2 * Math.PI * s) / l1 + p1) + a2 * Math.sin((2 * Math.PI * s) / l2 + p2));
    return { x: p.x + ns[i].x * off, y: p.y + ns[i].y * off };
  });
}

/** A filled outline around the centre line: pressure along the way, round tapered ends. */
export function outline(center: Vec[], r: Rand, pen: Pen, weight = 1): string {
  if (center.length < 2) return '';
  const w = pen.width * weight;
  const L = length(center);
  const ns = normals(center);
  const lp = 40 + r() * 60;
  const pp = r() * Math.PI * 2;
  const left: Vec[] = [];
  const right: Vec[] = [];
  let s = 0;
  const half: number[] = [];
  center.forEach((p, i) => {
    if (i > 0) s += Math.hypot(p.x - center[i - 1].x, p.y - center[i - 1].y);
    const edge = Math.min(s, L - s);
    const taper = 0.6 + 0.4 * Math.min(1, edge / (2 * w + 3));
    const press = 1 - 0.3 * pen.pressure * (0.5 + 0.5 * Math.sin((2 * Math.PI * s) / lp + pp));
    const h = (w * taper * press) / 2;
    half.push(h);
    left.push({ x: p.x + ns[i].x * h, y: p.y + ns[i].y * h });
    right.push({ x: p.x - ns[i].x * h, y: p.y - ns[i].y * h });
  });
  // Round caps: half circles around the ends.
  const cap = (p: Vec, n: Vec, h: number, forward: boolean): Vec[] => {
    const out: Vec[] = [];
    // From one side, around the tip (ahead at the end, behind at the start), to the other side.
    const from = forward ? n : { x: -n.x, y: -n.y };
    const tip = forward ? { x: n.y, y: -n.x } : { x: -n.y, y: n.x };
    for (let k = 1; k < 6; k++) {
      const a = (Math.PI * k) / 6;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      out.push({ x: p.x + (from.x * c + tip.x * sn) * h, y: p.y + (from.y * c + tip.y * sn) * h });
    }
    return out;
  };
  const n = center.length - 1;
  const ring = [...left, ...cap(center[n], ns[n], half[n], true), ...right.reverse(), ...cap(center[0], ns[0], half[0], false)];
  return 'M' + ring.map((p) => `${f1(p.x)} ${f1(p.y)}`).join('L') + 'Z';
}

/** Dash patterns (in pen widths) for GeoGebra's line styles 1–4. */
const DASHES: Record<number, number[]> = {
  1: [7, 4.5],
  2: [3.5, 3.5],
  3: [0.01, 3],
  4: [9, 3.5, 1, 3.5],
};

/** The centre line cut into dashes; style 0 is one solid piece. */
export function dashes(center: Vec[], style: number, unit: number): Vec[][] {
  const pattern = DASHES[style];
  if (!pattern) return [center];
  const lens = pattern.map((v) => Math.max(v * unit, 0.01));
  const out: Vec[][] = [];
  let k = 0;
  let left = lens[0];
  let cur: Vec[] = [center[0]];
  for (let i = 1; i < center.length; i++) {
    let a = center[i - 1];
    const b = center[i];
    let d = Math.hypot(b.x - a.x, b.y - a.y);
    while (d > left) {
      const t = left / d;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (k % 2 === 0) {
        cur.push(p);
        out.push(cur);
      }
      cur = [p];
      d -= left;
      a = p;
      k = (k + 1) % lens.length;
      left = lens[k];
    }
    left -= d;
    if (k % 2 === 0) cur.push(b);
    else cur = [b];
  }
  if (k % 2 === 0 && cur.length > 1) out.push(cur);
  return out;
}

/** A dot of ink: a slightly uneven blob. */
export function dot(c: Vec, radius: number, r: Rand): string {
  const n = 9;
  const pts: Vec[] = [];
  const turn = r() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = turn + (2 * Math.PI * i) / n;
    const rr = radius * (0.9 + r() * 0.2);
    pts.push({ x: c.x + Math.cos(a) * rr, y: c.y + Math.sin(a) * rr });
  }
  const midOf = (p: Vec, q: Vec) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  const start = midOf(pts[n - 1], pts[0]);
  let d = `M${f1(start.x)} ${f1(start.y)}`;
  for (let i = 0; i < n; i++) {
    const m = midOf(pts[i], pts[(i + 1) % n]);
    d += `Q${f1(pts[i].x)} ${f1(pts[i].y)} ${f1(m.x)} ${f1(m.y)}`;
  }
  return d + 'Z';
}

/** Hatching inside a closed polygon: parallel lines `gap` px apart at `angle`. */
export function hatch(poly: Vec[], gap: number, angle: number): [Vec, Vec][] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Rotate so the hatch lines are horizontal, cut, rotate back.
  const rot = poly.map((p) => ({ x: p.x * c + p.y * s, y: -p.x * s + p.y * c }));
  const ys = rot.map((p) => p.y);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const out: [Vec, Vec][] = [];
  for (let y = lo + gap / 2; y < hi; y += gap) {
    const xs: number[] = [];
    for (let i = 0; i < rot.length; i++) {
      const a = rot[i];
      const b = rot[(i + 1) % rot.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const back = (x: number): Vec => ({ x: x * c - y * s, y: x * s + y * c });
      out.push([back(xs[i]), back(xs[i + 1])]);
    }
  }
  return out;
}
