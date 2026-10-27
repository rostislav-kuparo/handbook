//! The camera's noise, measured on the blank paper: how strong it is at each
//! brightness, how much the colours share it, how far it is smeared.

use serde::Serialize;

use crate::img::Photo;
use crate::quad::{apply, invert, square_to_quad, Pt};
use crate::rng::Rng;

#[derive(Serialize, Debug, Clone)]
pub struct Noise {
    /// Per channel, in linear light: variance = a·L + b.
    pub a: [f64; 3],
    pub b: [f64; 3],
    /// How much the channels share the noise (1: grey grain, 0: independent colour speckles).
    pub rho: f64,
    /// Width of the Gaussian that smears white noise into the photo's grain, px.
    pub smooth: f64,
    /// Paper tiles the estimate rests on.
    pub tiles: usize,
}

const TILE: usize = 16;

/// Per-pixel residual against the 3×3 mean, over a tile's interior; `v` is TILE×TILE.
fn residual(v: &[f64]) -> Vec<f64> {
    let mut r = Vec::with_capacity((TILE - 2) * (TILE - 2));
    for y in 1..TILE - 1 {
        for x in 1..TILE - 1 {
            let mut m = 0.0;
            for dy in 0..3 {
                for dx in 0..3 {
                    m += v[(y + dy - 1) * TILE + x + dx - 1];
                }
            }
            r.push(v[y * TILE + x] - m / 9.0);
        }
    }
    r
}

/// Variance of the residual over that of the noise, and the residual's
/// horizontal neighbour correlation, for white noise smeared by a Gaussian of `s` px.
fn smear_stats(s: f64) -> (f64, f64) {
    let n = 160;
    let mut rng = Rng::new(0x5ee0 + (s * 1000.0) as u64);
    let white: Vec<f64> = (0..n * n).map(|_| rng.gauss()).collect();
    let r = (3.0 * s).ceil().max(1.0) as isize;
    let k: Vec<f64> = (-r..=r).map(|i| if s < 0.05 { (i == 0) as u8 as f64 } else { (-0.5 * (i as f64 / s).powi(2)).exp() }).collect();
    let ks: f64 = k.iter().sum();
    let conv = |src: &[f64], horizontal: bool| -> Vec<f64> {
        let mut out = vec![0.0; n * n];
        for y in 0..n {
            for x in 0..n {
                let mut acc = 0.0;
                for j in -r..=r {
                    let (xx, yy) = if horizontal { ((x as isize + j).rem_euclid(n as isize) as usize, y) } else { (x, (y as isize + j).rem_euclid(n as isize) as usize) };
                    acc += src[yy * n + xx] * k[(j + r) as usize];
                }
                out[y * n + x] = acc / ks;
            }
        }
        out
    };
    let noise = conv(&conv(&white, true), false);
    let var_n = noise.iter().map(|v| v * v).sum::<f64>() / (n * n) as f64;
    let (mut vr, mut cr, mut cnt, mut pairs) = (0.0, 0.0, 0.0, 0.0);
    for ty in 0..n / TILE {
        for tx in 0..n / TILE {
            let tile: Vec<f64> = (0..TILE * TILE).map(|i| noise[(ty * TILE + i / TILE) * n + tx * TILE + i % TILE]).collect();
            let res = residual(&tile);
            let w = TILE - 2;
            for y in 0..w {
                for x in 0..w {
                    vr += res[y * w + x].powi(2);
                    if x + 1 < w {
                        cr += res[y * w + x] * res[y * w + x + 1];
                        pairs += 1.0;
                    }
                }
            }
            cnt += (w * w) as f64;
        }
    }
    let vr = vr / cnt;
    (vr / var_n, cr / pairs / vr)
}

pub fn measure_noise(photo: &Photo, corners: &[Pt; 4]) -> Option<Noise> {
    let to_sheet = invert(&square_to_quad(corners));
    let inset = 0.06;
    let inside = |x: f64, y: f64| {
        let [u, v] = apply(&to_sheet, [x, y]);
        (inset..=1.0 - inset).contains(&u) && (inset..=1.0 - inset).contains(&v)
    };
    let xs = corners.iter().map(|p| p[0]);
    let ys = corners.iter().map(|p| p[1]);
    let x0 = xs.clone().fold(f64::INFINITY, f64::min).max(0.0) as usize;
    let x1 = (xs.fold(f64::NEG_INFINITY, f64::max) as usize).min(photo.w);
    let y0 = ys.clone().fold(f64::INFINITY, f64::min).max(0.0) as usize;
    let y1 = (ys.fold(f64::NEG_INFINITY, f64::max) as usize).min(photo.h);

    // Per tile: mean and residual variance per channel, channel correlation, neighbour correlation.
    struct Tile {
        mean: [f64; 3],
        var: [f64; 3],
        rho: f64,
        lag: f64,
    }
    let mut tiles = Vec::new();
    let mut ty = y0;
    while ty + TILE <= y1 {
        let mut tx = x0;
        while tx + TILE <= x1 {
            let (fx, fy) = (tx as f64, ty as f64);
            let t = TILE as f64;
            if [(fx, fy), (fx + t, fy), (fx, fy + t), (fx + t, fy + t)].iter().all(|&(x, y)| inside(x, y)) {
                let mut mean = [0.0; 3];
                let mut var = [0.0; 3];
                let mut res: Vec<Vec<f64>> = Vec::new();
                for c in 0..3 {
                    let v: Vec<f64> = (0..TILE * TILE).map(|i| photo.lin(tx + i % TILE, ty + i / TILE, c) as f64).collect();
                    mean[c] = v.iter().sum::<f64>() / v.len() as f64;
                    let r = residual(&v);
                    var[c] = r.iter().map(|x| x * x).sum::<f64>() / r.len() as f64;
                    res.push(r);
                }
                let corr = |a: &[f64], b: &[f64]| {
                    let (ab, aa, bb) = a.iter().zip(b).fold((0.0, 0.0, 0.0), |s, (x, y)| (s.0 + x * y, s.1 + x * x, s.2 + y * y));
                    ab / (aa * bb).sqrt().max(1e-30)
                };
                let rho = (corr(&res[0], &res[1]) + corr(&res[1], &res[2]) + corr(&res[0], &res[2])) / 3.0;
                let w = TILE - 2;
                let g = &res[1];
                let (mut num, mut den) = (0.0, 0.0);
                for y in 0..w {
                    for x in 0..w {
                        den += g[y * w + x].powi(2);
                        if x + 1 < w {
                            num += g[y * w + x] * g[y * w + x + 1];
                        }
                    }
                }
                tiles.push(Tile { mean, var, rho, lag: num / den.max(1e-30) * (w * w) as f64 / ((w - 1) * w) as f64 });
            }
            tx += TILE;
        }
        ty += TILE;
    }
    if tiles.len() < 12 {
        return None;
    }

    // The cleaner half of the paper (least ruling, fibres, dirt) describes the noise itself.
    let mut by_var: Vec<usize> = (0..tiles.len()).collect();
    by_var.sort_by(|&i, &j| tiles[i].var[1].partial_cmp(&tiles[j].var[1]).unwrap());
    let clean = &by_var[..by_var.len() / 2];
    let median = |mut v: Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    let rho = median(clean.iter().map(|&i| tiles[i].rho).collect()).clamp(0.0, 1.0);
    let lag = median(clean.iter().map(|&i| tiles[i].lag).collect());
    // Smear whose statistics match the measured neighbour correlation.
    let (mut smooth, mut q, mut gap) = (0.0, 8.0 / 9.0, f64::INFINITY);
    for i in 0..=24 {
        let s = i as f64 * 0.075;
        let (qs, ls) = smear_stats(s);
        if (ls - lag).abs() < gap {
            (smooth, q, gap) = (s, qs, (ls - lag).abs());
        }
    }

    let mut a = [0.0; 3];
    let mut b = [0.0; 3];
    for c in 0..3 {
        // Per brightness bin, a low percentile of the variance (texture only adds to it).
        let lo = tiles.iter().map(|t| t.mean[c]).fold(f64::INFINITY, f64::min);
        let hi = tiles.iter().map(|t| t.mean[c]).fold(f64::NEG_INFINITY, f64::max);
        let bins = 8;
        let mut pts: Vec<(f64, f64, f64)> = Vec::new();
        for k in 0..bins {
            let (bl, bh) = (lo + (hi - lo) * k as f64 / bins as f64, lo + (hi - lo) * (k + 1) as f64 / bins as f64);
            let mut sel: Vec<&Tile> = tiles.iter().filter(|t| t.mean[c] >= bl && (t.mean[c] < bh || k == bins - 1)).collect();
            if sel.len() < 5 {
                continue;
            }
            sel.sort_by(|x, y| x.var[c].partial_cmp(&y.var[c]).unwrap());
            let at = sel.len() * 3 / 10;
            let l = sel.iter().map(|t| t.mean[c]).sum::<f64>() / sel.len() as f64;
            pts.push((l, sel[at].var[c] / q, sel.len() as f64));
        }
        let spread = hi / lo.max(1e-6);
        if pts.len() >= 3 && spread > 1.35 {
            // Weighted least squares for var = a·L + b, both non-negative.
            let (mut sw, mut sx, mut sy, mut sxx, mut sxy) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for &(x, y, w) in &pts {
                sw += w;
                sx += w * x;
                sy += w * y;
                sxx += w * x * x;
                sxy += w * x * y;
            }
            let den = sw * sxx - sx * sx;
            let (mut aa, mut bb) = if den.abs() > 1e-20 { ((sw * sxy - sx * sy) / den, (sy * sxx - sx * sxy) / den) } else { (0.0, sy / sw) };
            if aa < 0.0 {
                aa = 0.0;
                bb = sy / sw;
            }
            if bb < 0.0 {
                bb = 0.0;
                aa = sxy / sxx;
            }
            a[c] = aa;
            b[c] = bb;
        } else {
            // Lighting too even to tell the parts apart: shot noise, var ∝ L.
            let all: Vec<f64> = pts.iter().map(|&(l, v, _)| v / l.max(1e-6)).collect();
            a[c] = if all.is_empty() { 0.0 } else { median(all) };
        }
    }
    Some(Noise { a, b, rho, smooth, tiles: tiles.len() })
}
