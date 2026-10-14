// A4 sheet geometry in CSS pixels (1 CSS px = 1/96 in, so this prints at true size).
export const MM = 96 / 25.4;

export const SHEET_W = Math.round(210 * MM); // 794
export const SHEET_H = Math.round(297 * MM); // 1123
export const SHEET_GAP = 28;
export const PITCH = SHEET_H + SHEET_GAP;

export type PaperStyle = 'ruled' | 'grid' | 'plain';

/** Page setup of a document: margins in millimetres, paper look, pen colour. */
export interface PageSetup {
  margins: { top: number; bottom: number; left: number; right: number };
  paper: PaperStyle;
  ink: string;
  /** Show the document title at the top of the first sheet. */
  showTitle: boolean;
}

export const DEFAULT_PAGE: PageSetup = {
  margins: { top: 20, bottom: 20, left: 25, right: 15 },
  paper: 'ruled',
  ink: '#1f2a6b',
  showTitle: true,
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
  };
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
