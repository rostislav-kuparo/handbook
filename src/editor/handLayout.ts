import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { LINE_HEIGHT_EM } from './layout';
import { lineSegments, type Segment } from './lines';
import { REMEASURE_EVENT } from './pagination';

// Editor plugins are set up once per editor: reload the page instead of hot-swapping.
import.meta.hot?.accept(() => location.reload());

/**
 * Uneven handwriting in the editor: each visual line gets its own small
 * offset (so the distance between rows varies), the line droops to the
 * right, every word sinks a little and its letters sag progressively.
 *
 * Offsets are applied with `position: relative; top`, which never changes
 * line breaking — so measuring the lines and decorating them cannot loop.
 * Randomness is seeded by the words themselves, so typing in one place does
 * not make the rest of the text jump. The same model (in font units) is used
 * by the ink renderer in glyph-core.
 */

export interface HandLayoutParams {
  sag: number;
  lineJitter: number;
  seed: number;
}

export const handLayoutKey = new PluginKey<DecorationSet>('handLayout');

function hash(s: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-9);
  return Math.max(-2.5, Math.min(2.5, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r())));
}

function measure(view: EditorView, p: HandLayoutParams): DecorationSet {
  if (p.sag <= 0 && p.lineJitter <= 0) return DecorationSet.empty;
  const fontPx = parseFloat(getComputedStyle(view.dom).fontSize) || 16;
  const lineHeightPx = fontPx * LINE_HEIGHT_EM;
  const widthEm = Math.max(view.dom.clientWidth / fontPx, 1);
  const decos: Decoration[] = [];

  view.state.doc.forEach((block, offset) => {
    if (block.type.name !== 'paragraph' || block.content.size === 0) return;
    const start = offset + 1;
    const text = block.textBetween(0, block.content.size, undefined, '￼');
    type Word = Segment;
    // Words, with a word too long for one line split at its wraps.
    const words: Word[] = lineSegments(view, start, text, lineHeightPx);
    if (words.length === 0) return;

    // Group words into visual lines.
    const lines: Word[][] = [];
    for (const w of words) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(w.top - line[0].top) < lineHeightPx * 0.5) line.push(w);
      else lines.push([w]);
    }

    const seen = new Map<string, number>();
    lines.forEach((line, li) => {
      const lr = rng(hash(`${line[0].text}|${li}`, p.seed ^ 0x5eed));
      const lineOffset = gauss(lr) * p.lineJitter * 0.12 * LINE_HEIGHT_EM;
      const droop = (p.sag * (lr() * 1.25 - 0.25) * 0.3 * LINE_HEIGHT_EM) / widthEm;
      const lineLeft = line[0].left;
      for (const w of line) {
        const occurrence = seen.get(w.text) ?? 0;
        seen.set(w.text, occurrence + 1);
        const wr = rng(hash(w.text, p.seed + occurrence * 7919));
        const wordDrop = p.sag * wr() * 0.06;
        const slide = p.sag * (0.3 + 0.7 * wr()) * 0.07;
        const chars = [...w.text];
        const xEm = (w.left - lineLeft) / fontPx;
        let pos = w.from;
        chars.forEach((ch, k) => {
          const y = lineOffset + droop * (xEm + k * 0.45) + wordDrop + (slide * k) / Math.max(chars.length - 1, 1);
          if (Math.abs(y) > 0.002) {
            decos.push(Decoration.inline(pos, pos + ch.length, { style: `position:relative;top:${y.toFixed(3)}em` }));
          }
          pos += ch.length;
        });
      }
    });
  });
  return DecorationSet.create(view.state.doc, decos);
}

export const HandLayout = Extension.create<{ getParams: () => HandLayoutParams }>({
  name: 'handLayout',

  addOptions() {
    return { getParams: () => ({ sag: 0, lineJitter: 0, seed: 1 }) };
  },

  addProseMirrorPlugins() {
    const getParams = this.options.getParams;
    return [
      new Plugin<DecorationSet>({
        key: handLayoutKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, old) => (tr.getMeta(handLayoutKey) as DecorationSet | undefined) ?? old.map(tr.mapping, tr.doc),
        },
        props: { decorations: (state) => handLayoutKey.getState(state) },
        view(view) {
          let frame = 0;
          const schedule = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
              if (view.isDestroyed) return;
              view.dispatch(view.state.tr.setMeta(handLayoutKey, measure(view, getParams())).setMeta('addToHistory', false));
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
