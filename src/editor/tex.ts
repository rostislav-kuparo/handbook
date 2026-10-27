// Formulas written in LaTeX ($f_1$, \(\Pi_1\), $$x^2$$ — what ChatGPT, Gemini,
// Wikipedia and many sites copy) turned into plain handwriting text: Greek
// letters and math signs become characters, _ and ^ become index letters.
// Anything the notebook cannot draw (fractions, roots over long expressions)
// is spelled out on one line: \frac{a+b}{2} → (a+b)/2.

import type { ScriptKind } from './marks';

/** A piece of converted text: plain, or an index (subscript / superscript). */
export interface MathRun {
  text: string;
  script?: ScriptKind;
}

const SYMBOLS: Record<string, string> = {
  // Greek
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο',
  pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // operations
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', ast: '*', star: '⋆', circ: '∘', bullet: '•',
  // relations
  le: '≤', leq: '≤', leqslant: '≤', ge: '≥', geq: '≥', geqslant: '≥', ne: '≠', neq: '≠',
  approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫',
  perp: '⊥', parallel: '∥', mid: '|', nmid: '∤',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨',
  // arrows
  to: '→', rightarrow: '→', longrightarrow: '→', leftarrow: '←', gets: '←', longleftarrow: '←',
  leftrightarrow: '↔', Rightarrow: '⇒', Longrightarrow: '⇒', implies: '⇒', Leftarrow: '⇐',
  Leftrightarrow: '⇔', iff: '⇔', mapsto: '↦', uparrow: '↑', downarrow: '↓',
  longleftrightarrow: '↔', Longleftarrow: '⇐', Longleftrightarrow: '⇔',
  // geometry and the rest
  angle: '∠', measuredangle: '∡', triangle: '△', square: '□', degree: '°', prime: '′',
  infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫', oint: '∮',
  ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', langle: '⟨', rangle: '⟩',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', vert: '|', Vert: '∥', backslash: '\\',
  hbar: 'ħ', ell: 'ℓ', aleph: 'ℵ', therefore: '∴', because: '∵',
};

/** Written as words, like in a textbook. */
const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'tg', 'cot', 'ctg', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'arctg',
  'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'lim', 'min', 'max', 'sup', 'inf', 'det',
  'deg', 'arg', 'dim', 'ker', 'gcd', 'mod', 'bmod', 'pmod',
]);

/** Layout-only commands. */
const IGNORED = new Set([
  'displaystyle', 'textstyle', 'scriptstyle', 'left', 'right', 'big', 'Big', 'bigg', 'Bigg',
  'bigl', 'bigr', 'Bigl', 'Bigr', 'middle', 'limits', 'nolimits', 'nonumber', 'notag',
]);

const SPACES: Record<string, string> = { ',': ' ', ';': ' ', ':': ' ', '>': ' ', ' ': ' ', '!': '', quad: ' ', qquad: ' ' };

/** One argument, read literally (\text{…}) or as math (\mathrm{…}, \vec{…}). */
const LITERAL_ARG = new Set(['text', 'textrm', 'textit', 'textbf', 'textup', 'mbox', 'operatorname']);
const MATH_ARG = new Set([
  'mathrm', 'mathit', 'mathbf', 'mathsf', 'mathtt', 'mathcal', 'mathfrak', 'boldsymbol', 'bm',
  'vec', 'overrightarrow', 'overline', 'underline', 'bar', 'hat', 'widehat', 'tilde', 'widetilde', 'dot', 'ddot',
]);
const BLACKBOARD: Record<string, string> = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ' };
const NEGATED: Record<string, string> = { '=': '≠', in: '∉', subset: '⊄', equiv: '≢', parallel: '∦' };

/** Every sign a LaTeX formula can turn into: the handwriting studio offers them for writing. */
export const TEX_CHARS = [...new Set([...Object.values(SYMBOLS), ...Object.values(BLACKBOARD), ...Object.values(NEGATED)])].filter(
  (c) => [...c].length === 1 && c.trim() !== '',
);

class TexReader {
  i = 0;
  private readonly s: string;
  constructor(src: string) {
    this.s = src;
  }

  get done() {
    return this.i >= this.s.length;
  }

  private skipSpace() {
    while (!this.done && /\s/.test(this.s[this.i])) this.i++;
  }

  /** `\name` (letters) or `\x` (one other character); the backslash is already read. */
  private command(): string {
    const m = /^[A-Za-z]+/.exec(this.s.slice(this.i));
    if (m) {
      this.i += m[0].length;
      return m[0];
    }
    return this.s[this.i++] ?? '';
  }

  /** Raw source of a {group}, without the braces. */
  private group(): string {
    let depth = 1;
    const start = ++this.i;
    while (!this.done) {
      const c = this.s[this.i];
      if (c === '\\') this.i += 2;
      else {
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
        this.i++;
      }
    }
    const out = this.s.slice(start, this.i);
    this.i++;
    return out;
  }

  /** Raw source of the next argument: a {group}, a \command or one character. */
  arg(): string {
    this.skipSpace();
    const c = this.s[this.i];
    if (c === '{') return this.group();
    if (c === '\\') {
      const start = this.i++;
      this.command();
      return this.s.slice(start, this.i);
    }
    this.i++;
    return c ?? '';
  }

  /** `[n]` option, if there is one. */
  option(): string | null {
    this.skipSpace();
    if (this.s[this.i] !== '[') return null;
    const end = this.s.indexOf(']', this.i);
    if (end < 0) return null;
    const out = this.s.slice(this.i + 1, end);
    this.i = end + 1;
    return out;
  }

  /** Convert everything; `script` marks the whole result as an index. */
  read(script?: ScriptKind): MathRun[] {
    const out: MathRun[] = [];
    const put = (text: string, kind = script) => {
      if (text) out.push({ text, script: kind });
    };
    const putRuns = (runs: MathRun[]) => out.push(...runs);
    while (!this.done) {
      const c = this.s[this.i];
      if (c === '\\') {
        this.i++;
        const name = this.command();
        if (name === '\\') put(' ');
        else if (name in SPACES) put(SPACES[name]);
        else if (IGNORED.has(name)) {
          // \left. and \right. are invisible delimiters.
          if ((name === 'left' || name === 'right') && this.s[this.i] === '.') this.i++;
        } else if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
          const num = convertTex(this.arg(), script);
          const den = convertTex(this.arg(), script);
          putRuns(wrapped(num, script));
          put('/');
          putRuns(wrapped(den, script));
        } else if (name === 'sqrt') {
          const n = this.option();
          if (n) putRuns(convertTex(n, 'sup'));
          put('√');
          putRuns(wrapped(convertTex(this.arg(), script), script));
        } else if (name === 'mathbb') {
          put([...this.arg()].map((ch) => BLACKBOARD[ch] ?? ch).join(''));
        } else if (LITERAL_ARG.has(name)) {
          put(this.arg());
        } else if (MATH_ARG.has(name)) {
          putRuns(convertTex(this.arg(), script));
        } else if (/^x(?:left|right|leftright|Left|Right|Leftright)arrow$/.test(name)) {
          // \xrightarrow[below]{above} on one line: the arrow, then its labels as indices.
          const below = this.option();
          const above = this.arg();
          put(SYMBOLS[name.slice(1)]);
          for (const [mark, kind] of [[above, 'sup'], [below ?? '', 'sub']] as [string, ScriptKind][]) {
            if (mark.trim()) putRuns(convertTex(mark, script ?? kind).map((r) => ({ ...r, script: script ?? kind })));
          }
        } else if (name === 'overset' || name === 'stackrel' || name === 'underset') {
          const mark = this.arg();
          putRuns(convertTex(this.arg(), script));
          const kind: ScriptKind = name === 'underset' ? 'sub' : 'sup';
          putRuns(convertTex(mark, script ?? kind).map((r) => ({ ...r, script: script ?? kind })));
        } else if (name === 'not') {
          const next = this.arg().replace(/^\\/, '');
          put(NEGATED[next] ?? SYMBOLS[next] ?? next);
        } else if (name === 'begin' || name === 'end') {
          this.arg();
        } else if (FUNCTIONS.has(name)) {
          put(name === 'bmod' || name === 'pmod' ? 'mod' : name);
        } else if (name in SYMBOLS) {
          put(SYMBOLS[name]);
        } else if (/^[A-Za-z]/.test(name)) {
          put(name);
        } else {
          // \{ \} \% \$ \# \& \_
          put(name);
        }
      } else if (c === '_' || c === '^') {
        this.i++;
        const raw = this.arg().trim();
        const kind: ScriptKind = c === '_' ? 'sub' : 'sup';
        // Degrees and primes are signs of their own, not indices.
        if (kind === 'sup' && /^\\circ$|^\\degree$|^o$/.test(raw)) put('°', script);
        else if (kind === 'sup' && /^(\\prime|')+$/.test(raw)) put('′'.repeat(Math.max(1, raw.split(/\\prime|'/).length - 1)), script);
        else putRuns(convertTex(raw, script ?? kind).map((r) => ({ ...r, script: script ?? kind })));
      } else if (c === '{') {
        putRuns(convertTex(this.group(), script));
      } else if (c === '}') {
        this.i++;
      } else if (c === "'") {
        this.i++;
        put('′');
      } else if (c === '~') {
        this.i++;
        put(' ');
      } else if (c === '&') {
        this.i++;
        put(' ');
      } else if (/\s/.test(c)) {
        this.skipSpace();
        put(' ');
      } else {
        this.i++;
        put(c);
      }
    }
    return out;
  }
}

/** Fraction parts and roots over more than one symbol get brackets: (a+b)/2, √(x+1). */
function wrapped(runs: MathRun[], script?: ScriptKind): MathRun[] {
  const text = runs.map((r) => r.text).join('').trim();
  if ([...text].length <= 1 || /^[\p{L}\p{N}.,]+$/u.test(text) || /^\(.*\)$/.test(text)) return runs;
  return [{ text: '(', script }, ...runs, { text: ')', script }];
}

/** Merge neighbours of the same kind and tidy the spaces. */
function tidy(runs: MathRun[]): MathRun[] {
  const out: MathRun[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.script === r.script) last.text += r.text;
    else out.push({ ...r });
  }
  for (const r of out) r.text = r.text.replace(/\s+/g, ' ');
  if (out.length) {
    out[0].text = out[0].text.replace(/^\s+/, '');
    out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
  }
  return out.filter((r) => r.text);
}

/** LaTeX source (without the $ delimiters) as handwriting text with indices. */
export function convertTex(src: string, script?: ScriptKind): MathRun[] {
  return tidy(new TexReader(src).read(script));
}

/**
 * Formulas inside ordinary text: $…$, $$…$$, \(…\), \[…\], '''…''' (three
 * apostrophes, as some notes mark them). A lone dollar ("$5 and $10") is left
 * alone: the inner text may not start or end with a space and the closing $
 * may not be followed by a digit.
 */
const MATH_IN_TEXT = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)([^$\n]*?[^$\s\\])\$(?!\d)|['’]{3}([\s\S]+?)['’]{3}/g;

const texOf = (m: RegExpMatchArray) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '';

/** Determinants, matrices, systems: tables a line of text cannot hold (they become blocks of their own). */
export const hasTable = (tex: string) => /\\begin\s*\{\s*(array|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix|cases)\s*\}/.test(tex);

/** Text with its formulas converted; null when there is no formula in it. Formulas with tables stay as they are. */
export function convertMathInText(text: string): MathRun[] | null {
  const out: MathRun[] = [];
  let last = 0;
  let found = false;
  for (const m of text.matchAll(MATH_IN_TEXT)) {
    const tex = texOf(m);
    if (hasTable(tex)) continue;
    found = true;
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    out.push(...convertTex(tex));
    last = m.index! + m[0].length;
  }
  if (!found) return null;
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.filter((r) => r.text);
}

/**
 * Text cut around its formulas with tables: the stretches between (from–to,
 * spaces at their ends left out; their other formulas still in them) and the
 * tables' formulas; null when it has none.
 */
export function splitTables(text: string): ({ from: number; to: number } | { tex: string })[] | null {
  const out: ({ from: number; to: number } | { tex: string })[] = [];
  const stretch = (from: number, to: number) => {
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    if (to > from) out.push({ from, to });
  };
  let last = 0;
  for (const m of text.matchAll(MATH_IN_TEXT)) {
    const tex = texOf(m);
    if (!hasTable(tex)) continue;
    stretch(last, m.index!);
    out.push({ tex: tex.trim() });
    last = m.index! + m[0].length;
  }
  if (last === 0) return null;
  stretch(last, text.length);
  return out;
}

export function countMathInText(text: string): number {
  return [...text.matchAll(MATH_IN_TEXT)].length;
}

/** A $…$ (or '''…''') formula just closed by typing its last character (for the input rule). */
export const TYPED_MATH = /(?:^|\s)(\$(?!\s)[^$\n]*?[^$\s\\]\$)$|(['’]{3}(?:(?!['’]{3})[^\n])+?['’]{3})$/;
