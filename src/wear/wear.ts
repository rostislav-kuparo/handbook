// Traces of work on a sheet: graphite rubbed off the lines by the hand,
// what is left of a rubbed-out line, crumbs of lead, and the holes the
// compasses' needle left. All of it from where the sheet really has letters,
// lines and circles (the work map), the same way every time for one sheet.
import { MM, type SheetSize } from '../editor/page';
import { rng, type Rand } from '../sketch/pen';
import type { Vec } from '../sketch/types';

/** How the traces look; one set for the whole program (the render settings). */
export interface WearSettings {
  on: boolean;
  /** 0 — none, 1 — as usual, 2 — a grubby piece of work: how many smudges and how dark. */
  smudge: number;
  /** Size of the smudges, × (0.5…2). */
  size: number;
  /** Rubbed-out lines per sheet (0…3). */
  erasers: number;
  /** The hand drags graphite with the writing: to the right (right hand) or to the left. */
  hand: 'right' | 'left';
  /** Holes of the compasses' needle at the centres of circles and arcs. */
  holes: boolean;
  /** How deep the holes are, × (0.5…2). */
  depth: number;
  /** «↺ другие следы». */
  seed: number;
  /** Creases where the hand dragged the sheet: 0 — none, 1 — a few soft ones, 2 — a crumpled sheet. */
  folds: number;
  /** Now and then a sharp fold too. */
  sharp: boolean;
  /** How worn the printer is that printed the blank. */
  printer: PrinterKind;
  /** «↺ другой принтер». */
  printerSeed: number;
  /** What the rendered sheets show (and the files get): the stages of the render one by one. */
  show: LayerShow;
}

export type PrinterKind = 'new' | 'usual' | 'tired';

/** The parts of a rendered sheet that can be left out to see what is under them. */
export interface LayerShow {
  print: boolean;
  drawings: boolean;
  text: boolean;
  wear: boolean;
  folds: boolean;
}

export const SHOW_ALL: LayerShow = { print: true, drawings: true, text: true, wear: true, folds: true };

export const DEFAULT_WEAR: WearSettings = {
  on: false,
  smudge: 1,
  size: 1,
  erasers: 1,
  hand: 'right',
  holes: true,
  depth: 1,
  seed: 1,
  folds: 1,
  sharp: false,
  printer: 'usual',
  printerSeed: 1,
  show: SHOW_ALL,
};

export function wearOf(raw: unknown): WearSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<WearSettings>;
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d);
  return {
    on: typeof o.on === 'boolean' ? o.on : DEFAULT_WEAR.on,
    smudge: num(o.smudge, 0, 2, DEFAULT_WEAR.smudge),
    size: num(o.size, 0.5, 2, DEFAULT_WEAR.size),
    erasers: Math.round(num(o.erasers, 0, 3, DEFAULT_WEAR.erasers)),
    hand: o.hand === 'left' ? 'left' : 'right',
    holes: typeof o.holes === 'boolean' ? o.holes : DEFAULT_WEAR.holes,
    depth: num(o.depth, 0.5, 2, DEFAULT_WEAR.depth),
    seed: Math.round(num(o.seed, 0, 1e9, DEFAULT_WEAR.seed)),
    folds: num(o.folds, 0, 2, DEFAULT_WEAR.folds),
    sharp: typeof o.sharp === 'boolean' ? o.sharp : DEFAULT_WEAR.sharp,
    printer: o.printer === 'new' || o.printer === 'tired' ? o.printer : 'usual',
    printerSeed: Math.round(num(o.printerSeed, 0, 1e9, DEFAULT_WEAR.printerSeed)),
    show: Object.fromEntries(Object.keys(SHOW_ALL).map((k) => [k, (o.show as Partial<LayerShow> | undefined)?.[k as keyof LayerShow] !== false])) as unknown as LayerShow,
  };
}

/** A line on the sheet (sheet px): of a drawing in pencil or pen, or a pen stroke of the letters. */
export interface WorkLine {
  pts: Vec[];
  kind: 'pencil' | 'pen' | 'letter';
}

/** What was done on one sheet. */
export interface WorkMap {
  lines: WorkLine[];
  /** Centres of circles and arcs drawn with compasses (one entry per circle). */
  pivots: Vec[];
}

export const emptyWork = (): WorkMap => ({ lines: [], pivots: [] });

/** Pixels per sheet px of the traces' picture (about 290 dpi: a needle hole is a few pixels). */
export const WEAR_SCALE = 3;

/** Graphite of a school pencil. */
const LEAD = '72,74,82';
/** How much the hand smears each kind of line (a pen's ink hardly). */
const RUB: Record<WorkLine['kind'], number> = { pencil: 1, pen: 0.45, letter: 0.35 };

const mix = (a: number, b: number) => Math.imul(a ^ b, 16777619) >>> 0;

function lengthOf(pts: Vec[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s;
}

/** The part of a polyline from distance a to b along it. */
function piece(pts: Vec[], a: number, b: number): Vec[] {
  const out: Vec[] = [];
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    const at = (t: number) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    if (s + d >= a && s <= b) {
      if (!out.length) out.push(at(d > 0 ? Math.max(0, (a - s) / d) : 0));
      out.push(at(d > 0 ? Math.min(1, (b - s) / d) : 1));
    }
    s += d;
  }
  return out;
}

const canvasOf = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
};

/**
 * The traces of one sheet as a transparent picture `scale` times the sheet's
 * pixels: graphite and the shading of the holes. `light`: the direction the
 * light comes from on the sheet (y down); from the top left unless known.
 */
export function wearCanvas(work: WorkMap, size: SheetSize, scale: number, w: WearSettings, seed: number, light: Vec = { x: -0.6, y: -0.8 }): HTMLCanvasElement {
  const canvas = canvasOf(size.w * scale, size.h * scale);
  if (!w.on) return canvas;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  const r = rng(mix(seed, mix(w.seed, 0x5eed)));
  const ll = Math.hypot(light.x, light.y) || 1;
  const L = { x: light.x / ll, y: light.y / ll };

  // Where the work is: points every 3 mm along the lines, weighted by how much they smear.
  const samples: { p: Vec; w: number; line: WorkLine }[] = [];
  for (const line of work.lines) {
    let left = 0;
    for (let i = 1; i < line.pts.length; i++) {
      left -= Math.hypot(line.pts[i].x - line.pts[i - 1].x, line.pts[i].y - line.pts[i - 1].y);
      if (left <= 0) {
        samples.push({ p: line.pts[i], w: RUB[line.kind], line });
        left = 3 * MM;
      }
    }
  }
  const total = samples.reduce((s, x) => s + x.w, 0);
  const pick = () => {
    let t = r() * total;
    for (const s of samples) if ((t -= s.w) <= 0) return s;
    return samples[samples.length - 1];
  };

  if (samples.length && w.smudge > 0) {
    const n = Math.max(1, Math.round((2 + 3 * r()) * w.smudge));
    for (let i = 0; i < n; i++) smudge(ctx, work, pick().p, r, w, scale);
  }
  const drawn = work.lines.filter((l) => l.kind !== 'letter' && lengthOf(l.pts) >= 10 * MM);
  for (let i = 0; i < w.erasers && drawn.length; i++) rubbedOut(ctx, drawn[Math.floor(r() * drawn.length)], r, scale);
  if (w.smudge > 0) crumbs(ctx, work.lines.filter((l) => l.kind !== 'letter'), r, w.smudge);
  if (w.holes) for (const h of mergedPivots(work.pivots)) needle(ctx, h.p, h.n, r, w.depth, L, scale);
  return canvas;
}

/**
 * Graphite the hand dragged off the lines under it: those lines again, wide,
 * soft and moved on in the direction the hand goes, faded out at an uneven
 * edge, over a faint grey rub.
 */
function smudge(ctx: CanvasRenderingContext2D, work: WorkMap, at: Vec, r: Rand, w: WearSettings, scale: number) {
  const R = (8 + 22 * r()) * MM * w.size;
  const dir = w.hand === 'right' ? { x: 0.94, y: 0.33 } : { x: -0.94, y: 0.33 };
  const shift = (2 + 4 * r()) * MM;
  const c = { x: at.x + dir.x * shift * 0.5 + (r() - 0.5) * R * 0.4, y: at.y + dir.y * shift * 0.5 + (r() - 0.5) * R * 0.4 };
  const pad = 4 * MM;
  const side = 2 * (R + pad);
  const ox = c.x - R - pad;
  const oy = c.y - R - pad;
  const layer = canvasOf(side * scale, side * scale);
  const g = layer.getContext('2d')!;
  g.scale(scale, scale);
  g.translate(-ox, -oy);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.filter = `blur(${((0.8 + 1.2 * r()) * MM * scale).toFixed(1)}px)`;
  // A faint rub where the side of the hand lay.
  g.fillStyle = `rgba(${LEAD},0.18)`;
  g.beginPath();
  g.ellipse(c.x, c.y, R * 0.8, R * (0.35 + 0.25 * r()), Math.atan2(dir.y, dir.x) + (r() - 0.5) * 0.6, 0, Math.PI * 2);
  g.fill();
  // The lines, smeared on along the hand's way.
  const near = work.lines.filter((l) => l.pts.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < R + shift));
  const steps = 4;
  for (let k = 1; k <= steps; k++) {
    const d = (shift * k) / steps;
    g.strokeStyle = `rgba(${LEAD},${(0.9 * (1 - (k - 1) / steps)).toFixed(3)})`;
    for (const l of near) {
      g.lineWidth = (0.6 + 0.8 * r()) * MM * (l.kind === 'letter' ? 0.7 : 1);
      g.globalAlpha = RUB[l.kind];
      g.beginPath();
      l.pts.forEach((p, i) => (i ? g.lineTo(p.x + dir.x * d, p.y + dir.y * d) : g.moveTo(p.x + dir.x * d, p.y + dir.y * d)));
      g.stroke();
    }
  }
  g.globalAlpha = 1;
  // Faded out at an uneven edge: a few soft blobs as the mask.
  const mask = canvasOf(side * scale, side * scale);
  const m = mask.getContext('2d')!;
  m.scale(scale, scale);
  m.translate(-ox, -oy);
  const blobs = 4 + Math.floor(3 * r());
  for (let i = 0; i < blobs; i++) {
    const a = r() * Math.PI * 2;
    const q = { x: c.x + Math.cos(a) * R * 0.35 * r(), y: c.y + Math.sin(a) * R * 0.35 * r() };
    const rr = R * (0.5 + 0.4 * r());
    const grad = m.createRadialGradient(q.x, q.y, 0, q.x, q.y, rr);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.3)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    m.fillStyle = grad;
    m.fillRect(ox, oy, side, side);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.filter = 'none';
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(mask, 0, 0);
  ctx.save();
  ctx.globalAlpha = Math.min(1, (0.05 + 0.06 * r()) * w.smudge);
  ctx.drawImage(layer, ox, oy, side, side);
  ctx.restore();
}

/**
 * A line drawn wrong and rubbed out: what is left of it — the same piece of a
 * line a little off its place, faint and broken — and the grey the eraser
 * spread round it.
 */
function rubbedOut(ctx: CanvasRenderingContext2D, line: WorkLine, r: Rand, scale: number) {
  const total = lengthOf(line.pts);
  const len = Math.min(total, (10 + 20 * r()) * MM);
  const a = r() * (total - len);
  const part = piece(line.pts, a, a + len);
  if (part.length < 2) return;
  const p0 = part[0];
  const p1 = part[part.length - 1];
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
  const turn = (((1 + 2 * r()) * Math.PI) / 180) * (r() < 0.5 ? -1 : 1);
  const off = (1 + 2 * r()) * MM * (r() < 0.5 ? -1 : 1);
  const n = { x: -Math.sin(ang), y: Math.cos(ang) };
  const ghost = part.map((p) => {
    const dx = p.x - mid.x;
    const dy = p.y - mid.y;
    return { x: mid.x + dx * Math.cos(turn) - dy * Math.sin(turn) + n.x * off, y: mid.y + dx * Math.sin(turn) + dy * Math.cos(turn) + n.y * off };
  });
  const gmid = { x: mid.x + n.x * off, y: mid.y + n.y * off };
  ctx.save();
  // The eraser's grey: an oval along the line, a little darker at its rim.
  ctx.filter = `blur(${(1.2 * MM * scale).toFixed(1)}px)`;
  const rx = len / 2 + 3 * MM;
  const ry = (3 + 1.5 * r()) * MM;
  ctx.fillStyle = `rgba(${LEAD},${(0.025 + 0.015 * r()).toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(gmid.x, gmid.y, rx, ry, ang + turn, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(${LEAD},0.03)`;
  ctx.lineWidth = 1.2 * MM;
  ctx.stroke();
  // Streaks the way the eraser went.
  ctx.filter = `blur(${(0.3 * MM * scale).toFixed(1)}px)`;
  ctx.lineWidth = 0.25 * MM;
  for (let k = 0; k < 3 + Math.floor(3 * r()); k++) {
    const t = (r() - 0.5) * 1.4 * ry;
    const l = rx * (0.4 + 0.5 * r());
    const c = { x: gmid.x - Math.sin(ang + turn) * t, y: gmid.y + Math.cos(ang + turn) * t };
    ctx.strokeStyle = `rgba(${LEAD},0.03)`;
    ctx.beginPath();
    ctx.moveTo(c.x - Math.cos(ang + turn) * l, c.y - Math.sin(ang + turn) * l);
    ctx.lineTo(c.x + Math.cos(ang + turn) * l, c.y + Math.sin(ang + turn) * l);
    ctx.stroke();
  }
  // What is left of the line: faint, broken where the eraser took the graphite off the fibres.
  ctx.filter = `blur(${(0.12 * MM * scale).toFixed(1)}px)`;
  ctx.lineCap = 'round';
  ctx.lineWidth = 0.35 * MM;
  const base = 0.08 + 0.07 * r();
  const step = 0.8 * MM;
  const glen = lengthOf(ghost);
  for (let s = 0; s < glen; s += step) {
    if (r() < 0.2) continue;
    const seg = piece(ghost, s, s + step * (0.6 + 0.5 * r()));
    if (seg.length < 2) continue;
    ctx.strokeStyle = `rgba(${LEAD},${(base * (0.4 + 0.6 * r())).toFixed(3)})`;
    ctx.beginPath();
    seg.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
  ctx.restore();
}

/** Crumbs of lead and short touches of the pencil where it was put down, near the ends of lines. */
function crumbs(ctx: CanvasRenderingContext2D, lines: WorkLine[], r: Rand, amount: number) {
  if (!lines.length) return;
  const near = () => {
    const l = lines[Math.floor(r() * lines.length)];
    const end = r() < 0.5 ? l.pts[0] : l.pts[l.pts.length - 1];
    const a = r() * Math.PI * 2;
    const d = (1 + 3 * r()) * MM;
    return { x: end.x + Math.cos(a) * d, y: end.y + Math.sin(a) * d };
  };
  ctx.save();
  for (let i = Math.round((4 + 8 * r()) * amount); i > 0; i--) {
    const p = near();
    ctx.fillStyle = `rgba(${LEAD},${(0.35 + 0.35 * r()).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, (0.04 + 0.07 * r()) * MM, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineCap = 'round';
  ctx.lineWidth = 0.25 * MM;
  for (let i = Math.round((1 + 3 * r()) * amount); i > 0; i--) {
    const p = near();
    const a = r() * Math.PI * 2;
    const l = (1 + r()) * MM;
    ctx.strokeStyle = `rgba(${LEAD},${(0.2 + 0.15 * r()).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.quadraticCurveTo(p.x + Math.cos(a) * l * 0.5 + (r() - 0.5) * 0.3 * MM, p.y + Math.sin(a) * l * 0.5, p.x + Math.cos(a) * l, p.y + Math.sin(a) * l);
    ctx.stroke();
  }
  ctx.restore();
}

/** Centres closer than 0.3 mm are one hole, the needle put in there `n` times. */
export function mergedPivots(pivots: Vec[]): { p: Vec; n: number }[] {
  const out: { p: Vec; n: number }[] = [];
  for (const p of pivots) {
    const hit = out.find((h) => Math.hypot(h.p.x - p.x, h.p.y - p.y) < 0.3 * MM);
    if (hit) hit.n++;
    else out.push({ p, n: 1 });
  }
  return out;
}

/**
 * The needle's hole: dark inside, the paper pressed down round it — the wall
 * nearer the light in shadow — wider and torn when the needle
 * went in again and again; now and then it slipped and went in once more
 * beside, and the fingers on the head left a little grey.
 */
function needle(ctx: CanvasRenderingContext2D, c: Vec, uses: number, r: Rand, depth: number, L: Vec, scale: number) {
  const hole = (p: Vec, rh: number, rc: number, k: number) => {
    // The dent.
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, rc, 0, Math.PI * 2);
    ctx.clip();
    const s = { x: p.x + L.x * rc * 0.35, y: p.y + L.y * rc * 0.35 };
    const shade = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, rc * 0.95);
    shade.addColorStop(0, `rgba(40,40,46,${(0.16 * k).toFixed(3)})`);
    shade.addColorStop(1, 'rgba(40,40,46,0)');
    ctx.fillStyle = shade;
    ctx.fillRect(p.x - rc, p.y - rc, 2 * rc, 2 * rc);
    // (The lit far wall is light, not graphite: it is drawn with the paper's relief, relief.ts.)
    ctx.restore();
    // The hole itself, with its shadow inside.
    const core = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rh);
    core.addColorStop(0, 'rgba(24,24,28,0.9)');
    core.addColorStop(0.7, 'rgba(30,30,34,0.7)');
    core.addColorStop(1, 'rgba(40,40,46,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rh, 0, Math.PI * 2);
    ctx.fill();
  };
  const rh = Math.min(0.25, 0.075 + 0.075 * r() + 0.04 * (uses - 1)) * MM * Math.sqrt(depth);
  const rc = (0.4 + 0.4 * r()) * MM * depth * (1 + 0.12 * Math.min(uses - 1, 4));
  hole(c, Math.max(rh, 0.5 / scale), rc, Math.min(2, depth * (1 + 0.15 * (uses - 1))));
  // Torn round the edge after several goes.
  for (let i = uses > 2 ? 2 + Math.floor(2 * r()) : 0; i > 0; i--) {
    const a = r() * Math.PI * 2;
    ctx.fillStyle = 'rgba(30,30,34,0.5)';
    ctx.beginPath();
    ctx.arc(c.x + Math.cos(a) * rh * 0.9, c.y + Math.sin(a) * rh * 0.9, rh * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
  if (r() < 0.15) {
    const a = r() * Math.PI * 2;
    const d = (0.3 + 0.5 * r()) * MM;
    hole({ x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d }, Math.max(rh * 0.6, 0.4 / scale), rc * 0.5, depth * 0.6);
  }
  if (r() < 0.35) {
    const a = r() * Math.PI * 2;
    const d = (2 + 3 * r()) * MM;
    const p = { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d };
    const rr = (2 + 2 * r()) * MM;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
    g.addColorStop(0, `rgba(${LEAD},0.04)`);
    g.addColorStop(1, `rgba(${LEAD},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(p.x - rr, p.y - rr, 2 * rr, 2 * rr);
  }
}
