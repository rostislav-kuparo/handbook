//! Optical kerning from the actual ink.
//!
//! Each glyph gets a horizontal profile: for every 20-unit band of height, the
//! leftmost and rightmost ink. Two neighbours are compared band by band; the
//! closest approach decides the correction. Letters with an open side ("Г",
//! "Т", "У", a period after "г") are pulled closer, letters that would collide
//! are pushed apart. Joined cursive pairs are never kerned — their anchors
//! already position them.

pub const BAND: f64 = 20.0;
const Y_MIN: f64 = -500.0;
pub const BANDS: usize = 90; // -500 .. 1300

/// Leftmost and rightmost ink per height band (±infinity when the band is empty).
#[derive(Clone, Debug)]
pub struct Profile {
    pub left: Vec<f64>,
    pub right: Vec<f64>,
}

impl Profile {
    pub fn empty() -> Self {
        Profile { left: vec![f64::INFINITY; BANDS], right: vec![f64::NEG_INFINITY; BANDS] }
    }

    fn add(&mut self, band: usize, x: f64) {
        self.left[band] = self.left[band].min(x);
        self.right[band] = self.right[band].max(x);
    }

    /// Profile of closed contours, shifted by `dx`.
    pub fn of(contours: &[Vec<[f64; 2]>], dx: f64) -> Profile {
        let mut p = Profile::empty();
        for c in contours {
            for i in 0..c.len() {
                let a = c[i];
                let b = c[(i + 1) % c.len()];
                let (lo, hi) = (a[1].min(b[1]), a[1].max(b[1]));
                let first = band_of(lo);
                let last = band_of(hi);
                for band in first..=last {
                    // x where the edge crosses the middle of the band (clamped to the edge)
                    let yc = (Y_MIN + (band as f64 + 0.5) * BAND).clamp(lo, hi);
                    let t = if (b[1] - a[1]).abs() < 1e-9 { 0.5 } else { (yc - a[1]) / (b[1] - a[1]) };
                    p.add(band, a[0] + (b[0] - a[0]) * t.clamp(0.0, 1.0) + dx);
                }
            }
        }
        p
    }

    /// Envelope over several variants: the widest possible ink, so a kern
    /// value that is safe for the envelope is safe for every variant.
    pub fn envelope(profiles: &[(Profile, f64)]) -> (Vec<f64>, Vec<f64>) {
        let mut left = vec![f64::INFINITY; BANDS];
        let mut right_rel = vec![f64::NEG_INFINITY; BANDS];
        for (p, advance) in profiles {
            for i in 0..BANDS {
                left[i] = left[i].min(p.left[i]);
                right_rel[i] = right_rel[i].max(p.right[i] - advance);
            }
        }
        (left, right_rel)
    }
}

fn band_of(y: f64) -> usize {
    (((y - Y_MIN) / BAND).floor().max(0.0) as usize).min(BANDS - 1)
}

/// Kerning between a glyph whose right profile is given relative to its
/// advance (`right_rel`) and the next glyph's left profile.
/// `side_bearing` is the normal distance each letter keeps on its side.
pub fn pair_kern(right_rel: &[f64], left: &[f64], side_bearing: f64) -> f64 {
    let mut gap = f64::INFINITY;
    for i in 0..BANDS {
        if right_rel[i].is_finite() && left[i].is_finite() {
            gap = gap.min(left[i] - right_rel[i]);
        }
        // Diagonal neighbours: shapes approaching at a slant.
        if i + 1 < BANDS {
            if right_rel[i].is_finite() && left[i + 1].is_finite() {
                gap = gap.min(left[i + 1] - right_rel[i] + BAND * 0.5);
            }
            if right_rel[i + 1].is_finite() && left[i].is_finite() {
                gap = gap.min(left[i] - right_rel[i + 1] + BAND * 0.5);
            }
        }
    }
    if !gap.is_finite() {
        return 0.0;
    }
    let normal = 2.0 * side_bearing.max(10.0);
    if gap < 0.6 * normal {
        // Too close: push apart so the letters do not collide.
        return 0.6 * normal - gap;
    }
    // Open shapes: close 70% of the extra room, never more than a third of an em.
    -((gap - normal).max(0.0) * 0.7).min(330.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<[f64; 2]> {
        vec![[x0, y0], [x0, y1], [x1, y1], [x1, y0]]
    }

    #[test]
    fn open_shape_is_pulled_closer() {
        // "Г": stem on the left plus a bar at the top; next letter is low ("о").
        let g = vec![rect(0.0, 0.0, 60.0, 700.0), rect(0.0, 640.0, 400.0, 700.0)];
        let o = vec![rect(0.0, 0.0, 300.0, 450.0)];
        let sb = 45.0;
        let (g_adv, pg) = (400.0 + sb, Profile::of(&g, 0.0));
        let po = Profile::of(&o, sb);
        let (_, right_rel) = Profile::envelope(&[(pg, g_adv)]);
        let (left, _) = Profile::envelope(&[(po, 300.0 + 2.0 * sb)]);
        let k = pair_kern(&right_rel, &left, sb);
        assert!(k < -150.0, "Г + о should tighten a lot, got {k}");
    }

    #[test]
    fn plain_neighbours_keep_their_spacing() {
        let a = vec![rect(0.0, 0.0, 300.0, 450.0)];
        let sb = 45.0;
        let pa = Profile::of(&a, sb);
        let (left, right_rel) = Profile::envelope(&[(pa, 300.0 + 2.0 * sb)]);
        let k = pair_kern(&right_rel, &left, sb);
        assert!(k.abs() < 1.0, "two boxes already sit at the normal distance, got {k}");
    }
}
