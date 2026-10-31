// A blank printed onto the photographed sheet: where the printer put it
// (turned to fit the paper, shrunk as the blank says, never quite straight)
// and its toner as pixels for the GPU.
import { mul, type Mat3 } from '../desk/homography';
import { MM, type SheetSize } from '../editor/page';
import { blankRect, lum, pixels, type Blank } from './blank';

export interface PrintChoice {
  /** A landscape blank on upright paper (or the other way round) is turned: its top to the paper's left (−1) or right (1) edge. */
  turn: 1 | -1;
  /** The turn chosen so the blank stands upright in the photo (`turn` then only when chosen by hand). */
  turnAuto: boolean;
  /** The printer's own slight turn and shift. */
  skew: boolean;
  /** Which of them. */
  seed: number;
  /** A colour printer; otherwise black and white. */
  color: boolean;
  /** Thickness of the toner (1: a laser printer's black). */
  toner: number;
}

export const DEFAULT_PRINT: PrintChoice = { turn: -1, turnAuto: true, skew: true, seed: 1, color: false, toner: 1 };

/**
 * The turn that stands a turned blank upright in the photo: its top to the
 * paper's edge that is higher in the photo (corners: the paper's top left,
 * top right, bottom right, bottom left).
 */
export function uprightTurn(corners: [number, number][]): 1 | -1 {
  const left = (corners[0][1] + corners[3][1]) / 2;
  const right = (corners[1][1] + corners[2][1]) / 2;
  return left <= right ? -1 : 1;
}

/** A print setting as saved (anything missing or broken: the default). */
export function printChoice(raw: unknown): PrintChoice {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<PrintChoice>;
  return {
    turn: o.turn === 1 ? 1 : -1,
    turnAuto: typeof o.turnAuto === 'boolean' ? o.turnAuto : true,
    skew: typeof o.skew === 'boolean' ? o.skew : DEFAULT_PRINT.skew,
    seed: Number.isFinite(o.seed) ? Number(o.seed) : DEFAULT_PRINT.seed,
    color: !!o.color,
    toner: Number.isFinite(o.toner) ? Math.min(1.6, Math.max(0.3, Number(o.toner))) : DEFAULT_PRINT.toner,
  };
}

/** How far a printer may turn the print, degrees, and shift it, mm. */
const MAX_TURN = 0.3;
const MAX_SHIFT = 1;

/** Three numbers in −1..1 from a seed: the same seed, the same skew. */
function skewOf(seed: number): [number, number, number] {
  let a = (Math.imul(seed | 0, 2654435761) ^ 0x9e3779b9) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
  return [next(), next(), next()];
}

/**
 * Sheet px of the blank's paper (`sheet`) → px of the photographed paper:
 * turned when one is landscape and the other is not, shrunk only if the paper
 * is smaller, shrunk as the printer does (`shrink`), centred, and turned and
 * shifted a little as printers do.
 */
export function printMatrix(sheet: SheetSize, paper: SheetSize, p: PrintChoice, shrink = 1): Mat3 {
  const turned = sheet.w > sheet.h !== paper.w > paper.h;
  // (x, y) from the sheet's centre → turned a quarter: the top to the left (−1) or right (1).
  const rot: Mat3 = turned ? (p.turn === -1 ? [0, 1, 0, -1, 0, 0, 0, 0, 1] : [0, -1, 0, 1, 0, 0, 0, 0, 1]) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [w, h] = turned ? [sheet.h, sheet.w] : [sheet.w, sheet.h];
  // The whole page shrunk by the printer (its blank, drawings and notes together).
  const k = Math.min(1, paper.w / w, paper.h / h) * shrink;
  const [t, dx, dy] = p.skew ? skewOf(p.seed) : [0, 0, 0];
  // The printer feeds the paper a little unevenly: one direction scaled 0.1–0.4 % off the other.
  const feed = p.skew ? 1 + Math.sign(dx || 1) * (0.001 + 0.003 * Math.abs(dy)) : 1;
  const a = (t * MAX_TURN * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return [
    [1, 0, paper.w / 2, 0, 1, paper.h / 2, 0, 0, 1],
    [c, -s, 0, s, c, 0, 0, 0, 1],
    [1, 0, dx * MAX_SHIFT * MM, 0, 1, dy * MAX_SHIFT * MM, 0, 0, 1],
    [k, 0, 0, 0, k * feed, 0, 0, 0, 1],
    rot,
    [1, 0, -sheet.w / 2, 0, 1, -sheet.h / 2, 0, 0, 1],
  ].reduce((m, n) => mul(m, n) as Mat3);
}

const coverages = new Map<string, Promise<ImageBitmap>>();

/**
 * The toner of a blank at the picture's own size: alpha — how much of the
 * paper it covers, colour — its colour where it does (black on a black and
 * white printer). The paper's white is no toner.
 */
function coverage(b: Blank, color: boolean): Promise<ImageBitmap> {
  const key = `${b.id}|${b.white}|${color}`;
  let hit = coverages.get(key);
  if (!hit) {
    hit = (async () => {
      const { data, w, h } = await pixels(b.image);
      const out = new ImageData(w, h);
      const white = b.white * 0.94;
      for (let i = 0; i < data.length; i += 4) {
        // How the paper would look printed (on white), then as coverage and colour.
        const g = Math.min(1, lum(data, i) / white);
        const P = color ? [0, 1, 2].map((c) => Math.min(1, data[i + c] / white)) : [g, g, g];
        const m = Math.min(P[0], P[1], P[2]);
        const a = 1 - m;
        for (let c = 0; c < 3; c++) out.data[i + c] = a > 1e-3 ? Math.round((255 * (P[c] - m)) / a) : 0;
        out.data[i + 3] = Math.round(255 * a);
      }
      return createImageBitmap(out);
    })();
    coverages.set(key, hit);
    hit.catch(() => coverages.delete(key));
  }
  return hit;
}

/** The blank's toner on its sheet (of `sheet` px), drawn `scale` times larger: the same raster as the ink's. */
export async function tonerRaster(b: Blank, color: boolean, sheet: SheetSize, scale: number): Promise<HTMLCanvasElement> {
  const bitmap = await coverage(b, color);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sheet.w * scale));
  canvas.height = Math.max(1, Math.round(sheet.h * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  const r = blankRect(b, sheet);
  const kx = canvas.width / sheet.w;
  const ky = canvas.height / sheet.h;
  ctx.drawImage(bitmap, r.x * kx, r.y * ky, r.w * kx, r.h * ky);
  return canvas;
}
