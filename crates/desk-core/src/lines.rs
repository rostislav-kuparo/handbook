//! Straight lines in the photo: the edges of the sheet and of the desk, a
//! notebook's printed lines, a frame on a printed form. Found as in LSD:
//! pixels whose gradient turns the same way grow into thin regions, each
//! region a short straight piece; pieces lying on one line (a printed line
//! cut by the lines that cross it) are joined into one segment.

use std::f64::consts::{PI, TAU};

use crate::img::{Gray, Photo};
use crate::quad::Pt;

/// A straight segment, photo px; `seen`: how much of it was really seen (its pieces' length, px).
#[derive(Clone, Copy, Debug)]
pub struct Segment {
    pub a: Pt,
    pub b: Pt,
    pub seen: f64,
}

impl Segment {
    pub fn len(&self) -> f64 {
        (self.b[0] - self.a[0]).hypot(self.b[1] - self.a[1])
    }
}

/// Longest side of the copy the lines are looked for on.
const SIDE: usize = 1024;
/// Smallest gradient that counts (sRGB levels, as LSD's 2 / sin 22.5°).
const RHO: f32 = 5.2;
/// How far a pixel's gradient may turn from its region's (22.5°, as LSD).
const TURN: f64 = PI / 8.0;

/// One piece: a thin region of one gradient direction, as a line (small-copy px).
#[derive(Clone, Copy)]
struct Piece {
    c: Pt,
    /// Unit direction, its angle in 0..π.
    d: Pt,
    half: f64,
    /// Along the edge with its darker side on a fixed hand: the two edges of a printed line point opposite ways and are joined apart.
    t: Pt,
}

/// The straight segments of the photo at least `min_frac` of its diagonal long, longest first.
pub fn segments(photo: &Photo, min_frac: f64) -> Vec<Segment> {
    let k = (photo.w.max(photo.h) as f64 / SIDE as f64).ceil().max(1.0) as usize;
    let (w, h) = (photo.w / k, photo.h / k);
    if w < 16 || h < 16 {
        return vec![];
    }
    // The small copy, box-averaged, in sRGB-like levels (lines are found as the eye sees them).
    let mut img = Gray::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let mut s = 0.0;
            for yy in y * k..(y + 1) * k {
                for xx in x * k..(x + 1) * k {
                    s += photo.luma.at(xx, yy);
                }
            }
            img.data[y * w + x] = 255.0 * (s / (k * k) as f32).max(0.0).powf(1.0 / 2.2);
        }
    }
    if k == 1 {
        img = img.blur(0.6);
    }
    let pieces = pieces(&img);
    let diag = (w as f64).hypot(h as f64);
    join(&pieces, min_frac * diag)
        .into_iter()
        .map(|s| Segment { a: [(s.a[0] + 1.0) * k as f64, (s.a[1] + 1.0) * k as f64], b: [(s.b[0] + 1.0) * k as f64, (s.b[1] + 1.0) * k as f64], seen: s.seen * k as f64 })
        .collect()
}

fn turn(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % TAU;
    if d > PI {
        TAU - d
    } else {
        d
    }
}

/// The pieces: regions grown from the strongest gradients, kept when thin and dense.
fn pieces(img: &Gray) -> Vec<Piece> {
    let (w, h) = (img.w - 1, img.h - 1);
    let mut mag = vec![0f32; w * h];
    let mut ang = vec![0f64; w * h];
    for y in 0..h {
        for x in 0..w {
            let (a, b, c, d) = (img.at(x, y), img.at(x + 1, y), img.at(x, y + 1), img.at(x + 1, y + 1));
            let gx = (b + d - a - c) / 2.0;
            let gy = (c + d - a - b) / 2.0;
            let m = gx.hypot(gy);
            mag[y * w + x] = m;
            // The level line's direction (across the gradient), with the edge's polarity.
            ang[y * w + x] = (gx as f64).atan2(-gy as f64);
        }
    }
    let mut order: Vec<u32> = (0..(w * h) as u32).filter(|&i| mag[i as usize] > RHO).collect();
    order.sort_unstable_by(|&a, &b| mag[b as usize].total_cmp(&mag[a as usize]));
    let mut used = vec![false; w * h];
    let mut out = vec![];
    let mut region: Vec<usize> = vec![];
    for &seed in &order {
        let seed = seed as usize;
        if used[seed] {
            continue;
        }
        region.clear();
        region.push(seed);
        used[seed] = true;
        let (mut sx, mut sy) = (ang[seed].cos(), ang[seed].sin());
        let mut theta = ang[seed];
        let mut i = 0;
        while i < region.len() {
            let (px, py) = ((region[i] % w) as isize, (region[i] / w) as isize);
            i += 1;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let (x, y) = (px + dx, py + dy);
                    if x < 0 || y < 0 || x >= w as isize || y >= h as isize {
                        continue;
                    }
                    let n = y as usize * w + x as usize;
                    if used[n] || mag[n] <= RHO || turn(ang[n], theta) > TURN {
                        continue;
                    }
                    used[n] = true;
                    region.push(n);
                    sx += ang[n].cos();
                    sy += ang[n].sin();
                    theta = sy.atan2(sx);
                }
            }
        }
        if region.len() >= 5 {
            if let Some(p) = piece_of(&region, w, &mag, theta) {
                out.push(p);
            }
        }
    }
    out
}

/// A region as a piece of line: its axis by the weighted moments; none when it is thick, sparse or turned from its gradients.
fn piece_of(region: &[usize], w: usize, mag: &[f32], theta: f64) -> Option<Piece> {
    let (mut sm, mut cx, mut cy) = (0.0, 0.0, 0.0);
    for &i in region {
        let m = mag[i] as f64;
        sm += m;
        cx += m * (i % w) as f64;
        cy += m * (i / w) as f64;
    }
    cx /= sm;
    cy /= sm;
    let (mut ixx, mut iyy, mut ixy) = (0.0, 0.0, 0.0);
    for &i in region {
        let m = mag[i] as f64;
        let (dx, dy) = ((i % w) as f64 - cx, (i / w) as f64 - cy);
        ixx += m * dx * dx;
        iyy += m * dy * dy;
        ixy += m * dx * dy;
    }
    let a = 0.5 * (2.0 * ixy).atan2(ixx - iyy);
    // The axis must run along the level lines the region grew by.
    if turn(a, theta).min(turn(a + PI, theta)) > 0.45 {
        return None;
    }
    let d = [a.cos(), a.sin()];
    let (mut l0, mut l1, mut w0, mut w1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for &i in region {
        let (dx, dy) = ((i % w) as f64 - cx, (i / w) as f64 - cy);
        let along = dx * d[0] + dy * d[1];
        let across = -dx * d[1] + dy * d[0];
        l0 = l0.min(along);
        l1 = l1.max(along);
        w0 = w0.min(across);
        w1 = w1.max(across);
    }
    let (len, wid) = (l1 - l0 + 1.0, w1 - w0 + 1.0);
    if len < 5.0 || wid > (0.12 * len).max(3.5) || region.len() as f64 / (len * wid) < 0.5 {
        return None;
    }
    let mid = 0.5 * (l0 + l1);
    // The direction's angle in 0..π, so pieces of one line agree whatever their edge's polarity.
    let d = if d[1] < 0.0 || (d[1] == 0.0 && d[0] < 0.0) { [-d[0], -d[1]] } else { d };
    Some(Piece { c: [cx + d[0] * mid, cy + d[1] * mid], d, half: 0.5 * (l1 - l0), t: [theta.cos(), theta.sin()] })
}

/// A joined line, small-copy px.
struct Joined {
    a: Pt,
    b: Pt,
    seen: f64,
}

/// Pieces on one line, near each other, joined (union of neighbours), then each group fitted as one segment.
fn join(pieces: &[Piece], min_len: f64) -> Vec<Joined> {
    let n = pieces.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn root(p: &mut [usize], mut i: usize) -> usize {
        while p[i] != i {
            p[i] = p[p[i]];
            i = p[i];
        }
        i
    }
    // Pieces by the cells their ends fall into: only neighbours are compared.
    const CELL: f64 = 16.0;
    let mut cells: std::collections::HashMap<(i64, i64), Vec<usize>> = std::collections::HashMap::new();
    let ends = |p: &Piece| [[p.c[0] - p.d[0] * p.half, p.c[1] - p.d[1] * p.half], [p.c[0] + p.d[0] * p.half, p.c[1] + p.d[1] * p.half]];
    for (i, p) in pieces.iter().enumerate() {
        for e in ends(p) {
            cells.entry(((e[0] / CELL).floor() as i64, (e[1] / CELL).floor() as i64)).or_default().push(i);
        }
    }
    let near = |p: &Piece, q: &Piece| {
        // The same edge (not the other side of a printed line), turned no more than a pixel over the shorter one
        // (at least 3°), each on the other's line, and a short gap between them.
        let cos = (p.d[0] * q.d[0] + p.d[1] * q.d[1]).abs();
        let tol = (1.0 / p.half.min(q.half)).atan().max(3f64.to_radians());
        if p.t[0] * q.t[0] + p.t[1] * q.t[1] < 0.0 || cos < tol.cos() {
            return false;
        }
        let along = (q.c[0] - p.c[0]) * p.d[0] + (q.c[1] - p.c[1]) * p.d[1];
        if along.abs() - p.half - q.half > 6.0 {
            return false;
        }
        // Off each other's line where they come closest (a staircase step of a slanting line is a pixel).
        let toward = along.signum();
        let pe = [p.c[0] + p.d[0] * p.half * toward, p.c[1] + p.d[1] * p.half * toward];
        let qe = [q.c[0] - p.d[0] * q.half * toward, q.c[1] - p.d[1] * q.half * toward];
        let off = |a: &Piece, e: Pt| ((e[0] - a.c[0]) * -a.d[1] + (e[1] - a.c[1]) * a.d[0]).abs();
        off(p, qe) <= 1.5 && off(q, pe) <= 1.5
    };
    for (i, p) in pieces.iter().enumerate() {
        for e in ends(p) {
            let (cx, cy) = ((e[0] / CELL).floor() as i64, (e[1] / CELL).floor() as i64);
            for gy in cy - 1..=cy + 1 {
                for gx in cx - 1..=cx + 1 {
                    let Some(list) = cells.get(&(gx, gy)) else { continue };
                    for &j in list {
                        if j > i && near(p, &pieces[j]) {
                            let (a, b) = (root(&mut parent, i), root(&mut parent, j));
                            if a != b {
                                parent[a] = b;
                            }
                        }
                    }
                }
            }
        }
    }
    let mut groups: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
    for i in 0..n {
        let r = root(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }
    let mut out = vec![];
    for g in groups.values() {
        let seen: f64 = g.iter().map(|&i| 2.0 * pieces[i].half).sum();
        if seen < 0.5 * min_len {
            continue;
        }
        // The line through the pieces' ends, weighted by their length.
        let (mut sw, mut cx, mut cy) = (0.0, 0.0, 0.0);
        for &i in g {
            for e in ends(&pieces[i]) {
                sw += pieces[i].half;
                cx += pieces[i].half * e[0];
                cy += pieces[i].half * e[1];
            }
        }
        cx /= sw;
        cy /= sw;
        let (mut ixx, mut iyy, mut ixy) = (0.0, 0.0, 0.0);
        for &i in g {
            for e in ends(&pieces[i]) {
                let (dx, dy) = (e[0] - cx, e[1] - cy);
                ixx += pieces[i].half * dx * dx;
                iyy += pieces[i].half * dy * dy;
                ixy += pieces[i].half * dx * dy;
            }
        }
        let a = 0.5 * (2.0 * ixy).atan2(ixx - iyy);
        let d = [a.cos(), a.sin()];
        let (mut l0, mut l1, mut worst) = (f64::MAX, f64::MIN, 0f64);
        for &i in g {
            for e in ends(&pieces[i]) {
                let (dx, dy) = (e[0] - cx, e[1] - cy);
                l0 = l0.min(dx * d[0] + dy * d[1]);
                l1 = l1.max(dx * d[0] + dy * d[1]);
                worst = worst.max((-dx * d[1] + dy * d[0]).abs());
            }
        }
        // Long, mostly seen (not a row of unrelated dots), and straight.
        if l1 - l0 < min_len || seen < 0.5 * (l1 - l0) || worst > 2.0 + 0.004 * (l1 - l0) {
            continue;
        }
        out.push(Joined { a: [cx + d[0] * l0, cy + d[1] * l0], b: [cx + d[0] * l1, cy + d[1] * l1], seen });
    }
    out.sort_by(|p, q| q.seen.total_cmp(&p.seen));
    out
}
