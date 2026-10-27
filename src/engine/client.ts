import { fallbackWidths } from './fallbackMetrics';
import { getHandwriting } from './handwriting';
import type { EngineOp } from './worker';

export interface PreviewGlyph {
  d: string;
  advance: number;
  entry: [number, number] | null;
  exit: [number, number] | null;
}

export interface SampleOutline {
  d: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface ParagraphRender {
  width: number;
  height: number;
  lines: number;
  d: string;
  /** The same ink per line and colour index (same coordinates), to flow lines onto pages. */
  lineD: { color: number; d: string }[][];
  missing: string[];
  /** Centre lines of the strokes per line, when asked for (`CharStyles.skeleton`): flat x, y, radius, pressure. */
  lineSkel?: { color: number; pts: number[] }[][];
  /** Characters without handwriting: drawn with a fallback font at these baseline positions. */
  fallback: { ch: string; x: number; y: number; line: number; scale: number; color: number }[];
}

export interface EngineInfo {
  /** Keys written by the user. */
  chars: string[];
  /** Keys built automatically, and what from. */
  derived: { key: string; from: string }[];
  joinLow: number | null;
  joinHigh: number | null;
  /** Learned directions of variation per key. */
  learned: Record<string, number>;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, Pending>();
let nextId = 1;

worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
  const p = pending.get(e.data.id);
  if (!p) return;
  pending.delete(e.data.id);
  if (e.data.ok) p.resolve(e.data.result);
  else p.reject(new Error(e.data.error));
};

function call<T>(req: EngineOp): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker.postMessage({ id, req });
  });
}

/** Typed facade over the Rust engine running in a worker. */
/** Per-character look for the ink renderer (code point indices). */
export interface CharStyles {
  scales: number[];
  colors: number[];
  /** Raise above the baseline in em: superscripts > 0, subscripts < 0. */
  shifts?: number[];
  /** How often each word of the paragraph occurred earlier in the document (repeats get new letters). */
  seen?: Record<string, number>;
  /** Also return the strokes' centre lines with pressure (`lineSkel`). */
  skeleton?: boolean;
}

export const engine = {
  setStyle: (style: unknown) => call<void>({ op: 'setStyle', style }),
  setSamples: (samples: unknown[]) => call<void>({ op: 'setSamples', samples }),
  buildFont: () => call<Uint8Array>({ op: 'buildFont' }),
  info: () => call<EngineInfo>({ op: 'info' }),
  preview: (char: string, count: number, seed: number) =>
    call<PreviewGlyph[]>({ op: 'preview', char, count, seed }),
  sampleOutline: (sample: unknown) => call<SampleOutline>({ op: 'sampleOutline', sample }),
  /**
   * Ink rendering; widths of characters without samples are measured here, in the page.
   * `charStyles`: size factor, colour index and raise per character (code point), optional.
   */
  renderParagraph: (
    text: string,
    width: number,
    lineHeight: number,
    seed: number,
    charStyles: CharStyles = { scales: [], colors: [] },
  ) =>
    call<ParagraphRender>({
      op: 'renderParagraph',
      text,
      width,
      lineHeight,
      seed,
      fallbackWidths: fallbackWidths(text, (ch) => getHandwriting().byChar.has(ch)),
      charStyles,
    }),
};
