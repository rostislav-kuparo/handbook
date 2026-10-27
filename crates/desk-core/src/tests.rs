//! Synthetic desks where every answer is known: the corners, the blur, the
//! noise, the glare and the pen.

use crate::img::{to_srgb8, Gray, Photo};
use crate::quad::{apply, cross, dist, square_to_quad, sub, Pt};
use crate::rng::Rng;
use crate::warp::Warp;
use crate::{calib, edges, light, mask, measure, noise, ruling, sheet};

struct Scene {
    w: usize,
    h: usize,
    quad: [Pt; 4],
    /// Linear colours.
    paper: [f64; 3],
    desk: [f64; 3],
    /// Lighting falls off from left to right by this much.
    falloff: f64,
    sigma: f64,
    /// The phone's sharpening: unsharp mask radius and amount.
    sharpen: Option<(f64, f64)>,
    /// Noise variance a·L + b (linear).
    noise: (f64, f64),
    /// Additive glare: centre, radius, strength.
    glare: Option<(Pt, f64, f64)>,
    /// Ink: segment ends, width (px), transmittance.
    strokes: Vec<(Pt, Pt, f64, [f64; 3])>,
    /// Samples per pixel side.
    ss: usize,
    /// The sheet's outline when its sides are curved (else the quad).
    outline: Option<Vec<Pt>>,
}

impl Scene {
    fn new(w: usize, h: usize, quad: [Pt; 4]) -> Scene {
        Scene {
            w,
            h,
            quad,
            paper: [0.80, 0.78, 0.72],
            desk: [0.12, 0.07, 0.04],
            falloff: 0.35,
            sigma: 0.0,
            sharpen: None,
            noise: (0.0, 0.0),
            glare: None,
            strokes: vec![],
            ss: 4,
            outline: None,
        }
    }

    fn render(&self) -> Photo {
        let inside = |p: Pt| match &self.outline {
            // Ray casting across the polygon's edges.
            Some(poly) => {
                let mut inn = false;
                for k in 0..poly.len() {
                    let (a, b) = (poly[k], poly[(k + 1) % poly.len()]);
                    if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]) {
                        inn = !inn;
                    }
                }
                inn
            }
            None => (0..4).all(|k| cross(sub(self.quad[(k + 1) % 4], self.quad[k]), sub(p, self.quad[k])) >= 0.0),
        };
        let seg = |p: Pt, a: Pt, b: Pt| {
            let ab = sub(b, a);
            let t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / (ab[0] * ab[0] + ab[1] * ab[1]);
            let t = t.clamp(0.0, 1.0);
            dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t])
        };
        let mut ch: Vec<Gray> = (0..3).map(|_| Gray::new(self.w, self.h)).collect();
        let ss = self.ss;
        let boxes: Vec<[f64; 4]> = self
            .strokes
            .iter()
            .map(|(a, b, w, _)| [a[0].min(b[0]) - w, a[0].max(b[0]) + w, a[1].min(b[1]) - w, a[1].max(b[1]) + w])
            .collect();
        // Strokes by 32-px cell, so each pixel only looks at the strokes near it.
        let cell = 32.0;
        let (gw, gh) = ((self.w as f64 / cell).ceil() as usize, (self.h as f64 / cell).ceil() as usize);
        let mut cells: Vec<Vec<usize>> = vec![vec![]; gw * gh];
        for (i, b) in boxes.iter().enumerate() {
            let (x0, x1) = ((b[0] / cell).floor().max(0.0) as usize, ((b[1] / cell).floor().max(0.0) as usize).min(gw - 1));
            let (y0, y1) = ((b[2] / cell).floor().max(0.0) as usize, ((b[3] / cell).floor().max(0.0) as usize).min(gh - 1));
            for cy in y0..=y1 {
                for cx in x0..=x1 {
                    cells[cy * gw + cx].push(i);
                }
            }
        }
        for y in 0..self.h {
            for x in 0..self.w {
                let mut acc = [0.0; 3];
                for sy in 0..ss {
                    for sx in 0..ss {
                        let p = [x as f64 + (sx as f64 + 0.5) / ss as f64, y as f64 + (sy as f64 + 0.5) / ss as f64];
                        let mut c = if inside(p) { self.paper } else { self.desk };
                        for &si in &cells[(y / cell as usize).min(gh - 1) * gw + (x / cell as usize).min(gw - 1)] {
                            let ((a, b, w, t), bx) = (&self.strokes[si], &boxes[si]);
                            if p[0] < bx[0] || p[0] > bx[1] || p[1] < bx[2] || p[1] > bx[3] {
                                continue;
                            }
                            if seg(p, *a, *b) <= w / 2.0 {
                                for k in 0..3 {
                                    c[k] *= t[k];
                                }
                            }
                        }
                        for k in 0..3 {
                            acc[k] += c[k];
                        }
                    }
                }
                let light = 1.0 - self.falloff * x as f64 / self.w as f64;
                for k in 0..3 {
                    ch[k].data[y * self.w + x] = (acc[k] / (ss * ss) as f64 * light) as f32;
                }
            }
        }
        let mut ch: Vec<Gray> = ch.iter().map(|g| g.blur(self.sigma)).collect();
        if let Some((radius, amount)) = self.sharpen {
            for g in ch.iter_mut() {
                let soft = g.blur(radius);
                for (v, s) in g.data.iter_mut().zip(&soft.data) {
                    *v += amount as f32 * (*v - s);
                }
            }
        }
        let mut rng = Rng::new(7);
        let mut rgba = vec![255u8; self.w * self.h * 4];
        for y in 0..self.h {
            for x in 0..self.w {
                let glare = self.glare.map_or(0.0, |(c, r, s)| s * (-(dist([x as f64, y as f64], c) / r).powi(2)).exp());
                for k in 0..3 {
                    let l = ch[k].at(x, y) as f64 + glare;
                    let n = (self.noise.0 * l + self.noise.1).max(0.0).sqrt() * rng.gauss();
                    rgba[(y * self.w + x) * 4 + k] = to_srgb8(l + n);
                }
            }
        }
        Photo::new(rgba, self.w, self.h)
    }
}

const QUAD: [Pt; 4] = [[250.0, 120.0], [720.0, 150.0], [760.0, 800.0], [215.0, 770.0]];

fn worst(a: &[Pt; 4], b: &[Pt; 4]) -> f64 {
    (0..4).map(|k| dist(a[k], b[k])).fold(0.0, f64::max)
}

#[test]
fn finds_the_sheet() {
    let mut s = Scene::new(1000, 900, QUAD);
    s.sigma = 1.0;
    s.noise = (2e-4, 1e-5);
    let photo = s.render();
    let found = sheet::find_sheet(&photo).expect("sheet");
    assert!(worst(&found.corners, &QUAD) < 4.0, "{:?}", found.corners);
    assert!(found.confidence > 0.9, "{}", found.confidence);
    let snapped = edges::snap(&photo, found.corners, [true; 4]);
    assert_eq!(snapped.snapped, [true; 4]);
    assert!(worst(&snapped.corners, &QUAD) < 0.3, "{:?}", snapped.corners);
}

#[test]
fn sides_stick_to_the_edges_through_a_finger() {
    let mut s = Scene::new(1000, 900, QUAD);
    s.sigma = 1.3;
    s.noise = (3e-4, 2e-5);
    // A dark «finger» across the right edge.
    s.strokes.push(([700.0, 420.0], [800.0, 440.0], 40.0, [0.25, 0.2, 0.2]));
    let photo = s.render();
    let rough = [[244.0, 129.0], [711.0, 144.0], [768.0, 808.0], [209.0, 761.0]];
    let snapped = edges::snap(&photo, rough, [true; 4]);
    assert_eq!(snapped.snapped, [true; 4]);
    assert!(worst(&snapped.corners, &QUAD) < 0.3, "{:?}", snapped.corners);
    // Only the chosen sides move.
    let one = edges::snap(&photo, rough, [true, false, false, false]);
    assert_eq!(one.snapped, [true, false, false, false]);
    assert!(dist(one.corners[2], rough[2]) < 1e-6);
}

#[test]
fn reads_the_blur_off_the_edges() {
    for sigma in [0.7, 1.5] {
        let mut s = Scene::new(1000, 900, QUAD);
        s.sigma = sigma;
        s.noise = (1e-4, 5e-6);
        let m = measure(&s.render(), &QUAD, [true; 4]);
        let got = m.sigma.expect("sigma");
        assert!((got - sigma).abs() < 0.15 * sigma + 0.05, "σ {sigma}: {got} {:?}", m.sides);
        assert!(m.sharpen < 0.3, "no sharpening was applied: {}", m.sharpen);
    }
}

#[test]
fn measures_the_noise() {
    let mut s = Scene::new(1000, 900, QUAD);
    s.sigma = 0.8;
    s.falloff = 0.6;
    s.noise = (4e-4, 2e-5);
    let n = noise::measure_noise(&s.render(), &QUAD).expect("noise");
    // At the paper's brightness the variance must match within a fifth.
    for c in 0..3 {
        let l = 0.6;
        let want = 4e-4 * l + 2e-5;
        let got = n.a[c] * l + n.b[c];
        assert!((got / want - 1.0).abs() < 0.2, "channel {c}: {got} vs {want} ({n:?})");
    }
    assert!(n.rho < 0.3, "independent channels: {}", n.rho);
    assert!(n.smooth < 0.4, "white noise: {}", n.smooth);
}

#[test]
fn maps_the_glare_only_where_the_paper_burns_out() {
    let mut s = Scene::new(1000, 900, QUAD);
    s.glare = Some(([480.0, 400.0], 90.0, 0.6));
    let photo = s.render();
    let m = light::specular_map(&photo, &QUAD, 4).expect("glare");
    let at = |x: usize, y: usize| m.rgba[((y / 4) * m.w + x / 4) * 4] as f64 / 255.0;
    assert!(at(480, 400) > 0.1, "{}", at(480, 400));
    assert_eq!(at(300, 700), 0.0);
    let mut calm = Scene::new(1000, 900, QUAD);
    calm.glare = None;
    assert!(light::specular_map(&calm.render(), &QUAD, 4).is_none());
}

#[test]
fn takes_the_colour_of_a_real_pen() {
    let mut s = Scene::new(1000, 900, QUAD);
    s.sigma = 0.8;
    s.noise = (1e-4, 5e-6);
    let t = [0.25, 0.32, 0.62];
    for k in 0..6 {
        let y = 400.0 + k as f64 * 9.0;
        s.strokes.push(([420.0, y], [520.0, y + 6.0], 4.0, t));
    }
    let photo = s.render();
    let c = calib::calibrate(&photo, 470.0, 425.0, 40.0, 0.8).expect("ink");
    for k in 0..3 {
        assert!((c.t[k] - t[k]).abs() < 0.06, "{:?} vs {t:?}", c.t);
    }
    assert!((c.width - 4.0).abs() < 1.6, "width {}", c.width);
    // Blank paper: nothing to take.
    assert!(calib::calibrate(&photo, 400.0, 650.0, 30.0, 0.8).is_none());
}


#[test]
fn notices_the_phones_sharpening() {
    let mut s = Scene::new(1000, 900, QUAD);
    s.sigma = 1.0;
    s.sharpen = Some((1.2, 1.0));
    s.noise = (1e-4, 5e-6);
    let m = measure(&s.render(), &QUAD, [true; 4]);
    assert!((0.5..1.6).contains(&m.sharpen), "sharpen {} σ {:?}", m.sharpen, m.sigma);
}

const BIG: [Pt; 4] = [[200.0, 150.0], [1150.0, 190.0], [1200.0, 1500.0], [160.0, 1460.0]];
const A4_MM: (f64, f64) = (210.0, 297.0);

/// A notebook sheet: blue lines every `step` mm from 13.3 mm, leaning by
/// `slope`, vertical lines too for squares, a red margin line at `margin` mm.
fn notebook(grid: bool, margin: f64) -> Scene {
    notebook_on(A4_MM, grid, &[(margin, [0.95, 0.55, 0.6], 1.6)])
}

/// The same on paper of `size` mm, with margin lines (x mm, colour, width px).
fn notebook_on(size: (f64, f64), grid: bool, margins: &[(f64, [f64; 3], f64)]) -> Scene {
    let mut s = Scene::new(1400, 1650, BIG);
    s.ss = 2;
    s.sigma = 0.8;
    s.noise = (1e-4, 5e-6);
    let (w, h) = size;
    let m = square_to_quad(&BIG);
    let on = |x: f64, y: f64| apply(&m, [x / w, y / h]);
    let (step, slope, lw) = (if grid { 5.0 } else { 8.0 }, 0.008, 1.6);
    let blue = [0.62, 0.74, 0.95];
    let mut y = 13.3;
    while y < h {
        s.strokes.push((on(0.0, y), on(w, y + w * slope), lw, blue));
        y += step;
    }
    if grid {
        let mut x = 4.0;
        while x < w {
            s.strokes.push((on(x, 0.0), on(x - h * slope, h), lw, blue));
            x += step;
        }
    }
    for &(x, color, width) in margins {
        s.strokes.push((on(x, 0.0), on(x - h * slope, h), width, color));
    }
    s
}

/// Distance between two positions of a comb with this step.
fn phase_gap(a: f64, b: f64, step: f64) -> f64 {
    let d = (a - b).rem_euclid(step);
    d.min(step - d)
}

#[test]
fn finds_the_lines_of_a_ruled_sheet() {
    let photo = notebook(false, 25.0).render();
    let r = ruling::detect(&photo, &Warp::flat(BIG), A4_MM.0, A4_MM.1).expect("ruling");
    assert_eq!(r.kind, "ruled");
    assert!((r.step - 8.0).abs() < 0.04, "step {}", r.step);
    assert!(phase_gap(r.offset, 13.3, 8.0) < 0.3, "offset {}", r.offset);
    assert!((r.slope - 0.008).abs() < 0.002, "slope {}", r.slope);
    let m = &r.margins;
    assert!(m.left.is_some_and(|x| (x - 25.0).abs() < 0.4) && m.right.is_none(), "{m:?}");
}

#[test]
fn finds_squares_and_a_margin_on_the_right() {
    let photo = notebook(true, 185.0).render();
    let r = ruling::detect(&photo, &Warp::flat(BIG), A4_MM.0, A4_MM.1).expect("ruling");
    assert_eq!(r.kind, "grid");
    assert!((r.step - 5.0).abs() < 0.03, "step {}", r.step);
    assert!(phase_gap(r.offset, 13.3, 5.0) < 0.3, "offset {}", r.offset);
    assert!(phase_gap(r.col_offset.expect("columns"), 4.0, 5.0) < 0.3, "{:?}", r.col_offset);
    assert!(r.col_step.is_some_and(|c| (c - 5.0).abs() < 0.05), "{:?}", r.col_step);
    let m = &r.margins;
    assert!(m.right.is_some_and(|x| (x - 185.0).abs() < 0.4) && m.left.is_none(), "{m:?}");
}

#[test]
fn blank_paper_has_no_lines() {
    let mut s = Scene::new(1400, 1650, BIG);
    s.ss = 2;
    s.sigma = 0.8;
    s.noise = (1e-4, 5e-6);
    assert!(ruling::detect(&s.render(), &Warp::flat(BIG), A4_MM.0, A4_MM.1).is_none());
}

#[test]
fn masks_a_pen_lying_on_the_sheet_but_not_the_ruling() {
    let mut s = notebook(false, 25.0);
    let m = square_to_quad(&BIG);
    let on = |x: f64, y: f64| apply(&m, [x / A4_MM.0, y / A4_MM.1]);
    s.strokes.push((on(60.0, 150.0), on(150.0, 200.0), 36.0, [0.15, 0.18, 0.35]));
    let photo = s.render();
    let mask = mask::object_mask(&photo, &BIG, A4_MM.0, A4_MM.1, 2);
    let at = |p: Pt| mask.data[(p[1] as usize / 2) * mask.w + p[0] as usize / 2];
    assert_eq!(mask.objects, 1);
    assert!(at(on(105.0, 175.0)) < 60, "on the pen: {}", at(on(105.0, 175.0)));
    // A ruled line far from the pen stays paper.
    assert_eq!(at(on(150.0, 13.3 + 8.0 * 20.0 + 150.0 * 0.008)), 255);
    assert_eq!(at(on(40.0, 60.0)), 255);
}

/// A curved notebook sheet: the true warp (bowed sides, and a sag in the
/// middle the edges do not show), its outline, lines every 8 mm through it.
fn curved_notebook(bulge: [[f64; 4]; 4], sag: f64) -> (Scene, Warp) {
    let mut grid = crate::warp::Grid::zero(5, 7);
    for j in 0..7 {
        for i in 0..5 {
            grid.d[j * 5 + i] = [0.0, sag * (std::f64::consts::PI * i as f64 / 4.0).sin() * (std::f64::consts::PI * j as f64 / 6.0).sin()];
        }
    }
    let truth = Warp { corners: BIG, bulge: Some(bulge), grid: Some(grid) };
    let m = truth.map();
    let mut outline = Vec::new();
    for k in 0..4 {
        for i in 0..200 {
            let t = i as f64 / 200.0;
            let (u, v) = match k {
                0 => (t, 0.0),
                1 => (1.0, t),
                2 => (1.0 - t, 1.0),
                _ => (0.0, 1.0 - t),
            };
            outline.push(m.at(u, v));
        }
    }
    let mut s = Scene::new(1400, 1650, BIG);
    s.ss = 2;
    s.sigma = 0.8;
    s.noise = (1e-4, 5e-6);
    s.outline = Some(outline);
    let (w, h) = A4_MM;
    let mut y = 13.3;
    while y < h {
        let mut x = 0.0;
        while x < w {
            let x2 = (x + 3.0).min(w);
            s.strokes.push((m.at(x / w, y / h), m.at(x2 / w, y / h), 1.6, [0.62, 0.74, 0.95]));
            x = x2;
        }
        y += 8.0;
    }
    (s, truth)
}

#[test]
fn follows_curved_edges() {
    let bulge = [[0.0, 10.0, -10.0, 0.0], [0.0, -16.0, 16.0, 0.0], [0.0, 12.0, -12.0, 0.0], [0.0; 4]];
    let (mut s, _) = curved_notebook(bulge, 0.0);
    s.strokes.clear();
    let photo = s.render();
    let rough = [[203.0, 147.0], [1147.0, 193.0], [1203.0, 1497.0], [157.0, 1463.0]];
    let c = edges::curved_sides(&photo, rough);
    assert!(c.fitted.iter().all(|&f| f), "{:?}", c.fitted);
    assert!(worst(&c.corners, &BIG) < 0.5, "{:?}", c.corners);
    for k in 0..4 {
        for t in [0.25, 0.5, 0.75] {
            let (got, want) = (crate::warp::poly(&c.bulge[k], t), crate::warp::poly(&bulge[k], t));
            assert!((got - want).abs() < 0.5, "side {k} at {t}: {got} vs {want}");
        }
    }
    assert!((c.max - 4.0).abs() < 0.5, "max {}", c.max);
}

#[test]
fn straightens_a_sagging_page_by_its_lines() {
    let bulge = [[0.0, 10.0, -10.0, 0.0], [0.0; 4], [0.0, 8.0, -8.0, 0.0], [0.0; 4]];
    let (s, truth) = curved_notebook(bulge, 9.0);
    let photo = s.render();
    // As the dialog does it: curved edges, the lines, then the bend from the lines.
    let c = edges::curved_sides(&photo, BIG);
    let warp = Warp { corners: c.corners, bulge: Some(c.bulge), grid: None };
    let r = ruling::detect(&photo, &warp, A4_MM.0, A4_MM.1).expect("ruling");
    let b = ruling::bend(&photo, &warp, A4_MM.0, A4_MM.1, r.step, r.offset, r.slope, 5, 7);
    assert!(b.before > 0.4, "the page sags: {} mm", b.before);
    assert!(b.after < 0.15, "after: {} mm (before {})", b.after, b.before);
    // What the text is laid onto: the lines found again on the straightened
    // sheet must run where the ruling found there says, all over it.
    let fixed = Warp { grid: Some(b.grid.clone()), ..warp };
    let r2 = ruling::detect(&photo, &fixed, A4_MM.0, A4_MM.1).expect("ruling after");
    let m = ruling::line_residuals(&photo, &fixed.map(), A4_MM.0, A4_MM.1, r2.step, r2.offset, r2.slope);
    let worst = m.iter().map(|e| e.2.abs()).fold(0.0, f64::max);
    let rms = (m.iter().map(|e| e.2 * e.2).sum::<f64>() / m.len() as f64).sqrt();
    assert!(m.len() > 300 && rms < 0.15 && worst < 0.5, "{} points, rms {rms} mm, worst {worst} mm", m.len());
    let _ = truth;
}

#[test]
fn grey_margins_on_both_sides_and_paper_wider_than_a4() {
    // A 230-mm notebook sheet (a spiral strip) taken for A4: squares come out
    // narrow, and their real size gives the paper's width back.
    let grey = [0.45, 0.45, 0.47];
    let photo = notebook_on((230.0, 297.0), true, &[(32.0, grey, 2.6), (198.0, grey, 2.6)]).render();
    let r = ruling::detect(&photo, &Warp::flat(BIG), A4_MM.0, A4_MM.1).expect("ruling");
    assert_eq!(r.kind, "grid");
    let cols = r.col_step.expect("columns");
    assert!((r.step - 5.0).abs() < 0.05 && (cols - 5.0 * 210.0 / 230.0).abs() < 0.05, "rows {} cols {cols}", r.step);
    let width = A4_MM.0 * 5.0 / cols;
    assert!((width - 230.0).abs() < 1.5, "width {width}");
    // Read again on the real size: square squares, margins where they are.
    let r = ruling::detect(&photo, &Warp::flat(BIG), 230.0, 297.0).expect("ruling");
    assert!(r.col_step.is_some_and(|c| (c - 5.0).abs() < 0.05), "{:?}", r.col_step);
    let m = &r.margins;
    assert!(m.left.is_some_and(|x| (x - 32.0).abs() < 0.5), "{m:?}");
    assert!(m.right.is_some_and(|x| (x - 198.0).abs() < 0.5), "{m:?}");
}

#[test]
fn finds_a_squared_sheet_on_a_white_desk() {
    // The desk lighter than the paper: no bright region to find, the squares tell.
    let mut s = notebook_on(A4_MM, true, &[]);
    s.desk = [0.92, 0.92, 0.93];
    s.paper = [0.74, 0.73, 0.69];
    s.falloff = 0.1;
    let photo = s.render();
    let f = crate::find(&photo).expect("sheet");
    assert!(!f.scan);
    assert!(f.snapped.iter().filter(|&&b| b).count() >= 3, "{:?}", f.snapped);
    assert!(worst(&f.corners, &BIG) < 1.0, "{:?}", f.corners);
    // A straight sheet with squares up to its edges does not bend.
    let c = edges::curved_sides(&photo, f.corners);
    assert!(c.max < 1.5, "false bend {} px ({:?})", c.max, c.fitted);
}

#[test]
fn a_scan_is_the_whole_frame() {
    let frame = [[0.0, 0.0], [1400.0, 0.0], [1400.0, 1650.0], [0.0, 1650.0]];
    let mut s = notebook_on(A4_MM, true, &[]);
    s.quad = frame;
    // The squares as drawn on BIG would not reach the frame: draw them over the whole frame.
    s.strokes.clear();
    let m = square_to_quad(&frame);
    let on = |x: f64, y: f64| crate::quad::apply(&m, [x / 210.0, y / 297.0]);
    let mut y = 2.0;
    while y < 297.0 {
        s.strokes.push((on(0.0, y), on(210.0, y), 1.6, [0.62, 0.74, 0.95]));
        y += 5.0;
    }
    let mut x = 2.0;
    while x < 210.0 {
        s.strokes.push((on(x, 0.0), on(x, 297.0), 1.6, [0.62, 0.74, 0.95]));
        x += 5.0;
    }
    let f = crate::find(&s.render()).expect("sheet");
    assert!(f.scan, "{f:?}");
    assert!(worst(&f.corners, &frame) < 1e-9);
}

/// A real photo of the local tests (fixtures/real, kept out of git), or None.
fn real(name: &str) -> Option<Photo> {
    let path = format!("{}/fixtures/real/{name}", env!("CARGO_MANIFEST_DIR"));
    let img = image::open(&path).ok()?.to_rgba8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    Some(Photo::new(img.into_raw(), w, h))
}

/// The paper's size by its 5-mm squares (read first as A4), and the ruling read again on it.
fn by_squares(p: &Photo, warp: &Warp) -> ((f64, f64), ruling::Ruling) {
    let r = ruling::detect(p, warp, 210.0, 297.0).expect("ruling");
    assert_eq!(r.kind, "grid");
    let size = (210.0 * 5.0 / r.col_step.expect("columns"), 297.0 * 5.0 / r.step);
    (size, ruling::detect(p, warp, size.0, size.1).expect("ruling on the real size"))
}

#[test]
fn reads_a_real_scan() {
    // A scanned Oxford A4+ notebook page: squares to every border, a grey
    // margin line on the left, a perforation on the right before the spiral.
    let Some(p) = real("scan.jpg") else { return };
    let f = crate::find(&p).expect("sheet");
    assert!(f.scan, "{f:?}");
    let c = edges::curved_sides(&p, f.corners);
    assert!(c.max < 2.0, "false bend {} px", c.max);
    let ((w, h), r) = by_squares(&p, &Warp::flat(f.corners));
    assert!((w - 220.6).abs() < 2.0 && (h - 303.0).abs() < 3.0, "{w} x {h}");
    assert!((r.step - 5.0).abs() < 0.05 && r.col_step.is_some_and(|c| (c - 5.0).abs() < 0.05), "{r:?}");
    let m = &r.margins;
    assert!(m.left.is_some_and(|x| (x - 32.8).abs() < 1.0), "{m:?}");
    assert!(m.right.is_some_and(|x| (x - 183.1).abs() < 1.5), "{m:?}");
    assert!(m.top.is_none() && m.bottom.is_none(), "{m:?}");
}

#[test]
fn reads_a_real_photo() {
    // The same notebook photographed on a white desk: a stack of pages on the
    // left, the spiral on the right, a black mat behind part of the top, the
    // top page bowing up.
    let Some(p) = real("photo.jpg") else { return };
    let f = crate::find(&p).expect("sheet");
    assert!(!f.scan && f.snapped.iter().all(|&s| s), "{f:?}");
    // Corners as marked by eye (the left one on the top page, the right ones at the spiral's end).
    let truth = [[192.0, 272.0], [1240.0, 258.0], [1345.0, 1755.0], [88.0, 1778.0]];
    for k in 0..4 {
        assert!(dist(f.corners[k], truth[k]) < 25.0, "corner {k}: {:?}", f.corners);
    }
    let ((w, h), r) = by_squares(&p, &Warp::flat(f.corners));
    assert!((w - 221.0).abs() < 3.0 && (h - 301.0).abs() < 4.0, "{w} x {h}");
    assert!((r.step - 5.0).abs() < 0.05 && r.col_step.is_some_and(|c| (c - 5.0).abs() < 0.05), "{r:?}");
    // The margins are the scan's: 150 mm apart.
    let m = &r.margins;
    let (Some(l), Some(rt)) = (m.left, m.right) else { panic!("{m:?}") };
    assert!((l - 33.5).abs() < 2.5 && (rt - l - 150.3).abs() < 4.0, "{m:?}");
    let s = measure(&p, &f.corners, f.snapped);
    assert!(s.reliable && s.sigma.is_some_and(|x| x < 2.0), "{:?}", s.sigma);
}

/// Saves the photo with a quadrilateral drawn on it (scratch files for looking at results).
fn save_overlay(p: &Photo, quads: &[([Pt; 4], [u8; 3])], path: &str) {
    let mut img = image::RgbImage::new(p.w as u32, p.h as u32);
    for y in 0..p.h {
        for x in 0..p.w {
            img.put_pixel(x as u32, y as u32, image::Rgb([p.byte(x, y, 0), p.byte(x, y, 1), p.byte(x, y, 2)]));
        }
    }
    for (q, color) in quads {
        for k in 0..4 {
            let (a, b) = (q[k], q[(k + 1) % 4]);
            let n = (dist(a, b) as usize).max(1);
            for i in 0..=n {
                let t = i as f64 / n as f64;
                let (x, y) = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
                for (dx, dy) in [(0, 0), (1, 0), (0, 1), (-1, 0), (0, -1)] {
                    let (xx, yy) = (x as i64 + dx, y as i64 + dy);
                    if xx >= 0 && yy >= 0 && (xx as usize) < p.w && (yy as usize) < p.h {
                        img.put_pixel(xx as u32, yy as u32, image::Rgb(*color));
                    }
                }
            }
        }
    }
    img.save(path).expect("save");
}

/// Draws what was found on the real photo, to look at: run with DESK_OVERLAY_DIR set.
#[test]
fn real_overlay() {
    let Ok(dir) = std::env::var("DESK_OVERLAY_DIR") else { return };
    let Some(p) = real("photo.jpg") else { return };
    let b = sheet::find_by_lines(&p).unwrap();
    let f = crate::find(&p).unwrap();
    let path = format!("{dir}/photo_found.jpg");
    // The margins found on the paper's size by its squares, as thin quads.
    let w = Warp::flat(f.corners);
    let r = ruling::detect(&p, &w, 210.0, 297.0).unwrap();
    let (wm, hm) = (210.0 * 5.0 / r.col_step.unwrap(), 297.0 * 5.0 / r.step);
    let r = ruling::detect(&p, &w, wm, hm).unwrap();
    let map = w.map();
    let mut quads = vec![(b.found.corners, [255, 140, 0]), (f.corners, [0, 200, 255])];
    for x in [r.margins.left, r.margins.right].into_iter().flatten() {
        let u = x / wm;
        quads.push(([map.at(u, 0.0), map.at(u + 0.0005, 0.0), map.at(u + 0.0005, 1.0), map.at(u, 1.0)], [255, 0, 80]));
    }
    save_overlay(&p, &quads, &path);
    // The corners up close.
    let img = image::open(&path).unwrap().to_rgb8();
    for (k, c) in f.corners.iter().enumerate() {
        let (x, y) = ((c[0] as i64 - 160).clamp(0, p.w as i64 - 320) as u32, (c[1] as i64 - 160).clamp(0, p.h as i64 - 320) as u32);
        let crop = image::imageops::crop_imm(&img, x, y, 320, 320).to_image();
        image::imageops::resize(&crop, 640, 640, image::imageops::FilterType::Nearest).save(format!("{dir}/corner{k}.jpg")).unwrap();
    }
}
