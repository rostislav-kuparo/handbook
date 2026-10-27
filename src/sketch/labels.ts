// Labels of a drawing written by the handwriting engine — the same letters,
// joins and indices as the text around it, not a font.
import { LINE_HEIGHT_UNITS } from '../editor/layout';
import { SCRIPT_SCALE, SCRIPT_SHIFT } from '../editor/marks';
import type { MathRun } from '../editor/tex';
import { engine, type Deal } from '../engine/client';
import { fallbackWidths } from '../engine/fallbackMetrics';
import { getHandwriting, hasGlyph } from '../engine/handwriting';

/** A written label in font units, as the engine wrote it (y down, baseline at the ascent). */
export interface LabelInk {
  d: string;
  fallback: { ch: string; x: number; y: number; scale: number }[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Variants used last after this label: pass it on to the next label of the drawing. */
  deal: Deal;
}

/** Signs the hand may not have written yet are drawn with their plain look-alikes. */
function substitute(text: string): string {
  return text
    .replace(/[−′]/g, (c) => {
      const alt = c === '−' ? '-' : "'";
      return !hasGlyph(c) && hasGlyph(alt) ? alt : c;
    })
    .replace(/\s*≡\s*/g, () => (hasGlyph('≡') ? ' ≡ ' : ', '));
}

const cache = new Map<string, Promise<LabelInk>>();
let cacheFont = -1;

/**
 * Ink of a label (cached; the same text, seed and variants used before always
 * look the same). `deal`: the variants the drawing's labels before this one
 * used last, so a letter repeated from label to label (M₄₁, M₄₂, the cells of
 * a determinant) takes another variant each time.
 */
export async function labelInk(runs: MathRun[], seed: number, deal: Deal = {}): Promise<LabelInk> {
  const { fontVersion } = getHandwriting();
  if (fontVersion !== cacheFont) {
    cache.clear();
    cacheFont = fontVersion;
  }
  let text = '';
  const scales: number[] = [];
  const shifts: number[] = [];
  for (const r of runs) {
    const t = substitute(r.text);
    text += t;
    for (const _ of t) {
      scales.push(r.script ? SCRIPT_SCALE : 1);
      shifts.push(r.script ? SCRIPT_SHIFT[r.script] : 0);
    }
  }
  // Only the letters of this label matter to it: other labels' changes keep it cached.
  const own = Object.fromEntries(Object.entries(deal).filter(([k]) => [...k].every((c) => text.includes(c))));
  const key = `${seed}|${JSON.stringify(runs)}|${JSON.stringify(own)}`;
  let job = cache.get(key);
  if (!job) {
    job = written(text, seed, scales, shifts, own);
    cache.set(key, job);
    job.catch(() => cache.delete(key));
  }
  const ink = await job;
  return { ...ink, deal: { ...deal, ...ink.deal } };
}

function written(text: string, seed: number, scales: number[], shifts: number[], deal: Deal): Promise<LabelInk> {
  return engine.renderParagraph(text, 1e7, LINE_HEIGHT_UNITS, seed, { scales, colors: [], shifts, deal }).then((r) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const nums = r.d.match(/-?\d+(?:\.\d+)?/g) ?? [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = Number(nums[i]);
      const y = Number(nums[i + 1]);
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    const fallback = r.fallback.map((f) => ({ ch: f.ch, x: f.x, y: f.y, scale: f.scale }));
    for (const f of fallback) {
      const w = (fallbackWidths(f.ch, () => false)[f.ch] ?? 500) * f.scale;
      x0 = Math.min(x0, f.x);
      x1 = Math.max(x1, f.x + w);
      y0 = Math.min(y0, f.y - 720 * f.scale);
      y1 = Math.max(y1, f.y + 200 * f.scale);
    }
    if (!Number.isFinite(x0)) x0 = y0 = x1 = y1 = 0;
    return { d: r.d, fallback, x0, y0, x1, y1, deal: r.deal };
  });
}
