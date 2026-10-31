// «Надпись»: a few words in the user's hand anywhere on a sheet — an answer
// on a blank, a name on its line. Its text is plain: formulas between $…$
// (or '''…''') and indices written as A_1, x^2, as in the drawings' labels.
import { engine, type ParagraphRender } from '../engine/client';
import { LINE_HEIGHT_UNITS } from '../editor/layout';
import { SCRIPT_SCALE, SCRIPT_SHIFT } from '../editor/marks';
import { MM } from '../editor/page';
import { convertMathInText, type MathRun } from '../editor/tex';
import { CAP_HEIGHT, UNITS_PER_EM } from '../model/types';
import { hasGlyph } from '../engine/handwriting';
import { romanize } from './roman';

/** Letter size of a new note: capitals this tall, mm (school handwriting). */
export const NOTE_SIZE = 4;
export const NOTE_SIZES = { min: 2, max: 12 };

/** Letter size (px per em) for capitals `mm` tall. */
export const noteFontSize = (mm: number) => (Math.min(Math.max(mm || NOTE_SIZE, NOTE_SIZES.min), NOTE_SIZES.max) * MM * UNITS_PER_EM) / CAP_HEIGHT;

/** A_1, x^2, B_{12}: the letter's index or power. */
const INDEX = /([_^])(\{([^}]*)\}|([\p{L}\p{N}]))/gu;

function indexRuns(text: string): MathRun[] {
  const out: MathRun[] = [];
  let last = 0;
  for (const m of text.matchAll(INDEX)) {
    // Only right after a letter, digit or closing bracket: a lone «_» stays.
    if (m.index === 0 || !/[\p{L}\p{N})']/u.test(text[m.index! - 1])) continue;
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[3] ?? m[4], script: m[1] === '_' ? 'sub' : 'sup' });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** One line of a note's text as runs: plain, index or power. */
export function noteRuns(line: string): MathRun[] {
  const math = convertMathInText(line) ?? [{ text: line }];
  return math.flatMap((r) => (r.script ? [r] : indexRuns(r.text))).filter((r) => r.text);
}

/** The note's paragraphs (one per line of its text) as the engine takes them. */
export function noteParagraphs(text: string, flip: number[] = []): { text: string; scales: number[]; colors: number[]; shifts: number[] }[] {
  // Roman numerals become sticks (`flip`: words set by hand, see romanWords).
  return romanize(text, flip, hasGlyph).split('\n').map((line) => {
    const runs = noteRuns(line);
    const out = { text: '', scales: [] as number[], colors: [] as number[], shifts: [] as number[] };
    for (const r of runs) {
      out.text += r.text;
      for (const _ of r.text) {
        out.scales.push(r.script ? SCRIPT_SCALE : 1);
        out.shifts.push(r.script ? SCRIPT_SHIFT[r.script] : 0);
        out.colors.push(0);
      }
    }
    return out;
  });
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * The note written by hand, `width` px wide at letter size `fontSize`: each
 * paragraph's render (null for an empty line). `skeleton`: with the pen's
 * centre lines, for a photo. The same text always comes out the same.
 */
export async function writeNote(text: string, width: number, fontSize: number, seed: number, skeleton = false, flip: number[] = []): Promise<(ParagraphRender | null)[]> {
  const out: (ParagraphRender | null)[] = [];
  const units = (Math.max(width, fontSize * 2) / fontSize) * 1000;
  for (const [i, p] of noteParagraphs(text, flip).entries()) {
    out.push(
      p.text.trim()
        ? await engine.renderParagraph(p.text, units, LINE_HEIGHT_UNITS, (seed ^ hash(`${i}|${p.text}`)) >>> 0, {
            scales: p.scales,
            colors: p.colors,
            shifts: p.shifts,
            skeleton,
          })
        : null,
    );
  }
  return out;
}

/** The seed a note is written with: the document's, varied by the note's place in it (the same in every view and export). */
export const noteSeed = (docSeed: number, node: number) => (docSeed ^ Math.imul(node + 1, 2654435761)) >>> 0;
