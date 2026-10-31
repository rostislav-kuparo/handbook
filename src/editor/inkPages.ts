// How rendered handwriting falls onto A4 sheets. Shared by the rendered view
// and the page-by-page PNG/SVG export, so a file shows exactly the sheet you saw.
import { blankBox } from '../sketch/render';
import type { NodeLayout } from './docLayout';
import type { PMNodeJSON } from './layout';
import type { Geometry } from './page';

export type InkItem = { kind: 'line'; para: number; line: number } | { kind: 'block'; node: number };
export type PlacedItem = InkItem & { y: number };

export interface FloatPlacement {
  i: number;
  attrs: Record<string, unknown>;
  page: number;
  /** Position on its sheet (sheet pixels). */
  top: number;
  left: number;
  width: number;
  /** A drawing on a blank (НаБланке): it lies by the sheet itself, wherever its margins and title are. */
  onSheet: boolean;
}

/** Height of the title on the first sheet: two ruled lines, or nothing when hidden. */
export const titleHeight = (showTitle: boolean, lh: number) => (showTitle ? 2 * lh : 0);

/** Inline blocks take whole lines, so the text below stays on the ruling. */
export const blockSpan = (height: number, lh: number) => Math.ceil(height / lh - 0.001) * lh;

/**
 * Lines and inline blocks flowed onto sheets; `y` is from the top of the
 * writable area of each sheet. Page 1 starts below the title.
 */
export function flowPages(
  nodes: PMNodeJSON[],
  lineCount: (node: number) => number,
  blockHeight: (node: number) => number,
  lh: number,
  titleH: number,
  contentH: number,
): PlacedItem[][] {
  const out: PlacedItem[][] = [[]];
  let y = titleH;
  const place = (item: InkItem, h: number) => {
    if (y > 0 && y + h > contentH + 0.5 && h <= contentH + 0.5) {
      out.push([]);
      y = 0;
    }
    out[out.length - 1].push({ ...item, y });
    y += h;
  };
  nodes.forEach((n, i) => {
    if (n.type === 'htmlBlock') {
      if (n.attrs?.float) return;
      place({ kind: 'block', node: i }, blockSpan(blockHeight(i), lh));
    } else {
      for (let k = 0; k < lineCount(i); k++) place({ kind: 'line', para: i, line: k }, lh);
    }
  });
  return out;
}

/**
 * Lines and inline blocks where the editor put them (`layout`, one per node):
 * the same lines on the same sheets, empty paragraphs and page breaks
 * included. A line the editor did not have goes below the one before.
 */
export function layoutPages(nodes: PMNodeJSON[], layout: (NodeLayout | null)[], lineCount: (node: number) => number, lh: number): PlacedItem[][] {
  const out: PlacedItem[][] = [[]];
  let last: [number, number] = [0, -lh];
  const place = (item: InkItem, at: [number, number] | undefined) => {
    const [page, y] = at ?? [last[0], last[1] + lh];
    while (out.length <= page) out.push([]);
    out[page].push({ ...item, y });
    last = [page, y];
  };
  nodes.forEach((n, i) => {
    const at = layout[i]?.at ?? [];
    if (n.type === 'htmlBlock') {
      if (!n.attrs?.float) place({ kind: 'block', node: i }, at[0]);
      return;
    }
    for (let k = 0; k < lineCount(i); k++) place({ kind: 'line', para: i, line: k }, at[k]);
  });
  return out;
}

/**
 * Floating blocks keep the position they have over the editor's text column:
 * `geo` is the editor's page (its sheets split the stack the blocks lie on).
 */
export function placeFloats(nodes: PMNodeJSON[], geo: Geometry, titleH: number): FloatPlacement[] {
  return nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.type === 'htmlBlock' && n.attrs?.float)
    .map(({ n, i }) => {
      const attrs = n.attrs ?? {};
      const box = attrs.kind === 'sketch' ? blankBox(String(attrs.code ?? '')) : null;
      if (box) return { i, attrs, page: 0, top: box.y, left: box.x, width: box.w, onSheet: true };
      const stackY = geo.margin.top + titleH + Number(attrs.y ?? 0);
      let page = Math.max(0, Math.floor(stackY / geo.pitch));
      // A block whose top falls into the gap between sheets goes to the next sheet (print clips sheets).
      if (stackY - page * geo.pitch > geo.sheet.h - 40) page += 1;
      const top = Math.max(0, stackY - page * geo.pitch);
      return { i, attrs, page, top, left: geo.margin.left + Number(attrs.x ?? 0), width: Number(attrs.w ?? 360), onSheet: false };
    });
}
