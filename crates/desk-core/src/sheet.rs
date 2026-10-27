//! Where the sheet is: the largest bright, colourless region of the photo,
//! as document-scanner apps find it, reduced to a quadrilateral — or, on a
//! desk as white as the paper, the region its printed lines cover.

use serde::Serialize;

use crate::img::{lut, Photo};
use crate::quad::{area, convex_clockwise, cross, order_corners, sub, Pt};

#[derive(Serialize, Debug)]
pub struct Found {
    pub corners: [Pt; 4],
    /// 0..1: how well the bright region fills the quadrilateral (1: a clean sheet).
    pub confidence: f64,
}

/// Longest side of the copy the search runs on.
const SEARCH_SIDE: usize = 768;

pub fn find_sheet(photo: &Photo) -> Option<Found> {
    // A small copy: «paperness» = brightness, less for coloured pixels.
    let k = (photo.w.max(photo.h) as f64 / SEARCH_SIDE as f64).ceil().max(1.0) as usize;
    let (w, h) = (photo.w / k, photo.h / k);
    if w < 16 || h < 16 {
        return None;
    }
    let t = lut();
    let mut score = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let (mut l, mut sat) = (0f32, 0f32);
            for yy in y * k..(y + 1) * k {
                for xx in x * k..(x + 1) * k {
                    let (r, g, b) = (photo.byte(xx, yy, 0), photo.byte(xx, yy, 1), photo.byte(xx, yy, 2));
                    let (mx, mn) = (r.max(g).max(b) as f32, r.min(g).min(b) as f32);
                    sat += if mx > 0.0 { (mx - mn) / mx } else { 0.0 };
                    l += 0.2126 * t[r as usize] + 0.7152 * t[g as usize] + 0.0722 * t[b as usize];
                }
            }
            let n = (k * k) as f32;
            score[y * w + x] = (l / n).powf(1.0 / 2.2) * (1.0 - 0.7 * (sat / n));
        }
    }

    let thr = otsu(&score);
    let mut mask: Vec<bool> = score.iter().map(|&s| s > thr).collect();
    mask = morph(&mask, w, h, 2, true);
    mask = morph(&mask, w, h, 2, false);
    mask = morph(&mask, w, h, 2, false);
    mask = morph(&mask, w, h, 2, true);

    let (labels, sizes) = components(&mask, w, h);
    let mut bbox = vec![(w, 0, h, 0); sizes.len()];
    for y in 0..h {
        for x in 0..w {
            let l = labels[y * w + x] as usize;
            if l > 0 {
                let b = &mut bbox[l - 1];
                *b = (b.0.min(x), b.1.max(x), b.2.min(y), b.3.max(y));
            }
        }
    }
    // The largest region that is not the whole frame (a bright desk would be).
    let mut order: Vec<usize> = (0..sizes.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(sizes[i]));
    let best = order.into_iter().find(|&i| bbox[i] != (0, w - 1, 0, h - 1))?;
    let label = best as u32 + 1;
    let region = sizes[best] as f64;
    if region < 0.03 * (w * h) as f64 {
        return None;
    }

    // Boundary pixels → convex hull → the largest quadrilateral on it.
    let mut pts: Vec<Pt> = Vec::new();
    for y in 0..h {
        for x in 0..w {
            if labels[y * w + x] != label {
                continue;
            }
            let edge = x == 0 || y == 0 || x == w - 1 || y == h - 1 || [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)].iter().any(|&(a, b)| labels[b * w + a] != label);
            if edge {
                pts.push([x as f64 + 0.5, y as f64 + 0.5]);
            }
        }
    }
    let mut hull = convex_hull(pts);
    simplify(&mut hull, 32);
    let quad = largest_quad(&hull)?;
    let fill = (region / area(&quad)).min(1.0);
    let scaled = quad.map(|p| [p[0] * k as f64, p[1] * k as f64]);
    let corners = order_corners(scaled);
    if !convex_clockwise(&corners) {
        return None;
    }
    Some(Found { corners, confidence: fill })
}

/// Otsu's threshold on values in 0..1.
fn otsu(v: &[f32]) -> f32 {
    let mut hist = [0f64; 256];
    for &s in v {
        hist[(s.clamp(0.0, 1.0) * 255.0) as usize] += 1.0;
    }
    let total = v.len() as f64;
    let sum_all: f64 = hist.iter().enumerate().map(|(i, c)| i as f64 * c).sum();
    let (mut wb, mut sb, mut best, mut at) = (0.0, 0.0, -1.0, 128);
    for (i, c) in hist.iter().enumerate() {
        wb += c;
        if wb == 0.0 {
            continue;
        }
        let wf = total - wb;
        if wf == 0.0 {
            break;
        }
        sb += i as f64 * c;
        let (mb, mf) = (sb / wb, (sum_all - sb) / wf);
        let between = wb * wf * (mb - mf) * (mb - mf);
        if between > best {
            best = between;
            at = i;
        }
    }
    (at as f32 + 0.5) / 255.0
}

/// Dilation (`grow`) or erosion by a square of radius `r`.
pub(crate) fn morph(m: &[bool], w: usize, h: usize, r: usize, grow: bool) -> Vec<bool> {
    let pass = |src: &[bool], horizontal: bool| -> Vec<bool> {
        let mut out = vec![false; w * h];
        for y in 0..h {
            for x in 0..w {
                let (lo, hi, at) = if horizontal { (x.saturating_sub(r), (x + r).min(w - 1), y) } else { (y.saturating_sub(r), (y + r).min(h - 1), x) };
                let get = |i: usize| if horizontal { src[at * w + i] } else { src[i * w + at] };
                out[y * w + x] = if grow { (lo..=hi).any(get) } else { (lo..=hi).all(get) };
            }
        }
        out
    };
    pass(&pass(m, true), false)
}

/// 4-connected regions: label per pixel (0: background) and size per label.
pub(crate) fn components(m: &[bool], w: usize, h: usize) -> (Vec<u32>, Vec<usize>) {
    let mut labels = vec![0u32; w * h];
    let mut sizes = Vec::new();
    let mut stack = Vec::new();
    for start in 0..w * h {
        if !m[start] || labels[start] != 0 {
            continue;
        }
        let label = sizes.len() as u32 + 1;
        let mut size = 0;
        labels[start] = label;
        stack.push(start);
        while let Some(i) = stack.pop() {
            size += 1;
            let (x, y) = (i % w, i / w);
            let mut visit = |j: usize| {
                if m[j] && labels[j] == 0 {
                    labels[j] = label;
                    stack.push(j);
                }
            };
            if x > 0 {
                visit(i - 1);
            }
            if x + 1 < w {
                visit(i + 1);
            }
            if y > 0 {
                visit(i - w);
            }
            if y + 1 < h {
                visit(i + w);
            }
        }
        sizes.push(size);
    }
    (labels, sizes)
}

/// Andrew's monotone chain; clockwise on screen (y down).
fn convex_hull(mut p: Vec<Pt>) -> Vec<Pt> {
    p.sort_by(|a, b| a.partial_cmp(b).unwrap());
    p.dedup();
    if p.len() < 3 {
        return p;
    }
    let turn = |o: Pt, a: Pt, b: Pt| cross(sub(a, o), sub(b, o));
    let mut lower: Vec<Pt> = Vec::new();
    for &q in &p {
        while lower.len() >= 2 && turn(lower[lower.len() - 2], lower[lower.len() - 1], q) <= 0.0 {
            lower.pop();
        }
        lower.push(q);
    }
    let mut upper: Vec<Pt> = Vec::new();
    for &q in p.iter().rev() {
        while upper.len() >= 2 && turn(upper[upper.len() - 2], upper[upper.len() - 1], q) <= 0.0 {
            upper.pop();
        }
        upper.push(q);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// Drops the hull vertices that matter least (smallest triangle with their neighbours) down to `n`.
fn simplify(hull: &mut Vec<Pt>, n: usize) {
    while hull.len() > n {
        let m = hull.len();
        let (mut best, mut at) = (f64::INFINITY, 0);
        for i in 0..m {
            let (a, b, c) = (hull[(i + m - 1) % m], hull[i], hull[(i + 1) % m]);
            let tri = cross(sub(b, a), sub(c, a)).abs();
            if tri < best {
                best = tri;
                at = i;
            }
        }
        hull.remove(at);
    }
}

/// The largest-area quadrilateral with its corners among the hull's vertices.
fn largest_quad(hull: &[Pt]) -> Option<[Pt; 4]> {
    let n = hull.len();
    if n < 4 {
        return None;
    }
    let mut best = (0.0, [0usize; 4]);
    for a in 0..n {
        for b in a + 1..n {
            for c in b + 1..n {
                for d in c + 1..n {
                    let q = [hull[a], hull[b], hull[c], hull[d]];
                    let s = area(&q);
                    if s > best.0 {
                        best = (s, [a, b, c, d]);
                    }
                }
            }
        }
    }
    let [a, b, c, d] = best.1;
    Some([hull[a], hull[b], hull[c], hull[d]])
}

/// Side of the blocks the printed lines are looked for in, px of the small copy.
const BLOCK: usize = 32;

/// The sheet found by its printed lines, and whether it fills the whole frame (a scan).
pub struct ByLines {
    pub found: Found,
    pub scan: bool,
    /// How far inside the real edge the lined region may stop, photo px.
    pub slack: f64,
}

/// Where the desk is as light as the paper, the paper's grid or ruling tells
/// them apart: blocks of the photo whose brightness repeats every few px
/// across or down. Lines up to every border of the frame: a scan.
pub fn find_by_lines(photo: &Photo) -> Option<ByLines> {
    let (k, bw, bh, lined) = lined_blocks(photo)?;
    region_of_lines(photo, k, bw, bh, &lined)
}

/// Which blocks of the small copy repeat with the paper's period: (scale of the copy, blocks across, down, lined).
fn lined_blocks(photo: &Photo) -> Option<(usize, usize, usize, Vec<bool>)> {
    let k = (photo.w.max(photo.h) as f64 / SEARCH_SIDE as f64).ceil().max(1.0) as usize;
    let (w, h) = (photo.w / k, photo.h / k);
    if w < 4 * BLOCK || h < 4 * BLOCK {
        return None;
    }
    let mut l = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut s = 0.0;
            for yy in y * k..(y + 1) * k {
                for xx in x * k..(x + 1) * k {
                    s += photo.luma.at(xx, yy);
                }
            }
            l[y * w + x] = (s / (k * k) as f32).powf(1.0 / 2.2);
        }
    }
    // Lines stand out from a 7-px box average.
    let r = 3usize;
    let mut hp = vec![0f32; w * h];
    for y in r..h - r {
        for x in r..w - r {
            let mut s = 0.0;
            for yy in y - r..=y + r {
                for xx in x - r..=x + r {
                    s += l[yy * w + xx];
                }
            }
            hp[y * w + x] = l[y * w + x] - s / ((2 * r + 1) * (2 * r + 1)) as f32;
        }
    }
    // Each block's brightness across and down: how it correlates with itself
    // at shifts of 3..14 px, and how much it swings.
    let analyse = |p: &[f64]| -> ([f64; 15], f64) {
        let n = p.len();
        let mean = p.iter().sum::<f64>() / n as f64;
        let c: Vec<f64> = p.iter().map(|v| v - mean).collect();
        let var: f64 = c.iter().map(|v| v * v).sum();
        let mut ac = [0.0; 15];
        if var > 1e-12 {
            for (lag, a) in ac.iter_mut().enumerate().skip(3) {
                *a = (0..n - lag).map(|i| c[i] * c[i + lag]).sum::<f64>() / var;
            }
        }
        (ac, (var / n as f64).sqrt())
    };
    let (bw, bh) = (w / BLOCK, h / BLOCK);
    let mut blocks = Vec::with_capacity(bw * bh);
    for by in 0..bh {
        for bx in 0..bw {
            let (x0, y0) = (bx * BLOCK, by * BLOCK);
            let rows: Vec<f64> = (0..BLOCK).map(|j| (0..BLOCK).map(|i| hp[(y0 + j) * w + x0 + i] as f64).sum::<f64>() / BLOCK as f64).collect();
            let cols: Vec<f64> = (0..BLOCK).map(|i| (0..BLOCK).map(|j| hp[(y0 + j) * w + x0 + i] as f64).sum::<f64>() / BLOCK as f64).collect();
            blocks.push([analyse(&rows), analyse(&cols)]);
        }
    }
    // Printed lines swing clearly above the camera's grain.
    const SWING: f64 = 0.003;
    // The paper's period: the most common best shift among clearly periodic blocks.
    let mut votes = [0usize; 15];
    for b in &blocks {
        for (ac, swing) in b {
            let best = (3..15).max_by(|&i, &j| ac[i].partial_cmp(&ac[j]).unwrap()).unwrap();
            if *swing >= SWING && ac[best] >= 0.5 {
                votes[best] += 1;
            }
        }
    }
    let (period, &count) = votes.iter().enumerate().max_by_key(|(_, &c)| c)?;
    if count < 6 {
        return None;
    }
    // Lined: repeating with that period, as the paper's lines do everywhere on it.
    let lined: Vec<bool> = blocks
        .iter()
        .map(|b| b.iter().any(|(ac, swing)| *swing >= SWING && (period.saturating_sub(1).max(3)..=(period + 1).min(14)).any(|l| ac[l] >= 0.35)))
        .collect();
    Some((k, bw, bh, lined))
}

/// The largest lined region as the sheet (or the whole frame for a scan).
fn region_of_lines(photo: &Photo, k: usize, bw: usize, bh: usize, lined: &[bool]) -> Option<ByLines> {
    // Close small gaps on a grid with an empty border around it, so a region
    // does not creep onto the border of the frame.
    let (pw, ph) = (bw + 2, bh + 2);
    let mut padded = vec![false; pw * ph];
    for by in 0..bh {
        for bx in 0..bw {
            padded[(by + 1) * pw + bx + 1] = lined[by * bw + bx];
        }
    }
    let shut = morph(&morph(&padded, pw, ph, 1, true), pw, ph, 1, false);
    let closed: Vec<bool> = (0..bw * bh).map(|i| shut[(i / bw + 1) * pw + i % bw + 1]).collect();
    let (labels, sizes) = components(&closed, bw, bh);
    let (best, &size) = sizes.iter().enumerate().max_by_key(|(_, s)| **s)?;
    if (size as f64) < 0.08 * (bw * bh) as f64 {
        return None;
    }
    let label = best as u32 + 1;
    let at = |bx: usize, by: usize| labels[by * bw + bx] == label;
    // Lines along at least 70 % of every border of the frame: the sheet is the frame.
    let border = |n: usize, f: &dyn Fn(usize) -> bool| (0..n).filter(|&i| f(i)).count() as f64 >= 0.7 * n as f64;
    let scan = border(bw, &|i| at(i, 0)) && border(bw, &|i| at(i, bh - 1)) && border(bh, &|j| at(0, j)) && border(bh, &|j| at(bw - 1, j));
    if scan {
        let (fw, fh) = (photo.w as f64, photo.h as f64);
        return Some(ByLines { found: Found { corners: [[0.0, 0.0], [fw, 0.0], [fw, fh], [0.0, fh]], confidence: 1.0 }, scan: true, slack: 0.0 });
    }
    let mut pts: Vec<Pt> = Vec::new();
    for by in 0..bh {
        for bx in 0..bw {
            if at(bx, by) {
                pts.push([((2 * bx + 1) * BLOCK / 2) as f64, ((2 * by + 1) * BLOCK / 2) as f64]);
            }
        }
    }
    let hull = convex_hull(pts);
    let quad = sides_by_extremes(&at, bw, bh).or_else(|| sides_of(&hull)).or_else(|| {
        let mut h = hull.clone();
        simplify(&mut h, 32);
        largest_quad(&h)
    })?;
    let fill = ((size * BLOCK * BLOCK) as f64 / area(&quad)).min(1.0);
    let corners = order_corners(quad.map(|p| [p[0] * k as f64, p[1] * k as f64]));
    if !convex_clockwise(&corners) {
        return None;
    }
    Some(ByLines { found: Found { corners, confidence: fill }, scan: false, slack: (BLOCK * k) as f64 })
}

/// Four sides through the outermost blocks of the region: the last block of
/// every row on the left and on the right, of every column at the top and at
/// the bottom, a robust line through each set (in blocks: a row cut short by
/// a marker or a hole is an outlier), the corners where the lines meet. Only
/// the middle rows and columns count: the region's corners come out rounded.
fn sides_by_extremes(at: &dyn Fn(usize, usize) -> bool, bw: usize, bh: usize) -> Option<[Pt; 4]> {
    let rows: Vec<(usize, usize, usize)> = (0..bh)
        .filter_map(|by| {
            let row: Vec<usize> = (0..bw).filter(|&bx| at(bx, by)).collect();
            Some((by, *row.first()?, *row.last()?))
        })
        .collect();
    let cols: Vec<(usize, usize, usize)> = (0..bw)
        .filter_map(|bx| {
            let col: Vec<usize> = (0..bh).filter(|&by| at(bx, by)).collect();
            Some((bx, *col.first()?, *col.last()?))
        })
        .collect();
    let middle = |list: &[(usize, usize, usize)]| -> Vec<(usize, usize, usize)> {
        let (Some(first), Some(last)) = (list.first(), list.last()) else { return Vec::new() };
        let cut = 0.2 * (last.0 - first.0) as f64;
        list.iter().filter(|e| e.0 as f64 >= first.0 as f64 + cut && e.0 as f64 <= last.0 as f64 - cut).copied().collect()
    };
    let (rows, cols) = (middle(&rows), middle(&cols));
    let sets: [Vec<Pt>; 4] = [
        cols.iter().map(|&(x, t, _)| [x as f64, t as f64]).collect(),
        rows.iter().map(|&(y, _, r)| [r as f64, y as f64]).collect(),
        cols.iter().map(|&(x, _, b)| [x as f64, b as f64]).collect(),
        rows.iter().map(|&(y, l, _)| [l as f64, y as f64]).collect(),
    ];
    let mut lines = Vec::new();
    for (g, set) in sets.iter().enumerate() {
        let (line, inliers, _) = crate::edges::fit_line(set, 0xb10c + g as u64)?;
        // A side is a run of blocks along most of the region, not a corner.
        if inliers < 4 || 2 * inliers < set.len() {
            return None;
        }
        // Sides run within 30° of the frame's axes: rows on the left and right, columns on top.
        let along = if g % 2 == 1 { line.d[1].abs() } else { line.d[0].abs() };
        if along < 30f64.to_radians().cos() {
            return None;
        }
        lines.push(line);
    }
    let mut q = [[0.0; 2]; 4];
    for (k, (a, b)) in [(0, 3), (0, 1), (2, 1), (2, 3)].into_iter().enumerate() {
        let p = lines[a].intersect(&lines[b])?;
        // Block centres, in pixels of the small copy.
        q[k] = [(p[0] + 0.5) * BLOCK as f64, (p[1] + 0.5) * BLOCK as f64];
    }
    Some(q)
}

/// Four sides through a blocky outline: its edges grouped by the way they
/// face (up, right, down, left), a line fitted to each group by length, the
/// corners where neighbouring lines meet. Unlike the largest inscribed
/// quadrilateral, the sides keep the outline's direction where its corners are cut.
fn sides_of(hull: &[Pt]) -> Option<[Pt; 4]> {
    let n = hull.len();
    if n < 4 {
        return None;
    }
    let c = [hull.iter().map(|p| p[0]).sum::<f64>() / n as f64, hull.iter().map(|p| p[1]).sum::<f64>() / n as f64];
    // Per side: weighted sums for a total least squares line.
    let mut groups = [(0.0, [0.0; 2], [0.0; 3]); 4];
    let mut points: [Vec<(Pt, f64)>; 4] = Default::default();
    let mut edges: [Vec<(Pt, Pt, f64, f64)>; 4] = Default::default();
    for i in 0..n {
        let (a, b) = (hull[i], hull[(i + 1) % n]);
        let len = (b[0] - a[0]).hypot(b[1] - a[1]);
        if len < 1e-9 {
            continue;
        }
        let mid = [(a[0] + b[0]) / 2.0 - c[0], (a[1] + b[1]) / 2.0 - c[1]];
        // The edge's normal, turned to face away from the centre.
        let mut nrm = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
        if nrm[0] * mid[0] + nrm[1] * mid[1] < 0.0 {
            nrm = [-nrm[0], -nrm[1]];
        }
        // y down: up is −y. Groups: 0 up, 1 right, 2 down, 3 left.
        let g = if nrm[1].abs() >= nrm[0].abs() {
            if nrm[1] < 0.0 { 0 } else { 2 }
        } else if nrm[0] > 0.0 {
            1
        } else {
            3
        };
        edges[g].push((a, b, len, nrm[1].atan2(nrm[0])));
    }
    // Only the edges facing (within 20°) the way most of the side faces: the
    // cut corners of a blocky outline lean and would tilt the side.
    for (g, list) in edges.iter().enumerate() {
        let total: f64 = list.iter().map(|e| e.2).sum();
        let mut by: Vec<&(Pt, Pt, f64, f64)> = list.iter().collect();
        by.sort_by(|x, y| x.3.partial_cmp(&y.3).unwrap());
        let (mut acc, mut main) = (0.0, 0.0);
        for e in &by {
            acc += e.2;
            if acc >= total / 2.0 {
                main = e.3;
                break;
            }
        }
        for &(a, b, len, angle) in list {
            let gap = (angle - main + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU) - std::f64::consts::PI;
            if gap.abs() <= 20f64.to_radians() {
                points[g].push((a, len / 2.0));
                points[g].push((b, len / 2.0));
            }
        }
    }
    let mut lines = Vec::new();
    for (g, pts) in points.iter().enumerate() {
        let sw: f64 = pts.iter().map(|p| p.1).sum();
        if pts.len() < 2 || sw < 1e-9 {
            return None;
        }
        let cx = pts.iter().map(|p| p.0[0] * p.1).sum::<f64>() / sw;
        let cy = pts.iter().map(|p| p.0[1] * p.1).sum::<f64>() / sw;
        let (mut sxx, mut sxy, mut syy) = (0.0, 0.0, 0.0);
        for &(p, w) in pts {
            let (dx, dy) = (p[0] - cx, p[1] - cy);
            sxx += w * dx * dx;
            sxy += w * dx * dy;
            syy += w * dy * dy;
        }
        let theta = 0.5 * (2.0 * sxy).atan2(sxx - syy);
        groups[g].0 = sw;
        lines.push(crate::quad::Line { p: [cx, cy], d: [theta.cos(), theta.sin()] });
    }
    let mut q = [[0.0; 2]; 4];
    // Corners: top-left = up ∩ left, top-right = up ∩ right, …
    for (k, (a, b)) in [(0, 3), (0, 1), (2, 1), (2, 3)].into_iter().enumerate() {
        q[k] = lines[a].intersect(&lines[b])?;
    }
    Some(q)
}
