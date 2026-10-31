import { engine, type Deal, type ParagraphRender } from '../engine/client';
import { FALLBACK_FONTS } from '../engine/constants';
import { getHandwriting } from '../engine/handwriting';
import type { DocContent } from '../model/types';
import { aroundOnSheet, dealAfter, drawingBody, drawSketch, heightOf, penFor, scaleOf, sketchLayout } from '../sketch/render';
import { drawPenOf, type DrawPen } from './page';
import { exportFolder, safeFilename, saveFile } from '../util/download';
import { breaksOf, type NodeLayout } from './docLayout';
import { blockSpan, flowPages, layoutPages, placeFloats, titleHeight } from './inkPages';
import { docSeed, INK_VIEWBOX_TOP, InkPalette, LINE_HEIGHT_EM, LINE_HEIGHT_UNITS, paragraphRuns, topLevelNodes, wordsSeen } from './layout';
import type { Rect } from '../blank/blank';
import type { Occupancy } from '../blank/occupancy';
import { noteFontSize, noteSeed, writeNote } from '../blank/note';
import { isRomanChar, romanPen, romanStrokes, romanSvg } from '../blank/roman';
import type { Geometry, PaperStyle } from './page';
import { emptyWork, SHOW_ALL, WEAR_SCALE, wearCanvas, type LayerShow, type WearSettings, type WorkMap } from '../wear/wear';
import { reliefOf, shadeOverlay } from '../wear/relief';

/** Paper of the exports; ink colours are chosen to look right on it. */
export const PAPER = '#fbf7ee';

const xml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/** Everything the page export needs to draw a document exactly as the rendered view shows it. */
export interface PageExport {
  docId: string;
  title: string;
  showTitle: boolean;
  content: DocContent;
  fontSize: number;
  geo: Geometry;
  paper: PaperStyle;
  ink: string;
  /** Number of the first sheet; null: sheets are not numbered. */
  firstNumber: number | null;
  /** What the document's drawings are drawn with. */
  drawPen: DrawPen;
  /** Where the editor put the lines, when measured for this text and page: they go there (see `docLayout`). */
  layout?: (NodeLayout | null)[] | null;
  /**
   * The editor's page, when `geo` is another (the text laid onto other paper):
   * floating blocks lie over the editor's sheets.
   */
  editor?: Geometry;
  /** The blank the first sheet is printed with: its id, its picture (a data URL; empty while not made yet), where it lies, its letters' size (capitals, mm), and what lies on its sheet. */
  blank?: { id: string; href: string; rect: Rect; letters?: number; map?: Occupancy | null } | null;
  /** Traces of work drawn onto every sheet, when turned on (see wear/wear.ts); also what the sheets show. */
  wear?: WearSettings | null;
}

/** A sheet's ink apart: its text, its drawings (ink-only SVGs) and the graphite rubbed onto it. */
export interface SheetLayers {
  text: string;
  drawings: string;
  wear: HTMLCanvasElement | null;
}

/**
 * The centre line of one pen stroke on a sheet, for drawing the ink like a
 * real pen: flat `x, y, radius, pressure` per point (sheet pixels; pressure 1
 * at the letter's median, 0.3..1.5), and the stroke's ink.
 */
export interface PenStroke {
  color: string;
  pts: number[];
}

/** How the drawings go onto a photographed sheet. */
export interface DrawingFit {
  /** Width of a drawing in the text, px: the editor's scaled with the letters (never wider than the text). */
  width?: number;
  /**
   * Squares to draw by: a unit of the drawing is a simple number of them, its
   * origin where two of their lines cross. Square px, and where two lines
   * cross, text-area px.
   */
  grid?: { cell: number; x: number; y: number } | null;
  /** The editor's sheets: a drawing keeps the room it has in the editor, shrinking into it when it must. */
  keepPages?: boolean;
  /** The thinnest line of a drawing, px. */
  minPen?: number;
}

/** Paper colours of the light theme (exports are always on light paper). */
const RULE = 'stroke="rgb(70,105,170)" stroke-opacity="0.2" stroke-width="1.5"';
const GRID = 'fill="rgb(70,105,170)" fill-opacity="0.14"';
const MARGIN_LINE = 'stroke="rgb(217,83,63)" stroke-opacity="0.35" stroke-width="1.5"';
/** Title: 1.5× letters on a two-line box; its baseline in font units from the top of the text area. */
const TITLE_SCALE = 1.5;
const TITLE_BASELINE_UNITS = (2 * LINE_HEIGHT_UNITS - TITLE_SCALE * 1150) / 2 + TITLE_SCALE * 850;
const INK_FIRST_BASELINE = 850;

/** Ruling, squares and the margin line of a sheet, when the document uses them. */
function paperSvg(paper: PaperStyle, geo: Geometry, lh: number, baseline: number): string {
  if (paper === 'plain') return '';
  const { w: SHEET_W, h: SHEET_H } = geo.sheet;
  const out: string[] = [];
  if (paper === 'ruled') {
    for (let y = geo.margin.top + baseline; y < SHEET_H - geo.margin.bottom; y += lh) {
      out.push(`<line x1="0" x2="${SHEET_W}" y1="${y}" y2="${y}" ${RULE}/>`);
    }
  } else {
    // Squares of half a line, aligned so every baseline lies on a grid line (as on screen).
    const cell = lh / 2;
    const mod = (a: number) => ((a % cell) + cell) % cell;
    for (let x = mod(geo.margin.left); x < SHEET_W; x += cell) out.push(`<rect x="${x}" y="0" width="1" height="${SHEET_H}" ${GRID}/>`);
    for (let y = mod(geo.margin.top + baseline); y < SHEET_H; y += cell) out.push(`<rect x="0" y="${y}" width="${SHEET_W}" height="1" ${GRID}/>`);
  }
  for (const mx of [geo.leftLine, geo.rightLine]) {
    if (mx !== null) out.push(`<line x1="${mx}" x2="${mx}" y1="0" y2="${SHEET_H}" ${MARGIN_LINE}/>`);
  }
  return out.join('');
}

/** A blank's picture, printed onto the paper (its white is the paper's). */
function blankSvg(blank: PageExport['blank']): string {
  if (!blank?.href) return '';
  const { x, y, w, h } = blank.rect;
  return `<image href="${blank.href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" style="mix-blend-mode:multiply"/>`;
}

/** A labelled frame where an interactive HTML block sits (it is live in print/PDF). */
function blockFrame(x: number, y: number, w: number, h: number, title: string): string {
  return (
    `<rect x="${x}" y="${y + 4}" width="${w}" height="${Math.max(h - 8, 40)}" rx="10" fill="none" stroke="#9aa3c7" stroke-dasharray="8 6"/>` +
    `<text x="${x + w / 2}" y="${y + Math.max(h, 48) / 2 + 5}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#6b7390">Блок «${xml(title)}» — интерактивный, есть в PDF/печати</text>`
  );
}

/**
 * The document as sheets, one SVG per sheet (A4: 794×1123 px): the same
 * letters, line breaks and page breaks as the rendered view, on the paper the
 * document uses (ruled, squared, plain or a blank).
 *
 * `inkOnly`: just what the pen wrote, on a transparent sheet — no paper,
 * ruling or page number, and no interactive HTML blocks (their place stays
 * empty, so the lines do not move). For writing onto a photo of a real sheet;
 * `geo.sheet` may then be another paper size, with the text re-flowed onto it.
 * `strokes`: filled with each sheet's pen strokes (handwriting only).
 * `pitch`: the lines (and blocks) go this far apart instead of the line
 * height, the letters keep their size — the same lines and sheets, spaced to
 * the printed lines of a real notebook. `drawings`: how the drawings go onto
 * such a sheet.
 */
export async function documentPages(
  o: PageExport,
  {
    inkOnly = false,
    strokes,
    pitch,
    drawings,
    work,
    layers,
  }: { inkOnly?: boolean; strokes?: PenStroke[][]; pitch?: number; drawings?: DrawingFit; work?: WorkMap[]; layers?: SheetLayers[] } = {},
): Promise<string[]> {
  // Where the letters and lines went is collected for the traces of work.
  const wear = o.wear?.on ? o.wear : null;
  /** What the sheets show: the stages of the render may be left out (the work is collected all the same). */
  const show: LayerShow = o.wear?.show ?? SHOW_ALL;
  const collect = !!strokes || !!work || !!wear;
  const { geo, fontSize } = o;
  // Drawings on a blank write their labels as big as the blank's letters, not the text's.
  const sketchFs = o.blank?.letters ? noteFontSize(o.blank.letters) : fontSize;
  const { w: sheetW, h: sheetH } = geo.sheet;
  const s = fontSize / 1000;
  const lh = fontSize * LINE_HEIGHT_EM;
  const vy = pitch ? pitch / lh : 1;
  const baseline = fontSize * 1.075 + 2;
  const unitsWidth = (geo.contentW / fontSize) * 1000;
  const seed = docSeed(o.docId);
  const nodes = topLevelNodes(o.content);
  const palette = new InkPalette(o.ink);
  const color = (c: number) => palette.colors[c] ?? o.ink;

  const runs = nodes.map((n) => (n.type === 'paragraph' ? paragraphRuns(n, palette) : null));
  const seen = wordsSeen(runs.map((r) => r?.text ?? null));
  // The editor's lines, unless the text is laid out anew (another width).
  const layout = o.layout && o.layout.length === nodes.length ? o.layout : null;
  const renders: (ParagraphRender | null)[] = [];
  // In reading order, each paragraph going on with the variants the text before left unused — the labels
  // of drawings and formulas in between too (as the rendered view does).
  let deal: Deal | undefined;
  /** The deal each drawing's labels go on from (by its attributes). */
  const sketchDeals = new Map<unknown, Deal>();
  for (const [i, run] of runs.entries()) {
    const a = nodes[i].attrs;
    if (a?.kind === 'sketch') {
      const pen = penFor(getHandwriting().style, sketchFs, drawPenOf(o.drawPen, a.pen));
      sketchDeals.set(a, deal ?? {});
      deal = await dealAfter(sketchLayout(String(a.code ?? ''), geo.contentW, sketchFs, pen), deal ?? {});
    }
    const r = run
      ? await engine.renderParagraph(run.text, unitsWidth, LINE_HEIGHT_UNITS, seed, {
          scales: run.scales,
          colors: run.colors,
          shifts: run.shifts,
          seen: seen[i],
          skeleton: collect,
          deal,
          breaks: breaksOf(layout?.[i]),
        })
      : null;
    if (r) deal = r.deal;
    renders.push(r);
  }
  const title = o.showTitle && o.title.trim() ? o.title : null;
  const titleInk = title
    ? await engine.renderParagraph(title, unitsWidth * 4, LINE_HEIGHT_UNITS, seed, {
        scales: [...title].map(() => TITLE_SCALE),
        colors: [],
        skeleton: collect,
      })
    : null;

  const titleH = titleHeight(o.showTitle, lh);
  const isSketch = (a: Record<string, unknown> | undefined) => a?.kind === 'sketch';
  const mod = (a: number, m: number) => ((a % m) + m) % m;
  const fitW = Math.min(geo.contentW, drawings?.width ?? geo.contentW);
  const fits = new Map<string, { width: number; height: number; ox: number; oy: number }>();
  /** A drawing in the text: its width (by the squares, when asked) and height, and where its origin is. */
  const fitOf = (code: string) => {
    const hit = fits.get(code);
    if (hit) return hit;
    const grid = drawings?.grid;
    let width = fitW;
    let at = scaleOf(code, width, sketchFs);
    if (grid && at.ppx > 0) {
      // Squares per unit: a simple number near the drawing's own scale, the drawing within the text.
      const widthAt = (ppx: number) => fitW - at.plotW + at.plotW * (ppx / at.ppx);
      const want = at.ppx / grid.cell;
      const choices = [0.1, 0.2, 0.25, 0.5, 1, 2, 3, 4, 5, 10].filter((c) => widthAt(c * grid.cell) <= geo.contentW - grid.cell && widthAt(c * grid.cell) >= 4 * sketchFs);
      if (choices.length) {
        const c = choices.reduce((b, v) => (Math.abs(Math.log(v / want)) < Math.abs(Math.log(b / want)) ? v : b));
        width = widthAt(c * grid.cell);
        // The window shifts a little with the width: once more.
        at = scaleOf(code, width, sketchFs);
        width += at.plotW * ((c * grid.cell) / at.ppx - 1);
        at = scaleOf(code, width, sketchFs);
      }
    }
    const fit = { width, height: at.height + (grid ? grid.cell : 0), ox: at.ox, oy: at.oy };
    fits.set(code, fit);
    return fit;
  };
  /** The room a drawing takes among the lines (before they are spaced `pitch` apart): the editor's, or its own here. */
  const roomOf = (code: string) => (drawings?.keepPages ? heightOf(code, geo.contentW, sketchFs) : fitOf(code).height / vy);
  const pages = layout
    ? layoutPages(nodes, layout, (i) => renders[i]?.lines ?? 1, lh)
    : flowPages(
        nodes,
        (i) => renders[i]?.lines ?? 1,
        (i) => (isSketch(nodes[i].attrs) ? roomOf(String(nodes[i].attrs?.code ?? '')) : Number(nodes[i].attrs?.height) || 260),
        lh,
        titleH,
        geo.contentH,
      );
  /**
   * A drawing in the user's hand, as on screen: its pen or pencil, the document's ink; `zoom` shrinks it.
   * (x, y) within the text area when `inText`, else on the sheet.
   */
  const sketchAt = async (a: Record<string, unknown>, x: number, y: number, width: number, zoom = 1, inText = false) => {
    const draw = drawPenOf(o.drawPen, a.pen);
    const pen = penFor(getHandwriting().style, sketchFs, draw);
    if (drawings?.minPen) pen.width = Math.max(pen.width, drawings.minPen);
    const lay = sketchLayout(String(a.code ?? ''), width, sketchFs, pen);
    if (collect) {
      const ox = x + (inText ? geo.margin.left : 0);
      const oy = y + (inText ? geo.margin.top : 0);
      const at = (p: { x: number; y: number }) => ({ x: ox + p.x * zoom, y: oy + p.y * zoom });
      const kind = draw.tool === 'pencil' ? 'pencil' : 'pen';
      for (const l of lay.lines) sheetWork.lines.push({ pts: l.map(at), kind });
      for (const p of lay.pivots) sheetWork.pivots.push(at(p));
    }
    const d = await drawSketch(lay, sketchDeals.get(a) ?? {}, aroundOnSheet(String(a.code ?? ''), o.blank?.map));
    return `<svg x="${x}" y="${y}" width="${d.width * zoom}" height="${d.height * zoom}" viewBox="0 0 ${d.width} ${d.height}" overflow="visible">${drawingBody(d, o.ink, draw)}</svg>`;
  };
  /** A drawing among the lines at y: by the squares, within the room it was given. */
  const sketchIn = async (a: Record<string, unknown>, y: number) => {
    const code = String(a.code ?? '');
    const fit = fitOf(code);
    const grid = drawings?.grid;
    const x = grid ? mod(grid.x - fit.ox, grid.cell) : 0;
    const dy = grid ? mod(grid.y - (y + fit.oy), grid.cell) : 0;
    const room = blockSpan(roomOf(code), lh) * vy;
    return sketchAt(a, x, y + dy, fit.width, Math.min(1, room / (fit.height - (grid ? grid.cell : 0) + dy)), true);
  };
  /** A note at (x, y) on the sheet, `width` px wide: its lines by hand, its pen strokes collected with the sheet's. */
  const noteAt = async (a: Record<string, unknown>, node: number, x: number, y: number, width: number) => {
    const fs = noteFontSize(Number(a.size));
    const ns = fs / 1000;
    const nlh = fs * LINE_HEIGHT_EM;
    const out: string[] = [];
    let k = 0;
    const flip = Array.isArray(a.data && (a.data as { roman?: unknown }).roman) ? ((a.data as { roman: number[] }).roman) : [];
    const nseed = noteSeed(seed, node);
    const weight = getHandwriting().style.weight;
    for (const r of await writeNote(String(a.code ?? ''), width, fs, nseed, collect, flip)) {
      if (!r) {
        k++;
        continue;
      }
      for (let line = 0; line < r.lines; line++, k++) {
        const top = y + k * nlh;
        const ty = -(INK_VIEWBOX_TOP + line * LINE_HEIGHT_UNITS);
        for (const st of collect ? (r.lineSkel?.[line] ?? []) : []) {
          const pts = st.pts.slice();
          for (let q = 0; q < pts.length; q += 4) {
            pts[q] = x + pts[q] * ns;
            pts[q + 1] = top + (pts[q + 1] + ty) * ns;
            pts[q + 2] *= ns;
          }
          sheetStrokes.push({ color: color(st.color), pts });
        }
        const paths = (r.lineD[line] ?? []).map((part) => `<path d="${part.d}" fill="${color(part.color)}"/>`).join('');
        const fallback = r.fallback
          .filter((f) => f.line === line)
          .map((f, j) => {
            if (!isRomanChar(f.ch)) return `<text x="${f.x}" y="${f.y}" font-size="${1000 * f.scale}" fill="${color(f.color)}" opacity="0.7" font-family='${FALLBACK_FONTS}'>${xml(f.ch)}</text>`;
            // A Roman numeral's sticks: drawn, and for a photo, written with the pen too.
            for (const pts of collect ? romanStrokes(f.ch, f.x, f.y, f.scale, nseed + j) : []) {
              const flat: number[] = [];
              for (const [px, py] of pts) flat.push(x + px * ns, top + (py + ty) * ns, (romanPen(weight) * f.scale * ns) / 2, 1);
              sheetStrokes.push({ color: color(f.color), pts: flat });
            }
            return romanSvg(f, color(f.color), weight, nseed + j);
          })
          .join('');
        out.push(`<g transform="translate(${x} ${top}) scale(${ns}) translate(0 ${ty})">${paths}${fallback}</g>`);
      }
    }
    return out.join('');
  };
  const editorGeo = o.editor ?? geo;
  const floats = placeFloats(nodes, editorGeo, titleH);
  const pageCount = Math.max(pages.length, ...floats.map((f) => f.page + 1));

  let sheetStrokes: PenStroke[] = [];
  let sheetWork: WorkMap = emptyWork();
  /**
   * One line of ink (paths + characters without samples), placed with its top
   * at y (text-area pixels). Its pen strokes, when collected, go onto the sheet
   * by the same transform: x·s, dy + (y + ty)·s, inside the margins.
   */
  const inkLine = (r: ParagraphRender, line: number, transform: string, dy: number, ty: number) => {
    for (const st of collect ? (r.lineSkel?.[line] ?? []) : []) {
      const pts = st.pts.slice();
      for (let k = 0; k < pts.length; k += 4) {
        pts[k] = geo.margin.left + pts[k] * s;
        pts[k + 1] = geo.margin.top + dy + (pts[k + 1] + ty) * s;
        pts[k + 2] *= s;
      }
      sheetStrokes.push({ color: color(st.color), pts });
    }
    const paths = (r.lineD[line] ?? []).map((part) => `<path d="${part.d}" fill="${color(part.color)}"/>`).join('');
    const weight = getHandwriting().style.weight;
    const fallback = r.fallback
      .filter((f) => f.line === line)
      .map((f, j) => {
        if (!isRomanChar(f.ch)) return `<text x="${f.x}" y="${f.y}" font-size="${1000 * f.scale}" fill="${color(f.color)}" opacity="0.7">${xml(f.ch)}</text>`;
        // A Roman numeral's sticks; for a photo, written with the pen too.
        const rseed = seed + line * 131 + j;
        for (const pts of collect ? romanStrokes(f.ch, f.x, f.y, f.scale, rseed) : []) {
          const flat: number[] = [];
          for (const [px, py] of pts) flat.push(geo.margin.left + px * s, geo.margin.top + dy + (py + ty) * s, (romanPen(weight) * f.scale * s) / 2, 1);
          sheetStrokes.push({ color: color(f.color), pts: flat });
        }
        return romanSvg(f, color(f.color), weight, rseed);
      })
      .join('');
    return `<g transform="${transform}">${paths}${fallback}</g>`;
  };

  const out: string[] = [];
  for (let p = 0; p < pageCount; p++) {
    const body: string[] = [];
    const bodyDraw: string[] = [];
    sheetStrokes = [];
    sheetWork = emptyWork();
    if (p === 0 && titleInk) {
      const ty = TITLE_BASELINE_UNITS - INK_FIRST_BASELINE;
      body.push(inkLine(titleInk, 0, `scale(${s}) translate(0 ${ty})`, 0, ty));
    }
    for (const it of pages[p] ?? []) {
      const y = it.y * vy;
      if (it.kind === 'line') {
        const r = renders[it.para];
        const ty = -(INK_VIEWBOX_TOP + it.line * LINE_HEIGHT_UNITS);
        if (r) body.push(inkLine(r, it.line, `translate(0 ${y}) scale(${s}) translate(0 ${ty})`, y, ty));
      } else {
        const a = nodes[it.node].attrs ?? {};
        if (isSketch(a)) bodyDraw.push(await sketchIn(a, y));
        else if (!inkOnly) body.push(blockFrame(0, y, geo.contentW, blockSpan(Number(a.height) || 260, lh), String(a.title ?? 'Блок')));
      }
    }
    const floating: string[] = [];
    const floatDraw: string[] = [];
    for (const f of floats.filter((f) => f.page === p)) {
      // Floating blocks are placed over the editor's sheets; on other paper they keep their relative height.
      const top = (f.top * sheetH) / editorGeo.sheet.h;
      // A drawing on a blank keeps its place on the sheet exactly (it may run past the edge as on paper).
      const left = f.onSheet ? f.left : Math.max(0, Math.min(f.left - editorGeo.margin.left + geo.margin.left, sheetW - f.width));
      if (f.attrs.kind === 'note') floating.push(await noteAt(f.attrs, f.i, left, top, f.width));
      else if (isSketch(f.attrs)) floatDraw.push(await sketchAt(f.attrs, left, top, f.width));
      else if (!inkOnly) floating.push(blockFrame(left, top, f.width, Number(f.attrs.height) || 260, String(f.attrs.title ?? 'Блок')));
    }
    const number =
      o.firstNumber === null || inkOnly
        ? ''
        : `<text x="${sheetW / 2}" y="${sheetH - Math.min(28, geo.margin.bottom / 2.5) - 3}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#6b7390">${o.firstNumber + p}</text>`;
    // The letters' pen strokes are where the hand went too.
    for (const st of sheetStrokes) {
      const pts: { x: number; y: number }[] = [];
      for (let k = 0; k + 1 < st.pts.length; k += 4) pts.push({ x: st.pts[k], y: st.pts[k + 1] });
      if (pts.length > 1) sheetWork.lines.push({ pts, kind: 'letter' });
    }
    work?.push(sheetWork);
    const full = (pic: HTMLCanvasElement) => `<image href="${pic.toDataURL('image/png')}" x="0" y="0" width="${sheetW}" height="${sheetH}" preserveAspectRatio="none"/>`;
    const rubbed = wear ? wearCanvas(sheetWork, geo.sheet, WEAR_SCALE, wear, mix32(seed, p)) : null;
    const traces = rubbed && show.wear ? full(rubbed) : '';
    // The creases' light (on a photo the GPU does it, with the shift).
    const relief = wear && !inkOnly ? reliefOf(geo.sheet, wear, mix32(seed, p), sheetWork.pivots) : null;
    const creases = relief && !relief.flat ? full(shadeOverlay(relief)) : '';
    const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}" viewBox="0 0 ${sheetW} ${sheetH}">`;
    const inText = (parts: string[]) => `<g transform="translate(${geo.margin.left} ${geo.margin.top})" font-family='${FALLBACK_FONTS}'>${parts.join('')}</g>`;
    const text = show.text ? inText(body) + floating.join('') : '';
    const drawn = show.drawings ? inText(bodyDraw) + floatDraw.join('') : '';
    out.push(
      open +
        (inkOnly ? '' : `<rect width="100%" height="100%" fill="${PAPER}"/>${p === 0 && show.print ? blankSvg(o.blank) : ''}${paperSvg(o.paper, geo, lh, baseline)}`) +
        creases +
        traces +
        drawn +
        text +
        `${number}</svg>`,
    );
    layers?.push({ text: open + inText(body) + floating.join('') + '</svg>', drawings: open + inText(bodyDraw) + floatDraw.join('') + '</svg>', wear: rubbed });
    strokes?.push(sheetStrokes);
  }
  return out;
}

/** The seed of a sheet's traces: the document's, then the sheet's number. */
export const mix32 = (seed: number, page: number) => Math.imul(seed ^ (page + 1) * 0x9e3779b1, 16777619) >>> 0;

/** File name of sheet n: «Конспект.png» for one sheet, «Конспект — лист 2.png» for several. */
const sheetName = (title: string, page: number, pages: number, ext: string) =>
  `${safeFilename(title)}${pages > 1 ? ` — лист ${page + 1}` : ''}.${ext}`;

/** Every sheet as its own SVG file. */
export async function exportSvg(o: PageExport) {
  const pages = await documentPages(o);
  const folder = await exportFolder();
  for (let p = 0; p < pages.length; p++) {
    await saveFile(new Blob([pages[p]], { type: 'image/svg+xml' }), sheetName(o.title, p, pages.length, 'svg'), folder);
  }
}

/** Every sheet as its own PNG (192 dpi). */
export async function exportPng(o: PageExport) {
  const pages = await documentPages(o);
  const folder = await exportFolder();
  const k = 2;
  for (let p = 0; p < pages.length; p++) {
    const url = URL.createObjectURL(new Blob([pages[p]], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      const { w, h } = o.geo.sheet;
      canvas.width = Math.round(w * k);
      canvas.height = Math.round(h * k);
      const ctx = canvas.getContext('2d')!;
      ctx.scale(k, k);
      ctx.drawImage(img, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
      if (blob) await saveFile(blob, sheetName(o.title, p, pages.length, 'png'), folder);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

export async function exportFont() {
  const bytes = getHandwriting().fontBytes;
  if (!bytes) return;
  await saveFile(new Blob([bytes.slice()], { type: 'font/ttf' }), 'MyHandwriting.ttf');
}

export async function exportDocumentJson(title: string, content: DocContent) {
  const data = { format: 'handbook-document', version: 1, title, content };
  await saveFile(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${safeFilename(title)}.handbook.json`);
}
