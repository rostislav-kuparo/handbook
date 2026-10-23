import { Extension, InputRule } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { findSketchFences, sketchOf } from '../sketch/detect';

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

/**
 * Drawings written inside the text: commands between ``` lines (or ёёё, the
 * same key in the Russian layout) become a «Чертёж» block in their place —
 * as soon as the closing fence is typed (Backspace right after brings the
 * text back), when such text is pasted, or by the menu for older text.
 */
export const SketchFences = Extension.create({
  name: 'sketchFences',
  // Before the formulas: $…$ inside the commands belongs to the drawing.
  priority: 110,

  addInputRules() {
    return [
      new InputRule({
        find: /^\s*(?:`{3,}|~{3,}|[ёЁ]{3,})$/,
        handler: ({ state, range, match }) => {
          const $to = state.doc.resolve(range.to);
          // Only a fence on its own line, typed at its end.
          if ($to.depth !== 1 || $to.parentOffset !== $to.parent.content.size) return null;
          const index = $to.index(0);
          const lines = linesOf(state.doc.content);
          lines[index] = match[0];
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
        key: new PluginKey('sketchFences'),
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
