import type { EditorView } from '@tiptap/pm/view';

/** A piece of text that sits on one visual line. */
export interface Segment {
  from: number;
  text: string;
  /** Text of the whole word (the same for every piece of a word broken across lines). */
  word: string;
  top: number;
  left: number;
}

/**
 * Words of a paragraph, split into the pieces that sit on one visual line.
 * Usually a piece is a whole word; a word longer than the line (no spaces to
 * break at) wraps inside itself and is split at every wrap.
 */
export function lineSegments(view: EditorView, start: number, text: string, lineHeight: number): Segment[] {
  const out: Segment[] = [];
  for (const m of text.matchAll(/\S+/gu)) {
    const word = m[0];
    const from = start + m.index!;
    const first = view.coordsAtPos(from, 1);
    const last = view.coordsAtPos(from + word.length, -1);
    if (Math.abs(last.top - first.top) < lineHeight * 0.5) {
      out.push({ from, text: word, word, top: first.top, left: first.left });
      continue;
    }
    // The word wraps inside itself: find where each line of it starts.
    let segFrom = from;
    let segTop = first.top;
    let segLeft = first.left;
    let offset = 0;
    for (const ch of word) {
      const pos = from + offset;
      if (offset > 0) {
        const c = view.coordsAtPos(pos, 1);
        if (c.top - segTop > lineHeight * 0.5) {
          out.push({ from: segFrom, text: text.slice(segFrom - start, pos - start), word, top: segTop, left: segLeft });
          segFrom = pos;
          segTop = c.top;
          segLeft = c.left;
        }
      }
      offset += ch.length;
    }
    out.push({ from: segFrom, text: text.slice(segFrom - start, from + word.length - start), word, top: segTop, left: segLeft });
  }
  return out;
}
