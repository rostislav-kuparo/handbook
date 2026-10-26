//! Learned shape model of one letter (on-device, no network).
//!
//! All recorded variants of a letter that were written the same way (same
//! number of strokes, same joins) are resampled to a common set of points and
//! aligned. Principal component analysis then finds the directions in which
//! *this* writer's variants actually differ — a bigger loop together with a
//! longer tail, a steeper stem with a narrower bowl. New variants are drawn
//! around one of the written variants: they look like plausible siblings of
//! what was written, not like a blend of all of them (an average of loops of
//! different sizes is no loop at all — «е» would turn into «с»). A variant
//! that still strays too far (a loop gone, proportions off) is replaced by the
//! written one it came from.
//!
//! PCA uses the dual (Gram matrix) form because there are few samples (n) and
//! many coordinates (d): eigen-decompose the n×n matrix X·Xᵀ with Jacobi
//! rotations and map the eigenvectors back to d dimensions.

use crate::geom::*;
use crate::model::Anchor;
use crate::rng::Rng;
use crate::synth::{Prepared, Topology};

/// Pressure lives on a 0..1 scale while coordinates are hundreds of units;
/// scale it so it takes part in the model without dominating it.
const P_SCALE: f64 = 100.0;
const MAX_COMPONENTS: usize = 6;

#[derive(Clone, Debug)]
struct GroupModel {
    topology: Topology,
    size: usize,
    counts: Vec<usize>,
    /// Whether the group's samples have a connecting entry / exit (part of the vector).
    entry: bool,
    exit: bool,
    /// The written variants as vectors: new ones start from one of them.
    rows: Vec<Vec<f64>>,
    /// (standard deviation, unit direction)
    comps: Vec<(f64, Vec<f64>)>,
}

/// How far around a written variant a new one may go, per unit of fantasy.
/// The written variant already sits about one deviation from the mean.
const SPREAD: f64 = 0.7;
/// A new variant may turn this much more or less than the written one (radians, per stroke).
const MAX_TURN_CHANGE: f64 = 1.6;
/// …and change its width-to-height ratio by this share.
const MAX_RATIO_CHANGE: f64 = 0.3;

#[derive(Clone, Debug, Default)]
pub struct ShapeModel {
    groups: Vec<GroupModel>,
}

/// A generated letter: strokes plus anchors.
pub type Generated = (Vec<Stroke>, Option<Anchor>, Option<Anchor>);

impl ShapeModel {
    pub fn fit(samples: &[Prepared]) -> ShapeModel {
        let mut by_topo: Vec<(Topology, Vec<&Prepared>)> = Vec::new();
        for s in samples.iter().filter(|s| !s.strokes.is_empty() && s.strokes.iter().all(|st| !st.is_empty())) {
            let t = s.topology();
            match by_topo.iter_mut().find(|(k, _)| *k == t) {
                Some((_, v)) => v.push(s),
                None => by_topo.push((t, vec![s])),
            }
        }
        ShapeModel { groups: by_topo.into_iter().map(|(_, members)| fit_group(&members)).collect() }
    }

    /// Number of independent directions of variation the model has learned.
    pub fn components(&self) -> usize {
        self.groups.iter().map(|g| g.comps.len()).sum()
    }

    /// Draw a new variant. `fantasy` scales how far it may stray (1 = as much as the samples do).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn sample(&self, rng: &mut Rng, fantasy: f64) -> Option<Generated> {
        self.sample_where(rng, fantasy, |_| true)
    }

    /// Draw a new variant from the groups whose way of writing matches `accept`
    /// (e.g. only variants that join on the left, for the middle of a word).
    pub fn sample_where(&self, rng: &mut Rng, fantasy: f64, accept: impl Fn(&Topology) -> bool) -> Option<Generated> {
        let groups: Vec<&GroupModel> = self.groups.iter().filter(|g| accept(&g.topology)).collect();
        let total: usize = groups.iter().map(|g| g.size).sum();
        if total == 0 {
            return None;
        }
        let mut pick = rng.below(total);
        let g = *groups.iter().find(|g| {
            if pick < g.size {
                true
            } else {
                pick -= g.size;
                false
            }
        })?;
        let base = &g.rows[rng.below(g.rows.len())];
        let written = devectorize(base, &g.counts, g.entry, g.exit);
        let spread = fantasy.clamp(0.0, 3.0) * SPREAD;
        if g.comps.is_empty() || spread <= 0.0 {
            return Some(written);
        }
        for _ in 0..3 {
            let mut v = base.clone();
            for (sigma, u) in &g.comps {
                let z = rng.gauss() * spread;
                for (vi, ui) in v.iter_mut().zip(u) {
                    *vi += sigma * z * ui;
                }
            }
            let fresh = devectorize(&v, &g.counts, g.entry, g.exit);
            if plausible(&fresh.0, &written.0) {
                return Some(fresh);
            }
        }
        Some(written)
    }
}

/// Total signed turning of a stroke, radians: about ±2π for a loop, ±π for «с».
fn turning(s: &[Pt]) -> f64 {
    let pts: Vec<&Pt> = {
        // Skip points closer than a few units: jitter there says nothing about the shape.
        let mut out: Vec<&Pt> = Vec::with_capacity(s.len());
        for p in s {
            if out.last().is_none_or(|q| q.dist(p) >= 6.0) {
                out.push(p);
            }
        }
        out
    };
    let mut total = 0.0;
    for w in pts.windows(3) {
        let (ax, ay) = (w[1].x - w[0].x, w[1].y - w[0].y);
        let (bx, by) = (w[2].x - w[1].x, w[2].y - w[1].y);
        total += (ax * by - ay * bx).atan2(ax * bx + ay * by);
    }
    total
}

/// Width-to-height ratio of the ink (heights below a dot's size count as one).
fn ratio(strokes: &[Stroke]) -> f64 {
    let b = strokes_bbox(strokes);
    if b.is_empty() {
        return 1.0;
    }
    b.width().max(20.0) / (b.y_max - b.y_min).max(20.0)
}

/// A new variant keeps the character of the written one it grew from: the
/// same loops and turns in every stroke and roughly the same proportions.
fn plausible(fresh: &[Stroke], written: &[Stroke]) -> bool {
    if fresh.len() != written.len() {
        return false;
    }
    let turns = fresh.iter().zip(written).all(|(a, b)| a.len() < 3 || (turning(a) - turning(b)).abs() <= MAX_TURN_CHANGE);
    let (ra, rb) = (ratio(fresh), ratio(written));
    turns && (ra / rb - 1.0).abs() <= MAX_RATIO_CHANGE
}

fn reversed(reference: &[Pt], s: &[Pt]) -> bool {
    let (fa, la) = (reference[0], *reference.last().unwrap());
    let (fb, lb) = (s[0], *s.last().unwrap());
    fa.dist(&lb) + la.dist(&fb) < fa.dist(&fb) + la.dist(&lb)
}

fn aligned(p: &Prepared) -> (Vec<Stroke>, Option<Anchor>, Option<Anchor>) {
    let dx = -strokes_bbox(&p.strokes).x_min;
    let shift = |a: Option<Anchor>| a.map(|a| Anchor { x: a.x + dx, ..a });
    let strokes = p.strokes.iter().map(|s| s.iter().map(|q| Pt::new(q.x + dx, q.y, q.p)).collect()).collect();
    (strokes, shift(p.entry), shift(p.exit))
}

fn vectorize(p: &Prepared, reference: &[Stroke], counts: &[usize]) -> Vec<f64> {
    let (strokes, entry, exit) = aligned(p);
    let mut v = Vec::new();
    for (si, s) in strokes.into_iter().enumerate() {
        let mut s = s;
        if s.len() > 1 && reference[si].len() > 1 && reversed(&reference[si], &s) {
            s.reverse();
        }
        for q in resample_count(&s, counts[si]) {
            v.extend([q.x, q.y, q.p * P_SCALE]);
        }
    }
    // Only connecting anchors take part: the group's topology guarantees they exist in every member.
    for a in [entry, exit].into_iter().flatten().filter(|a| a.connect) {
        v.extend([a.x, a.y]);
    }
    v
}

fn devectorize(v: &[f64], counts: &[usize], entry: bool, exit: bool) -> Generated {
    let mut i = 0;
    let mut strokes = Vec::with_capacity(counts.len());
    for &c in counts {
        let s: Stroke = (0..c)
            .map(|k| {
                let o = i + k * 3;
                Pt::new(v[o], v[o + 1], (v[o + 2] / P_SCALE).clamp(0.05, 1.0))
            })
            .collect();
        i += c * 3;
        strokes.push(s);
    }
    let mut anchor = |present: bool| {
        present.then(|| {
            let a = Anchor { x: v[i], y: v[i + 1], connect: true };
            i += 2;
            a
        })
    };
    let entry = anchor(entry);
    let exit = anchor(exit);
    (strokes, entry, exit)
}

fn fit_group(members: &[&Prepared]) -> GroupModel {
    let first = members[0];
    let reference = aligned(first).0;
    let counts: Vec<usize> = (0..first.strokes.len())
        .map(|si| {
            let avg = members.iter().map(|m| stroke_length(&m.strokes[si])).sum::<f64>() / members.len() as f64;
            ((avg / 8.0).round() as usize).clamp(if first.strokes[si].len() == 1 { 1 } else { 8 }, 160)
        })
        .collect();
    let rows: Vec<Vec<f64>> = members.iter().map(|m| vectorize(m, &reference, &counts)).collect();
    let n = rows.len();
    let d = rows[0].len();
    let mut mean = vec![0.0; d];
    for r in &rows {
        for (m, x) in mean.iter_mut().zip(r) {
            *m += x / n as f64;
        }
    }
    let mut comps = Vec::new();
    if n >= 2 {
        let centered: Vec<Vec<f64>> = rows.iter().map(|r| r.iter().zip(&mean).map(|(x, m)| x - m).collect()).collect();
        let gram: Vec<Vec<f64>> = (0..n)
            .map(|a| (0..n).map(|b| dot(&centered[a], &centered[b])).collect())
            .collect();
        let (values, vectors) = jacobi_eigen(gram);
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by(|&a, &b| values[b].partial_cmp(&values[a]).unwrap());
        let top = values[order[0]].max(0.0);
        for &k in order.iter().take(MAX_COMPONENTS) {
            let lambda = values[k];
            if lambda <= 1e-9 * top.max(1.0) || lambda <= 1e-6 {
                continue;
            }
            let mut u = vec![0.0; d];
            for (row, w) in centered.iter().zip(vectors.iter().map(|vec| vec[k])) {
                for (ui, x) in u.iter_mut().zip(row) {
                    *ui += w * x;
                }
            }
            let norm = lambda.sqrt();
            u.iter_mut().for_each(|x| *x /= norm);
            comps.push(((lambda / (n - 1) as f64).sqrt(), u));
        }
    }
    GroupModel {
        topology: first.topology(),
        size: n,
        counts,
        entry: first.topology().entry.is_some(),
        exit: first.topology().exit.is_some(),
        rows,
        comps,
    }
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Eigen-decomposition of a small symmetric matrix (cyclic Jacobi).
/// Returns eigenvalues and a matrix whose columns are the eigenvectors.
fn jacobi_eigen(mut a: Vec<Vec<f64>>) -> (Vec<f64>, Vec<Vec<f64>>) {
    let n = a.len();
    let mut v: Vec<Vec<f64>> = (0..n).map(|i| (0..n).map(|j| if i == j { 1.0 } else { 0.0 }).collect()).collect();
    for _ in 0..100 {
        let off: f64 = (0..n).flat_map(|i| (0..n).filter(move |&j| j != i).map(move |j| (i, j))).map(|(i, j)| a[i][j] * a[i][j]).sum();
        let scale: f64 = (0..n).map(|i| a[i][i] * a[i][i]).sum::<f64>().max(1e-300);
        if off <= 1e-24 * scale {
            break;
        }
        for p in 0..n {
            for q in p + 1..n {
                if a[p][q].abs() < 1e-300 {
                    continue;
                }
                let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..n {
                    let (akp, akq) = (a[k][p], a[k][q]);
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for k in 0..n {
                    let (apk, aqk) = (a[p][k], a[q][k]);
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
                for row in v.iter_mut() {
                    let (vkp, vkq) = (row[p], row[q]);
                    row[p] = c * vkp - s * vkq;
                    row[q] = s * vkp + c * vkq;
                }
            }
        }
    }
    ((0..n).map(|i| a[i][i]).collect(), v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jacobi_recovers_eigenpairs() {
        let m = vec![vec![4.0, 1.0, 0.5], vec![1.0, 3.0, 0.2], vec![0.5, 0.2, 1.0]];
        let (vals, vecs) = jacobi_eigen(m.clone());
        for k in 0..3 {
            let col: Vec<f64> = (0..3).map(|i| vecs[i][k]).collect();
            for i in 0..3 {
                let mv: f64 = (0..3).map(|j| m[i][j] * col[j]).sum();
                assert!((mv - vals[k] * col[i]).abs() < 1e-9, "A·v = λ·v");
            }
        }
        let trace: f64 = vals.iter().sum();
        assert!((trace - 8.0).abs() < 1e-9);
    }

    fn arch(h: f64, w: f64) -> Prepared {
        Prepared {
            strokes: vec![(0..=40)
                .map(|i| {
                    let t = i as f64 / 40.0;
                    Pt::new(t * w, h * (t * std::f64::consts::PI).sin(), 0.5)
                })
                .collect()],
            entry: None,
            exit: None,
        }
    }

    #[test]
    fn learns_correlated_variation_and_samples_within_it() {
        // Taller arches are also wider in these samples: one direction of variation.
        let samples: Vec<Prepared> = (0..6).map(|i| arch(300.0 + i as f64 * 20.0, 300.0 + i as f64 * 20.0)).collect();
        let model = ShapeModel::fit(&samples);
        assert_eq!(model.components(), 1, "one learned direction");
        let mut rng = Rng::new(9);
        for _ in 0..20 {
            let (strokes, _, _) = model.sample(&mut rng, 1.0).unwrap();
            let b = strokes_bbox(&strokes);
            let (w, h) = (b.x_max - b.x_min, b.y_max - b.y_min);
            assert!((w - h).abs() < 6.0, "generated arch keeps the learned proportion: {w} x {h}");
            assert!(h > 200.0 && h < 520.0);
        }
    }

    /// «е»: a loop and then a «с» curve, one stroke; `r` is the loop size.
    fn e_letter(r: f64, tail: f64) -> Prepared {
        let mut pts: Vec<Pt> = (0..=30).map(|i| Pt::new(40.0 + i as f64 * (2.0 * r) / 30.0, 220.0, 0.5)).collect();
        // Up and around counter-clockwise from the bar's right end, then down and out to the right.
        pts.extend((1..=60).map(|i| {
            let t = i as f64 / 60.0 * (std::f64::consts::TAU * 0.85);
            Pt::new(40.0 + r + r * t.cos(), 220.0 + r * t.sin(), 0.5)
        }));
        let last = *pts.last().unwrap();
        pts.extend((1..=10).map(|i| Pt::new(last.x + i as f64 * tail / 10.0, last.y - i as f64 * 4.0, 0.5)));
        Prepared { strokes: vec![pts], entry: None, exit: None }
    }

    #[test]
    fn generated_variants_keep_the_loop() {
        // Loops of rather different sizes: their average would blur the loop away.
        let samples: Vec<Prepared> = [(150.0, 40.0), (200.0, 120.0), (120.0, 90.0), (180.0, 20.0)].iter().map(|&(r, t)| e_letter(r, t)).collect();
        let written: Vec<f64> = samples.iter().map(|s| turning(&s.strokes[0])).collect();
        let model = ShapeModel::fit(&samples);
        let mut rng = Rng::new(3);
        for _ in 0..40 {
            let (strokes, _, _) = model.sample(&mut rng, 2.0).unwrap();
            let t = turning(&strokes[0]);
            assert!(written.iter().any(|w| (w - t).abs() <= MAX_TURN_CHANGE + 1e-9), "loop kept: {t} vs {written:?}");
        }
    }

    #[test]
    fn no_fantasy_gives_the_written_variants_in_turn() {
        let samples: Vec<Prepared> = (0..4).map(|i| arch(300.0 + i as f64 * 60.0, 300.0)).collect();
        let model = ShapeModel::fit(&samples);
        let mut rng = Rng::new(5);
        let heights: std::collections::BTreeSet<i64> = (0..40)
            .map(|_| {
                let (strokes, _, _) = model.sample(&mut rng, 0.0).unwrap();
                let b = strokes_bbox(&strokes);
                (b.y_max - b.y_min).round() as i64
            })
            .collect();
        assert_eq!(heights.len(), 4, "every written variant shows up, nothing in between: {heights:?}");
    }

    #[test]
    fn single_sample_reproduces_itself() {
        let s = arch(300.0, 400.0);
        let model = ShapeModel::fit(std::slice::from_ref(&s));
        let (strokes, _, _) = model.sample(&mut Rng::new(1), 1.0).unwrap();
        let b = strokes_bbox(&strokes);
        assert!((b.x_max - b.x_min - 400.0).abs() < 1.0);
    }
}
