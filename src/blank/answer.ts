// A neural net's answer for a blank («бланк» block): read into tasks, each
// becoming a drawing on the blank (its @-points put where the app knows them
// to be) and handwritten notes (their {…} numbers counted from the drawing),
// the notes kept off the printing.
import { MM, type SheetSize } from '../editor/page';
import { valuesIn } from '../sketch/evaluate';
import { blankBox, sketchErrors } from '../sketch/render';
import type { Blank, BlankMark } from './blank';
import { LINE_HEIGHT_EM } from '../editor/layout';
import { markMm, type Area } from './marks';
import { NOTE_SIZE, noteFontSize } from './note';
import { mmText, type SheetMm } from './pickCode';
import { lintDrawing } from './lint';
import type { Occupancy } from './occupancy';
import type { Dark } from './snap';
import { blankRect } from './blank';

export type NotePlace =
  | { at: 'mark'; mark: number; side: 'right' | 'left' | 'above' | 'below' }
  | { at: 'area'; area: number }
  | { at: 'mm'; x: number; y: number };

export interface AnswerTask {
  /** As the blank numbers it: «3», «4а». */
  id: string;
  /** Its origin: a point of the blank (@n) or a place of the sheet (mm); null: not given. */
  origin: { mark: number } | { mm: SheetMm } | null;
  /** Its drawing's commands as written (with @n). */
  lines: string[];
  notes: { place: NotePlace; text: string }[];
}

const TASK = /^\s*(?:задание|завдання|task|задача)\s*№?\s*([\p{L}\p{N}.,\- ]{1,12}?)\s*:?\s*$/iu;
const ORIGIN = /^\s*(?:начало|початок|origin)\s*:?\s*(?:@(\d+)|\(\s*(-?[\d.]+)\s*[,;]\s*(-?[\d.]+)\s*\))\s*$/iu;
const NOTE = /^\s*(?:надпись|напис|note)\s+(.+?)\s*:\s?(.*)$/iu;
const FENCE = /^\s*(`{3,}|~{3,}|[ёЁ]{3,})/;

/** Whether pasted text is an answer for a blank (has «задание N» and something in it). */
export function isAnswer(text: string): boolean {
  const lines = text.split(/\r?\n/);
  return lines.some((l) => TASK.test(l)) && lines.some((l) => ORIGIN.test(l) || NOTE.test(l) || /@\d+/.test(l));
}

function placeOf(where: string): NotePlace | null {
  const w = where.trim().toLowerCase();
  const mark = /@(\d+)/.exec(w);
  if (mark) {
    const side = /слева|зліва|left/.test(w) ? 'left' : /сверху|над|зверху|above/.test(w) ? 'above' : /снизу|под|знизу|below/.test(w) ? 'below' : 'right';
    return { at: 'mark', mark: Number(mark[1]), side };
  }
  const area = /\br\s*(\d+)/i.exec(w);
  if (area) return { at: 'area', area: Number(area[1]) };
  const mm = /\(\s*(-?[\d.]+)\s*[,;]\s*(-?[\d.]+)\s*\)/.exec(w);
  if (mm) return { at: 'mm', x: Number(mm[1]), y: Number(mm[2]) };
  return null;
}

/** The answer's tasks, and what could not be read. */
export function parseAnswer(text: string): { tasks: AnswerTask[]; problems: { task: string; text: string }[] } {
  const tasks: AnswerTask[] = [];
  const problems: { task: string; text: string }[] = [];
  let cur: AnswerTask | null = null;
  let note: { place: NotePlace; text: string } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (FENCE.test(raw)) continue;
    const task = TASK.exec(raw);
    if (task) {
      cur = { id: task[1].trim().replace(/\s+/g, ''), origin: null, lines: [], notes: [] };
      tasks.push(cur);
      note = null;
      continue;
    }
    if (!cur) continue;
    // A note goes on in lines set in by two spaces.
    if (note && /^ {2,}\S/.test(raw) && !NOTE.test(raw)) {
      note.text += `\n${raw.trim()}`;
      continue;
    }
    note = null;
    const origin = ORIGIN.exec(raw);
    if (origin) {
      cur.origin = origin[1] ? { mark: Number(origin[1]) } : { mm: { x: Number(origin[2]), y: Number(origin[3]) } };
      continue;
    }
    const n = NOTE.exec(raw);
    if (n) {
      const place = placeOf(n[1]);
      if (!place) problems.push({ task: cur.id, text: `непонятно, где надпись «${n[2].trim()}»: «${n[1]}»` });
      else {
        note = { place, text: n[2].trim() };
        cur.notes.push(note);
      }
      continue;
    }
    if (raw.trim()) cur.lines.push(raw.replace(/\s+$/, ''));
  }
  if (!tasks.length) problems.push({ task: '?', text: 'нет ни одной строки «задание N»' });
  return { tasks, problems };
}

/** A pasted task as it stays with its blocks: to lay it out again or ask about it. */
export interface AiInfo {
  task: string;
  /** The task's text as the net wrote it (to report problems against). */
  raw: string;
  /** The names the net gave to printed points: name → @n. */
  names: Record<string, number>;
}

/** A block to put into the document. */
export interface AnswerBlock {
  kind: 'sketch' | 'note';
  title: string;
  code: string;
  /** Sheet px. */
  x: number;
  y: number;
  w: number;
  size?: number;
  ai: AiInfo;
}

const PRINTED_POINT = /^\s*([\p{L}][\p{L}\p{N}_'′]*)\s*=\s*(?:@(\d+)|(?:FromProjections|ПоПроекциям)\s*\(\s*@(\d+)\s*,\s*@(\d+)\s*\))\s*(?:#.*)?$/u;

/** A task's drawing: its origin on the blank, its @-points as numbers from there, the printed ones hidden. */
function drawingOf(t: AnswerTask, markAt: (n: number) => SheetMm | null, problems: string[], areas: Area[]): { code: string; names: Record<string, number> } | null {
  const used = t.lines.flatMap((l) => [...l.matchAll(/@(\d+)/g)].map((m) => Number(m[1])));
  if (!t.lines.length) return null;
  let o: SheetMm | null = null;
  if (t.origin && 'mark' in t.origin) {
    o = markAt(t.origin.mark);
    if (!o) problems.push(`начало @${t.origin.mark}: такой метки нет`);
  } else if (t.origin) o = t.origin.mm;
  o ??= used.map(markAt).find((p): p is SheetMm => !!p) ?? (areas[0] ? { x: areas[0].x + areas[0].w / 2, y: areas[0].y + areas[0].h / 2 } : { x: 100, y: 100 });
  const names: Record<string, number> = {};
  const out = [`НаБланке(${mmText(o.x)}, ${mmText(o.y)})`];
  for (const line of t.lines) {
    let bad = false;
    const code = line.replace(/@(\d+)/g, (_, n: string) => {
      const p = markAt(Number(n));
      if (!p) {
        bad = true;
        return `@${n}`;
      }
      return `(${mmText(p.x - o!.x)}, ${mmText(o!.y - p.y)})`;
    });
    if (bad) {
      problems.push(`строка «${line.trim()}»: метки ${[...line.matchAll(/@(\d+)/g)].map((m) => m[0]).join(', ')} нет на бланке`);
      out.push(`# ${line.trim()}`);
      continue;
    }
    out.push(code);
    const printed = PRINTED_POINT.exec(line);
    if (printed) {
      out.push(`Скрыть(${printed[1]})`);
      names[printed[1]] = Number(printed[2] ?? printed[3]);
    }
  }
  return { code: out.join('\n'), names };
}

/** {expr} and {expr:digits} in a note: counted from the task's drawing. */
function fillNumbers(text: string, code: string | null, problems: string[]): string {
  const found = [...text.matchAll(/\{([^{}]+?)(?::\s*(\d))?\}/g)];
  if (!found.length) return text;
  const values = code ? valuesIn(code, found.map((m) => m[1])) : found.map(() => null);
  let i = 0;
  return text.replace(/\{([^{}]+?)(?::\s*(\d))?\}/g, (whole, _expr: string, digits?: string) => {
    const v = values[i++];
    if (v === null || v === undefined) {
      problems.push(`в надписи не посчиталось ${whole}`);
      return '?';
    }
    if (typeof v === 'string') return v;
    return v.toFixed(digits ? Number(digits) : 1).replace(/\.0+$/, '').replace('.', ',');
  });
}

/** How much ink of the printing lies under a box of the sheet (px), as a share. */
function inkUnder(d: Dark, b: Blank, sheet: SheetSize, box: { x: number; y: number; w: number; h: number }): number {
  const r = blankRect(b, sheet);
  const k = d.w / r.w;
  const x0 = Math.max(0, Math.floor((box.x - r.x) * k));
  const y0 = Math.max(0, Math.floor((box.y - r.y) * k));
  const x1 = Math.min(d.w, Math.ceil((box.x + box.w - r.x) * k));
  const y1 = Math.min(d.h, Math.ceil((box.y + box.h - r.y) * k));
  let n = 0;
  let all = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2, all++) n += d.on[y * d.w + x];
  return all ? n / all : 0;
}

const overlap = (p: { x: number; y: number; w: number; h: number }, q: { x: number; y: number; w: number; h: number }) =>
  Math.max(0, Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x)) * Math.max(0, Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y));

/**
 * The answer as blocks on the blank's sheet (sheet px), and what went wrong
 * per task. Notes go where the answer says, moved a little if they would lie
 * on the printing or on another note.
 */
export function answerBlocks(
  text: string,
  b: Blank,
  marks: BlankMark[],
  areas: Area[],
  sheet: SheetSize,
  dark: Dark,
  letters = NOTE_SIZE,
  /** The sheet's map with these drawings on it (the notes keep off their lines too). */
  mapWith?: (drawings: string[]) => Occupancy,
): { blocks: AnswerBlock[]; tasks: string[]; problems: { task: string; text: string }[] } {
  const { tasks, problems: parsed } = parseAnswer(text);
  const problems = [...parsed];
  const blocks: AnswerBlock[] = [];
  const markAt = (n: number) => (marks[n - 1] ? markMm(b, marks[n - 1], sheet) : null);
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  // The drawings first, all of them: the notes keep off their lines.
  const drawn = tasks.map((t) => {
    const said: string[] = [];
    return { said, drawing: drawingOf(t, markAt, said, areas) };
  });
  const map = mapWith?.(drawn.flatMap((x) => (x.drawing ? [x.drawing.code] : [])));
  for (const [ti, t] of tasks.entries()) {
    const { said, drawing } = drawn[ti];
    const ai: AiInfo = { task: t.id, raw: text, names: drawing?.names ?? {} };
    if (drawing) {
      for (const l of lintDrawing(drawing.code)) said.push(l);
      const errors = sketchErrors(drawing.code);
      for (const e of errors.slice(0, 5)) said.push(`строка чертежа «${drawing.code.split('\n')[e.line - 1]?.trim()}»: ${e.message}`);
      blocks.push({ kind: 'sketch', title: `Задание ${t.id}`, code: drawing.code, x: 0, y: 0, w: 360, ai });
      const box = blankBox(drawing.code);
      if (box) {
        const share = inkUnder(dark, b, sheet, { x: box.x + 8 * MM, y: box.y + 8 * MM, w: Math.max(1, box.w - 16 * MM), h: Math.max(1, box.h - 16 * MM) });
        if (share > 0.04 && t.origin && 'mm' in t.origin) said.push('чертёж на свободном месте заходит на печать — уменьши его или возьми другую рамку R');
      }
    }
    for (const n of t.notes) {
      const body = fillNumbers(n.text, drawing?.code ?? null, said);
      const fs = noteFontSize(letters);
      const lh = fs * LINE_HEIGHT_EM;
      const longest = Math.max(...body.split('\n').map((l) => [...l.replace(/\$/g, '')].length), 1);
      let w = Math.min(Math.max(longest * fs * 0.5 + fs, 18 * MM), 110 * MM);
      const h = body.split('\n').length * lh * (longest * fs * 0.5 > w ? 2 : 1);
      let at: SheetMm | null = null;
      const p = n.place;
      if (p.at === 'mark') {
        const m = markAt(p.mark);
        if (!m) said.push(`надпись у @${p.mark}: такой метки нет`);
        else {
          const [mx, my] = [m.x * MM, m.y * MM];
          const gap = 2 * MM;
          const pos =
            p.side === 'left'
              ? { x: mx - gap - w, y: my - lh * 0.6 }
              : p.side === 'above'
                ? { x: mx - w / 2, y: my - gap - h }
                : p.side === 'below'
                  ? { x: mx - w / 2, y: my + gap }
                  : { x: mx + gap, y: my - lh * 0.6 };
          at = { x: pos.x / MM, y: pos.y / MM };
        }
      } else if (p.at === 'area') {
        const a = areas[p.area - 1];
        if (!a) said.push(`надпись в R${p.area}: такой рамки нет`);
        else {
          at = { x: a.x + 2, y: a.y + 2 };
          w = Math.min(w, (a.w - 4) * MM);
        }
      } else at = { x: p.x, y: p.y };
      if (!at) continue;
      // Off the printing and the other notes: the nearest place within 16 mm where least lies under it.
      const base = { x: at.x * MM, y: at.y * MM, w, h };
      const under = (q: typeof base) => (map ? (map.count(q) * (0.5 * MM) ** 2) / (q.w * q.h) : inkUnder(dark, b, sheet, q));
      const cost = (q: typeof base) => under(q) * 100 + placed.reduce((c, o) => c + overlap(q, o), 0) / (w * h) * 100;
      let best = base;
      if (cost(base) > 0.5) {
        let bestCost = cost(base);
        for (let ring = 1; ring <= 8; ring++) {
          for (let i = -ring; i <= ring; i++) {
            for (const [dx, dy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]]) {
              const q = { ...base, x: base.x + dx * 2 * MM, y: base.y + dy * 2 * MM };
              if (q.x < 0 || q.y < 0 || q.x + w > sheet.w || q.y + h > sheet.h) continue;
              const c = cost(q) + ring * 0.3;
              if (c < bestCost) [best, bestCost] = [q, c];
            }
          }
          if (bestCost < 0.5 + ring * 0.3) break;
        }
      }
      placed.push(best);
      blocks.push({ kind: 'note', title: 'Надпись', code: body, x: best.x, y: best.y, w: best.w, size: letters, ai });
    }
    if (!drawing && !t.notes.length) said.push('пустое задание');
    for (const s of said) problems.push({ task: t.id, text: s });
  }
  return { blocks, tasks: tasks.map((t) => t.id), problems };
}
