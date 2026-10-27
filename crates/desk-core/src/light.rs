//! Glare on the sheet: where the lamp's reflection burns the paper out, real
//! ink fades too, because the reflected light never went through it.

use crate::img::Photo;
use crate::quad::{apply, invert, square_to_quad, Pt};

/// Quadratic surface c0 + c1·u + c2·v + c3·u² + c4·u·v + c5·v².
fn terms(u: f64, v: f64) -> [f64; 6] {
    [1.0, u, v, u * u, u * v, v * v]
}

pub fn eval(c: &[f64; 6], u: f64, v: f64) -> f64 {
    terms(u, v).iter().zip(c).map(|(t, k)| t * k).sum()
}

/// Weighted least squares for the surface through (u, v, value, weight).
fn fit(points: &[(f64, f64, f64, f64)]) -> Option<[f64; 6]> {
    let mut a = [[0.0; 7]; 6];
    for &(u, v, y, w) in points {
        let t = terms(u, v);
        for i in 0..6 {
            for j in 0..6 {
                a[i][j] += w * t[i] * t[j];
            }
            a[i][6] += w * t[i] * y;
        }
    }
    for col in 0..6 {
        let piv = (col..6).max_by(|&i, &j| a[i][col].abs().partial_cmp(&a[j][col].abs()).unwrap())?;
        if a[piv][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, piv);
        for r in 0..6 {
            if r != col {
                let k = a[r][col] / a[col][col];
                for c in col..7 {
                    a[r][c] -= k * a[col][c];
                }
            }
        }
    }
    Some(std::array::from_fn(|i| a[i][6] / a[i][i]))
}

/// A map of the glare, RGBA bytes: linear light reflected off the paper
/// surface (the part ink does not darken), `scale` times smaller than the photo.
pub struct Specular {
    pub w: usize,
    pub h: usize,
    pub rgba: Vec<u8>,
}

const BURNT: u8 = 250;

/// The paper's lighting per channel (linear light) as smooth surfaces over
/// the sheet (u, v in 0..1), through the bright paper of each cell — burnt-out
/// cells left out — and whether any part of the sheet burns out.
pub fn paper_surface(photo: &Photo, corners: &[Pt; 4]) -> (Option<[[f64; 6]; 3]>, bool) {
    let to_photo = square_to_quad(corners);
    let pixel = |u: f64, v: f64| {
        let [x, y] = apply(&to_photo, [u, v]);
        ((x.max(0.0) as usize).min(photo.w - 1), (y.max(0.0) as usize).min(photo.h - 1))
    };
    let burnt = |x: usize, y: usize| (0..3).any(|c| photo.byte(x, y, c) >= BURNT);
    let n = 24;
    let mut cells: Vec<[(f64, f64, f64, f64); 3]> = Vec::new();
    let mut any_burnt = false;
    for cy in 0..n {
        for cx in 0..n {
            let mut vals: [Vec<f64>; 3] = Default::default();
            let mut hot = false;
            for sy in 0..7 {
                for sx in 0..7 {
                    let u = 0.03 + 0.94 * (cx as f64 + (sx as f64 + 0.5) / 7.0) / n as f64;
                    let v = 0.03 + 0.94 * (cy as f64 + (sy as f64 + 0.5) / 7.0) / n as f64;
                    let (x, y) = pixel(u, v);
                    hot |= burnt(x, y);
                    for (c, list) in vals.iter_mut().enumerate() {
                        list.push(photo.lin(x, y, c) as f64);
                    }
                }
            }
            any_burnt |= hot;
            if hot {
                continue;
            }
            let (u, v) = (0.03 + 0.94 * (cx as f64 + 0.5) / n as f64, 0.03 + 0.94 * (cy as f64 + 0.5) / n as f64);
            cells.push(std::array::from_fn(|c| {
                let mut l = vals[c].clone();
                l.sort_by(|a, b| a.partial_cmp(b).unwrap());
                (u, v, l[l.len() * 3 / 4], 1.0)
            }));
        }
    }
    if cells.len() < 12 {
        return (None, any_burnt);
    }
    let mut surf = [[0.0; 6]; 3];
    for c in 0..3 {
        let mut pts: Vec<(f64, f64, f64, f64)> = cells.iter().map(|cell| cell[c]).collect();
        let Some(mut coef) = fit(&pts) else { return (None, any_burnt) };
        // A few rounds of Tukey reweighting: shadows, dirt and things on the sheet are not the lighting.
        for _ in 0..3 {
            let mut res: Vec<f64> = pts.iter().map(|&(u, v, y, _)| (y - eval(&coef, u, v)).abs()).collect();
            let mut sorted = res.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let k = (4.685 * 1.4826 * sorted[sorted.len() / 2]).max(1e-4);
            for (p, r) in pts.iter_mut().zip(res.iter_mut()) {
                p.3 = if *r < k { (1.0 - (*r / k).powi(2)).powi(2) } else { 0.0 };
            }
            coef = fit(&pts).unwrap_or(coef);
        }
        surf[c] = coef;
    }
    (Some(surf), any_burnt)
}

pub fn specular_map(photo: &Photo, corners: &[Pt; 4], scale: usize) -> Option<Specular> {
    let to_sheet = invert(&square_to_quad(corners));
    let (surf, any_burnt) = paper_surface(photo, corners);
    if !any_burnt {
        return None;
    }
    let surf = surf?;

    // Glare = what rises above that surface where the paper is (nearly) burnt out, feathered.
    let (w, h) = (photo.w.div_ceil(scale), photo.h.div_ceil(scale));
    let mut s = vec![[0f32; 3]; w * h];
    let mut found = false;
    for my in 0..h {
        for mx in 0..w {
            let (bx, by) = (mx * scale, my * scale);
            let [u, v] = apply(&to_sheet, [(bx as f64 + scale as f64 / 2.0), (by as f64 + scale as f64 / 2.0)]);
            if !(0.0..=1.0).contains(&u) || !(0.0..=1.0).contains(&v) {
                continue;
            }
            let (mut top, mut sum, mut cnt) = (0u8, [0f64; 3], 0.0);
            for y in by..(by + scale).min(photo.h) {
                for x in bx..(bx + scale).min(photo.w) {
                    for (c, acc) in sum.iter_mut().enumerate() {
                        top = top.max(photo.byte(x, y, c));
                        *acc += photo.lin(x, y, c) as f64;
                    }
                    cnt += 1.0;
                }
            }
            let t = ((top as f64 / 255.0 - 0.86) / (0.97 - 0.86)).clamp(0.0, 1.0);
            let gate = t * t * (3.0 - 2.0 * t);
            if gate <= 0.0 {
                continue;
            }
            for c in 0..3 {
                let v = (gate * (sum[c] / cnt - eval(&surf[c], u, v)).max(0.0)) as f32;
                s[my * w + mx][c] = v;
                found |= v > 0.004;
            }
        }
    }
    if !found {
        return None;
    }
    // Soften the border of the glare: dilate by 2, then blur.
    let grow = |src: &Vec<[f32; 3]>| -> Vec<[f32; 3]> {
        let mut out = src.clone();
        for y in 0..h {
            for x in 0..w {
                for dy in -2i32..=2 {
                    for dx in -2i32..=2 {
                        let (xx, yy) = (x as i32 + dx, y as i32 + dy);
                        if xx < 0 || yy < 0 || xx >= w as i32 || yy >= h as i32 {
                            continue;
                        }
                        let o = src[yy as usize * w + xx as usize];
                        let d = &mut out[y * w + x];
                        for c in 0..3 {
                            d[c] = d[c].max(o[c]);
                        }
                    }
                }
            }
        }
        out
    };
    let s = grow(&s);
    let k = [0.11f32, 0.24, 0.30, 0.24, 0.11];
    let blur = |src: &Vec<[f32; 3]>, horizontal: bool| -> Vec<[f32; 3]> {
        let mut out = vec![[0f32; 3]; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut acc = [0f32; 3];
                for (j, kv) in k.iter().enumerate() {
                    let o = j as i32 - 2;
                    let (xx, yy) = if horizontal { ((x as i32 + o).clamp(0, w as i32 - 1) as usize, y) } else { (x, (y as i32 + o).clamp(0, h as i32 - 1) as usize) };
                    let v = src[yy * w + xx];
                    for c in 0..3 {
                        acc[c] += v[c] * kv;
                    }
                }
                out[y * w + x] = acc;
            }
        }
        out
    };
    let s = blur(&blur(&s, true), false);
    let mut rgba = vec![0u8; w * h * 4];
    for (i, v) in s.iter().enumerate() {
        for c in 0..3 {
            rgba[i * 4 + c] = (v[c].clamp(0.0, 1.0) * 255.0).round() as u8;
        }
        rgba[i * 4 + 3] = 255;
    }
    Some(Specular { w, h, rgba })
}
