// «Бланк»: a printed task sheet (a picture file) as the sheet of a document.
// The document's sheet is the paper the blank gets printed on; the picture lies
// on it the way a printer puts it. Whatever is placed over it (drawings,
// later notes) is in millimetres of that paper.
import { MM, type SheetSize } from '../editor/page';
import { uid } from '../model/types';
import { db } from '../storage/db';

export type BlankFormat = 'a4' | 'a5';

export const BLANK_FORMATS: Record<BlankFormat, { name: string; mm: [number, number] }> = {
  a4: { name: 'A4', mm: [210, 297] },
  a5: { name: 'A5', mm: [148, 210] },
};

/** How the printer puts the picture: shrunk into the area it can print («по размеру листа»), or onto the whole paper (its edges may be cut). */
export type BlankPrint = 'fit' | 'actual';

export interface Blank {
  id: string;
  /** The file's name, without the extension. */
  name: string;
  /** The file as it was opened. */
  image: Blob;
  /** Size of the picture, px. */
  px: [number, number];
  format: BlankFormat;
  landscape: boolean;
  /** Brightness of the paper in the picture (0..255): this and lighter takes no toner. */
  white: number;
  print: BlankPrint;
  createdAt: number;
  /** Capitals of the handwriting on this blank, mm: by its printed text, or as set; missing: not measured yet. */
  letters?: number;
  /** 2: the sheet is the blank itself, the printer's shrinking only when printed (0.8.1); missing: shrunk on the sheet (0.7–0.8.0). */
  version?: number;
  /**
   * The points a neural net is shown (@1, @2…), as shares of the picture's
   * width and height; missing: not looked for yet.
   */
  marks?: BlankMark[];
}

/** A point of the blank the neural net may build from: where (shares of the picture) and what it is. */
export interface BlankMark {
  u: number;
  v: number;
  kind: 'circle' | 'dot' | 'cross' | 'end' | 'free';
}

/** A printer leaves about this much of the paper's edge unprinted, mm. */
export const PRINTER_MARGIN = 4.2;

/** The format's paper, width and height in mm, as the blank lies (before 0.8.1 this was the sheet). */
export function formatMm(b: Pick<Blank, 'format' | 'landscape'>): [number, number] {
  const [w, h] = BLANK_FORMATS[b.format].mm;
  return b.landscape ? [h, w] : [w, h];
}

/**
 * The blank's own sheet, mm: the format when the picture has its proportions
 * (A4, A5), otherwise as the picture is — its longer side the format's.
 */
export function blankPaperMm(b: Pick<Blank, 'format' | 'landscape' | 'px'>): [number, number] {
  const [w, h] = formatMm(b);
  const aspect = b.px[0] / b.px[1];
  if (Math.abs(aspect / (w / h) - 1) < 0.015) return [w, h];
  const long = Math.max(w, h);
  return aspect >= 1 ? [long, long / aspect] : [long * aspect, long];
}

/** The document's sheet for a blank, CSS px: the blank itself. */
export function blankSheet(b: Pick<Blank, 'format' | 'landscape' | 'px'>): SheetSize {
  const [w, h] = blankPaperMm(b);
  return { w: w * MM, h: h * MM };
}

/**
 * How much a printer shrinks a whole page «по размеру листа» onto `paper`
 * (px): into what it can print, about 4 mm in from each edge (0.96 for A4).
 */
export function printerShrink(paper: SheetSize): number {
  const m = 2 * PRINTER_MARGIN * MM;
  return Math.min((paper.w - m) / paper.w, (paper.h - m) / paper.h);
}

/** How a blank's page is shrunk when printed onto paper of `paper` px: as its setting says. */
export const printShrinkOf = (b: Pick<Blank, 'print'>, paper: SheetSize) => (b.print === 'fit' ? printerShrink(paper) : 1);

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the picture lies on a sheet, sheet px: the whole of it, centred, keeping its proportions (on the blank's own sheet: the sheet). */
export function blankRect(b: Pick<Blank, 'px'>, sheet: SheetSize): Rect {
  const k = Math.min(sheet.w / b.px[0], sheet.h / b.px[1]);
  const w = b.px[0] * k;
  const h = b.px[1] * k;
  return { x: (sheet.w - w) / 2, y: (sheet.h - h) / 2, w, h };
}

/** «По размеру листа» on paper of the blank's size, percent (about 96 for A4). */
export const fitPercent = (b: Pick<Blank, 'format' | 'landscape' | 'px'>) => Math.round(100 * printerShrink(blankSheet(b)));

/** The picture is processed at most this big along its longer side (it is shown and printed from that). */
const MAX_SIDE = 3500;

/** The picture's pixels on white, at most `MAX_SIDE` along its longer side, and its full size. */
export async function pixels(image: Blob): Promise<{ data: Uint8ClampedArray; w: number; h: number; full: [number, number] }> {
  const bitmap = await createImageBitmap(image);
  try {
    const k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * k));
    const h = Math.max(1, Math.round(bitmap.height * k));
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
    // Transparency is paper.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, w, h, full: [bitmap.width, bitmap.height] };
  } finally {
    bitmap.close();
  }
}

export const lum = (d: Uint8ClampedArray, i: number) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

/** The paper's brightness: the commonest light shade of the picture (a blank is mostly paper). */
export function paperWhite(d: Uint8ClampedArray): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[Math.round(lum(d, i))]++;
  let best = 255;
  for (let v = 128; v < 256; v++) if (hist[v] > hist[best]) best = v;
  return best;
}

/**
 * How dark the toner is at a pixel of brightness `l`, 0..1 (1: none): the
 * paper and what is a little darker (noise, a JPEG's ringing) take none.
 */
export const tonerOf = (l: number, white: number) => Math.min(1, l / (white * 0.94));

/** Opens a picture as a new blank (kept in the database); the paper is guessed from its sides. */
export async function openBlankFile(file: File): Promise<Blank> {
  const { data, full } = await pixels(file);
  const blank: Blank = {
    id: uid(),
    name: file.name.replace(/\.[^.]+$/, '') || 'Бланк',
    image: file,
    px: full,
    format: 'a4',
    landscape: full[0] > full[1],
    white: paperWhite(data),
    print: 'fit',
    createdAt: Date.now(),
    version: 2,
  };
  await db.blanks.add(blank);
  return blank;
}

/** The blank as a black-and-white laser printer prints it: grey levels, the paper white. */
export interface BlankPicture {
  /** For <img>. */
  url: string;
  /** For SVG files and the PNG export (an SVG drawn as a picture may not load anything else). */
  dataUrl: string;
}

const pictures = new Map<string, Promise<BlankPicture>>();

export function blankPicture(b: Blank): Promise<BlankPicture> {
  const key = `${b.id}|${b.white}`;
  let hit = pictures.get(key);
  if (!hit) {
    hit = (async () => {
      const { data, w, h } = await pixels(b.image);
      const out = new ImageData(w, h);
      for (let i = 0; i < data.length; i += 4) {
        const g = Math.round(255 * tonerOf(lum(data, i), b.white));
        out.data[i] = out.data[i + 1] = out.data[i + 2] = g;
        out.data[i + 3] = 255;
      }
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d')!.putImageData(out, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      return { url: URL.createObjectURL(blob), dataUrl: await toDataUrl(blob) };
    })();
    pictures.set(key, hit);
    hit.catch(() => pictures.delete(key));
  }
  return hit;
}

export const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** The blanks as plain JSON for the full backup: pictures as data URLs. */
export async function exportBlanks(): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const b of await db.blanks.toArray()) out.push({ ...b, image: await toDataUrl(b.image) });
  return out;
}

/** Adds blanks from a backup; ones with the same id are replaced. */
export async function importBlanks(list: unknown[]): Promise<number> {
  const rows: Blank[] = [];
  for (const raw of list) {
    const b = raw as Partial<Blank> & { image?: unknown };
    if (!b || typeof b.id !== 'string' || typeof b.image !== 'string' || !Array.isArray(b.px)) continue;
    rows.push({
      id: b.id,
      name: String(b.name ?? 'Бланк'),
      image: await (await fetch(b.image)).blob(),
      px: [Number(b.px[0]) || 1, Number(b.px[1]) || 1],
      format: b.format === 'a5' ? 'a5' : 'a4',
      landscape: !!b.landscape,
      white: Number(b.white) || 255,
      print: b.print === 'actual' ? 'actual' : 'fit',
      createdAt: Number(b.createdAt) || Date.now(),
      ...(Array.isArray(b.marks) ? { marks: b.marks as BlankMark[] } : {}),
      ...(b.version ? { version: Number(b.version) } : {}),
      ...(Number(b.letters) > 0 ? { letters: Number(b.letters) } : {}),
    });
  }
  await db.blanks.bulkPut(rows);
  return rows.length;
}
