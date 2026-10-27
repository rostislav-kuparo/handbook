/// <reference lib="webworker" />
// Runs the Rust engine off the main thread so font rebuilds never block typing.
import init, { Engine } from '../../crates/glyph-core/pkg/glyph_core.js';
import { FONT_FAMILY } from './constants';

let engine: Engine;
const ready = init().then(() => {
  engine = new Engine();
  engine.setFamily(FONT_FAMILY);
});

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
      charStyles: { scales: number[]; colors: number[]; shifts?: number[]; seen?: Record<string, number>; skeleton?: boolean };
    };

self.onmessage = async (e: MessageEvent<{ id: number; req: EngineOp }>) => {
  await ready;
  const { id, req } = e.data;
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
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, ok: false, error: String(err) });
  }
};
