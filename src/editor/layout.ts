import type { DocContent } from '../model/types';
import { SCRIPT_SCALE, SCRIPT_SHIFT, type ScriptKind } from './marks';

/** Editor line height in em; the ink renderer uses the same grid. */
export const LINE_HEIGHT_EM = 1.6;
export const LINE_HEIGHT_UNITS = LINE_HEIGHT_EM * 1000;
/** Font ascent/descent (crates/glyph-core/src/model.rs). */
const ASCENT = 850;
const DESCENT = 300;
/** Where the first baseline sits inside a line box, as in CSS (half-leading + ascent). */
export const FIRST_BASELINE_UNITS = (LINE_HEIGHT_UNITS - (ASCENT + DESCENT)) / 2 + ASCENT;
/** renderParagraph puts the first baseline at y = ASCENT; shift so lines match the editor. */
export const INK_VIEWBOX_TOP = ASCENT - FIRST_BASELINE_UNITS;

export interface PMNodeJSON {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PMNodeJSON[];
}

export function topLevelNodes(content: DocContent): PMNodeJSON[] {
  return ((content as { content?: PMNodeJSON[] }).content ?? []) as PMNodeJSON[];
}

export function textOf(node: PMNodeJSON): string {
  if (node.text) return node.text;
  return (node.content ?? []).map(textOf).join('');
}

/**
 * Seed of a document. The engine combines it with each word's own text, so
 * letters stay the same when other words or paragraphs are edited.
 */
export function docSeed(docId: string): number {
  let h = 2166136261;
  for (const c of docId) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Colours used in a document: index 0 is the document's pen, the rest come from coloured words. */
export class InkPalette {
  readonly colors: string[];
  constructor(base: string) {
    this.colors = [base];
  }
  index(color: string | undefined): number {
    if (!color) return 0;
    let i = this.colors.indexOf(color);
    if (i < 0) {
      this.colors.push(color);
      i = this.colors.length - 1;
    }
    return i;
  }
}

/** Text of a paragraph with the size factor, colour index and raise of every character (code point). */
export function paragraphRuns(
  node: PMNodeJSON,
  palette: InkPalette,
): { text: string; scales: number[]; colors: number[]; shifts: number[] } {
  let text = '';
  const scales: number[] = [];
  const colors: number[] = [];
  const shifts: number[] = [];
  for (const child of node.content ?? []) {
    if (!child.text) continue;
    const marks = (child as { marks?: { type: string; attrs?: Record<string, unknown> }[] }).marks ?? [];
    const size = Number(marks.find((m) => m.type === 'textSize')?.attrs?.scale ?? 1) || 1;
    const script = marks.find((m) => m.type === 'script')?.attrs?.kind as ScriptKind | undefined;
    const scale = script ? size * SCRIPT_SCALE : size;
    const shift = script ? size * (SCRIPT_SHIFT[script] ?? 0) : 0;
    const color = palette.index(marks.find((m) => m.type === 'inkColor')?.attrs?.color as string | undefined);
    text += child.text;
    for (const _ of child.text) {
      scales.push(scale);
      colors.push(color);
      shifts.push(shift);
    }
  }
  return { text, scales, colors, shifts };
}
