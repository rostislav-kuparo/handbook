// Plane-to-plane perspective maps (homographies): a flat sheet seen by a camera.

export type Pt = [number, number];
/** 3×3 matrix, row-major. */
export type Mat3 = number[];

export const apply = (m: Mat3, [x, y]: Pt): Pt => {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
};

export function mul(a: Mat3, b: Mat3): Mat3 {
  const out: Mat3 = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
  }
  return out;
}

export function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map((v) => v / det);
}

/** Solves A·x = b (A is n×n, row-major) by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, r) => [...row, b[r]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) throw new Error('Вырожденные уголки: три из них лежат на одной прямой');
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = col + 1; r < n; r++) {
      const k = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= k * M[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

/** The homography taking the four points `from` to the four points `to` (direct linear transform). */
export function homography(from: Pt[], to: Pt[]): Mat3 {
  const A: number[][] = [];
  const b: number[] = [];
  for (let k = 0; k < 4; k++) {
    const [x, y] = from[k];
    const [u, v] = to[k];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  return [...solve(A, b), 1];
}

/**
 * The four corners of a quadrilateral go round clockwise on screen (y down)
 * and it does not fold over itself: the edges always turn the same way.
 */
export function isConvexClockwise(q: Pt[]): boolean {
  for (let k = 0; k < 4; k++) {
    const [a, b, c] = [q[k], q[(k + 1) % 4], q[(k + 2) % 4]];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0) return false;
  }
  return true;
}

/**
 * The largest stretch of the map anywhere on the rectangle 0..w × 0..h: how
 * many target pixels one source pixel becomes at most (the larger singular
 * value of the Jacobian; a homography stretches most at a corner).
 */
export function maxStretch(m: Mat3, w: number, h: number): number {
  let best = 0;
  const e = 0.5;
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h], [w / 2, h / 2]] as Pt[]) {
    const p = apply(m, [x, y]);
    const px = apply(m, [x + e, y]);
    const py = apply(m, [x, y + e]);
    const [a, c] = [(px[0] - p[0]) / e, (px[1] - p[1]) / e];
    const [b, d] = [(py[0] - p[0]) / e, (py[1] - p[1]) / e];
    // Singular values of [[a b] [c d]].
    const s = a * a + b * b + c * c + d * d;
    const det = a * d - b * c;
    best = Math.max(best, Math.sqrt((s + Math.sqrt(Math.max(0, s * s - 4 * det * det))) / 2));
  }
  return best;
}
