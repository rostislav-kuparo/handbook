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
  /** The variants used last after this paragraph: pass it on to the next one (`CharStyles.deal`). */
  deal: Deal;
}

/**
 * Per letter, which of its written variants were used last (sample indices,
 * the most recent last). Carried through a text in reading order, it keeps
 * the same variant from turning up again and again.
 */
export type Deal = Record<string, number[]>;

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

type Pending = { req: EngineOp; resolve: (v: unknown) => void; reject: (e: Error) => void };
type Reply = { id: number; ok: boolean; result?: unknown; error?: string; crashed?: boolean };

const pending = new Map<number, Pending>();
let nextId = 1;
/** What the engine was last given: a worker started after a crash gets it again (ids below zero). */
const state: { style: EngineOp | null; samples: EngineOp | null } = { style: null, samples: null };
const STYLE_ID = -1;
const SAMPLES_ID = -2;

function failAll(error: Error) {
  for (const p of pending.values()) p.reject(error);
  pending.clear();
}

function spawn(): Worker {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<Reply>) => {
    // A worker already replaced may still have answers on their way.
    if (w !== worker) return;
    const { id, ok, result, error, crashed } = e.data;
    const p = pending.get(id);
    pending.delete(id);
    if (crashed) restart(id, p?.req);
    if (!p) return;
    if (ok) p.resolve(result);
    else p.reject(new Error(error));
  };
  // The worker itself failed (its script or the engine did not load): nothing waits for ever.
  w.onerror = (e) => {
    console.error('engine worker', e.message);
    if (w === worker) failAll(new Error(e.message || 'Движок почерка не запустился'));
  };
  w.onmessageerror = () => {
    if (w === worker) failAll(new Error('Движок почерка ответил непонятно'));
  };
  return w;
}

let worker = spawn();

/**
 * The engine crashed on the call `id`: after a crash it answers nothing, so a
 * new worker takes over — with the style and samples of the old one, and the
 * calls still waiting. What crashed it is not given again.
 */
function restart(id: number, culprit: EngineOp | undefined) {
  console.error('engine crashed, restarting', culprit?.op ?? id);
  if (id === STYLE_ID || culprit?.op === 'setStyle') state.style = null;
  if (id === SAMPLES_ID || culprit?.op === 'setSamples') state.samples = null;
  worker.terminate();
  worker = spawn();
  if (state.style) worker.postMessage({ id: STYLE_ID, req: state.style });
  if (state.samples) worker.postMessage({ id: SAMPLES_ID, req: state.samples });
  for (const [waiting, p] of pending) worker.postMessage({ id: waiting, req: p.req });
}

function call<T>(req: EngineOp): Promise<T> {
  const id = nextId++;
  if (req.op === 'setStyle') state.style = req;
  if (req.op === 'setSamples') state.samples = req;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { req, resolve: resolve as (v: unknown) => void, reject });
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
  /** The previous paragraph's `deal` (none: the start of the text). */
  deal?: Deal;
  /** Where lines start (code points), as the editor broke them; empty: the engine breaks by width. */
  breaks?: number[];
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
