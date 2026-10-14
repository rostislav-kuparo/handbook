// How rendered handwriting falls onto A4 sheets. Shared by the rendered view
// and the page-by-page PNG/SVG export, so a file shows exactly the sheet you saw.
import type { PMNodeJSON } from './layout';
import { PITCH, SHEET_H, type Geometry } from './page';

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
    if (y > 0 && y + h > contentH + 0.5 && h <= contentH) {
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

/** Floating blocks keep the position they have over the editor's text column. */
export function placeFloats(nodes: PMNodeJSON[], geo: Geometry, titleH: number): FloatPlacement[] {
  return nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.type === 'htmlBlock' && n.attrs?.float)
    .map(({ n, i }) => {
      const attrs = n.attrs ?? {};
      const stackY = geo.margin.top + titleH + Number(attrs.y ?? 0);
      let page = Math.max(0, Math.floor(stackY / PITCH));
      // A block whose top falls into the gap between sheets goes to the next sheet (print clips sheets).
      if (stackY - page * PITCH > SHEET_H - 40) page += 1;
      const top = Math.max(0, stackY - page * PITCH);
      return { i, attrs, page, top, left: geo.margin.left + Number(attrs.x ?? 0), width: Number(attrs.w ?? 360) };
    });
}
