import { engine, type ParagraphRender } from '../engine/client';
import { FALLBACK_FONTS } from '../engine/constants';
import { getHandwriting } from '../engine/handwriting';
import type { DocContent } from '../model/types';
import { drawingBody, drawSketch, heightOf, penFor, sketchLayout } from '../sketch/render';
import { drawPenOf, type DrawPen } from './page';
import { safeFilename, saveFile } from '../util/download';
import { blockSpan, flowPages, placeFloats, titleHeight } from './inkPages';
import { docSeed, INK_VIEWBOX_TOP, InkPalette, LINE_HEIGHT_EM, LINE_HEIGHT_UNITS, paragraphRuns, topLevelNodes, wordsSeen } from './layout';
import { SHEET_H, SHEET_W, type Geometry, type PaperStyle } from './page';

const PAPER = '#fbf7ee';

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
  const mx = geo.margin.left - 14;
  out.push(`<line x1="${mx}" x2="${mx}" y1="0" y2="${SHEET_H}" ${MARGIN_LINE}/>`);
  return out.join('');
}

/** A labelled frame where an interactive HTML block sits (it is live in print/PDF). */
function blockFrame(x: number, y: number, w: number, h: number, title: string): string {
  return (
    `<rect x="${x}" y="${y + 4}" width="${w}" height="${Math.max(h - 8, 40)}" rx="10" fill="none" stroke="#9aa3c7" stroke-dasharray="8 6"/>` +
    `<text x="${x + w / 2}" y="${y + Math.max(h, 48) / 2 + 5}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#6b7390">Блок «${xml(title)}» — интерактивный, есть в PDF/печати</text>`
  );
}

/**
 * The document as A4 sheets, one SVG (794×1123 px) per sheet: the same
 * letters, line breaks and page breaks as the rendered view, on the paper the
 * document uses (ruled, squared or plain).
 */
export async function documentPages(o: PageExport): Promise<string[]> {
  const { geo, fontSize } = o;
  const s = fontSize / 1000;
  const lh = fontSize * LINE_HEIGHT_EM;
  const baseline = fontSize * 1.075 + 2;
  const unitsWidth = (geo.contentW / fontSize) * 1000;
  const seed = docSeed(o.docId);
  const nodes = topLevelNodes(o.content);
  const palette = new InkPalette(o.ink);
  const color = (c: number) => palette.colors[c] ?? o.ink;

  const runs = nodes.map((n) => (n.type === 'paragraph' ? paragraphRuns(n, palette) : null));
  const seen = wordsSeen(runs.map((r) => r?.text ?? null));
  const renders: (ParagraphRender | null)[] = [];
  for (const [i, run] of runs.entries()) {
    renders.push(
      run
        ? await engine.renderParagraph(run.text, unitsWidth, LINE_HEIGHT_UNITS, seed, { scales: run.scales, colors: run.colors, shifts: run.shifts, seen: seen[i] })
        : null,
    );
  }
  const title = o.showTitle && o.title.trim() ? o.title : null;
  const titleInk = title
    ? await engine.renderParagraph(title, unitsWidth * 4, LINE_HEIGHT_UNITS, seed, {
        scales: [...title].map(() => TITLE_SCALE),
        colors: [],
      })
    : null;

  const titleH = titleHeight(o.showTitle, lh);
  const isSketch = (a: Record<string, unknown> | undefined) => a?.kind === 'sketch';
  const pages = flowPages(
    nodes,
    (i) => renders[i]?.lines ?? 1,
    (i) => (isSketch(nodes[i].attrs) ? heightOf(String(nodes[i].attrs?.code ?? ''), geo.contentW, fontSize) : Number(nodes[i].attrs?.height) || 260),
    lh,
    titleH,
    geo.contentH,
  );
  /** A drawing in the user's hand, as on screen: its pen or pencil, the document's ink. */
  const sketchAt = async (a: Record<string, unknown>, x: number, y: number, width: number) => {
    const draw = drawPenOf(o.drawPen, a.pen);
    const d = await drawSketch(sketchLayout(String(a.code ?? ''), width, fontSize, penFor(getHandwriting().style, fontSize, draw)));
    return `<svg x="${x}" y="${y}" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}" overflow="visible">${drawingBody(d, o.ink, draw)}</svg>`;
  };
  const floats = placeFloats(nodes, geo, titleH);
  const pageCount = Math.max(pages.length, ...floats.map((f) => f.page + 1));

  /** One line of ink (paths + characters without samples), placed with its top at y (text-area pixels). */
  const inkLine = (r: ParagraphRender, line: number, transform: string) => {
    const paths = (r.lineD[line] ?? []).map((part) => `<path d="${part.d}" fill="${color(part.color)}"/>`).join('');
    const fallback = r.fallback
      .filter((f) => f.line === line)
      .map((f) => `<text x="${f.x}" y="${f.y}" font-size="${1000 * f.scale}" fill="${color(f.color)}" opacity="0.7">${xml(f.ch)}</text>`)
      .join('');
    return `<g transform="${transform}">${paths}${fallback}</g>`;
  };

  const out: string[] = [];
  for (let p = 0; p < pageCount; p++) {
    const body: string[] = [];
    if (p === 0 && titleInk) body.push(inkLine(titleInk, 0, `scale(${s}) translate(0 ${TITLE_BASELINE_UNITS - INK_FIRST_BASELINE})`));
    for (const it of pages[p] ?? []) {
      if (it.kind === 'line') {
        const r = renders[it.para];
        if (r) body.push(inkLine(r, it.line, `translate(0 ${it.y}) scale(${s}) translate(0 ${-(INK_VIEWBOX_TOP + it.line * LINE_HEIGHT_UNITS)})`));
      } else {
        const a = nodes[it.node].attrs ?? {};
        if (isSketch(a)) body.push(await sketchAt(a, 0, it.y, geo.contentW));
        else body.push(blockFrame(0, it.y, geo.contentW, blockSpan(Number(a.height) || 260, lh), String(a.title ?? 'Блок')));
      }
    }
    const floating: string[] = [];
    for (const f of floats.filter((f) => f.page === p)) {
      if (isSketch(f.attrs)) floating.push(await sketchAt(f.attrs, f.left, f.top, f.width));
      else floating.push(blockFrame(f.left, f.top, f.width, Number(f.attrs.height) || 260, String(f.attrs.title ?? 'Блок')));
    }
    const number =
      o.firstNumber === null
        ? ''
        : `<text x="${SHEET_W / 2}" y="${SHEET_H - Math.min(28, geo.margin.bottom / 2.5) - 3}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#6b7390">${o.firstNumber + p}</text>`;
    out.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_W}" height="${SHEET_H}" viewBox="0 0 ${SHEET_W} ${SHEET_H}">` +
        `<rect width="100%" height="100%" fill="${PAPER}"/>${paperSvg(o.paper, geo, lh, baseline)}` +
        `<g transform="translate(${geo.margin.left} ${geo.margin.top})" font-family='${FALLBACK_FONTS}'>${body.join('')}</g>` +
        `${floating.join('')}${number}</svg>`,
    );
  }
  return out;
}

/** File name of sheet n: «Конспект.png» for one sheet, «Конспект — лист 2.png» for several. */
const sheetName = (title: string, page: number, pages: number, ext: string) =>
  `${safeFilename(title)}${pages > 1 ? ` — лист ${page + 1}` : ''}.${ext}`;

/** Every sheet as its own SVG file. */
export async function exportSvg(o: PageExport) {
  const pages = await documentPages(o);
  for (let p = 0; p < pages.length; p++) {
    await saveFile(new Blob([pages[p]], { type: 'image/svg+xml' }), sheetName(o.title, p, pages.length, 'svg'));
  }
}

/** Every sheet as its own PNG (A4 at 192 dpi). */
export async function exportPng(o: PageExport) {
  const pages = await documentPages(o);
  const k = 2;
  for (let p = 0; p < pages.length; p++) {
    const url = URL.createObjectURL(new Blob([pages[p]], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = SHEET_W * k;
      canvas.height = SHEET_H * k;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(k, k);
      ctx.drawImage(img, 0, 0, SHEET_W, SHEET_H);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
      if (blob) await saveFile(blob, sheetName(o.title, p, pages.length, 'png'));
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
