// From a scene to ink on paper: the window and the scale, the hand-drawn
// lines, and where every label goes so that it does not sit on a line.
import { convertMathInText, convertTex, type MathRun } from '../editor/tex';
import * as g from './geometry';
import type { LabelInk } from './labels';
import { formatNumber } from './lang';
import { dashes, dot, hatch, outline, rng, wobble, type Pen } from './pen';
import type { Item, Scene, Shape, Vec } from './types';

export interface InkPath {
  d: string;
  color?: string;
  opacity?: number;
}

/** A place for a label: its ink box aligned at (x, y); ax/ay: 0 = left/top, 0.5 = middle, 1 = right/bottom. */
export interface Spot {
  x: number;
  y: number;
  ax: number;
  ay: number;
}

export interface LabelRequest {
  runs: MathRun[];
  /** Letter size, px per em. */
  size: number;
  color?: string;
  seed: number;
  /** Places to choose from, best first. */
  spots: Spot[];
  /** Goes exactly to its first spot (axis numbers, texts, the title). */
  fixed?: boolean;
}

export interface SketchLayout {
  width: number;
  height: number;
  paths: InkPath[];
  labels: LabelRequest[];
  /** Points along every drawn line: labels keep clear of them. */
  obstacles: Vec[];
  /** Nothing to draw yet. */
  empty: boolean;
}

export interface PlacedLabel {
  ink: LabelInk;
  /** Where the label's origin (start of the baseline) goes, and its scale from font units. */
  x: number;
  y: number;
  scale: number;
  color?: string;
}

interface Frame {
  width: number;
  height: number;
  /** The plot area, px. */
  rect: g.Rect;
  x: [number, number];
  y: [number, number];
  /** Pixels per unit along x and y. */
  ppx: number;
  ppy: number;
  axes: boolean;
  grid: boolean;
  xPi: boolean;
  yPi: boolean;
}

const finite = (p: Vec) => Number.isFinite(p.x) && Number.isFinite(p.y);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function extent(vs: number[]): [number, number] | null {
  if (!vs.length) return null;
  return [Math.min(...vs), Math.max(...vs)];
}

function union(a: [number, number] | null, b: [number, number] | null): [number, number] | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}

/** The range widened to at least `min` and padded by a share of itself on both sides. */
function padded(r: [number, number], share: number, min: number): [number, number] {
  let [lo, hi] = r;
  if (hi - lo < min) {
    const c = (lo + hi) / 2;
    lo = c - min / 2;
    hi = c + min / 2;
  }
  const p = (hi - lo) * share;
  return [lo - p, hi + p];
}

/** Where the graphs mostly are on [x0, x1]: spikes near asymptotes do not stretch the view. */
function graphRange(graphs: Extract<Shape, { type: 'graph' }>[], xr: [number, number]): [number, number] | null {
  const ys: number[] = [];
  for (const s of graphs) {
    const [a, b] = s.domain ? [Math.max(xr[0], s.domain[0]), Math.min(xr[1], s.domain[1])] : xr;
    for (let i = 0; i <= 300 && b > a; i++) {
      const y = s.f(a + ((b - a) * i) / 300);
      if (Number.isFinite(y)) ys.push(y);
    }
  }
  if (!ys.length) return null;
  ys.sort((p, q) => p - q);
  let lo = ys[Math.floor(ys.length * 0.02)];
  let hi = ys[Math.max(0, Math.ceil(ys.length * 0.98) - 1)];
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  // Keep the x-axis in view when the graph is close to it.
  if (lo > 0 && lo < (hi - lo) * 0.5) lo = 0;
  if (hi < 0 && -hi < (hi - lo) * 0.5) hi = 0;
  return [lo, hi];
}

const SHAPELY = new Set<Shape['type']>(['circle', 'arc', 'angle', 'curve', 'polygon']);

/** The window, the scale and the size of a drawing `width` px wide. */
function frameOf(scene: Scene, width: number, fs: number): Frame {
  const items = scene.items.filter((i) => !i.hidden);
  const graphs = items.map((i) => i.shape).filter((s): s is Extract<Shape, { type: 'graph' }> => s.type === 'graph');
  // Circles must stay round: one scale for both axes, unless only graphs are drawn.
  const equal = scene.view.ratio !== undefined || !graphs.length || items.some((i) => SHAPELY.has(i.shape.type));
  const ratio = scene.view.ratio ?? 1;
  // An epure keeps its origin O in view: the axes start there.
  const pts = [...items.flatMap((i) => g.extentPoints(i.shape)), ...(scene.view.epure ? [{ x: 0, y: 0 }] : [])].filter(finite);
  const bx = extent(pts.map((p) => p.x));
  const by = extent(pts.map((p) => p.y));

  let xr = scene.view.x;
  if (!xr) {
    let r = bx;
    if (graphs.length) {
      const domains = graphs.map((s) => s.domain).reduce<[number, number] | null>((acc, d) => union(acc, d), null);
      const around = bx ? padded(bx, 0.3, 3) : ([-5, 5] as [number, number]);
      r = union(union(r, domains), graphs.some((s) => !s.domain) ? around : null);
    }
    xr = padded(r ?? [-5, 5], 0.08, 1);
  }
  let yr = scene.view.y;
  if (!yr) {
    const r = union(by, graphs.length ? graphRange(graphs, xr) : null);
    yr = padded(r ?? [-5, 5], 0.1, 1);
  }

  const axes = scene.view.axes ?? graphs.length > 0;
  const titleH = scene.title ? fs * 1.6 : 0;
  const pad = axes
    ? { l: fs * 1.6, r: fs * 0.9, t: titleH + fs * 0.9, b: fs * 1.2 }
    : { l: fs * 0.7, r: fs * 0.7, t: titleH + fs * 0.7, b: fs * 0.7 };
  const plotW = Math.max(40, width - pad.l - pad.r);
  let plotH: number;
  if (equal) {
    const want = (plotW * ratio * (yr[1] - yr[0])) / (xr[1] - xr[0]);
    plotH = clamp(want, 0.3 * width, 1.15 * width);
    if (plotH > want) {
      // Too flat: show more along y.
      const span = plotH / ((plotW / (xr[1] - xr[0])) * ratio);
      const c = (yr[0] + yr[1]) / 2;
      yr = [c - span / 2, c + span / 2];
    } else if (plotH < want) {
      // Too tall: show more along x.
      const span = plotW / (plotH / (yr[1] - yr[0]) / ratio);
      const c = (xr[0] + xr[1]) / 2;
      xr = [c - span / 2, c + span / 2];
    }
  } else {
    plotH = plotW * 0.62;
  }
  const empty = !items.length && !scene.title && !axes;
  return {
    width,
    height: empty ? Math.round(fs * 1.6) : Math.round(pad.t + plotH + pad.b),
    rect: { x0: pad.l, y0: pad.t, x1: pad.l + plotW, y1: pad.t + plotH },
    x: xr,
    y: yr,
    ppx: plotW / (xr[1] - xr[0]),
    ppy: plotH / (yr[1] - yr[0]),
    axes,
    grid: scene.view.grid ?? false,
    xPi: !!scene.view.xPi,
    yPi: !!scene.view.yPi,
  };
}

/** Height of the drawing at this width (pages are laid out with it before anything is drawn). */
export function sketchHeight(scene: Scene, width: number, fs: number): number {
  return frameOf(scene, width, fs).height;
}

function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const k = raw / p;
  return (k <= 1 ? 1 : k <= 2 ? 2 : k <= 5 ? 5 : 10) * p;
}

/** k·π/2 as it is written: π/2, π, 3π/2, −π. */
function piLabel(m: number): string {
  if (m === 0) return '0';
  const sign = m < 0 ? '−' : '';
  const a = Math.abs(m);
  if (a % 2 === 0) return `${sign}${a === 2 ? '' : a / 2}π`;
  return `${sign}${a === 1 ? '' : a}π/2`;
}

function ticks(lo: number, hi: number, pi: boolean, maxCount: number): { v: number; text: string }[] {
  const out: { v: number; text: string }[] = [];
  if (pi) {
    let k = 1;
    while ((hi - lo) / ((k * Math.PI) / 2) > maxCount) k *= 2;
    const step = (k * Math.PI) / 2;
    for (let m = Math.ceil(lo / step - 1e-9); m * step <= hi + 1e-9; m++) out.push({ v: m * step, text: piLabel(m * k) });
    return out;
  }
  const step = niceStep(hi - lo, maxCount);
  for (let m = Math.ceil(lo / step - 1e-9); m * step <= hi + 1e-9; m++) out.push({ v: m * step, text: formatNumber(m * step) });
  return out;
}

/** Eight places around a point, upper right first (where people usually write). */
function aroundPoint(p: Vec, gap: number): Spot[] {
  const d = gap * 1.25;
  return [
    { x: p.x + gap, y: p.y - gap, ax: 0, ay: 1 },
    { x: p.x - gap, y: p.y - gap, ax: 1, ay: 1 },
    { x: p.x + gap, y: p.y + gap, ax: 0, ay: 0 },
    { x: p.x - gap, y: p.y + gap, ax: 1, ay: 0 },
    { x: p.x + d, y: p.y, ax: 0, ay: 0.5 },
    { x: p.x - d, y: p.y, ax: 1, ay: 0.5 },
    { x: p.x, y: p.y - d, ax: 0.5, ay: 1 },
    { x: p.x, y: p.y + d, ax: 0.5, ay: 0 },
  ];
}

/** Places beside a drawn line, at the given shares of its length. */
function alongLine(pieces: Vec[][], shares: number[], gap: number): Spot[] {
  const all = pieces.flat();
  if (all.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < all.length; i++) cum.push(cum[i - 1] + g.dist(all[i - 1], all[i]));
  const total = cum[cum.length - 1];
  const out: Spot[] = [];
  for (const share of shares) {
    const at = total * share;
    const i = Math.max(1, cum.findIndex((c) => c >= at));
    out.push(...aroundPoint(all[Math.min(i, all.length - 1)], gap).slice(0, 4));
  }
  return out;
}

/** Breaks a sampled graph where it jumps over a pole (1/x, tan x), not where it is merely steep. */
function continuous(f: (x: number) => number, xa: number, ya: number, xb: number, yb: number, depth = 0): boolean {
  const xm = (xa + xb) / 2;
  const ym = f(xm);
  if (!Number.isFinite(ym)) return false;
  const lo = Math.min(ya, yb);
  const hi = Math.max(ya, yb);
  if (ym < lo - (hi - lo) * 0.1 || ym > hi + (hi - lo) * 0.1) return false;
  if (depth >= 6) return true;
  return continuous(f, xa, ya, xm, ym, depth + 1) && continuous(f, xm, ym, xb, yb, depth + 1);
}

/** Text of a label: A_1 becomes A with index 1, $…$ parts are formulas. */
function labelRuns(text: string): MathRun[] {
  return convertMathInText(text) ?? convertTex(text);
}

function mix(a: number, b: number): number {
  return Math.imul(a ^ b, 16777619) >>> 0;
}

export function layoutSketch(scene: Scene, width: number, fs: number, pen: Pen): SketchLayout {
  const fr = frameOf(scene, width, fs);
  const { rect } = fr;
  const X = (x: number) => rect.x0 + (x - fr.x[0]) * fr.ppx;
  const Y = (y: number) => rect.y1 - (y - fr.y[0]) * fr.ppy;
  const T = (p: Vec): Vec => ({ x: X(p.x), y: Y(p.y) });
  const paths: InkPath[] = [];
  const labels: LabelRequest[] = [];
  const obstacles: Vec[] = [];
  const items = scene.items.filter((i) => !i.hidden);
  const base = items.reduce((h, it) => mix(h, it.seed), mix(2166136261, scene.title ? scene.title.length : 0));
  const gap = fs * 0.22;
  const dashUnit = Math.max(1.3, pen.width);
  const view: g.Rect = { x0: rect.x0 - 1, y0: rect.y0 - 1, x1: rect.x1 + 1, y1: rect.y1 + 1 };
  const inView = (p: Vec, m = 0) => p.x >= rect.x0 - m && p.x <= rect.x1 + m && p.y >= rect.y0 - m && p.y <= rect.y1 + m;

  interface Look {
    seed: number;
    color?: string;
    style?: number;
    weight?: number;
    straight?: boolean;
    opacity?: number;
    /** Labels keep clear of it (not of the grid). */
    solid?: boolean;
  }
  const stroke = (pts: Vec[], look: Look, salt = 0) => {
    if (pts.length < 2) return;
    const r = rng(mix(look.seed, salt + 1));
    const center = wobble(pts, r, pen, { straight: look.straight });
    const d = dashes(center, look.style ?? 0, dashUnit)
      .map((p) => outline(p, r, pen, look.weight ?? 1))
      .join('');
    if (d) paths.push({ d, color: look.color, opacity: look.opacity });
    if (look.solid !== false) for (let i = 0; i < center.length; i += 2) obstacles.push(center[i]);
  };
  const arrowHead = (tip: Vec, from: Vec, look: Look, salt: number) => {
    const d = g.unit(g.sub(from, tip));
    const len = fs * 0.36;
    stroke([g.add(tip, g.mul(g.rotate(d, 0.42), len)), tip], { ...look, straight: true }, salt);
    stroke([g.add(tip, g.mul(g.rotate(d, -0.42), len)), tip], { ...look, straight: true }, salt + 1);
  };
  const label = (text: string, size: number, spots: Spot[], seed: number, color?: string, fixed = false) => {
    if (!text.trim() || !spots.length) return;
    labels.push({ runs: labelRuns(text), size, color, seed, spots, fixed });
  };

  // ---- grid and axes
  const maxX = Math.max(2, Math.floor((rect.x1 - rect.x0) / (fs * 2.2)));
  const maxY = Math.max(2, Math.floor((rect.y1 - rect.y0) / (fs * 1.5)));
  const xt = ticks(fr.x[0], fr.x[1], fr.xPi, maxX);
  const yt = ticks(fr.y[0], fr.y[1], fr.yPi, maxY);
  if (fr.grid) {
    const look: Look = { seed: mix(base, 7), weight: 0.45, opacity: 0.4, straight: true, solid: false };
    xt.forEach((t, i) => stroke([{ x: X(t.v), y: rect.y0 }, { x: X(t.v), y: rect.y1 }], look, i));
    yt.forEach((t, i) => stroke([{ x: rect.x0, y: Y(t.v) }, { x: rect.x1, y: Y(t.v) }], look, 100 + i));
  }
  if (fr.axes) {
    const look: Look = { seed: mix(base, 11), straight: true };
    const ay = clamp(Y(0), rect.y0, rect.y1);
    const ax = clamp(X(0), rect.x0, rect.x1);
    const xEnd = { x: rect.x1 + fs * 0.5, y: ay };
    const yEnd = { x: ax, y: rect.y0 - fs * 0.5 };
    stroke([{ x: rect.x0 - fs * 0.2, y: ay }, xEnd], look, 1);
    stroke([{ x: ax, y: rect.y1 + fs * 0.2 }, yEnd], look, 2);
    arrowHead(xEnd, { x: ax, y: ay }, look, 3);
    arrowHead(yEnd, { x: ax, y: ay }, look, 5);
    label('x', fs * 0.8, [{ x: xEnd.x, y: ay + fs * 0.3, ax: 1, ay: 0 }], mix(base, 21), undefined, true);
    label('y', fs * 0.8, [{ x: ax + fs * 0.35, y: yEnd.y, ax: 0, ay: 0 }], mix(base, 22), undefined, true);
    const tick: Look = { seed: mix(base, 13), straight: true };
    const originShown = X(0) >= rect.x0 && X(0) <= rect.x1 && Y(0) >= rect.y0 && Y(0) <= rect.y1;
    xt.forEach((t, i) => {
      const x = X(t.v);
      if (Math.abs(t.v) < 1e-9 && originShown) return;
      if (x < rect.x0 + 2 || x > rect.x1 - 2) return;
      stroke([{ x, y: ay - fs * 0.14 }, { x, y: ay + fs * 0.14 }], tick, 10 + i);
      label(t.text, fs * 0.58, [{ x, y: ay + fs * 0.3, ax: 0.5, ay: 0 }], mix(base, 1000 + i), undefined, true);
    });
    yt.forEach((t, i) => {
      const y = Y(t.v);
      if (Math.abs(t.v) < 1e-9 && originShown) return;
      if (y < rect.y0 + 2 || y > rect.y1 - 2) return;
      stroke([{ x: ax - fs * 0.14, y }, { x: ax + fs * 0.14, y }], tick, 200 + i);
      label(t.text, fs * 0.58, [{ x: ax - fs * 0.3, y, ax: 1, ay: 0.5 }], mix(base, 2000 + i), undefined, true);
    });
    if (originShown) label('0', fs * 0.58, [{ x: ax - fs * 0.22, y: ay + fs * 0.22, ax: 1, ay: 0 }], mix(base, 23), undefined, true);
  }

  // ---- the epure: axis x₁₂ (or x, y, z with a profile projection), the origin O
  if (scene.view.epure) {
    const profile = (scene.view.planes ?? [1, 2]).includes(3);
    const sx = scene.view.xRight ? 1 : -1;
    const look: Look = { seed: mix(base, 41), straight: true, weight: 0.8 };
    const ox = X(0);
    const oy = Y(0);
    const left = rect.x0 - fs * 0.3;
    const right = rect.x1 + fs * 0.3;
    // x grows to the left (as in textbooks) unless XAxis("вправо").
    const xEnd = sx < 0 ? left : right;
    const yEnd = sx < 0 ? right : left;
    stroke([{ x: left, y: oy }, { x: right, y: oy }], look, 1);
    label(profile ? 'x' : 'x_{12}', fs * 0.8, [{ x: xEnd, y: oy - fs * 0.15, ax: sx < 0 ? 0 : 1, ay: 1 }], mix(base, 42), undefined, true);
    if (profile) {
      stroke([{ x: ox, y: rect.y0 - fs * 0.3 }, { x: ox, y: rect.y1 + fs * 0.3 }], look, 2);
      label('z', fs * 0.8, [{ x: ox + fs * 0.2, y: rect.y0 - fs * 0.3, ax: 0, ay: 0 }], mix(base, 43), undefined, true);
      label('y', fs * 0.8, [{ x: ox + fs * 0.2, y: rect.y1 + fs * 0.3, ax: 0, ay: 1 }], mix(base, 44), undefined, true);
      label('y', fs * 0.8, [{ x: yEnd, y: oy - fs * 0.15, ax: sx < 0 ? 1 : 0, ay: 1 }], mix(base, 45), undefined, true);
      // The constant line at 45° carries y from П₁ over to П₃.
      const reach = Math.max(0, Math.min(Math.abs(yEnd - ox), rect.y1 + fs * 0.3 - oy));
      stroke([{ x: ox, y: oy }, { x: ox - sx * reach, y: oy + reach }], { ...look, weight: 0.45 }, 3);
    }
    label('O', fs * 0.75, aroundPoint({ x: ox, y: oy }, gap * 0.6), mix(base, 46));
  }

  // ---- the objects; points go last so they lie on top of their lines
  const points: (() => void)[] = [];
  let texts = 0;
  for (const it of items) {
    const s = it.shape;
    const look: Look = { seed: it.seed, color: it.color, style: it.lineStyle, weight: it.thickness / 5 };
    const lseed = mix(it.seed, 0x1abe1);
    const caption = it.caption ?? it.label ?? '';
    const pieces: Vec[][] = [];
    const draw = (pts: Vec[], straight: boolean, salt: number) => {
      pieces.push(pts);
      stroke(pts, { ...look, straight }, salt);
    };
    switch (s.type) {
      case 'point': {
        const p = T(s.p);
        if (!inView(p, 2)) break;
        points.push(() => {
          const radius = Math.max(1.8, pen.width * 1.1 + fs * 0.05) * Math.sqrt(it.thickness / 5);
          paths.push({ d: dot(p, radius, rng(it.seed)), color: it.color });
          obstacles.push(p, { x: p.x - radius, y: p.y }, { x: p.x + radius, y: p.y });
          if (it.showLabel) label(caption, fs * 0.9, aroundPoint(p, gap + radius * 0.5), lseed, it.color);
        });
        break;
      }
      case 'segment':
      case 'vector':
      case 'ray':
      case 'line': {
        const a = T(s.a);
        const b = T(s.b);
        const range = s.type === 'line' ? [-Infinity, Infinity] : s.type === 'ray' ? [0, Infinity] : [0, 1];
        const c = g.clipLine(a, g.sub(b, a), range[0], range[1], view);
        if (c) draw(c, true, 0);
        if (s.type === 'vector' && inView(b, 1)) arrowHead(b, a, look, 7);
        if (it.showLabel) label(caption, fs * 0.85, alongLine(pieces, [0.5, 0.35, 0.65, 0.2, 0.8], gap), lseed, it.color);
        break;
      }
      case 'circle':
      case 'arc': {
        const r = rng(mix(it.seed, 3));
        const full = s.type === 'circle';
        // A hand-drawn circle starts anywhere, runs a little past its start and does not quite close.
        const from = full ? r() * Math.PI * 2 : s.from;
        const sweep = full ? Math.PI * 2 + 0.15 + r() * 0.25 : s.sweep;
        const drift = full ? ((r() - 0.5) * 3) / fr.ppx : 0;
        const n = Math.max(24, Math.ceil((Math.abs(sweep) * s.r * Math.max(fr.ppx, fr.ppy)) / 4));
        const world: Vec[] = [];
        for (let i = 0; i <= n; i++) world.push(g.add(s.c, g.mul(g.dir(from + (sweep * i) / n), s.r + (drift * i) / n)));
        g.clipPolyline(world.map(T), view).forEach((piece, i) => draw(piece, false, i));
        if (full && it.filling > 0) fill(Array.from({ length: 64 }, (_, i) => T(g.add(s.c, g.mul(g.dir((i / 64) * Math.PI * 2), s.r)))), it);
        if (it.showLabel) {
          const spots: Spot[] = [];
          const angles = full ? [Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4, -Math.PI / 4] : [s.from + s.sweep / 2];
          for (const a of angles) {
            const p = T(g.add(s.c, g.mul(g.dir(a), s.r)));
            const out = g.unit(g.sub(p, T(s.c)));
            spots.push({ x: p.x + out.x * gap, y: p.y + out.y * gap, ax: out.x < -0.3 ? 1 : out.x > 0.3 ? 0 : 0.5, ay: out.y < -0.3 ? 1 : out.y > 0.3 ? 0 : 0.5 });
          }
          label(caption, fs * 0.85, spots, lseed, it.color);
        }
        break;
      }
      case 'polygon': {
        const pts = s.pts.map(T);
        pts.forEach((p, i) => {
          const q = pts[(i + 1) % pts.length];
          const c = g.clipLine(p, g.sub(q, p), 0, 1, view);
          if (c) draw(c, true, i);
        });
        if (it.filling > 0) fill(pts, it);
        if (it.showLabel) {
          const c = pts.reduce((acc, p) => g.add(acc, g.mul(p, 1 / pts.length)), { x: 0, y: 0 });
          label(caption, fs * 0.85, [{ x: c.x, y: c.y, ax: 0.5, ay: 0.5 }], lseed, it.color);
        }
        break;
      }
      case 'angle': {
        const v = T(s.v);
        const d0 = g.unit(g.sub(T(g.add(s.v, g.dir(s.from))), v));
        const d1 = g.unit(g.sub(T(g.add(s.v, g.dir(s.from + s.sweep))), v));
        const deg = (Math.abs(s.sweep) * 180) / Math.PI;
        const right = Math.abs(deg - 90) < 0.5;
        const rho = fs * (right ? 0.42 : 0.75);
        if (right) {
          draw([g.add(v, g.mul(d0, rho)), g.add(v, g.mul(g.add(d0, d1), rho)), g.add(v, g.mul(d1, rho))], true, 0);
        } else {
          const a0 = g.angleOf(d0);
          const sw = g.turn(a0, g.angleOf(d1));
          const n = 24;
          draw(Array.from({ length: n + 1 }, (_, i) => g.add(v, g.mul(g.dir(a0 + (sw * i) / n), rho))), false, 0);
        }
        const text = it.caption ?? (right ? '' : `${formatNumber(Math.round(deg * 10) / 10)}°`);
        if (it.showLabel && text) {
          const bis = g.len(g.add(d0, d1)) < 1e-6 ? g.perp(d0) : g.unit(g.add(d0, d1));
          // Along the bisector first, then a little to either side (the bisector may be drawn).
          const spots = [
            [0, 1],
            [0, 1.5],
            [0.35, 1.2],
            [-0.35, 1.2],
            [0, 2.1],
            [0.5, 1.8],
            [-0.5, 1.8],
          ].map(([turn, k]) => {
            const p = g.add(v, g.mul(g.rotate(bis, turn), rho + fs * 0.45 * k));
            return { x: p.x, y: p.y, ax: 0.5, ay: 0.5 };
          });
          label(text, fs * 0.7, spots, lseed, it.color);
        }
        break;
      }
      case 'graph': {
        const [a, b] = s.domain ? [Math.max(fr.x[0], s.domain[0]), Math.min(fr.x[1], s.domain[1])] : fr.x;
        if (!(b > a)) break;
        const span = fr.y[1] - fr.y[0];
        const far = (y: number) => clamp(y, fr.y[0] - span * 1e3, fr.y[1] + span * 1e3);
        const n = Math.max(240, Math.ceil((rect.x1 - rect.x0) / 1.5));
        const runs: Vec[][] = [];
        let run: Vec[] = [];
        let prev: { x: number; y: number } | null = null;
        for (let i = 0; i <= n; i++) {
          const x = a + ((b - a) * i) / n;
          const y = s.f(x);
          if (!Number.isFinite(y)) {
            if (run.length > 1) runs.push(run);
            run = [];
            prev = null;
            continue;
          }
          if (prev && Math.abs(y - prev.y) > span * 0.5 && !continuous(s.f, prev.x, prev.y, x, y)) {
            if (run.length > 1) runs.push(run);
            run = [];
          }
          run.push({ x: X(x), y: Y(far(y)) });
          prev = { x, y };
        }
        if (run.length > 1) runs.push(run);
        let k = 0;
        for (const r of runs) for (const piece of g.clipPolyline(r, view)) draw(piece, false, k++);
        if (it.showLabel) label(caption, fs * 0.85, alongLine(pieces, [0.88, 0.72, 0.5, 0.3, 0.12], gap), lseed, it.color);
        break;
      }
      case 'curve': {
        const n = 400;
        const runs: Vec[][] = [];
        let run: Vec[] = [];
        for (let i = 0; i <= n; i++) {
          const p = s.f(s.t0 + ((s.t1 - s.t0) * i) / n);
          if (!finite(p)) {
            if (run.length > 1) runs.push(run);
            run = [];
            continue;
          }
          run.push(T(p));
        }
        if (run.length > 1) runs.push(run);
        let k = 0;
        for (const r of runs) for (const piece of g.clipPolyline(r, view)) draw(piece, false, k++);
        if (it.showLabel) label(caption, fs * 0.85, alongLine(pieces, [0.15, 0.4, 0.65, 0.9], gap), lseed, it.color);
        break;
      }
      case 'text': {
        const at = s.at ? T(s.at) : { x: rect.x0 + fs * 0.2, y: rect.y0 + fs * (0.9 + 1.1 * texts++) };
        label(s.text, fs * 0.85, [{ x: at.x, y: at.y, ax: 0, ay: 1 }], lseed, it.color, true);
        break;
      }
    }
  }
  points.forEach((p) => p());

  function fill(poly: Vec[], it: Item) {
    const r = rng(mix(it.seed, 5));
    const lines = hatch(poly, fs * (0.5 - 0.32 * it.filling), Math.PI / 4 + (r() - 0.5) * 0.12);
    const look: Look = { seed: mix(it.seed, 9), color: it.color, weight: 0.55, opacity: 0.75, straight: true, solid: false };
    lines.forEach(([p, q], i) => {
      // The hand stops a little short of the outline.
      const d = g.unit(g.sub(q, p));
      const inset = Math.min(1.5, g.dist(p, q) / 4);
      stroke([g.add(p, g.mul(d, inset)), g.sub(q, g.mul(d, inset))], look, i);
    });
  }

  if (scene.title) label(scene.title, fs * 1.05, [{ x: width / 2, y: fs * 0.25, ax: 0.5, ay: 0 }], mix(base, 31), undefined, true);

  return { width, height: fr.height, paths, labels, obstacles, empty: !items.length && !scene.title && !fr.axes };
}

/** Labels to their places: the first spot that covers no line and no other label. */
export function placeLabels(layout: SketchLayout, inks: LabelInk[]): PlacedLabel[] {
  const cell = 12;
  const grid = new Map<string, Vec[]>();
  for (const p of layout.obstacles) {
    const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
    const list = grid.get(key);
    if (list) list.push(p);
    else grid.set(key, [p]);
  }
  const hits = (b: g.Rect) => {
    let n = 0;
    for (let cx = Math.floor(b.x0 / cell); cx <= Math.floor(b.x1 / cell); cx++) {
      for (let cy = Math.floor(b.y0 / cell); cy <= Math.floor(b.y1 / cell); cy++) {
        for (const p of grid.get(`${cx},${cy}`) ?? []) if (p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1) n++;
      }
    }
    return n;
  };
  const area = (b: g.Rect) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const overlap = (a: g.Rect, b: g.Rect) =>
    area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
  const taken: g.Rect[] = [];
  const out: PlacedLabel[] = [];
  const order = layout.labels.map((_, i) => i).sort((a, b) => Number(!!layout.labels[b].fixed) - Number(!!layout.labels[a].fixed));
  for (const i of order) {
    const req = layout.labels[i];
    const ink = inks[i];
    const s = req.size / 1000;
    const w = (ink.x1 - ink.x0) * s;
    const h = (ink.y1 - ink.y0) * s;
    if (w <= 0 || h <= 0) continue;
    let best: g.Rect | null = null;
    let bestCost = Infinity;
    req.spots.forEach((sp, k) => {
      if (req.fixed && k > 0) return;
      const box = { x0: sp.x - sp.ax * w, y0: sp.y - sp.ay * h, x1: sp.x - sp.ax * w + w, y1: sp.y - sp.ay * h + h };
      const a = area(box);
      const inside = overlap(box, { x0: 0, y0: 0, x1: layout.width, y1: layout.height });
      const crowd = taken.reduce((sum, t) => sum + overlap(box, t), 0);
      const cost = k * 0.6 + 3 * hits({ x0: box.x0 - 1.5, y0: box.y0 - 1.5, x1: box.x1 + 1.5, y1: box.y1 + 1.5 }) + (30 * crowd) / a + (25 * (a - inside)) / a;
      if (cost < bestCost) {
        bestCost = cost;
        best = box;
      }
    });
    if (!best) continue;
    const b: g.Rect = best;
    taken.push(b);
    out.push({ ink, x: b.x0 - ink.x0 * s, y: b.y0 - ink.y0 * s, scale: s, color: req.color });
  }
  return out;
}
