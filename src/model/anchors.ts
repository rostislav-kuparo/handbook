import { isLetter } from './alphabet';
import { Anchor, Stroke, X_HEIGHT } from './types';

/** Shortest stroke that can join; shorter ones are dots (і, ї, й) and ticks. Same as glyph-core. */
const DOT_LENGTH = 35;

function strokeLength(s: Stroke): number {
  let l = 0;
  for (let i = 1; i < s.length; i++) l += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
  return l;
}

/** A stroke end where a letter can join: the start or the end of a stroke that is not a dot. */
export interface StrokeEnd {
  x: number;
  y: number;
  stroke: number;
  atStart: boolean;
}

/** Every place a join can sit (the engine joins at stroke ends only). */
export function strokeEnds(strokes: Stroke[]): StrokeEnd[] {
  const out: StrokeEnd[] = [];
  strokes.forEach((s, i) => {
    if (s.length < 2 || strokeLength(s) < DOT_LENGTH) return;
    out.push({ x: s[0].x, y: s[0].y, stroke: i, atStart: true });
    const last = s[s.length - 1];
    out.push({ x: last.x, y: last.y, stroke: i, atStart: false });
  });
  return out;
}

/** The stroke end nearest to a point (where a dragged anchor lands). */
export function nearestEnd(strokes: Stroke[], x: number, y: number): StrokeEnd | null {
  let best: StrokeEnd | null = null;
  let bestD = Infinity;
  for (const e of strokeEnds(strokes)) {
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/**
 * Joins only work on the outer edge (the engine ignores others): the entry
 * near the left of the ink, the exit near the right. Same rule as glyph-core.
 */
export function anchorOnEdge(side: 'entry' | 'exit', a: Anchor, strokes: Stroke[]): boolean {
  const xs = strokes.flat().map((p) => p.x);
  if (xs.length === 0) return false;
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const reach = Math.max(0.3 * (xMax - xMin), 60);
  return side === 'entry' ? a.x <= xMin + reach : a.x >= xMax - reach;
}

/**
 * Auto-detect entry/exit anchors for a freshly written sample.
 *
 * Entry = where the first stroke starts, exit = where the last stroke ends —
 * as long as that point can join: on the outer edge of the letter, at a join
 * height (near the baseline, or for the exit also at the x-height, like о, в)
 * and not on a dot. Otherwise another stroke end that can is taken: the foot
 * of the right leg of «А» rather than its bar, the foot of «і» rather than its
 * dot. The engine snaps each to its join line. In the studio the user can
 * toggle `connect` or drag the anchor to another stroke end.
 */
export function detectAnchors(ch: string, strokes: Stroke[]): { entry: Anchor | null; exit: Anchor | null } {
  const drawn = strokes.filter((s) => s.length > 0);
  if (drawn.length === 0) return { entry: null, exit: null };
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const s of drawn) for (const p of s) {
    xMin = Math.min(xMin, p.x);
    xMax = Math.max(xMax, p.x);
  }
  const reach = Math.max(0.3 * (xMax - xMin), 60);
  const first = drawn[0][0];
  const lastStroke = drawn[drawn.length - 1];
  const last = lastStroke[lastStroke.length - 1];
  const letter = isLetter(ch);
  const lowZone = (y: number) => y > -0.12 * X_HEIGHT && y < 0.5 * X_HEIGHT;
  const highZone = (y: number) => y >= 0.75 * X_HEIGHT && y < 1.2 * X_HEIGHT;
  const ends = strokeEnds(drawn);
  const canEnter = (e: StrokeEnd) => lowZone(e.y) && e.x <= xMin + reach;
  const canExit = (e: StrokeEnd) => (lowZone(e.y) || highZone(e.y)) && e.x >= xMax - reach;

  const firstEnd = ends.find((e) => e.stroke === 0 && e.atStart);
  const lastEnd = ends.find((e) => e.stroke === drawn.length - 1 && !e.atStart);
  const entryEnd = !letter ? null : firstEnd && canEnter(firstEnd) ? firstEnd : ends.filter(canEnter).sort((a, b) => a.x - b.x)[0] ?? null;
  const exitEnd = !letter
    ? null
    : lastEnd && canExit(lastEnd) && lastEnd !== entryEnd
      ? lastEnd
      : ends.filter((e) => canExit(e) && e !== entryEnd).sort((a, b) => b.x - a.x)[0] ?? null;

  const entry: Anchor = entryEnd ? { x: entryEnd.x, y: entryEnd.y, connect: true } : { x: first.x, y: first.y, connect: false };
  const exit: Anchor = exitEnd ? { x: exitEnd.x, y: exitEnd.y, connect: true } : { x: last.x, y: last.y, connect: false };
  return { entry, exit };
}
