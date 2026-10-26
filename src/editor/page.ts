// A4 sheet geometry in CSS pixels (1 CSS px = 1/96 in, so this prints at true size).
export const MM = 96 / 25.4;

export const SHEET_W = Math.round(210 * MM); // 794
export const SHEET_H = Math.round(297 * MM); // 1123
export const SHEET_GAP = 28;
export const PITCH = SHEET_H + SHEET_GAP;

export type PaperStyle = 'ruled' | 'grid' | 'plain';

/**
 * What the drawings («Чертёж») are drawn with: a pen or a pencil, in a colour
 * (null: the text's ink for a pen, graphite for a pencil).
 */
export interface DrawPen {
  tool: 'pen' | 'pencil';
  color: string | null;
  /** Labels in the text's pen even when the lines are in pencil. */
  labelsInPen: boolean;
  /** How crooked the lines are: 0 — as with a ruler, 1 — a steady hand, up to 2.5. */
  wobble: number;
  /** Line thickness factor (1 — the handwriting's pen). */
  weight: number;
  /** How much the thickness breathes along a line: 0 — even, 1 — as the pen, up to 2. */
  pressure: number;
  /** How far lines run past their ends: 0 — exactly to the point, 1 — a little, up to 2. */
  overshoot: number;
}

export const DEFAULT_DRAW_PEN: DrawPen = { tool: 'pen', color: null, labelsInPen: false, wobble: 1, weight: 1, pressure: 1, overshoot: 1 };

/** Limits of the drawing pen's sliders. */
export const DRAW_PEN_RANGES = { wobble: [0, 2.5], weight: [0.4, 2.5], pressure: [0, 2], overshoot: [0, 2] } as const;

/** A drawing's own pen over the document's: what the drawing does not set comes from `base`. */
export function drawPenOf(base: DrawPen, own: unknown): DrawPen {
  const o = (own && typeof own === 'object' ? own : {}) as Partial<DrawPen>;
  const num = (k: keyof typeof DRAW_PEN_RANGES) => {
    const v = o[k];
    const [lo, hi] = DRAW_PEN_RANGES[k];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : base[k];
  };
  return {
    tool: o.tool === 'pen' || o.tool === 'pencil' ? o.tool : base.tool,
    color: 'color' in o && (o.color === null || typeof o.color === 'string') ? o.color : base.color,
    labelsInPen: typeof o.labelsInPen === 'boolean' ? o.labelsInPen : base.labelsInPen,
    wobble: num('wobble'),
    weight: num('weight'),
    pressure: num('pressure'),
    overshoot: num('overshoot'),
  };
}

/** Page setup of a document: margins in millimetres, paper look, pen colour, numbering, drawing pen. */
export interface PageSetup {
  margins: { top: number; bottom: number; left: number; right: number };
  paper: PaperStyle;
  ink: string;
  /** Show the document title at the top of the first sheet. */
  showTitle: boolean;
  /** Number the sheets at the bottom. */
  pageNumbers: boolean;
  /** Number of the first sheet (a continuation of another notebook starts at 7). */
  firstNumber: number;
  /** What the document's drawings are drawn with (each drawing may choose its own). */
  drawPen: DrawPen;
}

export const DEFAULT_PAGE: PageSetup = {
  margins: { top: 20, bottom: 20, left: 25, right: 15 },
  paper: 'ruled',
  ink: '#1f2a6b',
  showTitle: true,
  pageNumbers: true,
  firstNumber: 1,
  drawPen: DEFAULT_DRAW_PEN,
};

export const MARGIN_PRESETS: { name: string; margins: PageSetup['margins'] }[] = [
  { name: 'Обычные', margins: { top: 20, bottom: 20, left: 25, right: 15 } },
  { name: 'Узкие', margins: { top: 12, bottom: 12, left: 12, right: 12 } },
  { name: 'Широкие', margins: { top: 25, bottom: 25, left: 35, right: 25 } },
];

/** Pen colours; any other colour can be picked too. */
export const INK_COLORS: { name: string; color: string }[] = [
  { name: 'Тёмно-синяя', color: '#1f2a6b' },
  { name: 'Чёрная', color: '#1b1c20' },
  { name: 'Тёмно-фиолетовая', color: '#4b2a7b' },
];

export function pageSetup(raw: Partial<PageSetup> | undefined): PageSetup {
  return {
    margins: { ...DEFAULT_PAGE.margins, ...(raw?.margins ?? {}) },
    paper: raw?.paper ?? DEFAULT_PAGE.paper,
    ink: raw?.ink ?? DEFAULT_PAGE.ink,
    showTitle: raw?.showTitle ?? DEFAULT_PAGE.showTitle,
    pageNumbers: raw?.pageNumbers ?? DEFAULT_PAGE.pageNumbers,
    firstNumber: Math.round(Math.min(Math.max(Number(raw?.firstNumber ?? DEFAULT_PAGE.firstNumber) || 0, 0), 9999)),
    drawPen: drawPenOf(DEFAULT_DRAW_PEN, raw?.drawPen),
  };
}

/** Number printed on sheet `index` (from 0), or null when the sheets are not numbered. */
export function sheetNumber(setup: Pick<PageSetup, 'pageNumbers' | 'firstNumber'>, index: number): number | null {
  return setup.pageNumbers ? setup.firstNumber + index : null;
}

/** Sheet geometry for a page setup, in stack pixels. */
export interface Geometry {
  margin: { top: number; bottom: number; left: number; right: number };
  contentW: number;
  contentH: number;
  /** Top of the writable area of page `p`. */
  contentTop: (p: number) => number;
  /** Bottom of the writable area of page `p`. */
  contentBottom: (p: number) => number;
}

export function geometry(setup: PageSetup): Geometry {
  const px = (mm: number) => Math.round(Math.min(Math.max(mm, 5), 60) * MM);
  const margin = {
    top: px(setup.margins.top),
    bottom: px(setup.margins.bottom),
    left: px(setup.margins.left),
    right: px(setup.margins.right),
  };
  return {
    margin,
    contentW: SHEET_W - margin.left - margin.right,
    contentH: SHEET_H - margin.top - margin.bottom,
    contentTop: (p) => p * PITCH + margin.top,
    contentBottom: (p) => p * PITCH + SHEET_H - margin.bottom,
  };
}

/** Height of a paper stack with `pages` sheets. */
export function stackHeight(pages: number): number {
  return pages * PITCH - SHEET_GAP;
}
