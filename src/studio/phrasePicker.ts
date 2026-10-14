// Picks the next practice word for the phrase mode: random word, random case
// (все строчные / С заглавной / ВСЕ ЗАГЛАВНЫЕ), weighted towards the letters
// that still have fewer than three variants — so one round through the list
// colours in the whole alphabet. Formulas are taken as written (case matters
// there) and count every sign, digit and letter.
import { changeCase } from '../model/alphabet';

export type PhraseLang = 'ru' | 'la' | 'uk' | 'math';
export type CaseMode = 'lower' | 'capital' | 'upper';

/** Base words (lower case). Together they contain every letter of their alphabet. */
export const PHRASE_WORDS: Record<PhraseLang, string[]> = {
  ru: [
    'привет', 'строка', 'молоко', 'ночной', 'жизнь', 'щука', 'цветы', 'фея', 'юла', 'хвост', 'эхо', 'съёмка',
    'йогурт', 'чайник', 'буква', 'шёпот', 'зебра', 'мягкий', 'гусь', 'дом', 'анна', 'борис', 'вера', 'галина',
    'дмитрий', 'ева', 'ёлка', 'жанна', 'зоя', 'игорь', 'йод', 'ксения', 'лев', 'москва', 'нина', 'ольга', 'пётр',
    'россия', 'света', 'тула', 'ульяна', 'фёдор', 'харьков', 'цветаева', 'чехов', 'шура', 'щукин', 'эдуард',
    'юрий', 'яна', 'жук', 'слон', 'мёд', 'газ', 'щель', 'цыплёнок', 'фильм', 'чай', 'хор', 'яблоко', 'подъезд',
    'бык', 'шар', 'зима', 'вода', 'клён', 'объём', 'мышь', 'въезд', 'семья',
  ],
  la: [
    'hello', 'world', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'zebra', 'juice', 'vivid', 'paris',
    'london', 'berlin', 'quebec', 'wyoming', 'mexico', 'zurich', 'jazz', 'kiwi', 'yacht', 'galaxy',
  ],
  uk: ['їжак', 'єнот', 'ліс', 'їжа', 'київ', 'європа', 'іван', 'їжакові', 'інший', 'єдність', 'країна', 'мрія'],
  // Short equations and statements: every sign of the «Формулы» group, digits, Latin and Greek letters.
  math: [
    'a + b = c', 'x − 7 = 3', '2 × 3 = 6', 'y = 2x + 1', 'S = a · b', 'P = 2(a + b)', '12 ÷ 4 = 3',
    'a ≠ b', 'x ≤ 5', 'y ≥ 0', 'a < b < c', 'k > 1', 'π ≈ 3,14', 'x ≡ 1', 'a ± b', '√16 = 4',
    'α + β = 90°', '∠A = 45°', 'γ = 180° − α', 'φ = 60°', 'θ ≈ 0,5', 'a ⊥ b', 'AB ∥ CD', '△ABC',
    'Δ > 0', 'λ = 2π', 'μ ≠ 0', 'σ ≥ 1', 'ω = 2πf', 'ρ = m ÷ V', 'F = m · a', 'U = I · R', 'ε < δ',
    'x ∈ A', 'A ⊂ B', 'A ∪ B', 'A ∩ B = ∅', '∀x ∃y', 'x → ∞', 'a ⇒ b', 'Σ = 45', 'Ω = 8', 'x′ = 3x',
    'f(x) = 0', 'y = kx + b', 'V = abc', '∫ f dx',
  ],
};

export const LANG_TITLES: Record<PhraseLang, string> = { ru: 'Русский', la: 'Latin', uk: 'Українська', math: 'Формулы' };

const CASES: CaseMode[] = ['lower', 'capital', 'upper'];
export const TARGET_VARIANTS = 3;

export interface Pick {
  text: string;
  mode: CaseMode;
  /** How many still-missing variants this phrase adds. */
  gain: number;
}

/**
 * Choose the next phrase. `count(letter)` = recorded variants of that letter.
 * Words just used are skipped.
 */
export function pickPhrase(lang: PhraseLang, count: (letter: string) => number, recent: string[]): Pick {
  const candidates: Pick[] = [];
  const math = lang === 'math';
  for (const word of PHRASE_WORDS[lang]) {
    for (const mode of math ? (['lower'] as CaseMode[]) : CASES) {
      const text = math ? word : changeCase(word, mode);
      if (recent.includes(text)) continue;
      const letters = new Set([...text].filter((c) => (math ? /\S/u : /\p{L}/u).test(c)));
      let gain = 0;
      for (const l of letters) gain += Math.max(0, TARGET_VARIANTS - count(l));
      candidates.push({ text, mode, gain });
    }
  }
  if (candidates.length === 0) return { text: PHRASE_WORDS[lang][0], mode: 'lower', gain: 0 };
  const best = Math.max(...candidates.map((c) => c.gain));
  // Everything covered: just random words and cases for variety.
  const pool = best > 0 ? candidates.filter((c) => c.gain >= best * 0.6) : candidates;
  const weights = pool.map((c) => (best > 0 ? c.gain ** 1.5 : 1));
  let r = Math.random() * weights.reduce((a, w) => a + w, 0);
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}
