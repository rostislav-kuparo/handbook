// What the photo itself tells: where the sheet is, how blurred and noisy the
// picture is, where the lamp burns the paper out, what colour a real pen
// writes. The Rust analysis (crates/desk-core) runs in its own worker.
import type { Pt } from './homography';
import type { Photo } from './photo';
import type { Grid, Warp } from './warp';
import type { AnalysisOp } from './worker';

export interface Found {
  corners: Pt[];
  /** 0..1: how cleanly the bright region (or the printed lines) make a sheet. */
  confidence: number;
  snapped: boolean[];
  /** A scan: the sheet fills the whole frame (no perspective, no edges). */
  scan: boolean;
}

export interface Snapped {
  corners: Pt[];
  snapped: boolean[];
  rms: (number | null)[];
}

/** The camera's grain: variance a·L + b per channel in linear light, shared by the channels as `rho`, smeared over `smooth` px. */
export interface Noise {
  a: number[];
  b: number[];
  rho: number;
  smooth: number;
  tiles: number;
}

export interface Measure {
  /** Blur at the top, right, bottom and left edge of the sheet (Gaussian sigma, px), null where unreadable. */
  sides: (number | null)[];
  sigma: number | null;
  /** Unsharp-mask amount (radius 1.2 px) the phone added. */
  sharpen: number;
  noise: Noise | null;
  /** Blur and sharpening were read on at least two edges of the sheet (otherwise they are unknown). */
  reliable: boolean;
}

/** Glare reflected off the paper, linear light ×255, a few times smaller than the photo. */
export interface Specular {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface Calib {
  /** Transmittance of the real pen's ink per channel. */
  t: number[];
  /** Stroke width, photo px. */
  width: number;
  pixels: number;
}

/** Margin lines, mm: vertical ones where they cross the top edge (from the left), horizontal ones where they cross the left edge (from the top). */
export interface Margins {
  left: number | null;
  right: number | null;
  top: number | null;
  bottom: number | null;
}

export const NO_MARGINS: Margins = { left: null, right: null, top: null, bottom: null };

/** A notebook's printed lines, mm on the sheet: rows at y = offset + k·step + x·slope. */
export interface Ruling {
  kind: 'ruled' | 'grid';
  step: number;
  /** Squares: the distance between columns. Squares are square, so it tells the paper's real width from the assumed one. */
  colStep: number | null;
  offset: number;
  slope: number;
  /** Squares: columns at x = colOffset + k·colStep − y·slope. */
  colOffset: number | null;
  margins: Margins;
  strength: number;
}

/** Where things lie on the sheet: 255 — free paper, 0 — under an object; `scale` times smaller than the photo. */
export interface ObjectMask {
  width: number;
  height: number;
  /** Objects found (before any brushing). */
  objects: number;
  data: Uint8Array;
}

/** The sheet's edges as curves: where they meet, and how each side bows from its chord (cubic, px outward). */
export interface Curved {
  corners: Pt[];
  bulge: number[][];
  /** The largest bow, px. */
  max: number;
  fitted: boolean[];
}

/** Corrections that make the printed lines run straight, and how far they strayed before and after (RMS, mm). */
export interface BendFit {
  grid: Grid;
  before: number;
  after: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class Analyzer {
  private readonly worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, Pending>();
  private next = 1;
  /** Which photo the worker holds (it keeps one at a time). */
  private holds: { id: string; ready: Promise<void> } | null = null;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
  }

  private call<T>(req: AnalysisOp, transfer: Transferable[] = []): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, req }, transfer);
    });
  }

  /** Makes the worker look at this photo, handing its pixels over when it holds another one. */
  use(id: string, photo: Photo): Promise<void> {
    if (this.holds?.id !== id) {
      const ctx = new OffscreenCanvas(photo.width, photo.height).getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(photo.bitmap, 0, 0);
      const rgba = new Uint8Array(ctx.getImageData(0, 0, photo.width, photo.height).data.buffer);
      this.holds = { id, ready: this.call({ op: 'setPhoto', rgba, width: photo.width, height: photo.height }, [rgba.buffer]) };
    }
    return this.holds.ready;
  }

  findSheet = () => this.call<Found | null>({ op: 'findSheet' });
  snap = (corners: Pt[], which: boolean[]) => this.call<Snapped>({ op: 'snap', corners, which });
  /** `sides`: those lying on a found edge — blur is read only there. */
  measure = (corners: Pt[], sides: boolean[]) => this.call<Measure>({ op: 'measure', corners, sides });
  specular = (corners: Pt[], scale = 4) => this.call<Specular | null>({ op: 'specular', corners, scale });
  calibrate = (x: number, y: number, radius: number, sigma: number) => this.call<Calib | null>({ op: 'calibrate', x, y, radius, sigma });
  ruling = (warp: Warp, wMm: number, hMm: number) => this.call<Ruling | null>({ op: 'ruling', warp, wMm, hMm });
  curvedSides = (corners: Pt[]) => this.call<Curved>({ op: 'curvedSides', corners });
  bend = (warp: Warp, wMm: number, hMm: number, r: Ruling, nx: number, ny: number) =>
    this.call<BendFit>({ op: 'bend', warp, wMm, hMm, step: r.step, offset: r.offset, slope: r.slope, nx, ny });
  mask = (corners: Pt[], wMm: number, hMm: number, scale = 2) => this.call<ObjectMask>({ op: 'mask', corners, wMm, hMm, scale });

  dispose() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('закрыто'));
    this.pending.clear();
  }
}
