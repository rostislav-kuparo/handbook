import { Extension, InputRule } from '@tiptap/core';
import { Fragment, Slice, type Mark as PMMark, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { convertMathInText, convertTex, countMathInText, hasTable, splitTables, TYPED_MATH, type MathRun } from './tex';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mathText: {
      /** Turn every $…$ formula already in the document into handwriting with indices. */
      convertMathInDocument: () => ReturnType;
    };
  }
}

/** Text nodes for converted runs; indices get the `script` mark on top of the original marks. */
function runNodes(schema: Schema, runs: MathRun[], marks: readonly PMMark[]): PMNode[] {
  const script = schema.marks.script;
  return runs.map((r) =>
    schema.text(r.text, r.script && script ? script.create({ kind: r.script }).addToSet(marks) : marks),
  );
}

/** A formula with a table (a determinant, a matrix): a «Формула» block, drawn by hand like a drawing. */
function formulaBlock(schema: Schema, tex: string): PMNode {
  return schema.nodes.htmlBlock.create({ kind: 'sketch', title: 'Формула', code: `$$${tex}$$` });
}

/**
 * A paragraph with formulas holding tables, cut into paragraphs (their other
 * formulas converted, indices already written kept) and «Формула» blocks;
 * null when it has none. A paragraph holds only text, so its text's offsets
 * are its positions.
 */
function splitParagraph(schema: Schema, para: PMNode): PMNode[] | null {
  const parts = splitTables(para.textContent);
  if (!parts) return null;
  return parts.map((p) => {
    if ('tex' in p) return formulaBlock(schema, p.tex);
    const piece = para.cut(p.from, p.to);
    return piece.copy(convertFragment(schema, piece.content));
  });
}

function convertFragment(schema: Schema, fragment: Fragment): Fragment {
  const out: PMNode[] = [];
  fragment.forEach((node) => {
    const split = node.type.name === 'paragraph' ? splitParagraph(schema, node) : null;
    if (split) {
      out.push(...split);
    } else if (node.isText) {
      const runs = convertMathInText(node.text ?? '');
      out.push(...(runs ? runNodes(schema, runs, node.marks) : [node]));
    } else {
      out.push(node.copy(convertFragment(schema, node.content)));
    }
  });
  return Fragment.fromArray(out);
}

/**
 * Rendered formulas in copied HTML (KaTeX, MathJax, MathML, Wikipedia) carry
 * their LaTeX source; put it back as $…$ text so it is converted like typed math.
 */
function mathSourceInHtml(html: string): string {
  if (!/katex|math|mjx|data-math/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const replace = (el: Element, tex: string | null | undefined) => {
    if (!tex) return;
    el.replaceWith(doc.createTextNode(`$${tex.replace(/\\displaystyle\s*/g, '').trim()}$`));
  };
  doc.querySelectorAll('[data-math]').forEach((el) => replace(el, el.getAttribute('data-math')));
  doc.querySelectorAll('annotation[encoding="application/x-tex"]').forEach((a) => {
    // The outermost wrapper: KaTeX keeps a second, visual copy of the formula next to the MathML.
    const host = ['.katex-display', '.katex', 'mjx-container', '.MathJax', 'math'].map((sel) => a.closest(sel)).find(Boolean);
    if (host) replace(host, a.textContent);
  });
  doc.querySelectorAll('math[alttext]').forEach((el) => replace(el.closest('.mwe-math-element') ?? el, el.getAttribute('alttext')));
  doc.querySelectorAll('img.mwe-math-fallback-image-inline[alt], img.mwe-math-fallback-image-display[alt]').forEach((el) =>
    replace(el, el.getAttribute('alt')),
  );
  doc.querySelectorAll('script[type^="math/tex"]').forEach((el) => replace(el, el.textContent));
  doc.querySelectorAll('.MathJax_Preview, .MathJax_SVG, .MathJax_CHTML').forEach((el) => el.remove());
  return doc.body.innerHTML;
}

/**
 * Formulas in the notebook: LaTeX pasted from ChatGPT, Gemini, Wikipedia…
 * ($f_1$, \(\Pi_1\)) becomes handwriting with real indices — f₁, Π₁ — and
 * Greek letters and math signs. Typing `$\Pi_1$` converts as soon as the
 * closing $ is typed (Backspace right after brings the source back).
 */
export const MathText = Extension.create({
  name: 'mathText',

  addInputRules() {
    return [
      new InputRule({
        find: TYPED_MATH,
        handler: ({ state, range, match }) => {
          const source = match[1] ?? match[2];
          const from = range.from + (match[0].length - source.length);
          const $from = state.doc.resolve(from);
          const tex = source.startsWith('$') ? source.slice(1, -1) : source.slice(3, -3);
          if (hasTable(tex)) {
            // A table does not fit on a line: its paragraph is cut around it into a «Формула» block.
            if ($from.depth !== 1) return null;
            // The typed character is already in the line.
            const { tr } = state;
            const at = $from.before();
            const para = tr.doc.nodeAt(at)!;
            const split = splitParagraph(state.schema, para);
            if (!split) return null;
            // Go on writing in a line after it.
            if (split[split.length - 1].type.name !== 'paragraph') split.push(state.schema.nodes.paragraph.create(para.attrs));
            tr.replaceWith(at, at + para.nodeSize, split);
            const end = at + split.reduce((n, node) => n + node.nodeSize, 0);
            tr.setSelection(TextSelection.create(tr.doc, end - 1));
            return;
          }
          const runs = convertTex(tex);
          if (runs.length === 0) return null;
          state.tr.replaceWith(from, range.to, runNodes(state.schema, runs, $from.marks()));
          // Go on writing on the line, not inside the index the formula may end with.
          state.tr.setStoredMarks($from.marks());
        },
      }),
    ];
  },

  addCommands() {
    return {
      convertMathInDocument:
        () =>
        ({ state, tr, dispatch }) => {
          const edits: { from: number; to: number; nodes: PMNode[] }[] = [];
          state.doc.descendants((node, pos, parent) => {
            // A paragraph with a determinant or a matrix: cut into paragraphs and «Формула» blocks.
            if (node.type.name === 'paragraph' && parent === state.doc) {
              const split = splitParagraph(state.schema, node);
              if (split) {
                edits.push({ from: pos, to: pos + node.nodeSize, nodes: split });
                return false;
              }
            }
            if (!node.isText) return;
            const runs = convertMathInText(node.text ?? '');
            if (runs) edits.push({ from: pos, to: pos + node.nodeSize, nodes: runNodes(state.schema, runs, node.marks) });
          });
          if (edits.length === 0) return false;
          if (dispatch) for (const e of edits.reverse()) tr.replaceWith(e.from, e.to, e.nodes);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('mathText'),
        props: {
          transformPastedHTML: mathSourceInHtml,
          transformPasted: (slice, view) => {
            const { schema } = view.state;
            // Bare text with a table in it (copied from within a line): a line of its own, cut around the table.
            if (slice.content.firstChild?.isInline) {
              const split = splitParagraph(schema, schema.nodes.paragraph.create(null, slice.content));
              if (split) return new Slice(Fragment.fromArray(split), 0, 0);
            }
            const content = convertFragment(schema, slice.content);
            // A line cut into «Формула» blocks cannot stay open to join the line pasted into: it goes in whole.
            const cut = content.childCount !== slice.content.childCount || content.content.some((n, i) => n.type !== slice.content.child(i).type);
            return cut ? new Slice(content, 0, 0) : new Slice(content, slice.openStart, slice.openEnd);
          },
        },
      }),
    ];
  },
});

/** How many formulas the document still has as raw LaTeX ($…$). */
export function countRawMath(doc: PMNode): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.isText) n += countMathInText(node.text ?? '');
  });
  return n;
}

// Editor plugins are set up once per editor: reload the page instead of hot-swapping.
import.meta.hot?.accept(() => location.reload());
