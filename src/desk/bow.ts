// The bow of a sheet's side — the same model as crates/desk-core/src/bow.rs:
// a cubic spline through knots along the side (fractions 0..1, 0 and 1 at its
// corners), px along its outward normal; its ends bend as the stretch next to
// them does (parabolic runout).

export interface Bow {
  t: number[];
  d: number[];
}

export const straightBow = (): Bow => ({ t: [0, 1], d: [0, 0] });

/** The spline through the bow's knots, ready to evaluate. */
export function spline({ t, d }: Bow): (x: number) => number {
  const n = t.length;
  const m = new Array<number>(n).fill(0);
  if (n > 2) {
    const c = new Array<number>(n).fill(0);
    const r = new Array<number>(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const [h0, h1] = [t[i] - t[i - 1], t[i + 1] - t[i]];
      // M₀ = M₁ and Mₙ₋₁ = Mₙ₋₂ folded into the first and last rows.
      const b = 2 * (h0 + h1) + (i === 1 ? h0 : 0) + (i === n - 2 ? h1 : 0);
      const rhs = 6 * ((d[i + 1] - d[i]) / h1 - (d[i] - d[i - 1]) / h0);
      const den = b - h0 * c[i - 1];
      c[i] = h1 / den;
      r[i] = (rhs - h0 * r[i - 1]) / den;
    }
    for (let i = n - 2; i >= 1; i--) m[i] = r[i] - (i === n - 2 ? 0 : c[i] * m[i + 1]);
    m[0] = m[1];
    m[n - 1] = m[n - 2];
  }
  return (x: number) => {
    if (n < 2) return d[0] ?? 0;
    const v = Math.min(t[n - 1], Math.max(t[0], x));
    let i = 0;
    while (i < n - 2 && t[i + 1] <= v) i++;
    const h = t[i + 1] - t[i];
    const [a, b] = [(t[i + 1] - v) / h, (v - t[i]) / h];
    return a * d[i] + b * d[i + 1] + (((a * a * a - a) * m[i] + (b * b * b - b) * m[i + 1]) * h * h) / 6;
  };
}

export const poly = (c: number[], t: number) => c[0] + t * (c[1] + t * (c[2] + t * c[3]));

/** An old bow, kept as a cubic, as knots: seventeen along it (the curve between them is off by far less than a px). */
export const bowOfCubic = (c: number[]): Bow => {
  const t = Array.from({ length: 17 }, (_, i) => i / 16);
  return { t, d: t.map((x) => poly(c, x)) };
};
