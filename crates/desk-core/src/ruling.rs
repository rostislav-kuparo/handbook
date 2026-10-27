//! The printed lines of a notebook sheet: ruled or squared, their step and
//! where they run, how they lean against the cut of the sheet, and the red
//! margin line — so the text can be laid onto them.

use serde::Serialize;

use crate::img::Photo;
use crate::warp::{Grid, Warp, WarpMap};

/// Resolution of the straightened sheet the lines are read on.
const PX_PER_MM: f64 = 4.0;

/// Margin lines: vertical ones where they cross the top edge (mm from the
/// left), horizontal ones where they cross the left edge (mm from the top).
#[derive(Serialize, Debug, Clone, Default)]
pub struct Margins {
    pub left: Option<f64>,
    pub right: Option<f64>,
    pub top: Option<f64>,
    pub bottom: Option<f64>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Ruling {
    /// "ruled" or "grid".
    pub kind: &'static str,
    /// Distance between neighbouring horizontal lines, mm.
    pub step: f64,
    /// Squares: distance between neighbouring vertical lines, mm. Squares are
    /// square, so the two tell the paper's real width from the assumed one.
    pub col_step: Option<f64>,
    /// Horizontal lines run at y = offset + k·step + x·slope (mm from the sheet's top-left corner).
    pub offset: f64,
    pub slope: f64,
    /// Squares: vertical lines at x = colOffset + k·colStep − y·slope.
    pub col_offset: Option<f64>,
    pub margins: Margins,
    /// How much darker the lines are than the paper (0..1).
    pub strength: f64,
}

/// The sheet seen straight on, `PX_PER_MM` pixels per millimetre, linear red and green.
struct Flat {
    w: usize,
    h: usize,
    r: Vec<f32>,
    g: Vec<f32>,
}

fn flatten(photo: &Photo, warp: &WarpMap, w_mm: f64, h_mm: f64) -> Flat {
    let (w, h) = ((w_mm * PX_PER_MM) as usize, (h_mm * PX_PER_MM) as usize);
    let mut r = vec![0f32; w * h];
    let mut g = vec![0f32; w * h];
    for j in 0..h {
        for i in 0..w {
            let [x, y] = warp.at((i as f64 + 0.5) / w as f64, (j as f64 + 0.5) / h as f64);
            r[j * w + i] = photo.lin_at(x, y, 0);
            g[j * w + i] = photo.lin_at(x, y, 1);
        }
    }
    Flat { w, h, r, g }
}

/// Linear interpolation of `v` at a fractional index; None outside.
fn lerp_at(v: &[f64], x: f64) -> Option<f64> {
    if x < 0.0 || x > (v.len() - 1) as f64 {
        return None;
    }
    let i = x.floor() as usize;
    let t = x - i as f64;
    Some(if i + 1 < v.len() { v[i] * (1.0 - t) + v[i + 1] * t } else { v[i] })
}

/// Mean of `img` along lines leaning by `slope` — rows (`horizontal`, one
/// value per row) or columns (one per column) — over a part of the width
/// (rows) or height (columns), as fractions.
fn profile_over(img: &[f32], w: usize, h: usize, slope: f64, horizontal: bool, every: usize, (f0, f1): (f64, f64)) -> Vec<f64> {
    let (n, across) = if horizontal { (h, w) } else { (w, h) };
    let (a0, a1) = ((across as f64 * f0) as usize, (across as f64 * f1) as usize);
    let mut out = vec![0.0; n];
    for (k, slot) in out.iter_mut().enumerate() {
        let (mut sum, mut cnt) = (0.0, 0.0);
        for a in (a0..a1).step_by(every) {
            // Rows: y = k + x·slope; columns: x = k − y·slope.
            let pos = if horizontal { k as f64 + a as f64 * slope } else { k as f64 - a as f64 * slope };
            if pos < 0.0 || pos > (n - 1) as f64 {
                continue;
            }
            let i = pos.floor() as usize;
            let t = (pos - i as f64) as f32;
            let i1 = (i + 1).min(n - 1);
            let at = |p: usize| if horizontal { img[p * w + a] } else { img[a * w + p] };
            sum += (at(i) * (1.0 - t) + at(i1) * t) as f64;
            cnt += 1.0;
        }
        *slot = if cnt > 0.0 { sum / cnt } else { 0.0 };
    }
    out
}

/// How much darker than the paper around: 1 − v / (running median over `win`).
fn darkness(v: &[f64], win: usize) -> Vec<f64> {
    let n = v.len();
    (0..n)
        .map(|i| {
            let (a, b) = (i.saturating_sub(win / 2), (i + win / 2 + 1).min(n));
            let mut s: Vec<f64> = v[a..b].to_vec();
            s.sort_by(|x, y| x.partial_cmp(y).unwrap());
            let med = s[s.len() / 2].max(1e-6);
            1.0 - v[i] / med
        })
        .collect()
}

/// A darkness profile with only what printed lines can be: the outer 2 % (a
/// strip of desk when the corners sit a little outside) left out, and
/// anything far darker than a line (a shadow, an object) capped.
fn lines_only(d: &[f64]) -> Vec<f64> {
    let n = d.len();
    let edge = n / 50;
    d.iter().enumerate().map(|(i, &v)| if i < edge || i + edge >= n { 0.0 } else { v.clamp(-0.1, 0.35) }).collect()
}

/// Period of a profile of thin lines, px: the lag of the autocorrelation peak
/// (the shortest of the near-best, not a multiple), and how strong it is.
fn period(d: &[f64], min: usize, max: usize) -> Option<(f64, f64)> {
    let n = d.len();
    let mean = d.iter().sum::<f64>() / n as f64;
    let c: Vec<f64> = d.iter().map(|v| v - mean).collect();
    let var: f64 = c.iter().map(|v| v * v).sum();
    if var < 1e-12 || max + 2 >= n {
        return None;
    }
    let ac: Vec<f64> = (0..=max + 1).map(|l| (0..n - l).map(|i| c[i] * c[i + l]).sum::<f64>() / var).collect();
    let best = (min..=max).map(|l| ac[l]).fold(f64::NEG_INFINITY, f64::max);
    if best < 0.25 {
        return None;
    }
    let l = (min..=max).find(|&l| ac[l] >= 0.8 * best && ac[l] >= ac[l - 1] && ac[l] >= ac[l + 1])?;
    let (a, b, cc) = (ac[l - 1], ac[l], ac[l + 1]);
    let den = a - 2.0 * b + cc;
    let delta = if den.abs() > 1e-12 { ((a - cc) / (2.0 * den)).clamp(-0.5, 0.5) } else { 0.0 };
    Some((l as f64 + delta, ac[l]))
}

/// Step and phase of a comb of lines on the profile, refined near `step0`.
fn comb(d: &[f64], step0: f64) -> (f64, f64, f64) {
    let mut best = (f64::NEG_INFINITY, step0, 0.0);
    for si in -40..=40 {
        let step = step0 * (1.0 + si as f64 * 0.0005);
        let phases = (step * 10.0) as usize;
        for pi in 0..phases {
            let phase = pi as f64 / 10.0;
            let (mut sum, mut cnt) = (0.0f64, 0.0f64);
            let mut y = phase;
            while y <= (d.len() - 1) as f64 {
                if let Some(v) = lerp_at(d, y) {
                    sum += v;
                    cnt += 1.0;
                }
                y += step;
            }
            let score = sum / cnt.max(1.0);
            if score > best.0 {
                best = (score, step, phase);
            }
        }
    }
    (best.1, best.2, best.0)
}

/// Phase of a comb with a known step on the profile.
fn comb_phase(d: &[f64], step: f64) -> f64 {
    let mut best = (f64::NEG_INFINITY, 0.0);
    for pi in 0..(step * 20.0) as usize {
        let phase = pi as f64 / 20.0;
        let (mut sum, mut y) = (0.0, phase);
        while y <= (d.len() - 1) as f64 {
            sum += lerp_at(d, y).unwrap_or(0.0);
            y += step;
        }
        if sum > best.0 {
            best = (sum, phase);
        }
    }
    best.1
}

/// The lean of the lines, refined: the same lines read on the left and on the
/// right part of the sheet are shifted by (lean error) × (distance between the parts).
fn refine_slope(img: &[f32], w: usize, h: usize, slope: f64, step: f64) -> f64 {
    let win = (15.0 * PX_PER_MM) as usize | 1;
    let mut s = slope;
    for _ in 0..3 {
        let phase = |part: (f64, f64)| comb_phase(&lines_only(&darkness(&profile_over(img, w, h, s, true, 1, part), win)), step);
        let gap = (phase((0.55, 0.9)) - phase((0.1, 0.45))).rem_euclid(step);
        let gap = if gap > step / 2.0 { gap - step } else { gap };
        s += gap / (0.45 * w as f64);
    }
    s
}

/// Lines of `img` leaning by `slope`: (step, phase, strength) in px, if periodic.
fn lines(img: &[f32], w: usize, h: usize, slope: f64, horizontal: bool) -> Option<(f64, f64, f64)> {
    lines_over(img, w, h, slope, horizontal, (0.12, 0.88))
}

/// The same, read over a part of the width (rows) or height (columns).
fn lines_over(img: &[f32], w: usize, h: usize, slope: f64, horizontal: bool, band: (f64, f64)) -> Option<(f64, f64, f64)> {
    let p = profile_over(img, w, h, slope, horizontal, 2, band);
    let d = lines_only(&darkness(&p, (15.0 * PX_PER_MM) as usize | 1));
    let (lag, _) = period(&d, (3.0 * PX_PER_MM) as usize, (13.0 * PX_PER_MM) as usize)?;
    Some(comb(&d, lag))
}

/// A line across one direction that may be a margin: where (px along the
/// profile), how dark, how many times darker than the printed lines around
/// it, how wide at half its darkness (mm), how red.
#[derive(Debug, Clone, Copy)]
struct MarginLine {
    at: f64,
    dark: f64,
    ratio: f64,
    width: f64,
    red: f64,
}

impl MarginLine {
    /// How much it looks like a margin: a red line (green darkens, red does
    /// not); a thin line clearly darker than the printed lines around it; or a
    /// wider, fainter one still darker — a perforation to tear the page off
    /// along. A spiral's holes or a shadow are wider still.
    fn score(&self) -> Option<f64> {
        if self.red >= 0.03 {
            return Some(10.0 * self.red + self.dark);
        }
        if self.dark < 0.02 {
            return None;
        }
        if self.width < 1.5 {
            (self.ratio >= 1.25).then_some(self.ratio)
        } else if self.width < 4.0 {
            (self.ratio >= 1.4).then_some(0.9 * self.ratio)
        } else {
            None
        }
    }
}

/// The lines across one direction (and the profile's length, px).
fn margin_candidates(flat: &Flat, ink: &[f32], slope: f64, vertical: bool) -> (Vec<MarginLine>, usize) {
    let (w, h) = (flat.w, flat.h);
    let win = (10.0 * PX_PER_MM) as usize | 1;
    let prof = |img: &[f32]| darkness(&profile_over(img, w, h, slope, !vertical, 2, (0.05, 0.95)), win);
    let dark = prof(ink);
    let (r, g) = (prof(&flat.r), prof(&flat.g));
    let red: Vec<f64> = g.iter().zip(&r).map(|(g, r)| g - r).collect();
    let n = dark.len();
    let peak = |v: &[f64], i: usize, floor: f64| v[i] >= floor && (1..=3).all(|k| v[i] >= v[i - k] && v[i] >= v[i + k]);
    let peaks: Vec<usize> = (3..n - 3).filter(|&i| peak(&dark, i, 0.01)).collect();
    let around = (25.0 * PX_PER_MM) as usize;
    // How wide a line is at half its darkness, mm.
    let width = |i: usize| {
        let half = dark[i] / 2.0;
        let (mut a, mut b) = (i, i);
        while a > 0 && dark[a - 1] > half {
            a -= 1;
        }
        while b + 1 < n && dark[b + 1] > half {
            b += 1;
        }
        (b - a + 1) as f64 / PX_PER_MM
    };
    let thin = |i: usize| width(i) < 1.5;
    // How dark the printed lines around are (±25 mm — a scan or a lamp may
    // darken one part of the sheet): the upper quartile of the thin ones (a
    // spiral's holes next to the margin are not lines); with no lines this way, a trace.
    let local = |i: usize| {
        let mut near: Vec<f64> = peaks.iter().filter(|&&j| j != i && j.abs_diff(i) <= around && thin(j)).map(|&j| dark[j]).collect();
        near.sort_by(|a, b| a.partial_cmp(b).unwrap());
        near.get(near.len() * 3 / 4).copied().unwrap_or(0.0).max(0.01)
    };
    let lines = (3..n - 3)
        .filter(|&i| peaks.binary_search(&i).is_ok() || peak(&red, i, 0.03))
        .map(|i| {
            let (a, b, c) = (dark[i - 1], dark[i], dark[i + 1]);
            let den = a - 2.0 * b + c;
            let delta = if den.abs() > 1e-12 { ((a - c) / (2.0 * den)).clamp(-0.5, 0.5) } else { 0.0 };
            MarginLine { at: i as f64 + delta, dark: dark[i], ratio: dark[i] / local(i), width: width(i), red: red[i] }
        })
        .collect();
    (lines, n)
}

/// Margin lines across one direction: one per band (fractions of the
/// profile), the most standing out; px along the profile.
fn margin_lines(flat: &Flat, ink: &[f32], slope: f64, vertical: bool, bands: [(f64, f64); 2]) -> [Option<f64>; 2] {
    let (lines, n) = margin_candidates(flat, ink, slope, vertical);
    bands.map(|(a, b)| {
        let (lo, hi) = (a * n as f64, b * n as f64);
        lines
            .iter()
            .filter(|l| l.at >= lo && l.at <= hi)
            .filter_map(|l| l.score().map(|s| (l.at, s)))
            .fold(None::<(f64, f64)>, |best, c| if best.is_none_or(|b| c.1 > b.1) { Some(c) } else { best })
            .map(|b| b.0)
    })
}

/// Margin lines on all four sides, mm.
fn margins(flat: &Flat, ink: &[f32], slope: f64) -> Margins {
    let mm = |px: Option<f64>| px.map(|p| (p + 0.5) / PX_PER_MM);
    let [left, right] = margin_lines(flat, ink, slope, true, [(0.03, 0.45), (0.55, 0.95)]);
    let [top, bottom] = margin_lines(flat, ink, slope, false, [(0.02, 0.22), (0.78, 0.98)]);
    Margins { left: mm(left), right: mm(right), top: mm(top), bottom: mm(bottom) }
}

/// The printed lines of the sheet laid out by `warp` (`w_mm`×`h_mm` paper), or None on blank paper.
pub fn detect(photo: &Photo, warp: &Warp, w_mm: f64, h_mm: f64) -> Option<Ruling> {
    let flat = flatten(photo, &warp.map(), w_mm, h_mm);
    let (w, h) = (flat.w, flat.h);
    // Blue and grey ruling darkens red and green alike; the red margin only green.
    let ink: Vec<f32> = flat.r.iter().zip(&flat.g).map(|(r, g)| (r + g) / 2.0).collect();

    // The lean that makes the row profile sharpest: coarse, then fine.
    let sharpness = |slope: f64, band: (f64, f64)| {
        let d = lines_only(&darkness(&profile_over(&ink, w, h, slope, true, 4, band), (15.0 * PX_PER_MM) as usize | 1));
        d.iter().map(|v| v * v).sum::<f64>()
    };
    // Across the whole width; on a page that sags the lines bend and smear, so
    // then in a narrow band where they are still nearly straight.
    let (coarse, step0, band) = [(0.12, 0.88), (0.38, 0.62), (0.12, 0.36), (0.64, 0.88)].into_iter().find_map(|band| {
        let coarse = (-30..=30).map(|i| i as f64 * 0.001).fold((0.0, f64::NEG_INFINITY), |b, s| {
            let v = sharpness(s, band);
            if v > b.1 { (s, v) } else { b }
        }).0;
        lines_over(&ink, w, h, coarse, true, band).filter(|l| l.2 >= 0.015).map(|l| (coarse, l.0, band))
    })?;
    let slope = refine_slope(&ink, w, h, coarse, step0);

    let (step, phase, strength) = lines_over(&ink, w, h, slope, true, band)?;
    if strength < 0.015 {
        return None;
    }
    // Squares: columns with the same step.
    // Squares: columns at a similar step (squares may come out oblong when the paper's size is guessed wrong).
    let cols = lines(&ink, w, h, slope, false).filter(|&(s, _, k)| (s / step - 1.0).abs() < 0.25 && k > 0.4 * strength);
    let grid = cols.is_some();
    // Pixel centres sit at +0.5.
    let offset = (phase + 0.5) / PX_PER_MM;
    Some(Ruling {
        kind: if grid { "grid" } else { "ruled" },
        step: step / PX_PER_MM,
        col_step: cols.map(|(s, _, _)| s / PX_PER_MM),
        offset,
        slope,
        col_offset: cols.map(|(_, p, _)| (p + 0.5) / PX_PER_MM),
        margins: margins(&flat, &ink, slope),
        strength,
    })
}

/// Where each printed line really runs on the straightened sheet, against
/// where the ruling says it should: (u, v, how far lower it is, mm), in 16
/// blocks across every line.
pub(crate) fn line_residuals(photo: &Photo, warp: &WarpMap, w_mm: f64, h_mm: f64, step: f64, offset: f64, slope: f64) -> Vec<(f64, f64, f64)> {
    let flat = flatten(photo, warp, w_mm, h_mm);
    let (w, h) = (flat.w, flat.h);
    let ink: Vec<f32> = flat.r.iter().zip(&flat.g).map(|(r, g)| (r + g) / 2.0).collect();
    let blocks = 16;
    let half = w_mm * 0.84 / blocks as f64 / 2.0;
    let mut out = Vec::new();
    let mut k = 0;
    while offset + k as f64 * step < h_mm + w_mm * slope.abs() {
        for b in 0..blocks {
            let xc = w_mm * (0.08 + 0.84 * (b as f64 + 0.5) / blocks as f64);
            let ye = offset + k as f64 * step + xc * slope;
            if ye < 5.0 || ye > h_mm - 5.0 {
                continue;
            }
            // Mean across the block, along y over ±0.45 step around the expected line.
            let win = 0.45 * step * PX_PER_MM;
            let n = (2.0 * win / 0.25) as usize;
            let (x0, x1) = (((xc - half) * PX_PER_MM) as usize, (((xc + half) * PX_PER_MM) as usize).min(w - 1));
            let prof: Vec<f64> = (0..=n)
                .map(|i| {
                    let y = ye * PX_PER_MM - 0.5 - win + i as f64 * 0.25;
                    let (j, t) = (y.floor().clamp(0.0, (h - 2) as f64) as usize, (y - y.floor()) as f32);
                    let s: f32 = (x0..=x1).map(|x| ink[j * w + x] * (1.0 - t) + ink[(j + 1) * w + x] * t).sum();
                    (s / (x1 - x0 + 1) as f32) as f64
                })
                .collect();
            let mut sorted = prof.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let paper = sorted[sorted.len() * 3 / 4].max(1e-6);
            let d: Vec<f64> = prof.iter().map(|v| 1.0 - v / paper).collect();
            let (im, dm) = d.iter().enumerate().fold((0, f64::NEG_INFINITY), |a, (i, &v)| if v > a.1 { (i, v) } else { a });
            if dm < 0.03 || im < 2 || im + 2 >= d.len() {
                continue;
            }
            let (a, bb, c) = (d[im - 1], d[im], d[im + 1]);
            let den = a - 2.0 * bb + c;
            let delta = if den.abs() > 1e-12 { ((a - c) / (2.0 * den)).clamp(-0.5, 0.5) } else { 0.0 };
            let y = (-win + (im as f64 + delta) * 0.25) / PX_PER_MM;
            out.push((xc / w_mm, ye / h_mm, y));
        }
        k += 1;
    }
    out
}

/// Takes away the best plane a + b·u + c·v: the ruling's own offset, step and lean already account for it.
fn without_plane(m: &mut [(f64, f64, f64)]) {
    let mut a = [[0.0; 4]; 3];
    for &(u, v, r) in m.iter() {
        let p = [1.0, u, v];
        for i in 0..3 {
            for j in 0..3 {
                a[i][j] += p[i] * p[j];
            }
            a[i][3] += p[i] * r;
        }
    }
    for col in 0..3 {
        let Some(piv) = (col..3).max_by(|&i, &j| a[i][col].abs().partial_cmp(&a[j][col].abs()).unwrap()) else { return };
        if a[piv][col].abs() < 1e-12 {
            return;
        }
        a.swap(col, piv);
        for r in 0..3 {
            if r != col {
                let k = a[r][col] / a[col][col];
                for c in col..4 {
                    a[r][c] -= k * a[col][c];
                }
            }
        }
    }
    let c: [f64; 3] = std::array::from_fn(|i| a[i][3] / a[i][i]);
    for e in m.iter_mut() {
        e.2 -= c[0] + c[1] * e.0 + c[2] * e.1;
    }
}

#[derive(serde::Serialize, Debug)]
pub struct Bend {
    pub grid: Grid,
    /// How far the printed lines strayed from straight, mm (RMS): before and after.
    pub before: f64,
    pub after: f64,
}

/// A curved sheet straightened by its own printed lines: wherever a line runs
/// lower or higher than the ruling says, the warp is moved so it runs true.
pub fn bend(photo: &Photo, warp: &Warp, w_mm: f64, h_mm: f64, step: f64, offset: f64, slope: f64, nx: usize, ny: usize) -> Bend {
    let mut cur = warp.clone();
    if cur.grid.as_ref().is_none_or(|g| g.nx != nx || g.ny != ny) {
        cur.grid = Some(Grid::zero(nx, ny));
    }
    let rms = |m: &[(f64, f64, f64)]| (m.iter().map(|e| e.2 * e.2).sum::<f64>() / m.len().max(1) as f64).sqrt();
    let mut before = f64::NAN;
    for round in 0..4 {
        let map = cur.map();
        let mut m = line_residuals(photo, &map, w_mm, h_mm, step, offset, slope);
        if m.len() < 24 {
            break;
        }
        without_plane(&mut m);
        if round == 0 {
            before = rms(&m);
        }
        if round == 3 {
            return Bend { grid: cur.grid.unwrap(), before, after: rms(&m) };
        }
        // Each node takes the residuals around it, smoothly weighted.
        let (su, sv) = (0.6 / (nx - 1) as f64, 0.6 / (ny - 1) as f64);
        let mut grid = cur.grid.clone().unwrap();
        for j in 0..ny {
            for i in 0..nx {
                let (u, v) = (i as f64 / (nx - 1) as f64, j as f64 / (ny - 1) as f64);
                let (mut sw, mut sr) = (0.0, 0.0);
                for &(mu, mv, r) in &m {
                    let w = (-0.5 * (((mu - u) / su).powi(2) + ((mv - v) / sv).powi(2))).exp();
                    sw += w;
                    sr += w * r.clamp(-0.4 * step, 0.4 * step);
                }
                if sw < 2.0 {
                    continue;
                }
                let r = sr / sw;
                // The line shows `r` mm lower: the sheet's point (u, v) is really where (u, v + r) was mapped.
                let (a, b) = (map.at(u, v), map.at(u, v + r / h_mm));
                let d = &mut grid.d[j * nx + i];
                d[0] += b[0] - a[0];
                d[1] += b[1] - a[1];
            }
        }
        cur.grid = Some(grid);
    }
    Bend { grid: cur.grid.unwrap_or(Grid::zero(nx, ny)), before, after: before }
}
