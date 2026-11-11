// Points of a drawing in the user's own hand: the variants drawn in the
// studio, dealt out like letters, so that no two points in a row are the same.
import { getHandwriting } from '../engine/handwriting';
import { POINT_CENTER, POINT_SIGNS } from '../model/points';
import type { Sample } from '../model/types';
import { rng } from './pen';
import type { Item, Vec } from './types';

export interface PointMark {
  /** The strokes around the exact point, font units, y down. */
  strokes: Vec[][];
  /** The middle of the ink: the hand does not hit the exact point. */
  center: Vec;
  /** How far the ink lies from its middle: usually, and at most (a tail left out). */
  ring: number;
  reach: number;
}

/** The polyline without points closer than `step` to the last one kept (its ends stay). */
export function evenly(pts: Vec[], step: number): Vec[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(pts[i].x - last.x, pts[i].y - last.y) >= step) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const marks = new WeakMap<Sample, PointMark | null>();

function markOf(sample: Sample): PointMark | null {
  const known = marks.get(sample);
  if (known !== undefined) return known;
  let strokes = sample.strokes.filter((s) => s.length).map((s) => s.map((p) => ({ x: p.x - POINT_CENTER.x, y: POINT_CENTER.y - p.y })));
  const ink = strokes.flatMap((s) => evenly(s, 8));
  if (!ink.length) {
    marks.set(sample, null);
    return null;
  }
  let center = { x: ink.reduce((a, p) => a + p.x, 0) / ink.length, y: ink.reduce((a, p) => a + p.y, 0) / ink.length };
  const dists = ink.map((p) => Math.hypot(p.x - center.x, p.y - center.y)).sort((a, b) => a - b);
  const ring = dists[Math.floor(dists.length * 0.5)];
  const reach = dists[Math.floor(dists.length * 0.85)];
  // Drawn away from the cross hair: back to it, the hand misses a point by little.
  const off = Math.hypot(center.x, center.y);
  const limit = ring * 0.35 + 20;
  if (off > limit) {
    const back = { x: center.x * (limit / off - 1), y: center.y * (limit / off - 1) };
    strokes = strokes.map((s) => s.map((p) => ({ x: p.x + back.x, y: p.y + back.y })));
    center = { x: center.x + back.x, y: center.y + back.y };
  }
  const mark = { strokes, center, ring, reach };
  marks.set(sample, mark);
  return mark;
}

/**
 * The variant of every point that has any, kind by kind: from a shuffled deck,
 * so all of them come up before one comes up again and never twice running.
 * The order follows the drawing's first point of the kind: it stays as the
 * rest of the drawing changes. `alike`: one variant for all.
 */
export function dealPointMarks(items: Item[], alike: boolean): Map<Item, PointMark> {
  const out = new Map<Item, PointMark>();
  const { byChar } = getHandwriting();
  POINT_SIGNS.forEach((sign, style) => {
    const variants = (byChar.get(sign) ?? []).map(markOf).filter((m): m is PointMark => !!m);
    const points = items.filter((i) => i.shape.type === 'point' && (i.pointStyle ?? 0) === style);
    if (!variants.length || !points.length) return;
    const r = rng(points[0].seed ^ style);
    let deck: PointMark[] = [];
    let last: PointMark | null = null;
    for (const it of points) {
      if (alike) {
        out.set(it, variants[0]);
        continue;
      }
      if (!deck.length) {
        deck = [...variants];
        for (let i = deck.length - 1; i > 0; i--) {
          const k = Math.floor(r() * (i + 1));
          [deck[i], deck[k]] = [deck[k], deck[i]];
        }
        // The deck is dealt from its end.
        if (deck.length > 1 && deck[deck.length - 1] === last) [deck[0], deck[deck.length - 1]] = [deck[deck.length - 1], deck[0]];
      }
      last = deck.pop()!;
      out.set(it, last);
    }
  });
  return out;
}

let seen: unknown = null;
let key = '';

/** Changes when the drawn variants do: a drawing laid out before is out of date. */
export function pointsKey(): string {
  const { byChar } = getHandwriting();
  if (byChar !== seen) {
    seen = byChar;
    key = POINT_SIGNS.map((s) => (byChar.get(s) ?? []).map((v) => v.id).join(',')).join('|');
  }
  return key;
}
