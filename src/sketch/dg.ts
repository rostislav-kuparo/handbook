// Constructions of descriptive geometry done exactly, as a textbook does
// them: the true length of a segment by a right triangle, its traces and the
// quarters it passes, the development of a pyramid. A neural net says what to
// build; how is done here, so a construction is never «almost» right.
import { projection } from './epure';
import type { Vec, Vec3 } from './types';

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
const len = (a: Vec) => Math.hypot(a.x, a.y);
export const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * The right triangle on plane `n` (1: П₁, 2: П₂) that gives segment AB's true
 * length: the projection A_nB_n, a leg at B_n as long as the difference of
 * the other coordinate (z on П₁, y on П₂), drawn away from the axis; the
 * hypotenuse A_nB₀ is the true length, the angle at A_n the inclination
 * (α to П₁, β to П₂).
 */
export function rightTriangle(a: Vec3, b: Vec3, n: 1 | 2, xRight: boolean): { an: Vec; bn: Vec; b0: Vec; length: number; angle: number } {
  const an = projection(a, n, xRight);
  const bn = projection(b, n, xRight);
  const leg = n === 1 ? Math.abs(b.z - a.z) : Math.abs(b.y - a.y);
  const base = sub(bn, an);
  const l = len(base);
  let perp: Vec = l > 1e-9 ? { x: -base.y / l, y: base.x / l } : { x: 0, y: n === 1 ? -1 : 1 };
  // П₁ lies below the axis, П₂ above: the leg goes away from it.
  if ((n === 1 && perp.y > 0) || (n === 2 && perp.y < 0)) perp = mul(perp, -1);
  const b0 = add(bn, mul(perp, leg));
  return { an, bn, b0, length: Math.hypot(l, leg), angle: (Math.atan2(leg, l) * 180) / Math.PI };
}

/** The inclination of AB to plane n, degrees (to П₁: by z; to П₂: by y). */
export function inclination(a: Vec3, b: Vec3, n: 1 | 2): number {
  const d = n === 1 ? Math.abs(b.z - a.z) : Math.abs(b.y - a.y);
  return (Math.asin(Math.min(1, d / Math.max(dist3(a, b), 1e-12))) * 180) / Math.PI;
}

/** Where the line AB meets П₁ (z = 0: the horizontal trace H) and П₂ (y = 0: the frontal trace F); null where it runs parallel. */
export function traces(a: Vec3, b: Vec3): { h: Vec3 | null; f: Vec3 | null } {
  const at = (t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
  const h = Math.abs(b.z - a.z) > 1e-9 ? at(-a.z / (b.z - a.z)) : null;
  const f = Math.abs(b.y - a.y) > 1e-9 ? at(-a.y / (b.y - a.y)) : null;
  return { h, f };
}

const QUARTER = (y: number, z: number) => (z >= 0 ? (y >= 0 ? 'I' : 'II') : y >= 0 ? 'IV' : 'III');

/** The quarters of space the line AB passes: «I, II, III». */
export function quarters(a: Vec3, b: Vec3): string[] {
  const { h, f } = traces(a, b);
  // Along the line: its parameters at the traces cut it into pieces, one quarter each.
  const t = (p: Vec3 | null) => {
    if (!p) return null;
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const dd = d.x * d.x + d.y * d.y + d.z * d.z;
    return ((p.x - a.x) * d.x + (p.y - a.y) * d.y + (p.z - a.z) * d.z) / dd;
  };
  const cuts = [t(h), t(f)].filter((v): v is number => v !== null).sort((p, q) => p - q);
  const probes = cuts.length ? [cuts[0] - 1, ...cuts.slice(1).map((c, i) => (c + cuts[i]) / 2), cuts[cuts.length - 1] + 1] : [0];
  const out: string[] = [];
  const order = ['I', 'II', 'III', 'IV'];
  for (const s of probes) {
    const y = a.y + (b.y - a.y) * s;
    const z = a.z + (b.z - a.z) * s;
    const q = QUARTER(y, z);
    if (!out.includes(q)) out.push(q);
  }
  // As they are named in an answer: «I, II, III».
  return out.sort((p, q) => order.indexOf(p) - order.indexOf(q));
}

/** The third corner of a triangle on base PQ with sides |PX| = rp, |QX| = rq, on the given side of PQ (1: left of P→Q, −1: right). */
function apex(p: Vec, q: Vec, rp: number, rq: number, side: 1 | -1): Vec {
  const d = len(sub(q, p));
  const a = (rp * rp - rq * rq + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, rp * rp - a * a));
  const u = mul(sub(q, p), 1 / d);
  const n = { x: -u.y, y: u.x };
  return add(add(p, mul(u, a)), mul(n, side * h));
}

/**
 * The development of pyramid SABC: the side faces one after another round S
 * (S′ at `at`, the edge S′A′ at `angle` degrees), every edge its true length,
 * and the base ABC on side A′B′, outside. Returns the points' places.
 */
export function unfold(s: Vec3, base: Vec3[], at: Vec, angle: number): { s: Vec; ring: Vec[]; base: Vec } {
  const rad = (angle * Math.PI) / 180;
  const ring: Vec[] = [add(at, mul({ x: Math.cos(rad), y: Math.sin(rad) }, dist3(s, base[0])))];
  for (let i = 1; i <= base.length; i++) {
    const v = base[i % base.length];
    const prev = base[i - 1];
    // Faces go round S the same way (clockwise on the sheet).
    ring.push(apex(at, ring[i - 1], dist3(s, v), dist3(prev, v), -1));
  }
  // The base on the first edge A′B′, away from S′.
  const [p, q] = [ring[0], ring[1]];
  const side = ((q.x - p.x) * (at.y - p.y) - (q.y - p.y) * (at.x - p.x)) > 0 ? -1 : 1;
  const third = apex(p, q, dist3(base[0], base[2]), dist3(base[1], base[2]), side);
  return { s: at, ring, base: third };
}
