import { Extension, InputRule } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { findSketchFences, sketchOf, type SketchFence } from '../sketch/detect';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    sketchFences: {
      /** Turn every ```…``` drawing already in the document into a «Чертёж» block. */
      convertSketchFences: () => ReturnType;
    };
  }
}

/** Text of each top-level node; blocks are lines that are neither fences nor commands. */
function linesOf(fragment: Fragment): string[] {
  const lines: string[] = [];
  fragment.forEach((node) => lines.push(node.isTextblock ? node.textContent : '\u0000'));
  return lines;
}

function sketchNode(schema: Schema, code: string, title: string): PMNode {
  return schema.nodes.htmlBlock.create({ kind: 'sketch', title, code });
}

/** The fragment with every fenced drawing replaced by a «Чертёж» block. */
function convertFragment(schema: Schema, fragment: Fragment): { fragment: Fragment; count: number } {
  const found = findSketchFences(linesOf(fragment));
  if (!found.length) return { fragment, count: 0 };
  const out: PMNode[] = [];
  let next = 0;
  for (const f of found) {
    for (let i = next; i < f.open; i++) out.push(fragment.child(i));
    out.push(sketchNode(schema, f.code, f.title));
    next = f.close + 1;
  }
  for (let i = next; i < fragment.childCount; i++) out.push(fragment.child(i));
  return { fragment: Fragment.fromArray(out), count: found.length };
}

/** How many fenced drawings the document still has as text. */
export function countSketchFences(doc: PMNode): number {
  return findSketchFences(linesOf(doc.content)).length;
}

/**
 * Code blocks in copied HTML (a chat answer selected with the mouse loses its
 * ``` lines): a <pre> with drawing commands becomes a «Чертёж» block.
 */
function sketchesInHtml(html: string): string {
  if (!/<pre[\s>]/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let changed = false;
  doc.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code') ?? pre;
    const label = /language-([\p{L}\p{N}_+#.-]+)/u.exec(code.className)?.[1] ?? '';
    const found = sketchOf(label, (code.textContent ?? '').split(/\r?\n/));
    if (!found) return;
    const block = doc.createElement('div');
    block.setAttribute('data-html-block', '');
    block.setAttribute('data-kind', 'sketch');
    block.setAttribute('data-title', found.title);
    block.setAttribute('data-code', found.code);
    pre.replaceWith(block);
    changed = true;
  });
  return changed ? doc.body.innerHTML : html;
}

const fencesKey = new PluginKey('sketchFences');

/** Some fence character run: worth looking for drawings at all. */
const FENCE_CHARS = /`{3}|~{3}|[ёЁ]{3}/;

/** Replaces fenced drawings by blocks; the cursor, if it was inside one, goes on below it. */
function replaceFences(state: EditorState, found: SketchFence[]): Transaction {
  const tr = state.tr;
  const offsets: number[] = [];
  state.doc.forEach((_, offset) => offsets.push(offset));
  const head = state.selection.head;
  let cursor: { pos: number; steps: number } | null = null;
  // Bottom to top, so the positions above stay valid.
  for (const f of [...found].reverse()) {
    const from = offsets[f.open];
    const to = offsets[f.close] + state.doc.child(f.close).nodeSize;
    const block = sketchNode(state.schema, f.code, f.title);
    const last = f.close === state.doc.childCount - 1;
    tr.replaceWith(from, to, last ? [block, state.schema.nodes.paragraph.create()] : [block]);
    if (head >= from && head <= to) cursor = { pos: from + block.nodeSize, steps: tr.steps.length };
  }
  if (cursor) tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.slice(cursor.steps).map(cursor.pos))));
  return tr.setMeta(fencesKey, true);
}

/**
 * Drawings written inside the text: commands between ``` lines (or ёёё, the
 * same key in the Russian layout) become a «Чертёж» block in their place —
 * as soon as the closing fence is typed (Backspace right after brings the
 * text back), when a fence line appears any other way (Enter before ```,
 * a paste, a deleted line), when such text is pasted, or by the menu for
 * older text. A fence may also end the last line of commands or start the
 * first one: «Polygon(A, B, C) ```».
 */
export const SketchFences = Extension.create({
  name: 'sketchFences',
  // Before the formulas: $…$ inside the commands belongs to the drawing.
  priority: 110,

  addInputRules() {
    return [
      new InputRule({
        find: /(?:`{3,}|~{3,}|[ёЁ]{3,})$/,
        handler: ({ state, range, match }) => {
          const $to = state.doc.resolve(range.to);
          // A fence typed at the end of a line: on its own, or right after the last command.
          if ($to.depth !== 1 || $to.parentOffset !== $to.parent.content.size) return null;
          const index = $to.index(0);
          const lines = linesOf(state.doc.content);
          // The line as it is about to be: what is there plus what was just typed.
          lines[index] = $to.parent.textContent + match[0].slice(range.to - range.from);
          const f = findSketchFences(lines).find((x) => x.close === index);
          if (!f) return null;
          let from = 0;
          for (let i = 0; i < f.open; i++) from += state.doc.child(i).nodeSize;
          const to = $to.after(1);
          const block = sketchNode(state.schema, f.code, f.title);
          const last = index === state.doc.childCount - 1;
          const tr = state.tr;
          tr.replaceWith(from, to, last ? [block, state.schema.nodes.paragraph.create()] : [block]);
          // Writing goes on below the drawing.
          tr.setSelection(TextSelection.near(tr.doc.resolve(from + block.nodeSize)));
        },
      }),
    ];
  },

  addCommands() {
    return {
      convertSketchFences:
        () =>
        ({ state, tr, dispatch }) => {
          const { fragment, count } = convertFragment(state.schema, state.doc.content);
          if (!count) return false;
          if (dispatch) tr.replaceWith(0, state.doc.content.size, fragment);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: fencesKey,
        // A fence line that appeared without typing it (Enter before ```, a paste, a deleted line).
        appendTransaction: (trs, oldState, newState) => {
          if (!trs.some((t) => t.docChanged)) return null;
          // Undo and redo stay as they are, so Ctrl+Z after a conversion really brings the text back.
          if (trs.some((t) => t.getMeta('history$') || t.getMeta(fencesKey))) return null;
          const start = oldState.doc.content.findDiffStart(newState.doc.content);
          if (start === null) return null;
          const end = oldState.doc.content.findDiffEnd(newState.doc.content);
          const to = end ? Math.max(end.b, start) : newState.doc.content.size;
          const touched = new Set<number>();
          let fenceNearby = false;
          newState.doc.forEach((node, offset, index) => {
            if (offset > to || offset + node.nodeSize < start) return;
            touched.add(index);
            if (node.isTextblock && FENCE_CHARS.test(node.textContent)) fenceNearby = true;
          });
          if (!fenceNearby) return null;
          const found = findSketchFences(linesOf(newState.doc.content)).filter((f) => touched.has(f.open) || touched.has(f.close));
          return found.length ? replaceFences(newState, found) : null;
        },
        props: {
          transformPastedHTML: sketchesInHtml,
          transformPasted: (slice, view) => {
            const { fragment, count } = convertFragment(view.state.schema, slice.content);
            if (!count) return slice;
            // A block at an open end cannot merge into the paragraph around the cursor.
            const openStart = fragment.firstChild?.isTextblock ? slice.openStart : 0;
            const openEnd = fragment.lastChild?.isTextblock ? slice.openEnd : 0;
            return new Slice(fragment, openStart, openEnd);
          },
        },
      }),
    ];
  },
});

// Editor plugins are set up once per editor: reload the page instead of hot-swapping.
import.meta.hot?.accept(() => location.reload());
