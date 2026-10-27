//! The sheet's edges to a fraction of a pixel, and how blurred the photo is
//! there: the edge of a sheet is the sharpest known step in the picture.

use serde::Serialize;

use crate::img::{Gray, Photo};
use crate::quad::{convex_clockwise, dist, Line, Pt};
use crate::rng::Rng;
use crate::SHARPEN_RADIUS;

/// Where the brightness steps across the side `line`, at `count` places along
/// `t ∈ [t0, t1]` of its length (profiles reach `radius` px both ways), and
/// which way: +1 when the inside — to the right of its direction — is
/// brighter (paper on a dark desk), −1 when darker (paper on a white desk).
/// `sign` 0 lets each step decide by itself: the far desk may be lighter than
/// the paper and the shadow the sheet casts right next to it darker. A step
/// must hold for several px on both sides: a thin printed line, dark between
/// two equal levels, is no edge — the levels are medians, which the line
/// itself does not move.
fn edge_points(img: &Gray, line: &Line, len: f64, (t0, t1): (f64, f64), radius: f64, step: f64, count: usize, sign: f64) -> Vec<(Pt, f64)> {
    let n = line.normal();
    let steps = (radius / step).round() as isize;
    let (near, far) = ((1.5 / step).ceil() as usize, (10.0 / step).ceil() as usize);
    let mut out = Vec::new();
    let mut v = vec![0.0; (2 * steps + 1) as usize];
    for i in 0..count {
        let t = t0 + (t1 - t0) * (i as f64 + 0.5) / count as f64;
        let base = [line.p[0] + line.d[0] * t * len, line.p[1] + line.d[1] * t * len];
        for (j, slot) in v.iter_mut().enumerate() {
            let u = (j as isize - steps) as f64 * step;
            // Three profiles side by side, against noise.
            *slot = (-1..=1)
                .map(|s| {
                    let s = s as f64;
                    img.sample(base[0] + n[0] * u + line.d[0] * s, base[1] + n[1] * u + line.d[1] * s)
                })
                .sum::<f64>()
                / 3.0;
        }
        let m = v.len();
        let quarter = m / 4;
        let inside = v[..quarter].iter().sum::<f64>() / quarter as f64;
        let outside = v[m - quarter..].iter().sum::<f64>() / quarter as f64;
        let contrast = if sign != 0.0 { sign * (inside - outside) } else { (inside - outside).abs() };
        if sign != 0.0 && contrast < 0.01 {
            continue;
        }
        // A part of the contrast between the far ends: the desk and the paper
        // are rarely even, the step at the edge is less than that.
        let need = (0.2 * contrast).max(0.006);
        // Outward slopes; the edge is a steep one — a drop where the inside is lighter.
        let r: Vec<f64> = (1..m - 1).map(|j| (v[j + 1] - v[j - 1]) / (2.0 * step)).collect();
        let d: Vec<f64> = r.iter().map(|&x| if sign != 0.0 { sign * x } else { -x.abs() }).collect();
        let way = |j: usize| if sign != 0.0 { sign } else { -r[j].signum() };
        let level = |a: isize, b: isize| {
            let (a, b) = (a.max(0) as usize, (b.max(0) as usize).min(m - 1));
            if b < a {
                return None;
            }
            let mut part = v[a..=b].to_vec();
            part.sort_by(|x, y| x.partial_cmp(y).unwrap());
            Some(part[part.len() / 2])
        };
        let held = |jm: usize| -> Option<f64> {
            let c = jm as isize + 1;
            let before = level(c - far as isize, c - near as isize)?;
            let after = level(c + near as isize, c + far as isize)?;
            Some(way(jm) * (before - after))
        };
        let mut cand: Vec<usize> = (1..d.len() - 1).filter(|&j| d[j] < 0.0 && d[j] <= d[j - 1] && d[j] <= d[j + 1]).collect();
        cand.sort_by(|&a, &b| d[a].partial_cmp(&d[b]).unwrap());
        let found = cand.into_iter().take(6).find(|&jm| jm >= 2 && jm + 3 <= d.len() && d[jm] <= -need / radius && held(jm).is_some_and(|h| h >= need));
        let Some(jm) = found else { continue };
        let (a, b, c) = (d[jm - 1], d[jm], d[jm + 1]);
        let den = a - 2.0 * b + c;
        let delta = if den.abs() > 1e-12 { ((a - c) / (2.0 * den)).clamp(-1.0, 1.0) } else { 0.0 };
        let u = ((jm + 1) as f64 - steps as f64 + delta) * step;
        out.push(([base[0] + n[0] * u, base[1] + n[1] * u], way(jm)));
    }
    out
}

/// The most a sheet's edge bows, as a share of its length: a notebook's page
/// next to the spiral arches up to about 2 %.
const MAX_BOW: f64 = 0.025;

/// How far from a marked side its real edge is looked for, px.
pub fn reach(photo: &Photo) -> f64 {
    (0.012 * (photo.w as f64).hypot(photo.h as f64)).max(24.0)
}

/// A line through points with outliers (a finger or a pen over the edge):
/// RANSAC for a start, then iteratively reweighted total least squares with
/// Tukey's biweight. Returns the line, the inlier count and their RMS.
pub fn fit_line(points: &[Pt], seed: u64) -> Option<(Line, usize, f64)> {
    if points.len() < 6 {
        return None;
    }
    let mut rng = Rng::new(seed);
    let mut best: Option<(Line, usize)> = None;
    for _ in 0..80 {
        let i = rng.below(points.len());
        let j = rng.below(points.len());
        if i == j || dist(points[i], points[j]) < 1.0 {
            continue;
        }
        let l = Line::through(points[i], points[j]);
        let n = points.iter().filter(|&&p| l.offset(p).abs() < 1.0).count();
        if best.as_ref().is_none_or(|b| n > b.1) {
            best = Some((l, n));
        }
    }
    let (mut line, _) = best?;
    let mut c = 1.5;
    for _ in 0..10 {
        let r: Vec<f64> = points.iter().map(|&p| line.offset(p)).collect();
        let mut abs: Vec<f64> = r.iter().map(|x| x.abs()).collect();
        abs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        // At most 6 px: a gently bowed edge is taken whole, but two edges side
        // by side (the ends of a spiral's rings) must not pull the line between them.
        c = (4.685 * 1.4826 * abs[abs.len() / 2]).clamp(0.35, 6.0);
        let w: Vec<f64> = r.iter().map(|x| if x.abs() < c { (1.0 - (x / c).powi(2)).powi(2) } else { 0.0 }).collect();
        let sw: f64 = w.iter().sum();
        if sw < 1e-9 {
            return None;
        }
        let cx = points.iter().zip(&w).map(|(p, w)| p[0] * w).sum::<f64>() / sw;
        let cy = points.iter().zip(&w).map(|(p, w)| p[1] * w).sum::<f64>() / sw;
        let (mut sxx, mut sxy, mut syy) = (0.0, 0.0, 0.0);
        for (p, w) in points.iter().zip(&w) {
            let (dx, dy) = (p[0] - cx, p[1] - cy);
            sxx += w * dx * dx;
            sxy += w * dx * dy;
            syy += w * dy * dy;
        }
        // Principal direction of the weighted scatter.
        let theta = 0.5 * (2.0 * sxy).atan2(sxx - syy);
        let mut d = [theta.cos(), theta.sin()];
        if d[0] * line.d[0] + d[1] * line.d[1] < 0.0 {
            d = [-d[0], -d[1]];
        }
        line = Line { p: [cx, cy], d };
    }
    let inl: Vec<f64> = points.iter().map(|&p| line.offset(p)).filter(|r| r.abs() < c).collect();
    let rms = (inl.iter().map(|r| r * r).sum::<f64>() / inl.len().max(1) as f64).sqrt();
    Some((line, inl.len(), rms))
}

/// A sheet's edge through (t, u) points — fraction along the side, px across
/// it — with outliers: a parabola from the triple most points agree with
/// (within 1 px), then Tukey-reweighted least squares, the cut-off at most
/// 6 px so that two edges side by side (the ends of a spiral's rings) do not
/// pull it between them. A page bows a little; one bowing more than a paper
/// does (`MAX_BOW` of the side, `len` px) is fitted with a straight line instead.
fn fit_edge(pts: &[(f64, f64)], len: f64, seed: u64) -> Option<[f64; 4]> {
    if pts.len() < 6 {
        return None;
    }
    let mut rng = Rng::new(seed);
    let fit = |deg: usize, rng: &mut Rng| -> Option<[f64; 4]> {
        let mut best: Option<([f64; 4], usize)> = None;
        for _ in 0..120 {
            let pick: Vec<(f64, f64)> = (0..=deg).map(|_| pts[rng.below(pts.len())]).collect();
            if (0..deg).any(|i| pick[i + 1..].iter().any(|q| (q.0 - pick[i].0).abs() < 0.05)) {
                continue;
            }
            let Some(c) = weighted_poly(&pick, &[1.0; 3][..=deg], deg) else { continue };
            let k = pts.iter().filter(|&&(t, u)| (u - crate::warp::poly(&c, t)).abs() < 1.0).count();
            if best.as_ref().is_none_or(|b| k > b.1) {
                best = Some((c, k));
            }
        }
        let (mut c, _) = best?;
        for _ in 0..8 {
            let res: Vec<f64> = pts.iter().map(|&(t, u)| u - crate::warp::poly(&c, t)).collect();
            let mut abs: Vec<f64> = res.iter().map(|r| r.abs()).collect();
            abs.sort_by(|x, y| x.partial_cmp(y).unwrap());
            let k = (4.685 * 1.4826 * abs[abs.len() / 2]).clamp(0.35, 6.0);
            let w: Vec<f64> = res.iter().map(|r| if r.abs() < k { (1.0 - (r / k).powi(2)).powi(2) } else { 0.0 }).collect();
            c = weighted_poly(pts, &w, deg)?;
        }
        Some(c)
    };
    match fit(2, &mut rng) {
        Some(c) if c[2].abs() / 4.0 <= MAX_BOW * len => Some(c),
        _ => fit(1, &mut rng),
    }
}

/// The real edge of the sheet near the marked side a→b (looked for up to
/// `far` px away) as a straight side: the chord of the (gently bowed) edge
/// between the ends of the marked side. Also the RMS of the edge points about
/// the edge, px. None when no edge runs along a sixth of the side.
pub fn snap_side(photo: &Photo, a: Pt, b: Pt, seed: u64, far: f64) -> Option<(Line, f64)> {
    let line0 = Line::through(a, b);
    let len = dist(a, b);
    let n = line0.normal();
    let local = |p: Pt| (((p[0] - a[0]) * line0.d[0] + (p[1] - a[1]) * line0.d[1]) / len, line0.offset(p));
    // Far first, on a smoothed copy. Each profile steps its own way: the desk
    // behind one side may be lighter than the paper in one place and darker in another.
    let rough = edge_points(photo.smooth(), &line0, len, (0.1, 0.9), far, 0.5, 96, 0.0);
    let tu: Vec<(f64, f64)> = rough.iter().map(|q| local(q.0)).collect();
    let c = fit_edge(&tu, len, seed)?;
    let on = |c: &[f64; 4], band: f64, set: &[(f64, f64)]| set.iter().filter(|&&(t, u)| (u - crate::warp::poly(c, t)).abs() < band).count();
    if on(&c, 2.0, &tu) < 16 {
        return None;
    }
    // Then close up on the photo itself, at each point on the edge, the same way round.
    let mut fine = Vec::new();
    for ((p, s), &(t, u)) in rough.iter().zip(&tu) {
        if (u - crate::warp::poly(&c, t)).abs() < 2.0 {
            if let Some((q, _)) = edge_points(&photo.luma, &Line { p: *p, d: line0.d }, 1.0, (0.0, 0.0), 3.0, 0.25, 1, *s).first() {
                fine.push(local(*q));
            }
        }
    }
    let c = fit_edge(&fine, len, seed ^ 0x51de)?;
    let res: Vec<f64> = fine.iter().map(|&(t, u)| u - crate::warp::poly(&c, t)).filter(|r| r.abs() < 1.0).collect();
    // Along most of the side, not bunched in one place: three of its four quarters.
    let mut quarters = [0usize; 4];
    for &(t, u) in &fine {
        if (u - crate::warp::poly(&c, t)).abs() < 1.0 {
            quarters[((t - 0.1) / 0.2).clamp(0.0, 3.0) as usize] += 1;
        }
    }
    if res.len() < 16 || quarters.iter().filter(|&&k| k >= 2).count() < 3 {
        return None;
    }
    let rms = (res.iter().map(|r| r * r).sum::<f64>() / res.len() as f64).sqrt();
    let at = |t: f64| {
        let u = crate::warp::poly(&c, t);
        [a[0] + line0.d[0] * t * len + n[0] * u, a[1] + line0.d[1] * t * len + n[1] * u]
    };
    Some((Line::through(at(0.0), at(1.0)), rms))
}

/// The direction of the printed lines that run along the side a→b just
/// inside it (within `band` px), turned the way of a→b — the turn of the side
/// that makes the profile across them sharpest — if there are such lines.
fn lines_along(photo: &Photo, a: Pt, b: Pt, band: f64) -> Option<Pt> {
    let line = Line::through(a, b);
    let len = dist(a, b);
    let mid = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
    let turn = |phi: f64| [line.d[0] * phi.cos() - line.d[1] * phi.sin(), line.d[0] * phi.sin() + line.d[1] * phi.cos()];
    let steps = (band / 0.5) as usize;
    let sharp = |phi: f64| -> f64 {
        let d = turn(phi);
        let n = [d[1], -d[0]];
        let prof: Vec<f64> = (0..steps)
            .map(|j| {
                let o = -(j as f64) * 0.5;
                (0..64)
                    .map(|i| {
                        let t = 0.8 * (i as f64 + 0.5) / 64.0 - 0.4;
                        photo.luma.sample(mid[0] + n[0] * o + d[0] * t * len, mid[1] + n[1] * o + d[1] * t * len)
                    })
                    .sum::<f64>()
                    / 64.0
            })
            .collect();
        // Lines stand out from the profile's own average over ±6 px.
        let r = 12;
        let hp: Vec<f64> = (r..steps.saturating_sub(r)).map(|j| prof[j] - prof[j - r..=j + r].iter().sum::<f64>() / (2 * r + 1) as f64).collect();
        hp.iter().map(|x| x * x).sum::<f64>() / hp.len().max(1) as f64
    };
    let coarse: Vec<(f64, f64)> = (-24..=24).map(|i| (f64::from(i) * 0.25f64.to_radians(), 0.0)).map(|(phi, _)| (phi, sharp(phi))).collect();
    let &(best, top) = coarse.iter().max_by(|x, y| x.1.partial_cmp(&y.1).unwrap())?;
    let mut all: Vec<f64> = coarse.iter().map(|c| c.1).collect();
    all.sort_by(|x, y| x.partial_cmp(y).unwrap());
    // Lines along one direction, not texture alike in all.
    if top < 2.0 * all[all.len() / 2] {
        return None;
    }
    let fine = (-10..=10).map(|i| best + f64::from(i) * 0.025f64.to_radians()).map(|phi| (phi, sharp(phi)));
    let (phi, _) = fine.max_by(|x, y| x.1.partial_cmp(&y.1).unwrap())?;
    Some(turn(phi))
}

/// The edge of the sheet near the marked side a→b when no single step runs
/// along it (a stack of pages, each with its own edge; paper on a white desk
/// with only a faint shadow): the steps that line up with the sheet's own
/// printed lines. The top page's edge is parallel to its lines, the pages
/// beneath fan out. Looked for `look` px about the side moved `outward` px out.
fn by_lines(photo: &Photo, a: Pt, b: Pt, look: f64, outward: f64) -> Option<Line> {
    let d = lines_along(photo, a, b, 1.5 * look)?;
    let line0 = Line::through(a, b);
    let (n0, len) = (line0.normal(), dist(a, b));
    let out = |p: Pt| [p[0] + n0[0] * outward, p[1] + n0[1] * outward];
    let pts = edge_points(photo.smooth(), &Line::through(out(a), out(b)), len, (0.1, 0.9), look, 0.5, 96, 0.0);
    let along = Line { p: [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0], d };
    let mut off: Vec<(f64, Pt)> = pts.iter().map(|(p, _)| (along.offset(*p), *p)).collect();
    off.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap());
    // The most steps within 10 px of one line that way (the lines in from
    // the edge and the edge itself may differ by a fraction of a degree); of equals, the outer.
    let mut best = (0, 0);
    for i in 0..off.len() {
        let j = off.partition_point(|x| x.0 < off[i].0 + 10.0);
        if j - i >= best.1 - best.0 {
            best = (i, j);
        }
    }
    // Then the edge through them, as a side is snapped.
    let local = |p: &Pt| (((p[0] - a[0]) * line0.d[0] + (p[1] - a[1]) * line0.d[1]) / len, line0.offset(*p));
    let tu: Vec<(f64, f64)> = off[best.0..best.1].iter().map(|x| local(&x.1)).collect();
    let c = fit_edge(&tu, len, 0x11e5)?;
    let mut quarters = [0usize; 4];
    let mut on = 0;
    for &(t, u) in &tu {
        if (u - crate::warp::poly(&c, t)).abs() < 2.0 {
            on += 1;
            quarters[((t - 0.1) / 0.2).clamp(0.0, 3.0) as usize] += 1;
        }
    }
    if on < 12 || quarters.iter().filter(|&&k| k >= 2).count() < 3 {
        return None;
    }
    let at = |t: f64| {
        let u = crate::warp::poly(&c, t);
        [a[0] + line0.d[0] * t * len + n0[0] * u, a[1] + line0.d[1] * t * len + n0[1] * u]
    };
    Some(Line::through(at(0.0), at(1.0)))
}

#[derive(Serialize, Debug)]
pub struct Snapped {
    pub corners: [Pt; 4],
    /// Which sides now lie on a found edge.
    pub snapped: [bool; 4],
    /// Scatter of the edge points about each snapped side, px.
    pub rms: [f64; 4],
}

/// Moves the sides `which` onto the sheet's real edges; corners are where the sides meet.
pub fn snap(photo: &Photo, corners: [Pt; 4], which: [bool; 4]) -> Snapped {
    snap_within(photo, corners, which, reach(photo), 0.0)
}

/// The same, looking for each edge up to `look` px from its marked side moved
/// `outward` px out (when the side is known to lie inside the sheet).
pub fn snap_within(photo: &Photo, corners: [Pt; 4], which: [bool; 4], look: f64, outward: f64) -> Snapped {
    let diag = (photo.w as f64).hypot(photo.h as f64);
    let far = (0.04 * diag).max(60.0).max(2.5 * look);
    let marked: Vec<Line> = (0..4).map(|k| Line::through(corners[k], corners[(k + 1) % 4])).collect();
    let mut lines = marked.clone();
    let mut snapped = [false; 4];
    let mut rms = [f64::NAN; 4];
    for k in 0..4 {
        if which[k] {
            let n = marked[k].normal();
            let out = |p: Pt| [p[0] + n[0] * outward, p[1] + n[1] * outward];
            if let Some((l, r)) = snap_side(photo, out(corners[k]), out(corners[(k + 1) % 4]), 0x5eed + k as u64, look) {
                lines[k] = l;
                snapped[k] = true;
                rms[k] = r;
            } else if let Some(l) = by_lines(photo, corners[k], corners[(k + 1) % 4], look, outward) {
                lines[k] = l;
                snapped[k] = true;
            }
        }
    }
    let meet = |lines: &[Line]| -> Option<[Pt; 4]> {
        let mut q = [[0.0; 2]; 4];
        for k in 0..4 {
            q[k] = lines[(k + 3) % 4].intersect(&lines[k])?;
        }
        Some(q)
    };
    // A side that ran off to some other edge (the desk's) is dropped.
    for _ in 0..2 {
        let Some(q) = meet(&lines) else { break };
        let mut ok = true;
        for k in 0..4 {
            if dist(q[k], corners[k]) > far {
                for s in [(k + 3) % 4, k] {
                    if snapped[s] {
                        lines[s] = marked[s];
                        snapped[s] = false;
                        rms[s] = f64::NAN;
                        ok = false;
                    }
                }
            }
        }
        if ok {
            break;
        }
    }
    match meet(&lines) {
        Some(q) if convex_clockwise(&q) => Snapped { corners: q, snapped, rms },
        _ => Snapped { corners, snapped: [false; 4], rms: [f64::NAN; 4] },
    }
}

/// Standard normal cumulative distribution.
pub fn phi(x: f64) -> f64 {
    0.5 * (1.0 + erf(x / std::f64::consts::SQRT_2))
}

/// Abramowitz–Stegun 7.1.26 (error below 1.5e-7).
pub fn erf(x: f64) -> f64 {
    let s = x.signum();
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * x);
    let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * (-x * x).exp();
    s * y
}

#[derive(Serialize, Debug, Clone, Copy)]
pub struct EdgeBlur {
    /// Gaussian sigma of the photo's blur at this edge, px.
    pub sigma: f64,
    /// Light overshoot beside the edge from the camera's sharpening, as a fraction of the step.
    pub halo: f64,
    /// Unsharp-mask amount (radius `SHARPEN_RADIUS`) that explains it.
    pub sharpen: f64,
}

/// How blurred the step across a (snapped) side is: the mean profile across
/// the edge fitted with a blurred step `a + b·Φ(−(u − u0)/σ)`.
pub fn edge_blur(photo: &Photo, a: Pt, b: Pt) -> Option<EdgeBlur> {
    let line = Line::through(a, b);
    let n = line.normal();
    let len = dist(a, b);
    let (reach, step) = (8.0, 0.25);
    let m = (2.0 * reach / step) as usize + 1;
    let u = |j: usize| j as f64 * step - reach;
    // Each profile centred on the edge where it crosses it — a page bows away
    // from the side, its chord — and turned so the inside is the lighter: the
    // step is read the same way whichever way the paper and the desk differ.
    let search = (MAX_BOW * len).clamp(4.0, 30.0);
    let profiles: Vec<Vec<f64>> = edge_points(&photo.luma, &line, len, (0.12, 0.88), search, step, 80, 0.0)
        .into_iter()
        .map(|(p, s)| (0..m).map(|j| s * photo.luma.sample(p[0] + n[0] * u(j), p[1] + n[1] * u(j))).collect())
        .collect();
    let contrast = |p: &[f64]| p[..8].iter().sum::<f64>() / 8.0 - p[m - 8..].iter().sum::<f64>() / 8.0;
    let mut sum = vec![0.0; m];
    let mut used = 0;
    for prof in &profiles {
        // Only profiles whose own steepest drop is the edge (nothing lying over it here).
        let (mut jm, mut dm) = (0, f64::INFINITY);
        for j in 1..m - 1 {
            let d = prof[j + 1] - prof[j - 1];
            if d < dm {
                (jm, dm) = (j, d);
            }
        }
        if u(jm).abs() > 1.0 || contrast(prof) < 0.012 {
            continue;
        }
        for (s, v) in sum.iter_mut().zip(prof) {
            *s += v;
        }
        used += 1;
    }
    if used < 12 {
        return None;
    }
    let e: Vec<f64> = sum.iter().map(|s| s / used as f64).collect();
    // Grid search over (σ, u0), then (σ, u0, k) near it, for the model of a
    // blurred step sharpened by the camera:
    //   (1 + k)·Φ(−x/σ) − k·Φ(−x/√(σ² + r²)),  x = u − u0,
    // with offset and scale by least squares for each.
    let fit_range: Vec<usize> = (0..m).filter(|&j| u(j).abs() <= 6.0).collect();
    let sse_of = |sigma: f64, u0: f64, k: f64| -> f64 {
        let soft = (sigma * sigma + SHARPEN_RADIUS * SHARPEN_RADIUS).sqrt();
        let model = |j: usize| {
            let x = u(j) - u0;
            (1.0 + k) * phi(-x / sigma) - k * phi(-x / soft)
        };
        let (mut sx, mut sy, mut sxx, mut sxy) = (0.0, 0.0, 0.0, 0.0);
        for &j in &fit_range {
            let x = model(j);
            sx += x;
            sy += e[j];
            sxx += x * x;
            sxy += x * e[j];
        }
        let nn = fit_range.len() as f64;
        let den = nn * sxx - sx * sx;
        if den.abs() < 1e-12 {
            return f64::INFINITY;
        }
        let bb = (nn * sxy - sx * sy) / den;
        let aa = (sy - bb * sx) / nn;
        fit_range.iter().map(|&j| (aa + bb * model(j) - e[j]).powi(2)).sum()
    };
    let mut best = (f64::INFINITY, 1.0, 0.0, 0.0);
    for si in 0..140 {
        let sigma = 0.15 * (5.0f64 / 0.15).powf(si as f64 / 139.0);
        for ui in 0..=80 {
            let u0 = -1.0 + ui as f64 * 0.025;
            let sse = sse_of(sigma, u0, 0.0);
            if sse < best.0 {
                best = (sse, sigma, u0, 0.0);
            }
        }
    }
    let (_, s0, u00, _) = best;
    for si in 0..40 {
        let sigma = s0 * (0.5 + 1.5 * si as f64 / 39.0);
        for ui in 0..=10 {
            let u0 = u00 - 0.25 + ui as f64 * 0.05;
            for ki in 0..=30 {
                let k = ki as f64 * 0.1;
                let sse = sse_of(sigma, u0, k);
                if sse < best.0 {
                    best = (sse, sigma, u0, k);
                }
            }
        }
    }
    let (_, sigma, u0, sharpen) = best;
    let hi = e[..8].iter().sum::<f64>() / 8.0;
    let lo = e[m - 8..].iter().sum::<f64>() / 8.0;
    let step_size = (hi - lo).max(1e-6);
    let near = |j: usize| (u(j) - u0).abs() <= 4.0 * sigma + 2.0;
    let over = (0..m).filter(|&j| u(j) < u0 && near(j)).map(|j| e[j]).fold(f64::NEG_INFINITY, f64::max) - hi;
    let under = lo - (0..m).filter(|&j| u(j) > u0 && near(j)).map(|j| e[j]).fold(f64::INFINITY, f64::min);
    let halo = ((over.max(0.0) + under.max(0.0)) / 2.0 / step_size).clamp(0.0, 0.5);
    // The profile carries two blurs that are not the lens's: bilinear sampling
    // between pixels (variance 1/6) and the pixel's own area (1/12), which the
    // ink drawn per pixel gets anyway.
    let sigma = (sigma * sigma - 0.25).max(0.0).sqrt();
    Some(EdgeBlur { sigma, halo, sharpen })
}

/// Weighted least squares for a polynomial of degree `deg` ≤ 3 through
/// (t, value) points; the terms above `deg` are 0.
fn weighted_poly(pts: &[(f64, f64)], w: &[f64], deg: usize) -> Option<[f64; 4]> {
    let n = deg + 1;
    let mut a = [[0.0; 5]; 4];
    for (&(t, y), &wi) in pts.iter().zip(w) {
        let p = [1.0, t, t * t, t * t * t];
        for i in 0..n {
            for j in 0..n {
                a[i][j] += wi * p[i] * p[j];
            }
            a[i][4] += wi * p[i] * y;
        }
    }
    for col in 0..n {
        let piv = (col..n).max_by(|&i, &j| a[i][col].abs().partial_cmp(&a[j][col].abs()).unwrap())?;
        if a[piv][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, piv);
        for r in 0..n {
            if r != col {
                let k = a[r][col] / a[col][col];
                for cc in col..5 {
                    a[r][cc] -= k * a[col][cc];
                }
            }
        }
    }
    let mut c = [0.0; 4];
    for i in 0..n {
        c[i] = a[i][4] / a[i][i];
    }
    Some(c)
}

/// Weighted least squares for a cubic through (t, value) points, Tukey-reweighted
/// against outliers: the cubic, the share of points that fit it, their RMS.
fn fit_cubic(pts: &[(f64, f64)]) -> Option<([f64; 4], f64, f64)> {
    let mut w = vec![1.0; pts.len()];
    let mut c = [0.0; 4];
    for _ in 0..8 {
        c = weighted_poly(pts, &w, 3)?;
        let res: Vec<f64> = pts.iter().map(|&(t, y)| y - crate::warp::poly(&c, t)).collect();
        let mut abs: Vec<f64> = res.iter().map(|r| r.abs()).collect();
        abs.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let k = (4.685 * 1.4826 * abs[abs.len() / 2]).max(0.3);
        w = res.iter().map(|r| if r.abs() < k { (1.0 - (r / k).powi(2)).powi(2) } else { 0.0 }).collect();
    }
    let inl: Vec<f64> = pts.iter().zip(&w).filter(|(_, &w)| w > 0.0).map(|(&(t, y), _)| y - crate::warp::poly(&c, t)).collect();
    let rms = (inl.iter().map(|r| r * r).sum::<f64>() / inl.len().max(1) as f64).sqrt();
    Some((c, inl.len() as f64 / pts.len().max(1) as f64, rms))
}

#[derive(Serialize, Debug)]
pub struct Curved {
    /// Where the curved sides meet.
    pub corners: [Pt; 4],
    /// Each side's bow from the straight line between those corners: a cubic in
    /// the fraction along the side, photo px along the outward normal (zero at the ends).
    pub bulge: [[f64; 4]; 4],
    /// The largest bow, px.
    pub max: f64,
    /// Sides whose edge was found.
    pub fitted: [bool; 4],
}

/// The sheet's real edges as curves: points along every side to a fraction of
/// a pixel, a cubic through them (outliers dropped), corners where the curves
/// meet. A side counts as curved only when the curve is believable: most
/// points on it, tightly, bowing no more than a paper does (`MAX_BOW` of the side)
/// and ending near the corners — printed lines or a spiral next to the edge
/// must not bend the sheet.
pub fn curved_sides(photo: &Photo, corners: [Pt; 4]) -> Curved {
    let reach = reach(photo);
    let mut cubic = [[0.0; 4]; 4];
    let mut fitted = [false; 4];
    let lines: Vec<Line> = (0..4).map(|k| Line::through(corners[k], corners[(k + 1) % 4])).collect();
    for k in 0..4 {
        let (a, b) = (corners[k], corners[(k + 1) % 4]);
        let (line, len) = (lines[k], dist(a, b));
        let mut pts = Vec::new();
        for (p, s) in edge_points(photo.smooth(), &line, len, (0.02, 0.98), reach, 0.5, 64, 0.0) {
            // Close up on the photo itself.
            if let Some((q, _)) = edge_points(&photo.luma, &Line { p, d: line.d }, 1.0, (0.0, 0.0), 3.0, 0.25, 1, s).first() {
                let t = ((q[0] - a[0]) * line.d[0] + (q[1] - a[1]) * line.d[1]) / len;
                pts.push((t, line.offset(*q)));
            }
        }
        if pts.len() >= 24 {
            if let Some((c, share, rms)) = fit_cubic(&pts) {
                let ends = crate::warp::poly(&c, 0.0).abs().max(crate::warp::poly(&c, 1.0).abs());
                let end = crate::warp::poly(&c, 1.0);
                let bow = (0..=20).map(|i| {
                    let t = i as f64 / 20.0;
                    (crate::warp::poly(&c, t) - (1.0 - t) * c[0] - t * end).abs()
                });
                let bow = bow.fold(0.0, f64::max);
                if share >= 0.6 && rms <= 1.0 && bow <= MAX_BOW * len && ends <= (0.005 * len).max(4.0) {
                    cubic[k] = c;
                    fitted[k] = true;
                }
            }
        }
    }
    // The ends of neighbouring curves move the corner (the sides are nearly at right angles).
    let at = |k: usize, t: f64| crate::warp::poly(&cubic[k], t);
    let mut moved = corners;
    for k in 0..4 {
        let prev = (k + 3) % 4;
        let (np, nk) = (lines[prev].normal(), lines[k].normal());
        let (dp, dk) = (at(prev, 1.0), at(k, 0.0));
        moved[k] = [corners[k][0] + dp * np[0] + dk * nk[0], corners[k][1] + dp * np[1] + dk * nk[1]];
    }
    if !convex_clockwise(&moved) || (0..4).any(|k| dist(moved[k], corners[k]) > reach * 2.0) {
        return Curved { corners, bulge: [[0.0; 4]; 4], max: 0.0, fitted: [false; 4] };
    }
    // The bow left over once the straight part goes from corner to corner.
    let bulge: [[f64; 4]; 4] = std::array::from_fn(|k| {
        let c = cubic[k];
        let end = crate::warp::poly(&c, 1.0);
        [0.0, c[1] + c[0] - end, c[2], c[3]]
    });
    let max = (0..4)
        .filter(|&k| fitted[k])
        .flat_map(|k| (0..=20).map(move |i| crate::warp::poly(&bulge[k], i as f64 / 20.0).abs()))
        .fold(0.0, f64::max);
    Curved { corners: moved, bulge, max, fitted }
}
