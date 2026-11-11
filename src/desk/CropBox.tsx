import { useRef } from 'react';

/** A crop of the photo: left, top, right, bottom, photo px. */
export type Crop = [number, number, number, number];

/** The smallest crop, photo px. */
const MIN = 32;

/** Which part of the frame is taken: a side, a corner, or the whole frame (to move it). */
type Part = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';
const PARTS: Part[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** `c` with the proportions w/h `aspect`, as large as fits in itself and the photo, round its middle. */
export function fitAspect(c: Crop, aspect: number, w: number, h: number): Crop {
  const [cx, cy] = [(c[0] + c[2]) / 2, (c[1] + c[3]) / 2];
  let [cw, ch] = [c[2] - c[0], c[3] - c[1]];
  if (cw / ch > aspect) cw = ch * aspect;
  else ch = cw / aspect;
  return within([cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2], w, h);
}

/** A crop moved (not resized) into the photo, and shrunk when it is larger. */
export function within(c: Crop, w: number, h: number): Crop {
  let [x0, y0, x1, y1] = c;
  const [cw, ch] = [Math.min(w, x1 - x0), Math.min(h, y1 - y0)];
  x0 = Math.min(Math.max(0, x0), w - cw);
  y0 = Math.min(Math.max(0, y0), h - ch);
  return [x0, y0, x0 + cw, y0 + ch];
}

interface Props {
  crop: Crop;
  /** The photo's size, px. */
  width: number;
  height: number;
  /** Where the photo lies on the screen: its top left, screen px per photo px. */
  place: { left: number; top: number; scale: number };
  /** Proportions to keep (w/h), or null: free. */
  aspect: number | null;
  onChange: (c: Crop) => void;
}

/**
 * A frame over the photo to crop it by: its sides and corners resize it, a
 * drag inside moves it; outside it the photo is dimmed. Shift keeps the
 * proportions it has.
 */
export function CropBox({ crop, width, height, place, aspect, onChange }: Props) {
  const drag = useRef<{ part: Part; x: number; y: number; from: Crop; aspect: number | null } | null>(null);
  const [x0, y0, x1, y1] = crop;
  const box = { left: place.left + x0 * place.scale, top: place.top + y0 * place.scale, width: (x1 - x0) * place.scale, height: (y1 - y0) * place.scale };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [dx, dy] = [(e.clientX - d.x) / place.scale, (e.clientY - d.y) / place.scale];
    let [a, b, c, f] = d.from;
    if (d.part === 'move') {
      onChange(within([a + dx, b + dy, c + dx, f + dy], width, height));
      return;
    }
    if (d.part.includes('w')) a = Math.min(c - MIN, Math.max(0, a + dx));
    if (d.part.includes('e')) c = Math.max(a + MIN, Math.min(width, c + dx));
    if (d.part.includes('n')) b = Math.min(f - MIN, Math.max(0, b + dy));
    if (d.part.includes('s')) f = Math.max(b + MIN, Math.min(height, f + dy));
    const k = d.aspect ?? (e.shiftKey ? (d.from[2] - d.from[0]) / (d.from[3] - d.from[1]) : null);
    if (k) {
      // The dragged side decides; the other dimension follows, from the side or corner held still.
      const [cw, ch] = [c - a, f - b];
      const byWidth = d.part === 'e' || d.part === 'w' || (d.part.length === 2 && cw / ch > k);
      if (byWidth) {
        const nh = cw / k;
        if (d.part.includes('n')) b = f - nh;
        else if (d.part.includes('s')) f = b + nh;
        else [b, f] = [(b + f) / 2 - nh / 2, (b + f) / 2 + nh / 2];
      } else {
        const nw = ch * k;
        if (d.part.includes('w')) a = c - nw;
        else if (d.part.includes('e')) c = a + nw;
        else [a, c] = [(a + c) / 2 - nw / 2, (a + c) / 2 + nw / 2];
      }
      // Out of the photo: back to the proportions inside it.
      if (a < 0 || b < 0 || c > width || f > height) {
        const fitted = fitAspect([Math.max(0, a), Math.max(0, b), Math.min(width, c), Math.min(height, f)], k, width, height);
        onChange(fitted);
        return;
      }
    }
    onChange([a, b, c, f]);
  };
  const start = (part: Part) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { part, x: e.clientX, y: e.clientY, from: crop, aspect };
  };
  const end = () => (drag.current = null);

  return (
    <div className="desk-crop" style={box} onPointerDown={start('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <span className="desk-crop-size">
        {Math.round(x1 - x0)} × {Math.round(y1 - y0)}
      </span>
      {PARTS.map((p) => (
        <span key={p} className={`desk-crop-handle ${p}`} onPointerDown={start(p)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
      ))}
    </div>
  );
}
