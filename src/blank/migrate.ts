// Documents on a blank from before 0.8.1: there the blank lay on the sheet
// already shrunk «по размеру листа», and drawings and notes were placed by the
// sheet. Now the sheet is the blank itself: everything is moved and scaled so
// it stays where it was against the printing.
import { MM, type SheetSize } from '../editor/page';
import type { DocContent } from '../model/types';
import { blankRect, blankSheet, formatMm, PRINTER_MARGIN, type Blank, type Rect } from './blank';
import { mmText } from './pickCode';

/** Where the picture lay on the old sheet (the format's paper, shrunk into the printable area when «по листу»). */
function oldRect(b: Blank): { sheet: SheetSize; rect: Rect } {
  const [w, h] = formatMm(b);
  const sheet = { w: w * MM, h: h * MM };
  const m = b.print === 'fit' ? 2 * PRINTER_MARGIN * MM : 0;
  const k = Math.min((sheet.w - m) / b.px[0], (sheet.h - m) / b.px[1]);
  const rw = b.px[0] * k;
  const rh = b.px[1] * k;
  return { sheet, rect: { x: (sheet.w - rw) / 2, y: (sheet.h - rh) / 2, w: rw, h: rh } };
}

const ANCHOR = /^(\s*)(НаБланке|OnBlank)\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?:,\s*(-?[\d.]+)\s*)?\)/imu;

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[] };

/** The document's content as it goes onto the blank's own sheet; null when there is nothing to move. */
export function migrateContent(content: DocContent, b: Blank): DocContent | null {
  const from = oldRect(b).rect;
  const to = blankRect(b, blankSheet(b));
  const s = to.w / from.w;
  if (Math.abs(s - 1) < 1e-6 && Math.abs(to.x - from.x) < 1e-6 && Math.abs(to.y - from.y) < 1e-6) return null;
  const mapX = (x: number) => (x - from.x) * s + to.x;
  const mapY = (y: number) => (y - from.y) * s + to.y;
  const nodes = ((content as { content?: Node[] }).content ?? []).map((n): Node => {
    if (n.type !== 'htmlBlock' || !n.attrs) return n;
    const a = { ...n.attrs };
    const code = String(a.code ?? '');
    const anchor = a.kind === 'sketch' ? ANCHOR.exec(code) : null;
    if (anchor) {
      // The origin moves with the blank; a unit of the drawing grows as the blank did.
      const x = mapX(Number(anchor[3]) * MM) / MM;
      const y = mapY(Number(anchor[4]) * MM) / MM;
      const unit = (anchor[5] ? Number(anchor[5]) : 1) * s;
      a.code = code.replace(ANCHOR, `${anchor[1]}НаБланке(${mmText(x)}, ${mmText(y)}, ${Math.round(unit * 10000) / 10000})`);
    } else if (a.float) {
      // On a blank the text column is the sheet (no margins).
      a.x = Math.round(mapX(Number(a.x) || 0));
      a.y = Math.round(mapY(Number(a.y) || 0));
      a.w = Math.round((Number(a.w) || 360) * s);
      if (a.kind === 'note') a.size = Math.round((Number(a.size) || 4) * s * 10) / 10;
    }
    return { ...n, attrs: a };
  });
  return { ...(content as object), content: nodes } as DocContent;
}
