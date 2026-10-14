import { FALLBACK_FONTS } from './constants';

const cache = new Map<string, number>();
let ctx: CanvasRenderingContext2D | null = null;

/**
 * Advance widths (font units, 1000/em) of characters drawn with the fallback
 * font, so the ink renderer leaves exactly enough room for them.
 */
export function fallbackWidths(text: string, has: (ch: string) => boolean): Record<string, number> {
  ctx ??= document.createElement('canvas').getContext('2d');
  const out: Record<string, number> = {};
  for (const ch of new Set(text)) {
    if (/\s/u.test(ch) || has(ch)) continue;
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
