import { ROMAN_WIDTH } from '../blank/roman';
import { FALLBACK_FONTS } from './constants';

const cache = new Map<string, number>();
let ctx: CanvasRenderingContext2D | null = null;
const segmenter = new Intl.Segmenter();

/**
 * Advance widths (font units, 1000/em) of characters drawn with the fallback
 * font, so the ink renderer leaves exactly enough room for them.
 */
export function fallbackWidths(text: string, has: (ch: string) => boolean): Record<string, number> {
  ctx ??= document.createElement('canvas').getContext('2d');
  const out: Record<string, number> = {};
  // Characters, and letters with their marks (x̄): such a cluster falls back whole.
  const clusters = [...segmenter.segment(text)].map((s) => s.segment).filter((s) => [...s].length > 1);
  for (const ch of new Set([...text, ...clusters])) {
    if (/\s/u.test(ch) || has(ch)) continue;
    // A Roman numeral's letter, drawn as sticks (blank/roman.ts).
    if (ROMAN_WIDTH[ch]) {
      out[ch] = ROMAN_WIDTH[ch];
      continue;
    }
    let w = cache.get(ch);
    if (w === undefined && ctx) {
      ctx.font = `1000px ${FALLBACK_FONTS}`;
      w = ctx.measureText(ch).width;
      cache.set(ch, w);
    }
    if (w !== undefined) out[ch] = w;
  }
  return out;
}
