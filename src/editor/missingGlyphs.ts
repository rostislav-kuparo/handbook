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

function build(doc: PMNode, hasGlyph: (ch: string) => boolean): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    let offset = 0;
    for (const ch of node.text) {
      const len = ch.length;
      if (!/\s/u.test(ch) && !hasGlyph(ch)) {
        decos.push(
          Decoration.inline(pos + offset, pos + offset + len, {
            class: 'missing-glyph',
            'data-char': ch,
            title: `«${ch}» ещё не написана — кликните, чтобы дорисовать`,
          }),
        );
      }
      offset += len;
    }
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
    return [
      new Plugin<DecorationSet>({
        key: missingGlyphsKey,
        state: {
          init: (_, state) => build(state.doc, hasGlyph),
          apply: (tr, old, _oldState, newState) =>
            tr.docChanged || tr.getMeta(missingGlyphsKey) ? build(newState.doc, hasGlyph) : old,
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
