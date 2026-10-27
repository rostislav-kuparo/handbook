//! Where a point of the sheet lies in the photo. A flat sheet is a
//! perspective map of its four corners; a curved one adds the bulge of its
//! sides, spread over the sheet (a Coons patch), and a grid of corrections —
//! from the printed lines or dragged by hand.

use serde::{Deserialize, Serialize};

use crate::quad::{apply, dist, square_to_quad, Line, Mat3, Pt};

/// Corrections at grid nodes, photo px; nodes run row by row, `nx` across, `ny` down.
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Grid {
    pub nx: usize,
    pub ny: usize,
    pub d: Vec<Pt>,
}

impl Grid {
    pub fn zero(nx: usize, ny: usize) -> Grid {
        Grid { nx, ny, d: vec![[0.0, 0.0]; nx * ny] }
    }

    /// Catmull-Rom interpolation between the nodes (passes through them).
    pub fn at(&self, u: f64, v: f64) -> Pt {
        let (nx, ny) = (self.nx.max(2), self.ny.max(2));
        let axis = |t: f64, n: usize| {
            let f = t.clamp(0.0, 1.0) * (n - 1) as f64;
            let i = (f.floor() as usize).min(n - 2);
            (i, catmull_rom(f - i as f64))
        };
        let ((i, wx), (j, wy)) = (axis(u, nx), axis(v, ny));
        let mut out = [0.0, 0.0];
        for (b, wyb) in wy.iter().enumerate() {
            let y = (j as isize + b as isize - 1).clamp(0, ny as isize - 1) as usize;
            for (a, wxa) in wx.iter().enumerate() {
                let x = (i as isize + a as isize - 1).clamp(0, nx as isize - 1) as usize;
                let d = self.d[y * nx + x];
                out[0] += wxa * wyb * d[0];
                out[1] += wxa * wyb * d[1];
            }
        }
        out
    }
}

fn catmull_rom(t: f64) -> [f64; 4] {
    let (t2, t3) = (t * t, t * t * t);
    [(-t3 + 2.0 * t2 - t) / 2.0, (3.0 * t3 - 5.0 * t2 + 2.0) / 2.0, (-3.0 * t3 + 4.0 * t2 + t) / 2.0, (t3 - t2) / 2.0]
}

/// A cubic in t: c0 + c1·t + c2·t² + c3·t³.
pub fn poly(c: &[f64; 4], t: f64) -> f64 {
    c[0] + t * (c[1] + t * (c[2] + t * c[3]))
}

#[derive(Deserialize, Clone, Debug)]
pub struct Warp {
    /// Top-left, top-right, bottom-right, bottom-left, clockwise on screen.
    pub corners: [Pt; 4],
    /// How far each side (top, right, bottom, left) bows out from the straight
    /// line between its corners: a cubic in the fraction along it, photo px
    /// along the outward normal, zero at both ends.
    #[serde(default)]
    pub bulge: Option<[[f64; 4]; 4]>,
    #[serde(default)]
    pub grid: Option<Grid>,
}

/// A warp ready to be evaluated many times.
pub struct WarpMap {
    h: Mat3,
    sides: [(Line, f64); 4],
    bulge: Option<[[f64; 4]; 4]>,
    grid: Option<Grid>,
}

impl Warp {
    #[cfg(test)]
    pub fn flat(corners: [Pt; 4]) -> Warp {
        Warp { corners, bulge: None, grid: None }
    }

    pub fn map(&self) -> WarpMap {
        let c = self.corners;
        WarpMap {
            h: square_to_quad(&c),
            sides: std::array::from_fn(|k| (Line::through(c[k], c[(k + 1) % 4]), dist(c[k], c[(k + 1) % 4]).max(1e-9))),
            bulge: self.bulge,
            grid: self.grid.clone(),
        }
    }
}

impl WarpMap {
    /// The photo point of sheet point (u, v), both 0..1.
    pub fn at(&self, u: f64, v: f64) -> Pt {
        let mut p = apply(&self.h, [u, v]);
        if let Some(b) = &self.bulge {
            // Each side's bow at the point of the side level with (u, v), blended across the sheet.
            let side = |k: usize, q: Pt| {
                let (l, len) = &self.sides[k];
                let t = (((q[0] - l.p[0]) * l.d[0] + (q[1] - l.p[1]) * l.d[1]) / len).clamp(0.0, 1.0);
                let m = poly(&b[k], t);
                let n = l.normal();
                [n[0] * m, n[1] * m]
            };
            let top = side(0, apply(&self.h, [u, 0.0]));
            let right = side(1, apply(&self.h, [1.0, v]));
            let bottom = side(2, apply(&self.h, [u, 1.0]));
            let left = side(3, apply(&self.h, [0.0, v]));
            for i in 0..2 {
                p[i] += (1.0 - v) * top[i] + u * right[i] + v * bottom[i] + (1.0 - u) * left[i];
            }
        }
        if let Some(g) = &self.grid {
            let d = g.at(u, v);
            p[0] += d[0];
            p[1] += d[1];
        }
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flat_warp_is_the_perspective_and_the_grid_passes_its_nodes() {
        let q = [[100.0, 80.0], [900.0, 120.0], [950.0, 1000.0], [60.0, 960.0]];
        let flat = Warp::flat(q).map();
        assert!(dist(flat.at(1.0, 1.0), q[2]) < 1e-9);
        let mut g = Grid::zero(5, 7);
        g.d[2 * 5 + 3] = [4.0, -2.0];
        let w = Warp { corners: q, bulge: None, grid: Some(g) }.map();
        let (u, v) = (3.0 / 4.0, 2.0 / 6.0);
        let moved = w.at(u, v);
        let base = flat.at(u, v);
        assert!(dist(moved, [base[0] + 4.0, base[1] - 2.0]) < 1e-9);
        // Bulges are zero at the corners.
        let b = Warp { corners: q, bulge: Some([[0.0, 8.0, -8.0, 0.0]; 4]), grid: None }.map();
        for (k, (u, v)) in [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)].into_iter().enumerate() {
            assert!(dist(b.at(u, v), q[k]) < 1e-9);
        }
        // The middle of the top side bows outward (up, for this sheet) by 2 px.
        let mid = b.at(0.5, 0.0);
        let chord = flat.at(0.5, 0.0);
        assert!(mid[1] < chord[1] && (dist(mid, chord) - 2.0).abs() < 0.1, "{mid:?} {chord:?}");
    }
}
