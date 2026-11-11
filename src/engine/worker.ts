/// <reference lib="webworker" />
// Runs the Rust engine off the main thread so font rebuilds never block typing.
import init, { Engine } from '../../crates/glyph-core/pkg/glyph_core.js';
import type { CharStyles } from './client';
import { FONT_FAMILY } from './constants';

let engine: Engine;
/** The engine once it is loaded; why not, when it could not be (told to every call instead of leaving it waiting). */
const ready: Promise<string | null> = init().then(
  () => {
    engine = new Engine();
    engine.setFamily(FONT_FAMILY);
    return null;
  },
  (err) => `Движок почерка не загрузился: ${String(err)}`,
);

/**
 * A crash inside the engine (a Rust panic, memory run out): it stays locked
 * after one, every later call failing too — the page starts a new worker.
 */
const crashed = (err: unknown) =>
  err instanceof WebAssembly.RuntimeError || /recursive use of an object|unreachable|null pointer passed to rust/i.test(String(err));

export type EngineOp =
  | { op: 'setStyle'; style: unknown }
  | { op: 'setSamples'; samples: unknown[] }
  | { op: 'buildFont' }
  | { op: 'info' }
  | { op: 'preview'; char: string; count: number; seed: number }
  | { op: 'sampleOutline'; sample: unknown }
  | {
      op: 'renderParagraph';
      text: string;
      width: number;
      lineHeight: number;
      seed: number;
      fallbackWidths: Record<string, number>;
      charStyles: CharStyles;
    };

self.onmessage = async (e: MessageEvent<{ id: number; req: EngineOp }>) => {
  const failed = await ready;
  const { id, req } = e.data;
  if (failed) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, ok: false, error: failed });
    return;
  }
  try {
    let result: unknown;
    const transfer: Transferable[] = [];
    switch (req.op) {
      case 'setStyle':
        engine.setStyle(JSON.stringify(req.style));
        break;
      case 'setSamples':
        engine.setSamples(JSON.stringify(req.samples));
        break;
      case 'buildFont': {
        const bytes = engine.buildFont();
        result = bytes;
        transfer.push(bytes.buffer);
        break;
      }
      case 'info':
        result = JSON.parse(engine.info());
        break;
      case 'preview':
        result = JSON.parse(engine.preview(req.char, req.count, req.seed));
        break;
      case 'sampleOutline':
        result = JSON.parse(engine.sampleOutline(JSON.stringify(req.sample)));
        break;
      case 'renderParagraph':
        result = JSON.parse(
          engine.renderParagraph(
            req.text,
            req.width,
            req.lineHeight,
            req.seed,
            JSON.stringify(req.fallbackWidths),
            JSON.stringify(req.charStyles),
          ),
        );
        break;
    }
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, ok: false, error: String(err), crashed: crashed(err) });
  }
};
