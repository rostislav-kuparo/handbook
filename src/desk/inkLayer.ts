// The ink of one document sheet, ready to be written onto a photo: the
// ink-only page export, placed on the photographed paper and rasterised at the
// size the photo needs — plus what the pen did along each stroke.
import { documentPages, type DrawingFit, type PageExport, type PenStroke } from '../editor/exporters';
import { LINE_HEIGHT_EM } from '../editor/layout';
import { A4, geometry, MM, type PageSetup, type SheetSize } from '../editor/page';
import type { Margins, Ruling } from './analysis';
import type { Placement } from './compose';
import { homography, invert, maxStretch, mul, type Mat3, type Pt } from './homography';
import { warpMap, type Warp } from './warp';

/**
 * «Как в документе»: the same lines and sheets as in the editor — on a ruled
 * or squared sheet the letters scaled to the width between its margins and
 * the lines spaced a whole number of its printed lines apart, on plain paper
 * the A4 sheet scaled onto it. «Заполнить лист»: the text re-flowed onto the
 * photographed paper, as much as it holds.
 */
export type FitMode = 'fit' | 'document';

/** How the text sits on the printed lines; null: as fits best. */
export interface LineChoice {
  /** Printed lines (squares or rulings) per line of text. */
  every: number | null;
  /** Letters' size: their line height (1.6 letters) as a share of the line of text. */
  letters: number | null;
  /** On squares, a drawing's unit is a simple number of them, its axes on their lines. */
  squares: boolean;
}

export const AUTO_LINES: LineChoice = { every: null, letters: null, squares: true };

/** The thinnest line of a drawing on paper, px (0.3 mm). */
const MIN_PEN = 0.3 * MM;

/**
 * A notebook's printed lines in paper pixels: rows at y = offset + k·step +
 * x·slope; squares' columns at x = offset + k·step (before the lean); its
 * margin lines.
 */
export interface Lines {
  kind: 'ruled' | 'grid';
  step: number;
  offset: number;
  slope: number;
  cols: { offset: number; step: number } | null;
  margins: Margins;
}

const px = (mm: number | null) => (mm === null ? null : mm * MM);

/** The lines found on a sheet (mm), with these margins (those found, or moved by hand). */
export const linesOf = (r: Ruling, margins: Margins = r.margins): Lines => ({
  kind: r.kind,
  step: r.step * MM,
  offset: r.offset * MM,
  slope: r.slope,
  cols: r.colOffset !== null ? { offset: r.colOffset * MM, step: (r.colStep ?? r.step) * MM } : null,
  margins: marginsPx(margins),
});

/** Margin lines from mm to paper px. */
export const marginsPx = (m: Margins): Margins => ({ left: px(m.left), right: px(m.right), top: px(m.top), bottom: px(m.bottom) });

const hasAny = (m: Margins | null): m is Margins => !!m && (m.left !== null || m.right !== null || m.top !== null || m.bottom !== null);

/** Paper of `mm` (width, height) in CSS px; A4 exactly as the document's sheet. */
export function paperSize([w, h]: [number, number]): SheetSize {
  return isA4([w, h]) ? A4 : { w: w * MM, h: h * MM };
}

export const isA4 = ([w, h]: [number, number]) => Math.abs(w - 210) < 0.5 && Math.abs(h - 297) < 0.5;

export interface InkLayout {
  /** Ink-only SVG of every sheet. */
  pages: string[];
  /** Pen strokes of every sheet (page px). */
  strokes: PenStroke[][];
  /** Size of those sheets (CSS px). */
  size: SheetSize;
  /** The photographed paper (CSS px). */
  paper: SheetSize;
  /** Page pixels → paper pixels (on a sheet without printed lines of its own). */
  place: Mat3;
  /**
   * The lines the text was laid onto, which of them (from the top) carries
   * the first baseline, and how far apart the lines of text are (paper px).
   */
  ref: { lines: Lines; first: number; pitch: number } | null;
  /** Size of the letters, px. */
  fontSize: number;
}

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Where the page goes on a photographed sheet: page px → paper px, on paper of this size (px). */
export interface OnPaper {
  place: Mat3;
  paper: SheetSize;
}

/** The page as it was laid out: on the paper it was laid out for. */
export const asLaid = (layout: InkLayout): OnPaper => ({ place: layout.place, paper: layout.paper });

/**
 * The document's ink for paper of `paperMm`. With `lines` (a ruled or squared
 * sheet, «подогнать под лист»), the text is laid onto them: a line of text per
 * ruled line (two squares), the first baseline on a printed line, between the
 * margin lines.
 */
export async function inkLayout(
  base: PageExport,
  setup: PageSetup,
  paperMm: [number, number],
  mode: FitMode,
  lines: Lines | null = null,
  choice: LineChoice = AUTO_LINES,
  margins: Margins | null = null,
): Promise<InkLayout> {
  const paper = paperSize(paperMm);
  const strokes: PenStroke[][] = [];
  const g = base.geo;
  // Margins drawn by hand on paper without printed lines (px).
  const loose = !lines && hasAny(margins) ? margins : null;
  if (isA4(paperMm) && !lines && !loose) mode = 'document';
  if (mode === 'document' && lines) return asInDocument(base, setup, paper, lines, choice);
  if (mode === 'document') {
    // The A4 sheet as it is, shrunk into the margins or onto the whole paper, centred.
    const box = loose ? textBox(loose, setup, paper) : null;
    const [bx, by, bw, bh] = box ? [box.left, box.top, paper.w - box.left - box.right, paper.h - box.top - box.bottom] : [0, 0, paper.w, paper.h];
    const k = box ? Math.min(bw / g.contentW, bh / g.contentH) : Math.min(paper.w / A4.w, paper.h / A4.h);
    const place = box
      ? [k, 0, bx - g.margin.left * k, 0, k, by - g.margin.top * k, 0, 0, 1]
      : [k, 0, (paper.w - A4.w * k) / 2, 0, k, (paper.h - A4.h * k) / 2, 0, 0, 1];
    const pages = await documentPages(base, { inkOnly: true, strokes, drawings: { keepPages: true, minPen: MIN_PEN / k } });
    return { pages, strokes, size: A4, paper, place, ref: null, fontSize: base.fontSize };
  }
  if (!lines) {
    const box = loose ? textBox(loose, setup, paper) : null;
    const fitted: PageSetup = box ? { ...setup, margins: { top: box.top / MM, bottom: box.bottom / MM, left: box.left / MM, right: box.right / MM } } : setup;
    const geo = geometry(fitted, paper, true);
    const pages = await documentPages({ ...base, geo }, { inkOnly: true, strokes, drawings: { width: g.contentW, minPen: MIN_PEN } });
    return { pages, strokes, size: paper, paper, place: IDENTITY, ref: null, fontSize: base.fontSize };
  }
  // A line of text per ruled line, or per two squares, unless chosen otherwise; letters filling it.
  const pitch = (choice.every ?? (lines.kind === 'grid' ? 2 : 1)) * lines.step;
  const fontSize = ((choice.letters ?? 1) * pitch) / LINE_HEIGHT_EM;
  const lh = fontSize * LINE_HEIGHT_EM;
  // Where the ruled paper of the editor puts the first baseline below the top margin (exporters/Paper).
  const baseline = fontSize * 1.075 + 2;
  const { left, right, top, bottom } = textBox(lines.margins, setup, paper);
  const first = Math.ceil((top + baseline - lines.offset) / lines.step);
  const firstY = lines.offset + first * lines.step;
  const fitted: PageSetup = { ...setup, margins: { top: (firstY - baseline) / MM, bottom: bottom / MM, left: left / MM, right: right / MM } };
  const full = geometry(fitted, paper, true);
  // As many lines on a sheet as `pitch` apart fit (the pages are counted in lines of `lh`).
  const geo = { ...full, contentH: (full.contentH * lh) / pitch };
  // Drawings as big against the letters as in the editor; on squares, by them. The page is the paper here.
  const drawings: DrawingFit = {
    width: (g.contentW * fontSize) / base.fontSize,
    grid: squaresOf(lines, choice, 1, [geo.margin.left, geo.margin.top]),
    minPen: MIN_PEN,
  };
  const pages = await documentPages({ ...base, fontSize, geo }, { inkOnly: true, strokes, pitch, drawings });
  return { pages, strokes, size: paper, paper, place: IDENTITY, ref: { lines, first, pitch }, fontSize };
}

/**
 * The squares for the drawings, in px of the page as drawn (before `k` scales
 * it onto the paper): their size and where two of their lines cross, from the
 * text area's corner at `origin` (paper px).
 */
function squaresOf(lines: Lines, choice: LineChoice, k: number, origin: [number, number]): DrawingFit['grid'] {
  if (!choice.squares || lines.kind !== 'grid' || !lines.cols) return null;
  return { cell: lines.step / k, x: (lines.cols.offset - origin[0]) / k, y: (lines.offset - origin[1]) / k };
}

/**
 * Where the text goes on a sheet with margin lines (paper px): right of one
 * on the left (14 px, as on the editor's paper) and 3 mm before one on the
 * right — the spiral's holes are beyond it; with a margin only on the right,
 * near the left edge; below one at the top, above one at the bottom. Paper px
 * from each edge.
 */
function textBox(m: Margins, setup: PageSetup, paper: SheetSize) {
  return {
    left: m.left !== null ? m.left + 14 : m.right !== null ? 8 * MM : setup.margins.left * MM,
    right: m.right !== null ? paper.w - m.right + 3 * MM : setup.margins.right * MM,
    top: m.top !== null ? m.top + 2 * MM : Math.max(setup.margins.top, 5) * MM,
    bottom: m.bottom !== null ? paper.h - m.bottom + 2 * MM : setup.margins.bottom * MM,
  };
}

/**
 * «Как в документе» on a ruled or squared sheet: the editor's sheets with
 * their own line breaks and page breaks, scaled so a line fills the width
 * between the margins, the lines a whole number of printed lines apart (the
 * nearest to the scaled line height that still lets the editor's sheet fit),
 * each baseline on a printed line.
 */
async function asInDocument(base: PageExport, setup: PageSetup, paper: SheetSize, lines: Lines, choice: LineChoice): Promise<InkLayout> {
  const g = base.geo;
  const lh = base.fontSize * LINE_HEIGHT_EM;
  const box = textBox(lines.margins, setup, paper);
  let k = (paper.w - box.left - box.right) / g.contentW;
  // Lines of the printed ruling per line of text: as near the scaled line as can be, at least one,
  // and few enough for the editor's sheet to fit between the top and bottom margins.
  const room = paper.h - box.top - box.bottom;
  const most = Math.floor((room * lh) / (g.contentH * lines.step) + 1e-6);
  let n = choice.every ?? Math.max(1, Math.round((lh * k) / lines.step));
  if (most >= 1) n = Math.min(n, most);
  const pitch = n * lines.step;
  // Letters no taller than the lines allow (a little over a ruled line, as handwriting goes, or as
  // chosen) — and never wider than the margins: the lines keep the editor's words.
  k = Math.min(k, ((choice.letters ?? 1.15) * pitch) / lh);
  // The editor's sheet with its lines `pitch / k` apart, as tall as that makes it.
  const docPitch = pitch / k;
  const size: SheetSize = { w: g.sheet.w, h: Math.max(g.sheet.h, g.margin.top + (g.contentH * docPitch) / lh + g.margin.bottom) };
  // The first baseline (as on the editor's paper) on the first printed line below the top margin.
  const baseline = base.fontSize * 1.075 + 2;
  const first = Math.ceil((box.top + baseline * k - lines.offset) / lines.step);
  const firstY = lines.offset + first * lines.step;
  const place = [k, 0, box.left - g.margin.left * k, 0, k, firstY - (g.margin.top + baseline) * k, 0, 0, 1];
  // Drawings as in the editor, keeping their room on the sheet; on squares, by them.
  const drawings: DrawingFit = { keepPages: true, grid: squaresOf(lines, choice, k, [box.left, firstY - baseline * k]), minPen: MIN_PEN / k };
  const strokes: PenStroke[][] = [];
  const pages = await documentPages({ ...base, geo: { ...g, sheet: size } }, { inkOnly: true, strokes, pitch: docPitch, drawings });
  return { pages, strokes, size, paper, place, ref: { lines, first, pitch }, fontSize: base.fontSize };
}

/**
 * The page on a sheet with these printed lines, of size `paper` (px): the
 * text laid onto the reference lines follows this sheet's own — its step,
 * the same printed line for the first baseline, its margin line and its
 * lean (after the page's own placing onto the reference sheet). A sheet
 * without lines of the kind takes the page as laid out.
 */
export function placeOn(layout: InkLayout, own: Lines | null, paper: SheetSize): OnPaper {
  const ref = layout.ref;
  if (!ref || !own || own.kind !== ref.lines.kind) return asLaid(layout);
  const r = ref.lines;
  const sy = own.step / r.step;
  const yRef = r.offset + ref.first * r.step;
  const yOwn = own.offset + ref.first * own.step;
  // Along by the margin line both sheets have: the left one, else the right one.
  const [a, b] = [own.margins, r.margins];
  const dx = a.left !== null && b.left !== null ? a.left - b.left : a.right !== null && b.right !== null ? a.right - b.right : 0;
  // x' = x + dx;  y' = yOwn + (y − yRef)·sy + x'·slope
  return { place: mul([1, 0, dx, own.slope, sy, yOwn - yRef * sy + dx * own.slope, 0, 0, 1], layout.place), paper };
}

/** How many times the page is scaled onto the paper (1 when the text is re-flowed onto it). */
export const pageScale = (layout: InkLayout) => layout.place[0];

/**
 * Page pixels → photo pixels. `corners`: the paper's top-left, top-right,
 * bottom-right and bottom-left corner in the photo; `on`: page → paper.
 */
export function pageToPhoto(layout: InkLayout, corners: Pt[], on = asLaid(layout)): Mat3 {
  const { w, h } = on.paper;
  const paperToPhoto = homography([[0, 0], [w, 0], [w, h], [0, h]], corners);
  return mul(paperToPhoto, on.place);
}

/** Inverse of `m`, scaled so that w > 0 inside the photographed paper. */
function towardsSheet(m: Mat3, corners: Pt[]): Mat3 {
  const inv = invert(m);
  const cx = corners.reduce((s, c) => s + c[0], 0) / 4;
  const cy = corners.reduce((s, c) => s + c[1], 0) / 4;
  const sign = Math.sign(inv[6] * cx + inv[7] * cy + inv[8]) || 1;
  return inv.map((v) => v * sign);
}

/** Photo pixels → texture coordinates of the page (0..1 across the page, y down), for the shader. */
export function photoToInk(layout: InkLayout, corners: Pt[], on = asLaid(layout)): Mat3 {
  const { w, h } = layout.size;
  return towardsSheet(mul(pageToPhoto(layout, corners, on), [w, 0, 0, 0, h, 0, 0, 0, 1]), corners);
}

/** Photo pixels → coordinates on the photographed paper (0..1). */
export function photoToPaper(corners: Pt[]): Mat3 {
  return towardsSheet(homography([[0, 0], [1, 0], [1, 1], [0, 1]], corners), corners);
}

/** Mean photo pixels per millimetre of the paper (of size `paper`, px). */
export function pixelsPerMm(paper: SheetSize, corners: Pt[]): number {
  let area = 0;
  for (let k = 0; k < 4; k++) {
    const [a, b] = [corners[k], corners[(k + 1) % 4]];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.sqrt(Math.abs(area) / 2 / ((paper.w / MM) * (paper.h / MM)));
}

/** Cells of the mesh the page is drawn with, per side. */
const MESH = 64;

/**
 * Where the sheet lies in the photo, for the renderer: the page as a mesh of
 * triangles whose corners sit where the (possibly curved) sheet puts them.
 * Each vertex carries the perspective's w, so a flat sheet is drawn exactly.
 */
export function placement(layout: InkLayout, warp: Warp, on = asLaid(layout)): Placement {
  const { place, paper } = on;
  const corners = warp.corners;
  const map = warpMap(warp);
  const h = map.h;
  const n = MESH + 1;
  const mesh = new Float32Array(n * n * 5);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [pu, pv] = [i / MESH, j / MESH];
      // Page uv → paper px → paper uv.
      const x = pu * layout.size.w;
      const y = pv * layout.size.h;
      const u = (place[0] * x + place[1] * y + place[2]) / paper.w;
      const v = (place[3] * x + place[4] * y + place[5]) / paper.h;
      const p = map(u, v);
      const w = Math.max(1e-6, h[6] * u + h[7] * v + h[8]);
      mesh.set([p[0], p[1], w, pu, pv], (j * n + i) * 5);
    }
  }
  const indices = new Uint16Array(MESH * MESH * 6);
  let k = 0;
  for (let j = 0; j < MESH; j++) {
    for (let i = 0; i < MESH; i++) {
      const a = j * n + i;
      indices.set([a, a + 1, a + n, a + 1, a + n + 1, a + n], k);
      k += 6;
    }
  }
  // Fibres show against the paper averaged over ~0.4 mm around.
  const r = 0.4 * pixelsPerMm(paper, corners);
  return {
    mesh,
    indices,
    toPaper: photoToPaper(corners),
    inkSize: [layout.size.w, layout.size.h],
    fibreLod: Math.min(4, Math.max(0.5, Math.log2(Math.max(1, 2 * r)))),
  };
}

/**
 * Pixels per page pixel for the raster: 1.5× the largest stretch of the
 * page in the photo, so even the nearest corner gets its own detail, within
 * what a texture may hold.
 */
export function rasterScale(layout: InkLayout, corners: Pt[], maxSide: number, on = asLaid(layout)): number {
  const need = maxStretch(pageToPhoto(layout, corners, on), layout.size.w, layout.size.h) * 1.5;
  const limit = maxSide / Math.max(layout.size.w, layout.size.h);
  return Math.max(0.5, Math.min(need, limit));
}

const blankCanvas = (size: SheetSize, scale: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(size.w * scale));
  canvas.height = Math.max(1, Math.round(size.h * scale));
  return canvas;
};

/** One sheet's SVG drawn as pixels; the browser renders the vectors afresh at this size. */
export async function rasterize(svg: string, size: SheetSize, scale: number): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = blankCanvas(size, scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * What the pen did under the ink, as pixels of the same raster: red —
 * pressure (0.3..1.5 → 0..1), green and blue — the stroke's direction as
 * (cos 2θ, sin 2θ) (a line has no front or back), alpha — a stroke is here.
 * Drawn a little wider than the ink, so every inked pixel finds its stroke.
 */
export function rasterizePen(strokes: PenStroke[], size: SheetSize, scale: number): HTMLCanvasElement {
  const canvas = blankCanvas(size, scale);
  const ctx = canvas.getContext('2d')!;
  ctx.lineCap = 'round';
  ctx.scale(canvas.width / size.w, canvas.height / size.h);
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (const { pts } of strokes) {
    for (let k = 0; k + 7 < pts.length; k += 4) {
      const [x0, y0, r0, p0, x1, y1, r1, p1] = pts.slice(k, k + 8);
      const th = Math.atan2(y1 - y0, x1 - x0);
      ctx.strokeStyle = `rgb(${byte(((p0 + p1) / 2 - 0.3) / 1.2)},${byte(0.5 + 0.5 * Math.cos(2 * th))},${byte(0.5 + 0.5 * Math.sin(2 * th))})`;
      ctx.lineWidth = (r0 + r1) * 1.4;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }
  return canvas;
}
