// Where the editor put a document's lines, kept with the document: the
// rendered view and the exports write the same lines, broken at the same
// words, on the same places of the same sheets — and the paragraphs keep the
// room they have in the editor.
import type { DocContent } from '../model/types';
import type { PMNodeJSON } from './layout';
import type { Geometry } from './page';

/** A top-level node in the editor: a paragraph's visual lines, or a block (one place). */
export interface NodeLayout {
  /** Where each line starts: code points into the paragraph's text (0 for the first). */
  starts: number[];
  /** Each line's (a block's) sheet and its top in the writable area of that sheet, px. */
  at: [number, number][];
}

export interface DocLayout {
  /** What it was measured for (see `layoutKey`): another text or page makes it void. */
  key: string;
  /** Per top-level node; null for a floating block. */
  nodes: (NodeLayout | null)[];
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** The text, the letters' size, the page and the title a layout belongs to. */
export function layoutKey(content: DocContent, fontSize: number, geo: Geometry, showTitle: boolean): string {
  const m = geo.margin;
  return [textKey(content), fontSize, geo.contentW, m.top, m.bottom, showTitle ? 1 : 0].join(':');
}

/** The text's part of the key, worked out once per content (the editor hands the same object to all who ask while the text is the same). */
const textKeys = new WeakMap<object, string>();
function textKey(content: DocContent): string {
  let key = textKeys.get(content);
  if (key === undefined) {
    const json = JSON.stringify(content);
    key = `${hash(json)}:${json.length}`;
    textKeys.set(content, key);
  }
  return key;
}

/** The nodes of a layout, when it fits these nodes (the same count): null otherwise. */
export function layoutFor(layout: DocLayout | null | undefined, key: string, nodes: PMNodeJSON[]): (NodeLayout | null)[] | null {
  return layout && layout.key === key && layout.nodes.length === nodes.length ? layout.nodes : null;
}

/** Where a paragraph's lines must break (its line starts but the first), for the engine. */
export const breaksOf = (n: NodeLayout | null | undefined) => (n ? n.starts.filter((s) => s > 0) : []);
