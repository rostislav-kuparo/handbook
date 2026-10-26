//! Turning recorded samples into an endless supply of letter variants.
//!
//! 1. `prepare`    – clean up a raw sample (dedupe, pressure, smoothing, resampling).
//! 2. `synthesize` – take a recorded variant or draw a new one from the learned
//!    shape model, apply natural jitter and snap entry/exit onto their join line
//!    (low, near the baseline, or high, at the x-height).
//! 3. `adapt_entry` – rewrite the start of a letter so it joins a neighbour that
//!    leaves at the other height (after "о" the next letter starts at the top).
//!    `stretch_entry` lengthens the lead-in when two joined letters would collide.
//! 4. `place`      – compute the glyph origin and advance so that the exit of one
//!    letter lands exactly on the entry of the next one.

use std::f64::consts::TAU;

use crate::geom::*;
use crate::model::*;
use crate::rng::Rng;
use crate::shape_model::ShapeModel;

/// A sample after cleanup.
#[derive(Clone, Debug)]
pub struct Prepared {
    pub strokes: Vec<Stroke>,
    pub entry: Option<Anchor>,
    pub exit: Option<Anchor>,
}

/// Samples can only be blended when they were written the same way.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Topology {
    pub strokes: usize,
    pub entry: Option<Level>,
    pub exit: Option<Level>,
}

impl Prepared {
    pub fn topology(&self) -> Topology {
        let level = |a: Option<Anchor>| a.filter(|a| a.connect).map(|a| Level::of(a.y));
        Topology { strokes: self.strokes.len(), entry: level(self.entry), exit: level(self.exit) }
    }
}

/// A join point after snapping.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Join {
    pub x: f64,
    pub y: f64,
    pub level: Level,
}

/// One synthesized letter, in font units, before placement.
#[derive(Clone, Debug)]
pub struct GlyphInk {
    pub strokes: Vec<Stroke>,
    /// Present only when the letter connects on that side.
    pub entry: Option<Join>,
    pub exit: Option<Join>,
}

/// Where a letter stands in its word; picks which recorded variants fit.
///
/// A variant written without a joining entry starts words; one that joins on
/// both sides belongs in the middle (falling back to any that joins on the left).
/// The last letter prefers a variant without a joining exit, and when there is
/// none its tail is cut short: a word ends without a stroke into nowhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Position {
    Any,
    Initial,
    Medial,
    /// The last letter of a word (before a space, punctuation or the end).
    Final,
    /// A word of one letter (і, з, у, а): joins nothing on either side.
    Single,
    /// Abbreviations (СССР, т.е.): a stand-alone letter that joins nothing.
    Isolated,
}

impl Position {
    /// Acceptance tests, most preferred first.
    fn preferences(self) -> &'static [fn(&Topology) -> bool] {
        match self {
            Position::Any => &[|_| true],
            Position::Initial => &[|t| t.entry.is_none()],
            Position::Medial => &[|t| t.entry.is_some() && t.exit.is_some(), |t| t.entry.is_some()],
            Position::Final => &[|t| t.entry.is_some() && t.exit.is_none(), |t| t.entry.is_some()],
            Position::Single | Position::Isolated => &[|t| t.entry.is_none() && t.exit.is_none(), |t| t.entry.is_none()],
        }
    }

    /// Nothing follows this letter in its word: no tail towards a next letter.
    pub fn ends_word(self) -> bool {
        matches!(self, Position::Final | Position::Single | Position::Isolated)
    }

    /// The first preference some sample satisfies (or "anything").
    pub fn filter(self, samples: &[Prepared]) -> fn(&Topology) -> bool {
        for &pref in self.preferences() {
            if samples.iter().any(|s| pref(&s.topology())) {
                return pref;
            }
        }
        |_| true
    }
}

/// Heights of the two join lines, learned from the user's anchors.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Joins {
    pub low: Option<f64>,
    pub high: Option<f64>,
}

impl Joins {
    pub fn y(&self, level: Level) -> Option<f64> {
        match level {
            Level::Low => self.low,
            Level::High => self.high,
        }
    }
}

pub fn prepare(sample: &Sample) -> Prepared {
    let simulate = sample.pointer_type.as_deref() != Some("pen") || constant_pressure(sample);
    let strokes = sample
        .strokes
        .iter()
        .filter(|s| !s.is_empty())
        .map(|raw| {
            let mut pts: Vec<(Pt, f64)> = Vec::with_capacity(raw.len());
            for ip in raw {
                let p = Pt::new(ip.x, ip.y, ip.p.clamp(0.0, 1.0));
                if let Some((last, _)) = pts.last() {
                    if last.dist(&p) < 0.75 {
                        continue;
                    }
                }
                pts.push((p, ip.t));
            }
            if simulate {
                simulate_pressure(&mut pts);
            }
            let mut s: Stroke = pts.into_iter().map(|(p, _)| p).collect();
            smooth(&mut s, 2);
            if s.len() > 1 {
                s = resample_spacing(&s, 5.0);
            }
            s
        })
        .collect::<Vec<Stroke>>();
    // A join only works on the outer edge: the pen arrives from the left and
    // leaves to the right. A "connecting" point in the middle of the letter
    // would make it hang over its neighbour, so it is ignored.
    let b = strokes_bbox(&strokes);
    let reach = (0.3 * b.width()).max(60.0);
    let entry = sample.entry.map(|a| Anchor { connect: a.connect && !b.is_empty() && a.x <= b.x_min + reach, ..a });
    let exit = sample.exit.map(|a| Anchor { connect: a.connect && !b.is_empty() && a.x >= b.x_max - reach, ..a });
    Prepared { strokes, entry, exit }
}

fn constant_pressure(sample: &Sample) -> bool {
    let mut it = sample.strokes.iter().flatten().map(|p| p.p);
    let Some(first) = it.next() else { return true };
    it.all(|p| (p - first).abs() < 0.01)
}

/// Mouse and touch have no pressure: derive it from speed (fast = thin)
/// and taper the ends the way a pen lands and lifts.
fn simulate_pressure(pts: &mut [(Pt, f64)]) {
    let n = pts.len();
    if n == 1 {
        pts[0].0.p = 0.8;
        return;
    }
    let mut speeds = vec![0.0; n];
    for i in 1..n {
        let dt = (pts[i].1 - pts[i - 1].1).max(1.0);
        speeds[i] = pts[i].0.dist(&pts[i - 1].0) / dt;
    }
    speeds[0] = speeds[1];
    let mut v = speeds[0];
    for i in 0..n {
        v = v * 0.7 + speeds[i] * 0.3;
        let p = 1.0 - 0.5 * (v / 6.0).min(1.0);
        let taper = (i.min(n - 1 - i) as f64 / 4.0).min(1.0);
        pts[i].0.p = p * (0.6 + 0.4 * taper);
    }
}

/// Join line heights: the median of all connecting anchors of each level.
/// Quantised so tiny changes do not invalidate every cached glyph.
pub fn join_lines(samples: &[&Prepared]) -> Joins {
    let mut low = Vec::new();
    let mut high = Vec::new();
    for a in samples.iter().flat_map(|s| [s.entry, s.exit]).flatten().filter(|a| a.connect) {
        match Level::of(a.y) {
            Level::Low => low.push(a.y),
            Level::High => high.push(a.y),
        }
    }
    let median = |mut v: Vec<f64>| -> Option<f64> {
        if v.is_empty() {
            return None;
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        Some((v[v.len() / 2] / 5.0).round() * 5.0)
    };
    let low = median(low);
    // A letter that must start high (after "о") can be built even if the user
    // never wrote a high join: fall back to the x-height.
    let high = median(high).or(low.map(|_| X_HEIGHT * 0.92));
    Joins { low, high }
}

/// Create one variant of a letter.
///
/// `slot = Some(k)` reuses recorded sample `k` when it exists (so every
/// recorded variant shows up in the font) and samples the learned model for
/// the rest; `slot = None` makes a fresh random instance (ink rendering).
#[allow(clippy::too_many_arguments)]
pub fn synthesize(
    samples: &[Prepared],
    model: &ShapeModel,
    slot: Option<usize>,
    position: Position,
    rng: &mut Rng,
    style: &Style,
    joins: &Joins,
) -> GlyphInk {
    if samples.is_empty() {
        return GlyphInk { strokes: vec![], entry: None, exit: None };
    }
    // Only the variants that suit this place in the word.
    let accept = position.filter(samples);
    let fitting: Vec<&Prepared> = samples.iter().filter(|s| accept(&s.topology())).collect();
    let n = fitting.len();
    let (mut strokes, entry, exit) = match slot {
        Some(k) if k < n => (fitting[k].strokes.clone(), fitting[k].entry, fitting[k].exit),
        _ => {
            let generated = if style.interpolate { model.sample_where(rng, style.fantasy, accept) } else { None };
            generated.unwrap_or_else(|| {
                let s = fitting[rng.below(n)];
                (s.strokes.clone(), s.entry, s.exit)
            })
        }
    };

    // Natural variation: scale, rotation, slant, baseline shift and a gentle wobble.
    let bbox = strokes_bbox(&strokes);
    let cx = if bbox.is_empty() { 0.0 } else { bbox.center_x() };
    let j = style.jitter.clamp(0.0, 2.0);
    let s = 1.0 + rng.gauss() * 0.035 * j;
    let sx = s * (1.0 + rng.gauss() * 0.02 * j);
    let sy = s * (1.0 + rng.gauss() * 0.02 * j);
    let (sin, cos) = (rng.gauss() * 1.6 * j).to_radians().sin_cos();
    let shear = (style.slant + rng.gauss() * 2.0 * j).to_radians().tan();
    let dy = rng.gauss() * 9.0 * j;
    let amp = 5.0 * j;
    let (f1, f2) = (rng.range(0.004, 0.009), rng.range(0.004, 0.009));
    let (ph1, ph2) = (rng.range(0.0, TAU), rng.range(0.0, TAU));
    let pmul = 1.0 + rng.gauss() * 0.08 * j;
    let tf = |x: f64, y: f64| -> (f64, f64) {
        let (x0, y0) = ((x - cx) * sx, y * sy);
        let (x1, y1) = (x0 * cos - y0 * sin, x0 * sin + y0 * cos);
        let (x2, y2) = (x1 + y1 * shear + cx, y1 + dy);
        (x2 + amp * (f1 * y2 + ph1).sin(), y2 + amp * (f2 * x2 + ph2).sin())
    };
    for st in strokes.iter_mut() {
        for p in st.iter_mut() {
            let (x, y) = tf(p.x, p.y);
            *p = Pt::new(x, y, (p.p * pmul).clamp(0.0, 1.0));
        }
    }
    // The level is decided on the untransformed anchor, as the user drew it.
    let tf_anchor = |a: Option<Anchor>| {
        a.filter(|a| a.connect).map(|a| {
            let (x, y) = tf(a.x, a.y);
            (x, y, Level::of(a.y))
        })
    };
    let entry = tf_anchor(entry);
    let exit = tf_anchor(exit);

    // Snap connecting ends onto their join line so neighbours meet exactly.
    let mut out_entry = None;
    let mut out_exit = None;
    let mut used = None;
    // Isolated letters keep their strokes but never join: spacing comes from their ink.
    if style.connect && position != Position::Isolated {
        if let Some((x, y, level)) = entry {
            if let (Some(ty), Some(end)) = (joins.y(level), nearest_end(&strokes, x, y, None)) {
                if let Some((px, py)) = warp_end(&mut strokes[end.0], end.1, ty, 220.0) {
                    out_entry = Some(Join { x: px, y: py, level });
                    used = Some(end);
                }
            }
        }
        if let (false, Some((x, y, level))) = (position.ends_word(), exit) {
            if let (Some(ty), Some(end)) = (joins.y(level), nearest_end(&strokes, x, y, used)) {
                if let Some((px, py)) = warp_end(&mut strokes[end.0], end.1, ty, 220.0) {
                    out_exit = Some(Join { x: px, y: py, level });
                }
            }
        }
    }
    // The end of a word: the joining tail has nowhere to go, cut it short.
    if let (true, Some((x, y, _))) = (position.ends_word(), exit) {
        if let Some(end) = nearest_end(&strokes, x, y, used) {
            trim_tail(&mut strokes[end.0], end.1);
        }
    }
    GlyphInk { strokes, entry: out_entry, exit: out_exit }
}

/// Make a letter enter at `target` height instead of its natural one.
///
/// Low → high: the lead-in upstroke is trimmed where it first reaches the high
/// join line (the pen arrives there from the previous letter), or bent up if it
/// never gets that high. High → low: a short upstroke from the low line is added.
pub fn adapt_entry(ink: &mut GlyphInk, target: Level, joins: &Joins) -> bool {
    let Some(entry) = ink.entry else { return false };
    if entry.level == target {
        return true;
    }
    let Some(ty) = joins.y(target) else { return false };
    let Some((si, at_start)) = nearest_end(&ink.strokes, entry.x, entry.y, None) else { return false };
    let mut s = ink.strokes[si].clone();
    if !at_start {
        s.reverse();
    }
    match target {
        Level::High => {
            let len = stroke_length(&s);
            let mut acc = 0.0;
            let mut cut = None;
            for i in 1..s.len() {
                acc += s[i - 1].dist(&s[i]);
                if acc > len * 0.6 {
                    break;
                }
                if s[i].y >= ty - 4.0 {
                    cut = Some(i);
                    break;
                }
            }
            if let Some(i) = cut {
                s.drain(..i);
            }
            if s.len() < 2 || warp_end(&mut s, true, ty, 400.0).is_none() {
                return false;
            }
        }
        Level::Low => {
            let p = s[0];
            let start = Pt::new(p.x - 150.0, ty, p.p * 0.8);
            let ctrl = Pt::new(p.x - 40.0, ty + (p.y - ty) * 0.15, p.p);
            let mut lead: Stroke = (0..12)
                .map(|i| {
                    let t = i as f64 / 12.0;
                    let a = start.lerp(&ctrl, t);
                    let b = ctrl.lerp(&p, t);
                    a.lerp(&b, t)
                })
                .collect();
            lead.extend(s);
            s = lead;
        }
    }
    let start = s[0];
    if !at_start {
        s.reverse();
    }
    ink.strokes[si] = s;
    ink.entry = Some(Join { x: start.x, y: start.y, level: target });
    true
}

/// Cut a joining tail short: the last run of the stroke that heads the way
/// the exit points (up and out of «а», across from the top of «о») is cut
/// back to a small flick, and the pen lifts there. `at_start`: the tail is at
/// the start of the stroke.
pub fn trim_tail(s: &mut Stroke, at_start: bool) {
    if s.len() < 8 {
        return;
    }
    if at_start {
        s.reverse();
    }
    let n = s.len();
    let dir = |a: &Pt, b: &Pt| {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l = (dx * dx + dy * dy).sqrt().max(1e-9);
        (dx / l, dy / l)
    };
    let k = 3;
    let out = dir(&s[n - 1 - k], &s[n - 1]);
    // Walk back while the stroke still heads roughly the same way (within ~55°).
    let mut cut = n - 1 - k;
    while cut > k {
        let d = dir(&s[cut - k], &s[cut]);
        if d.0 * out.0 + d.1 * out.1 < 0.57 {
            break;
        }
        cut -= 1;
    }
    let total = stroke_length(s);
    let tail = stroke_length(&s[cut..]);
    if tail >= 45.0 {
        // Never more than half the stroke; keep a short flick of the tail.
        let tail = tail.min(total * 0.5);
        let keep = total - tail + (tail * 0.3).min(45.0);
        let mut acc = 0.0;
        let mut end = n;
        for i in 1..n {
            acc += s[i - 1].dist(&s[i]);
            if acc > keep {
                end = i;
                break;
            }
        }
        s.truncate(end.max(2));
        // The pen lifts off where the stroke now ends.
        let m = s.len();
        for (j, p) in s.iter_mut().rev().take(5.min(m - 1)).enumerate() {
            p.p *= 0.55 + 0.09 * j as f64;
        }
    }
    if at_start {
        s.reverse();
    }
}

/// Move a joining letter `by` units to the right of where its entry was, by
/// drawing its lead-in that much longer along the join line (with the slight
/// sag of a hand-drawn connection). Used when two joined letters would collide.
pub fn stretch_entry(ink: &mut GlyphInk, by: f64) -> bool {
    let Some(entry) = ink.entry else { return false };
    let Some((si, at_start)) = nearest_end(&ink.strokes, entry.x, entry.y, None) else { return false };
    let s = &mut ink.strokes[si];
    if !at_start {
        s.reverse();
    }
    let p0 = s[0];
    let steps = ((by / 5.0).ceil() as usize).max(2);
    let lead: Stroke = (0..steps)
        .map(|i| {
            let t = i as f64 / steps as f64;
            let sag = 0.05 * by.min(300.0) * (std::f64::consts::PI * t).sin();
            Pt::new(p0.x - by * (1.0 - t), p0.y - sag, p0.p * (0.85 + 0.15 * t))
        })
        .collect();
    s.splice(0..0, lead);
    if !at_start {
        s.reverse();
    }
    ink.entry = Some(Join { x: entry.x - by, ..entry });
    true
}

/// Shortest stroke that can join: anything shorter is a dot (і, ї, й) or a tick.
const DOT_LENGTH: f64 = 35.0;

/// The stroke end (stroke index, is_start) closest to an anchor.
fn nearest_end(strokes: &[Stroke], x: f64, y: f64, exclude: Option<(usize, bool)>) -> Option<(usize, bool)> {
    let target = Pt::new(x, y, 0.0);
    let mut best: Option<((usize, bool), f64)> = None;
    for (i, s) in strokes.iter().enumerate() {
        if s.len() < 2 || stroke_length(s) < DOT_LENGTH {
            continue; // dots never join
        }
        for (at_start, p) in [(true, s[0]), (false, *s.last().unwrap())] {
            if exclude == Some((i, at_start)) {
                continue;
            }
            let d = p.dist(&target);
            if d < 160.0 && best.is_none_or(|(_, bd)| d < bd) {
                best = Some(((i, at_start), d));
            }
        }
    }
    best.map(|(e, _)| e)
}

/// Bend the last part of a stroke so its end sits on `target_y`.
/// Returns the new end point, or None when the bend would distort the letter.
fn warp_end(s: &mut Stroke, at_start: bool, target_y: f64, max_dy: f64) -> Option<(f64, f64)> {
    if s.len() < 2 {
        return None;
    }
    if !at_start {
        s.reverse();
    }
    let dy = target_y - s[0].y;
    let result = if dy.abs() > max_dy {
        None
    } else {
        let mut arc = vec![0.0; s.len()];
        for i in 1..s.len() {
            arc[i] = arc[i - 1] + s[i - 1].dist(&s[i]);
        }
        let reach = (arc[s.len() - 1] * 0.4).clamp(1.0, 170.0_f64.max(dy.abs() * 0.8));
        for (p, a) in s.iter_mut().zip(&arc) {
            if *a < reach {
                let w = 1.0 - a / reach;
                p.y += dy * w * w;
            }
        }
        Some((s[0].x, s[0].y))
    };
    if !at_start {
        s.reverse();
    }
    result
}

/// Where the glyph starts and how far the pen moves to the next letter.
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    pub origin_x: f64,
    pub advance: f64,
}

/// `ink_bbox` must include the pen radius.
pub fn place(ink: &GlyphInk, ink_bbox: &BBox, style: &Style) -> Placement {
    let sb = style.letter_spacing;
    if ink_bbox.is_empty() {
        return Placement { origin_x: 0.0, advance: (sb * 2.0).max(100.0) };
    }
    let origin_x = match ink.entry {
        Some(j) => j.x,
        None => ink_bbox.x_min - sb,
    };
    let right = match ink.exit {
        Some(j) => j.x,
        None => ink_bbox.x_max + sb,
    };
    Placement { origin_x, advance: (right - origin_x).max(20.0) }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn sample(points: &[(f64, f64)], entry: Option<Anchor>, exit: Option<Anchor>) -> Sample {
        Sample {
            id: "s".into(),
            ch: "u".into(),
            strokes: vec![points
                .iter()
                .enumerate()
                .map(|(i, &(x, y))| InkPoint { x, y, t: i as f64 * 8.0, p: 0.5 })
                .collect()],
            entry,
            exit,
            pointer_type: Some("mouse".into()),
        }
    }

    fn wave(h: f64) -> Vec<(f64, f64)> {
        (0..=40).map(|i| (i as f64 * 10.0, h * (i as f64 / 40.0 * 3.14).sin() + 30.0)).collect()
    }

    #[test]
    fn connecting_ends_snap_to_join_line() {
        let s = sample(
            &wave(200.0),
            Some(Anchor { x: 0.0, y: 30.0, connect: true }),
            Some(Anchor { x: 400.0, y: 30.0, connect: true }),
        );
        let p = prepare(&s);
        let style = Style::default();
        let joins = Joins { low: Some(60.0), high: Some(420.0) };
        let model = ShapeModel::fit(std::slice::from_ref(&p));
        let ink = synthesize(&[p], &model, Some(0), Position::Any, &mut Rng::new(7), &style, &joins);
        let e = ink.entry.expect("entry");
        let x = ink.exit.expect("exit");
        assert!((e.y - 60.0).abs() < 1e-6 && (x.y - 60.0).abs() < 1e-6);
        assert_eq!(e.level, Level::Low);
        let pl = place(&ink, &strokes_bbox(&ink.strokes), &style);
        assert!((pl.origin_x - e.x).abs() < 1e-9);
        assert!((pl.origin_x + pl.advance - x.x).abs() < 1e-9);
    }

    #[test]
    fn joins_away_from_the_edge_are_ignored() {
        // A "с" started at the top right with its entry switched on by mistake.
        let pts: Vec<(f64, f64)> = (0..=40)
            .map(|i| {
                let t = 0.5 + i as f64 / 40.0 * 5.2;
                (200.0 + 180.0 * t.cos(), 220.0 + 200.0 * t.sin())
            })
            .collect();
        let first = pts[0];
        let last = *pts.last().unwrap();
        let s = sample(
            &pts,
            Some(Anchor { x: first.0, y: first.1, connect: true }),
            Some(Anchor { x: 380.0, y: last.1, connect: true }),
        );
        let p = prepare(&s);
        assert!(!p.entry.unwrap().connect, "entry at {first:?} is not on the left edge");
        assert!(p.exit.unwrap().connect, "exit on the right edge stays");
    }

    #[test]
    fn high_exit_is_snapped_to_the_high_line() {
        // An "о"-like stroke that leaves at the top.
        let pts: Vec<(f64, f64)> = (0..=60)
            .map(|i| {
                let t = i as f64 / 60.0 * TAU;
                (200.0 - 150.0 * t.sin(), 220.0 + 200.0 * t.cos())
            })
            .chain((1..=10).map(|i| (200.0 + i as f64 * 15.0, 425.0)))
            .collect();
        let s = sample(&pts, None, Some(Anchor { x: 350.0, y: 425.0, connect: true }));
        let joins = Joins { low: Some(40.0), high: Some(430.0) };
        let p = prepare(&s);
        let model = ShapeModel::fit(std::slice::from_ref(&p));
        let ink = synthesize(&[p], &model, Some(0), Position::Any, &mut Rng::new(1), &Style::default(), &joins);
        let x = ink.exit.expect("exit");
        assert_eq!(x.level, Level::High);
        assert!((x.y - 430.0).abs() < 1e-6);
    }

    /// «а»-like: a stem down to the baseline, then a hook up and out to the right.
    fn hooked() -> Vec<(f64, f64)> {
        let mut pts: Vec<(f64, f64)> = (0..=40).map(|i| (200.0, 450.0 - i as f64 * 10.0)).collect();
        pts.extend((1..=12).map(|i| {
            let t = i as f64 / 12.0 * std::f64::consts::FRAC_PI_2;
            (200.0 + 40.0 * (1.0 - t.cos()), 40.0 - 40.0 * t.sin())
        }));
        pts.extend((1..=12).map(|i| (240.0 + i as f64 * 10.0, i as f64 * 6.0)));
        pts
    }

    #[test]
    fn word_end_cuts_the_joining_tail() {
        let pts = hooked();
        let last = *pts.last().unwrap();
        let s = sample(&pts, None, Some(Anchor { x: last.0, y: last.1, connect: true }));
        let p = prepare(&s);
        let joins = Joins { low: Some(60.0), high: Some(420.0) };
        let model = ShapeModel::fit(std::slice::from_ref(&p));
        let style = Style { jitter: 0.0, ..Style::default() };
        let mid = synthesize(std::slice::from_ref(&p), &model, Some(0), Position::Medial, &mut Rng::new(1), &style, &joins);
        let end = synthesize(std::slice::from_ref(&p), &model, Some(0), Position::Final, &mut Rng::new(1), &style, &joins);
        assert!(mid.exit.is_some(), "in the middle the tail joins");
        assert!(end.exit.is_none(), "at the end of a word there is nothing to join");
        let right = |ink: &GlyphInk| strokes_bbox(&ink.strokes).x_max;
        assert!(right(&end) < right(&mid) - 60.0, "tail cut short: {} vs {}", right(&end), right(&mid));
        assert!(right(&end) > 200.0, "the stem itself stays");
    }

    #[test]
    fn a_dot_never_joins() {
        // «і»: a stem, then the dot written last, where the exit was put by mistake.
        let stem: Vec<InkPoint> = (0..=30).map(|i| InkPoint { x: 100.0, y: 420.0 - i as f64 * 14.0, t: i as f64 * 8.0, p: 0.5 }).collect();
        let dot: Vec<InkPoint> = (0..4).map(|i| InkPoint { x: 100.0 + i as f64 * 3.0, y: 620.0, t: 400.0 + i as f64 * 8.0, p: 0.5 }).collect();
        let s = Sample {
            id: "i".into(),
            ch: "і".into(),
            strokes: vec![stem, dot],
            entry: None,
            exit: Some(Anchor { x: 109.0, y: 620.0, connect: true }),
            pointer_type: Some("mouse".into()),
        };
        let p = prepare(&s);
        let joins = Joins { low: Some(60.0), high: Some(420.0) };
        let model = ShapeModel::fit(std::slice::from_ref(&p));
        let ink = synthesize(&[p], &model, Some(0), Position::Medial, &mut Rng::new(1), &Style::default(), &joins);
        assert!(ink.exit.is_none(), "the dot is not bent down to the join line");
    }

    #[test]
    fn stretched_entry_moves_the_letter_right() {
        let pts = wave(200.0);
        let s = sample(&pts, Some(Anchor { x: 0.0, y: 30.0, connect: true }), Some(Anchor { x: 400.0, y: 30.0, connect: true }));
        let p = prepare(&s);
        let joins = Joins { low: Some(60.0), high: Some(420.0) };
        let model = ShapeModel::fit(std::slice::from_ref(&p));
        let style = Style { jitter: 0.0, ..Style::default() };
        let mut ink = synthesize(&[p], &model, Some(0), Position::Medial, &mut Rng::new(1), &style, &joins);
        let before = place(&ink, &strokes_bbox(&ink.strokes), &style);
        let body = strokes_bbox(&ink.strokes).x_max;
        assert!(stretch_entry(&mut ink, 120.0));
        let after = place(&ink, &strokes_bbox(&ink.strokes), &style);
        assert!((after.origin_x - (before.origin_x - 120.0)).abs() < 1e-6, "the pen now arrives 120 units earlier");
        assert!((strokes_bbox(&ink.strokes).x_max - body).abs() < 1e-6, "the letter itself is unchanged");
        assert!((ink.entry.unwrap().y - 60.0).abs() < 1e-6, "still on the join line");
    }

    #[test]
    fn low_entry_is_adapted_to_start_high() {
        // Lead-in rising from the baseline to the top, then down: like "и".
        let mut pts: Vec<(f64, f64)> = (0..=20).map(|i| (i as f64 * 8.0, 30.0 + i as f64 * 21.0)).collect();
        pts.extend((1..=20).map(|i| (160.0 + i as f64 * 4.0, 450.0 - i as f64 * 21.0)));
        let s = sample(&pts, Some(Anchor { x: 0.0, y: 30.0, connect: true }), None);
        let joins = Joins { low: Some(30.0), high: Some(420.0) };
        let p = prepare(&s);
        let model = ShapeModel::fit(std::slice::from_ref(&p));
        let style = Style { jitter: 0.0, ..Style::default() };
        let mut ink = synthesize(&[p], &model, Some(0), Position::Any, &mut Rng::new(1), &style, &joins);
        let before = ink.entry.unwrap();
        assert!(adapt_entry(&mut ink, Level::High, &joins));
        let after = ink.entry.unwrap();
        assert_eq!(after.level, Level::High);
        assert!((after.y - 420.0).abs() < 1e-6);
        assert!(after.x > before.x + 100.0, "the lead-in was trimmed: {before:?} -> {after:?}");

        // And back down: a lead-in is added from the low line.
        assert!(adapt_entry(&mut ink, Level::Low, &joins));
        let low = ink.entry.unwrap();
        assert!((low.y - 30.0).abs() < 1e-6 && low.x < after.x);
    }
}
