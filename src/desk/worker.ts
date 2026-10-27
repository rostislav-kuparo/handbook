/// <reference lib="webworker" />
// Looks at the desk photo off the main thread: finding the sheet and
// measuring 12 Mp of it takes a moment.
import init, { Desk } from '../../crates/desk-core/pkg/desk_core.js';

type Pt = [number, number];

export type AnalysisOp =
  | { op: 'setPhoto'; rgba: Uint8Array; width: number; height: number }
  | { op: 'findSheet' }
  | { op: 'snap'; corners: Pt[]; which: boolean[] }
  | { op: 'measure'; corners: Pt[]; sides: boolean[] }
  | { op: 'specular'; corners: Pt[]; scale: number }
  | { op: 'calibrate'; x: number; y: number; radius: number; sigma: number }
  | { op: 'ruling'; warp: unknown; wMm: number; hMm: number }
  | { op: 'curvedSides'; corners: Pt[] }
  | { op: 'bend'; warp: unknown; wMm: number; hMm: number; step: number; offset: number; slope: number; nx: number; ny: number }
  | { op: 'mask'; corners: Pt[]; wMm: number; hMm: number; scale: number };

const ready = init();
let desk: Desk | null = null;

self.onmessage = async (e: MessageEvent<{ id: number; req: AnalysisOp }>) => {
  await ready;
  const { id, req } = e.data;
  try {
    let result: unknown = null;
    const transfer: Transferable[] = [];
    if (req.op === 'setPhoto') {
      desk?.free();
      desk = new Desk(req.rgba, req.width, req.height);
    } else {
      if (!desk) throw new Error('фото ещё не загружено');
      switch (req.op) {
        case 'findSheet':
          result = JSON.parse(desk.findSheet());
          break;
        case 'snap':
          result = JSON.parse(desk.snap(JSON.stringify(req.corners), JSON.stringify(req.which)));
          break;
        case 'measure':
          result = JSON.parse(desk.measure(JSON.stringify(req.corners), JSON.stringify(req.sides)));
          break;
        case 'specular': {
          const bytes = desk.specularMap(JSON.stringify(req.corners), req.scale);
          if (bytes.length > 8) {
            const head = new DataView(bytes.buffer, bytes.byteOffset, 8);
            const rgba = bytes.slice(8);
            result = { width: head.getUint32(0, true), height: head.getUint32(4, true), rgba };
            transfer.push(rgba.buffer);
          }
          break;
        }
        case 'calibrate':
          result = JSON.parse(desk.calibrate(req.x, req.y, req.radius, req.sigma));
          break;
        case 'ruling':
          result = JSON.parse(desk.ruling(JSON.stringify(req.warp), req.wMm, req.hMm));
          break;
        case 'curvedSides':
          result = JSON.parse(desk.curvedSides(JSON.stringify(req.corners)));
          break;
        case 'bend':
          result = JSON.parse(desk.bend(JSON.stringify(req.warp), req.wMm, req.hMm, req.step, req.offset, req.slope, req.nx, req.ny));
          break;
        case 'mask': {
          const bytes = desk.objectMask(JSON.stringify(req.corners), req.wMm, req.hMm, req.scale);
          const head = new DataView(bytes.buffer, bytes.byteOffset, 12);
          const data = bytes.slice(12);
          result = { width: head.getUint32(0, true), height: head.getUint32(4, true), objects: head.getUint32(8, true), data };
          transfer.push(data.buffer);
          break;
        }
      }
    }
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, ok: false, error: String(err) });
  }
};
