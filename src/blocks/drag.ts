// Moving and stretching a block that lies over the sheet: it is moved by its
// blue square and stretched by its edges and corners. Everything in sheet px
// (the zoom taken off), one undo step for the whole movement.
import { zoomOf } from '../editor/zoom';

/** An edge or a corner of a block, by the compass: n is the top. */
export type Side = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Where a floating block lies and how wide it is, px from the text column. */
export interface BlockBox {
  x: number;
  y: number;
  w: number;
}

export interface DragOptions {
  start: BlockBox;
  /**
   * The block's height at a width: a drawing's height follows its width, so
   * its top and bottom edges and its corners pull the width too (the opposite
   * side stays put). Null: only the left and right edges stretch it.
   */
  heightAt: ((w: number) => number) | null;
  /** Where a moved block may lie (the sheet's edges). */
  place: (b: BlockBox) => BlockBox;
  minW: number;
  maxW: number;
  onDrag: (b: BlockBox) => void;
  onDone: (b: BlockBox) => void;
}

/** The sides a block is stretched by: all eight when its height follows its width, else the left and right ones. */
export const sidesFor = (follows: boolean): Side[] => (follows ? ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] : ['e', 'w']);

/** The block stretched by `side` by (dx, dy) px: the opposite side or corner stays where it was. */
export function stretch(s: BlockBox, side: Side, dx: number, dy: number, o: Pick<DragOptions, 'heightAt' | 'minW' | 'maxW'>): BlockBox {
  const h = o.heightAt;
  // Px of height per px of width (a drawing's height is its width times a ratio, plus room for the labels).
  const a = h ? (h(s.w) - h(s.w / 2)) / (s.w / 2) || null : null;
  const west = side.includes('w');
  const east = side.includes('e');
  const north = side.startsWith('n');
  const south = side.startsWith('s');
  const byX = east ? s.w + dx : west ? s.w - dx : null;
  const byY = a ? (south ? s.w + dy / a : north ? s.w - dy / a : null) : null;
  // A corner follows whichever way the hand pulls it more.
  let w = byX !== null && byY !== null ? (Math.abs(byX - s.w) >= Math.abs(byY - s.w) ? byX : byY) : (byX ?? byY ?? s.w);
  w = Math.round(Math.min(Math.max(w, o.minW), o.maxW));
  return {
    w,
    x: west ? Math.round(s.x + s.w - w) : s.x,
    y: north && h ? Math.round(s.y + h(s.w) - h(w)) : s.y,
  };
}

/** Moves (`move`) or stretches the block from a pointer down on one of its handles until the button is let go. */
export function dragBlock(e: React.PointerEvent, how: 'move' | Side, o: DragOptions) {
  e.preventDefault(); // also keeps ProseMirror from starting a selection or a drag
  e.stopPropagation();
  const [sx, sy] = [e.clientX, e.clientY];
  const z = zoomOf(e.currentTarget);
  const s = o.start;
  let last = s;
  getSelection()?.removeAllRanges();
  document.body.style.userSelect = 'none';
  // The handle's cursor stays on wherever the pointer goes.
  document.body.style.cursor = getComputedStyle(e.currentTarget).cursor;
  o.onDrag(s);
  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - sx) / z;
    const dy = (ev.clientY - sy) / z;
    if (how === 'move') {
      const p = o.place({ ...s, x: s.x + dx, y: s.y + dy });
      last = { ...p, x: Math.round(p.x), y: Math.round(p.y) };
    } else last = stretch(s, how, dx, dy, o);
    o.onDrag(last);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    o.onDone(last);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
