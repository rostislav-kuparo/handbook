import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { LINE_HEIGHT_EM } from './layout';
import { lineSegments, type Segment } from './lines';
import { measureStamp, sagChanged, voidMeasures } from './measureCache';
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

/**
 * The offsets of a paragraph's letters, as worked out last: where each is in
 * the paragraph (from its start), how long, and its style — and the
 * decorations made of them for the place the paragraph was at. Kept per
 * paragraph (see measureCache.ts): typing in one does not measure the others.
 *
 * The offsets themselves move the words a little (letters in elements of
 * their own are not kerned together), so a paragraph is `sure` only once a
 * second look, with its offsets in place, has found the same; until then it
 * is measured again every time.
 */
interface ParagraphSag {
  stamp: string;
  /** All of `specs` in one string: two measures compare by it. */
  key: string;
  sure: boolean;
  specs: { rel: number; len: number; style: string }[];
}
const sags = new WeakMap<PMNode, ParagraphSag>();

/** A paragraph's offsets as decorations, for the paragraph starting at `start`. */
const decosOf = (sag: ParagraphSag, start: number) => sag.specs.map((s) => Decoration.inline(start + s.rel, start + s.rel + s.len, { style: s.style }));

/** A paragraph of the text with its offsets: where its content lies, and whether they were worked out in this look. */
interface Part {
  start: number;
  end: number;
  sag: ParagraphSag;
  fresh: boolean;
}

/** The offsets of every letter, and whether some paragraph is still to be looked at once more (see `ParagraphSag`). */
function measure(view: EditorView, p: HandLayoutParams): { parts: Part[]; unsure: boolean; changed: boolean } | null {
  if (p.sag <= 0 && p.lineJitter <= 0) return null;
  let unsure = false;
  /** Some paragraph's offsets are not those of the look before (or lie elsewhere now). */
  let changed = false;
  const parts: Part[] = [];
  const fontPx = parseFloat(getComputedStyle(view.dom).fontSize) || 16;
  const lineHeightPx = fontPx * LINE_HEIGHT_EM;
  const widthEm = Math.max(view.dom.clientWidth / fontPx, 1);
  const stamp = `${measureStamp(view, fontPx)}|${p.sag}|${p.lineJitter}|${p.seed}`;

  view.state.doc.forEach((block, offset) => {
    if (block.type.name !== 'paragraph' || block.content.size === 0) return;
    const start = offset + 1;
    const end = offset + block.nodeSize - 1;
    const known = sags.get(block);
    if (known?.stamp === stamp && known.sure) {
      parts.push({ start, end, sag: known, fresh: false });
      return;
    }
    const fresh: ParagraphSag = { stamp, key: '', sure: false, specs: [] };
    parts.push({ start, end, sag: fresh, fresh: true });
    const keep = () => {
      fresh.key = fresh.specs.map((s) => `${s.rel}:${s.style}`).join(';');
      // The same as the look before: it holds. Another: the words may have moved with it.
      fresh.sure = known?.stamp === stamp && known.key === fresh.key;
      if (!fresh.sure) {
        unsure = true;
        if (known?.key !== fresh.key) sagChanged(block);
      }
      if (known?.key !== fresh.key) changed = true;
      sags.set(block, fresh);
    };
    const text = block.textBetween(0, block.content.size, undefined, '￼');
    type Word = Segment;
    // Words, with a word too long for one line split at its wraps.
    const words: Word[] = lineSegments(view, start, text, lineHeightPx);
    if (words.length === 0) return keep();

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
            fresh.specs.push({ rel: pos - start, len: ch.length, style: `position:relative;top:${y.toFixed(3)}em` });
          }
          pos += ch.length;
        });
      }
    });
    keep();
  });
  return { parts, unsure, changed };
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
          /** Looks asked for by a look itself, in a row: a few settle it, and it must not go on for ever. */
          let follow = 0;
          let asking = false;
          /** The set shown is the one made here (moved along with the text since): it can be mended paragraph by paragraph. */
          let ours = false;
          const show = (set: DecorationSet) => view.dispatch(view.state.tr.setMeta(handLayoutKey, set).setMeta('addToHistory', false));
          const schedule = () => {
            if (!asking) follow = 0;
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
              if (view.isDestroyed) return;
              const found = measure(view, getParams());
              if (!found) {
                // No offsets at all (a perfectly even hand).
                if (handLayoutKey.getState(view.state) !== DecorationSet.empty) show(DecorationSet.empty);
                ours = false;
                return;
              }
              const { parts, unsure, changed } = found;
              const fresh = parts.filter((part) => part.fresh);
              const doc = view.state.doc;
              if (!ours || fresh.length * 4 > parts.length) {
                // All of it anew.
                show(DecorationSet.create(doc, parts.flatMap((part) => decosOf(part.sag, part.start))));
                ours = true;
              } else if (changed) {
                // The paragraphs untouched keep theirs (they moved along with the text): only those measured anew are mended.
                let set = handLayoutKey.getState(view.state) ?? DecorationSet.empty;
                for (const part of fresh) {
                  const old = set.find(part.start, part.end);
                  if (old.length) set = set.remove(old);
                  if (part.sag.specs.length) set = set.add(doc, decosOf(part.sag, part.start));
                }
                show(set);
              }
              // Paragraphs measured anew are looked at once more with their offsets in place — the page breaks too.
              if (unsure && follow < 3) {
                follow++;
                asking = true;
                view.dom.dispatchEvent(new Event(REMEASURE_EVENT));
                asking = false;
              }
            });
          };
          schedule();
          void document.fonts.ready.then(() => {
            voidMeasures(view.dom);
            schedule();
          });
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
