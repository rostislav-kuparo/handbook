//! The real pen's ink, taken from a few words written on the sheet with it:
//! how much light it lets through in each channel, and how wide it writes.

use serde::Serialize;

use crate::edges::erf;
use crate::img::Photo;

#[derive(Serialize, Debug)]
pub struct Calib {
    /// Transmittance per channel (linear light, 1: no ink).
    pub t: [f64; 3],
    /// Width of the strokes, photo px.
    pub width: f64,
    /// Ink pixels the estimate rests on.
    pub pixels: usize,
}

fn percentile(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() - 1) as f64 * p).round() as usize]
}

/// Ink around (x, y) within `radius` px. `sigma`: the photo's blur, to undo
/// the paling of thin strokes it causes.
pub fn calibrate(photo: &Photo, x: f64, y: f64, radius: f64, sigma: f64) -> Option<Calib> {
    let r = radius.max(6.0) as isize;
    let (cx, cy) = (x as isize, y as isize);
    let (x0, x1) = ((cx - r).max(0) as usize, ((cx + r) as usize).min(photo.w - 1));
    let (y0, y1) = ((cy - r).max(0) as usize, ((cy + r) as usize).min(photo.h - 1));
    let (w, h) = (x1 - x0 + 1, y1 - y0 + 1);
    let luma: Vec<f64> = (0..w * h).map(|i| photo.luma.at(x0 + i % w, y0 + i / w) as f64).collect();
    let paper_l = percentile(&mut luma.clone(), 0.9);
    let paper: [f64; 3] = std::array::from_fn(|c| {
        let mut v: Vec<f64> = (0..w * h).map(|i| photo.lin(x0 + i % w, y0 + i / w, c) as f64).collect();
        percentile(&mut v, 0.9)
    });
    let ink: Vec<bool> = luma.iter().map(|&l| l < 0.8 * paper_l).collect();
    let count = ink.iter().filter(|&&b| b).count();
    if count < 12 || count as f64 > 0.7 * (w * h) as f64 {
        return None;
    }
    // The darkest quarter of the ink: the cores of the strokes.
    let mut idx: Vec<usize> = (0..w * h).filter(|&i| ink[i]).collect();
    idx.sort_by(|&a, &b| luma[a].partial_cmp(&luma[b]).unwrap());
    let core = &idx[..(idx.len() / 4).max(3)];
    let mut t: [f64; 3] = std::array::from_fn(|c| {
        let mut v: Vec<f64> = core.iter().map(|&i| photo.lin(x0 + i % w, y0 + i / w, c) as f64 / paper[c].max(1e-4)).collect();
        percentile(&mut v, 0.5).clamp(0.0, 1.0)
    });

    // Stroke width: twice the distance from the ridge of the ink to the paper (chamfer 3-4).
    let mut d = vec![0u32; w * h];
    let big = u32::MAX / 4;
    for i in 0..w * h {
        d[i] = if ink[i] { big } else { 0 };
    }
    for yy in 0..h {
        for xx in 0..w {
            let i = yy * w + xx;
            if d[i] == 0 {
                continue;
            }
            let mut m = d[i];
            if xx > 0 {
                m = m.min(d[i - 1] + 3);
            }
            if yy > 0 {
                m = m.min(d[i - w] + 3);
                if xx > 0 {
                    m = m.min(d[i - w - 1] + 4);
                }
                if xx + 1 < w {
                    m = m.min(d[i - w + 1] + 4);
                }
            }
            d[i] = m;
        }
    }
    for yy in (0..h).rev() {
        for xx in (0..w).rev() {
            let i = yy * w + xx;
            let mut m = d[i];
            if xx + 1 < w {
                m = m.min(d[i + 1] + 3);
            }
            if yy + 1 < h {
                m = m.min(d[i + w] + 3);
                if xx + 1 < w {
                    m = m.min(d[i + w + 1] + 4);
                }
                if xx > 0 {
                    m = m.min(d[i + w - 1] + 4);
                }
            }
            d[i] = m;
        }
    }
    let mut ridge: Vec<f64> = Vec::new();
    for yy in 1..h - 1 {
        for xx in 1..w - 1 {
            let i = yy * w + xx;
            if d[i] >= 3 && [i - 1, i + 1, i - w, i + w].iter().all(|&j| d[j] <= d[i]) {
                ridge.push(d[i] as f64 / 3.0);
            }
        }
    }
    let width = if ridge.is_empty() { 1.0 } else { (2.0 * percentile(&mut ridge, 0.5) - 1.0).max(1.0) };
    // A stroke narrower than the blur loses darkness at its core: put it back.
    if sigma > 0.05 {
        let f = erf(width / (2.0 * std::f64::consts::SQRT_2 * sigma)).max(0.2);
        for v in t.iter_mut() {
            *v = (1.0 - (1.0 - *v) / f).clamp(0.02, 1.0);
        }
    }
    Some(Calib { t, width, pixels: count })
}
