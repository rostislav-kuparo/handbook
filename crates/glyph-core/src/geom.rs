//! Small geometry helpers for polylines with pressure.

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
    /// Pressure, roughly 0..1.
    pub p: f64,
}

impl Pt {
    pub fn new(x: f64, y: f64, p: f64) -> Self {
        Pt { x, y, p }
    }

    pub fn dist(&self, o: &Pt) -> f64 {
        ((self.x - o.x).powi(2) + (self.y - o.y).powi(2)).sqrt()
    }

    pub fn lerp(&self, o: &Pt, t: f64) -> Pt {
        Pt {
            x: self.x + (o.x - self.x) * t,
            y: self.y + (o.y - self.y) * t,
            p: self.p + (o.p - self.p) * t,
        }
    }
}

pub type Stroke = Vec<Pt>;

pub fn stroke_length(s: &[Pt]) -> f64 {
    s.windows(2).map(|w| w[0].dist(&w[1])).sum()
}

/// Resample a stroke to exactly `n` points evenly spaced along its length.
pub fn resample_count(s: &[Pt], n: usize) -> Stroke {
    let n = n.max(2);
    if s.is_empty() {
        return Vec::new();
    }
    if s.len() == 1 {
        return vec![s[0]; n];
    }
    let total = stroke_length(s);
    if total <= f64::EPSILON {
        return vec![s[0]; n];
    }
    let step = total / (n - 1) as f64;
    let mut out = Vec::with_capacity(n);
    out.push(s[0]);
    let mut seg = 0;
    let mut seg_start = 0.0; // arc length at s[seg]
    for i in 1..n - 1 {
        let target = step * i as f64;
        while seg < s.len() - 2 && seg_start + s[seg].dist(&s[seg + 1]) < target {
            seg_start += s[seg].dist(&s[seg + 1]);
            seg += 1;
        }
        let len = s[seg].dist(&s[seg + 1]);
        let t = if len > 0.0 { ((target - seg_start) / len).clamp(0.0, 1.0) } else { 0.0 };
        out.push(s[seg].lerp(&s[seg + 1], t));
    }
    out.push(*s.last().unwrap());
    out
}

/// Resample so consecutive points are roughly `spacing` apart.
pub fn resample_spacing(s: &[Pt], spacing: f64) -> Stroke {
    let len = stroke_length(s);
    let n = ((len / spacing.max(0.5)).ceil() as usize + 1).max(2);
    if s.len() == 1 {
        return s.to_vec();
    }
    resample_count(s, n)
}

/// Light binomial smoothing; endpoints stay fixed.
pub fn smooth(s: &mut Stroke, passes: usize) {
    if s.len() < 3 {
        return;
    }
    for _ in 0..passes {
        let src = s.clone();
        for i in 1..src.len() - 1 {
            let a = src[i - 1];
            let b = src[i];
            let c = src[i + 1];
            s[i] = Pt {
                x: (a.x + 2.0 * b.x + c.x) / 4.0,
                y: (a.y + 2.0 * b.y + c.y) / 4.0,
                p: (a.p + 2.0 * b.p + c.p) / 4.0,
            };
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct BBox {
    pub x_min: f64,
    pub y_min: f64,
    pub x_max: f64,
    pub y_max: f64,
}

impl BBox {
    pub fn empty() -> Self {
        BBox { x_min: f64::MAX, y_min: f64::MAX, x_max: f64::MIN, y_max: f64::MIN }
    }

    pub fn add(&mut self, x: f64, y: f64) {
        self.x_min = self.x_min.min(x);
        self.y_min = self.y_min.min(y);
        self.x_max = self.x_max.max(x);
        self.y_max = self.y_max.max(y);
    }

    pub fn is_empty(&self) -> bool {
        self.x_min > self.x_max
    }

    pub fn width(&self) -> f64 {
        if self.is_empty() { 0.0 } else { self.x_max - self.x_min }
    }

    pub fn center_x(&self) -> f64 {
        (self.x_min + self.x_max) / 2.0
    }
}

pub fn strokes_bbox(strokes: &[Stroke]) -> BBox {
    let mut b = BBox::empty();
    for s in strokes {
        for p in s {
            b.add(p.x, p.y);
        }
    }
    b
}

/// Signed area of a closed polygon; positive means counter-clockwise (y up).
pub fn signed_area(poly: &[[f64; 2]]) -> f64 {
    let n = poly.len();
    let mut a = 0.0;
    for i in 0..n {
        let p = poly[i];
        let q = poly[(i + 1) % n];
        a += p[0] * q[1] - q[0] * p[1];
    }
    a / 2.0
}

/// Ramer–Douglas–Peucker simplification of a closed polygon.
pub fn simplify_closed(poly: &[[f64; 2]], eps: f64) -> Vec<[f64; 2]> {
    if poly.len() < 4 {
        return poly.to_vec();
    }
    // Split the ring at the vertex farthest from vertex 0 and simplify both halves.
    let far = (1..poly.len())
        .max_by(|&a, &b| d2(poly[0], poly[a]).partial_cmp(&d2(poly[0], poly[b])).unwrap())
        .unwrap();
    let mut first: Vec<[f64; 2]> = poly[..=far].to_vec();
    let mut second: Vec<[f64; 2]> = poly[far..].to_vec();
    second.push(poly[0]);
    first = rdp(&first, eps);
    second = rdp(&second, eps);
    first.pop();
    second.pop();
    first.extend(second);
    first
}

fn d2(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)
}

fn rdp(pts: &[[f64; 2]], eps: f64) -> Vec<[f64; 2]> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut stack = vec![(0usize, pts.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        let (mut best, mut best_d) = (0, 0.0);
        for i in a + 1..b {
            let d = seg_dist(pts[i], pts[a], pts[b]);
            if d > best_d {
                best = i;
                best_d = d;
            }
        }
        if best_d > eps {
            keep[best] = true;
            stack.push((a, best));
            stack.push((best, b));
        }
    }
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

fn seg_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    if len2 == 0.0 {
        return d2(p, a).sqrt();
    }
    let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0);
    d2(p, [a[0] + t * dx, a[1] + t * dy]).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_keeps_endpoints_and_count() {
        let s = vec![Pt::new(0.0, 0.0, 0.5), Pt::new(10.0, 0.0, 0.5), Pt::new(10.0, 10.0, 0.5)];
        let r = resample_count(&s, 5);
        assert_eq!(r.len(), 5);
        assert_eq!(r[0], s[0]);
        assert_eq!(r[4], s[2]);
        assert!((r[2].x - 10.0).abs() < 1e-9 && r[2].y.abs() < 1e-9);
    }

    #[test]
    fn simplify_square_with_extra_points() {
        let poly = vec![[0.0, 0.0], [5.0, 0.0], [10.0, 0.0], [10.0, 10.0], [5.0, 10.0], [0.0, 10.0]];
        let s = simplify_closed(&poly, 0.1);
        assert_eq!(s.len(), 4);
        assert!((signed_area(&s) - 100.0).abs() < 1e-9);
    }
}
