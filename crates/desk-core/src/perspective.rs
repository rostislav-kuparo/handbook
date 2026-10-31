//! How the phone was held over the sheet, from the photo's straight lines.
//! Lines that are parallel on the desk (a notebook's rows, the sheet's and
//! the desk's edges, a form's frame) meet in the photo at a vanishing point;
//! with the lens's focal length known, a vanishing point is a direction in
//! the camera's space. Two perpendicular ones are the sheet's axes, and the
//! camera's whole turn (up or down, sideways, round) follows. RANSAC finds
//! the two families most lines agree with; least squares then refine them.

use serde::Serialize;

use crate::img::Photo;
use crate::lines::{segments, Segment};
use crate::quad::Pt;
use crate::rng::Rng;

type V3 = [f64; 3];

fn cross3(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot3(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn unit(a: V3) -> Option<V3> {
    let l = dot3(a, a).sqrt();
    (l > 1e-12).then(|| [a[0] / l, a[1] / l, a[2] / l])
}

#[derive(Serialize, Debug)]
pub struct Perspective {
    /// Row-major 3×3; its columns are the sheet's right, its down and its
    /// normal (away from the camera) in the camera's axes (x right, y down,
    /// z forward).
    pub rot: [f64; 9],
    /// 0..1: how sure.
    pub confidence: f64,
    /// `two`: both of the sheet's directions converge in the photo; `one`:
    /// only one did, the rest is the smallest tilt agreeing with it.
    pub by: &'static str,
    /// The segments that agree, photo px: `[ax, ay, bx, by, family]` (0: across the sheet, 1: down it).
    pub lines: Vec<[f64; 5]>,
}

/// The camera's turn over the desk, `focal` px (or None when the lines do not tell).
pub fn find(photo: &Photo, focal: f64) -> Option<Perspective> {
    from_segments(&segments(photo, 0.03), photo.w as f64, photo.h as f64, focal)
}

/// A segment as the plane through it and the camera's centre.
struct Seen {
    n: V3,
    a: Pt,
    b: Pt,
    w: f64,
}

struct Camera {
    f: f64,
    c: Pt,
    /// Endpoint error a segment may have, px.
    px: f64,
}

impl Camera {
    /// How far off the vanishing point of direction `d` a segment points: its ends' distance from the line through its middle and that point, against what a segment so long may be off.
    fn miss(&self, s: &Seen, d: V3) -> f64 {
        let v = [self.f * d[0] + self.c[0] * d[2], self.f * d[1] + self.c[1] * d[2], d[2]];
        let m = [(s.a[0] + s.b[0]) / 2.0, (s.a[1] + s.b[1]) / 2.0, 1.0];
        let half = 0.5 * (s.b[0] - s.a[0]).hypot(s.b[1] - s.a[1]);
        // A vanishing point on the segment itself says nothing.
        if v[2].abs() > 1e-9 && (v[0] / v[2] - m[0]).hypot(v[1] / v[2] - m[1]) < 1.5 * half {
            return f64::INFINITY;
        }
        let l = cross3(m, v);
        let len = l[0].hypot(l[1]);
        if len < 1e-12 {
            return f64::INFINITY;
        }
        let off = (l[0] * s.a[0] + l[1] * s.a[1] + l[2]).abs() / len;
        off / self.px.max(half * (0.5f64).to_radians().sin())
    }
}

/// The smallest eigenvector of a symmetric 3×3 matrix (Jacobi).
fn smallest(mut m: [[f64; 3]; 3]) -> V3 {
    let mut v = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _ in 0..50 {
        let (mut p, mut q, mut big) = (0, 1, 0.0);
        for i in 0..3 {
            for j in i + 1..3 {
                if m[i][j].abs() > big {
                    (p, q, big) = (i, j, m[i][j].abs());
                }
            }
        }
        if big < 1e-15 {
            break;
        }
        let th = 0.5 * (2.0 * m[p][q]).atan2(m[q][q] - m[p][p]);
        let (c, s) = (th.cos(), th.sin());
        let mut r = m;
        for k in 0..3 {
            r[k][p] = c * m[k][p] - s * m[k][q];
            r[k][q] = s * m[k][p] + c * m[k][q];
        }
        let mut out = r;
        for k in 0..3 {
            out[p][k] = c * r[p][k] - s * r[q][k];
            out[q][k] = s * r[p][k] + c * r[q][k];
        }
        m = out;
        for row in v.iter_mut() {
            let (a, b) = (row[p], row[q]);
            row[p] = c * a - s * b;
            row[q] = s * a + c * b;
        }
    }
    let i = (0..3).min_by(|&a, &b| m[a][a].partial_cmp(&m[b][b]).unwrap()).unwrap();
    [v[0][i], v[1][i], v[2][i]]
}

/// The direction all these segments' planes contain best (least squares).
fn fit(seen: &[Seen], members: &[usize]) -> Option<V3> {
    if members.len() < 2 {
        return None;
    }
    let mut m = [[0.0; 3]; 3];
    for &i in members {
        let (n, w) = (seen[i].n, seen[i].w);
        for r in 0..3 {
            for c in 0..3 {
                m[r][c] += w * n[r] * n[c];
            }
        }
    }
    unit(smallest(m))
}

/// The directions apart by a right angle, each turned half the way.
fn square_up(a: V3, b: V3) -> Option<(V3, V3)> {
    let e = dot3(a, b) / 2.0;
    Some((unit([a[0] - e * b[0], a[1] - e * b[1], a[2] - e * b[2]])?, unit([b[0] - e * a[0], b[1] - e * a[1], b[2] - e * a[2]])?))
}

/// The sheet's tilt allowed: a phone looks at the desk, not along it.
const MAX_TILT: f64 = 50.0;

pub fn from_segments(segs: &[Segment], w: f64, h: f64, focal: f64) -> Option<Perspective> {
    let cam = Camera { f: focal, c: [w / 2.0, h / 2.0], px: w.max(h) / 1024.0 };
    let diag = w.hypot(h);
    let ray = |p: Pt| [(p[0] - cam.c[0]) / cam.f, (p[1] - cam.c[1]) / cam.f, 1.0];
    let seen: Vec<Seen> = segs
        .iter()
        .take(800)
        // A long segment's direction is surer: weight by length squared (capped at half the diagonal), less what was not seen.
        .filter_map(|s| Some(Seen { n: unit(cross3(ray(s.a), ray(s.b)))?, a: s.a, b: s.b, w: s.len().min(0.5 * diag).powi(2) / diag * (s.seen / s.len()).min(1.0) }))
        .collect();
    if seen.len() < 3 {
        return None;
    }
    let total: f64 = seen.iter().map(|s| s.w).sum();
    let mut cum = Vec::with_capacity(seen.len());
    let mut acc = 0.0;
    for s in &seen {
        acc += s.w;
        cum.push(acc);
    }
    let mut rng = Rng::new(0x5ee);
    let mut pick = || {
        let t = rng.f64() * total;
        cum.partition_point(|&c| c < t).min(seen.len() - 1)
    };
    let cos_tilt = MAX_TILT.to_radians().cos();
    // Support of a pair of directions: weight and count agreeing with each (each segment with the closer one).
    let support = |d1: V3, d2: Option<V3>, tol: f64| {
        let mut out = ([0.0, 0.0], [0usize, 0], vec![]);
        for (i, s) in seen.iter().enumerate() {
            let m1 = cam.miss(s, d1);
            let m2 = d2.map_or(f64::INFINITY, |d| cam.miss(s, d));
            let k = if m1 <= m2 { 0 } else { 1 };
            if m1.min(m2) <= tol {
                out.0[k] += s.w;
                out.1[k] += 1;
                out.2.push((i, k));
            }
        }
        out
    };
    let mut best_two: Option<(f64, V3, V3)> = None;
    let mut best_one: Option<(f64, V3)> = None;
    for _ in 0..1500 {
        let (i, j) = (pick(), pick());
        if i == j {
            continue;
        }
        let Some(d1) = unit(cross3(seen[i].n, seen[j].n)) else { continue };
        let k = pick();
        let d2 = if k == i || k == j { None } else { unit(cross3(d1, seen[k].n)) };
        let (w, c, _) = support(d1, d2, 1.0);
        if c[0] >= 3 && best_one.as_ref().is_none_or(|b| w[0] > b.0) {
            best_one = Some((w[0], d1));
        }
        let Some(d2) = d2 else { continue };
        let normal = unit(cross3(d1, d2)).unwrap_or([0.0, 0.0, 0.0]);
        // The weaker family must be real: a few lines, not one stray stroke.
        if normal[2].abs() < cos_tilt || c[0].min(c[1]) < 2 || w[0].min(w[1]) < 0.15 * diag {
            continue;
        }
        if best_two.as_ref().is_none_or(|b| w[0] + w[1] > b.0) {
            best_two = Some((w[0] + w[1], d1, d2));
        }
    }

    let lines = |members: &[(usize, usize)], fam: &dyn Fn(usize) -> usize| {
        members.iter().take(400).map(|&(i, k)| [seen[i].a[0], seen[i].a[1], seen[i].b[0], seen[i].b[1], fam(k) as f64]).collect::<Vec<_>>()
    };
    // How level an image direction is near the middle of the photo (1: across, 0: up and down).
    let level = |d: V3| d[0].abs() / d[0].hypot(d[1]).max(1e-12);

    if let Some((_, mut d1, mut d2)) = best_two {
        let mut members = vec![];
        for _ in 0..4 {
            let (_, _, m) = support(d1, Some(d2), 1.5);
            let f1: Vec<usize> = m.iter().filter(|p| p.1 == 0).map(|p| p.0).collect();
            let f2: Vec<usize> = m.iter().filter(|p| p.1 == 1).map(|p| p.0).collect();
            let (Some(a), Some(b)) = (fit(&seen, &f1), fit(&seen, &f2)) else { break };
            let Some((a, b)) = square_up(a, b) else { break };
            (d1, d2) = (a, b);
            members = m;
        }
        let (w, _, _) = support(d1, Some(d2), 1.5);
        // The more level direction is the sheet's across, pointing right; the other its down, pointing down.
        let swap = level(d2) > level(d1);
        let (mut x, mut y) = if swap { (d2, d1) } else { (d1, d2) };
        if x[0] < 0.0 {
            x = [-x[0], -x[1], -x[2]];
        }
        if y[1] < 0.0 {
            y = [-y[0], -y[1], -y[2]];
        }
        let z = unit(cross3(x, y))?;
        if z[2] >= cos_tilt {
            let y = cross3(z, x);
            let weak = w[0].min(w[1]);
            return Some(Perspective {
                rot: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]],
                confidence: 0.6 + 0.4 * (weak / (0.5 * diag)).min(1.0),
                by: "two",
                lines: lines(&members, &|k| if swap { 1 - k } else { k }),
            });
        }
    }

    let (w1, mut d) = best_one?;
    if w1 < 0.3 * diag {
        return None;
    }
    let mut members = vec![];
    for _ in 0..3 {
        let (_, _, m) = support(d, None, 1.5);
        let f: Vec<usize> = m.iter().map(|p| p.0).collect();
        let Some(a) = fit(&seen, &f) else { break };
        d = a;
        members = m;
    }
    // The other axis: the smallest tilt that agrees — the normal as near the camera's axis as can be.
    let toward = |a: V3| unit([-a[2] * a[0], -a[2] * a[1], 1.0 - a[2] * a[2]]);
    let across = level(d) >= 0.5f64.sqrt();
    let (x, y, z) = if across {
        let x = if d[0] < 0.0 { [-d[0], -d[1], -d[2]] } else { d };
        let z = toward(x)?;
        (x, cross3(z, x), z)
    } else {
        let y = if d[1] < 0.0 { [-d[0], -d[1], -d[2]] } else { d };
        let z = toward(y)?;
        (cross3(y, z), y, z)
    };
    if z[2] < cos_tilt {
        return None;
    }
    let (wt, _, _) = support(d, None, 1.5);
    Some(Perspective {
        rot: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]],
        confidence: 0.3 + 0.15 * (wt[0] / diag).min(1.0),
        by: "one",
        lines: lines(&members, &|_| if across { 0 } else { 1 }),
    })
}
