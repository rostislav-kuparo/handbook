// The language of «Чертёж» blocks: GeoGebra-style commands, one per line.
//
// The text says only *what* to draw. How it looks — the hand, the pen, where
// the labels go — is decided by the app, so the same text always gives the
// same drawing, whoever (or whichever neural net) wrote it.

export type CmpOp = '<' | '>' | '<=' | '>=' | '==' | '!=';
export type BinOp = '+' | '-' | '*' | '/' | '^';

export type Expr =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'name'; name: string }
  | { t: 'tuple'; items: Expr[] }
  | { t: 'call'; name: string; args: Expr[] }
  | { t: 'bin'; op: BinOp; a: Expr; b: Expr }
  | { t: 'neg'; a: Expr }
  | { t: 'abs'; a: Expr }
  | { t: 'cmp'; ops: CmpOp[]; items: Expr[] };

export type Statement =
  /** A = (1, 2), s = Segment(A, B), r = 3 */
  | { kind: 'define'; name: string; expr: Expr }
  /** f(x) = sin(x) */
  | { kind: 'function'; name: string; param: string; expr: Expr }
  /** y = 2x + 1, or a: y = 2x + 1 */
  | { kind: 'graph'; name?: string; expr: Expr }
  /** x = 3 */
  | { kind: 'vline'; name?: string; expr: Expr }
  /** Segment(A, B), Title("…") */
  | { kind: 'expr'; expr: Expr };

type Tok = { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'id'; v: string } | { k: 'op'; v: string };

const OP_ALIASES: Record<string, string> = {
  '−': '-',
  '–': '-',
  '—': '-',
  '·': '*',
  '⋅': '*',
  '×': '*',
  '÷': '/',
  '≤': '<=',
  '≥': '>=',
  '≠': '!=',
  ';': ',',
  // Old GeoGebra writes commands with brackets: Segment[A, B]
  '[': '(',
  ']': ')',
};
const OPS = new Set(['+', '-', '*', '/', '^', '(', ')', '=', ',', ':', '<', '>', '|', '√', '°']);
const CMP = new Set(['<', '>', '<=', '>=', '==', '!=']);
const QUOTES: Record<string, string> = { '"': '"', '«': '»', '“': '”', '„': '“' };

const isLetter = (c: string | undefined) => !!c && c !== 'π' && /\p{L}/u.test(c);
const isDigit = (c: string | undefined) => !!c && c >= '0' && c <= '9';

/** Cyrillic letters that look Latin: «А» typed in a Russian layout is the same point as «A». */
const LOOKALIKE: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x',
};

/** The key a name is looked up by: A_{1} = A_1, Cyrillic «А» = Latin «A», A′ = A'. */
export function canon(name: string): string {
  return name
    .replace(/_\{([^}]*)\}/, '_$1')
    .replace(/′/g, "'")
    .replace(/[АВЕКМНОРСТХаеорсух]/g, (c) => LOOKALIKE[c] ?? c);
}

/** The line without a trailing comment (# or //), quotes respected. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c in QUOTES) quote = QUOTES[c];
    else if (c === '#' || (c === '/' && line[i + 1] === '/')) return line.slice(0, i);
  }
  return line;
}

/** «;» between arguments means commas are decimal commas: (2,5; 3). */
function usesSemicolons(line: string): boolean {
  let quote: string | null = null;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c in QUOTES) quote = QUOTES[c];
    else if (c === ';') return true;
  }
  return false;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const number = usesSemicolons(src) ? /\d+(?:[.,]\d+)?|\.\d+/y : /\d+(?:\.\d+)?|\.\d+/y;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c in QUOTES) {
      const end = src.indexOf(QUOTES[c], i + 1);
      if (end < 0) throw new Error('не закрыта кавычка');
      toks.push({ k: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    number.lastIndex = i;
    const m = number.exec(src);
    if (m) {
      toks.push({ k: 'num', v: parseFloat(m[0].replace(',', '.')) });
      i += m[0].length;
      continue;
    }
    if (isLetter(c)) {
      // A name: letters and digits, then an index (A_1, A_{12}), then primes (A', A'').
      let j = i + 1;
      while (isLetter(src[j]) || isDigit(src[j])) j++;
      if (src[j] === '_') {
        if (src[j + 1] === '{') {
          const end = src.indexOf('}', j);
          if (end < 0) throw new Error('не закрыта фигурная скобка в индексе');
          j = end + 1;
        } else {
          let k = j + 1;
          while (isLetter(src[k]) || isDigit(src[k])) k++;
          if (k > j + 1) j = k;
        }
      }
      while (src[j] === "'" || src[j] === '′') j++;
      toks.push({ k: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (CMP.has(two) || two === ':=' || two === '**') {
      toks.push({ k: 'op', v: two === ':=' ? '=' : two === '**' ? '^' : two });
      i += 2;
      continue;
    }
    if (c === '²' || c === '³') {
      toks.push({ k: 'op', v: '^' }, { k: 'num', v: c === '²' ? 2 : 3 });
      i++;
      continue;
    }
    if (c === 'π') {
      toks.push({ k: 'id', v: 'pi' });
      i++;
      continue;
    }
    if (c === '∞') {
      toks.push({ k: 'id', v: 'inf' });
      i++;
      continue;
    }
    const op = OP_ALIASES[c] ?? c;
    if (OPS.has(op)) {
      toks.push({ k: 'op', v: op });
      i++;
      continue;
    }
    throw new Error(`непонятный знак «${c}»`);
  }
  return toks;
}

/** Math functions that may be written without brackets: sin x. */
const PREFIX_FUNCTIONS = new Set(['sin', 'cos', 'tan', 'tg', 'cot', 'ctg', 'ln', 'lg', 'log', 'sqrt', 'exp', 'abs']);

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }
  private isOp(v: string, o = 0): boolean {
    const t = this.peek(o);
    return t?.k === 'op' && t.v === v;
  }
  private take(v: string) {
    if (!this.isOp(v)) {
      const t = this.peek();
      throw new Error(t ? `ожидалась «${v}» вместо «${show(t)}»` : `ожидалась «${v}»`);
    }
    this.i++;
  }

  all(): Expr {
    const e = this.expr();
    const rest = this.peek();
    if (rest) throw new Error(`лишнее «${show(rest)}»`);
    return e;
  }

  private expr(): Expr {
    const first = this.additive();
    const ops: CmpOp[] = [];
    const items = [first];
    for (let t = this.peek(); t?.k === 'op' && CMP.has(t.v); t = this.peek()) {
      this.i++;
      ops.push(t.v as CmpOp);
      items.push(this.additive());
    }
    return ops.length ? { t: 'cmp', ops, items } : first;
  }

  private additive(): Expr {
    let a = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.toks[this.i++] as { v: BinOp }).v;
      a = { t: 'bin', op, a, b: this.term() };
    }
    return a;
  }

  private term(): Expr {
    let a = this.unary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/')) {
        const op = (this.toks[this.i++] as { v: BinOp }).v;
        a = { t: 'bin', op, a, b: this.unary() };
      } else if (this.startsAtom()) {
        // 2x, 2(x + 1), 3sin(x), 2pi
        a = { t: 'bin', op: '*', a, b: this.power() };
      } else return a;
    }
  }

  private startsAtom(): boolean {
    const t = this.peek();
    return !!t && (t.k === 'num' || t.k === 'id' || (t.k === 'op' && (t.v === '(' || t.v === '√')));
  }

  private unary(): Expr {
    if (this.isOp('-')) {
      this.i++;
      return { t: 'neg', a: this.unary() };
    }
    if (this.isOp('+')) {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  private power(): Expr {
    const a = this.postfix();
    if (!this.isOp('^')) return a;
    this.i++;
    return { t: 'bin', op: '^', a, b: this.unary() };
  }

  private postfix(): Expr {
    let a = this.atom();
    while (this.isOp('°')) {
      this.i++;
      a = { t: 'bin', op: '*', a, b: { t: 'num', v: Math.PI / 180 } };
    }
    return a;
  }

  private atom(): Expr {
    const t = this.toks[this.i++];
    if (!t) throw new Error('строка оборвалась');
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'str') return { t: 'str', v: t.v };
    if (t.k === 'op') {
      if (t.v === '(') {
        const items = [this.expr()];
        while (this.isOp(',')) {
          this.i++;
          items.push(this.expr());
        }
        this.take(')');
        return items.length === 1 ? items[0] : { t: 'tuple', items };
      }
      if (t.v === '|') {
        const a = this.expr();
        this.take('|');
        return { t: 'abs', a };
      }
      if (t.v === '√') return { t: 'call', name: 'sqrt', args: [this.postfix()] };
      throw new Error(`не ожидалось «${t.v}»`);
    }
    if (this.isOp('(')) return { t: 'call', name: t.v, args: this.args() };
    if (PREFIX_FUNCTIONS.has(t.v.toLowerCase()) && this.startsAtom()) {
      return { t: 'call', name: t.v, args: [this.power()] };
    }
    return { t: 'name', name: t.v };
  }

  private args(): Expr[] {
    this.take('(');
    const out: Expr[] = [];
    if (this.isOp(')')) {
      this.i++;
      return out;
    }
    out.push(this.expr());
    while (this.isOp(',')) {
      this.i++;
      out.push(this.expr());
    }
    this.take(')');
    return out;
  }
}

function show(t: Tok): string {
  return t.k === 'str' ? `"${t.v}"` : String(t.v);
}

const isOpTok = (t: Tok | undefined, v: string) => t?.k === 'op' && t.v === v;

/**
 * One line of a drawing; null for empty lines, comments and the ``` fences
 * neural nets wrap their answers in.
 */
export function parseLine(raw: string): Statement | null {
  const text = stripComment(raw).trim();
  if (!text || text.startsWith('```') || text.startsWith('~~~')) return null;
  const toks = tokenize(text);
  if (!toks.length) return null;

  // GeoGebra names an equation like this: a: y = 2x + 1
  let name: string | undefined;
  let body = toks;
  if (toks[0].k === 'id' && isOpTok(toks[1], ':')) {
    name = toks[0].v;
    body = toks.slice(2);
  }
  let depth = 0;
  let eq = -1;
  for (let k = 0; k < body.length; k++) {
    if (isOpTok(body[k], '(')) depth++;
    else if (isOpTok(body[k], ')')) depth--;
    else if (depth === 0 && isOpTok(body[k], '=')) {
      eq = k;
      break;
    }
  }
  if (eq < 0) {
    const expr = new Parser(body).all();
    return name ? { kind: 'define', name, expr } : { kind: 'expr', expr };
  }
  const lhs = body.slice(0, eq);
  const expr = new Parser(body.slice(eq + 1)).all();
  if (lhs.length === 1 && lhs[0].k === 'id') {
    const key = canon(lhs[0].v);
    if (key === 'y') return { kind: 'graph', name, expr };
    if (key === 'x') return { kind: 'vline', name, expr };
    if (!name) return { kind: 'define', name: lhs[0].v, expr };
  }
  if (!name && lhs.length === 4 && lhs[0].k === 'id' && isOpTok(lhs[1], '(') && lhs[2].k === 'id' && isOpTok(lhs[3], ')')) {
    return { kind: 'function', name: lhs[0].v, param: lhs[2].v, expr };
  }
  if (lhs.some((t) => t.k === 'id' && canon(t.v) === 'y')) {
    throw new Error('такие уравнения не рисуются: запишите y = …, Circle(…) или Curve(…)');
  }
  throw new Error('слева от «=» должно быть имя: A = (1, 2) или f(x) = …');
}

/** 2.5 → «2,5», −3 with a real minus: numbers as they are written by hand. */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : v < 0 ? '−∞' : '?';
  const s = String(Math.round(v * 1e4) / 1e4);
  return s.replace('.', ',').replace('-', '−');
}
