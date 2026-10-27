//! Turning recorded samples into an endless supply of letter variants.
//!
//! 1. `prepare`    – clean up a raw sample (dedupe, pressure, smoothing, resampling).
//! 2. `synthesize` – take a recorded variant or draw a new one from the learned
//!    shape model, apply natural jitter and snap entry/exit onto their join line
//!    (low, near the baseline, or high, at the x-height).
//! 3. `adapt_entry` – rewrite the start of a letter so it joins a neighbour that
//!    leaves at the other height (after "о" the next letter starts at the top).
//!    `stretch_entry` lengthens the lead-in when two joined letters would collide.
//!    The ink renderer does not bend letters at all: `connector` draws the
//!    stroke a hand makes from one letter's real exit to the next one's start.
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

/// How a variant was written to join, which says where in a word it belongs:
/// without an entry it starts words, with both in the middle, without an
/// exit it ends them, with neither it stands alone (one-letter words,
/// formulas, indices, abbreviations).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form {
    Start,
    Middle,
    End,
    Alone,
}

impl Topology {
    pub fn form(&self) -> Form {
        match (self.entry.is_some(), self.exit.is_some()) {
            (false, true) => Form::Start,
            (true, true) => Form::Middle,
            (true, false) => Form::End,
            (false, false) => Form::Alone,
        }
    }
}

/// With fewer variants of the right form than this, the variants of the
/// forms that can be adapted to the place join them (a lead-in or a tail is
/// cut), so a letter written mostly one way still varies everywhere.
pub const MIN_POOL: usize = 3;

/// Which written variant `synthesize` starts from.
#[derive(Clone, Copy, Debug)]
pub enum Choice {
    /// The font's k-th form: the k-th variant of the position's pool, then
    /// new ones grown around them in turn.
    Slot(usize),
    /// A new instance around this written variant (an index into the
    /// samples), dealt out by the caller from the position's pool.
    Variant(usize),
    /// A new instance around any variant of the pool.
    Random,
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
/// Every place takes the variants of its own [`Form`] first. When there are
/// fewer than [`MIN_POOL`] of them, the forms that can be adapted join in:
/// at the start of a word (and standing alone) a joining lead-in is cut short,
/// at its end a joining tail is — a word neither begins nor ends with a stroke
/// into nowhere. A place that must join the next letter only takes variants
/// with an exit, one the font joins on the left only variants with an entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Position {
    Any,
    Initial,
    Medial,
    /// The last letter of a word (before a space, punctuation or the end).
    Final,
    /// Inside a word, in ink: letters are joined by connecting strokes, so a
    /// variant written without a lead-in fits as well as one written with it.
    Inside,
    /// The last letter of a word, in ink (joined by a connecting stroke).
    End,
    /// A word of one letter (і, з, у, а): joins nothing on either side.
    Single,
    /// Abbreviations (СССР, т.е.): a stand-alone letter that joins nothing.
    Isolated,
}

impl Position {
    /// The form that belongs here, and the forms that can be adapted to it (in order).
    fn forms(self) -> (&'static [Form], &'static [Form]) {
        use Form::*;
        match self {
            Position::Any => (&[Start, Middle, End, Alone], &[]),
            Position::Initial => (&[Start], &[Middle]),
            Position::Inside => (&[Middle], &[Start]),
            Position::Medial => (&[Middle], &[End]),
            Position::Final => (&[End], &[Middle]),
            Position::End => (&[End], &[Middle, Alone, Start]),
            Position::Single | Position::Isolated => (&[Alone], &[End, Start, Middle]),
        }
    }

    /// Nothing follows this letter in its word: no tail towards a next letter.
    pub fn ends_word(self) -> bool {
        matches!(self, Position::Final | Position::End | Position::Single | Position::Isolated)
    }

    /// Nothing comes before this letter in its word: no lead-in from a previous letter.
    pub fn starts_word(self) -> bool {
        matches!(self, Position::Initial | Position::Single | Position::Isolated)
    }

    /// Indices of the samples that may stand here, those of the right form
    /// first. Never empty when there are samples: with none that fits, any.
    pub fn pool(self, samples: &[Prepared]) -> Vec<usize> {
        let forms: Vec<Form> = samples.iter().map(|s| s.topology().form()).collect();
        let of = |wanted: &[Form]| -> Vec<usize> {
            wanted.iter().flat_map(|w| (0..forms.len()).filter(|&i| forms[i] == *w).collect::<Vec<_>>()).collect()
        };
        let (own, adapted) = self.forms();
        let mut pool = of(own);
        if pool.len() < MIN_POOL {
            pool.extend(of(adapted));
        }
        if pool.is_empty() {
            pool = (0..samples.len()).collect();
        }
        pool
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
    // Nor can a letter join from the top of an ascender or the bottom of a tail
    // (a cut in «Напиши фразу» can land there).
    let b = strokes_bbox(&strokes);
    let reach = (0.3 * b.width()).max(60.0);
    let height = |a: &Anchor| a.y > -0.3 * X_HEIGHT && a.y < 1.3 * X_HEIGHT;
    let entry = sample.entry.map(|a| Anchor { connect: a.connect && !b.is_empty() && a.x <= b.x_min + reach && height(&a), ..a });
    let exit = sample.exit.map(|a| Anchor { connect: a.connect && !b.is_empty() && a.x >= b.x_max - reach && height(&a), ..a });
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
/// `choice` says which written variant it starts from (see [`Choice`]): the
/// font reuses every recorded variant of the pool once and grows new ones
/// from the learned model for the rest; ink rendering grows a fresh instance
/// around the variant dealt to it.
///
/// `snap`: bend the joining ends onto the two join lines, so that any two
/// letters meet (the font needs that). Without it the letter stays as it was
/// written and its entry and exit are where its strokes really end; the ink
/// renderer joins such letters with a connecting stroke instead.
#[allow(clippy::too_many_arguments)]
pub fn synthesize(
    samples: &[Prepared],
    model: &ShapeModel,
    choice: Choice,
    position: Position,
    rng: &mut Rng,
    style: &Style,
    joins: &Joins,
    snap: bool,
) -> GlyphInk {
    if samples.is_empty() {
        return GlyphInk { strokes: vec![], entry: None, exit: None };
    }
    // Only the variants that suit this place in the word.
    let pool = position.pool(samples);
    let (base, grow) = match choice {
        Choice::Slot(k) => (pool[k % pool.len()], k >= pool.len()),
        Choice::Variant(i) => (i.min(samples.len() - 1), true),
        Choice::Random => (pool[rng.below(pool.len())], true),
    };
    let generated = if grow && style.interpolate { model.sample_near(base, rng, style.fantasy) } else { None };
    let (mut strokes, entry, exit) = generated.unwrap_or_else(|| {
        let s = &samples[base];
        (s.strokes.clone(), s.entry, s.exit)
    });

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
    let mut entry = tf_anchor(entry);
    let exit = tf_anchor(exit);
    // The start of a word: a joining lead-in has nothing to come from, cut it short.
    if position.starts_word() {
        if let Some(end) = entry.take().and_then(|(x, y, _)| nearest_end(&strokes, x, y, None)) {
            trim_lead(&mut strokes[end.0], end.1);
        }
    }

    // Snap connecting ends onto their join line so neighbours meet exactly.
    let mut out_entry = None;
    let mut out_exit = None;
    let mut used = None;
    // Isolated letters keep their strokes but never join: spacing comes from their ink.
    if !snap && style.connect && position != Position::Isolated {
        let at = |strokes: &[Stroke], end: (usize, bool)| {
            let s = &strokes[end.0];
            if end.1 { s[0] } else { s[s.len() - 1] }
        };
        // As far from the user's own join line as a snapped join may bend; above the high
        // line only a little (the top of an ascender is not a join).
        let near = |p: Pt, level: Level| {
            joins.y(level).is_none_or(|ty| p.y - ty <= if level == Level::High { 120.0 } else { 220.0 } && ty - p.y <= 220.0)
        };
        if let Some((x, y, level)) = entry {
            if let Some(end) = nearest_end(&strokes, x, y, None) {
                let p = at(&strokes, end);
                if near(p, level) {
                    out_entry = Some(Join { x: p.x, y: p.y, level });
                    used = Some(end);
                }
            }
        }
        if let (false, Some((x, y, level))) = (position.ends_word(), exit) {
            if let Some(end) = nearest_end(&strokes, x, y, used) {
                let p = at(&strokes, end);
                if near(p, level) {
                    out_exit = Some(Join { x: p.x, y: p.y, level });
                }
            }
        }
    } else if style.connect && position != Position::Isolated {
        if let Some((x, y, level)) = entry {
            if let (Some(ty), Some(end)) = (joins.y(level), nearest_end(&strokes, x, y, None)) {
                if let Some((px, py)) = warp_end(&mut strokes[end.0], end.1, ty, 220.0) {
                    untaper(&mut strokes[end.0], end.1);
                    out_entry = Some(Join { x: px, y: py, level });
                    used = Some(end);
                }
            }
        }
        if let (false, Some((x, y, level))) = (position.ends_word(), exit) {
            if let (Some(ty), Some(end)) = (joins.y(level), nearest_end(&strokes, x, y, used)) {
                if let Some((px, py)) = warp_end(&mut strokes[end.0], end.1, ty, 220.0) {
                    untaper(&mut strokes[end.0], end.1);
                    out_exit = Some(Join { x: px, y: py, level });
                }
            }
        }
    }
    // The end of a word: the joining tail has nowhere to go, cut it short.
    if let (true, Some((x, y, _))) = (position.ends_word(), exit) {
        if let Some(end) = nearest_end(&strokes, x, y, used) {
            trim_tail(&mut strokes, end.0, end.1);
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
            trim_lead_in(&mut s, ty, 0.6);
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

/// Cut a lead-in that rises from below where it first reaches height `y`
/// (within the first `share` of the stroke): the pen arrives there from a
/// letter that leaves high, as after «о». The stroke starts at index 0.
pub fn trim_lead_in(s: &mut Stroke, y: f64, share: f64) -> bool {
    let len = stroke_length(s);
    let mut acc = 0.0;
    for i in 1..s.len() {
        acc += s[i - 1].dist(&s[i]);
        if acc > len * share {
            return false;
        }
        if s[i].y >= y - 4.0 {
            if s.len() - i >= 2 {
                s.drain(..i);
                return true;
            }
            return false;
        }
    }
    false
}

/// Cut a joining tail short: the part of the exit stroke that runs out past
/// the rest of the letter, heading the way the exit points (up and out of
/// «а», across from the top of «о»), is cut back to a small flick, and the
/// pen lifts there. The letter itself is never touched: nothing within its
/// own width is cut. `at_start`: the tail is at the start of stroke `si`.
pub fn trim_tail(strokes: &mut [Stroke], si: usize, at_start: bool) {
    if strokes[si].len() < 8 {
        return;
    }
    if at_start {
        strokes[si].reverse();
    }
    let s = &strokes[si];
    let n = s.len();
    let dir = |a: &Pt, b: &Pt| {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l = (dx * dx + dy * dy).sqrt().max(1e-9);
        (dx / l, dy / l)
    };
    let k = 3;
    let out = dir(&s[n - 1 - k], &s[n - 1]);
    // The tail: walk back while the stroke still heads roughly the same way (within ~55°).
    let mut run = n - 1 - k;
    while run > k {
        let d = dir(&s[run - k], &s[run]);
        if d.0 * out.0 + d.1 * out.1 < 0.57 {
            break;
        }
        run -= 1;
    }
    // How far the rest of the letter reaches the way the tail goes.
    let sign = if out.0 >= 0.0 { 1.0 } else { -1.0 };
    let reach = |p: &Pt| p.x * sign;
    let body = strokes
        .iter()
        .enumerate()
        .flat_map(|(i, st)| st.iter().enumerate().filter(move |(j, _)| i != si || *j < run).map(|(_, p)| p))
        .map(reach)
        .fold(f64::NEG_INFINITY, f64::max);
    let s = &mut strokes[si];
    if body.is_finite() {
        // Keep the tail up to a short flick past the letter's own edge.
        if let Some(cut) = (run..n).find(|&i| reach(&s[i]) > body + 30.0) {
            if n - cut > 2 {
                s.truncate(cut.max(2));
                let m = s.len();
                for (j, p) in s.iter_mut().rev().take(5.min(m - 1)).enumerate() {
                    p.p *= 0.55 + 0.09 * j as f64;
                }
            }
        }
    }
    if at_start {
        s.reverse();
    }
}

/// Cut a joining lead-in short at the start of a word: the part where the
/// pen runs in nearly level from the left (along the line, from where a
/// previous letter would be) is cut back to a small flick. A lead-in that
/// climbs is kept: in «м», «л», «и» it is the first leg of the letter itself.
/// `at_start`: the lead-in is at the start of the stroke.
pub fn trim_lead(s: &mut Stroke, at_start: bool) {
    const FLICK: f64 = 20.0;
    if s.len() < 8 {
        return;
    }
    if !at_start {
        s.reverse();
    }
    // How far the stroke runs in to the right, rising or falling at most ~30°.
    let k = 3;
    let mut level = 0;
    while level + k < s.len() {
        let (dx, dy) = (s[level + k].x - s[level].x, s[level + k].y - s[level].y);
        if dx <= 0.0 || dy.abs() > 0.6 * dx {
            break;
        }
        level += 1;
    }
    let run: f64 = s[..=level].windows(2).map(|w| w[0].dist(&w[1])).sum();
    if run > 2.0 * FLICK && s.len() - level > 4 {
        // Keep the last FLICK units of the level run.
        let mut cut = level;
        let mut kept = 0.0;
        while cut > 0 && kept < FLICK {
            kept += s[cut - 1].dist(&s[cut]);
            cut -= 1;
        }
        s.drain(..cut);
        for (j, p) in s.iter_mut().take(4).enumerate() {
            p.p *= 0.6 + 0.1 * j as f64;
        }
    }
    if !at_start {
        s.reverse();
    }
}

/// How far in from a joined end its thinning is taken back, at most.
const TAPER_REACH: f64 = 120.0;

/// Where a letter joins its neighbour the pen does not lift: the thinning at
/// that end of the stroke (the pen lifting off, or the taper given to mouse
/// strokes) is taken back to the pressure the stroke had just before it.
/// `at_start`: the joined end is the stroke's first point.
pub fn untaper(s: &mut Stroke, at_start: bool) {
    let n = s.len();
    if n < 3 {
        return;
    }
    let at = |k: usize| if at_start { k } else { n - 1 - k };
    // Walk in from the end while the pressure keeps rising: that is the taper.
    let (mut k, mut run) = (0, 0.0);
    while k + 1 < n && run < TAPER_REACH {
        let (a, b) = (s[at(k)], s[at(k + 1)]);
        if b.p + 0.01 < a.p {
            break;
        }
        run += a.dist(&b);
        k += 1;
    }
    let p = s[at(k)].p;
    for j in 0..k {
        let q = &mut s[at(j)];
        q.p = q.p.max(p);
    }
}

/// Unit direction in which the pen leaves stroke `s` at one of its ends
/// (at the start: backwards out of the stroke), over its last ~30 units.
pub fn outward(s: &Stroke, at_start: bool) -> (f64, f64) {
    let k = 6.min(s.len() - 1);
    let (a, b) = if at_start { (s[k], s[0]) } else { (s[s.len() - 1 - k], s[s.len() - 1]) };
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let l = (dx * dx + dy * dy).sqrt().max(1e-9);
    (dx / l, dy / l)
}

/// The stroke a hand draws from one letter's exit `from` to the next one's
/// start `to`. The hand moves fastest there, so it is nearly straight: it
/// only bends at its very ends, leaving along `out_dir` and arriving along
/// `in_dir`, always moving on to the right. `over`: the letter starts inside
/// its own width (the top of the bowl of «а», «d»), so the pen rises early and
/// runs in along the top of the bowl. The returned points end just before `to`.
pub fn connector(from: Pt, out_dir: (f64, f64), to: Pt, in_dir: (f64, f64), over: bool) -> Stroke {
    let len = from.dist(&to);
    if len < 1.0 {
        return vec![];
    }
    let onward = |(x, y): (f64, f64)| {
        let x = x.max(0.25);
        let l = (x * x + y * y).sqrt();
        (x / l, y / l)
    };
    let (dx, dy) = (to.x - from.x, to.y - from.y);
    let (c1, c2) = if over {
        ((from.x + 0.2 * dx, from.y + 0.85 * dy), (to.x - 0.5 * dx, to.y + 0.03 * dx.abs()))
    } else {
        let (o, i) = (onward(out_dir), onward(in_dir));
        let k = (0.12 * len).min(40.0);
        ((from.x + o.0 * k, from.y + o.1 * k), (to.x - i.0 * k, to.y - i.1 * k))
    };
    let n = ((len * 1.3) / 5.0).ceil().max(2.0) as usize;
    (0..n)
        .map(|j| {
            let t = j as f64 / n as f64;
            let u = 1.0 - t;
            let x = u * u * u * from.x + 3.0 * u * u * t * c1.0 + 3.0 * u * t * t * c2.0 + t * t * t * to.x;
            let y = u * u * u * from.y + 3.0 * u * u * t * c1.1 + 3.0 * u * t * t * c2.1 + t * t * t * to.y;
            Pt::new(x, y, from.p + (to.p - from.p) * t)
        })
        .collect()
}

/// The stroke end nearest to (x, y), if any is close (dots excluded).
pub fn end_at(strokes: &[Stroke], x: f64, y: f64) -> Option<(usize, bool)> {
    nearest_end(strokes, x, y, None)
}

/// The stroke a hand starts a letter with when it comes from the previous
/// one: the first real stroke in writing order, not a dot or a little dash
/// written first (the dot of «і», the bar of «ї» put on before the stem).
pub fn lead_stroke(strokes: &[Stroke]) -> Option<usize> {
    let longest = strokes.iter().map(|s| stroke_length(s)).fold(0.0, f64::max);
    strokes.iter().position(|s| s.len() >= 2 && stroke_length(s) >= DOT_LENGTH.max(0.35 * longest))
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
        let ink = synthesize(&[p], &model, Choice::Slot(0), Position::Any, &mut Rng::new(7), &style, &joins, true);
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
        let ink = synthesize(&[p], &model, Choice::Slot(0), Position::Any, &mut Rng::new(1), &Style::default(), &joins, true);
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
        let mid = synthesize(std::slice::from_ref(&p), &model, Choice::Slot(0), Position::Medial, &mut Rng::new(1), &style, &joins, true);
        let end = synthesize(std::slice::from_ref(&p), &model, Choice::Slot(0), Position::Final, &mut Rng::new(1), &style, &joins, true);
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
        let ink = synthesize(&[p], &model, Choice::Slot(0), Position::Medial, &mut Rng::new(1), &Style::default(), &joins, true);
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
        let mut ink = synthesize(&[p], &model, Choice::Slot(0), Position::Medial, &mut Rng::new(1), &style, &joins, true);
        let before = place(&ink, &strokes_bbox(&ink.strokes), &style);
        let body = strokes_bbox(&ink.strokes).x_max;
        assert!(stretch_entry(&mut ink, 120.0));
        let after = place(&ink, &strokes_bbox(&ink.strokes), &style);
        assert!((after.origin_x - (before.origin_x - 120.0)).abs() < 1e-6, "the pen now arrives 120 units earlier");
        assert!((strokes_bbox(&ink.strokes).x_max - body).abs() < 1e-6, "the letter itself is unchanged");
        assert!((ink.entry.unwrap().y - 60.0).abs() < 1e-6, "still on the join line");
    }

    fn of_form(entry: bool, exit: bool) -> Prepared {
        let s = sample(&wave(200.0), Some(Anchor { x: 0.0, y: 30.0, connect: entry }), Some(Anchor { x: 400.0, y: 30.0, connect: exit }));
        prepare(&s)
    }

    #[test]
    fn every_place_takes_its_own_form_first() {
        // 0, 1: start; 2, 3, 4: middle; 5: end; 6: alone.
        let forms = [(false, true), (false, true), (true, true), (true, true), (true, true), (true, false), (false, false)];
        let samples: Vec<Prepared> = forms.iter().map(|&(a, b)| of_form(a, b)).collect();
        assert_eq!(Position::Inside.pool(&samples), vec![2, 3, 4], "three of its own: nothing else");
        assert_eq!(Position::Initial.pool(&samples), vec![0, 1, 2, 3, 4], "two of its own, then the joining ones");
        assert_eq!(Position::End.pool(&samples), vec![5, 2, 3, 4, 6, 0, 1]);
        assert_eq!(Position::Single.pool(&samples), vec![6, 5, 0, 1, 2, 3, 4]);
        assert_eq!(Position::Medial.pool(&samples), vec![2, 3, 4]);
        // Only variants without an exit: the start of a word takes them after all.
        let ends: Vec<Prepared> = (0..2).map(|_| of_form(true, false)).collect();
        assert_eq!(Position::Initial.pool(&ends), vec![0, 1]);
    }

    #[test]
    fn a_lead_in_is_cut_at_the_start_of_a_word() {
        // A long lead-in from the left, then the letter: 400 units to the right of it.
        let mut pts: Vec<(f64, f64)> = (0..=30).map(|i| (i as f64 * 10.0, 30.0)).collect();
        pts.extend(wave(200.0).into_iter().map(|(x, y)| (x + 300.0, y)));
        let s = sample(&pts, Some(Anchor { x: 0.0, y: 30.0, connect: true }), Some(Anchor { x: 700.0, y: 30.0, connect: true }));
        let p = prepare(&s);
        let model = ShapeModel::fit(std::slice::from_ref(&p));
        let style = Style { jitter: 0.0, ..Style::default() };
        let joins = Joins { low: Some(30.0), high: Some(420.0) };
        let left = |pos: Position| {
            let ink = synthesize(std::slice::from_ref(&p), &model, Choice::Slot(0), pos, &mut Rng::new(1), &style, &joins, false);
            (strokes_bbox(&ink.strokes).x_min, ink.entry.is_some())
        };
        let (inside, joins_in) = left(Position::Inside);
        let (start, joins_start) = left(Position::Initial);
        assert!(joins_in && !joins_start);
        assert!(inside < 10.0 && start > 250.0, "lead-in kept inside a word, cut at its start: {inside} / {start}");

        // «м»: the stroke climbs from the line into the first leg — that is the letter, not a lead-in.
        let mut leg: Vec<(f64, f64)> = (0..=40).map(|i| (i as f64 * 3.0, 30.0 + i as f64 * 10.0)).collect();
        leg.extend((1..=40).map(|i| (120.0 + i as f64 * 3.0, 430.0 - i as f64 * 10.0)));
        let s = sample(&leg, Some(Anchor { x: 0.0, y: 30.0, connect: true }), Some(Anchor { x: 240.0, y: 30.0, connect: true }));
        let p = prepare(&s);
        let model = ShapeModel::fit(std::slice::from_ref(&p));
        let ink = synthesize(std::slice::from_ref(&p), &model, Choice::Slot(0), Position::Initial, &mut Rng::new(1), &style, &joins, false);
        assert!(ink.entry.is_none());
        assert!(strokes_bbox(&ink.strokes).x_min < 5.0, "the first leg stays: {}", strokes_bbox(&ink.strokes).x_min);
    }

    #[test]
    fn connecting_stroke_is_nearly_straight() {
        // Leaving a letter upwards, arriving along a lead-in that runs flat to the right.
        let (from, to) = (Pt::new(0.0, 30.0, 0.5), Pt::new(320.0, 240.0, 0.5));
        let line = connector(from, (0.3, 0.95), to, (1.0, 0.0), false);
        let len = from.dist(&to);
        let (dx, dy) = ((to.x - from.x) / len, (to.y - from.y) / len);
        let off = line.iter().map(|q| ((q.x - from.x) * dy - (q.y - from.y) * dx).abs()).fold(0.0, f64::max);
        assert!(off < 0.05 * len, "bows {off:.1} off a {len:.0} long straight line");
    }

    #[test]
    fn a_joined_end_loses_its_thinning() {
        let mut s: Stroke = (0..40).map(|i| Pt::new(i as f64 * 5.0, 0.0, 0.8)).collect();
        for (k, p) in s.iter_mut().take(4).enumerate() {
            p.p = 0.8 * (0.6 + 0.1 * k as f64);
        }
        s[20].p = 0.5;
        untaper(&mut s, true);
        assert!(s.iter().take(4).all(|p| (p.p - 0.8).abs() < 1e-9), "{:?}", s.iter().take(4).map(|p| p.p).collect::<Vec<_>>());
        assert_eq!(s[20].p, 0.5, "the rest of the stroke is untouched");
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
        let mut ink = synthesize(&[p], &model, Choice::Slot(0), Position::Any, &mut Rng::new(1), &style, &joins, true);
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
