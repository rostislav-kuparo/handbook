// How the camera saw the sheet, when the photo itself does not say: a photo
// of a clean sheet that fills the frame shows no edges, so nothing tells how
// the phone was held — and a sheet taken as exactly square to the camera
// gives a print as straight as the file it came from. Then the camera's
// tilt is read off the photo's straight lines when it has any (analysis
// `perspective`), set by hand, or made up: tilted a little as a hand holds a
// phone; its lens bends lines a little towards the frame's edges, the paper
// is not quite flat — waving as the light on the photo shows it. Only the
// printing and the ink go through it; the photo stays as it is.
import { apply, homography, invert, isConvexClockwise, mul, type Mat3, type Pt } from './homography';
import type { Photo } from './photo';

/** How the photo was taken: as a photo of a sheet, or by a scanner app (flat light, straight sheet); `auto`: as it looks. */
export type CaptureMode = 'auto' | 'photo' | 'scan';

export interface Capture {
  mode: CaptureMode;
  /** Which made-up camera (another number: another tilt). */
  seed: number;
}

export const DEFAULT_CAPTURE: Capture = { mode: 'auto', seed: 1 };

export function captureOf(raw: unknown): Capture {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Capture>;
  return {
    mode: o.mode === 'photo' || o.mode === 'scan' ? o.mode : 'auto',
    seed: Number.isFinite(o.seed) ? Number(o.seed) : 1,
  };
}

/** The sheet's corners are the photo's own: it fills the frame, its edges are not in the picture. */
export function fillsFrame(corners: Pt[], w: number, h: number): boolean {
  const frame: Pt[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const tol = 0.025 * Math.max(w, h);
  return corners.every((c) => frame.some((f) => Math.hypot(c[0] - f[0], c[1] - f[1]) < tol));
}

const random = (seed: number) => {
  let a = (Math.imul(seed | 0, 2654435761) ^ 0x51ed27) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
};

/** The photo's paper as a small grey picture: its brightness in a grid over the sheet (u, v in 0..1). */
function brightness(photo: Photo, corners: Pt[], n = 32): number[][] {
  const side = 256;
  const k = side / Math.max(photo.width, photo.height);
  const cw = Math.max(1, Math.round(photo.width * k));
  const ch = Math.max(1, Math.round(photo.height * k));
  const ctx = new OffscreenCanvas(cw, ch).getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(photo.bitmap, 0, 0, cw, ch);
  const data = ctx.getImageData(0, 0, cw, ch).data;
  const h = homography(
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    corners,
  );
  const out: number[][] = [];
  for (let j = 0; j < n; j++) {
    const row: number[] = [];
    for (let i = 0; i < n; i++) {
      const [u, v] = [(i + 0.5) / n, (j + 0.5) / n];
      const w = h[6] * u + h[7] * v + h[8];
      const x = Math.min(cw - 1, Math.max(0, Math.round(((h[0] * u + h[1] * v + h[2]) / w) * k)));
      const y = Math.min(ch - 1, Math.max(0, Math.round(((h[3] * u + h[4] * v + h[5]) / w) * k)));
      const p = (y * cw + x) * 4;
      row.push(0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]);
    }
    out.push(row);
  }
  return out;
}

/**
 * Where the light comes from on the photographed paper (its uv, y down): the
 * way the paper gets brighter, or null when it is lit evenly.
 */
export function lightFrom(photo: Photo, corners: Pt[]): { x: number; y: number } | null {
  const n = 16;
  const b = brightness(photo, corners, n);
  let gx = 0;
  let gy = 0;
  let mean = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n - 0.5;
      const v = (j + 0.5) / n - 0.5;
      gx += b[j][i] * u;
      gy += b[j][i] * v;
      mean += b[j][i];
    }
  }
  mean /= n * n;
  // Least squares slope of a plane over the cells (Σu² = n²/12 per axis).
  const k = 12 / (n * n);
  gx *= k;
  gy *= k;
  if (Math.hypot(gx, gy) < 0.03 * Math.max(mean, 1)) return null;
  return { x: gx, y: gy };
}

/** How unevenly the paper is lit: the spread of its brightness (5th to 95th percentile) against the mean. */
export function lightSpread(photo: Photo, corners: Pt[]): number {
  const all = brightness(photo, corners, 24).flat().sort((a, b) => a - b);
  const mean = all.reduce((s, v) => s + v, 0) / all.length;
  return (all[Math.floor(all.length * 0.95)] - all[Math.floor(all.length * 0.05)]) / Math.max(mean, 1);
}

/**
 * A turn of the camera, degrees: up or down (`pitch`; > 0: the sheet's
 * bottom further away), sideways (`yaw`; > 0: its left side further away)
 * and round (`roll`).
 */
export interface Angles {
  pitch: number;
  yaw: number;
  roll: number;
}

/** A tilt found with at least this confidence is used without asking. */
export const SURE_TILT = 0.55;
/** A tilt smaller than this, degrees, is a sheet square to the camera. */
export const FLAT_TILT = 0.7;

/** The focal length in photo px: the 35 mm equivalent over a full frame's diagonal (43.3 mm); a phone's main lens (26 mm) when unknown. */
export const focalPx = (w: number, h: number, focal35?: number | null) => ((focal35 || 26) / 43.27) * Math.hypot(w, h);

const DEG = Math.PI / 180;

/** R = Rz(roll) · Ry(yaw) · Rx(pitch), row-major: its columns are the sheet's right, down and normal in the camera's axes. */
export function rotOf({ pitch, yaw, roll }: Angles): Mat3 {
  const [cp, sp, cy, sy, cr, sr] = [Math.cos(pitch * DEG), Math.sin(pitch * DEG), Math.cos(yaw * DEG), Math.sin(yaw * DEG), Math.cos(roll * DEG), Math.sin(roll * DEG)];
  const Rx: Mat3 = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const Ry: Mat3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const Rz: Mat3 = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
  return mul(Rz, mul(Ry, Rx));
}

/** The angles of a turn made as `rotOf` makes it. */
export const anglesOf = (r: Mat3): Angles => ({
  pitch: Math.atan2(r[7], r[8]) / DEG,
  yaw: -Math.asin(Math.max(-1, Math.min(1, r[6]))) / DEG,
  roll: Math.atan2(r[3], r[0]) / DEG,
});

/** How far the sheet leans from square to the camera, degrees. */
export const tiltOf = (r: Mat3) => Math.acos(Math.max(-1, Math.min(1, r[8]))) / DEG;

/** The turn in words: «верх листа дальше на 6°, левый край — на 2°, повёрнут на 1°». */
export function describeTilt(a: Angles): string {
  const n = (v: number) => `${Math.round(Math.abs(v))}°`;
  const parts: string[] = [];
  if (Math.abs(a.pitch) >= 0.5) parts.push(`${a.pitch < 0 ? 'верх' : 'низ'} листа дальше на ${n(a.pitch)}`);
  if (Math.abs(a.yaw) >= 0.5) parts.push(`${a.yaw > 0 ? 'левый' : 'правый'} край дальше на ${n(a.yaw)}`);
  if (Math.abs(a.roll) >= 0.5) parts.push(`повёрнут на ${n(a.roll)}`);
  return parts.length ? parts.join(', ') : 'лист снят прямо';
}

/** The made-up turn of a hand holding a phone: 2–7° up or down, 1–4° sideways, up to 1.5° round. */
const drawAngles = (r: () => number): Angles => {
  const sign = (v: number) => (v < 0 ? -1 : 1);
  return { pitch: sign(r()) * (2 + 5 * Math.abs(r())), yaw: sign(r()) * (1 + 3 * Math.abs(r())), roll: r() * 1.5 };
};

/** The made-up camera's turn for `seed`. */
export const madeUpAngles = (seed: number) => drawAngles(random(seed));

/**
 * The camera for a sheet that fills the frame: turned by `turn` (found on
 * the photo or set by hand; made up by `seed` when missing), as a pure
 * rotation of a camera of `focal` px (a phone's main lens when missing). The
 * sheet then lies in the frame as a slightly uneven four-sided figure, a few
 * per cent in from the edges (the rest of the frame is the same paper) —
 * never cut off.
 */
export function cameraCorners(corners: Pt[], w: number, h: number, seed: number, turn?: Mat3 | null, focal?: number): Pt[] {
  const r = random(seed);
  const made = drawAngles(r);
  const f = focal ?? focalPx(w, h);
  const [cx, cy] = [w / 2, h / 2];
  // The image moves by K R K⁻¹.
  const K: Mat3 = [f, 0, cx, 0, f, cy, 0, 0, 1];
  const Ki: Mat3 = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
  const H = mul(K, mul(turn ?? rotOf(made), Ki));
  const moved = corners.map(([x, y]): Pt => {
    const q = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / q, (H[3] * x + H[4] * y + H[5]) / q];
  });
  // Into the frame, a few per cent in from its edges, not centred exactly.
  const xs = moved.map((p) => p[0]);
  const ys = moved.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const margin = (0.015 + 0.02 * Math.abs(r())) * Math.max(w, h);
  const k = Math.min((w - 2 * margin) / (x1 - x0), (h - 2 * margin) / (y1 - y0));
  const [bw, bh] = [(x1 - x0) * k, (y1 - y0) * k];
  const ox = (w - bw) / 2 + r() * ((w - bw) / 2 - margin * 0.5);
  const oy = (h - bh) / 2 + r() * ((h - bh) / 2 - margin * 0.5);
  return moved.map(([x, y]): Pt => [ox + (x - x0) * k, oy + (y - y0) * k]);
}

type V3 = [number, number, number];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Whether a four-sided figure in the photo lies in the plane of a turn: the
 * plane its opposite sides' vanishing points make, against the turn's
 * normal, within `tol` degrees — however the sheet lies turned on the desk.
 */
export function inPlaneOf(corners: Pt[], turn: Mat3, w: number, h: number, focal: number, tol = 6): boolean {
  const ray = ([x, y]: Pt): V3 => [(x - w / 2) / focal, (y - h / 2) / focal, 1];
  const side = (a: Pt, b: Pt) => cross3(ray(a), ray(b));
  const [c0, c1, c2, c3] = corners;
  const n = cross3(cross3(side(c0, c1), side(c3, c2)), cross3(side(c0, c3), side(c1, c2)));
  const len = Math.hypot(...n);
  if (!(len > 0)) return false;
  const cos = Math.abs(n[0] * turn[2] + n[1] * turn[5] + n[2] * turn[8]) / len;
  return cos >= Math.cos(tol * DEG);
}

/** Sheet (u, v) → photo for a turn: K · [right down t], the sheet's middle on the lens's axis. */
const planeOf = (turn: Mat3, w: number, h: number, focal: number): Mat3 =>
  mul([focal, 0, w / 2, 0, focal, h / 2, 0, 0, 1], [turn[0], turn[1], 0, turn[3], turn[4], 0, turn[6], turn[7], 1]);

/** A photo point on the plane, or null beyond its horizon. */
function onPlane(back: Mat3, [x, y]: Pt): Pt | null {
  const q = back[6] * x + back[7] * y + back[8];
  return q > 1e-9 ? [(back[0] * x + back[1] * y + back[2]) / q, (back[3] * x + back[4] * y + back[5]) / q] : null;
}

/** Where two lines (each through two points) cross, or null when they run parallel. */
function meet([a, b]: [Pt, Pt], [c, d]: [Pt, Pt]): Pt | null {
  const [rx, ry, sx, sy] = [b[0] - a[0], b[1] - a[1], d[0] - c[0], d[1] - c[1]];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  return [a[0] + rx * t, a[1] + ry * t];
}

/**
 * A sheet turned by `turn` that covers the whole frame: the rectangle along
 * its axes, as small as holds every corner of the photo, in the photo (its
 * corners mostly outside the frame). Null when the turn looks along the desk.
 */
export function coverCorners(turn: Mat3, w: number, h: number, focal: number): Pt[] | null {
  const M = planeOf(turn, w, h, focal);
  const back = invert(M);
  const onSheet: Pt[] = [];
  for (const [x, y] of [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ]) {
    const q = back[6] * x + back[7] * y + back[8];
    if (q <= 1e-9) return null;
    onSheet.push([(back[0] * x + back[1] * y + back[2]) / q, (back[3] * x + back[4] * y + back[5]) / q]);
  }
  const us = onSheet.map((p) => p[0]);
  const vs = onSheet.map((p) => p[1]);
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  return (
    [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ] as Pt[]
  ).map(([u, v]): Pt => {
    const q = M[6] * u + M[7] * v + M[8];
    return [(M[0] * u + M[1] * v + M[2]) / q, (M[3] * u + M[4] * v + M[5]) / q];
  });
}

/**
 * Sides (top, right, bottom, left) that are not on a found edge and run
 * along the photo's border (or beyond it): the sheet goes on past the photo
 * there.
 */
export function sidesBeyond(corners: Pt[], snapped: boolean[], w: number, h: number): boolean[] {
  const tol = 0.02 * Math.max(w, h);
  // How far inside the frame from its top, right, bottom and left border.
  const inside = ([x, y]: Pt) => [y, w - x, h - y, x];
  return [0, 1, 2, 3].map((k) => {
    const [a, b] = [inside(corners[k]), inside(corners[(k + 1) % 4])];
    return !snapped[k] && [0, 1, 2, 3].some((e) => a[e] < tol && b[e] < tol);
  });
}

/**
 * The corners of a sheet only partly in the photo: its seen sides stay where
 * they are; the sides beyond the frame are drawn in the plane the turn
 * shows, along the sheet's axes, far enough out to hold the whole frame — and
 * further when the paper's proportions (`paper`, mm: its top side, then its
 * height) need it. Null when nothing is beyond or seen, or when the seen
 * sides do not lie as the turn says they should.
 */
export function completeCorners(corners: Pt[], snapped: boolean[], turn: Mat3, w: number, h: number, focal: number, paper: [number, number]): Pt[] | null {
  const beyond = sidesBeyond(corners, snapped, w, h);
  const seen = [0, 1, 2, 3].filter((k) => snapped[k] && !beyond[k]);
  if (!seen.length || !beyond.some(Boolean)) return null;
  const M = planeOf(turn, w, h, focal);
  const back = invert(M);
  const flat = corners.map((c) => onPlane(back, c));
  if (flat.some((c) => !c)) return null;
  const q = flat as Pt[];
  // The sheet's own turn in the plane, from its seen sides (top and bottom along u, the others along v).
  const angleOf = (k: number) => {
    const [a, b] = [q[k], q[(k + 1) % 4]];
    return Math.atan2(b[1] - a[1], b[0] - a[0]) - (k % 2 ? Math.PI / 2 : 0);
  };
  let [sx, sy] = [0, 0];
  for (const k of seen) {
    const len = Math.hypot(q[(k + 1) % 4][0] - q[k][0], q[(k + 1) % 4][1] - q[k][1]);
    sx += Math.cos(2 * angleOf(k)) * len;
    sy += Math.sin(2 * angleOf(k)) * len;
  }
  const th = Math.atan2(sy, sx) / 2;
  // Seen sides more than 4° off the sheet's axes: the turn is not this sheet's.
  const off = (a: number) => Math.abs(Math.atan2(Math.sin(2 * (a - th)), Math.cos(2 * (a - th)))) / 2;
  if (seen.some((k) => off(angleOf(k)) > 4 * DEG)) return null;
  const [c, s] = [Math.cos(th), Math.sin(th)];
  const along = ([u, v]: Pt): Pt => [u * c + v * s, -u * s + v * c];
  const toPhoto = ([u, v]: Pt): Pt => apply(M, [u * c - v * s, u * s + v * c]);
  const frame = (
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ] as Pt[]
  ).map((p) => onPlane(back, p));
  if (frame.some((p) => !p)) return null;
  const f = (frame as Pt[]).map(along);
  const a = q.map(along);
  // Each side's place across the sheet's axes (v for the top and bottom, u for the sides) and which way is out.
  const axis = (k: number) => 1 - (k % 2);
  const level = [0, 1, 2, 3].map((k) => (a[k][axis(k)] + a[(k + 1) % 4][axis(k)]) / 2);
  const out = [0, 1, 2, 3].map((k) => Math.sign(level[k] - level[(k + 2) % 4]) || (k < 2 ? -1 : 1));
  for (let k = 0; k < 4; k++) {
    if (beyond[k]) level[k] = Math.max(level[k] * out[k], ...f.map((p) => p[axis(k)] * out[k])) * out[k];
  }
  // The paper's proportions: the missing length goes to the sides beyond the frame.
  const [W, H] = [Math.abs(level[1] - level[3]), Math.abs(level[2] - level[0])];
  const grow = (pair: number[], by: number) => {
    const free = pair.filter((k) => beyond[k]);
    for (const k of free) level[k] += (out[k] * by) / free.length;
  };
  const tall = W * (paper[1] / paper[0]);
  if (H < tall) grow([0, 2], tall - H);
  else grow([1, 3], H * (paper[0] / paper[1]) - W);
  // Each side as a line in the photo: seen ones as they are, the rest along the sheet's axes.
  const line = (k: number): [Pt, Pt] => {
    if (!beyond[k]) return [corners[k], corners[(k + 1) % 4]];
    return k % 2 ? [toPhoto([level[k], 0]), toPhoto([level[k], 1])] : [toPhoto([0, level[k]]), toPhoto([1, level[k]])];
  };
  const done: Pt[] = [];
  for (let k = 0; k < 4; k++) {
    const p = meet(line((k + 3) % 4), line(k));
    if (!p) return null;
    done.push(p);
  }
  return isConvexClockwise(done) ? done : null;
}

/**
 * The camera's turn from lines drawn on the photo along the sheet's two
 * directions: `lines[0]` and `lines[1]` across it (its rows, its top), the
 * other two down it (its margins, its sides) — as [ax, ay, bx, by] px. Each
 * pair meets at a vanishing point: a direction in the camera's space. Null
 * when the pairs do not make two directions about square to each other.
 */
export function turnByLines(lines: number[][], w: number, h: number, focal: number): Mat3 | null {
  const ray = (x: number, y: number): V3 => [(x - w / 2) / focal, (y - h / 2) / focal, 1];
  const unit = (v: V3): V3 | null => {
    const l = Math.hypot(...v);
    return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null;
  };
  const plane = (l: number[]) => cross3(ray(l[0], l[1]), ray(l[2], l[3]));
  let x = unit(cross3(plane(lines[0]), plane(lines[1])));
  let y = unit(cross3(plane(lines[2]), plane(lines[3])));
  if (!x || !y) return null;
  if (x[0] < 0) x = [-x[0], -x[1], -x[2]];
  if (y[1] < 0) y = [-y[0], -y[1], -y[2]];
  // Lines on a sheet are square to each other: more than 20° off, they were not put along it.
  if (Math.abs(x[0] * y[0] + x[1] * y[1] + x[2] * y[2]) > Math.sin(20 * DEG)) return null;
  // Squared up, the error shared equally.
  const a = unit([x[0] + y[0], x[1] + y[1], x[2] + y[2]])!;
  const b = unit([x[0] - y[0], x[1] - y[1], x[2] - y[2]])!;
  x = unit([a[0] + b[0], a[1] + b[1], a[2] + b[2]])!;
  y = unit([a[0] - b[0], a[1] - b[1], a[2] - b[2]])!;
  let z = cross3(x, y);
  if (z[2] < 0) {
    y = [-y[0], -y[1], -y[2]];
    z = [-z[0], -z[1], -z[2]];
  }
  const r: Mat3 = [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
  return tiltOf(r) <= 60 ? r : null;
}

/**
 * Lines to start drawing from: of the lines found on the photo, the longest
 * two far enough apart in each direction; without them, lines across and
 * down the marked sheet.
 */
export function startLines(found: number[][] | null | undefined, corners: Pt[], w: number, h: number): number[][] {
  const m = homography(
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    corners,
  );
  const inFrame = ([x, y]: Pt): Pt => [Math.min(w, Math.max(0, x)), Math.min(h, Math.max(0, y))];
  const onSheet = (u0: number, v0: number, u1: number, v1: number) => [...inFrame(apply(m, [u0, v0])), ...inFrame(apply(m, [u1, v1]))];
  const fallback = [onSheet(0.15, 0.3, 0.85, 0.3), onSheet(0.15, 0.7, 0.85, 0.7), onSheet(0.3, 0.15, 0.3, 0.85), onSheet(0.7, 0.15, 0.7, 0.85)];
  const len = (l: number[]) => Math.hypot(l[2] - l[0], l[3] - l[1]);
  const apart = 0.15 * Math.min(w, h);
  const out: number[][] = [];
  for (const fam of [0, 1]) {
    const mine = (found ?? []).filter((l) => l[4] === fam).sort((p, q) => len(q) - len(p));
    const [first] = mine;
    // How far a line's middle lies from the first one.
    const from = (l: number[]) => Math.abs((((l[0] + l[2]) / 2 - first[0]) * (first[3] - first[1]) - ((l[1] + l[3]) / 2 - first[1]) * (first[2] - first[0])) / len(first));
    const second = first && mine.find((l) => from(l) > apart);
    out.push(...(first && second ? [first.slice(0, 4), second.slice(0, 4)] : fallback.slice(2 * fam, 2 * fam + 2)));
  }
  return out;
}

/**
 * The made-up camera's lens: a little barrel distortion round the frame's
 * middle (k₁ from −0.01 to −0.03 at the frame's corner), bending long lines
 * near the edges as a phone's lens leaves them.
 */
export function lensOf(w: number, h: number, seed: number): (p: Pt) => Pt {
  const r = random(seed * 7 + 3);
  const k1 = -(0.01 + 0.02 * Math.abs(r()));
  const [cx, cy] = [w / 2, h / 2];
  const R2 = cx * cx + cy * cy;
  return ([x, y]) => {
    const [dx, dy] = [x - cx, y - cy];
    const s = 1 + (k1 * (dx * dx + dy * dy)) / R2;
    return [cx + dx * s, cy + dy * s];
  };
}

/**
 * The paper not lying quite flat, read off the light on it: on a clean sheet
 * the slow changes of brightness beyond the even fall of the light (a
 * tilted plane) are the paper's own waves. Their profile across the light's
 * direction moves the printing sideways by up to `amp` of the sheet (0.4 %
 * — a millimetre on A4), so long lines wave just where the photo shows the
 * paper waving. (u, v) of the sheet → its shift, in the same units.
 */
export function wavesOf(photo: Photo, corners: Pt[], amp = 0.004): (u: number, v: number) => [number, number] {
  const n = 24;
  const b = brightness(photo, corners, n);
  // The even light: a plane fitted to the brightness.
  let [su, sv, sb, suu, svv, suv, sub, svb] = [0, 0, 0, 0, 0, 0, 0, 0];
  const cnt = n * n;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const [u, v, l] = [(i + 0.5) / n - 0.5, (j + 0.5) / n - 0.5, b[j][i]];
      su += u;
      sv += v;
      sb += l;
      suu += u * u;
      svv += v * v;
      suv += u * v;
      sub += u * l;
      svb += v * l;
    }
  const mean = sb / cnt;
  const det = suu * svv - suv * suv || 1;
  const gu = (sub * svv - svb * suv) / det;
  const gv = (svb * suu - sub * suv) / det;
  const glen = Math.hypot(gu, gv);
  // Along the light (or across the sheet when it is even), the residue's profile is the waves' slope.
  const [du, dv] = glen > 1e-6 ? [gu / glen, gv / glen] : [0, 1];
  const bins = 16;
  const slope = new Array<number>(bins).fill(0);
  const hits = new Array<number>(bins).fill(0);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const [u, v] = [(i + 0.5) / n - 0.5, (j + 0.5) / n - 0.5];
      const rest = (b[j][i] - (mean + gu * u + gv * v)) / Math.max(mean, 1);
      const t = Math.min(bins - 1, Math.max(0, Math.floor((u * du + v * dv + 0.71) / 1.42 * bins)));
      slope[t] += rest;
      hits[t]++;
    }
  // Integrated slope → height; centred, scaled to the largest wave.
  const height: number[] = [];
  let acc = 0;
  for (let t = 0; t < bins; t++) {
    acc += hits[t] ? slope[t] / hits[t] : 0;
    height.push(acc);
  }
  const avg = height.reduce((s, v) => s + v, 0) / bins;
  const top = Math.max(...height.map((v) => Math.abs(v - avg)), 1e-9);
  const shape = height.map((v) => (v - avg) / top);
  const at = (t: number) => {
    const x = Math.min(bins - 1, Math.max(0, t * bins - 0.5));
    const i = Math.floor(x);
    const f = x - i;
    return shape[i] * (1 - f) + shape[Math.min(bins - 1, i + 1)] * f;
  };
  // Lines along the light's direction wave across it.
  return (u, v) => {
    const t = ((u - 0.5) * du + (v - 0.5) * dv + 0.71) / 1.42;
    const s = amp * at(t);
    return [-dv * s, du * s];
  };
}

/** The photo as a scanner app leaves it: the light evened out (divided by its own blur), the paper white, a little more contrast. */
export async function scannerLook(photo: Photo): Promise<Photo> {
  const { width: w, height: h } = photo;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(photo.bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  // The light: the photo blurred far (drawn tiny, then large again).
  const small = new OffscreenCanvas(Math.max(1, Math.round(w / 48)), Math.max(1, Math.round(h / 48)));
  const sctx = small.getContext('2d')!;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(photo.bitmap, 0, 0, small.width, small.height);
  const big = new OffscreenCanvas(w, h);
  const bctx = big.getContext('2d', { willReadFrequently: true })!;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, w, h);
  const light = bctx.getImageData(0, 0, w, h).data;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = (d[i + c] / Math.max(light[i + c], 1)) * 0.96;
      // A gentle S: paper to white, ink a touch darker.
      const s = Math.min(1, Math.max(0, (v - 0.08) / 0.88));
      d[i + c] = Math.round(255 * Math.min(1, s * s * (3 - 2 * s) * 0.35 + s * 0.65));
    }
  }
  ctx.putImageData(img, 0, 0);
  return { ...photo, bitmap: await createImageBitmap(canvas) };
}
