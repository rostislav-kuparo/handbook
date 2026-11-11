//! The bow of a sheet's side: a cubic spline through as many knots
//! as the edge needs — one smooth arc for a sheet that only bends, more for
//! a wavy edge. Knots are fractions along the side (0 and 1 at its corners);
//! values are px along its outward normal. The same in `src/desk/bow.ts`.

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct Bow {
    pub t: Vec<f64>,
    pub d: Vec<f64>,
}

impl Bow {
    /// A straight side.
    pub fn straight() -> Bow {
        Bow { t: vec![0.0, 1.0], d: vec![0.0, 0.0] }
    }

    /// The spline ready to evaluate.
    pub fn curve(&self) -> Spline {
        Spline::new(&self.t, &self.d)
    }
}

/// A cubic spline through (t, d), its ends bending as the stretch next to
/// them does (parabolic runout): a sheet's edge may curve right up to its
/// corner.
pub struct Spline {
    t: Vec<f64>,
    d: Vec<f64>,
    /// Second derivatives at the knots.
    m: Vec<f64>,
}

impl Spline {
    pub fn new(t: &[f64], d: &[f64]) -> Spline {
        let n = t.len();
        let mut m = vec![0.0; n];
        if n > 2 {
            // Tridiagonal system for the inner knots (Thomas algorithm).
            let mut c = vec![0.0; n];
            let mut r = vec![0.0; n];
            for i in 1..n - 1 {
                let (h0, h1) = (t[i] - t[i - 1], t[i + 1] - t[i]);
                // M₀ = M₁ and Mₙ₋₁ = Mₙ₋₂ folded into the first and last rows.
                let b = 2.0 * (h0 + h1) + if i == 1 { h0 } else { 0.0 } + if i == n - 2 { h1 } else { 0.0 };
                let rhs = 6.0 * ((d[i + 1] - d[i]) / h1 - (d[i] - d[i - 1]) / h0);
                let (a, prev_c, prev_r) = (h0, c[i - 1], r[i - 1]);
                let den = b - a * prev_c;
                c[i] = h1 / den;
                r[i] = (rhs - a * prev_r) / den;
            }
            for i in (1..n - 1).rev() {
                m[i] = r[i] - if i == n - 2 { 0.0 } else { c[i] * m[i + 1] };
            }
            m[0] = m[1];
            m[n - 1] = m[n - 2];
        }
        Spline { t: t.to_vec(), d: d.to_vec(), m }
    }

    pub fn at(&self, x: f64) -> f64 {
        let n = self.t.len();
        if n == 0 {
            return 0.0;
        }
        if n == 1 {
            return self.d[0];
        }
        let x = x.clamp(self.t[0], self.t[n - 1]);
        let i = self.t.partition_point(|&k| k <= x).clamp(1, n - 1) - 1;
        let h = self.t[i + 1] - self.t[i];
        let (a, b) = ((self.t[i + 1] - x) / h, (x - self.t[i]) / h);
        a * self.d[i] + b * self.d[i + 1] + ((a * a * a - a) * self.m[i] + (b * b * b - b) * self.m[i + 1]) * h * h / 6.0
    }
}

/// How each knot's value weighs in the spline at `x` (the spline is linear in its values).
fn basis(t: &[f64], xs: &[f64]) -> Vec<Vec<f64>> {
    let unit: Vec<Spline> = (0..t.len())
        .map(|j| {
            let d: Vec<f64> = (0..t.len()).map(|k| if k == j { 1.0 } else { 0.0 }).collect();
            Spline::new(t, &d)
        })
        .collect();
    xs.iter().map(|&x| unit.iter().map(|s| s.at(x)).collect()).collect()
}

/// Solves the symmetric system `a · x = b` (Gaussian elimination with pivoting).
fn solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    for c in 0..n {
        let p = (c..n).max_by(|&i, &j| a[i][c].abs().total_cmp(&a[j][c].abs()))?;
        if a[p][c].abs() < 1e-12 {
            return None;
        }
        a.swap(c, p);
        b.swap(c, p);
        for r in c + 1..n {
            let f = a[r][c] / a[c][c];
            for k in c..n {
                a[r][k] -= f * a[c][k];
            }
            b[r] -= f * b[c];
        }
    }
    let mut x = vec![0.0; n];
    for r in (0..n).rev() {
        x[r] = (b[r] - (r + 1..n).map(|k| a[r][k] * x[k]).sum::<f64>()) / a[r][r];
    }
    Some(x)
}

/// Tukey's weight of a residual against the cut-off `k`.
fn tukey(r: f64, k: f64) -> f64 {
    if r.abs() < k {
        (1.0 - (r / k).powi(2)).powi(2)
    } else {
        0.0
    }
}

/// The cut-off for these residuals: wide enough for their scatter, at most
/// 6 px so that two edges side by side (a spiral's rings, a cable by the
/// sheet) do not pull the curve between them.
fn cutoff(res: &[f64]) -> f64 {
    let mut abs: Vec<f64> = res.iter().map(|r| r.abs()).collect();
    abs.sort_by(|x, y| x.total_cmp(y));
    (4.685 * 1.4826 * abs[abs.len() / 2]).clamp(0.3, 6.0)
}

/// A spline with knots `t` through the points (t, value), least squares with
/// a little stiffness, Tukey-reweighted against outliers: its values, each
/// point's weight (0: an outlier).
fn fit_knots(t: &[f64], pts: &[(f64, f64)]) -> Option<(Vec<f64>, Vec<f64>)> {
    let xs: Vec<f64> = pts.iter().map(|p| p.0).collect();
    let phi = basis(t, &xs);
    let m = t.len();
    let mut w = vec![1.0; pts.len()];
    let mut d = vec![0.0; m];
    for _ in 0..8 {
        let mut a = vec![vec![0.0; m]; m];
        let mut b = vec![0.0; m];
        for (i, row) in phi.iter().enumerate() {
            for j in 0..m {
                b[j] += w[i] * row[j] * pts[i].1;
                for k in 0..m {
                    a[j][k] += w[i] * row[j] * row[k];
                }
            }
        }
        // Stiffness: the knots' second differences, a little — enough to keep a sparse stretch from swinging.
        let lam = 1e-3 * w.iter().sum::<f64>();
        for j in 1..m.saturating_sub(1) {
            let row = [(j - 1, 1.0), (j, -2.0), (j + 1, 1.0)];
            for &(p, x) in &row {
                for &(q, y) in &row {
                    a[p][q] += lam * x * y;
                }
            }
        }
        d = solve(a, b)?;
        let s = Spline::new(t, &d);
        let res: Vec<f64> = pts.iter().map(|&(x, y)| y - s.at(x)).collect();
        let k = cutoff(&res);
        w = res.iter().map(|&r| tukey(r, k)).collect();
    }
    Some((d, w))
}

/// How many knots a side may get: evenly spaced, from five (one smooth arc) to seventeen.
const KNOTS: [usize; 6] = [5, 7, 9, 11, 13, 17];

/// The edge's points as a spline with as many knots as it needs: fitted
/// with each number of knots in `KNOTS`, the fewest that fits about as well
/// as the most (within 5 % of its RMS: the rest is the points' own scatter)
/// — knots that would only chase noise are left out. Returns the bow, the
/// share of points on it and their RMS.
pub fn fit_bow(pts: &[(f64, f64)]) -> Option<(Bow, f64, f64)> {
    let mut tried = vec![];
    for &m in &KNOTS {
        let t: Vec<f64> = (0..m).map(|i| i as f64 / (m - 1) as f64).collect();
        let Some((d, w)) = fit_knots(&t, pts) else { continue };
        let s = Spline::new(&t, &d);
        let inl: Vec<f64> = pts.iter().zip(&w).filter(|(_, &w)| w > 0.0).map(|(&(x, y), _)| y - s.at(x)).collect();
        let rms = (inl.iter().map(|r| r * r).sum::<f64>() / inl.len().max(1) as f64).sqrt();
        tried.push((t, d, w, rms));
    }
    let share = |w: &[f64]| w.iter().filter(|&&w| w > 0.0).count() as f64 / pts.len().max(1) as f64;
    // A tighter fit that left more points out is not a better one.
    let most = tried.iter().map(|f| share(&f.2)).fold(0.0, f64::max);
    tried.retain(|f| share(&f.2) >= most - 0.05);
    let least = tried.iter().map(|f| f.3).fold(f64::INFINITY, f64::min);
    let (t, d, w, rms) = tried.into_iter().find(|f| f.3 <= (1.05 * least).max(0.2))?;
    let on = share(&w);
    Some((Bow { t, d }, on, rms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_spline_passes_its_knots_and_bends_smoothly() {
        let s = Spline::new(&[0.0, 0.3, 0.6, 1.0], &[0.0, 2.0, -1.0, 0.0]);
        for (x, y) in [(0.0, 0.0), (0.3, 2.0), (0.6, -1.0), (1.0, 0.0)] {
            assert!((s.at(x) - y).abs() < 1e-12);
        }
        // Continuous slope across a knot.
        let e = 1e-6;
        let (l, r) = ((s.at(0.3) - s.at(0.3 - e)) / e, (s.at(0.3 + e) - s.at(0.3)) / e);
        assert!((l - r).abs() < 1e-3, "{l} {r}");
    }

    #[test]
    fn a_wavy_edge_gets_the_knots_it_needs_a_straight_one_does_not() {
        let wave = |x: f64| 3.0 * (x * std::f64::consts::PI * 5.0).sin() * (x * std::f64::consts::PI).sin();
        let pts: Vec<(f64, f64)> = (0..300).map(|i| i as f64 / 299.0).map(|x| (x, wave(x) + 0.1 * ((x * 977.0).sin()))).collect();
        let (b, share, rms) = fit_bow(&pts).expect("fit");
        assert!(share > 0.95 && rms < 0.35, "share {share}, rms {rms}, {} knots", b.t.len());
        let s = b.curve();
        let worst = (0..=100).map(|i| i as f64 / 100.0).map(|x| (s.at(x) - wave(x)).abs()).fold(0.0, f64::max);
        assert!(worst < 0.4, "worst {worst} with {} knots", b.t.len());
        let flat: Vec<(f64, f64)> = (0..300).map(|i| i as f64 / 299.0).map(|x| (x, 0.1 * (x * 977.0).sin())).collect();
        let (b, _, _) = fit_bow(&flat).expect("fit");
        assert_eq!(b.t.len(), 5, "{:?}", b.t);
        // What lies beside the edge (a finger, a cable: a tenth of the side, 15 px off) does not bend it.
        let beside: Vec<(f64, f64)> = (0..300).map(|i| i as f64 / 299.0).map(|x| (x, if (0.4..0.5).contains(&x) { 15.0 } else { 0.1 * (x * 977.0).sin() })).collect();
        let (b, share, _) = fit_bow(&beside).expect("fit");
        let s = b.curve();
        assert!(share > 0.85 && s.at(0.45).abs() < 1.0, "{share}, {} at the finger, {} knots", s.at(0.45), b.t.len());
    }
}
