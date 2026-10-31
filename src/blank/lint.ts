// Checks of a drawing on a blank by the rules of descriptive geometry — what
// a teacher would see with a ruler: the two projections of a point on one
// linking line, points named as the task names them.
import { compileSketch } from '../sketch/evaluate';
import { formulaOf } from '../sketch/formula';
import type { Item, Shape } from '../sketch/types';

/** How far apart (mm) the projections of one point may be along the axis. */
const LINK = 0.3;

const plain = (label: string) => label.replace(/[{}]/g, '');

/** What is wrong in a drawing's commands, said for the check card (and for the neural net to mend). */
export function lintDrawing(code: string): string[] {
  if (formulaOf(code) !== null) return [];
  const scene = compileSketch(code);
  const unit = scene.view.blank?.unit ?? 1;
  const out: string[] = [];
  // Points of the sheet named as projections (A_1, A_2): the same x, on one linking line.
  const byName = new Map<string, { x: number; y: number }>();
  for (const it of scene.items) if (it.shape.type === 'point' && it.label) byName.set(plain(it.label), it.shape.p);
  for (const [name, p1] of byName) {
    const m = /^(.+)_1$/.exec(name);
    if (!m) continue;
    const p2 = byName.get(`${m[1]}_2`);
    if (!p2) continue;
    const gap = Math.abs(p1.x - p2.x) * unit;
    if (gap > LINK) out.push(`${m[1]}₁ и ${m[1]}₂ не на одной линии связи: разошлись на ${gap.toFixed(1).replace('.', ',')} мм — задай точку в пространстве (FromProjections) или выровняй x`);
  }
  const hatched = manualHatching(scene.items, unit, !!scene.view.epure);
  if (hatched) out.push(`штриховка нарисована отрезками (${hatched} шт.) — замени их одной командой Hatch(…)`);
  return out;
}

/** Parallel segments this close (mm) and this evenly spaced are hatching drawn by hand. */
const HATCH_GAP = 6;
const HATCH_MIN = 5;

/** How many visible segments make up hatching drawn line by line (0: none). */
function manualHatching(items: Item[], unit: number, epure: boolean): number {
  const segs = items.filter((it) => !it.hidden && it.shape.type === 'segment').map((it) => it.shape as Extract<Shape, { type: 'segment' }>);
  let most = 0;
  const used = new Set<number>();
  segs.forEach((s, i) => {
    if (used.has(i)) return;
    const dir = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
    // On an epure the linking lines stand side by side, perpendicular to the axis: not hatching.
    if (epure && Math.abs(Math.cos(dir)) < 0.03) return;
    const n = { x: -Math.sin(dir), y: Math.cos(dir) };
    // The same direction (a line has no front or back), within 2°.
    const family = segs
      .map((t, j) => ({ j, t }))
      .filter(({ t }) => {
        const d = (((Math.atan2(t.b.y - t.a.y, t.b.x - t.a.x) - dir) % Math.PI) + Math.PI) % Math.PI;
        return Math.min(d, Math.PI - d) < (2 * Math.PI) / 180;
      });
    if (family.length < HATCH_MIN) return;
    const offsets = family.map(({ t }) => (t.a.x * n.x + t.a.y * n.y) * unit).sort((p, q) => p - q);
    const gaps = offsets.slice(1).map((v, k) => v - offsets[k]);
    const mean = gaps.reduce((p, q) => p + q, 0) / gaps.length;
    const spread = Math.sqrt(gaps.reduce((p, q) => p + (q - mean) ** 2, 0) / gaps.length);
    if (mean > 0.2 && mean < HATCH_GAP && spread < mean * 0.3) {
      family.forEach(({ j }) => used.add(j));
      most = Math.max(most, family.length);
    }
  });
  return most;
}
