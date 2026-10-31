// Ctrl+V of a neural net's answer in a document on a blank: the answer's
// tasks become drawings and notes on the blank, replacing what an earlier
// answer put there for the same tasks — in one step, so Ctrl+Z takes it back.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Geometry } from '../editor/page';
import { db } from '../storage/db';
import { blankSheet, type Blank } from './blank';
import { answerBlocks, isAnswer, parseAnswer, type AiInfo } from './answer';
import { buildOccupancy, type MapBlock } from './occupancy';
import { freeAreas, markMm, marksOf } from './marks';
import { NOTE_SIZE } from './note';
import { darkOf } from './snap';

/** What was laid out: the tasks, what went wrong, and which printed points the net named how. */
export interface AnswerReport {
  tasks: string[];
  blocks: number;
  problems: { task: string; text: string }[];
  /** Per task: name → the point's number and place (mm). */
  names: { task: string; name: string; mark: number; x: number; y: number }[];
}

export interface AnswerHooks {
  /** The open document's blank and page, or null: not on a blank. */
  context: () => { blank: Blank; geo: Geometry } | null;
  onBusy: (busy: boolean) => void;
  onReport: (report: AnswerReport) => void;
}

/** The text of a paste: plain text, or the code blocks of copied HTML. */
function pastedText(e: ClipboardEvent): string {
  const plain = e.clipboardData?.getData('text/plain') ?? '';
  if (isAnswer(plain)) return plain;
  const html = e.clipboardData?.getData('text/html') ?? '';
  if (!html) return plain;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const code = [...doc.querySelectorAll('pre')].map((p) => p.textContent ?? '').join('\n');
  return isAnswer(code) ? code : plain;
}

async function apply(view: EditorView, text: string, hooks: AnswerHooks) {
  const ctx = hooks.context();
  if (!ctx) return;
  const { blank, geo } = ctx;
  hooks.onBusy(true);
  try {
    const marks = await marksOf(blank, (m) => void db.blanks.update(blank.id, { marks: m }));
    const areas = await freeAreas(blank);
    const dark = await darkOf(blank);
    const sheet = blankSheet(blank);
    const letters = blank.letters ?? NOTE_SIZE;
    // The sheet as it will be: what stays of the document, and the answer's drawings.
    const staying = (tasks: string[]) => {
      const out: MapBlock[] = [];
      view.state.doc.forEach((node) => {
        const ai = (node.attrs?.data as { ai?: AiInfo } | null)?.ai;
        if (node.type.name !== 'htmlBlock' || !node.attrs.float || (ai && tasks.includes(ai.task))) return;
        const a = node.attrs;
        out.push({ kind: a.kind, code: a.code, pen: a.pen, x: a.x + geo.margin.left, y: a.y + geo.margin.top, w: a.w, size: a.size });
      });
      return out;
    };
    const { tasks: answered } = parseAnswer(text);
    const { blocks, tasks, problems } = answerBlocks(text, blank, marks, areas, sheet, dark, letters, (drawings) =>
      buildOccupancy(dark, blank, sheet, [...staying(answered.map((t) => t.id)), ...drawings.map((code) => ({ kind: 'sketch', code, x: 0, y: 0, w: 0 }))], letters),
    );
    if (view.isDestroyed) return;
    const { state } = view;
    const tr = state.tr;
    // What an earlier answer put there for these tasks goes (bottom up, so the places above stay).
    const old: { pos: number; size: number }[] = [];
    state.doc.forEach((node, pos) => {
      const ai = (node.attrs?.data as { ai?: AiInfo } | null)?.ai;
      if (node.type.name === 'htmlBlock' && ai && tasks.includes(ai.task)) old.push({ pos, size: node.nodeSize });
    });
    for (const o of old.reverse()) tr.delete(o.pos, o.pos + o.size);
    const nodes = blocks.map((b) =>
      state.schema.nodes.htmlBlock.create({
        kind: b.kind,
        title: b.title,
        code: b.code,
        float: true,
        x: Math.round(b.x - geo.margin.left),
        y: Math.round(b.y - geo.margin.top),
        w: Math.round(b.w),
        size: b.size ?? 4,
        data: { ai: b.ai },
      }),
    );
    tr.insert(tr.doc.content.size, nodes);
    view.dispatch(tr);
    const names: AnswerReport['names'] = [];
    for (const b of blocks) {
      if (b.kind !== 'sketch') continue;
      for (const [name, n] of Object.entries(b.ai.names)) {
        const m = marks[n - 1];
        if (m) names.push({ task: b.ai.task, name, mark: n, ...markMm(blank, m, sheet) });
      }
    }
    hooks.onReport({ tasks, blocks: blocks.length, problems, names });
  } catch (err) {
    hooks.onReport({ tasks: [], blocks: 0, problems: [{ task: '?', text: `не удалось разложить ответ: ${String(err)}` }], names: [] });
  } finally {
    hooks.onBusy(false);
  }
}

const key = new PluginKey('blankAnswers');

export const BlankAnswers = Extension.create<{ hooks: AnswerHooks | null }>({
  name: 'blankAnswers',
  // Before the drawings' fences: an answer is not one drawing.
  priority: 120,

  addOptions() {
    return { hooks: null };
  },

  addProseMirrorPlugins() {
    const hooks = this.options.hooks;
    return [
      new Plugin({
        key,
        props: {
          handlePaste: (view, event) => {
            if (!hooks?.context()) return false;
            const text = pastedText(event);
            if (!isAnswer(text)) return false;
            event.preventDefault();
            void apply(view, text, hooks);
            return true;
          },
        },
      }),
    ];
  },
});
