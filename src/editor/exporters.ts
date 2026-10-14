import { engine } from '../engine/client';
import { FALLBACK_FONTS } from '../engine/constants';
import { getHandwriting } from '../engine/handwriting';
import type { DocContent } from '../model/types';
import { downloadBlob, safeFilename } from '../util/download';
import { docSeed, INK_VIEWBOX_TOP, InkPalette, LINE_HEIGHT_UNITS, paragraphRuns, topLevelNodes } from './layout';

const PAPER = '#fbf7ee';

const xml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/** Whole document as one SVG, written "by hand". HTML blocks become labelled frames. */
export async function documentSvg(docId: string, content: DocContent, widthPx: number, fontSize: number, ink: string) {
  const margin = 56;
  const scale = fontSize / 1000;
  const unitsWidth = widthPx / scale;
  const parts: string[] = [];
  let y = margin;
  const nodes = topLevelNodes(content);
  const palette = new InkPalette(ink);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.type === 'paragraph') {
      const run = paragraphRuns(n, palette);
      const r = await engine.renderParagraph(run.text, unitsWidth, LINE_HEIGHT_UNITS, docSeed(docId), {
        scales: run.scales,
        colors: run.colors,
        shifts: run.shifts,
      });
      const color = (c: number) => palette.colors[c] ?? ink;
      const fallback = r.fallback
        .map((f) => `<text x="${f.x}" y="${f.y}" font-size="${1000 * f.scale}" fill="${color(f.color)}" opacity="0.7">${xml(f.ch)}</text>`)
        .join('');
      const paths = r.lineD
        .flat()
        .map((part) => `<path d="${part.d}" fill="${color(part.color)}"/>`)
        .join('');
      parts.push(
        `<g transform="translate(${margin} ${y}) scale(${scale}) translate(0 ${-INK_VIEWBOX_TOP})">${paths}${fallback}</g>`,
      );
      y += r.lines * LINE_HEIGHT_UNITS * scale;
    } else if (n.type === 'htmlBlock') {
      const title = xml(String(n.attrs?.title ?? 'Блок'));
      parts.push(
        `<rect x="${margin}" y="${y + 8}" width="${widthPx}" height="110" rx="12" fill="none" stroke="#9aa3c7" stroke-dasharray="8 6"/>` +
          `<text x="${margin + widthPx / 2}" y="${y + 70}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" fill="#6b7390">Блок «${title}» — интерактивный, есть в PDF/печати</text>`,
      );
      y += 126;
    }
  }
  const width = widthPx + margin * 2;
  const height = Math.ceil(y + margin);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="100%" height="100%" fill="${PAPER}"/><g fill="${ink}" font-family='${FALLBACK_FONTS}'>${parts.join('')}</g></svg>`;
  return { svg, width, height };
}

export async function exportSvg(docId: string, title: string, content: DocContent, widthPx: number, fontSize: number, ink: string) {
  const { svg } = await documentSvg(docId, content, widthPx, fontSize, ink);
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${safeFilename(title)}.svg`);
}

export async function exportPng(docId: string, title: string, content: DocContent, widthPx: number, fontSize: number, ink: string) {
  const { svg, width, height } = await documentSvg(docId, content, widthPx, fontSize, ink);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = 2;
    const canvas = document.createElement('canvas');
    canvas.width = width * k;
    canvas.height = height * k;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(k, k);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (blob) downloadBlob(blob, `${safeFilename(title)}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function exportFont() {
  const bytes = getHandwriting().fontBytes;
  if (!bytes) return;
  downloadBlob(new Blob([bytes.slice()], { type: 'font/ttf' }), 'MyHandwriting.ttf');
}

export function exportDocumentJson(title: string, content: DocContent) {
  const data = { format: 'handbook-document', version: 1, title, content };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${safeFilename(title)}.handbook.json`);
}
