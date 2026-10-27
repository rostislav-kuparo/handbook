//! Plane geometry: the sheet's quadrilateral, its sides as lines, and the
//! perspective map between the flat sheet and the photo.

pub type Pt = [f64; 2];

pub fn sub(a: Pt, b: Pt) -> Pt {
    [a[0] - b[0], a[1] - b[1]]
}

pub fn dist(a: Pt, b: Pt) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

pub fn cross(a: Pt, b: Pt) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}

/// An infinite line: a point on it and a unit direction.
#[derive(Clone, Copy, Debug)]
pub struct Line {
    pub p: Pt,
    pub d: Pt,
}

impl Line {
    pub fn through(a: Pt, b: Pt) -> Line {
        let d = sub(b, a);
        let l = d[0].hypot(d[1]).max(1e-12);
        Line { p: a, d: [d[0] / l, d[1] / l] }
    }

    /// Signed distance of a point from the line (positive to the left of `d` in y-down coordinates, i.e. outward for a clockwise quad).
    pub fn offset(&self, q: Pt) -> f64 {
        cross(self.d, sub(q, self.p)) * -1.0
    }

    /// Unit normal pointing outward for a clockwise quadrilateral (y down).
    pub fn normal(&self) -> Pt {
        [self.d[1], -self.d[0]]
    }

    pub fn intersect(&self, o: &Line) -> Option<Pt> {
        let den = cross(self.d, o.d);
        if den.abs() < 1e-9 {
            return None;
        }
        let t = cross(sub(o.p, self.p), o.d) / den;
        Some([self.p[0] + self.d[0] * t, self.p[1] + self.d[1] * t])
    }
}

/// Corners go round clockwise on screen (y down) and the quadrilateral is convex.
pub fn convex_clockwise(q: &[Pt; 4]) -> bool {
    (0..4).all(|k| cross(sub(q[(k + 1) % 4], q[k]), sub(q[(k + 2) % 4], q[(k + 1) % 4])) > 0.0)
}

pub fn area(q: &[Pt]) -> f64 {
    let n = q.len();
    (0..n).map(|k| cross(q[k], q[(k + 1) % n])).sum::<f64>().abs() / 2.0
}

/// 3×3 matrix, row-major.
pub type Mat3 = [f64; 9];

pub fn apply(m: &Mat3, p: Pt) -> Pt {
    let w = m[6] * p[0] + m[7] * p[1] + m[8];
    [(m[0] * p[0] + m[1] * p[1] + m[2]) / w, (m[3] * p[0] + m[4] * p[1] + m[5]) / w]
}

/// The homography taking the unit square (0,0) (1,0) (1,1) (0,1) to the four corners.
pub fn square_to_quad(q: &[Pt; 4]) -> Mat3 {
    // Closed form (Heckbert): projective map of the unit square.
    let [p0, p1, p2, p3] = *q;
    let sx = p0[0] - p1[0] + p2[0] - p3[0];
    let sy = p0[1] - p1[1] + p2[1] - p3[1];
    if sx.abs() < 1e-12 && sy.abs() < 1e-12 {
        return [p1[0] - p0[0], p3[0] - p0[0], p0[0], p1[1] - p0[1], p3[1] - p0[1], p0[1], 0.0, 0.0, 1.0];
    }
    let (dx1, dy1) = (p1[0] - p2[0], p1[1] - p2[1]);
    let (dx2, dy2) = (p3[0] - p2[0], p3[1] - p2[1]);
    let den = dx1 * dy2 - dx2 * dy1;
    let g = (sx * dy2 - dx2 * sy) / den;
    let h = (dx1 * sy - sx * dy1) / den;
    [
        p1[0] - p0[0] + g * p1[0],
        p3[0] - p0[0] + h * p3[0],
        p0[0],
        p1[1] - p0[1] + g * p1[1],
        p3[1] - p0[1] + h * p3[1],
        p0[1],
        g,
        h,
        1.0,
    ]
}

pub fn invert(m: &Mat3) -> Mat3 {
    let [a, b, c, d, e, f, g, h, i] = *m;
    let ca = e * i - f * h;
    let cb = f * g - d * i;
    let cc = d * h - e * g;
    let det = a * ca + b * cb + c * cc;
    [ca, c * h - b * i, b * f - c * e, cb, a * i - c * g, c * d - a * f, cc, b * g - a * h, a * e - b * d].map(|v| v / det)
}

/// Puts four corners in the order the editor uses: clockwise on screen,
/// starting at the top-left of an upright sheet — the top side is a short
/// side (sheets are portrait), the higher of the two in the photo.
pub fn order_corners(mut q: [Pt; 4]) -> [Pt; 4] {
    let c = [q.iter().map(|p| p[0]).sum::<f64>() / 4.0, q.iter().map(|p| p[1]).sum::<f64>() / 4.0];
    q.sort_by(|a, b| {
        let ta = (a[1] - c[1]).atan2(a[0] - c[0]);
        let tb = (b[1] - c[1]).atan2(b[0] - c[0]);
        ta.partial_cmp(&tb).unwrap()
    });
    // atan2 with y down grows clockwise on screen.
    let side = |q: &[Pt; 4], k: usize| dist(q[k], q[(k + 1) % 4]);
    let mid_y = |q: &[Pt; 4], k: usize| (q[k][1] + q[(k + 1) % 4][1]) / 2.0;
    let short = if side(&q, 0) + side(&q, 2) <= side(&q, 1) + side(&q, 3) { 0 } else { 1 };
    let top = if mid_y(&q, short) <= mid_y(&q, short + 2) { short } else { short + 2 };
    [q[top], q[(top + 1) % 4], q[(top + 2) % 4], q[(top + 3) % 4]]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_maps_onto_the_corners() {
        let q = [[100.0, 80.0], [900.0, 120.0], [950.0, 1000.0], [60.0, 960.0]];
        let m = square_to_quad(&q);
        for (k, s) in [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]].iter().enumerate() {
            assert!(dist(apply(&m, *s), q[k]) < 1e-9);
        }
        let back = apply(&invert(&m), q[2]);
        assert!(dist(back, [1.0, 1.0]) < 1e-9);
    }

    #[test]
    fn corners_are_ordered_from_the_top_left() {
        let q = [[950.0, 1000.0], [100.0, 80.0], [60.0, 960.0], [700.0, 120.0]];
        let o = order_corners(q);
        assert_eq!(o[0], [100.0, 80.0]);
        assert_eq!(o[1], [700.0, 120.0]);
        assert!(convex_clockwise(&o));
    }
}
