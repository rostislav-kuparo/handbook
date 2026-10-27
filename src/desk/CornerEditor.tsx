import { useEffect, useRef, useState } from 'react';
import type { Pt } from './homography';
import type { Photo } from './photo';
import { warpMap, type Grid, type Warp } from './warp';

const HANDLE = 18;
const LOUPE_R = 80;
const PAD = 28;
/** Points per side when a curved side is drawn. */
const SIDE_STEPS = 32;

/** A point to drag: a corner, or a node of the grid of a curved sheet. */
type Handle = { kind: 'corner'; i: number } | { kind: 'node'; i: number };

interface Props {
  photo: Photo;
  /** The paper's top-left, top-right, bottom-right and bottom-left corner, photo pixels. */
  corners: Pt[];
  onChange: (corners: Pt[]) => void;
  /** A curved sheet: its sides' bow and grid (the corners come from `corners`). */
  bend?: Pick<Warp, 'bulge' | 'grid'> | null;
  /** A node of the grid was moved. */
  onGrid?: (grid: Grid) => void;
  /** Sides (top, right, bottom, left) that lie on the sheet's real edge: drawn solid, the rest dashed. */
  snapped?: boolean[];
  /** A dragged corner was let go at `corners`; `free`: Alt was held (no sticking to the edges). */
  onRelease?: (index: number, free: boolean, corners: Pt[]) => void;
  /** A corner was moved by the keyboard. */
  onNudge?: (index: number) => void;
}

/**
 * The photo with the four corners of the sheet to drag — and, on a curved
 * sheet, the nodes of its grid. While a point moves, a loupe shows the real
 * pixels of the full-size photo around it; Shift moves it eight times slower,
 * arrow keys by a quarter of a pixel.
 */
export function CornerEditor({ photo, corners, onChange, bend, onGrid, snapped, onRelease, onNudge }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<ImageBitmap | null>(null);
  const [active, setActive] = useState<Handle>({ kind: 'corner', i: 0 });
  const [loupe, setLoupe] = useState(false);
  const [hover, setHover] = useState(false);
  /** The point being dragged: where it is now, where it and (a node) its offset were at the start. */
  const drag = useRef<{ h: Handle; last: Pt; at: Pt; start: Pt; offset: Pt; moved: boolean } | null>(null);
  const dpr = window.devicePixelRatio || 1;

  // Fit the photo into the box, with room around it for corners outside the frame.
  const s = box.w > 0 ? Math.min((box.w - 2 * PAD) / photo.width, (box.h - 2 * PAD) / photo.height) : 0;
  const ox = (box.w - photo.width * s) / 2;
  const oy = (box.h - photo.height * s) / 2;
  const toScreen = ([x, y]: Pt): Pt => [ox + x * s, oy + y * s];

  const map = warpMap({ corners, bulge: bend?.bulge ?? null, grid: bend?.grid ?? null });
  const grid = bend?.grid ?? null;
  /** Grid nodes that can be dragged (the corners are dragged as corners). */
  const nodes: { i: number; at: Pt }[] = [];
  if (grid) {
    for (let j = 0; j < grid.ny; j++) {
      for (let i = 0; i < grid.nx; i++) {
        const corner = (i === 0 || i === grid.nx - 1) && (j === 0 || j === grid.ny - 1);
        if (!corner) nodes.push({ i: j * grid.nx + i, at: map(i / (grid.nx - 1), j / (grid.ny - 1)) });
      }
    }
  }
  const pointOf = (h: Handle): Pt => (h.kind === 'corner' ? corners[h.i] : (nodes.find((n) => n.i === h.i)?.at ?? corners[0]));
  /** A side as a polyline in photo px (curved when the sheet is). */
  const sidePoints = (k: number): Pt[] =>
    Array.from({ length: SIDE_STEPS + 1 }, (_, i) => {
      const t = i / SIDE_STEPS;
      return k === 0 ? map(t, 0) : k === 1 ? map(1, t) : k === 2 ? map(1 - t, 1) : map(0, 1 - t);
    });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A copy of the photo at screen size, so redrawing while dragging stays smooth.
  useEffect(() => {
    if (s <= 0) return;
    let alive = true;
    void createImageBitmap(photo.bitmap, {
      resizeWidth: Math.max(1, Math.round(photo.width * s * dpr)),
      resizeHeight: Math.max(1, Math.round(photo.height * s * dpr)),
      resizeQuality: 'high',
    }).then((b) => {
      if (alive) setView(b);
      else b.close();
    });
    return () => {
      alive = false;
    };
  }, [photo, s, dpr]);
  useEffect(() => () => view?.close(), [view]);

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

    const sides = [0, 1, 2, 3].map(sidePoints);
    const outline = sides.flatMap((p) => p.slice(0, -1));
    // Dim everything but the sheet.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, box.w, box.h);
    outline.map(toScreen).forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(15, 18, 28, 0.38)';
    ctx.fill('evenodd');
    ctx.restore();

    /** The sides (and the grid of a curved sheet) through `at`, a photo → canvas map. */
    const edges = (c: CanvasRenderingContext2D, at: (p: Pt) => Pt, width: number) => {
      if (grid) {
        c.lineWidth = 0.75 * width;
        c.strokeStyle = 'rgba(255, 255, 255, 0.45)';
        const line = (f: (t: number) => Pt) => {
          c.beginPath();
          for (let i = 0; i <= SIDE_STEPS; i++) {
            const [x, y] = at(f(i / SIDE_STEPS));
            if (i) c.lineTo(x, y);
            else c.moveTo(x, y);
          }
          c.stroke();
        };
        for (let i = 1; i < grid.nx - 1; i++) line((t) => map(i / (grid.nx - 1), t));
        for (let j = 1; j < grid.ny - 1; j++) line((t) => map(t, j / (grid.ny - 1)));
      }
      sides.forEach((pts, k) => {
        c.beginPath();
        pts.map(at).forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
        c.lineWidth = (k === 0 ? 3 : 1.5) * width;
        c.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        c.stroke();
        c.lineWidth = (k === 0 ? 2 : 1) * width;
        c.strokeStyle = k === 0 ? '#ffb020' : '#ffffff';
        // Dashed: the side is only where it was put, not on a found edge.
        c.setLineDash(snapped?.[k] ? [] : [6 * width, 4 * width]);
        c.stroke();
        c.setLineDash([]);
      });
    };
    edges(ctx, toScreen, 1);

    // «верх» over the top edge, upright along it.
    const [t0, t1] = [toScreen(corners[0]), toScreen(corners[1])];
    const mid = toScreen(map(0.5, 0));
    ctx.save();
    ctx.translate(mid[0], mid[1]);
    let ang = Math.atan2(t1[1] - t0[1], t1[0] - t0[0]);
    if (Math.abs(ang) > Math.PI / 2) ang += Math.PI;
    ctx.rotate(ang);
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText('верх листа', 0, -8);
    ctx.fillStyle = '#ffb020';
    ctx.fillText('верх листа', 0, -8);
    ctx.restore();

    const isActive = (h: Handle) => h.kind === active.kind && h.i === active.i;
    for (const n of nodes) {
      const [x, y] = toScreen(n.at);
      const on = isActive({ kind: 'node', i: n.i });
      ctx.beginPath();
      ctx.rect(x - (on ? 5 : 4), y - (on ? 5 : 4), on ? 10 : 8, on ? 10 : 8);
      ctx.fillStyle = on ? '#ffb020' : 'rgba(255,255,255,0.85)';
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.stroke();
    }
    corners.map(toScreen).forEach(([x, y], k) => {
      const on = isActive({ kind: 'corner', i: k });
      ctx.beginPath();
      ctx.arc(x, y, on ? 7 : 6, 0, Math.PI * 2);
      ctx.fillStyle = on ? '#ffb020' : 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.stroke();
    });

    if (loupe) {
      const c = pointOf(active);
      const [sx, sy] = toScreen(c);
      // Screen pixels per photo pixel inside the loupe.
      const z = Math.max(3, 6 * s);
      let lx = sx - LOUPE_R - 24;
      let ly = sy - LOUPE_R - 24;
      if (lx - LOUPE_R < 0) lx = sx + LOUPE_R + 24;
      if (ly - LOUPE_R < 0) ly = sy + LOUPE_R + 24;
      ctx.save();
      ctx.beginPath();
      ctx.arc(lx, ly, LOUPE_R, 0, Math.PI * 2);
      ctx.fillStyle = '#20232b';
      ctx.fill();
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      const half = LOUPE_R / z;
      ctx.drawImage(photo.bitmap, c[0] - half, c[1] - half, 2 * half, 2 * half, lx - LOUPE_R, ly - LOUPE_R, 2 * LOUPE_R, 2 * LOUPE_R);
      // The edges near the point, at the loupe's scale.
      edges(ctx, ([x, y]) => [lx + (x - c[0]) * z, ly + (y - c[1]) * z], 0.7);
      ctx.strokeStyle = '#ffb020';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.moveTo(lx + dx * 5, ly + dy * 5);
        ctx.lineTo(lx + dx * 16, ly + dy * 16);
      }
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(lx, ly, LOUPE_R, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.stroke();
    }
  });

  const pointer = (e: React.PointerEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const nearest = (p: Pt): Handle | null => {
    let best: Handle | null = null;
    let dist = HANDLE;
    const consider = (h: Handle, at: Pt) => {
      const [x, y] = toScreen(at);
      const d = Math.hypot(x - p[0], y - p[1]);
      if (d < dist) [best, dist] = [h, d];
    };
    corners.forEach((c, i) => consider({ kind: 'corner', i }, c));
    nodes.forEach((n) => consider({ kind: 'node', i: n.i }, n.at));
    return best;
  };

  /** Puts a dragged point at `at` (the grid passes through its nodes, so a node moves by its offset). */
  const place = (d: NonNullable<typeof drag.current>) => {
    if (d.h.kind === 'corner') {
      const i = d.h.i;
      onChange(corners.map((c, k) => (k === i ? d.at : c)));
    } else if (grid) {
      const i = d.h.i;
      const off: Pt = [d.offset[0] + d.at[0] - d.start[0], d.offset[1] + d.at[1] - d.start[1]];
      onGrid?.({ ...grid, d: grid.d.map((g, k) => (k === i ? off : g)) });
    }
  };

  /** Moves a point by a photo-px delta (keyboard). */
  const shift = (h: Handle, d: Pt) => {
    if (h.kind === 'corner') {
      onChange(corners.map((c, k) => (k === h.i ? [c[0] + d[0], c[1] + d[1]] : c)));
    } else if (grid) {
      onGrid?.({ ...grid, d: grid.d.map((g, k) => (k === h.i ? [g[0] + d[0], g[1] + d[1]] : g)) });
    }
  };

  return (
    <div className="desk-corners" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label="Уголки листа на фото"
        style={{ width: box.w, height: box.h, cursor: drag.current ? 'grabbing' : hover ? 'grab' : 'default' }}
        onPointerDown={(e) => {
          const p = pointer(e);
          const h = nearest(p);
          if (!h) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus();
          const at = pointOf(h);
          drag.current = { h, last: p, at, start: at, offset: h.kind === 'node' && grid ? grid.d[h.i] : [0, 0], moved: false };
          setActive(h);
          setLoupe(true);
        }}
        onPointerMove={(e) => {
          const p = pointer(e);
          const d = drag.current;
          if (!d) {
            setHover(nearest(p) !== null);
            if (loupe) setLoupe(false);
            return;
          }
          // Relative moves: the point does not jump to the pointer, and Shift slows it down.
          const k = (e.shiftKey ? 1 / 8 : 1) / s;
          const delta: Pt = [(p[0] - d.last[0]) * k, (p[1] - d.last[1]) * k];
          d.at = [d.at[0] + delta[0], d.at[1] + delta[1]];
          d.last = p;
          d.moved = true;
          place(d);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          setLoupe(false);
          // The last move may not be drawn yet: hand over where the corner really is.
          if (d?.moved && d.h.kind === 'corner') {
            const i = d.h.i;
            onRelease?.(i, e.altKey, corners.map((c, k) => (k === i ? d.at : c)));
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
          setLoupe(false);
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 2 : 0.25;
          const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] as Pt | undefined;
          if (e.key === 'Tab' && !e.ctrlKey && active.kind === 'corner') {
            if (e.shiftKey ? active.i === 0 : active.i === 3) return;
            e.preventDefault();
            setActive({ kind: 'corner', i: active.i + (e.shiftKey ? -1 : 1) });
            setLoupe(true);
            return;
          }
          if (!d) return;
          e.preventDefault();
          shift(active, d);
          if (active.kind === 'corner') onNudge?.(active.i);
          setLoupe(true);
        }}
        onBlur={() => setLoupe(false)}
      />
    </div>
  );
}
