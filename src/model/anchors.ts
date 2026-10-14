import { isLetter } from './alphabet';
import { Anchor, Stroke, X_HEIGHT } from './types';

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
 * Entry = where the first stroke starts, exit = where the last stroke ends.
 * A side is marked as connecting when that point lies on the outer edge of the
 * letter and at a join height: near the baseline (most letters), or — for the
 * exit — at the x-height (о, в, which hand over to the next letter at the top).
 * The engine snaps each to its join line. The user can toggle `connect` per
 * sample in the studio.
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
  const width = Math.max(xMax - xMin, 1);
  const first = drawn[0][0];
  const lastStroke = drawn[drawn.length - 1];
  const last = lastStroke[lastStroke.length - 1];
  const letter = isLetter(ch);
  const lowZone = (y: number) => y > -0.12 * X_HEIGHT && y < 0.5 * X_HEIGHT;
  const highZone = (y: number) => y >= 0.75 * X_HEIGHT && y < 1.2 * X_HEIGHT;

  const entry: Anchor = {
    x: first.x,
    y: first.y,
    connect: letter && lowZone(first.y) && first.x <= xMin + width * 0.3,
  };
  const exit: Anchor = {
    x: last.x,
    y: last.y,
    connect: letter && (lowZone(last.y) || highZone(last.y)) && last.x >= xMax - width * 0.3 && lastStroke.length > 1,
  };
  return { entry, exit };
}
