// Formulas a line of text cannot hold — determinants, matrices, systems —
// written by hand: the entries in rows and columns between hand-drawn bars,
// brackets or braces, the rest of the formula on either side. Such a formula
// lives in a drawing block whose code is the formula between $$ … $$, and is
// drawn like a drawing: lines by the pen, everything written by the
// handwriting engine.
import { convertTex, type MathRun } from '../editor/tex';
import type { InkPath, LabelRequest, SketchLayout } from './layout';
import { outline, rng, wobble, type Pen } from './pen';
import type { Vec } from './types';

/** Environments written as a table. */
export const MATRIX = /\\begin\s*\{\s*(array|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix|cases)\s*\}/;

/** The formula of a drawing block's code ($$ … $$), or null when the code is a drawing. */
export function formulaOf(code: string): string | null {
  const m = /^\s*\$\$([\s\S]*?)\$\$\s*$/.exec(code);
  return m ? m[1] : null;
}

type Delim = '' | '|' | '‖' | '(' | ')' | '[' | ']' | '{' | '}';

interface Table {
  kind: 'table';
  rows: string[][];
  /** Column alignments: l, c, r. */
  align: string;
  left: Delim;
  right: Delim;
}

type Part = { kind: 'text'; tex: string } | Table;

const ENV_DELIMS: Record<string, [Delim, Delim]> = {
  pmatrix: ['(', ')'],
  bmatrix: ['[', ']'],
  Bmatrix: ['{', '}'],
  vmatrix: ['|', '|'],
  Vmatrix: ['‖', '‖'],
  cases: ['{', ''],
};

/** A \left / \right delimiter as drawn. */
function delimOf(src: string): Delim {
  const s = src.replace(/\s/g, '');
  if (s === '|' || s === '\\vert' || s === '\\lvert' || s === '\\rvert') return '|';
  if (s === '\\|' || s === '\\Vert' || s === '\\lVert' || s === '\\rVert') return '‖';
  if (s === '\\{' || s === '\\lbrace') return '{';
  if (s === '\\}' || s === '\\rbrace') return '}';
  if (s === '(' || s === ')' || s === '[' || s === ']') return s;
  return '';
}

const DELIM_SRC = String.raw`(\\\{|\\\}|\\\||\\[lr]?[vV]ert|\\[lr]brace|[|()[\].])`;

/** Splits at a separator outside braces (& between cells, \\ between rows). */
function splitTop(src: string, sep: '&' | '\\\\'): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && sep === '&') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && src.startsWith(sep, i) && (sep === '&' || src[i - 1] !== '\\')) {
      out.push(src.slice(last, i));
      i += sep.length - 1;
      last = i + 1;
      // \\[4pt]: a row's extra space.
      if (sep === '\\\\') {
        const m = /^\s*\[[^\]]*\]/.exec(src.slice(last));
        if (m) {
          last += m[0].length;
          i = last - 1;
        }
      }
    } else if (c === '\\') i++;
  }
  out.push(src.slice(last));
  return out;
}

/** The formula as text between tables. */
function parse(tex: string): Part[] {
  const parts: Part[] = [];
  const open = new RegExp(String.raw`(?:\\left\s*${DELIM_SRC}\s*)?\\begin\s*\{\s*(\w+)\s*\}`, 'g');
  let last = 0;
  for (;;) {
    open.lastIndex = last;
    const m = open.exec(tex);
    if (!m || !MATRIX.test(`\\begin{${m[2]}}`)) {
      if (m && !MATRIX.test(`\\begin{${m[2]}}`)) {
        // Some other environment: kept as text.
        last = m.index + m[0].length;
        continue;
      }
      break;
    }
    const env = m[2];
    let i = m.index + m[0].length;
    // array's column spec {ccc|c}.
    let align = '';
    const spec = /^\s*\{([^}]*)\}/.exec(tex.slice(i));
    if (env === 'array' && spec) {
      align = spec[1].replace(/[^lcr]/g, '');
      i += spec[0].length;
    }
    // The matching \end{env}, nested ones skipped.
    const re = new RegExp(String.raw`\\(begin|end)\s*\{\s*${env}\s*\}`, 'g');
    re.lastIndex = i;
    let depth = 1;
    let end = -1;
    let after = tex.length;
    for (let e = re.exec(tex); e; e = re.exec(tex)) {
      depth += e[1] === 'begin' ? 1 : -1;
      if (depth === 0) {
        end = e.index;
        after = e.index + e[0].length;
        break;
      }
    }
    if (end < 0) break;
    const body = tex.slice(i, end).replace(/\\hline/g, '');
    let [left, right] = ENV_DELIMS[env] ?? ['', ''];
    if (m[1] !== undefined) left = delimOf(m[1]);
    const close = new RegExp(String.raw`^\s*\\right\s*${DELIM_SRC}`).exec(tex.slice(after));
    if (close) {
      right = delimOf(close[1]);
      after += close[0].length;
    }
    const rows = splitTop(body, '\\\\')
      .map((r) => splitTop(r, '&').map((c) => c.trim()))
      .filter((r, k, all) => !(k === all.length - 1 && r.every((c) => !c)));
    const cols = Math.max(1, ...rows.map((r) => r.length));
    if (!align) align = (env === 'cases' ? 'l' : 'c').repeat(cols);
    if (m.index > last) parts.push({ kind: 'text', tex: tex.slice(last, m.index) });
    parts.push({ kind: 'table', rows, align, left, right });
    last = after;
  }
  if (last < tex.length) parts.push({ kind: 'text', tex: tex.slice(last) });
  return parts.filter((p) => p.kind === 'table' || p.tex.trim());
}

/** Text of a formula cut before its = signs (outside braces), so a long one can go on over lines. */
function pieces(tex: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '=' && depth === 0 && i > last && tex.slice(last, i).trim()) {
      out.push(tex.slice(last, i));
      last = i;
    }
  }
  out.push(tex.slice(last));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * How wide written runs are, px at `fs` px per em — a guess before they are
 * written (the hand's own widths are known only then), a little generous.
 */
function guessWidth(runs: MathRun[], fs: number): number {
  let w = 0;
  for (const r of runs) {
    for (const ch of r.text) {
      const k = /\s/.test(ch) ? 0.32 : /[0-9]/.test(ch) ? 0.56 : /[.,:;'′]/.test(ch) ? 0.3 : /[−+=·×±<>≤≥]/.test(ch) ? 0.66 : 0.62;
      w += k * (r.script ? 0.7 : 1);
    }
  }
  return w * fs;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The centre line of a delimiter of height h whose inner side is at x (drawn towards `side`: −1 left, +1 right). */
function delimLine(d: Delim, x: number, y0: number, h: number, e: number): Vec[][] {
  const y1 = y0 + h;
  const n = 24;
  const at = (f: (t: number) => Vec) => Array.from({ length: n + 1 }, (_, i) => f(i / n));
  // Opening ones open to the right; closing ones are their mirror.
  const mirror = d === ')' || d === ']' || d === '}';
  const sx = (dx: number) => (mirror ? x + dx : x - dx);
  switch (d) {
    case '|':
      return [[{ x: sx(e / 2), y: y0 }, { x: sx(e / 2), y: y1 }]];
    case '‖':
      return [
        [{ x: sx(e * 0.25), y: y0 }, { x: sx(e * 0.25), y: y1 }],
        [{ x: sx(e * 0.75), y: y0 }, { x: sx(e * 0.75), y: y1 }],
      ];
    case '(':
    case ')':
      return [at((t) => ({ x: sx(e * 0.25 + e * 0.6 * Math.sin(Math.PI * t)), y: y0 + h * t }))];
    case '[':
    case ']':
      return [[{ x: sx(e * 0.2), y: y0 }, { x: sx(e * 0.8), y: y0 }, { x: sx(e * 0.8), y: y1 }, { x: sx(e * 0.2), y: y1 }]];
    case '{':
    case '}':
      return [
        at((t) => {
          // Two long strokes meeting in a point at the middle, the ends curling in.
          const u = Math.abs(2 * t - 1);
          const dx = e * (0.35 + 0.1 * (1 - u) + 0.5 * Math.max(0, 1 - u / 0.1) - 0.3 * Math.max(0, (u - 0.9) / 0.1));
          return { x: sx(dx), y: y0 + h * t };
        }),
      ];
    default:
      return [];
  }
}

/**
 * A formula with tables laid out `width` px wide at `fs` px per em: from left
 * to right, a new band below when the next part does not fit — a long
 * formula goes on at its = signs.
 */
export function layoutFormula(tex: string, width: number, fs: number, pen: Pen): SketchLayout {
  const lineH = fs * 1.6;
  const rowH = fs * 1.45;
  const colGap = fs * 1.1;
  const gap = fs * 0.45;
  const delimW = fs * 0.5;
  const base = hash(tex);

  interface Box {
    w: number;
    h: number;
    part: { kind: 'text'; runs: MathRun[] } | (Table & { cells: MathRun[][][]; colW: number[] });
  }
  const boxes: Box[] = [];
  for (const p of parse(tex)) {
    if (p.kind === 'text') {
      for (const piece of pieces(p.tex)) {
        const runs = convertTex(piece);
        if (runs.length) boxes.push({ w: guessWidth(runs, fs), h: lineH, part: { kind: 'text', runs } });
      }
    } else {
      const cells = p.rows.map((r) => r.map((c) => convertTex(c)));
      const cols = Math.max(1, ...cells.map((r) => r.length));
      const colW = Array.from({ length: cols }, (_, j) => Math.max(fs * 0.6, ...cells.map((r) => (r[j] ? guessWidth(r[j], fs) : 0))));
      const inner = colW.reduce((a, b) => a + b, 0) + colGap * (cols - 1) + fs * 0.7;
      const w = inner + (p.left ? delimW : 0) + (p.right ? delimW : 0);
      boxes.push({ w, h: Math.max(1, p.rows.length) * rowH + fs * 0.4, part: { ...p, cells, colW } });
    }
  }
  if (!boxes.length) return { width, height: Math.round(lineH), paths: [], labels: [], obstacles: [], empty: true };

  // Bands of parts side by side.
  const bands: Box[][] = [[]];
  let x = 0;
  for (const b of boxes) {
    if (x > 0 && x + b.w > width) {
      bands.push([]);
      x = 0;
    }
    bands[bands.length - 1].push(b);
    x += b.w + gap;
  }

  const paths: InkPath[] = [];
  const labels: LabelRequest[] = [];
  let top = fs * 0.15;
  let n = 0;
  const label = (runs: MathRun[], sx: number, sy: number, ax: number) => {
    labels.push({ runs, size: fs, seed: (base + 7919 * n++) >>> 0, spots: [{ x: sx, y: sy, ax, ay: 0.5 }], fixed: true });
  };
  bands.forEach((band, bi) => {
    const h = Math.max(...band.map((b) => b.h));
    const mid = top + h / 2;
    // Continuation lines start a little in, under the formula.
    let x = bi > 0 ? fs * 1.2 : 0;
    band.forEach((b, k) => {
      const p = b.part;
      if (p.kind === 'text') {
        // Text before a table ends right at it; any other starts where it is.
        const next = band[k + 1]?.part.kind === 'table';
        label(p.runs, next ? x + b.w : x, mid, next ? 1 : 0);
      } else {
        const y0 = mid - b.h / 2;
        const r = rng(base + 31 * k + 977 * bi);
        let cx = x;
        for (const [d, at] of [
          [p.left, cx + (p.left ? delimW * 0.8 : 0)],
          [p.right, x + b.w - (p.right ? delimW * 0.8 : 0)],
        ] as [Delim, number][]) {
          for (const line of delimLine(d, at, y0, b.h, delimW * 0.6)) {
            paths.push({ d: outline(wobble(line, r, pen, { straight: d === '|' || d === '‖' }), r, pen) });
          }
        }
        cx += (p.left ? delimW : 0) + fs * 0.35;
        p.colW.forEach((cw, j) => {
          const a = p.align[j] ?? 'c';
          const ax = a === 'l' ? 0 : a === 'r' ? 1 : 0.5;
          p.cells.forEach((row, i) => {
            const runs = row[j];
            if (runs?.length) label(runs, cx + cw * ax, y0 + fs * 0.2 + rowH * (i + 0.5), ax);
          });
          cx += cw + colGap;
        });
      }
      x += b.w + gap;
    });
    top += h + fs * 0.3;
  });
  return { width, height: Math.round(top), paths, labels, obstacles: [], empty: false };
}
