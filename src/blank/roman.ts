// Roman numerals (I, II, IV чверті; XII століття) as they are written by hand
// in geometry: not letters of the handwriting but sticks with short serifs,
// drawn like the lines of a drawing. A numeral's letters are swapped for
// private characters the handwriting does not have: the engine leaves room
// for them (see `ROMAN_WIDTH`) and says where they are, and they are drawn there.

/** I, V, X, L as private characters (U+E101…), the engine's «unwritten» letters, drawn as sticks. */
export const ROMAN_CHAR: Record<string, string> = { I: '\uE101', V: '\uE102', X: '\uE103', L: '\uE104' };
const ROMAN_OF: Record<string, string> = { '\uE101': 'I', '\uE102': 'V', '\uE103': 'X', '\uE104': 'L' };

/** The numerals' own characters (Ⅰ Ⅴ Ⅹ Ⅼ Ⅽ Ⅾ Ⅿ): written by hand in «Почерк», they are used instead of the sticks. */
export const ROMAN_GLYPH: Record<string, string> = { I: 'Ⅰ', V: 'Ⅴ', X: 'Ⅹ', L: 'Ⅼ', C: 'Ⅽ', D: 'Ⅾ', M: 'Ⅿ' };

/** Advance widths of the sticks, font units (1000 per em; capitals are 700 tall). */
export const ROMAN_WIDTH: Record<string, number> = { '\uE101': 300, '\uE102': 560, '\uE103': 560, '\uE104': 470 };

export const isRomanChar = (ch: string) => ch in ROMAN_OF;

/** I, V, X, L, C, D, M — Latin, and the Cyrillic І and Х that look the same. */
const LETTER: Record<string, string> = { I: 'I', V: 'V', X: 'X', L: 'L', C: 'C', D: 'D', M: 'M', І: 'I', Х: 'X' };
const VALID = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
/** Words after which a lone I, V or X is a number. */
const AFTER = /^(чверт|четверт|октант|квадрант|век|столітт|стол|ст|семестр|курс|розділ|раздел|глав|варіант|вариант|груп|частин|пункт|том)/i;
const JOIN = /^[\s,;]*(?:(?:і|и|та|й|and|or|або|или)\s+)?[\s,;]*$/i;

export interface RomanWord {
  /** Where the word starts and ends in the text (UTF-16). */
  from: number;
  to: number;
  /** A number by the rules (or as set by hand). */
  roman: boolean;
}

/**
 * Words that may be Roman numerals: made only of I, V, X, L, C, D, M (and
 * the Cyrillic І, Х), a valid number up to 3999. A word of two letters or
 * more is one; a lone I, V or X only next to another numeral in a list
 * («І, ІІ, ІV») or before a word such as «чверть», «століття» (a lone L, C,
 * D or M never: they are letters far more often). `flip`: words (by where
 * they start) set by hand to the other way.
 */
export function romanWords(text: string, flip: number[] = []): RomanWord[] {
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ from: m.index!, to: m.index! + m[0].length, word: m[0] }));
  const isNumber = (w: string) => {
    if (![...w].every((c) => c in LETTER)) return false;
    const norm = [...w].map((c) => LETTER[c]).join('');
    return norm.length > 0 && VALID.test(norm);
  };
  const out: RomanWord[] = [];
  words.forEach((w, i) => {
    if (!isNumber(w.word)) return;
    let roman = w.word.length > 1;
    if (!roman && 'IVXІХ'.includes(w.word)) {
      const prev = words[i - 1];
      const next = words[i + 1];
      const near = (o: typeof w | undefined, a: number, b: number) => !!o && isNumber(o.word) && o.word.length > 1 && JOIN.test(text.slice(a, b));
      const listed = (o: typeof w | undefined, a: number, b: number) => !!o && isNumber(o.word) && JOIN.test(text.slice(a, b)) && /[,;]|\s(і|и|та|й)\s/i.test(text.slice(a, b));
      roman =
        near(prev, prev ? prev.to : 0, w.from) ||
        near(next, w.to, next ? next.from : 0) ||
        listed(prev, prev ? prev.to : 0, w.from) ||
        listed(next, w.to, next ? next.from : 0) ||
        (!!next && /^\s+$/.test(text.slice(w.to, next.from)) && AFTER.test(next.word));
    }
    if (flip.includes(w.from)) roman = !roman;
    out.push({ from: w.from, to: w.to, roman });
  });
  return out;
}

/**
 * The text with its Roman numerals written as numerals: each letter by the
 * hand's own numeral (Ⅰ, Ⅴ… written in «Почерк», `has`), else as sticks (I, V,
 * X, L). A numeral with a letter that has neither stays as it is typed.
 * `flip` as in `romanWords`.
 */
export function romanize(text: string, flip: number[] = [], has: (ch: string) => boolean = () => false): string {
  let out = '';
  let last = 0;
  for (const w of romanWords(text, flip)) {
    if (!w.roman) continue;
    const letters = [...text.slice(w.from, w.to)].map((c) => {
      const r = LETTER[c];
      return has(ROMAN_GLYPH[r]) ? ROMAN_GLYPH[r] : (ROMAN_CHAR[r] ?? null);
    });
    if (letters.some((c) => c === null)) continue;
    out += text.slice(last, w.from) + letters.join('');
    last = w.to;
  }
  return out + text.slice(last);
}

/** Back to plain letters (what the text says). */
export const unromanize = (text: string) => text.replace(/[-]/g, (c) => ROMAN_OF[c]).replace(/[Ⅰ-Ⅿ]/g, (c) => Object.keys(ROMAN_GLYPH).find((k) => ROMAN_GLYPH[k] === c) ?? c);

const rand = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
};

/**
 * The strokes of a numeral's letter at (x, y) — its left end on the
 * baseline, font units, `scale` × em — as polylines: the stick(s) and short
 * serifs at the top and the bottom, a little uneven as a hand draws them.
 */
export function romanStrokes(ch: string, x: number, y: number, scale: number, seed: number): [number, number][][] {
  const r = rand(seed);
  const s = scale;
  const top = y - 700 * s;
  const j = () => r() * 14 * s;
  const w = ROMAN_WIDTH[ch] * s;
  const serif = 95 * s;
  const out: [number, number][][] = [];
  const line = (x0: number, y0: number, x1: number, y1: number) => out.push([[x0 + j(), y0 + j()], [x1 + j(), y1 + j()]]);
  if (ROMAN_OF[ch] === 'I') {
    const cx = x + w / 2;
    line(cx, top, cx, y);
    line(cx - serif, top, cx + serif, top);
    line(cx - serif, y, cx + serif, y);
  } else if (ROMAN_OF[ch] === 'V') {
    const [a, b] = [x + 70 * s, x + w - 70 * s];
    line(a, top, x + w / 2, y);
    line(x + w / 2, y, b, top);
    line(a - serif * 0.7, top, a + serif * 0.7, top);
    line(b - serif * 0.7, top, b + serif * 0.7, top);
  } else if (ROMAN_OF[ch] === 'L') {
    const cx = x + 110 * s;
    line(cx, top, cx, y);
    line(cx - serif, top, cx + serif, top);
    line(cx - serif * 0.6, y, x + w - 40 * s, y);
    line(x + w - 40 * s, y, x + w - 30 * s, y - 120 * s);
  } else {
    const [a, b] = [x + 80 * s, x + w - 80 * s];
    line(a, top, b, y);
    line(b, top, a, y);
    line(a - serif * 0.7, top, a + serif * 0.7, top);
    line(b - serif * 0.7, top, b + serif * 0.7, top);
    line(a - serif * 0.7, y, a + serif * 0.7, y);
    line(b - serif * 0.7, y, b + serif * 0.7, y);
  }
  return out;
}

/** The numeral's letter as an SVG path (a stroke `width` font units wide is drawn along it). */
export function romanPath(ch: string, x: number, y: number, scale: number, seed: number): string {
  return romanStrokes(ch, x, y, scale, seed)
    .map((pts) => `M${pts.map(([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`).join('L')}`)
    .join('');
}

/** How thick the sticks are drawn, font units: the handwriting's pen. */
export const romanPen = (weight: number) => Math.max(30, weight * 1.05);

/** A numeral's letter written where the engine left room for it, as SVG (in the label's or line's own units). */
export function romanSvg(f: { ch: string; x: number; y: number; scale: number }, color: string | null, weight: number, seed: number): string {
  const paint = color ? `stroke="${color}"` : 'stroke="currentColor"';
  return `<path d="${romanPath(f.ch, f.x, f.y, f.scale, seed)}" fill="none" ${paint} stroke-width="${(romanPen(weight) * f.scale).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}
