// From a scene to ink on paper: the window and the scale, the hand-drawn
// lines, and where every label goes so that it does not sit on a line.
import { romanize } from '../blank/roman';
import { hasGlyph } from '../engine/handwriting';
import { convertMathInText, convertTex, type MathRun } from '../editor/tex';
import * as g from './geometry';
import type { LabelInk } from './labels';
import { formatNumber } from './lang';
import { dashes, dot, hatch, outline, rng, wobble, type Pen } from './pen';
import { dealPointMarks, evenly } from './pointInk';
import type { Hatching, Item, Scene, Shape, Vec } from './types';

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
  /** How much worse than the best place this one is (default: its index × 0.6). */
  cost?: number;
}

export interface LabelRequest {
  runs: MathRun[];
  /** Letter size, px per em. */
  size: number;
  color?: string;
  seed: number;
  /** Places to choose from, best first. */
  spots: Spot[];
  /** Keeps to its first spot unless that one covers a line (axis numbers, texts, the title). */
  fixed?: boolean;
}

/** Where the needle of the compasses went in: a circle's or an arc's centre, px, and the radius drawn from it. */
export interface Pivot {
  x: number;
  y: number;
  r: number;
}

export interface SketchLayout {
  width: number;
  height: number;
  paths: InkPath[];
  labels: LabelRequest[];
  /** Points along every drawn line: labels keep clear of them. */
  obstacles: Vec[];
  /** Every drawn line as the hand moved (px, before its wobble; not the grid): where the paper got rubbed. */
  lines: Vec[][];
  /** Centres of what was drawn with compasses. */
  pivots: Pivot[];
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

/** From this radius on (mm) circles and arcs are drawn with compasses. */
const COMPASS_MIN = 6;

/** CSS px per millimetre (the sheet's own scale). */
const PX_MM = 96 / 25.4;
/** Room around what a drawing on a blank shows (its labels, lines run on), mm. */
const BLANK_PAD = 8;

/**
 * A drawing on a blank (НаБланке): the box it takes on the sheet, sheet px —
 * what it shows, with room round it — and the origin's place in sheet px.
 */
export function blankBoxOf(scene: Scene): { x: number; y: number; w: number; h: number; ox: number; oy: number; ppu: number } | null {
  const b = scene.view.blank;
  if (!b) return null;
  const ppu = PX_MM * b.unit;
  const ox = b.x * PX_MM;
  const oy = b.y * PX_MM;
  const pts = scene.items
    .filter((i) => !i.hidden)
    .flatMap((i) => g.extentPoints(i.shape))
    .filter(finite)
    .map((p) => ({ x: ox + p.x * ppu, y: oy - p.y * ppu }));
  if (!pts.length) pts.push({ x: ox, y: oy });
  const pad = BLANK_PAD * PX_MM;
  const x = Math.min(...pts.map((p) => p.x)) - pad;
  const y = Math.min(...pts.map((p) => p.y)) - pad;
  const w = Math.max(...pts.map((p) => p.x)) + pad - x;
  const h = Math.max(...pts.map((p) => p.y)) + pad - y;
  return { x, y, w, h, ox, oy, ppu };
}

/** The window, the scale and the size of a drawing `width` px wide (on a blank: of its own size, by the sheet). */
function frameOf(scene: Scene, width: number, fs: number): Frame {
  const box = blankBoxOf(scene);
  if (box) {
    return {
      width: box.w,
      height: box.h,
      rect: { x0: 0, y0: 0, x1: box.w, y1: box.h },
      x: [(box.x - box.ox) / box.ppu, (box.x + box.w - box.ox) / box.ppu],
      y: [(box.oy - box.y - box.h) / box.ppu, (box.oy - box.y) / box.ppu],
      ppx: box.ppu,
      ppy: box.ppu,
      axes: false,
      grid: scene.view.grid ?? false,
      xPi: false,
      yPi: false,
    };
  }
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

/** Where the drawing `width` px wide puts the origin (px from its top-left), how wide its plot is, and px per unit along x and y. */
export function sketchScale(scene: Scene, width: number, fs: number): { height: number; plotW: number; ox: number; oy: number; ppx: number; ppy: number } {
  const fr = frameOf(scene, width, fs);
  return { height: fr.height, plotW: fr.rect.x1 - fr.rect.x0, ox: fr.rect.x0 - fr.x[0] * fr.ppx, oy: fr.rect.y1 + fr.y[0] * fr.ppy, ppx: fr.ppx, ppy: fr.ppy };
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
  ].map((s, i) => ({ ...s, cost: i * 0.6 }));
}

/**
 * Further places around a point, for crowded corners: three more rings of
 * twelve directions. The label's box always opens away from the point.
 */
function ringsAround(p: Vec, gap: number): Spot[] {
  const out: Spot[] = [];
  [2.1, 3.2, 4.6].forEach((k, ring) => {
    for (let i = 0; i < 12; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 6;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const side = (v: number) => 0.5 - 0.5 * Math.sign(v) * Math.min(1, Math.abs(v) * 1.6);
      out.push({ x: p.x + c * gap * k, y: p.y - s * gap * k, ax: side(c), ay: 1 - side(s), cost: 5 + ring * 2.5 + i * 0.05 });
    }
  });
  return out;
}

/** Places beside a drawn line, at the given shares of its length (nearer first, then further off). */
function alongLine(pieces: Vec[][], shares: number[], gap: number): Spot[] {
  const all = pieces.flat();
  if (all.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < all.length; i++) cum.push(cum[i - 1] + g.dist(all[i - 1], all[i]));
  const total = cum[cum.length - 1];
  const out: Spot[] = [];
  [1, 2, 3.2].forEach((k, far) => {
    shares.forEach((share, j) => {
      const at = total * share;
      const i = Math.max(1, cum.findIndex((c) => c >= at));
      aroundPoint(all[Math.min(i, all.length - 1)], gap * k)
        .slice(0, 4)
        .forEach((s, n) => out.push({ ...s, cost: far * 4 + (j * 4 + n) * 0.6 }));
    });
  });
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

/** A disc a line does not cross: an open point. */
interface Hole {
  c: Vec;
  r: number;
  /** Radius of the ring drawn round it, px. */
  ring: number;
  seed: number;
}

/**
 * The parts of a polyline outside the holes. `reach`: how far from a hole's
 * centre this line stops as it comes in (`entering`) and starts again as it
 * goes out — each end of a line meets an open point its own way; 0 or less:
 * the line runs through.
 */
function outsideHoles(pts: Vec[], holes: Hole[], reach?: (h: Hole, entering: boolean) => number): Vec[][] {
  if (!holes.length) return [pts];
  const out: Vec[][] = [];
  let cur: Vec[] = [];
  const at = (p: Vec, q: Vec, t: number): Vec => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  // A line that ends at an open point meets it once: that end's reach holds for the whole way in
  // (else a bit run past the centre could show on its own).
  const [first, last] = [pts[0], pts[pts.length - 1]];
  const into = holes.map((h) => (reach ? reach(h, true) : h.r));
  const outOf = holes.map((h, k) => (reach ? reach(h, false) : into[k]));
  const once = holes.map((h, k) => (g.dist(last, h.c) < h.r ? into[k] : g.dist(first, h.c) < h.r ? outOf[k] : null));
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    const d = g.sub(q, p);
    const dd = g.dot(d, d);
    // Where along p→q the segment is inside a hole: intervals of t, merged.
    const inside: [number, number][] = [];
    for (const [k, h] of holes.entries()) {
      if (dd < 1e-12) continue;
      const f = g.sub(p, h.c);
      const hr = once[k] ?? (g.dot(d, g.sub(h.c, at(p, q, 0.5))) > 0 ? into[k] : outOf[k]);
      if (hr <= 0.5) continue;
      const b = g.dot(f, d);
      const disc = b * b - dd * (g.dot(f, f) - hr * hr);
      if (disc <= 0) continue;
      const t0 = (-b - Math.sqrt(disc)) / dd;
      const t1 = (-b + Math.sqrt(disc)) / dd;
      if (t1 > 0 && t0 < 1) inside.push([Math.max(0, t0), Math.min(1, t1)]);
    }
    inside.sort((u, v) => u[0] - v[0]);
    if (!cur.length) cur.push(p);
    let t = 0;
    for (const [a, b] of inside) {
      if (b <= t) continue;
      if (a > t) cur.push(at(p, q, a));
      if (cur.length > 1) out.push(cur);
      cur = [];
      t = b;
    }
    if (t < 1) {
      if (!cur.length) cur.push(at(p, q, t));
      cur.push(q);
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
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
  const lines: Vec[][] = [];
  const pivots: Pivot[] = [];
  const items = scene.items.filter((i) => !i.hidden);
  // Compasses: an even line — the lead goes round the needle, the hand only turns the head.
  const compassPen: Pen = { ...pen, wobble: (pen.wobble ?? 1) * 0.06, jitter: pen.jitter * 0.3, pressure: pen.pressure * 0.25 };
  const byCompass = (rPx: number) => (!!scene.view.blank || pen.compass === true) && rPx >= COMPASS_MIN * PX_MM;
  const base = items.reduce((h, it) => mix(h, it.seed), mix(2166136261, scene.title ? scene.title.length : 0));
  const gap = fs * 0.22;
  const dashUnit = Math.max(1.3, pen.width);
  const view: g.Rect = { x0: rect.x0 - 1, y0: rect.y0 - 1, x1: rect.x1 + 1, y1: rect.y1 + 1 };
  const inView = (p: Vec, m = 0) => p.x >= rect.x0 - m && p.x <= rect.x1 + m && p.y >= rect.y0 - m && p.y <= rect.y1 + m;
  /** One millimetre on the sheet for a drawing on a blank, else a share of the letters. */
  const mmOr = (mm: number, ofFs: number) => (scene.view.blank ? mm * PX_MM : fs * ofFs);
  const ppu = (fr.ppx + fr.ppy) / 2;
  const pointRadius = (it: Item) => Math.max(1.8, pen.width * 1.1 + fs * 0.05) * Math.sqrt(it.thickness / 5);
  const unevenPoints = pen.points ?? 1;
  const unevenJoins = pen.joins ?? 1;
  /** The variants the user drew of the points, one for each point that has any. */
  const pointMarks = dealPointMarks(items, !unevenPoints);
  /**
   * How the hand put a point down (the same every time: its seed): a little
   * bigger or smaller, an open ring a little oval and off the exact spot.
   * `ring`: radius of an open point's ring; `r` goes on for the rest of its look.
   * `drawn`: a variant the user drew, at the size it has beside the letters,
   * a little turned and bigger or smaller, so that it never repeats exactly.
   */
  const handPoint = (it: Item) => {
    const r = rng(mix(it.seed, 0x9017));
    const a = unevenPoints;
    const p = T((it.shape as Extract<Shape, { type: 'point' }>).p);
    const radius = pointRadius(it) * (1 + a * (r() * 0.35 - 0.15));
    const ratio = 1 + a * (r() - 0.5) * 0.2;
    const rot = a ? r() * Math.PI : 0;
    const off = a * r() * radius * (it.pointStyle === 2 ? 1.7 * 0.25 : 0.15);
    const c = g.add(p, g.mul(g.dir(r() * Math.PI * 2), off));
    const mark = pointMarks.get(it);
    let drawn: { strokes: Vec[][]; center: Vec; ring: number; reach: number } | undefined;
    if (mark) {
      const size = (fs / 1000) * Math.sqrt(it.thickness / 5) * (1 + a * (r() * 0.2 - 0.1));
      const turn = a * (r() - 0.5) * 0.3;
      const place = (q: Vec) => g.add(c, g.mul(g.rotate(q, turn), size));
      const step = Math.max(0.5, pen.width * 0.35);
      drawn = { strokes: mark.strokes.map((s) => evenly(s.map(place), step)), center: place(mark.center), ring: mark.ring * size, reach: mark.reach * size };
    }
    return { p, c, off, radius, ring: radius * 1.7, ratio, rot, r, drawn };
  };
  const air = pen.width * 0.5 + 0.15 * PX_MM;
  // Open points first: no line runs through them, whatever is drawn before them.
  const holes: Hole[] = items
    .filter((it) => it.shape.type === 'point' && it.pointStyle === 2)
    .map((it) => {
      const h = handPoint(it);
      if (h.drawn) return { c: h.drawn.center, r: h.drawn.reach + air, ring: h.drawn.ring, seed: it.seed };
      return { c: h.c, r: h.ring * Math.max(1, h.ratio) + air, ring: h.ring, seed: it.seed };
    })
    .filter((h) => inView(h.c, 2));

  interface Look {
    seed: number;
    color?: string;
    style?: number;
    weight?: number;
    straight?: boolean;
    opacity?: number;
    /** Labels keep clear of it (not of the grid). */
    solid?: boolean;
    /** Drawn whole even across open points (their own circles). */
    whole?: boolean;
    /** Drawn with compasses. */
    compass?: boolean;
  }
  const stroke = (pts: Vec[], look: Look, salt = 0) => {
    if (pts.length < 2) return;
    const lineSeed = mix(look.seed, salt + 1);
    const r = rng(lineSeed);
    const hand = look.compass ? compassPen : pen;
    const center = wobble(pts, r, hand, { straight: look.straight });
    // Where this line stops at an open point: short of the ring, on it, inside it, or nearly at the centre.
    const reach = (h: Hole, entering: boolean) => {
      if (!unevenJoins) return h.r;
      const rr = rng(mix(mix(lineSeed, h.seed), entering ? 1 : 2));
      const [u, v] = [rr(), rr()];
      const target =
        u < 0.3
          ? h.r + (0.1 + 0.5 * v) * PX_MM
          : u < 0.55
            ? h.ring + pen.width * (0.2 + 0.6 * v)
            : u < 0.9
              ? h.ring * (0.35 + 0.4 * v)
              : h.ring * 0.15 * v;
      return h.r + (target - h.r) * unevenJoins;
    };
    const d = (look.whole ? [center] : outsideHoles(center, holes, reach))
      .flatMap((piece) => dashes(piece, look.style ?? 0, dashUnit))
      .map((p) => outline(p, r, hand, look.weight ?? 1))
      .join('');
    if (d) paths.push({ d, color: look.color, opacity: look.opacity });
    if (look.solid !== false) {
      for (let i = 0; i < center.length; i += 2) obstacles.push(center[i]);
      lines.push(pts);
    }
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
      // Below the axis; above it when a line runs there.
      label(t.text, fs * 0.58, [{ x, y: ay + fs * 0.3, ax: 0.5, ay: 0 }, { x, y: ay - fs * 0.3, ax: 0.5, ay: 1 }], mix(base, 1000 + i), undefined, true);
    });
    yt.forEach((t, i) => {
      const y = Y(t.v);
      if (Math.abs(t.v) < 1e-9 && originShown) return;
      if (y < rect.y0 + 2 || y > rect.y1 - 2) return;
      stroke([{ x: ax - fs * 0.14, y }, { x: ax + fs * 0.14, y }], tick, 200 + i);
      label(t.text, fs * 0.58, [{ x: ax - fs * 0.3, y, ax: 1, ay: 0.5 }, { x: ax + fs * 0.3, y, ax: 0, ay: 0.5 }], mix(base, 2000 + i), undefined, true);
    });
    if (originShown) label('0', fs * 0.58, [{ x: ax - fs * 0.22, y: ay + fs * 0.22, ax: 1, ay: 0 }], mix(base, 23), undefined, true);
  }

  // ---- the epure: axis x₁₂ (or x, y, z with a profile projection), the origin O — printed already on a blank
  if (scene.view.epure && !scene.view.blank) {
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
  /** Labels of points, written once all points are known (points in one place share a label). */
  const pointLabels: { p: Vec; radius: number; caption: string; seed: number; color?: string }[] = [];
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
        if (!inView(T(s.p), 2)) break;
        points.push(() => {
          const hp = handPoint(it);
          const { p, c, ratio, rot } = hp;
          const a = unevenPoints;
          const hr = hp.r;
          let radius = hp.radius;
          const mark: Look = { seed: it.seed, color: it.color, weight: 0.9 * (1 + a * (hr() * 0.25 - 0.17)), straight: true, whole: true };
          if (hp.drawn) {
            // As the user drew it, in the drawing's pen: the hand has done its shaking already.
            const r = rng(mix(it.seed, 21));
            radius = hp.drawn.reach;
            for (const s of hp.drawn.strokes) {
              if (s.length < 2) {
                paths.push({ d: dot(s[0], pen.width * 0.55, r), color: it.color });
                continue;
              }
              paths.push({ d: outline(s, r, pen, mark.weight), color: it.color });
              lines.push(s);
            }
          } else if (it.pointStyle === 2) {
            // An open circle by pen: it starts anywhere and runs a little past its start or stops just short —
            // by hand also a little oval, and now and then its ends miss each other in a small loop.
            const r = rng(mix(it.seed, 21));
            radius = hp.ring;
            const from = r() * Math.PI * 2;
            const sweep = Math.PI * 2 + (r() - 0.4) * 0.35 + a * (hr() * 0.7 - 0.3);
            const drift = a * (hr() < 0.15 ? 0.08 + 0.06 * hr() : 0.04 * hr()) * (hr() < 0.5 ? -1 : 1);
            const [cr, sr] = [Math.cos(rot), Math.sin(rot)];
            const ring = Array.from({ length: 21 }, (_, i) => {
              const t = from + (sweep * i) / 20;
              const R = radius * (1 + (drift * i) / 20);
              const [lx, ly] = [Math.cos(t - rot) * R, Math.sin(t - rot) * R * ratio];
              return { x: c.x + lx * cr - ly * sr, y: c.y + lx * sr + ly * cr };
            });
            stroke(ring, { ...mark, straight: false }, 0);
          } else if (it.pointStyle === 1 || it.pointStyle === 3) {
            // A cross × or a plus +: two short strokes, by hand a little turned, the arms not quite equal.
            radius *= 1.6;
            const turn = (it.pointStyle === 1 ? Math.PI / 4 : 0) + a * (hr() - 0.5) * 0.28;
            for (const k of [0, 1]) {
              const d = g.dir(turn + (k * Math.PI) / 2);
              const [l0, l1] = [radius * (1 + a * (hr() - 0.5) * 0.4), radius * (1 + a * (hr() - 0.5) * 0.4)];
              stroke([g.sub(c, g.mul(d, l0)), g.add(c, g.mul(d, l1))], mark, k);
            }
          } else {
            const stretch = a ? { angle: hr() * Math.PI * 2, by: 1 + a * 0.3 * hr() } : undefined;
            paths.push({ d: dot(c, radius, rng(it.seed), stretch), color: it.color });
          }
          // Labels keep clear of the ring wherever the hand put it.
          radius += hp.off;
          obstacles.push(p, { x: p.x - radius, y: p.y }, { x: p.x + radius, y: p.y }, { x: p.x, y: p.y - radius }, { x: p.x, y: p.y + radius });
          if (it.showLabel && caption.trim()) pointLabels.push({ p, radius, caption, seed: lseed, color: it.color });
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
        const rPx = s.r * ppu;
        const compass = byCompass(rPx);
        let from: number;
        let sweep: number;
        let drift: number;
        if (compass) {
          // Compasses: a full turn and 5–20° more, the lead slipping 0.1–0.2 mm on the way (a step where it closes);
          // an arc runs on 1–3 mm past both its ends, as notches are drawn.
          const past = full ? 0 : ((1 + 2 * r()) * PX_MM) / rPx;
          const dirn = s.type === 'circle' ? 1 : Math.sign(s.sweep) || 1;
          from = s.type === 'circle' ? r() * Math.PI * 2 : s.from - dirn * past;
          sweep = s.type === 'circle' ? Math.PI * 2 + ((5 + 15 * r()) * Math.PI) / 180 : s.sweep + dirn * (past + ((1 + 2 * r()) * PX_MM) / rPx);
          drift = full ? ((r() < 0.5 ? -1 : 1) * (0.1 + 0.1 * r()) * PX_MM) / ppu : 0;
          const c = T(s.c);
          pivots.push({ x: c.x, y: c.y, r: rPx });
        } else {
          // A hand-drawn circle starts anywhere, runs a little past its start and does not quite close.
          from = full ? r() * Math.PI * 2 : s.from;
          sweep = full ? Math.PI * 2 + 0.15 + r() * 0.25 : s.sweep;
          drift = full ? ((r() - 0.5) * 3) / fr.ppx : 0;
        }
        const n = Math.max(24, Math.ceil((Math.abs(sweep) * s.r * Math.max(fr.ppx, fr.ppy)) / 4));
        const world: Vec[] = [];
        for (let i = 0; i <= n; i++) world.push(g.add(s.c, g.mul(g.dir(from + (sweep * i) / n), s.r + (drift * i) / n)));
        g.clipPolyline(world.map(T), view).forEach((piece, i) => {
          pieces.push(piece);
          stroke(piece, { ...look, straight: false, compass }, i);
        });
        if (full && (it.filling > 0 || it.hatch)) fill(Array.from({ length: 64 }, (_, i) => T(g.add(s.c, g.mul(g.dir((i / 64) * Math.PI * 2), s.r)))), it);
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
        if (it.filling > 0 || it.hatch) fill(pts, it);
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
      case 'region': {
        fill(s.pts.map(T), it, s.hatch);
        if (it.showLabel && caption.trim()) {
          const pts = s.pts.map(T);
          const c = pts.reduce((acc, q) => g.add(acc, g.mul(q, 1 / pts.length)), { x: 0, y: 0 });
          label(caption, fs * 0.85, [{ x: c.x, y: c.y, ax: 0.5, ay: 0.5 }], lseed, it.color);
        }
        break;
      }
      case 'hatched': {
        const a = T(s.a);
        const b = T(s.b);
        const range = s.of === 'line' ? [-Infinity, Infinity] : s.of === 'ray' ? [0, Infinity] : [0, 1];
        const c = g.clipLine(a, g.sub(b, a), range[0], range[1], view);
        if (!c) break;
        if (s.line) draw(c, true, 0);
        const u = g.unit(g.sub(c[1], c[0]));
        let n = g.perp(u);
        if (g.dot(g.sub(T(s.side), c[0]), n) < 0) n = g.mul(n, -1);
        // Ticks at 45° to the line, leaning the same way, as drawn by hand one after another.
        const tick = g.unit(g.add(n, u));
        const len = s.len ? s.len * ppu : mmOr(1.5, 0.45);
        const step = s.gap ? s.gap * ppu : mmOr(2, 0.5);
        const total = g.dist(c[0], c[1]);
        const r = rng(mix(it.seed, 13));
        const tickLook: Look = { ...look, style: 0, weight: (look.weight ?? 1) * 0.8, straight: true };
        let k = 0;
        for (let t = step * (0.3 + 0.4 * r()); t < total - step * 0.2; t += step * (0.9 + 0.2 * r())) {
          const from = g.add(c[0], g.mul(u, t));
          const dir = g.rotate(tick, (r() - 0.5) * 0.1);
          stroke([from, g.add(from, g.mul(dir, len * (0.85 + 0.3 * r())))], tickLook, 10 + k++);
        }
        if (it.showLabel && s.line) label(caption, fs * 0.85, alongLine(pieces, [0.5, 0.35, 0.65, 0.2, 0.8], gap), lseed, it.color);
        break;
      }
      case 'text': {
        const at = s.at ? T(s.at) : { x: rect.x0 + fs * 0.2, y: rect.y0 + fs * (0.9 + 1.1 * texts++) };
        // A text may hold Roman numerals (I, II чверть): written as sticks.
        label(romanize(s.text, [], hasGlyph), fs * 0.85, [{ x: at.x, y: at.y, ax: 0, ay: 1 }], lseed, it.color, true);
        break;
      }
    }
  }
  points.forEach((p) => p());
  // Points drawn in one place (A₂ and B₂ of a projecting line, Qx₁ and Qx₂)
  // get one label, «A₂ ≡ B₂» as in textbooks, instead of two on top of each other.
  const groups: (typeof pointLabels)[] = [];
  for (const pl of pointLabels) {
    const near = groups.find((grp) => g.dist(grp[0].p, pl.p) < Math.max(3, pen.width * 2));
    if (near) near.push(pl);
    else groups.push([pl]);
  }
  for (const grp of groups) {
    const radius = Math.max(...grp.map((x) => x.radius));
    const captions = [...new Set(grp.map((x) => x.caption))];
    const colors = new Set(grp.map((x) => x.color));
    const spots = [...aroundPoint(grp[0].p, gap + radius * 0.5), ...ringsAround(grp[0].p, gap + radius * 0.5)];
    label(captions.join(' ≡ '), fs * 0.9, spots, grp[0].seed, colors.size === 1 ? grp[0].color : undefined);
  }

  /** Hatching inside a polygon (px): SetFilling's, or Hatch's with its direction and spacing. */
  function fill(poly: Vec[], it: Item, own?: Hatching) {
    const r = rng(mix(it.seed, 5));
    const h = own ?? it.hatch;
    // A direction of the drawing becomes one on the sheet (y down, the units' own scale).
    const angle = h ? Math.atan2(-Math.sin(h.angle) * fr.ppy, Math.cos(h.angle) * fr.ppx) : Math.PI / 4;
    const step = h ? (h.gap ? h.gap * ppu : mmOr(2, 0.4)) : fs * (0.5 - 0.32 * it.filling);
    const look: Look = { seed: mix(it.seed, 9), color: it.color, weight: 0.55, opacity: 0.75, straight: true, solid: false };
    const families = h?.cross ? [angle, angle + Math.PI / 2] : [angle];
    let i = 0;
    for (const a of families) {
      for (const [p0, q0] of hatch(poly, Math.max(step, pen.width * 1.5), a + (r() - 0.5) * 0.04, r)) {
        const c = g.clipLine(p0, g.sub(q0, p0), 0, 1, view);
        if (!c) continue;
        const [p, q] = c;
        // The hand mostly stops a little short of the outline, sometimes runs a hair past it.
        const d = g.unit(g.sub(q, p));
        const room = g.dist(p, q) / 4;
        const end = () => Math.min(room, fs * (r() < 0.25 ? -0.05 * r() : 0.03 + 0.09 * r()));
        stroke([g.add(p, g.mul(d, end())), g.sub(q, g.mul(d, end()))], look, i++);
      }
    }
  }

  if (scene.title) label(scene.title, fs * 1.05, [{ x: width / 2, y: fs * 0.25, ax: 0.5, ay: 0 }], mix(base, 31), undefined, true);

  return { width, height: fr.height, paths, labels, obstacles, lines, pivots, empty: !items.length && !scene.title && !fr.axes };
}

/** What else lies under a box of a drawing (its px) — on a blank, the sheet around it. */
export interface Around {
  /** Points of lines and printing under the box: a label crosses them only when it must. */
  hits(box: g.Rect): number;
  /** Share of the box under what a label is never written over: printed letters and points, notes, other labels. */
  covered(box: g.Rect): number;
}

/**
 * Labels to their places: for each, the spot that covers no line and no
 * other label, the nearest such one. Fixed labels (axis numbers, texts, the
 * title) go first and leave their spot only when it covers a line; then the
 * labels with the fewest free spots, so a crowded point gets its place before
 * an easy one takes it. A label never lies on another one (or on printed
 * letters) while any spot is free of them: running further out, or across a
 * line, is always better than letters written over letters.
 */
export function placeLabels(layout: SketchLayout, inks: LabelInk[], around?: Around): PlacedLabel[] {
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
  // Any line through a label is worse than moving it a ring further out.
  const LINE = 10;
  const PER_HIT = 4;
  /** However many lines a label crosses, it costs no more than this many: letters over letters always cost more. */
  const MAX_HITS = 15;
  // Letters over letters (another label, a printed «C₁»): worse than any line.
  const ON_TEXT = LINE + PER_HIT * MAX_HITS;
  const pad = 2;
  /** Labels keep a little air between each other and from printed letters. */
  const apart = 4;
  const grow = (b: g.Rect, by: number) => ({ x0: b.x0 - by, y0: b.y0 - by, x1: b.x1 + by, y1: b.y1 + by });
  /** Cost of a box whose `core` share lies under letters, `near` share of its air around. */
  const onText = (core: number, near: number) => (core > 1e-3 ? ON_TEXT + 400 * core : 0) + (near > 1e-3 ? 8 + 40 * near : 0);
  const boxes = layout.labels.map((req, i) => {
    const s = req.size / 1000;
    const ink = inks[i];
    const w = (ink.x1 - ink.x0) * s;
    const h = (ink.y1 - ink.y0) * s;
    return req.spots.map((sp, k) => {
      const box = { x0: sp.x - sp.ax * w, y0: sp.y - sp.ay * h, x1: sp.x - sp.ax * w + w, y1: sp.y - sp.ay * h + h };
      const padded = grow(box, pad);
      const n = w > 0 && h > 0 ? hits(padded) + (around ? around.hits(padded) : 0) : 0;
      const text = around && w > 0 && h > 0 ? onText(around.covered(box), around.covered(grow(box, apart))) : 0;
      const a = Math.max(area(box), 1e-6);
      const inside = overlap(box, { x0: 0, y0: 0, x1: layout.width, y1: layout.height });
      const order = req.fixed ? (k === 0 ? 0 : 12 + k) : sp.cost ?? k * 0.6;
      return { box, base: order + (n ? LINE + PER_HIT * Math.min(n, MAX_HITS) : 0) + text + (25 * (a - inside)) / a };
    });
  });
  // Hardest first: the label whose best spot (ignoring other labels) is worst.
  const hardness = boxes.map((c) => Math.min(...c.map((x) => x.base), Infinity));
  const order = layout.labels
    .map((_, i) => i)
    .sort((a, b) => Number(!!layout.labels[b].fixed) - Number(!!layout.labels[a].fixed) || hardness[b] - hardness[a] || a - b);
  for (const i of order) {
    const req = layout.labels[i];
    const ink = inks[i];
    const s = req.size / 1000;
    if (ink.x1 - ink.x0 <= 0 || ink.y1 - ink.y0 <= 0) continue;
    let best: g.Rect | null = null;
    let bestCost = Infinity;
    for (const { box, base } of boxes[i]) {
      const a = Math.max(area(box), 1e-6);
      const air = grow(box, apart);
      const core = taken.reduce((sum, t) => sum + overlap(box, t), 0) / a;
      const near = taken.reduce((sum, t) => sum + overlap(air, t), 0) / Math.max(area(air), 1e-6);
      const cost = base + onText(core, near);
      if (cost < bestCost) {
        bestCost = cost;
        best = box;
      }
    }
    if (!best) continue;
    const b: g.Rect = best;
    taken.push(b);
    out.push({ ink, x: b.x0 - ink.x0 * s, y: b.y0 - ink.y0 * s, scale: s, color: req.color });
  }
  return out;
}
