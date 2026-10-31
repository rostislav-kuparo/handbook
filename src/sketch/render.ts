// A drawing from its text: the same picture in the editor, the rendered
// view and the exported sheets.
import type { DrawPen } from '../editor/page';
import type { Deal } from '../engine/client';
import { isRomanChar, romanSvg } from '../blank/roman';
import { FALLBACK_FONTS } from '../engine/constants';
import { getHandwriting } from '../engine/handwriting';
import type { Style } from '../model/types';
import { compileSketch } from './evaluate';
import { formulaOf, layoutFormula } from './formula';
import { labelInk, type LabelInk } from './labels';
import { blankBoxOf, layoutSketch, placeLabels, sketchHeight, sketchScale, type Around, type InkPath, type PlacedLabel, type SketchLayout } from './layout';
import type { Pen } from './pen';

export interface Drawing {
  width: number;
  height: number;
  paths: InkPath[];
  labels: PlacedLabel[];
  empty: boolean;
}

/** Colour of a pencil line when the drawing does not choose one. */
export const GRAPHITE = '#4d4f56';

/**
 * The handwriting's own pen, at this letter size, as the drawing asks for it:
 * a pencil draws a thinner, shakier line whose weight breathes more; the
 * drawing's sliders scale the thickness, the shaking, the breathing and how
 * far lines run past their ends.
 */
export function penFor(style: Style, fontSize: number, draw?: Partial<DrawPen>): Pen {
  const base = Math.max(0.8, (style.weight * fontSize) / 1000);
  const pencil = draw?.tool === 'pencil';
  const width = (pencil ? Math.max(0.7, base * 0.72) : base) * (draw?.weight ?? 1);
  const pressure = (pencil ? Math.min(1, style.pressure + 0.3) : style.pressure) * (draw?.pressure ?? 1);
  const jitter = pencil ? Math.min(1, style.jitter * 1.2 + 0.15) : style.jitter;
  return {
    width: Math.max(0.4, width),
    pressure: Math.min(pressure, 1.6),
    jitter,
    wobble: draw?.wobble ?? 1,
    overshoot: draw?.overshoot ?? 1,
    points: draw?.points ?? 1,
    joins: draw?.joins ?? 1,
    // Away from a blank only a pencil drawing is drawn with compasses.
    compass: (draw?.compass ?? true) && pencil,
  };
}

/**
 * Graphite: the line's ink keeps only where the paper's grain lets it, so it
 * looks rubbed onto the paper rather than laid down with ink. The same id in
 * every drawing is fine — the definitions are identical.
 */
const PENCIL_DEFS =
  '<defs><filter id="hb-pencil" x="-2%" y="-2%" width="104%" height="104%" color-interpolation-filters="sRGB">' +
  '<feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves="2" seed="7" result="grain"/>' +
  '<feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.4 2.05" result="paper"/>' +
  '<feComposite in="SourceGraphic" in2="paper" operator="in"/>' +
  '</filter></defs>';

const layouts = new Map<string, SketchLayout>();

/** Lines and label places of a drawing `width` px wide (cached). */
export function sketchLayout(code: string, width: number, fontSize: number, pen: Pen): SketchLayout {
  const key = `${width}|${fontSize}|${pen.width}|${pen.pressure}|${pen.jitter}|${pen.wobble ?? 1}|${pen.overshoot ?? 1}|${pen.points ?? 1}|${pen.joins ?? 1}|${pen.compass ? 1 : 0}|${code}`;
  const hit = layouts.get(key);
  if (hit) return hit;
  const tex = formulaOf(code);
  const layout = tex !== null ? layoutFormula(tex, width, fontSize, pen) : layoutSketch(compileSketch(code), width, fontSize, pen);
  layouts.set(key, layout);
  if (layouts.size > 30) layouts.delete(layouts.keys().next().value!);
  return layout;
}

/** Height in px at this width: known before anything is drawn, so pages can be laid out. */
export function heightOf(code: string, width: number, fontSize: number): number {
  const tex = formulaOf(code);
  if (tex !== null) return layoutFormula(tex, width, fontSize, { width: 1, pressure: 0.5, jitter: 0.3 }).height;
  return sketchHeight(compileSketch(code), width, fontSize);
}

/** Where a drawing `width` px wide puts its origin, and px per unit along x and y. */
export function scaleOf(code: string, width: number, fontSize: number) {
  // A formula has no units to lay onto squares.
  if (formulaOf(code) !== null) return { height: heightOf(code, width, fontSize), plotW: width, ox: 0, oy: 0, ppx: 0, ppy: 0 };
  return sketchScale(compileSketch(code), width, fontSize);
}

/**
 * Where a drawing on a blank (НаБланке) lies on the sheet: its box, sheet px,
 * and the origin's place; null for any other drawing (and a formula).
 */
export function blankBox(code: string) {
  return formulaOf(code) !== null ? null : blankBoxOf(compileSketch(code));
}

/** Mistakes in a drawing's code (none in a formula: it is written as it can be). */
export const sketchErrors = (code: string) => (formulaOf(code) !== null ? [] : compileSketch(code).errors);

/** Lines only: shown at once while the labels are being written. */
export function linesOnly(layout: SketchLayout): Drawing {
  return { width: layout.width, height: layout.height, paths: layout.paths, labels: [], empty: layout.empty };
}

/**
 * A drawing's labels written one after another: each goes on with the
 * variants the text and labels before it left unused (`deal`), so a letter
 * repeated in and around a formula (M₄₁ … M₄₁ = |…|) is never the same twice
 * running. Returns the labels and the deal the text after the drawing goes on with.
 */
async function writeLabels(layout: SketchLayout, deal: Deal): Promise<{ inks: LabelInk[]; deal: Deal }> {
  const inks: LabelInk[] = [];
  for (const l of layout.labels) {
    const ink = await labelInk(l.runs, l.seed, deal);
    deal = ink.deal;
    inks.push(ink);
  }
  return { inks, deal };
}

/** The whole drawing, labels written by the handwriting engine, going on from `deal`. */
export async function drawSketch(layout: SketchLayout, deal: Deal = {}, around?: Around): Promise<Drawing> {
  const { inks } = await writeLabels(layout, deal);
  return { ...linesOnly(layout), labels: placeLabels(layout, inks, around) };
}

type SheetBox = { x: number; y: number; w: number; h: number };

/** The map of a blank's sheet as a drawing on it reads it (see `Occupancy`). */
export interface SheetMap {
  version: number;
  count(box: SheetBox, self?: string): number;
  covered(box: SheetBox, self?: string): number;
}

/**
 * For a drawing on a blank: what lies under a box of it (its own px) on the
 * sheet, from the sheet's map — its own lines and labels not counted.
 */
export function aroundOnSheet(code: string, map: SheetMap | null | undefined): Around | undefined {
  const box = map ? blankBox(code) : null;
  if (!box || !map) return undefined;
  const onSheet = (b: { x0: number; y0: number; x1: number; y1: number }) => ({ x: b.x0 + box.x, y: b.y0 + box.y, w: b.x1 - b.x0, h: b.y1 - b.y0 });
  return { hits: (b) => map.count(onSheet(b), code), covered: (b) => map.covered(onSheet(b), code) };
}

/**
 * The deal after a drawing's labels, written from `deal` on — for the text
 * after it. The labels stay cached, so drawing it from the same deal is instant.
 */
export async function dealAfter(layout: SketchLayout, deal: Deal): Promise<Deal> {
  return (await writeLabels(layout, deal)).deal;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The drawing's SVG content (without the <svg> element). With `ink` the colours
 * are written out (export); without it the pen follows the page: currentColor,
 * and coloured pens are toned down on dark paper like coloured words.
 * `draw`: pen or pencil and its colour (objects coloured by SetColor keep theirs).
 */
export function drawingBody(d: Drawing, ink?: string, draw?: DrawPen): string {
  const fill = (color?: string) => {
    if (!color) return ink ? `fill="${ink}"` : 'fill="currentColor"';
    return ink ? `fill="${color}"` : `style="fill:color-mix(in srgb, ${color} var(--pen-mix, 100%), #e6ecff)"`;
  };
  const pencil = draw?.tool === 'pencil';
  const lineColor = draw?.color ?? (pencil ? GRAPHITE : undefined);
  const labelColor = draw?.labelsInPen ? undefined : lineColor;
  const out: string[] = [];
  if (pencil) out.push(PENCIL_DEFS, '<g filter="url(#hb-pencil)">');
  for (const p of d.paths) out.push(`<path d="${p.d}" ${fill(p.color ?? lineColor)}${p.opacity !== undefined ? ` opacity="${p.opacity}"` : ''}/>`);
  if (pencil && draw?.labelsInPen) out.push('</g>');
  for (const l of d.labels) {
    const weight = getHandwriting().style.weight;
    const texts = l.ink.fallback
      .map((f, i) =>
        isRomanChar(f.ch)
          ? romanSvg(f, ink ? (l.color ?? labelColor ?? ink) : l.color ? `color-mix(in srgb, ${l.color} var(--pen-mix, 100%), #e6ecff)` : labelColor ?? null, weight, Math.round(l.x * 31 + l.y * 17 + i))
          : `<text x="${f.x}" y="${f.y}" font-size="${1000 * f.scale}" font-family='${FALLBACK_FONTS}' opacity="0.7">${esc(f.ch)}</text>`,
      )
      .join('');
    out.push(
      `<g transform="translate(${l.x.toFixed(1)} ${l.y.toFixed(1)}) scale(${l.scale.toFixed(5)})" ${fill(l.color ?? labelColor)}>` +
        (l.ink.d ? `<path d="${l.ink.d}"/>` : '') +
        texts +
        '</g>',
    );
  }
  if (pencil && !draw?.labelsInPen) out.push('</g>');
  return out.join('');
}

/** A standalone <svg> of the drawing. */
export function drawingSvg(d: Drawing, ink?: string, draw?: DrawPen): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}" overflow="visible">${drawingBody(d, ink, draw)}</svg>`;
}
