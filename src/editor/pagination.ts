import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { NodeLayout } from './docLayout';
import { LINE_HEIGHT_EM } from './layout';
import { lineSegments } from './lines';
import type { Geometry } from './page';
import { zoomOf } from './zoom';

// Editor plugins are set up once per editor: reload the page instead of hot-swapping.
import.meta.hot?.accept(() => location.reload());

/**
 * Word-like pages for one continuous ProseMirror editor.
 *
 * Text flows in a single column laid over a stack of sheets (A4, or a blank's paper). After every
 * change the lines are measured; when a line (or an HTML block) would cross the
 * bottom margin of a sheet, an invisible spacer widget is inserted before it,
 * pushing it to the top of the next sheet. Spacers are decorations — they are
 * never part of the document.
 *
 * To stay stable, positions are first converted to "natural" ones (as if no
 * spacer existed) by subtracting the spacers currently in place; page breaks
 * are then computed from scratch. Spacers only add height, never width, so
 * line breaking — and therefore the natural layout — never depends on them.
 */

interface Spacer {
  pos: number;
  height: number;
  /** Between top-level nodes (before a paragraph or block) or inside a paragraph (before a wrapped line). */
  block: boolean;
}

interface PageState {
  spacers: Spacer[];
  decorations: DecorationSet;
}

export const paginationKey = new PluginKey<PageState>('pagination');
export const REMEASURE_EVENT = 'hand-remeasure';

/** Ask the layout plugins (pagination, sag) to measure again: font rebuilt, size changed… */
export function remeasure(view: EditorView) {
  view.dom.dispatchEvent(new Event(REMEASURE_EVENT));
}

function spacerDecorations(doc: Parameters<typeof DecorationSet.create>[0], spacers: Spacer[]): DecorationSet {
  return DecorationSet.create(
    doc,
    spacers.map((s) =>
      Decoration.widget(
        s.pos,
        () => {
          const el = document.createElement(s.block ? 'div' : 'span');
          el.className = 'page-spacer';
          el.style.height = `${s.height}px`;
          el.contentEditable = 'false';
          return el;
        },
        { side: -1, key: `page-${s.pos}-${s.block ? 'b' : 'i'}-${Math.round(s.height)}`, ignoreSelection: true },
      ),
    ),
  );
}

interface Unit {
  pos: number;
  top: number;
  height: number;
  block: boolean;
  /** The top-level node it belongs to, and where its line starts in that paragraph's text (code points). */
  node: number;
  start: number;
}

/**
 * Lines and blocks, measured: the spacers that push them past page breaks,
 * how many sheets there are, and where every line and block ends up (see
 * `NodeLayout`) for the rendered view.
 */
function measure(view: EditorView, geo: Geometry): { spacers: Spacer[]; pages: number; layout: (NodeLayout | null)[] } | null {
  const stack = view.dom.closest('.paper-stack');
  if (!stack) return null;
  // Screen positions are zoomed with the sheets: everything below is in sheet pixels.
  const z = zoomOf(stack);
  const top0 = stack.getBoundingClientRect().top / z;
  const fontPx = parseFloat(getComputedStyle(view.dom).fontSize) || 16;
  const lh = fontPx * LINE_HEIGHT_EM;
  const current = paginationKey.getState(view.state)?.spacers ?? [];
  // Height of the spacers that currently push a position down.
  const blockBefore = (pos: number) => current.filter((s) => s.pos <= pos && (s.block || s.pos < pos)).reduce((a, s) => a + s.height, 0);

  const units: Unit[] = [];
  // Floating blocks take no room in the text, but the paper must reach them.
  let floatBottom = 0;
  const layout: (NodeLayout | null)[] = [];
  view.state.doc.forEach((node, offset, index) => {
    layout[index] = null;
    const dom = view.nodeDOM(offset) as HTMLElement | null;
    if (!dom || !(dom instanceof HTMLElement)) return;
    if (node.type.name === 'htmlBlock') {
      if (node.attrs.float) {
        // The node view's outer element stays in the flow with no height; measure the block itself.
        const el = dom.querySelector('.html-block') ?? dom;
        floatBottom = Math.max(floatBottom, el.getBoundingClientRect().bottom / z - top0);
        return;
      }
      const r = dom.getBoundingClientRect();
      units.push({ pos: offset, top: r.top / z - top0 - blockBefore(offset), height: r.height / z, block: true, node: index, start: 0 });
      return;
    }
    const rect = dom.getBoundingClientRect();
    const r = { top: rect.top / z };
    const paraTop = r.top - top0 - blockBefore(offset);
    units.push({ pos: offset, top: paraTop, height: lh, block: true, node: index, start: 0 });
    // Further lines of the paragraph: find where wrapped lines start.
    const start = offset + 1;
    const text = node.textBetween(0, node.content.size, undefined, '￼');
    let lastLine = 0;
    // Every piece of text that starts a visual line — including the middle of a
    // word too long for one line — is a place where a page may have to break.
    for (const seg of lineSegments(view, start, text, lh)) {
      const q = seg.from;
      const inner = current.filter((s) => !s.block && s.pos > offset && s.pos <= q).reduce((a, s) => a + s.height, 0);
      // The glyph box sits 0.225em below its line top; small sag offsets are absorbed by rounding.
      const k = Math.round((seg.top - r.top - inner - 0.225 * fontPx) / lh);
      if (k > lastLine) {
        // The line's start in the text as the ink renderer counts it: text only, by code points.
        const before = node.textBetween(0, q - start, undefined, () => '');
        units.push({ pos: q, top: paraTop + k * lh, height: lh, block: false, node: index, start: [...before].length });
        lastLine = k;
      }
    }
  });

  const spacers: Spacer[] = [];
  let shift = 0;
  let bottom = 0;
  for (const u of units) {
    let y = u.top + shift;
    const p = Math.max(0, Math.floor(y / geo.pitch));
    const cTop = geo.contentTop(p);
    const cBottom = geo.contentBottom(p);
    if (p > 0 && y < cTop - 0.5) {
      // Landed in the gap or the top margin of a sheet.
      spacers.push({ pos: u.pos, height: cTop - y, block: u.block });
      shift += cTop - y;
      y = cTop;
    } else if (y + u.height > cBottom + 0.5 && u.height <= cBottom - cTop) {
      const next = geo.contentTop(p + 1);
      spacers.push({ pos: u.pos, height: next - y, block: u.block });
      shift += next - y;
      y = next;
    }
    bottom = Math.max(bottom, y + u.height);
    // Where it ends up: its sheet and its top in the writable area, on the line grid.
    const page = Math.max(0, Math.floor((y + 0.5) / geo.pitch));
    const at: [number, number] = [page, Math.round((y - geo.contentTop(page)) / lh) * lh];
    const n = (layout[u.node] ??= { starts: [], at: [] });
    n.starts.push(u.start);
    n.at.push(at);
  }
  const last = Math.max(bottom, floatBottom);
  return { spacers, pages: Math.max(1, Math.floor(last / geo.pitch) + 1), layout };
}

function same(a: Spacer[], b: Spacer[]): boolean {
  return a.length === b.length && a.every((s, i) => s.pos === b[i].pos && s.block === b[i].block && Math.abs(s.height - b[i].height) < 1);
}

export const Pagination = Extension.create<{
  onPages: (pages: number) => void;
  getGeometry: () => Geometry | null;
  /** Where the lines and blocks are once the pages settle, with the document they belong to. */
  onLayout: (layout: (NodeLayout | null)[], doc: EditorView['state']['doc']) => void;
}>({
  name: 'pagination',

  addOptions() {
    return { onPages: () => {}, getGeometry: () => null, onLayout: () => {} };
  },

  addProseMirrorPlugins() {
    const { onPages, getGeometry, onLayout } = this.options;
    return [
      new Plugin<PageState>({
        key: paginationKey,
        state: {
          init: () => ({ spacers: [], decorations: DecorationSet.empty }),
          apply: (tr, old) => {
            const next = tr.getMeta(paginationKey) as Spacer[] | undefined;
            if (next) return { spacers: next, decorations: spacerDecorations(tr.doc, next) };
            if (!tr.docChanged) return old;
            return {
              spacers: old.spacers.map((s) => ({ ...s, pos: tr.mapping.map(s.pos, -1) })),
              decorations: old.decorations.map(tr.mapping, tr.doc),
            };
          },
        },
        props: { decorations: (state) => paginationKey.getState(state)?.decorations },
        view(view) {
          let frame = 0;
          let pages = 0;
          let told = '';
          const schedule = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
              if (view.isDestroyed) return;
              const geo = getGeometry();
              const result = geo && measure(view, geo);
              if (!result) return;
              if (result.pages !== pages) {
                pages = result.pages;
                onPages(pages);
              }
              const current = paginationKey.getState(view.state)?.spacers ?? [];
              if (!same(current, result.spacers)) {
                view.dispatch(view.state.tr.setMeta(paginationKey, result.spacers).setMeta('addToHistory', false));
              }
              // The places are measured with the new spacers already counted in.
              const layout = JSON.stringify(result.layout);
              if (layout !== told) {
                told = layout;
                onLayout(result.layout, view.state.doc);
              }
            });
          };
          schedule();
          void document.fonts.ready.then(schedule);
          const ro = new ResizeObserver(schedule);
          ro.observe(view.dom);
          view.dom.addEventListener(REMEASURE_EVENT, schedule);
          return {
            update(v, prev) {
              if (v.state.doc !== prev.doc) schedule();
            },
            destroy() {
              cancelAnimationFrame(frame);
              ro.disconnect();
              view.dom.removeEventListener(REMEASURE_EVENT, schedule);
            },
          };
        },
      }),
    ];
  },
});
