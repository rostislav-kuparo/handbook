//! Strokes -> filled outlines.
//!
//! Each stroke is swept as a chain of "capsules" (two circles joined by their
//! tangents) whose radius follows pen pressure. The union of all capsules is
//! computed with i_overlay, giving clean contours without overlaps — robust
//! even for loops and sharp reversals where offset curves fold over.

use std::f64::consts::{PI, TAU};

use i_overlay::core::fill_rule::FillRule;
use i_overlay::float::simplify::SimplifyShape;

use crate::geom::*;
use crate::model::Style;
use crate::synth::GlyphInk;

/// Points with pen radius: (x, y, r).
type Disc = (f64, f64, f64);

/// Pen radius along each stroke. Pressure is normalised by the glyph median so
/// pens and mice produce the same overall weight.
pub fn discs(ink: &GlyphInk, style: &Style) -> Vec<Vec<Disc>> {
    discs_of(&skeleton(ink, style))
}

/// The pen discs of a skeleton (pressure dropped).
pub fn discs_of(skel: &[Vec<[f64; 4]>]) -> Vec<Vec<Disc>> {
    skel.iter().map(|s| s.iter().map(|q| (q[0], q[1], q[2])).collect()).collect()
}

/// The centre lines with what the pen did there: (x, y, radius, pressure),
/// pressure normalised to 1 at the glyph's median (0.3..1.5).
pub fn skeleton(ink: &GlyphInk, style: &Style) -> Vec<Vec<[f64; 4]>> {
    let mut ps: Vec<f64> = ink.strokes.iter().flatten().map(|p| p.p).collect();
    if ps.is_empty() {
        return vec![];
    }
    ps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let med = ps[ps.len() / 2].max(0.05);
    let half = style.weight / 2.0;
    let k = style.pressure.clamp(0.0, 1.0);
    ink.strokes
        .iter()
        .map(|s| {
            s.iter()
                .map(|p| {
                    let pn = (p.p / med).clamp(0.3, 1.5);
                    [p.x, p.y, (half * (1.0 - k + k * pn)).max(1.5), pn]
                })
                .collect()
        })
        .collect()
}

/// Bounding box of the inked area (centre line expanded by the pen radius).
pub fn ink_bbox(discs: &[Vec<Disc>]) -> BBox {
    let mut b = BBox::empty();
    for s in discs {
        for &(x, y, r) in s {
            b.add(x - r, y - r);
            b.add(x + r, y + r);
        }
    }
    b
}

/// Union outline. Outer contours are clockwise and holes counter-clockwise
/// (TrueType convention, y up).
pub fn polygons(discs: &[Vec<Disc>]) -> Vec<Vec<[f64; 2]>> {
    let mut contours: Vec<Vec<[f64; 2]>> = Vec::new();
    for s in discs {
        let pts = thin(s);
        if pts.len() == 1 {
            contours.push(circle(pts[0]));
            continue;
        }
        for w in pts.windows(2) {
            contours.push(capsule(w[0], w[1]));
        }
    }
    if contours.is_empty() {
        return vec![];
    }
    let shapes = contours.simplify_shape(FillRule::NonZero);
    let mut out = Vec::new();
    for shape in shapes {
        for (i, c) in shape.into_iter().enumerate() {
            let mut c = simplify_closed(&c, 0.6);
            if c.len() < 3 {
                continue;
            }
            let area = signed_area(&c);
            if area.abs() < 4.0 {
                continue;
            }
            let outer = i == 0;
            if (outer && area > 0.0) || (!outer && area < 0.0) {
                c.reverse();
            }
            out.push(c);
        }
    }
    out
}

/// Drop points that add nothing: keep a point when the pen moved far enough,
/// turned noticeably or changed width.
fn thin(s: &[Disc]) -> Vec<Disc> {
    if s.len() <= 2 {
        return s.to_vec();
    }
    let mut out = vec![s[0]];
    let mut dir: Option<f64> = None;
    for i in 1..s.len() - 1 {
        let last = *out.last().unwrap();
        let p = s[i];
        let d = ((p.0 - last.0).powi(2) + (p.1 - last.1).powi(2)).sqrt();
        let max_step = (last.2 * 0.9).clamp(4.0, 22.0);
        let a = (p.1 - last.1).atan2(p.0 - last.0);
        let turned = dir.is_some_and(|d0| angle_diff(a, d0) > 0.21);
        let widened = (p.2 - last.2).abs() > last.2 * 0.15;
        if d >= max_step || (d > 2.0 && (turned || widened)) {
            out.push(p);
            dir = Some(a);
        } else if dir.is_none() && d > 2.0 {
            dir = Some(a);
        }
    }
    out.push(*s.last().unwrap());
    out
}

fn angle_diff(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(TAU);
    d.min(TAU - d)
}

/// Angular step that keeps the polygon within `tol` units of the true circle.
fn arc_step(r: f64) -> f64 {
    let tol = 0.8_f64.min(r * 0.5);
    (2.0 * (1.0 - tol / r).clamp(-1.0, 1.0).acos()).clamp(0.12, PI / 4.0)
}

fn arc(out: &mut Vec<[f64; 2]>, c: Disc, from: f64, to: f64) {
    let span = to - from;
    let n = ((span / arc_step(c.2)).ceil() as usize).max(1);
    for i in 0..=n {
        let t = from + span * i as f64 / n as f64;
        out.push([c.0 + c.2 * t.cos(), c.1 + c.2 * t.sin()]);
    }
}

fn circle(c: Disc) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    arc(&mut out, c, 0.0, TAU);
    out.pop();
    out
}

/// Convex hull of two discs, counter-clockwise.
fn capsule(a: Disc, b: Disc) -> Vec<[f64; 2]> {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let d = (dx * dx + dy * dy).sqrt();
    if d + a.2.min(b.2) <= a.2.max(b.2) + 1e-9 {
        return circle(if a.2 > b.2 { a } else { b });
    }
    let theta = dy.atan2(dx);
    let alpha = ((a.2 - b.2) / d).clamp(-1.0, 1.0).acos();
    let mut poly = Vec::new();
    arc(&mut poly, b, theta - alpha, theta + alpha);
    arc(&mut poly, a, theta + alpha, theta + TAU - alpha);
    poly
}

/// SVG path data. Polygon vertices act as quadratic B-spline control points
/// (the same curves TrueType draws from consecutive off-curve points), which
/// smooths away the faceting. `flip` maps font y-up to SVG y-down.
pub fn svg_path(contours: &[Vec<[f64; 2]>], dx: f64, dy: f64, flip: bool, out: &mut String) {
    use std::fmt::Write;
    let sy = if flip { -1.0 } else { 1.0 };
    for c in contours {
        let n = c.len();
        if n < 3 {
            continue;
        }
        let pt = |i: usize| [c[i % n][0] + dx, c[i % n][1] * sy + dy];
        let mid = |a: [f64; 2], b: [f64; 2]| [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
        let start = mid(pt(n - 1), pt(0));
        let _ = write!(out, "M{:.1} {:.1}", start[0], start[1]);
        for i in 0..n {
            let ctrl = pt(i);
            let end = mid(ctrl, pt(i + 1));
            let _ = write!(out, "Q{:.1} {:.1} {:.1} {:.1}", ctrl[0], ctrl[1], end[0], end[1]);
        }
        out.push('Z');
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::Pt;

    #[test]
    fn straight_stroke_becomes_one_clockwise_contour() {
        let ink = GlyphInk {
            strokes: vec![(0..=50).map(|i| Pt::new(i as f64 * 8.0, 0.0, 0.5)).collect()],
            entry: None,
            exit: None,
        };
        let style = Style::default();
        let d = discs(&ink, &style);
        let polys = polygons(&d);
        assert_eq!(polys.len(), 1);
        assert!(signed_area(&polys[0]) < 0.0);
        let b = ink_bbox(&d);
        assert!((b.width() - (400.0 + style.weight)).abs() < 1.0);
    }

    #[test]
    fn closed_loop_has_a_hole() {
        let ink = GlyphInk {
            strokes: vec![(0..=120)
                .map(|i| {
                    let t = i as f64 / 120.0 * TAU * 1.02;
                    Pt::new(200.0 * t.cos(), 200.0 * t.sin(), 0.5)
                })
                .collect()],
            entry: None,
            exit: None,
        };
        let polys = polygons(&discs(&ink, &Style::default()));
        assert_eq!(polys.len(), 2, "ring = outer contour + hole");
        let areas: Vec<f64> = polys.iter().map(|p| signed_area(p)).collect();
        assert!(areas.iter().any(|a| *a < 0.0) && areas.iter().any(|a| *a > 0.0));
    }
}
