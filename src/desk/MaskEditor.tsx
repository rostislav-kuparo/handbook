import { useEffect, useRef, useState } from 'react';
import { along, type HandMargins, type MarginLine, type ObjectMask, type Ruling } from './analysis';
import { apply, homography, invert, type Pt } from './homography';
import type { Photo } from './photo';
import { warpMap, type Warp } from './warp';

const PAD = 12;
/** How near (screen px) a margin line can be taken. */
const GRAB = 10;
/** How near (mm) a dragged margin sticks to a printed line. */
const STICK = 1.2;
const PINK = 'rgba(255, 60, 150, 0.9)';

export type Brush = 'erase' | 'restore';
/** What the pointer does: paints the mask, or moves the margin lines. */
export type MaskTool = 'brush' | 'margins';
type Side = keyof HandMargins;
/** What of a margin line is taken: one of its ends (it turns round the other), or the whole line. */
type Part = 'a' | 'b' | 'mid';
const VERTICAL: Record<Side, boolean> = { left: true, right: true, top: false, bottom: false };

interface Props {
  photo: Photo;
  /** Where the sheet lies in the photo (curved or flat). */
  warp: Warp;
  /** Size of the paper, mm (to draw the printed lines found on it). */
  paperMm: [number, number];
  ruling: Ruling | null;
  /** The margin lines the text keeps within, mm. */
  margins: HandMargins;
  mask: ObjectMask | null;
  tool: MaskTool;
  brush: Brush;
  /** Brush radius, photo px. */
  radius: number;
  onChange: (mask: ObjectMask) => void;
  onMargins: (margins: HandMargins) => void;
}

/**
 * The photo with what lies on the sheet in red (no text there), the printed
 * lines that were found and the margin lines. A brush marks more («стереть»
 * — no text here) or gives the paper back («вернуть»); the margin lines can
 * be dragged whole or by an end (then they turn round the other end), and
 * stick to the printed lines (not with Alt); a double click sets a line
 * along the printed lines again.
 */
export function MaskEditor({ photo, warp, paperMm, ruling, margins, mask, tool, brush, radius, onChange, onMargins }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<ImageBitmap | null>(null);
  const [cursor, setCursor] = useState<Pt | null>(null);
  /** The mask being painted (a copy) and its red overlay. */
  const work = useRef<{ data: Uint8Array; overlay: OffscreenCanvas; image: ImageData } | null>(null);
  const painting = useRef(false);
  /** The margin line (and which part of it) under the pointer, or being dragged (with where it is now, mm). */
  const [grab, setGrab] = useState<{ side: Side; part: Part; line: MarginLine; dragging: boolean } | null>(null);
  const [, redraw] = useState(0);
  const dpr = window.devicePixelRatio || 1;

  const map = warpMap(warp);
  const s = box.w > 0 ? Math.min((box.w - 2 * PAD) / photo.width, (box.h - 2 * PAD) / photo.height) : 0;
  const ox = (box.w - photo.width * s) / 2;
  const oy = (box.h - photo.height * s) / 2;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (s <= 0) return;
    let alive = true;
    void createImageBitmap(photo.bitmap, {
      resizeWidth: Math.max(1, Math.round(photo.width * s * dpr)),
      resizeHeight: Math.max(1, Math.round(photo.height * s * dpr)),
      resizeQuality: 'high',
    }).then((b) => (alive ? setView(b) : b.close()));
    return () => {
      alive = false;
    };
  }, [photo, s, dpr]);
  useEffect(() => () => view?.close(), [view]);

  // A fresh mask from outside: copy it and paint its overlay.
  useEffect(() => {
    if (!mask) {
      work.current = null;
      redraw((n) => n + 1);
      return;
    }
    const overlay = new OffscreenCanvas(mask.width, mask.height);
    const image = new ImageData(mask.width, mask.height);
    const data = mask.data.slice();
    for (let i = 0; i < data.length; i++) {
      image.data[i * 4] = 230;
      image.data[i * 4 + 1] = 40;
      image.data[i * 4 + 2] = 40;
      image.data[i * 4 + 3] = Math.round((255 - data[i]) * 0.5);
    }
    overlay.getContext('2d')!.putImageData(image, 0, 0);
    work.current = { data, overlay, image };
    redraw((n) => n + 1);
  }, [mask]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || s <= 0) return;
    const [cw, ch] = [Math.round(box.w * dpr), Math.round(box.h * dpr)];
    if (canvas.width !== cw || canvas.height !== ch) [canvas.width, canvas.height] = [cw, ch];
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(view ?? photo.bitmap, ox, oy, photo.width * s, photo.height * s);
    if (work.current) ctx.drawImage(work.current.overlay, ox, oy, photo.width * s, photo.height * s);

    // The printed lines found, mapped from the sheet (mm) onto the photo — along the sheet's curve.
    const [wMm, hMm] = paperMm;
    const line = (a: Pt, b: Pt) => {
      // a, b in mm on the sheet; drawn as a polyline through the warp.
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const [x, y] = at(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
    };
    if (ruling) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(40, 200, 255, 0.75)';
      for (let y = ruling.offset; y < hMm; y += ruling.step) line([0, y], [wMm, y + wMm * ruling.slope]);
      if (ruling.colOffset !== null) {
        for (let x = ruling.colOffset; x < wMm; x += ruling.colStep ?? ruling.step) line([x, 0], [x - hMm * ruling.slope, hMm]);
      }
    }
    // The margin lines, the one at hand thicker; with the margins tool, their ends to take.
    for (const side of Object.keys(VERTICAL) as Side[]) {
      const l = grab?.side === side ? grab.line : margins[side];
      if (!l) continue;
      ctx.lineWidth = grab?.side === side ? 3 : 2;
      ctx.strokeStyle = PINK;
      const [e0, e1] = ends(side, l);
      line(e0, e1);
      if (tool !== 'margins') continue;
      for (const [part, e] of [['a', e0], ['b', e1]] as const) {
        const held = grab?.side === side && grab.part === part;
        ctx.beginPath();
        ctx.arc(...at(...e), held ? 6.5 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = held ? PINK : '#fff';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    if (cursor && tool === 'brush') {
      ctx.beginPath();
      ctx.arc(cursor[0], cursor[1], radius * s, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = brush === 'erase' ? '#ff6b6b' : '#7ee28f';
      ctx.stroke();
    }
  });

  /** A point of the sheet (mm) on the screen. */
  function at(x: number, y: number): Pt {
    const [px, py] = map(x / paperMm[0], y / paperMm[1]);
    return [ox + px * s, oy + py * s];
  }
  /** The ends of a margin line on the sheet's edges, mm. */
  function ends(side: Side, l: MarginLine): [Pt, Pt] {
    const [wMm, hMm] = paperMm;
    return VERTICAL[side] ? [[l.a, 0], [l.b, hMm]] : [[0, l.a], [wMm, l.b]];
  }
  /** A screen point on the sheet, mm (by the sheet's perspective; its bow is small here). */
  const toSheet = (p: Pt): Pt => {
    const [u, v] = apply(invert(homography([[0, 0], [1, 0], [1, 1], [0, 1]], warp.corners)), [(p[0] - ox) / s, (p[1] - oy) / s]);
    return [u * paperMm[0], v * paperMm[1]];
  };
  /** The margin line within reach of screen point p, and which part of it: its ends come first. */
  const nearest = (p: Pt): { side: Side; part: Part } | null => {
    const [x, y] = toSheet(p);
    const near: { side: Side; part: Part; d: number }[] = [];
    for (const side of Object.keys(VERTICAL) as Side[]) {
      const l = margins[side];
      if (!l) continue;
      const [e0, e1] = ends(side, l);
      // The point of the line level with p, on the screen.
      const level = VERTICAL[side] ? at(along(l, y / paperMm[1]), y) : at(x, along(l, x / paperMm[0]));
      for (const [part, q, reach] of [['a', at(...e0), 4], ['b', at(...e1), 4], ['mid', level, 0]] as const) {
        near.push({ side, part, d: Math.hypot(q[0] - p[0], q[1] - p[1]) - reach });
      }
    }
    const best = near.filter((n) => n.d < GRAB).sort((m, n) => m.d - n.d)[0];
    return best ? { side: best.side, part: best.part } : null;
  };
  /**
   * Where a margin line goes for the pointer at p: the taken end there (the
   * other one stays), or the whole line through it; sticking to a printed
   * line nearby, unless `free`.
   */
  const moveTo = (side: Side, part: Part, l: MarginLine, p: Pt, free: boolean): MarginLine => {
    const [x, y] = toSheet(p);
    const [wMm, hMm] = paperMm;
    const vertical = VERTICAL[side];
    const [length, across, room] = vertical ? [hMm, x, wMm] : [wMm, y, hMm];
    // Where along the line the pointer is: 0 at its `a` end, 1 at its `b` end.
    const t = part === 'a' ? 0 : part === 'b' ? 1 : Math.min(1, Math.max(0, (vertical ? y : x) / length));
    const shift = (n: MarginLine, d: number): MarginLine =>
      part === 'mid' ? { a: n.a + d, b: n.b + d } : part === 'a' ? { ...n, a: n.a + d } : { ...n, b: n.b + d };
    let n = shift(l, across - along(l, t));
    if (ruling && !free) {
      const [start, step] = vertical ? [ruling.colOffset, ruling.colStep ?? ruling.step] : [ruling.offset, ruling.step];
      if (start !== null) {
        // The printed lines lean: columns x = start + k·step − y·slope, rows y = start + k·step + x·slope.
        const u = along(n, t) + (vertical ? 1 : -1) * ruling.slope * t * length;
        const printed = start + Math.round((u - start) / step) * step;
        if (Math.abs(printed - u) < STICK) n = shift(n, printed - u);
      }
    }
    const clamp = (v: number) => Math.min(Math.max(v, 0), room);
    return { a: clamp(n.a), b: clamp(n.b) };
  };
  /** The line along the printed lines again, through its middle. */
  const straighten = (side: Side, l: MarginLine): MarginLine => {
    const slope = ruling?.slope ?? 0;
    const lean = VERTICAL[side] ? -slope * paperMm[1] : slope * paperMm[0];
    const mid = along(l, 0.5);
    return { a: mid - lean / 2, b: mid + lean / 2 };
  };

  /** Paints a disc of the brush at screen point p into the mask copy and its overlay. */
  const paint = (p: Pt) => {
    const w = work.current;
    if (!w || !mask) return;
    const k = mask.width / photo.width;
    const cx = ((p[0] - ox) / s) * k;
    const cy = ((p[1] - oy) / s) * k;
    const r = radius * k;
    const value = brush === 'erase' ? 0 : 255;
    const [x0, x1] = [Math.max(0, Math.floor(cx - r - 1)), Math.min(mask.width - 1, Math.ceil(cx + r + 1))];
    const [y0, y1] = [Math.max(0, Math.floor(cy - r - 1)), Math.min(mask.height - 1, Math.ceil(cy + r + 1))];
    if (x0 > x1 || y0 > y1) return;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // Soft rim of one mask pixel.
        const t = Math.min(1, Math.max(0, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
        if (t <= 0) continue;
        const i = y * mask.width + x;
        const v = Math.round(w.data[i] + (value - w.data[i]) * t);
        w.data[i] = v;
        w.image.data[i * 4 + 3] = Math.round((255 - v) * 0.5);
      }
    }
    w.overlay.getContext('2d')!.putImageData(w.image, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  };

  const pointer = (e: React.MouseEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const finish = () => {
    if (grab?.dragging) {
      onMargins({ ...margins, [grab.side]: grab.line });
      setGrab(null);
    }
    if (!painting.current) return;
    painting.current = false;
    if (work.current && mask) onChange({ ...mask, data: work.current.data.slice() });
  };

  const brushing = tool === 'brush';
  const resize = !grab ? 'default' : grab.part !== 'mid' ? (grab.dragging ? 'grabbing' : 'grab') : VERTICAL[grab.side] ? 'ew-resize' : 'ns-resize';
  return (
    <div className="desk-corners" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        aria-label={brushing ? 'Предметы на листе: кисть отмечает, где писать нельзя' : 'Поля: линии можно перетащить'}
        style={{ width: box.w, height: box.h, cursor: brushing ? (mask ? 'none' : 'default') : resize }}
        onPointerDown={(e) => {
          const p = pointer(e);
          if (!brushing) {
            const near = nearest(p);
            const l = near && margins[near.side];
            if (!near || !l) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setGrab({ ...near, line: moveTo(near.side, near.part, l, p, e.altKey), dragging: true });
            return;
          }
          if (!mask) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          painting.current = true;
          paint(p);
          setCursor(p);
        }}
        onPointerMove={(e) => {
          const p = pointer(e);
          if (!brushing) {
            if (grab?.dragging) setGrab({ ...grab, line: moveTo(grab.side, grab.part, margins[grab.side] ?? grab.line, p, e.altKey) });
            else {
              const near = nearest(p);
              setGrab(near ? { ...near, line: margins[near.side]!, dragging: false } : null);
            }
            return;
          }
          if (painting.current) paint(p);
          setCursor(p);
        }}
        onPointerUp={finish}
        onDoubleClick={(e) => {
          const near = brushing ? null : nearest(pointer(e));
          const l = near && margins[near.side];
          if (near && l) onMargins({ ...margins, [near.side]: straighten(near.side, l) });
        }}
        onPointerCancel={finish}
        onPointerLeave={() => {
          setCursor(null);
          if (!grab?.dragging) setGrab(null);
        }}
      />
    </div>
  );
}
