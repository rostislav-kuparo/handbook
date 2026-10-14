// Cutting a handwritten word into letters.
//
// The user writes a whole word or phrase; boundaries are lines between
// letters, slanted like the handwriting (and each can be tilted by hand). A
// stroke that crosses a boundary is cut there — and that cut point is exactly
// where one letter hands over to the next, so it becomes a connecting exit of
// the left letter and a connecting entry of the right one.
import { detectAnchors } from '../model/anchors';
import { Anchor, InkPoint, Stroke } from '../model/types';

interface Piece {
  points: InkPoint[];
  letter: number;
  /** Boundary index this piece starts/ends at, when it was cut there. */
  startCut: number | null;
  endCut: number | null;
}

export interface LetterCut {
  strokes: Stroke[];
  entry: Anchor | null;
  exit: Anchor | null;
}

/** A cut between two letters: the line x = x + lean·y (font units, y up; lean > 0 leans right). */
export interface Boundary {
  x: number;
  lean: number;
}

/** Where a boundary crosses the height y. */
export const boundaryX = (b: Boundary, y: number) => b.x + b.lean * y;

const length = (s: InkPoint[]) => s.slice(1).reduce((acc, p, i) => acc + Math.hypot(p.x - s[i].x, p.y - s[i].y), 0);

/** Letter index of a point: how many boundaries lie to its left. */
function region(p: { x: number; y: number }, bounds: Boundary[]): number {
  let r = 0;
  while (r < bounds.length && p.x >= boundaryX(bounds[r], p.y)) r++;
  return r;
}

/**
 * Slant of the handwriting (dx per dy): the weighted median direction of the
 * near-vertical pieces of the strokes — stems and downstrokes show the slant.
 */
export function writingSlant(strokes: Stroke[]): number {
  const leans: { v: number; w: number }[] = [];
  for (const s of strokes) {
    let a = s[0];
    for (const b of s) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.hypot(dx, dy) < 40) continue;
      if (Math.abs(dy) > Math.abs(dx) * 1.2) leans.push({ v: dx / dy, w: Math.abs(dy) });
      a = b;
    }
  }
  if (leans.length < 3) return 0;
  leans.sort((p, q) => p.v - q.v);
  const half = leans.reduce((acc, l) => acc + l.w, 0) / 2;
  let acc = 0;
  for (const l of leans) {
    acc += l.w;
    if (acc >= half) return Math.min(Math.max(l.v, -0.25), 0.6);
  }
  return 0;
}

/**
 * Initial boundaries, slanted like the handwriting: equal widths, then each
 * moved to the emptiest spot nearby (a pen lift or a thin join). Measured in
 * "sheared" coordinates u = x − lean·y, where slanted lines are vertical.
 */
export function autoBounds(input: Stroke[], letters: number): Boundary[] {
  const lean = writingSlant(input);
  const strokes = input.map((s) => s.map((p) => ({ ...p, x: p.x - lean * p.y })));
  const pts = strokes.flat();
  if (letters < 2 || pts.length === 0) return [];
  const xMin = Math.min(...pts.map((p) => p.x));
  const xMax = Math.max(...pts.map((p) => p.x));
  const bin = 10;
  const bins = Math.max(1, Math.ceil((xMax - xMin) / bin) + 1);
  const density = new Array(bins).fill(0);
  for (const s of strokes) {
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1];
      const b = s[i];
      const from = Math.floor((Math.min(a.x, b.x) - xMin) / bin);
      const to = Math.floor((Math.max(a.x, b.x) - xMin) / bin);
      const ink = Math.hypot(b.x - a.x, b.y - a.y) / (to - from + 1);
      for (let k = from; k <= to; k++) density[k] += ink;
    }
  }
  const w = (xMax - xMin) / letters;
  const bounds: number[] = [];
  for (let k = 1; k < letters; k++) {
    const guess = xMin + w * k;
    let best = guess;
    let bestD = Infinity;
    for (let x = guess - w * 0.35; x <= guess + w * 0.35; x += bin) {
      const i = Math.round((x - xMin) / bin);
      // Prefer emptier columns, slightly prefer the even split.
      const d = (density[i] ?? 0) + Math.abs(x - guess) * 0.02;
      if (d < bestD && (bounds.length === 0 || x > bounds[bounds.length - 1] + 40)) {
        bestD = d;
        best = x;
      }
    }
    bounds.push(best);
  }
  return bounds.map((x) => ({ x, lean }));
}

/** Split strokes at the boundaries into pieces, each belonging to one letter. */
function pieces(strokes: Stroke[], bounds: Boundary[]): Piece[] {
  const out: Piece[] = [];
  for (const s of strokes) {
    if (s.length === 0) continue;
    // Small marks (dots, breves) belong wholly to the letter under their centre.
    if (s.length < 3 || length(s) < 120) {
      const cx = s.reduce((acc, p) => acc + p.x, 0) / s.length;
      const cy = s.reduce((acc, p) => acc + p.y, 0) / s.length;
      out.push({ points: s, letter: region({ x: cx, y: cy }, bounds), startCut: null, endCut: null });
      continue;
    }
    let r = region(s[0], bounds);
    let cur: Piece = { points: [s[0]], letter: r, startCut: null, endCut: null };
    for (let i = 1; i < s.length; i++) {
      const p = s[i - 1];
      const q = s[i];
      const rq = region(q, bounds);
      while (r !== rq) {
        const b = r < rq ? r : r - 1;
        // Where the segment p→q crosses the (slanted) boundary line.
        const side = (pt: InkPoint) => pt.x - boundaryX(bounds[b], pt.y);
        const fp = side(p);
        const fq = side(q);
        const t = fp === fq ? 0 : Math.min(Math.max(fp / (fp - fq), 0), 1);
        const c: InkPoint = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, t: p.t + (q.t - p.t) * t, p: p.p + (q.p - p.p) * t };
        cur.points.push(c);
        cur.endCut = b;
        out.push(cur);
        r = r < rq ? r + 1 : r - 1;
        cur = { points: [c], letter: r, startCut: b, endCut: null };
      }
      cur.points.push(q);
    }
    out.push(cur);
  }
  // Tiny slivers from a stroke grazing a boundary are noise.
  return out.filter((p) => p.points.length >= 2 && (length(p.points) >= 12 || (p.startCut === null && p.endCut === null)));
}

/** Letters in writing order; each with its strokes and anchors (cuts = connecting joins). */
export function cutLetters(strokes: Stroke[], bounds: Boundary[], letters: string[]): LetterCut[] {
  const all = pieces(strokes, bounds);
  return letters.map((ch, i) => {
    const mine = all.filter((p) => p.letter === i);
    const strokesOut = mine.map((p) => p.points);
    const auto = detectAnchors(ch, strokesOut);
    const cutIn = mine.find((p) => p.startCut === i - 1);
    const cutOut = [...mine].reverse().find((p) => p.endCut === i);
    const entry = cutIn ? { x: cutIn.points[0].x, y: cutIn.points[0].y, connect: true } : auto.entry;
    const last = cutOut?.points[cutOut.points.length - 1];
    const exit = last ? { x: last.x, y: last.y, connect: true } : auto.exit;
    // Normalise position so thumbnails look alike: left edge at x = 150.
    const xMin = Math.min(...strokesOut.flat().map((p) => p.x));
    const dx = Number.isFinite(xMin) ? 150 - xMin : 0;
    const shift = (a: Anchor | null) => (a ? { ...a, x: a.x + dx } : null);
    return {
      strokes: strokesOut.map((s) => s.map((p) => ({ ...p, x: p.x + dx }))),
      entry: shift(entry),
      exit: shift(exit),
    };
  });
}
