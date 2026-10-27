/**
 * A shelf of the handwriting studio's alphabet: one script in one case, or
 * all the symbols (they have no case). The pills under the alphabet pick it.
 */
export type Shelf = 'cyr-lower' | 'cyr-upper' | 'lat-lower' | 'lat-upper' | 'sym';

export interface CharGroup {
  id: string;
  title: string;
  chars: string[];
  shelf: Shelf;
}

const range = (from: string, to: string) =>
  Array.from({ length: to.codePointAt(0)! - from.codePointAt(0)! + 1 }, (_, i) =>
    String.fromCodePoint(from.codePointAt(0)! + i),
  );

// Ё/ё live outside the contiguous А–я block.
const cyrLower = [...range('а', 'е'), 'ё', ...range('ж', 'я')];
const cyrUpper = [...range('А', 'Е'), 'Ё', ...range('Ж', 'Я')];

/** The most frequent Russian letter pairs: writing them in one go captures natural joins. */
export const SUGGESTED_PAIRS = [
  'ст', 'но', 'то', 'на', 'ен', 'ов', 'ни', 'ра', 'во', 'ко', 'пр', 'ро',
  'ос', 'ал', 'ли', 'ер', 'от', 'по', 'ет', 'ол', 'ре', 'ка', 'ле', 'ом',
];

export const CHAR_GROUPS: CharGroup[] = [
  { id: 'cyr-lower', title: 'Русские', chars: cyrLower, shelf: 'cyr-lower' },
  { id: 'ukr-lower', title: 'Українські', chars: ['і', 'ї', 'є'], shelf: 'cyr-lower' },
  { id: 'pairs', title: 'Пары букв', chars: SUGGESTED_PAIRS, shelf: 'cyr-lower' },
  { id: 'cyr-upper', title: 'Русские', chars: cyrUpper, shelf: 'cyr-upper' },
  { id: 'ukr-upper', title: 'Українські', chars: ['І', 'Ї', 'Є'], shelf: 'cyr-upper' },
  { id: 'lat-lower', title: 'Latin', chars: range('a', 'z'), shelf: 'lat-lower' },
  { id: 'lat-upper', title: 'Latin', chars: range('A', 'Z'), shelf: 'lat-upper' },
  { id: 'digits', title: 'Цифры', chars: range('0', '9'), shelf: 'sym' },
  { id: 'punct', title: 'Знаки', chars: [...'.,!?:;-—«»"()№%+=/'], shelf: 'sym' },
  { id: 'math', title: 'Формулы', chars: [...'αβγδεθλμπρσφωΔΣΩ×·−±≠≈≤≥<>°′⊥∥∠△√∞∈→'], shelf: 'sym' },
];

const isLatin = (key: string) => /\p{Script=Latin}/u.test(key);

/** The shelf a letter, pair or sign is found on. */
export function shelfOf(key: string): Shelf {
  const group = CHAR_GROUPS.find((g) => g.chars.includes(key));
  if (group) return group.shelf;
  if (isPair(key)) return isLatin(key) ? 'lat-lower' : 'cyr-lower';
  return 'sym';
}

/** Own pairs go to their script's lowercase shelf. */
export const pairShelf = (pair: string): Shelf => (isLatin(pair) ? 'lat-lower' : 'cyr-lower');

/** Lowercase letters that stay within the x-height (no ascender or descender in cursive). */
const X_HEIGHT_LETTERS = new Set([...'аеёжийклмнопстчшъыьэюяґіїєaceimnorsuvwxz']);

/**
 * A lowercase letter written much taller than the x-height is probably a
 * capital (or written at the wrong size): the engine would learn that size.
 */
export function looksTooTall(ch: string, yMax: number, xHeight: number): boolean {
  return X_HEIGHT_LETTERS.has(ch) && yMax > xHeight * 1.35;
}

/** Characters (or pairs) that may join neighbours in cursive. */
export function isLetter(ch: string): boolean {
  return /^\p{L}/u.test(ch);
}

/** A key is a single character or a letter pair (2–3 letters). */
export function isPair(key: string): boolean {
  return [...key].length > 1;
}

export const PANGRAM = 'Съешь же ещё этих мягких французских булок, да выпей чаю';

/** Change a phrase's case: Аа = capital first letter, АА = all capitals, аа = all small. */
export function changeCase(text: string, mode: 'capital' | 'upper' | 'lower'): string {
  if (mode === 'upper') return text.toUpperCase();
  const lower = text.toLowerCase();
  if (mode === 'lower') return lower;
  return lower.replace(/\p{L}/u, (ch) => ch.toUpperCase());
}
