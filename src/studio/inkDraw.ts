import getStroke from 'perfect-freehand';
import { CAP_HEIGHT, DESCENDER, InkPoint, X_HEIGHT } from '../model/types';

/** Visible copybook band in font units (y up). */
export const CELL = { top: 1000, bottom: -450 };

export type ToPx = (x: number, y: number) => readonly [number, number];

export interface InkColors {
  guide: string;
  guideStrong: string;
  ink: string;
  paper: string;
}

export function themeColors(el: Element): InkColors {
  const css = getComputedStyle(el);
  return {
    guide: css.getPropertyValue('--guide').trim() || '#9aa3b5',
    guideStrong: css.getPropertyValue('--guide-strong').trim() || '#5c6a8a',
    ink: css.getPropertyValue('--ink').trim() || '#1f2a6b',
    paper: css.getPropertyValue('--paper').trim() || '#fbf7ee',
  };
}

/** Copybook ruling: cap height, x-height, baseline, descender line and slanted helpers. */
export function drawGuides(ctx: CanvasRenderingContext2D, w: number, h: number, toPx: ToPx, c: InkColors) {
  const line = (y: number, color: string, dash: number[], label?: string) => {
    const [, py] = toPx(0, y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(0, py + 0.5);
    ctx.lineTo(w, py + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    if (label) {
      ctx.fillStyle = color;
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(label, w - ctx.measureText(label).width - 6, py - 4);
    }
  };
  line(CAP_HEIGHT, c.guide, [2, 4], 'прописные');
  line(X_HEIGHT, c.guide, [6, 5], 'строчные');
  line(0, c.guideStrong, [], 'строка');
  line(DESCENDER, c.guide, [2, 4], 'хвосты');
  ctx.strokeStyle = c.guide;
  ctx.globalAlpha = 0.25;
  for (let x = -h; x < w; x += 70) {
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x + h * 0.27, 0);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Variable-width live ink (perfect-freehand), already in pixels. */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  points: InkPoint[],
  toPx: ToPx,
  sizePx: number,
  simulatePressure: boolean,
  finished: boolean,
) {
  const pts = points.map((p) => {
    const [x, y] = toPx(p.x, p.y);
    return [x, y, p.p];
  });
  const outline = getStroke(pts, {
    size: sizePx,
    thinning: 0.5,
    smoothing: 0.6,
    streamline: 0.35,
    simulatePressure,
    last: finished,
  });
  if (outline.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  ctx.closePath();
  ctx.fill();
}

/** Canvas sized for the device pixel ratio; returns a context in CSS pixels. */
export function prepareCanvas(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}
