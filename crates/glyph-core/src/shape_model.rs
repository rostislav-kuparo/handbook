//! Learned shape model of one letter (on-device, no network).
//!
//! All recorded variants of a letter that were written the same way (same
//! number of strokes, same joins) are resampled to a common set of points and
//! aligned. Principal component analysis then finds the directions in which
//! *this* writer's variants actually differ — a bigger loop together with a
//! longer tail, a steeper stem with a narrower bowl. New variants are drawn
//! from that learned Gaussian: they look like plausible siblings of what was
//! written, not like a straight blend of two samples.
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
    mean: Vec<f64>,
    /// (standard deviation, unit direction)
    comps: Vec<(f64, Vec<f64>)>,
}

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
        let mut v = g.mean.clone();
        for (sigma, u) in &g.comps {
            let z = rng.gauss() * fantasy.clamp(0.0, 3.0);
            for (vi, ui) in v.iter_mut().zip(u) {
                *vi += sigma * z * ui;
            }
        }
        Some(devectorize(&v, &g.counts, g.entry, g.exit))
    }
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
        mean,
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

    #[test]
    fn single_sample_reproduces_itself() {
        let s = arch(300.0, 400.0);
        let model = ShapeModel::fit(std::slice::from_ref(&s));
        let (strokes, _, _) = model.sample(&mut Rng::new(1), 1.0).unwrap();
        let b = strokes_bbox(&strokes);
        assert!((b.x_max - b.x_min - 400.0).abs() < 1.0);
    }
}
