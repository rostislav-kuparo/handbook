// Descriptive geometry: figures in space drawn the way textbooks draw them —
// as an epure (Monge's method). Every point gets its projections on the
// horizontal (П₁), frontal (П₂) and, when asked, profile (П₃) planes, joined
// by thin linking lines. The axes are drawn by the layout.
import type { Item, Scene, Shape, SpaceKind, Vec, Vec3 } from './types';

/**
 * Where a point of space lands on the sheet. As in textbooks, x runs left
 * from the origin O along the axis x₁₂, y towards the viewer (down on П₁,
 * right on П₃), z up.
 */
export function projection(p: Vec3, plane: number, xRight: boolean): Vec {
  const sx = xRight ? 1 : -1;
  if (plane === 1) return { x: sx * p.x, y: -p.y };
  if (plane === 2) return { x: sx * p.x, y: p.z };
  return { x: -sx * p.y, y: p.z };
}

function mix(a: number, b: number): number {
  return Math.imul(a ^ b, 16777619) >>> 0;
}

/** The name of a projection: A → A₁, A_x → A_x1, A' → A′₁. */
function indexed(name: string, plane: number): string {
  const m = /^([^_]*)(?:_\{?([^}]*)\}?)?$/.exec(name);
  if (!m) return `${name}_{${plane}}`;
  return `${m[1]}_{${m[2] ?? ''}${plane}}`;
}

/** The projection of a figure; a line seen end-on is a point. */
function flat(of: SpaceKind, pts: Vec[]): Shape {
  if (of === 'polygon') return { type: 'polygon', pts };
  const [a, b] = pts;
  if (of === 'point' || Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) return { type: 'point', p: a };
  return { type: of, a, b };
}

/** Replaces figures in space by their projections; marks the scene as an epure. */
export function projectSpace(scene: Scene): void {
  if (!scene.items.some((it) => it.shape.type === 'space')) return;
  const planes = [...new Set(scene.view.planes ?? [1, 2])].filter((k) => k >= 1 && k <= 3).sort();
  const xRight = !!scene.view.xRight;
  const sx = xRight ? 1 : -1;
  const out: Item[] = [];
  for (const it of scene.items) {
    const s = it.shape;
    if (s.type !== 'space') {
      out.push(it);
      continue;
    }
    if (s.of === 'point') {
      const p = s.pts[0];
      const at = (k: number) => projection(p, k, xRight);
      // Thin linking lines go first, so the points lie on top of them.
      const link = (a: Vec, b: Vec, salt: number): Item => ({
        ...it,
        shape: { type: 'segment', a, b },
        name: undefined,
        label: undefined,
        caption: undefined,
        showLabel: false,
        color: undefined,
        lineStyle: 0,
        thickness: 2,
        filling: 0,
        seed: mix(it.seed, salt),
      });
      const has = (k: number) => planes.includes(k);
      if (has(1) && has(2)) out.push(link(at(2), at(1), 101));
      if (has(3) && has(2)) out.push(link(at(2), at(3), 102));
      if (has(3) && has(1)) {
        // From П₁ across to the constant line at 45°, then up to П₃.
        const turn = { x: -sx * p.y, y: -p.y };
        out.push(link(at(1), turn, 103), link(turn, at(3), 104));
      }
    }
    for (const k of planes) {
      out.push({
        ...it,
        shape: flat(s.of, s.pts.map((q) => projection(q, k, xRight))),
        label: it.label && indexed(it.label, k),
        caption: it.caption && indexed(it.caption, k),
        seed: mix(it.seed, k),
      });
    }
  }
  scene.items = out;
  scene.view.planes = planes;
  scene.view.epure = true;
}
