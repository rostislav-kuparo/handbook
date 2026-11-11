import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const missingGlyphsKey = new PluginKey<DecorationSet>('missingGlyphs');

export interface MissingGlyphsOptions {
  /** Characters that have handwriting samples. */
  hasGlyph: (ch: string) => boolean;
  onMissingClick: (ch: string, rect: DOMRect) => void;
}

const attrsOf = (ch: string) => ({
  class: 'missing-glyph',
  'data-char': ch,
  title: `«${ch}» ещё не написана — кликните, чтобы дорисовать`,
});

/**
 * The letters of a paragraph without handwriting, as found last: where each is
 * in the paragraph (from its start) — and the decorations made of them for the
 * place the paragraph was at. ProseMirror keeps the same node object for a
 * paragraph nobody touched, so typing in one does not go through the others
 * letter by letter; `epoch` tells the set of written letters they were found for.
 */
interface Found {
  epoch: number;
  marks: { rel: number; ch: string }[];
  start: number;
  decos: Decoration[];
}
const found = new WeakMap<PMNode, Found>();

function build(doc: PMNode, hasGlyph: (ch: string) => boolean, epoch: number): DecorationSet {
  const decos: Decoration[] = [];
  doc.forEach((block, offset) => {
    const start = offset + 1;
    const known = found.get(block);
    if (known?.epoch === epoch) {
      // The paragraph moved (the text before it changed): the same letters at its new place.
      if (known.start !== start) {
        known.decos = known.marks.map((m) => Decoration.inline(start + m.rel, start + m.rel + m.ch.length, attrsOf(m.ch)));
        known.start = start;
      }
      for (const d of known.decos) decos.push(d);
      return;
    }
    const fresh: Found = { epoch, marks: [], start, decos: [] };
    block.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      let at = pos;
      for (const ch of node.text) {
        if (!/\s/u.test(ch) && !hasGlyph(ch)) {
          fresh.marks.push({ rel: at, ch });
          fresh.decos.push(Decoration.inline(start + at, start + at + ch.length, attrsOf(ch)));
        }
        at += ch.length;
      }
    });
    found.set(block, fresh);
    for (const d of fresh.decos) decos.push(d);
  });
  return DecorationSet.create(doc, decos);
}

/**
 * Underlines characters the handwriting does not cover yet (they fall back to
 * a system font) and lets the user draw them right where they are.
 * Dispatch a transaction with meta `missingGlyphsKey` to refresh after the
 * glyph set changed.
 */
export const MissingGlyphs = Extension.create<MissingGlyphsOptions>({
  name: 'missingGlyphs',

  addOptions() {
    return { hasGlyph: () => true, onMissingClick: () => {} };
  },

  addProseMirrorPlugins() {
    const { hasGlyph, onMissingClick } = this.options;
    // Open the "draw it" popover only on a plain single click: a double click
    // (selecting a word) or a drag must not pop it up.
    let pending: number | undefined;
    /** Counts the changes of the set of written letters: what was found before one is looked for anew. */
    let epoch = 0;
    return [
      new Plugin<DecorationSet>({
        key: missingGlyphsKey,
        state: {
          init: (_, state) => build(state.doc, hasGlyph, epoch),
          apply: (tr, old, _oldState, newState) => {
            if (tr.getMeta(missingGlyphsKey)) epoch++;
            else if (!tr.docChanged) return old;
            return build(newState.doc, hasGlyph, epoch);
          },
        },
        props: {
          decorations: (state) => missingGlyphsKey.getState(state),
          handleClick: (view, _pos, event) => {
            window.clearTimeout(pending);
            const el = (event.target as HTMLElement).closest?.('.missing-glyph') as HTMLElement | null;
            if (!el?.dataset.char || event.detail > 1) return false;
            const char = el.dataset.char;
            const rect = el.getBoundingClientRect();
            pending = window.setTimeout(() => {
              if (!view.isDestroyed && view.state.selection.empty) onMissingClick(char, rect);
            }, 300);
            return false;
          },
          handleDoubleClick: () => {
            window.clearTimeout(pending);
            return false;
          },
        },
      }),
    ];
  },
});

// Editor plugins are set up once per editor: reload the page instead of hot-swapping.
import.meta.hot?.accept(() => location.reload());
