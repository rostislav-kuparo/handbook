// A drawing from its text: the same picture in the editor, the rendered
// view and the exported sheets.
import { FALLBACK_FONTS } from '../engine/constants';
import type { Style } from '../model/types';
import { compileSketch } from './evaluate';
import { labelInk } from './labels';
import { layoutSketch, placeLabels, sketchHeight, type InkPath, type PlacedLabel, type SketchLayout } from './layout';
import type { Pen } from './pen';

export interface Drawing {
  width: number;
  height: number;
  paths: InkPath[];
  labels: PlacedLabel[];
  empty: boolean;
}

/** The handwriting's own pen, at this letter size. */
export function penFor(style: Style, fontSize: number): Pen {
  return { width: Math.max(0.8, (style.weight * fontSize) / 1000), pressure: style.pressure, jitter: style.jitter };
}

const layouts = new Map<string, SketchLayout>();

/** Lines and label places of a drawing `width` px wide (cached). */
export function sketchLayout(code: string, width: number, fontSize: number, pen: Pen): SketchLayout {
  const key = `${width}|${fontSize}|${pen.width}|${pen.pressure}|${pen.jitter}|${code}`;
  const hit = layouts.get(key);
  if (hit) return hit;
  const layout = layoutSketch(compileSketch(code), width, fontSize, pen);
  layouts.set(key, layout);
  if (layouts.size > 30) layouts.delete(layouts.keys().next().value!);
  return layout;
}

/** Height in px at this width: known before anything is drawn, so pages can be laid out. */
export function heightOf(code: string, width: number, fontSize: number): number {
  return sketchHeight(compileSketch(code), width, fontSize);
}

/** Lines only: shown at once while the labels are being written. */
export function linesOnly(layout: SketchLayout): Drawing {
  return { width: layout.width, height: layout.height, paths: layout.paths, labels: [], empty: layout.empty };
}

/** The whole drawing, labels written by the handwriting engine. */
export async function drawSketch(layout: SketchLayout): Promise<Drawing> {
  const inks = await Promise.all(layout.labels.map((l) => labelInk(l.runs, l.seed)));
  return { ...linesOnly(layout), labels: placeLabels(layout, inks) };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The drawing's SVG content (without the <svg> element). With `ink` the colours
 * are written out (export); without it the pen follows the page: currentColor,
 * and coloured pens are toned down on dark paper like coloured words.
 */
export function drawingBody(d: Drawing, ink?: string): string {
  const fill = (color?: string) => {
    if (!color) return ink ? `fill="${ink}"` : 'fill="currentColor"';
    return ink ? `fill="${color}"` : `style="fill:color-mix(in srgb, ${color} var(--pen-mix, 100%), #e6ecff)"`;
  };
  const out: string[] = [];
  for (const p of d.paths) out.push(`<path d="${p.d}" ${fill(p.color)}${p.opacity !== undefined ? ` opacity="${p.opacity}"` : ''}/>`);
  for (const l of d.labels) {
    const texts = l.ink.fallback
      .map((f) => `<text x="${f.x}" y="${f.y}" font-size="${1000 * f.scale}" font-family='${FALLBACK_FONTS}' opacity="0.7">${esc(f.ch)}</text>`)
      .join('');
    out.push(
      `<g transform="translate(${l.x.toFixed(1)} ${l.y.toFixed(1)}) scale(${l.scale.toFixed(5)})" ${fill(l.color)}>` +
        (l.ink.d ? `<path d="${l.ink.d}"/>` : '') +
        texts +
        '</g>',
    );
  }
  return out.join('');
}

/** A standalone <svg> of the drawing. */
export function drawingSvg(d: Drawing, ink?: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}" overflow="visible">${drawingBody(d, ink)}</svg>`;
}
