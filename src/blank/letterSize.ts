// How big to write on a blank: as its printed text, a little bigger, as a
// hand does. The printed letters are measured on the blank's own picture.
import { MM } from '../editor/page';
import { blankRect, blankSheet, type Blank } from './blank';
import { darkOf, forEachBlob } from './snap';

/** Capitals of the handwriting on a blank, mm, when nothing better is known. */
export const BLANK_LETTERS = 3.5;
/** Within these, mm: smaller is not readable by hand, bigger does not fit a blank. */
const RANGE = [2.8, 5] as const;

/**
 * Capitals of the handwriting for this blank, mm: its printed text's
 * capitals × 1.1. Printed letters are the commonest small blots of ink of a
 * letter's shape; most of them are lowercase, so their usual height is the
 * x-height (≈ 0.72 of a capital).
 */
export async function printLetters(b: Blank): Promise<number> {
  const d = await darkOf(b);
  const r = blankRect(b, blankSheet(b));
  const pmm = (d.w / r.w) * MM;
  const bins = new Map<number, number>();
  forEachBlob(d, ({ x0, y0, x1, y1, n }) => {
    const h = (y1 - y0 + 1) / pmm;
    const w = (x1 - x0 + 1) / pmm;
    const fill = n / ((x1 - x0 + 1) * (y1 - y0 + 1));
    // A letter: a few millimetres tall, not much wider than tall, neither a line nor a blot.
    if (h < 1 || h > 7 || w < 0.2 || w > 1.4 * h || fill < 0.12 || fill > 0.7) return;
    const bin = Math.round(h * 10);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  });
  if (!bins.size) return BLANK_LETTERS;
  // The usual height, a little smoothed over neighbouring tenths of a millimetre.
  let best = 0;
  let bestN = -1;
  for (const bin of bins.keys()) {
    const n = (bins.get(bin - 1) ?? 0) + 2 * (bins.get(bin) ?? 0) + (bins.get(bin + 1) ?? 0);
    if (n > bestN) [best, bestN] = [bin, n];
  }
  const caps = best / 10 / 0.72;
  return Math.round(Math.min(RANGE[1], Math.max(RANGE[0], caps * 1.1)) * 10) / 10;
}
