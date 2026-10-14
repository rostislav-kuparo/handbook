import { Extension, InputRule } from '@tiptap/core';
import { Fragment, Slice, type Mark as PMMark, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { convertMathInText, convertTex, countMathInText, TYPED_MATH, type MathRun } from './tex';

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

function convertFragment(schema: Schema, fragment: Fragment): Fragment {
  const out: PMNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
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
          const source = match[1];
          const from = range.from + (match[0].length - source.length);
          const $from = state.doc.resolve(from);
          const runs = convertTex(source.slice(1, -1));
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
          state.doc.descendants((node, pos) => {
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
          transformPasted: (slice, view) =>
            new Slice(convertFragment(view.state.schema, slice.content), slice.openStart, slice.openEnd),
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
