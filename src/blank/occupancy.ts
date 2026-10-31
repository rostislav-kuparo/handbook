// What already lies on a blank's sheet — its printing, the lines of every
// drawing, the notes, the drawings' labels — for labels and notes to keep off it.
import { getHandwriting } from '../engine/handwriting';
import { DEFAULT_DRAW_PEN, drawPenOf, MM, type DrawPen, type SheetSize } from '../editor/page';
import { aroundOnSheet, blankBox, drawSketch, penFor, sketchLayout } from '../sketch/render';
import type { Vec } from '../sketch/types';
import { blankRect, type Blank, type Rect } from './blank';
import { noteFontSize } from './note';
import { LINE_HEIGHT_EM } from '../editor/layout';
import { forEachBlob, type Dark } from './snap';

/** A block of the document as the map takes it. */
export interface MapBlock {
  kind: string;
  code: string;
  pen?: unknown;
  /** A floating block's place, sheet px (on a blank: the text column is the sheet). */
  x: number;
  y: number;
  w: number;
  size?: number;
}

/** A label a drawing on the blank wrote (`code`: the drawing's commands): its box, sheet px. */
export interface SheetLabel {
  code: string;
  box: Rect;
}

export interface Occupancy {
  /** Bumped whenever the map is built anew (for caches). */
  version: number;
  /**
   * How much lies under a box of the sheet (sheet px): printed cells of half
   * a millimetre and points along the lines of the drawings — not counting the
   * drawing whose commands are `self` (its own lines are its own business) —
   * and notes and the drawings' labels, by the cells they cover (not the note
   * at `selfNote`, nor the labels of `self`).
   */
  count(box: Rect, self?: string, selfNote?: { x: number; y: number }): number;
  /**
   * Share of a box (sheet px) under what a label must never be written over:
   * printed letters, digits and points, the notes, the labels of the drawings
   * (not those of the drawing whose commands are `self`).
   */
  covered(box: Rect, self?: string): number;
  /** The same map with these labels of the drawings on it (instead of any it had). */
  withLabels(labels: SheetLabel[]): Occupancy;
}

let versions = 0;

/** Printed blots no bigger than this both ways (mm) are letters, digits and points… */
const MARK = 6;
/** …and keep this much air around them, mm. */
const MARK_AIR = 0.3;

/** The sheet's map: the printing, the drawings on the blank (their lines), the notes (their boxes). */
export function buildOccupancy(d: Dark, b: Blank, sheet: SheetSize, blocks: MapBlock[], letters: number, docPen: DrawPen = DEFAULT_DRAW_PEN): Occupancy {
  const cell = 0.5 * MM;
  const cols = Math.ceil(sheet.w / cell);
  const rows = Math.ceil(sheet.h / cell);
  const printed = new Uint8Array(cols * rows);
  const r = blankRect(b, sheet);
  const k = r.w / d.w;
  for (let y = 0; y < d.h; y++) {
    for (let x = 0; x < d.w; x++) {
      if (!d.on[y * d.w + x]) continue;
      const cx = Math.floor((r.x + x * k) / cell);
      const cy = Math.floor((r.y + y * k) / cell);
      if (cx >= 0 && cy >= 0 && cx < cols && cy < rows) printed[cy * cols + cx] = 1;
    }
  }
  // Letters, digits, the circles of points: small blots of their own, unlike
  // the lines (a label may cross a line when it must, never a printed «C₁»).
  const marks = new Uint8Array(cols * rows);
  const big = (MARK * MM) / k;
  const air = MARK_AIR * MM;
  forEachBlob(d, (bl) => {
    if (bl.n < 3 || bl.x1 - bl.x0 + 1 > big || bl.y1 - bl.y0 + 1 > big) return;
    const x0 = Math.max(0, Math.floor((r.x + bl.x0 * k - air) / cell));
    const y0 = Math.max(0, Math.floor((r.y + bl.y0 * k - air) / cell));
    const x1 = Math.min(cols - 1, Math.floor((r.x + (bl.x1 + 1) * k + air) / cell));
    const y1 = Math.min(rows - 1, Math.floor((r.y + (bl.y1 + 1) * k + air) / cell));
    for (let cy = y0; cy <= y1; cy++) marks.fill(1, cy * cols + x0, cy * cols + x1 + 1);
  });
  // Lines of the drawings on the blank, in sheet px, by cell for a quick look-up.
  const fs = noteFontSize(letters);
  const lines = new Map<number, { code: string; p: Vec }[]>();
  const notes: { box: Rect }[] = [];
  blocks.forEach((blk) => {
    if (blk.kind === 'note') {
      const nfs = noteFontSize(blk.size ?? letters);
      const rowsOf = Math.max(1, blk.code.split('\n').length);
      notes.push({ box: { x: blk.x, y: blk.y, w: blk.w, h: rowsOf * nfs * LINE_HEIGHT_EM } });
      return;
    }
    if (blk.kind !== 'sketch') return;
    const box = blankBox(blk.code);
    if (!box) return;
    const layout = sketchLayout(blk.code, box.w, fs, penFor(getHandwriting().style, fs, drawPenOf(docPen, blk.pen)));
    for (const o of layout.obstacles) {
      const p = { x: o.x + box.x, y: o.y + box.y };
      const key = Math.floor(p.y / cell) * cols + Math.floor(p.x / cell);
      const list = lines.get(key);
      if (list) list.push({ code: blk.code, p });
      else lines.set(key, [{ code: blk.code, p }]);
    }
  });
  const overlap = (a: Rect, q: Rect) =>
    Math.max(0, Math.min(a.x + a.w, q.x + q.w) - Math.max(a.x, q.x)) * Math.max(0, Math.min(a.y + a.h, q.y + q.h) - Math.max(a.y, q.y));
  const cellsOf = (box: Rect) => ({
    x0: Math.max(0, Math.floor(box.x / cell)),
    y0: Math.max(0, Math.floor(box.y / cell)),
    x1: Math.min(cols - 1, Math.floor((box.x + box.w) / cell)),
    y1: Math.min(rows - 1, Math.floor((box.y + box.h) / cell)),
  });

  const mapOf = (labels: SheetLabel[]): Occupancy => ({
    version: ++versions,
    count(box, self, selfNote) {
      let n = 0;
      const c = cellsOf(box);
      for (let cy = c.y0; cy <= c.y1; cy++) {
        for (let cx = c.x0; cx <= c.x1; cx++) {
          n += printed[cy * cols + cx];
          for (const l of lines.get(cy * cols + cx) ?? []) if (l.code !== self) n++;
        }
      }
      for (const nt of notes) {
        if (selfNote && Math.abs(nt.box.x - selfNote.x) < 1 && Math.abs(nt.box.y - selfNote.y) < 1) continue;
        n += overlap(box, nt.box) / (cell * cell);
      }
      for (const l of labels) if (l.code !== self) n += overlap(box, l.box) / (cell * cell);
      return n;
    },
    covered(box, self) {
      const area = box.w * box.h;
      if (area <= 0) return 0;
      let under = 0;
      const c = cellsOf(box);
      for (let cy = c.y0; cy <= c.y1; cy++) {
        for (let cx = c.x0; cx <= c.x1; cx++) {
          if (marks[cy * cols + cx]) under += overlap(box, { x: cx * cell, y: cy * cell, w: cell, h: cell });
        }
      }
      for (const nt of notes) under += overlap(box, nt.box);
      for (const l of labels) if (l.code !== self) under += overlap(box, l.box);
      return under / area;
    },
    withLabels: (more) => mapOf(more),
  });
  return mapOf([]);
}

/**
 * The map with the labels of every drawing on the blank, written in the
 * document's order: each drawing's labels keep off the printing, the notes
 * and the labels of the drawings before it, so two drawings never write
 * into each other. Each drawing then places its own labels on this map.
 */
export async function withDrawingLabels(map: Occupancy, blocks: MapBlock[], letters: number, docPen: DrawPen = DEFAULT_DRAW_PEN): Promise<Occupancy> {
  const fs = noteFontSize(letters);
  const labels: SheetLabel[] = [];
  let out = map;
  for (const blk of blocks) {
    const box = blk.kind === 'sketch' ? blankBox(blk.code) : null;
    if (!box) continue;
    const layout = sketchLayout(blk.code, box.w, fs, penFor(getHandwriting().style, fs, drawPenOf(docPen, blk.pen)));
    const d = await drawSketch(layout, {}, aroundOnSheet(blk.code, out));
    for (const l of d.labels) {
      const { x0, y0, x1, y1 } = l.ink;
      labels.push({ code: blk.code, box: { x: box.x + l.x + x0 * l.scale, y: box.y + l.y + y0 * l.scale, w: (x1 - x0) * l.scale, h: (y1 - y0) * l.scale } });
    }
    out = map.withLabels([...labels]);
  }
  return out;
}

/** The nearest place for a box (sheet px) within `reach` px where least lies under it; the box itself when it is clear. */
export function clearPlace(occ: Occupancy, box: Rect, sheet: SheetSize, selfNote?: { x: number; y: number }, reach = 16 * MM): Rect {
  const step = 1 * MM;
  const cost = (q: Rect) => occ.count(q, undefined, selfNote);
  let best = box;
  let bestCost = cost(box);
  if (bestCost < 1) return box;
  for (let ring = 1; ring * step <= reach; ring++) {
    for (let i = -ring; i <= ring; i++) {
      for (const [dx, dy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]]) {
        const q = { ...box, x: box.x + dx * step, y: box.y + dy * step };
        if (q.x < 0 || q.y < 0 || q.x + q.w > sheet.w || q.y + q.h > sheet.h) continue;
        const c = cost(q) + ring * 0.5;
        if (c < bestCost) [best, bestCost] = [q, c];
      }
    }
    if (bestCost < ring * 0.5 + 1) break;
  }
  return best;
}
