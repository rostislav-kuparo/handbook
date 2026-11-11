import { useEffect, useRef, useState } from 'react';
import { bowOfCubic, spline, straightBow, type Bow } from './bow';
import { apply, type Pt } from './homography';
import type { Photo } from './photo';
import { gridAt, warpMap, type Grid, type Warp } from './warp';
import { ZoomPill } from './DeskParts';
import { clampView, FIT, MAX_PIXELS, usePan, useViewInput, type View } from './view';

const HANDLE = 18;
const LOUPE_R = 80;
const PAD = 28;
/** Points per side when a curved side is drawn. */
const SIDE_STEPS = 64;

/**
 * A point to drag: a corner, a node of the grid of a curved sheet, an end of
 * a guide line (line · 2 + end), or a knot of a side's bow (side · 64 + knot).
 */
type Handle = { kind: 'corner'; i: number } | { kind: 'node'; i: number } | { kind: 'guide'; i: number } | { kind: 'knot'; i: number };

/** The knots a side starts with when it is bent by hand. */
const FIRST_KNOTS = [0, 0.25, 0.5, 0.75, 1];
/** Two knots no closer than this share of the side. */
const KNOT_GAP = 0.03;
/** The grid nodes shown: as many as on a 5×7 grid (a finer one follows them smoothly). */
const SHOWN = [5, 7];

/** Colours of the two directions of lines: across the sheet, down it. */
const LINE_COLORS = ['#ff6b9a', '#3fd4ff'];

/** The photo's frame grown to hold the corners outside it (by at most half the photo each way): x0, y0, x1, y1. */
function reachOf(photo: Photo, corners: Pt[]): [number, number, number, number] {
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const [mx, my] = [photo.width / 2, photo.height / 2];
  return [
    Math.max(-mx, Math.min(0, ...xs)),
    Math.max(-my, Math.min(0, ...ys)),
    Math.min(photo.width + mx, Math.max(photo.width, ...xs)),
    Math.min(photo.height + my, Math.max(photo.height, ...ys)),
  ];
}

interface Props {
  photo: Photo;
  /** The paper's top-left, top-right, bottom-right and bottom-left corner, photo pixels. */
  corners: Pt[];
  onChange: (corners: Pt[]) => void;
  /** A curved sheet: its sides' bow and grid (the corners come from `corners`). */
  bend?: Pick<Warp, 'bulge' | 'bows' | 'grid'> | null;
  /** A node of the grid was moved. */
  onGrid?: (grid: Grid) => void;
  /** Sides (top, right, bottom, left) that lie on the sheet's real edge: drawn solid, the rest dashed. */
  snapped?: boolean[];
  /** A dragged corner was let go at `corners`; `free`: Alt was held (no sticking to the edges). */
  onRelease?: (index: number, free: boolean, corners: Pt[]) => void;
  /** A corner was moved by the keyboard. */
  onNudge?: (index: number) => void;
  /** Straight lines found on the photo, shown over it: [ax, ay, bx, by, direction]. */
  found?: number[][] | null;
  /** Lines put along the sheet by hand ([ax, ay, bx, by]; two across it, two down it): only their ends are dragged then. */
  guides?: number[][] | null;
  /** The guides moved; `done`: a drag or a key press ended. */
  onGuides?: (guides: number[][], done: boolean) => void;
  /**
   * The sides' bows changed (a knot moved, added or taken away); `done`: a
   * knot was let go there — `free` with Alt (no sticking to the edge).
   */
  onBows?: (bows: Bow[], done: { side: number; knot: number; free: boolean } | null) => void;
  /** How the photo is looked at (zoomed, moved). */
  view?: View;
  onView?: (view: View) => void;
}

/**
 * The photo with the four corners of the sheet to drag — and, on a curved
 * sheet, the nodes of its grid. While a point moves, a loupe shows the real
 * pixels of the full-size photo around it; Shift moves it eight times slower,
 * arrow keys by a quarter of a pixel.
 */
export function CornerEditor({ photo, corners, onChange, bend, onGrid, snapped, onRelease, onNudge, found, guides, onGuides, onBows, view: zoom = FIT, onView = () => {} }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [small, setSmall] = useState<ImageBitmap | null>(null);
  const [active, setActive] = useState<Handle>({ kind: 'corner', i: 0 });
  const [loupe, setLoupe] = useState(false);
  const [hover, setHover] = useState(false);
  /** The point being dragged: where it is now, where it and (a node) its offset were at the start. */
  const drag = useRef<{ h: Handle; last: Pt; at: Pt; start: Pt; grid0: Pt[] | null; moved: boolean } | null>(null);
  const dpr = window.devicePixelRatio || 1;
  // The keys move what can be dragged: the guides' ends while they are shown.
  const guiding = !!guides;
  useEffect(() => setActive(guiding ? { kind: 'guide', i: 0 } : { kind: 'corner', i: 0 }), [guiding]);

  // What the view holds: the photo and the corners outside its frame (a sheet bigger than the frame), kept still while a point is dragged.
  const [reach, setReach] = useState(() => reachOf(photo, corners));
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    if (!drag.current) setReach(reachOf(photo, corners));
  }, [photo, corners, settled]);
  const [x0, y0, x1, y1] = reach;
  // Fit it into the box, with room around it for the handles; then as zoomed and moved.
  const fit = box.w > 0 ? Math.min((box.w - 2 * PAD) / (x1 - x0), (box.h - 2 * PAD) / (y1 - y0)) : 0;
  const maxZ = fit > 0 ? MAX_PIXELS / (dpr * fit) : 1;
  const v = clampView(zoom, box.w, box.h, maxZ);
  const s = fit * v.z;
  const ox = ((box.w - (x1 - x0) * fit) / 2 - x0 * fit) * v.z + v.x;
  const oy = ((box.h - (y1 - y0) * fit) / 2 - y0 * fit) * v.z + v.y;
  const space = useViewInput(wrapRef, box.w, box.h, v, onView, maxZ);
  const pan = usePan(v, onView, box.w, box.h, maxZ);
  const toScreen = ([x, y]: Pt): Pt => [ox + x * s, oy + y * s];

  const map = warpMap({ corners, bulge: bend?.bulge ?? null, bows: bend?.bows ?? null, grid: bend?.grid ?? null });
  const grid = bend?.grid ?? null;
  /** Grid nodes that can be dragged (the corners are dragged as corners); of a fine grid, those of a 5×7 one. */
  const nodes: { i: number; at: Pt }[] = [];
  const every = grid ? [Math.max(1, Math.round((grid.nx - 1) / (SHOWN[0] - 1))), Math.max(1, Math.round((grid.ny - 1) / (SHOWN[1] - 1)))] : [1, 1];
  if (grid) {
    for (let j = 0; j < grid.ny; j += every[1]) {
      for (let i = 0; i < grid.nx; i += every[0]) {
        const corner = (i === 0 || i === grid.nx - 1) && (j === 0 || j === grid.ny - 1);
        if (!corner) nodes.push({ i: j * grid.nx + i, at: map(i / (grid.nx - 1), j / (grid.ny - 1)) });
      }
    }
  }
  /** The grid with node `i` moved by `by` from `from`: on a fine grid its neighbours follow, less the further they are. */
  const gridMoved = (from: Pt[], i: number, by: Pt): Grid => {
    const g = grid!;
    const [ci, cj] = [i % g.nx, Math.floor(i / g.nx)];
    const fine = every[0] > 1 || every[1] > 1;
    return {
      ...g,
      d: from.map((o, k) => {
        const [di, dj] = [((k % g.nx) - ci) / every[0], (Math.floor(k / g.nx) - cj) / every[1]];
        const w = fine ? Math.exp(-1.25 * (di * di + dj * dj)) : k === i ? 1 : 0;
        return [o[0] + by[0] * w, o[1] + by[1] * w];
      }),
    };
  };

  // The sides' bows: as the sheet bends, or straight with a few knots to bend it by.
  const bows: Bow[] = (bend?.bows ?? bend?.bulge?.map(bowOfCubic) ?? [0, 1, 2, 3].map(straightBow)).map((b) => (b.t.length > 2 ? b : { t: FIRST_KNOTS, d: FIRST_KNOTS.map(() => 0) }));
  const chord = (k: number) => {
    const [a, b] = [corners[k], corners[(k + 1) % 4]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
    const d: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    return { a, b, len, d, n: [d[1], -d[0]] as Pt };
  };
  /** Side k at s (0..1 from its corner k) as a point of the sheet. */
  const uvOf = (k: number, s: number): Pt => (k === 0 ? [s, 0] : k === 1 ? [1, s] : k === 2 ? [1 - s, 1] : [0, 1 - s]);
  /** How far along side k's chord a photo point lies (0..1). */
  const tOf = (k: number, p: Pt) => {
    const c = chord(k);
    return ((p[0] - c.a[0]) * c.d[0] + (p[1] - c.a[1]) * c.d[1]) / c.len;
  };
  /** The point of the sheet on side k level with the fraction t of its chord (as the bow is laid out). */
  const uvAt = (k: number, t: number): Pt => {
    let [lo, hi] = [0, 1];
    for (let n = 0; n < 30; n++) {
      const mid = (lo + hi) / 2;
      if (tOf(k, apply(map.h, uvOf(k, mid))) < t) lo = mid;
      else hi = mid;
    }
    return uvOf(k, (lo + hi) / 2);
  };
  /** The knots between the corners, where they are on the photo. */
  const knots: { i: number; at: Pt }[] = bows.flatMap((b, k) => b.t.slice(1, -1).map((t, j) => ({ i: k * 64 + j + 1, at: map(...uvAt(k, t)) })));
  /** The bows with knot `i` moved to photo point p (across the side only; it keeps its place along it). */
  const bowsWith = (i: number, p: Pt): Bow[] => {
    const [k, j] = [i >> 6, i & 63];
    const c = chord(k);
    const t = bows[k].t[j];
    const g = grid ? gridAt(grid, ...uvAt(k, t)) : [0, 0];
    const off = (p[0] - c.a[0] - c.d[0] * c.len * t - g[0]) * c.n[0] + (p[1] - c.a[1] - c.d[1] * c.len * t - g[1]) * c.n[1];
    return bows.map((b, m) => (m === k ? { t: b.t, d: b.d.map((v, n) => (n === j ? off : v)) } : b));
  };
  /** A knot more on the side nearest screen point p (where the side already runs: its shape stays), or null. */
  const withKnot = (p: Pt): Bow[] | null => {
    let best: { k: number; at: Pt; dist: number } | null = null;
    for (let k = 0; k < 4; k++) {
      const pts = sidePoints(k);
      for (let i = 0; i < pts.length - 1; i++) {
        const [a, b] = [toScreen(pts[i]), toScreen(pts[i + 1])];
        const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
        const f = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        const q: Pt = [a[0] + dx * f, a[1] + dy * f];
        const dist = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (dist < HANDLE && (!best || dist < best.dist)) best = { k, at: [(q[0] - ox) / s, (q[1] - oy) / s], dist };
      }
    }
    if (!best) return null;
    const { k } = best;
    const t = tOf(k, best.at);
    const b = bows[k];
    if (t <= KNOT_GAP || t >= 1 - KNOT_GAP || b.t.some((x) => Math.abs(x - t) < KNOT_GAP)) return null;
    const at = b.t.findIndex((x) => x > t);
    const v = spline(b)(t);
    return bows.map((w, m) => (m === k ? { t: [...w.t.slice(0, at), t, ...w.t.slice(at)], d: [...w.d.slice(0, at), v, ...w.d.slice(at)] } : w));
  };
  /** The bows without knot `i`. */
  const withoutKnot = (i: number): Bow[] => {
    const [k, j] = [i >> 6, i & 63];
    return bows.map((b, m) => (m === k ? { t: b.t.filter((_, n) => n !== j), d: b.d.filter((_, n) => n !== j) } : b));
  };
  const endOf = (i: number): Pt => {
    const l = guides?.[i >> 1] ?? [0, 0, 0, 0];
    return i & 1 ? [l[2], l[3]] : [l[0], l[1]];
  };
  const pointOf = (h: Handle): Pt =>
    h.kind === 'corner'
      ? corners[h.i]
      : h.kind === 'guide'
        ? endOf(h.i)
        : ((h.kind === 'knot' ? knots : nodes).find((n) => n.i === h.i)?.at ?? corners[0]);
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

  // A copy of the photo at the fitted size, so redrawing while dragging stays smooth (zoomed in, the photo itself).
  useEffect(() => {
    if (fit <= 0) return;
    let alive = true;
    void createImageBitmap(photo.bitmap, {
      resizeWidth: Math.max(1, Math.round(photo.width * fit * dpr)),
      resizeHeight: Math.max(1, Math.round(photo.height * fit * dpr)),
      resizeQuality: 'high',
    }).then((b) => {
      if (alive) setSmall(b);
      else b.close();
    });
    return () => {
      alive = false;
    };
  }, [photo, fit, dpr]);
  useEffect(() => () => small?.close(), [small]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || s <= 0) return;
    const [cw, ch] = [Math.round(box.w * dpr), Math.round(box.h * dpr)];
    if (canvas.width !== cw || canvas.height !== ch) [canvas.width, canvas.height] = [cw, ch];
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);
    ctx.imageSmoothingQuality = 'high';
    // Close up, the photo's own pixels.
    ctx.imageSmoothingEnabled = s * dpr < 2.5;
    ctx.drawImage(v.z > 1.05 || !small ? photo.bitmap : small, ox, oy, photo.width * s, photo.height * s);
    ctx.imageSmoothingEnabled = true;

    const sides = [0, 1, 2, 3].map(sidePoints);
    const outline = sides.flatMap((p) => p.slice(0, -1));
    // Dim the photo but the sheet.
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, photo.width * s, photo.height * s);
    ctx.clip();
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
        for (let i = every[0]; i < grid.nx - 1; i += every[0]) line((t) => map(i / (grid.nx - 1), t));
        for (let j = every[1]; j < grid.ny - 1; j += every[1]) line((t) => map(t, j / (grid.ny - 1)));
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
    /** The guide lines through `at`: each run on dashed across the view (where a pair meets is where it converges), its ends to drag. */
    const guideLines = (c: CanvasRenderingContext2D, at: (p: Pt) => Pt, width: number) => {
      guides?.forEach((l, k) => {
        const [a, b] = [at([l[0], l[1]]), at([l[2], l[3]])];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const [dx, dy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        const far = 4 * Math.max(box.w, box.h);
        c.strokeStyle = LINE_COLORS[k >> 1];
        c.globalAlpha = 0.55;
        c.lineWidth = width;
        c.setLineDash([5 * width, 5 * width]);
        c.beginPath();
        c.moveTo(a[0] - dx * far, a[1] - dy * far);
        c.lineTo(b[0] + dx * far, b[1] + dy * far);
        c.stroke();
        c.setLineDash([]);
        c.globalAlpha = 1;
        c.beginPath();
        c.moveTo(a[0], a[1]);
        c.lineTo(b[0], b[1]);
        c.lineWidth = 3.5 * width;
        c.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        c.stroke();
        c.lineWidth = 2 * width;
        c.strokeStyle = LINE_COLORS[k >> 1];
        c.stroke();
      });
    };
    if (found && !guides) {
      ctx.lineCap = 'round';
      for (const l of found) {
        const [a, b] = [toScreen([l[0], l[1]]), toScreen([l[2], l[3]])];
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = LINE_COLORS[l[4] ? 1 : 0];
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }
    edges(ctx, toScreen, 1);
    guideLines(ctx, toScreen, 1);

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

    if (!guides) {
      for (const n of knots) {
        const [x, y] = toScreen(n.at);
        const on = isActive({ kind: 'knot', i: n.i });
        const r = on ? 6.5 : 5;
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
        ctx.fillStyle = on ? '#ffb020' : 'rgba(255, 255, 255, 0.9)';
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.stroke();
      }
    }

    guides?.forEach((_, k) =>
      [0, 1].forEach((e) => {
        const [x, y] = toScreen(endOf(2 * k + e));
        const on = isActive({ kind: 'guide', i: 2 * k + e });
        ctx.beginPath();
        ctx.rect(x - (on ? 6 : 5), y - (on ? 6 : 5), on ? 12 : 10, on ? 12 : 10);
        ctx.fillStyle = on ? '#ffffff' : LINE_COLORS[k >> 1];
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.stroke();
      }),
    );

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
      guideLines(ctx, ([x, y]) => [lx + (x - c[0]) * z, ly + (y - c[1]) * z], 0.6);
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
    if (guides) {
      guides.forEach((_, k) => [0, 1].forEach((e) => consider({ kind: 'guide', i: 2 * k + e }, endOf(2 * k + e))));
      return best;
    }
    corners.forEach((c, i) => consider({ kind: 'corner', i }, c));
    knots.forEach((n) => consider({ kind: 'knot', i: n.i }, n.at));
    nodes.forEach((n) => consider({ kind: 'node', i: n.i }, n.at));
    return best;
  };

  /** The guides with an end moved to `at`. */
  const guidesWith = (i: number, at: Pt) => (guides ?? []).map((l, k) => (k === i >> 1 ? (i & 1 ? [l[0], l[1], ...at] : [...at, l[2], l[3]]) : l));

  /** Puts a dragged point at `at` (the grid passes through its nodes, so a node moves by its offset). */
  const place = (d: NonNullable<typeof drag.current>) => {
    if (d.h.kind === 'guide') {
      onGuides?.(guidesWith(d.h.i, d.at), false);
    } else if (d.h.kind === 'corner') {
      const i = d.h.i;
      onChange(corners.map((c, k) => (k === i ? d.at : c)));
    } else if (d.h.kind === 'knot') {
      onBows?.(bowsWith(d.h.i, d.at), null);
    } else if (grid && d.grid0) {
      onGrid?.(gridMoved(d.grid0, d.h.i, [d.at[0] - d.start[0], d.at[1] - d.start[1]]));
    }
  };

  /** Moves a point by a photo-px delta (keyboard). */
  const shift = (h: Handle, d: Pt) => {
    if (h.kind === 'guide') {
      const at = endOf(h.i);
      onGuides?.(guidesWith(h.i, [at[0] + d[0], at[1] + d[1]]), true);
    } else if (h.kind === 'corner') {
      onChange(corners.map((c, k) => (k === h.i ? [c[0] + d[0], c[1] + d[1]] : c)));
    } else if (h.kind === 'knot') {
      const at = pointOf(h);
      onBows?.(bowsWith(h.i, [at[0] + d[0], at[1] + d[1]]), null);
    } else if (grid) {
      onGrid?.(gridMoved(grid.d, h.i, d));
    }
  };

  return (
    <div className="desk-corners" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label="Уголки листа на фото"
        style={{ width: box.w, height: box.h, cursor: drag.current || pan.active ? 'grabbing' : hover ? 'grab' : v.z > 1 ? 'move' : 'default' }}
        onPointerDown={(e) => {
          const p = pointer(e);
          const h = e.button === 0 && !space.current ? nearest(p) : null;
          // The middle button, Space or an empty place: the picture moves.
          if (!h) {
            if (e.button === 1 || space.current || v.z > 1) pan.start(e);
            if (e.button === 1) e.preventDefault();
            return;
          }
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus();
          const at = pointOf(h);
          drag.current = { h, last: p, at, start: at, grid0: grid ? grid.d.map((g) => [...g] as Pt) : null, moved: false };
          setActive(h);
          setLoupe(true);
        }}
        onPointerMove={(e) => {
          if (pan.move(e)) return;
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
          if (pan.end()) return;
          const d = drag.current;
          drag.current = null;
          setLoupe(false);
          setSettled((n) => n + 1);
          // The last move may not be drawn yet: hand over where the point really is.
          if (d?.moved && d.h.kind === 'guide') onGuides?.(guidesWith(d.h.i, d.at), true);
          if (d?.h.kind === 'knot') {
            const i = d.h.i;
            // Alt + a click: the knot goes; let go after a move: it may stick to the edge.
            if (!d.moved && e.altKey) onBows?.(withoutKnot(i), null);
            else if (d.moved) onBows?.(bowsWith(i, d.at), { side: i >> 6, knot: i & 63, free: e.altKey });
          }
          if (d?.moved && d.h.kind === 'corner') {
            const i = d.h.i;
            onRelease?.(i, e.altKey, corners.map((c, k) => (k === i ? d.at : c)));
          }
        }}
        onPointerCancel={() => {
          pan.end();
          drag.current = null;
          setLoupe(false);
          setSettled((n) => n + 1);
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
        onDoubleClick={(e) => {
          if (guides) return;
          const r = canvasRef.current!.getBoundingClientRect();
          const p: Pt = [e.clientX - r.left, e.clientY - r.top];
          const h = nearest(p);
          if (h?.kind === 'knot' || h?.kind === 'corner') return;
          const next = withKnot(p);
          if (next) onBows?.(next, null);
        }}
      />
      {v.z > 1 && <ZoomPill percent={s * dpr * 100} onReset={() => onView(FIT)} />}
    </div>
  );
}
