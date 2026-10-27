//! Things lying on the sheet — a pen, fingers, a phone: whatever does not look
//! like the paper. Text must not be written over them.

use serde::Serialize;

use crate::img::Photo;
use crate::light::{eval, paper_surface};
use crate::quad::{apply, area, invert, square_to_quad, Pt};
use crate::sheet::{components, morph};

/// 255 where the sheet is free paper, 0 under objects (soft at their edges);
/// `scale` times smaller than the photo.
#[derive(Serialize, Debug)]
pub struct ObjectMask {
    pub w: usize,
    pub h: usize,
    #[serde(skip)]
    pub data: Vec<u8>,
    pub objects: usize,
}

/// A pixel differs from the paper's colour by this much (relative), or is this dark against the paper's light.
const CHROMA: f64 = 0.12;
const DARK: f64 = 0.3;

pub fn object_mask(photo: &Photo, corners: &[Pt; 4], w_mm: f64, h_mm: f64, scale: usize) -> ObjectMask {
    let (w, h) = (photo.w.div_ceil(scale), photo.h.div_ceil(scale));
    let mut data = vec![255u8; w * h];
    let Some(surf) = paper_surface(photo, corners).0 else {
        return ObjectMask { w, h, data, objects: 0 };
    };
    let to_sheet = invert(&square_to_quad(corners));

    // Candidates: not the paper's colour, or far darker than its light here.
    let mut cand = vec![false; w * h];
    for my in 0..h {
        for mx in 0..w {
            let (bx, by) = (mx * scale, my * scale);
            let [u, v] = apply(&to_sheet, [bx as f64 + scale as f64 / 2.0, by as f64 + scale as f64 / 2.0]);
            if !(0.0..=1.0).contains(&u) || !(0.0..=1.0).contains(&v) {
                continue;
            }
            let mut ratio = [0.0; 3];
            let mut n = 0.0;
            for y in by..(by + scale).min(photo.h) {
                for x in bx..(bx + scale).min(photo.w) {
                    for (c, r) in ratio.iter_mut().enumerate() {
                        *r += photo.lin(x, y, c) as f64;
                    }
                    n += 1.0;
                }
            }
            for (c, r) in ratio.iter_mut().enumerate() {
                *r /= n * eval(&surf[c], u, v).max(1e-4);
            }
            let mean = (ratio[0] + ratio[1] + ratio[2]) / 3.0;
            let chroma = ratio.iter().map(|r| (r / mean.max(1e-4) - 1.0).abs()).fold(0.0, f64::max);
            cand[my * w + mx] = mean < DARK || (mean > 0.05 && chroma > CHROMA);
        }
    }

    // Thin things — the ruling, handwriting, dust — are not objects: open by
    // ~0.8 mm, close the holes, keep the large regions.
    let per_mm = (area(corners) / (scale * scale) as f64 / (w_mm * h_mm)).sqrt();
    let r = (0.8 * per_mm).round().max(1.0) as usize;
    let mut m = morph(&morph(&cand, w, h, r, false), w, h, r, true);
    m = morph(&morph(&m, w, h, r, true), w, h, r, false);
    let (labels, sizes) = components(&m, w, h);
    let sheet = area(corners) / (scale * scale) as f64;
    // Large regions, and small round ones too: punched holes.
    let mut bbox = vec![(w, 0usize, h, 0usize); sizes.len()];
    for (i, &l) in labels.iter().enumerate() {
        if l > 0 {
            let b = &mut bbox[l as usize - 1];
            let (x, y) = (i % w, i / w);
            *b = (b.0.min(x), b.1.max(x), b.2.min(y), b.3.max(y));
        }
    }
    let keep: Vec<bool> = sizes
        .iter()
        .zip(&bbox)
        .map(|(&s, b)| {
            let (bw, bh) = ((b.1 - b.0 + 1) as f64, (b.3 - b.2 + 1) as f64);
            let round = (0.6..=1.6).contains(&(bw / bh)) && s as f64 >= 0.55 * bw * bh;
            s as f64 >= 0.003 * sheet || (round && s as f64 >= 0.0003 * sheet)
        })
        .collect();
    let objects = keep.iter().filter(|&&k| k).count();
    let obj: Vec<bool> = labels.iter().map(|&l| l > 0 && keep[l as usize - 1]).collect();
    // A margin of ~1 mm keeps the ink off the object's edge.
    let grown = morph(&obj, w, h, per_mm.round().max(1.0) as usize, true);

    // Soft edge: a small box blur of the paper/object map.
    let hard: Vec<f32> = grown.iter().map(|&o| if o { 0.0 } else { 1.0 }).collect();
    let blur = |src: &[f32], horizontal: bool| -> Vec<f32> {
        let mut out = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut s = 0.0;
                for o in -1i32..=1 {
                    let (xx, yy) = if horizontal { ((x as i32 + o).clamp(0, w as i32 - 1) as usize, y) } else { (x, (y as i32 + o).clamp(0, h as i32 - 1) as usize) };
                    s += src[yy * w + xx];
                }
                out[y * w + x] = s / 3.0;
            }
        }
        out
    };
    let soft = blur(&blur(&hard, true), false);
    for (d, v) in data.iter_mut().zip(soft) {
        *d = (v * 255.0).round() as u8;
    }
    ObjectMask { w, h, data, objects }
}
