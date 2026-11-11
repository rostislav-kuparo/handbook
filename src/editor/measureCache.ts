// Where a paragraph's lines break depends only on its text, the font and the
// width of the column — not on the text around it. Measuring it means asking
// the browser where every word is, which is slow in a long document; so what
// was measured is kept per paragraph (ProseMirror keeps the same node object
// for a paragraph nobody touched) and thrown away when anything else that
// moves the words changes: that is what the stamp tells.
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { zoomOf } from './zoom';

const epochs = new WeakMap<HTMLElement, number>();

/**
 * The words may sit differently with the text unchanged (a new font, another
 * size of the letters): everything measured before is void.
 */
export function voidMeasures(dom: HTMLElement) {
  epochs.set(dom, (epochs.get(dom) ?? 0) + 1);
}

/** What the line breaks were measured under; a paragraph measured under the same stamp need not be measured again. */
export function measureStamp(view: EditorView, fontPx: number): string {
  return [epochs.get(view.dom) ?? 0, fontPx, view.dom.clientWidth, zoomOf(view.dom), window.devicePixelRatio].join('|');
}

/**
 * The letters' offsets in the editor (handLayout.ts) wrap single letters into
 * elements of their own, and letters apart are not kerned together: a
 * paragraph whose offsets changed may wrap differently. Its number here
 * changes with them, and the lines measured for the page breaks are measured
 * again.
 */
const sagVersions = new WeakMap<PMNode, number>();
let sagCount = 0;

export const sagVersion = (node: PMNode) => sagVersions.get(node) ?? 0;

export function sagChanged(node: PMNode) {
  sagVersions.set(node, ++sagCount);
}
