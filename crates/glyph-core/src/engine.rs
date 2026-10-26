//! Stateful engine: holds the samples, caches synthesized glyphs per key
//! (adding a sample to "а" only rebuilds "а") and renders fonts and ink.
//!
//! A "key" is a single character or a recorded letter pair ("ст").

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use crate::derive::{self, Kind};
use crate::font::{build_font, round_contours, FontGlyph, FontOptions, KeyGlyphs};
use crate::geom::{strokes_bbox, BBox};
use crate::kern::{joined_overlap, joined_overlap_at, pair_kern, Profile};
use crate::model::*;
use crate::outline;
use crate::rng::{hash_str, mix, Rng};
use crate::shape_model::ShapeModel;
use crate::geom::{Pt, Stroke};
use crate::synth::{self, adapt_entry, stretch_entry, GlyphInk, Joins, Placement, Position, Prepared};

struct KeyData {
    signature: u64,
    prepared: Vec<Prepared>,
    model: ShapeModel,
    /// Some(source) when the key was built automatically.
    derived_from: Option<String>,
    cached: Option<CachedKey>,
}

/// Font glyphs of one key: word-initial forms, middle-of-word forms (when the
/// user wrote both kinds) and the joining forms adapted to the other join height.
#[derive(Clone, Default)]
struct CachedKey {
    variants: Vec<FontGlyph>,
    medial: Vec<FontGlyph>,
    alts: Vec<FontGlyph>,
    /// Stand-alone forms for abbreviations; empty when the letter never joins anyway.
    isolated: Vec<FontGlyph>,
}

pub struct EngineCore {
    style: Style,
    family: String,
    /// The user's own samples, prepared, per key.
    own: BTreeMap<String, (u64, Vec<Prepared>)>,
    keys: BTreeMap<String, KeyData>,
    joins: Joins,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewGlyph {
    /// SVG path, y down, origin at the glyph origin on the baseline.
    pub d: String,
    pub advance: f64,
    pub entry: Option<[f64; 2]>,
    pub exit: Option<[f64; 2]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleOutline {
    /// SVG path, y down, in the sample's own coordinates.
    pub d: String,
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
}

#[derive(Serialize)]
pub struct FallbackChar {
    pub ch: String,
    pub x: f64,
    pub y: f64,
    /// Line of the paragraph this character is on.
    pub line: usize,
    pub scale: f64,
    pub color: u8,
}

/// Ink of one colour on one line.
#[derive(Serialize, Clone, Default)]
pub struct ColorPath {
    pub color: u8,
    pub d: String,
}

/// Per-character size, colour and raise of a paragraph (empty = default for all).
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct CharStyles {
    /// Size factor per character (1 = normal).
    pub scales: Vec<f64>,
    /// Ink colour index per character (0 = the document ink).
    pub colors: Vec<u8>,
    /// Raise above the baseline per character, in em (superscript > 0, subscript < 0).
    pub shifts: Vec<f64>,
    /// How many times each word of this paragraph already occurred earlier in
    /// the document, so a «1.» or «і» repeated in every paragraph still
    /// gets a different instance each time.
    pub seen: HashMap<String, u64>,
}

/// Size, colour index and raise (font units, up) of one character.
#[derive(Clone, Copy)]
struct CharStyle {
    scale: f64,
    color: u8,
    shift: f64,
}

impl Default for CharStyle {
    fn default() -> Self {
        CharStyle { scale: 1.0, color: 0, shift: 0.0 }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphRender {
    pub width: f64,
    pub height: f64,
    pub lines: usize,
    pub d: String,
    /// The same ink split per line and colour (same coordinates), so lines can flow onto pages.
    pub line_d: Vec<Vec<ColorPath>>,
    pub missing: Vec<String>,
    /// Characters without samples, to be drawn with a fallback font (y down, on the baseline).
    pub fallback: Vec<FallbackChar>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedInfo {
    pub key: String,
    pub from: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    /// Keys written by the user.
    pub chars: Vec<String>,
    /// Keys built automatically from other letters.
    pub derived: Vec<DerivedInfo>,
    pub join_low: Option<f64>,
    pub join_high: Option<f64>,
    /// Learned directions of variation, per key.
    pub learned: BTreeMap<String, usize>,
}

impl Default for EngineCore {
    fn default() -> Self {
        Self::new()
    }
}

/// Keys are 1–3 characters; longer strings are not letters or pairs.
fn valid_key(k: &str) -> bool {
    (1..=3).contains(&k.chars().count())
}

impl EngineCore {
    pub fn new() -> Self {
        EngineCore {
            style: Style::default(),
            family: "Handwriting".into(),
            own: BTreeMap::new(),
            keys: BTreeMap::new(),
            joins: Joins::default(),
        }
    }

    pub fn set_family(&mut self, family: &str) {
        self.family = family.to_string();
    }

    pub fn set_style(&mut self, style: Style) {
        let glyphs_changed = style.glyph_key() != self.style.glyph_key();
        let derive_changed = style.derive != self.style.derive;
        self.style = style;
        if derive_changed {
            self.rebuild_keys();
        }
        if glyphs_changed {
            self.keys.values_mut().for_each(|k| k.cached = None);
        }
    }

    /// Replace the whole sample set; only keys whose samples changed are rebuilt.
    pub fn set_samples(&mut self, samples: Vec<Sample>) {
        let mut groups: BTreeMap<String, Vec<Sample>> = BTreeMap::new();
        for s in samples {
            if valid_key(&s.ch) && !s.strokes.iter().all(|st| st.is_empty()) {
                groups.entry(s.ch.clone()).or_default().push(s);
            }
        }
        self.own.retain(|k, _| groups.contains_key(k));
        for (k, group) in groups {
            let signature = hash_str(&serde_json::to_string(&group).unwrap_or_default());
            if self.own.get(&k).is_some_and(|(sig, _)| *sig == signature) {
                continue;
            }
            self.own.insert(k, (signature, group.iter().map(synth::prepare).collect()));
        }
        self.rebuild_keys();
    }

    /// Compose own + derived keys, keeping caches whose inputs did not change.
    fn rebuild_keys(&mut self) {
        let mut next: BTreeMap<String, (u64, Vec<Prepared>, Option<String>)> = BTreeMap::new();
        for (k, (sig, prepared)) in &self.own {
            match self.pair_in_scale(k, prepared) {
                // No variant of the pair fits its letters' size: they are written one by one.
                Some((_, kept)) if kept.is_empty() => {}
                Some((letters, kept)) => {
                    next.insert(k.clone(), (mix(*sig, letters), kept, None));
                }
                None => {
                    next.insert(k.clone(), (*sig, prepared.clone(), None));
                }
            }
        }
        if self.style.derive {
            for &(target, source, kind) in derive::RULES {
                if next.contains_key(target) {
                    continue;
                }
                if let Some((sig, prepared, _)) = next.get(source) {
                    let sig = mix(mix(*sig, hash_str(target)), kind_id(kind));
                    let derived = derive::derive(kind, prepared);
                    next.insert(target.to_string(), (sig, derived, Some(source.to_string())));
                }
            }
            for &mark in derive::PUNCTUATION {
                if !next.contains_key(mark) {
                    if let Some(p) = derive::punctuation(mark) {
                        next.insert(mark.to_string(), (hash_str(mark), p, Some("перо".to_string())));
                    }
                }
            }
        }
        let mut old = std::mem::take(&mut self.keys);
        for (k, (signature, prepared, derived_from)) in next {
            let data = match old.remove(&k) {
                Some(d) if d.signature == signature => KeyData { derived_from, ..d },
                _ => {
                    let model = ShapeModel::fit(&prepared);
                    KeyData { signature, prepared, model, derived_from, cached: None }
                }
            };
            self.keys.insert(k, data);
        }
        let all: Vec<&Prepared> =
            self.keys.values().filter(|d| d.derived_from.is_none()).flat_map(|d| d.prepared.iter()).collect();
        let joins = synth::join_lines(&all);
        if joins != self.joins {
            self.joins = joins;
            self.keys.values_mut().for_each(|k| k.cached = None);
        }
    }

    /// A letter pair keeps only the variants written at the size of its own
    /// letters: a pair «на» with a capital-high «Н» would stand out in the
    /// text. `None` for single letters (and pairs whose letters were never
    /// written alone); otherwise the signature of those letters and the
    /// variants kept (possibly none: then the letters are used one by one).
    fn pair_in_scale(&self, key: &str, prepared: &[Prepared]) -> Option<(u64, Vec<Prepared>)> {
        let top = |p: &Prepared| strokes_bbox(&p.strokes).y_max;
        let median = |v: &mut Vec<f64>| {
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v[v.len() / 2]
        };
        if key.chars().count() < 2 {
            return None;
        }
        let mut sig = 0u64;
        let mut expected = f64::NEG_INFINITY;
        for c in key.chars() {
            let (s, letters) = self.own.get(&c.to_string())?;
            let mut tops: Vec<f64> = letters.iter().map(top).collect();
            if tops.is_empty() {
                return None;
            }
            expected = expected.max(median(&mut tops));
            sig = mix(sig, *s);
        }
        let kept = prepared.iter().filter(|p| (0.7 * expected..=1.2 * expected).contains(&top(p))).cloned().collect();
        Some((sig, kept))
    }

    pub fn info(&self) -> EngineInfo {
        EngineInfo {
            chars: self.keys.iter().filter(|(_, d)| d.derived_from.is_none()).map(|(k, _)| k.clone()).collect(),
            derived: self
                .keys
                .iter()
                .filter_map(|(k, d)| d.derived_from.as_ref().map(|from| DerivedInfo { key: k.clone(), from: from.clone() }))
                .collect(),
            join_low: self.joins.low,
            join_high: self.joins.high,
            learned: self.keys.iter().map(|(k, d)| (k.clone(), d.model.components())).collect(),
        }
    }

    fn finish(&self, ink: &GlyphInk) -> (Vec<Vec<[f64; 2]>>, Placement) {
        let discs = outline::discs(ink, &self.style);
        let bbox = outline::ink_bbox(&discs);
        let polys = outline::polygons(&discs);
        (polys, synth::place(ink, &bbox, &self.style))
    }

    /// Outline, placement and kerning profile of a letter at a size factor
    /// (scaled around its origin on the baseline).
    fn placed(&self, ink: &GlyphInk, scale: f64) -> (Vec<Vec<[f64; 2]>>, Placement, Profile) {
        let (mut polys, mut pl) = self.finish(ink);
        if (scale - 1.0).abs() > 1e-6 {
            for c in polys.iter_mut() {
                for p in c.iter_mut() {
                    *p = [pl.origin_x + (p[0] - pl.origin_x) * scale, p[1] * scale];
                }
            }
            pl.advance *= scale;
        }
        let profile = Profile::of(&polys, -pl.origin_x);
        (polys, pl, profile)
    }

    fn font_glyph(&self, ink: &GlyphInk) -> FontGlyph {
        let (polys, pl) = self.finish(ink);
        FontGlyph {
            contours: round_contours(&polys, -pl.origin_x),
            advance: pl.advance.round().clamp(1.0, 4000.0) as u16,
            entry: ink.entry.map(|j| j.level),
            exit: ink.exit.map(|j| j.level),
        }
    }

    fn space_advance(&self, rng: &mut Rng) -> f64 {
        (self.style.word_spacing * (1.0 + rng.gauss() * 0.12 * self.style.jitter)).max(40.0)
    }

    fn key_seed(&self, key: &str) -> u64 {
        mix(self.style.seed as u64, hash_str(key))
    }

    /// N variants of a key. When the user wrote both variants without a joining
    /// entry and variants that join on the left, the first ones start words and
    /// the others go in the middle (the font switches after any letter). The
    /// joining forms are also built entering at the other join height.
    fn key_glyphs(&self, key: &str, data: &KeyData) -> CachedKey {
        let n = self.style.variants.clamp(1, 31);
        let seed = self.key_seed(key);
        let topo: Vec<_> = data.prepared.iter().map(|p| p.topology()).collect();
        let split = topo.iter().any(|t| t.entry.is_none()) && topo.iter().any(|t| t.entry.is_some());
        let make = |position: Position, salt: u64| -> Vec<GlyphInk> {
            (0..n)
                .map(|k| {
                    let mut rng = Rng::new(mix(mix(seed, salt), k as u64));
                    synth::synthesize(&data.prepared, &data.model, Some(k), position, &mut rng, &self.style, &self.joins, true)
                })
                .collect()
        };
        let initial = make(if split { Position::Initial } else { Position::Any }, 0);
        let medial = if split { make(Position::Medial, 1) } else { vec![] };
        let variants: Vec<FontGlyph> = initial.iter().map(|ink| self.font_glyph(ink)).collect();
        let medial_glyphs: Vec<FontGlyph> = medial.iter().map(|ink| self.font_glyph(ink)).collect();

        // Joining forms: the middle-of-word ones when they exist, otherwise the only set.
        let (joining, joining_glyphs) = if split { (&medial, &medial_glyphs) } else { (&initial, &variants) };
        let joins_left = joining.iter().filter(|i| i.entry.is_some()).count() * 2 > joining.len();
        let alts = if joins_left && self.joins.low.is_some() && self.joins.high.is_some() {
            joining
                .iter()
                .zip(joining_glyphs)
                .map(|(ink, base)| {
                    let mut alt = ink.clone();
                    match ink.entry {
                        Some(e) if adapt_entry(&mut alt, e.level.other(), &self.joins) => self.font_glyph(&alt),
                        _ => base.clone(),
                    }
                })
                .collect()
        } else {
            vec![]
        };
        // Abbreviations need a form that joins nothing — only worth it for letters that do join.
        let joins_somewhere = variants.iter().chain(&medial_glyphs).any(|g| g.entry.is_some() || g.exit.is_some());
        let isolated = if key.chars().all(char::is_alphabetic) && joins_somewhere {
            make(Position::Isolated, 2).iter().map(|ink| self.font_glyph(ink)).collect()
        } else {
            vec![]
        };
        CachedKey { variants, medial: medial_glyphs, alts, isolated }
    }

    pub fn build_font(&mut self) -> Result<Vec<u8>, String> {
        let todo: Vec<String> = self.keys.iter().filter(|(_, d)| d.cached.is_none()).map(|(k, _)| k.clone()).collect();
        for k in todo {
            let glyphs = self.key_glyphs(&k, &self.keys[&k]);
            self.keys.get_mut(&k).unwrap().cached = Some(glyphs);
        }
        let n = self.style.variants.clamp(1, 31);
        let mut list: Vec<KeyGlyphs> = self
            .keys
            .iter()
            .filter(|(k, _)| self.style.pairs || k.chars().count() == 1)
            .map(|(k, d)| {
                let c = d.cached.clone().unwrap_or_default();
                KeyGlyphs { key: k.clone(), variants: c.variants, medial: c.medial, alts: c.alts, isolated: c.isolated }
            })
            .collect();
        for space in [" ", "\u{a0}"] {
            if !self.keys.contains_key(space) {
                let mut rng = Rng::new(self.key_seed(" "));
                let variants = (0..n)
                    .map(|_| FontGlyph { advance: self.space_advance(&mut rng).round() as u16, ..Default::default() })
                    .collect();
                list.push(KeyGlyphs { key: space.to_string(), variants, medial: vec![], alts: vec![], isolated: vec![] });
            }
        }
        let opts = FontOptions {
            family: self.family.clone(),
            variants: n,
            kerning: self.style.kerning,
            letter_spacing: self.style.letter_spacing,
        };
        build_font(&opts, &list)
    }

    /// Fresh random instances of one key, for the studio preview.
    pub fn preview(&self, key: &str, count: usize, seed: u32) -> Vec<PreviewGlyph> {
        let Some(data) = self.keys.get(key) else { return vec![] };
        (0..count.min(64))
            .map(|i| {
                let mut rng = Rng::new(mix(mix(self.key_seed(key), seed as u64), i as u64));
                let ink = synth::synthesize(&data.prepared, &data.model, None, Position::Any, &mut rng, &self.style, &self.joins, true);
                let (polys, pl) = self.finish(&ink);
                let mut d = String::new();
                outline::svg_path(&polys, -pl.origin_x, 0.0, true, &mut d);
                PreviewGlyph {
                    d,
                    advance: pl.advance,
                    entry: ink.entry.map(|j| [j.x - pl.origin_x, -j.y]),
                    exit: ink.exit.map(|j| [j.x - pl.origin_x, -j.y]),
                }
            })
            .collect()
    }

    /// Outline of a single recorded sample, without any variation.
    pub fn sample_outline(&self, sample: &Sample) -> SampleOutline {
        let p = synth::prepare(sample);
        let ink = GlyphInk { strokes: p.strokes, entry: None, exit: None };
        let discs = outline::discs(&ink, &self.style);
        let polys = outline::polygons(&discs);
        let b = if discs.is_empty() { strokes_bbox(&ink.strokes) } else { outline::ink_bbox(&discs) };
        let mut d = String::new();
        outline::svg_path(&polys, 0.0, 0.0, true, &mut d);
        let b = if b.is_empty() { BBox { x_min: 0.0, y_min: 0.0, x_max: 0.0, y_max: 0.0 } } else { b };
        SampleOutline { d, x_min: b.x_min, x_max: b.x_max, y_min: -b.y_max, y_max: -b.y_min }
    }

    /// "Ink" rendering of a paragraph: every letter is a unique instance and the
    /// lines are uneven like real handwriting. Units are font units, y down, the
    /// first baseline at `ASCENDER`.
    ///
    /// Randomness is seeded by the words themselves and how often each occurred
    /// before (plus `seed`, per document), so editing one word never
    /// re-shuffles the letters of the others.
    pub fn render_paragraph(
        &self,
        text: &str,
        width: f64,
        line_height: f64,
        seed: u32,
        fallback_widths: &HashMap<String, f64>,
        styles: &CharStyles,
    ) -> ParagraphRender {
        struct Word {
            items: Vec<Item>,
            seed: u64,
            hash: u64,
            space_after: f64,
        }

        let style = &self.style;
        let doc_seed = mix(seed as u64, style.seed as u64);
        let mut missing: Vec<String> = Vec::new();
        let mut seen: HashMap<u64, u64> = HashMap::new();
        let chars: Vec<char> = text.chars().collect();
        let mut words: Vec<Word> = Vec::new();
        let mut i = 0;
        while i < chars.len() {
            if chars[i].is_whitespace() {
                // Leading spaces become a word without letters.
                if words.is_empty() {
                    words.push(Word { items: vec![], seed: doc_seed, hash: 0, space_after: 0.0 });
                }
                let last = words.last_mut().unwrap();
                let mut rng = Rng::new(mix(last.seed, 0x5ace));
                last.space_after += self.space_advance(&mut rng);
                i += 1;
                continue;
            }
            let end = (i..chars.len()).find(|&k| chars[k].is_whitespace()).unwrap_or(chars.len());
            let word: String = chars[i..end].iter().collect();
            let hash = hash_str(&word);
            let occurrence = seen.entry(hash).or_insert_with(|| styles.seen.get(&word).copied().unwrap_or(0));
            let wseed = mix(mix(doc_seed, hash), *occurrence);
            *occurrence += 1;
            let char_style = |k: usize| CharStyle {
                scale: styles.scales.get(k).copied().unwrap_or(1.0).clamp(0.3, 4.0),
                color: styles.colors.get(k).copied().unwrap_or(0),
                shift: styles.shifts.get(k).copied().unwrap_or(0.0).clamp(-2.0, 2.0) * UNITS_PER_EM as f64,
            };
            let word_styles: Vec<CharStyle> = (i..end).map(char_style).collect();
            let items = self.word_items(&chars[i..end], wseed, fallback_widths, &mut missing, &word_styles);
            words.push(Word { items, seed: wseed, hash, space_after: 0.0 });
            i = end;
        }

        // Greedy line breaking on spaces; over-long words break anywhere.
        let word_width = |w: &Word| w.items.iter().map(|it| it.advance).sum::<f64>();
        let mut lines: Vec<Vec<(usize, usize, f64)>> = vec![vec![]]; // (word, item, x)
        let mut line_words: Vec<Vec<usize>> = vec![vec![]];
        let mut x = 0.0;
        for (wi, w) in words.iter().enumerate() {
            let ww = word_width(w);
            if x > 0.0 && x + ww > width {
                lines.push(vec![]);
                line_words.push(vec![]);
                x = 0.0;
            }
            line_words.last_mut().unwrap().push(wi);
            for (ii, item) in w.items.iter().enumerate() {
                if x > 0.0 && x + item.advance > width && ww > width {
                    lines.push(vec![]);
                    line_words.push(vec![wi]);
                    x = 0.0;
                }
                lines.last_mut().unwrap().push((wi, ii, x));
                x += item.advance;
            }
            x += w.space_after;
        }

        // Uneven lines: random line spacing, a droop along each line, words and
        // letters sagging below the ruling, plus the gentle wobble.
        let top = ASCENDER as f64;
        let j = style.jitter;
        let mut line_d: Vec<Vec<ColorPath>> = vec![vec![]; lines.len()];
        let mut fallback = Vec::new();
        let mut max_baseline = top;
        for (li, line) in lines.iter().enumerate() {
            let first_hash = line_words[li].first().map(|&w| words[w].hash).unwrap_or(0);
            let mut rng = Rng::new(mix(mix(doc_seed ^ 0x5eed_11e5, first_hash), li as u64));
            let offset = rng.gauss() * style.line_jitter * 0.12 * line_height;
            let droop = style.sag * rng.range(-0.25, 1.0) * 0.3 * line_height / width.max(1.0);
            let amp = 6.0 * j;
            let freq = rng.range(0.0015, 0.003);
            let phase = rng.range(0.0, std::f64::consts::TAU);
            let indent = (rng.gauss() * 6.0 * j).abs();
            let baseline = top + li as f64 * line_height + offset;
            max_baseline = max_baseline.max(baseline + style.sag * 0.3 * line_height);
            let mut word_drop: HashMap<usize, (f64, f64)> = HashMap::new();
            for &(wi, ii, x) in line {
                let (wdrop, wslide) = *word_drop.entry(wi).or_insert_with(|| {
                    let mut r = Rng::new(mix(words[wi].seed, 0xd409));
                    (style.sag * r.f64() * 60.0, style.sag * r.range(0.3, 1.0) * 70.0)
                });
                let item = &words[wi].items[ii];
                let gx = x + indent;
                let (k, len) = item.pos;
                let in_word = wslide * k as f64 / (len.max(2) - 1) as f64;
                let y = baseline + droop * gx + wdrop + in_word - amp * (freq * gx + phase).sin() - item.shift;
                if let Some(ch) = &item.fallback {
                    fallback.push(FallbackChar { ch: ch.clone(), x: gx, y, line: li, scale: item.scale, color: item.color });
                }
                if !item.polys.is_empty() {
                    let parts = &mut line_d[li];
                    let at = match parts.iter().position(|p| p.color == item.color) {
                        Some(at) => at,
                        None => {
                            parts.push(ColorPath { color: item.color, d: String::new() });
                            parts.len() - 1
                        }
                    };
                    outline::svg_path(&item.polys, gx - item.origin, y, true, &mut parts[at].d);
                }
            }
        }
        let n_lines = lines.len().max(1);
        ParagraphRender {
            width,
            height: max_baseline + (-DESCENDER) as f64,
            lines: n_lines,
            d: line_d.iter().flatten().map(|p| p.d.as_str()).collect(),
            line_d,
            missing,
            fallback,
        }
    }

    /// A letter joined the font's way: its entry already sits on a join line;
    /// adapted to the other line after a letter that leaves there, and drawn
    /// longer when the two letters would still collide.
    fn snapped_ink(&self, ink: &mut GlyphInk, prev_exit: Option<Level>, prev_profile: Option<&(Profile, f64)>, scale: f64) -> Placed {
        let style = &self.style;
        if let (Some(level), Some(e)) = (prev_exit, ink.entry) {
            if e.level != level {
                adapt_entry(ink, level, &self.joins);
            }
        }
        let joined = prev_exit.is_some() && ink.entry.is_some();
        let (mut polys, mut pl, mut profile) = self.placed(ink, scale);
        if let (true, Some((pp, padv)), Some(e)) = (joined, prev_profile, ink.entry) {
            let (_, right_rel) = Profile::envelope(&[(pp.clone(), *padv)]);
            let need = joined_overlap(&right_rel, &profile.left, e.y * scale, style.weight + 70.0, (style.weight * 0.4).max(8.0));
            if need > 6.0 && stretch_entry(ink, (need / scale).min(400.0)) {
                (polys, pl, profile) = self.placed(ink, scale);
            }
        }
        Placed { polys, origin: pl.origin_x, advance: pl.advance, profile, joined, exit: None }
    }

    /// A letter as it was written, joined to the previous one by the stroke a
    /// hand would draw: from that letter's real exit to this one's real start —
    /// its lead-in when it has one, otherwise (`bridge`) the first point of the
    /// letter. A start inside the letter's own width (the top of the bowl of
    /// «а», «d», «о») is reached over the top of the bowl. Nothing is bent.
    fn joined_ink(&self, ink: &mut GlyphInk, bridge: bool, prev: Option<Exit>, prev_profile: Option<&(Profile, f64)>, scale: f64) -> Placed {
        let style = &self.style;
        let sb = style.letter_spacing;
        let radius = style.weight / 2.0;
        // Where the pen arrives: (stroke, at its start?, written lead-in?).
        let start = prev.and_then(|_| match ink.entry {
            Some(e) => synth::end_at(&ink.strokes, e.x, e.y).map(|(si, at)| (si, at, true)),
            None if bridge => synth::lead_stroke(&ink.strokes).map(|si| (si, true, false)),
            None => None,
        });
        let mut joined = false;
        let origin = match (prev, start) {
            (Some(p), Some((si, at_start, written))) => {
                let py = p.y / scale;
                let end = |s: &Stroke, at: bool| if at { s[0] } else { s[s.len() - 1] };
                // A lead-in rising from below where the pen arrives starts where it reaches it (after «о»).
                if written && py > end(&ink.strokes[si], at_start).y + 60.0 {
                    let s = &mut ink.strokes[si];
                    if !at_start {
                        s.reverse();
                    }
                    // Only a real lead-in: never the loop of «l» or the stem of the letter itself.
                    synth::trim_lead_in(s, py, 0.4);
                    if !at_start {
                        s.reverse();
                    }
                }
                let e = end(&ink.strokes[si], at_start);
                let body = strokes_bbox(&ink.strokes);
                let over = e.x > body.x_min + (0.3 * body.width()).max(60.0);
                let g0 = (sb * 0.4).max(12.0);
                // The pen needs room to climb or drop to the start.
                let mut origin = e.x - (g0 + 0.35 * (e.y - py).abs()) / scale;
                if over {
                    origin = origin.min(body.x_min - radius - g0 / scale);
                }
                // The letters themselves must not run into each other.
                if let Some((pp, padv)) = prev_profile {
                    let (_, right_rel) = Profile::envelope(&[(pp.clone(), *padv)]);
                    let left = Profile::of_strokes(&ink.strokes, radius, -origin, scale).left;
                    let need = joined_overlap_at(&right_rel, &left, &[p.y, e.y * scale], style.weight + 40.0, (style.weight * 0.4).max(8.0));
                    origin -= need.min(400.0) / scale;
                }
                let s = &ink.strokes[si];
                let from = Pt::new(origin, py, p.p);
                let inward = {
                    let o = synth::outward(s, at_start);
                    (-o.0, -o.1)
                };
                // Arriving into a lead-in: along it. Into a stroke that turns back or drops: straight at it.
                let in_dir = if inward.0 > 0.3 {
                    inward
                } else {
                    let (dx, dy) = (e.x - from.x, e.y - from.y);
                    let l = (dx * dx + dy * dy).sqrt().max(1e-9);
                    (dx / l, dy / l)
                };
                let lead = synth::connector(from, p.dir, e, in_dir, over);
                let s = &mut ink.strokes[si];
                if at_start {
                    s.splice(0..0, lead);
                } else {
                    s.extend(lead.into_iter().rev());
                }
                joined = true;
                origin
            }
            _ => f64::NAN,
        };
        let discs = outline::discs(ink, style);
        let bbox = outline::ink_bbox(&discs);
        let mut polys = outline::polygons(&discs);
        let origin = if origin.is_nan() { synth::place(ink, &bbox, style).origin_x } else { origin };
        let right = match ink.exit {
            Some(x) => x.x,
            None if bbox.is_empty() => origin + (sb * 2.0).max(100.0),
            None => bbox.x_max + sb,
        };
        if (scale - 1.0).abs() > 1e-6 {
            for c in polys.iter_mut() {
                for q in c.iter_mut() {
                    *q = [origin + (q[0] - origin) * scale, q[1] * scale];
                }
            }
        }
        let advance = ((right - origin) * scale).max(20.0);
        let profile = Profile::of(&polys, -origin);
        // Where the next letter's connecting stroke starts.
        let exit = ink.exit.and_then(|x| synth::end_at(&ink.strokes, x.x, x.y)).map(|(si, at)| {
            let s = &ink.strokes[si];
            let q = if at { s[0] } else { s[s.len() - 1] };
            Exit { y: q.y * scale, dir: synth::outward(s, at), p: q.p, scale, shift: 0.0 }
        });
        Placed { polys, origin, advance, profile, joined, exit }
    }

    /// Letters of one word: pairs where recorded, joins adapted to the
    /// neighbour's exit height, optical kerning between letters that do not join.
    fn word_items(
        &self,
        chars: &[char],
        wseed: u64,
        fallback_widths: &HashMap<String, f64>,
        missing: &mut Vec<String>,
        char_styles: &[CharStyle],
    ) -> Vec<Item> {
        let style = &self.style;
        let mut out: Vec<Item> = Vec::new();
        let mut prev_exit: Option<Level> = None;
        let mut prev_join: Option<Exit> = None;
        let mut prev_profile: Option<(Profile, f64)> = None;
        let mut i = 0;
        let letters = chars.len();
        let isolated = |i: usize| abbreviation_letter(chars, i);
        // Ink joins letters by connecting strokes; the font's way (bending ends onto two lines) otherwise.
        let bridged = style.bridge && style.connect;
        while i < chars.len() {
            let mut rng = Rng::new(mix(wseed, i as u64));
            let CharStyle { scale, color, shift } = char_styles.get(i).copied().unwrap_or_default();
            // Prefer a recorded pair (3, then 2 letters) most of the time — not inside abbreviations.
            let mut take = 1;
            if style.pairs && !isolated(i) && rng.f64() < 0.75 {
                for len in [3, 2] {
                    if i + len <= chars.len() {
                        let k: String = chars[i..i + len].iter().collect();
                        if self.keys.get(&k).is_some_and(|d| d.derived_from.is_none()) {
                            take = len;
                            break;
                        }
                    }
                }
            }
            let key: String = chars[i..i + take].iter().collect();
            let pos = (i, letters);
            match self.keys.get(&key) {
                Some(data) => {
                    // Abbreviation letters stand alone; the first letter of a word prefers
                    // variants written without a joining entry; the last letter goes without
                    // a tail. Inside a word ink takes any variant (the connecting stroke joins
                    // it); the font only those written to join on the left.
                    let letter = key.chars().all(char::is_alphabetic);
                    let after_letter = i > 0 && chars[i - 1].is_alphabetic();
                    let before_letter = chars.get(i + take).is_some_and(|c| c.is_alphabetic());
                    let position = if isolated(i) {
                        Position::Isolated
                    } else if letter && !before_letter {
                        match (after_letter, bridged) {
                            (false, _) => Position::Single,
                            (true, true) => Position::End,
                            (true, false) => Position::Final,
                        }
                    } else if !after_letter {
                        Position::Initial
                    } else if bridged {
                        Position::Inside
                    } else {
                        Position::Medial
                    };
                    let mut ink = synth::synthesize(&data.prepared, &data.model, None, position, &mut rng, style, &self.joins, !bridged);
                    let placed = if bridged {
                        // Only lowercase letters take a connecting stroke into a start written without a lead-in.
                        let lowercase = letter && !key.chars().any(char::is_uppercase);
                        let prev = prev_join.filter(|p| (p.scale - scale).abs() < 1e-6 && (p.shift - shift).abs() < 1e-6);
                        self.joined_ink(&mut ink, lowercase, prev, prev_profile.as_ref(), scale)
                    } else {
                        self.snapped_ink(&mut ink, prev_exit, prev_profile.as_ref(), scale)
                    };
                    if let (false, true, Some((pp, padv))) = (placed.joined, style.kerning, prev_profile.as_ref()) {
                        let (_, right_rel) = Profile::envelope(&[(pp.clone(), *padv)]);
                        let k = pair_kern(&right_rel, &placed.profile.left, style.letter_spacing);
                        if let Some(last) = out.last_mut() {
                            last.advance += k;
                        }
                    }
                    prev_exit = ink.exit.map(|j| j.level);
                    prev_join = placed.exit.map(|e| Exit { scale, shift, ..e });
                    prev_profile = Some((placed.profile, placed.advance));
                    out.push(Item { polys: placed.polys, origin: placed.origin, advance: placed.advance, fallback: None, pos, scale, color, shift });
                }
                None => {
                    let s = key.clone();
                    // Measured width of the fallback glyph, or a rough guess.
                    let advance = fallback_widths
                        .get(&s)
                        .copied()
                        .unwrap_or(if chars[i].is_alphanumeric() { 560.0 } else { 320.0 })
                        * scale;
                    if !missing.contains(&s) {
                        missing.push(s.clone());
                    }
                    prev_exit = None;
                    prev_join = None;
                    prev_profile = None;
                    out.push(Item { polys: vec![], origin: 0.0, advance, fallback: Some(s), pos, scale, color, shift });
                }
            }
            i += take;
        }
        // Before a space: ink past the last letter's advance (a joining exit inside a
        // loop) must not eat the space.
        if let (Some(last), Some((profile, advance))) = (out.last_mut(), prev_profile) {
            let right = profile.right.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let overhang = right - advance + style.letter_spacing;
            if overhang > 0.0 {
                last.advance += overhang;
            }
        }
        out
    }
}

/// Where a letter leaves towards the next one (ink joins): the height in
/// font units above the baseline, the direction the pen moves, its pressure,
/// and the letter's size and raise (only letters alike are joined).
#[derive(Clone, Copy)]
struct Exit {
    y: f64,
    dir: (f64, f64),
    p: f64,
    scale: f64,
    shift: f64,
}

/// A letter laid out in ink: outline, origin and advance, kerning profile,
/// whether it joined the previous letter, and where it leaves to the next.
struct Placed {
    polys: Vec<Vec<[f64; 2]>>,
    origin: f64,
    advance: f64,
    profile: Profile,
    joined: bool,
    exit: Option<Exit>,
}

/// One placed letter (or pair) of the ink renderer.
struct Item {
    polys: Vec<Vec<[f64; 2]>>,
    origin: f64,
    advance: f64,
    fallback: Option<String>,
    /// Index of the letter inside its word and the word's length (for sag).
    pos: (usize, usize),
    scale: f64,
    color: u8,
    /// Raise above the baseline in font units (indices).
    shift: f64,
}

/// Letter `i` of a word is part of an abbreviation: capitals next to capitals
/// (СССР) or a letter at a dot (т.е., А.С.). Same rules as the font's GSUB.
fn abbreviation_letter(chars: &[char], i: usize) -> bool {
    let c = chars[i];
    if !c.is_alphabetic() {
        return false;
    }
    let cap = |c: char| c.is_alphabetic() && c.is_uppercase();
    let prev = i.checked_sub(1).map(|j| chars[j]);
    let next = chars.get(i + 1).copied();
    prev == Some('.')
        || (cap(c) && (prev.is_some_and(cap) || next.is_some_and(cap)))
        || (next == Some('.') && !prev.is_some_and(char::is_alphabetic))
}

fn kind_id(kind: Kind) -> u64 {
    match kind {
        Kind::Copy => 1,
        Kind::Capital => 2,
        Kind::Breve { cap } => 3 + cap as u64,
        Kind::Dots { cap } => 5 + cap as u64,
        Kind::SwapDots => 7,
        Kind::Bar { cap } => 8 + cap as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wave_sample(id: &str, ch: &str, h: f64, connect: bool) -> Sample {
        Sample {
            id: id.into(),
            ch: ch.into(),
            strokes: vec![(0..=60)
                .map(|i| {
                    let t = i as f64 / 60.0;
                    InkPoint { x: t * 300.0, y: 30.0 + h * (t * std::f64::consts::PI * 2.0).sin().abs(), t: i as f64 * 6.0, p: 0.5 }
                })
                .collect()],
            entry: Some(Anchor { x: 0.0, y: 30.0, connect }),
            exit: Some(Anchor { x: 300.0, y: 30.0, connect }),
            pointer_type: Some("mouse".into()),
        }
    }

    fn shape(font: &[u8], text: &str) -> Vec<u32> {
        let face = rustybuzz::Face::from_slice(font, 0).unwrap();
        let mut buf = rustybuzz::UnicodeBuffer::new();
        buf.push_str(text);
        rustybuzz::shape(&face, &[], buf).glyph_infos().iter().map(|g| g.glyph_id).collect()
    }

    #[test]
    fn engine_builds_font_and_caches_per_key() {
        let mut e = EngineCore::new();
        e.set_samples(vec![wave_sample("1", "м", 300.0, true), wave_sample("2", "м", 320.0, true), wave_sample("3", "о", 250.0, true)]);
        let font = e.build_font().unwrap();
        let ids = shape(&font, "мом мм");
        assert_eq!(ids.len(), 6);
        assert!(ids.iter().all(|&g| g != 0), "all glyphs mapped");
        e.set_samples(vec![wave_sample("1", "м", 300.0, true), wave_sample("2", "м", 320.0, true), wave_sample("4", "о", 260.0, true)]);
        assert!(e.keys["м"].cached.is_some());
        assert!(e.keys["о"].cached.is_none());
        // Layout-only style changes keep the cache.
        e.set_style(Style { sag: 0.9, line_jitter: 0.9, ..Style::default() });
        assert!(e.keys["м"].cached.is_some());
    }

    #[test]
    fn missing_letters_are_derived_and_own_samples_win() {
        let mut e = EngineCore::new();
        e.set_samples(vec![wave_sample("1", "и", 300.0, true), wave_sample("2", "о", 250.0, false)]);
        let info = e.info();
        let derived: Vec<&str> = info.derived.iter().map(|d| d.key.as_str()).collect();
        for k in ["й", "О", "o", "O", ".", ","] {
            assert!(derived.contains(&k), "{k} derived: {derived:?}");
        }
        // Ukrainian: і from Latin i, then ї from і.
        e.set_samples(vec![wave_sample("1", "и", 300.0, true), wave_sample("5", "i", 300.0, false), wave_sample("6", "с", 200.0, false)]);
        let derived: Vec<String> = e.info().derived.into_iter().map(|d| d.key).collect();
        for k in ["і", "ї", "є", "Є"] {
            assert!(derived.iter().any(|d| d == k), "{k} derived: {derived:?}");
        }
        e.set_samples(vec![wave_sample("1", "и", 300.0, true), wave_sample("2", "о", 250.0, false)]);
        let derived: Vec<String> = e.info().derived.into_iter().map(|d| d.key).collect();
        for k in ["й", "О"] {
            assert!(derived.iter().any(|d| d == k), "{k} derived: {derived:?}");
        }
        assert!(!derived.iter().any(|d| d == "и"));
        e.set_samples(vec![wave_sample("1", "и", 300.0, true), wave_sample("3", "й", 280.0, true)]);
        assert!(!e.info().derived.iter().any(|d| d.key == "й"), "a written й replaces the derived one");
        e.set_style(Style { derive: false, ..Style::default() });
        assert!(e.info().derived.is_empty());
    }

    #[test]
    fn variants_without_an_entry_start_words() {
        let mut e = EngineCore::new();
        // "м" written both ways: once without a joining entry, once joining on both sides.
        e.set_samples(vec![wave_sample("1", "м", 300.0, false), wave_sample("2", "м", 320.0, true)]);
        let font = e.build_font().unwrap();
        let ids = shape(&font, "ммм");
        let first = shape(&font, "м")[0];
        let n = e.style.variants as u32;
        assert!(ids[0] < first + n, "word start uses the variant without entry");
        assert!(ids[1] >= first + n && ids[2] >= first + n, "middle letters use joining variants: {ids:?}");
    }

    #[test]
    fn pairs_written_out_of_scale_are_left_out() {
        let mut e = EngineCore::new();
        let singles = vec![wave_sample("1", "с", 200.0, true), wave_sample("2", "т", 300.0, true)];
        let mut tall = singles.clone();
        tall.extend([wave_sample("3", "ст", 700.0, true), wave_sample("4", "ст", 280.0, true)]);
        e.set_samples(tall);
        assert_eq!(e.keys["ст"].prepared.len(), 1, "the capital-high variant is dropped");
        let mut only_tall = singles.clone();
        only_tall.push(wave_sample("3", "ст", 700.0, true));
        e.set_samples(only_tall);
        assert!(!e.keys.contains_key("ст"), "with no variant in scale the letters go one by one");
    }

    #[test]
    fn recorded_pair_is_used_in_the_font() {
        let mut e = EngineCore::new();
        e.set_samples(vec![wave_sample("1", "с", 200.0, true), wave_sample("2", "т", 300.0, true), wave_sample("3", "ст", 260.0, true)]);
        let font = e.build_font().unwrap();
        assert_eq!(shape(&font, "ст").len(), 1, "с+т is replaced by the pair glyph");
        e.set_style(Style { pairs: false, ..Style::default() });
        let font = e.build_font().unwrap();
        assert_eq!(shape(&font, "ст").len(), 2);
    }

    #[test]
    fn paragraph_wraps_reports_missing_and_keeps_words_stable() {
        let mut e = EngineCore::new();
        e.set_style(Style { derive: false, ..Style::default() });
        e.set_samples(vec![wave_sample("1", "м", 300.0, true), wave_sample("2", "а", 200.0, true)]);
        let r = e.render_paragraph("мм мм мм мм мм мм ж", 1500.0, 1500.0, 1, &HashMap::new(), &CharStyles::default());
        assert!(r.lines >= 3, "wrapped into {} lines", r.lines);
        assert_eq!(r.missing, vec!["ж".to_string()]);
        assert_eq!(r.fallback.len(), 1);
        assert_eq!(r.line_d.len(), r.lines);
        assert_eq!(r.line_d.iter().flatten().map(|p| p.d.as_str()).collect::<String>(), r.d);
        assert_eq!(r.fallback[0].line, r.lines - 1, "ж is on the last line");

        // The same word gets the same letters wherever it stands: its seed
        // depends on the document seed and the word itself, not on its position.
        let chars: Vec<char> = "мама".chars().collect();
        let seed = mix(mix(mix(1, e.style.seed as u64), hash_str("мама")), 0);
        let a = e.word_items(&chars, seed, &HashMap::new(), &mut vec![], &[]);
        let b = e.word_items(&chars, seed, &HashMap::new(), &mut vec![], &[]);
        assert_eq!(a.len(), 4);
        assert!(a.iter().zip(&b).all(|(x, y)| x.polys == y.polys && x.advance == y.advance));
    }

    #[test]
    fn abbreviations_and_char_styles_in_ink() {
        let chars = |s: &str| s.chars().collect::<Vec<char>>();
        let w = chars("СССР");
        assert!((0..4).all(|i| abbreviation_letter(&w, i)));
        let w = chars("т.е.");
        assert!(abbreviation_letter(&w, 0) && abbreviation_letter(&w, 2));
        let w = chars("мама.");
        assert!((0..4).all(|i| !abbreviation_letter(&w, i)));
        let w = chars("Мама");
        assert!((0..4).all(|i| !abbreviation_letter(&w, i)));

        let mut e = EngineCore::new();
        e.set_samples(vec![wave_sample("1", "м", 300.0, true)]);
        let styles = CharStyles { scales: vec![1.0, 1.0, 2.0, 2.0], colors: vec![0, 0, 3, 3], ..Default::default() };
        let r = e.render_paragraph("мм мм", 9000.0, 1500.0, 1, &HashMap::new(), &styles);
        let colors: Vec<u8> = r.line_d[0].iter().map(|p| p.color).collect();
        assert_eq!(colors, vec![0, 3], "second word in colour 3");
        let plain = e.render_paragraph("мм мм", 9000.0, 1500.0, 1, &HashMap::new(), &CharStyles::default());
        assert_ne!(plain.d, r.d, "scaled word differs");

        // Indices: a subscript sits lower, a superscript higher (y down).
        let plain = e.render_paragraph("ж1", 9000.0, 1500.0, 1, &HashMap::new(), &CharStyles::default());
        let sub = CharStyles { scales: vec![1.0, 0.65], shifts: vec![0.0, -0.18], ..Default::default() };
        let sub = e.render_paragraph("ж1", 9000.0, 1500.0, 1, &HashMap::new(), &sub);
        assert!((sub.fallback[1].y - plain.fallback[1].y - 180.0).abs() < 1e-6, "subscript 180 units lower");
        assert_eq!(sub.fallback[0].y, plain.fallback[0].y, "the letter itself stays");
    }

    /// «т» written from the top down, without a lead-in: it starts words.
    fn from_the_top(id: &str, ch: &str) -> Sample {
        let mut pts: Vec<InkPoint> = (0..=30).map(|i| InkPoint { x: 0.0, y: 420.0 - i as f64 * 13.0, t: i as f64 * 6.0, p: 0.5 }).collect();
        pts.extend((1..=15).map(|i| InkPoint { x: i as f64 * 12.0, y: 30.0, t: 200.0 + i as f64 * 6.0, p: 0.5 }));
        Sample {
            id: id.into(),
            ch: ch.into(),
            strokes: vec![pts],
            entry: Some(Anchor { x: 0.0, y: 420.0, connect: false }),
            exit: Some(Anchor { x: 180.0, y: 30.0, connect: true }),
            pointer_type: Some("mouse".into()),
        }
    }

    #[test]
    fn ink_joins_a_letter_written_without_a_lead_in() {
        let mut e = EngineCore::new();
        e.set_samples(vec![wave_sample("1", "м", 300.0, true), from_the_top("2", "т")]);
        let chars: Vec<char> = "мт".chars().collect();
        let left_of = |it: &Item| it.polys.iter().flatten().map(|p| p[0]).fold(f64::INFINITY, f64::min) - it.origin;
        let joined = e.word_items(&chars, 7, &HashMap::new(), &mut vec![], &[]);
        assert!(left_of(&joined[1]) < 5.0, "the connecting stroke starts where «м» leaves: {}", left_of(&joined[1]));
        e.set_style(Style { bridge: false, ..Style::default() });
        let apart = e.word_items(&chars, 7, &HashMap::new(), &mut vec![], &[]);
        assert!(left_of(&apart[1]) > 20.0, "without connecting strokes «т» stands apart: {}", left_of(&apart[1]));
    }

    #[test]
    fn ink_letters_inside_a_word_come_from_all_their_variants() {
        // One «т» written with a lead-in, three without: inside words all four turn up.
        let mut e = EngineCore::new();
        e.set_style(Style { interpolate: false, jitter: 0.0, ..Style::default() });
        let mut samples = vec![wave_sample("1", "м", 300.0, true), wave_sample("2", "т", 200.0, true)];
        samples.extend((0..3).map(|k| from_the_top(&format!("t{k}"), "т")));
        e.set_samples(samples);
        let chars: Vec<char> = "мтм".chars().collect();
        let leads = (0..40u64)
            .filter(|&w| {
                let items = e.word_items(&chars, w, &HashMap::new(), &mut vec![], &[]);
                // The wave «т» is 230 tall, the one from the top 420.
                items[1].polys.iter().flatten().map(|p| p[1]).fold(f64::NEG_INFINITY, f64::max) < 330.0
            })
            .count();
        assert!(leads > 2 && leads < 25, "the variant with a lead-in is one of four, not the only one: {leads} of 40");
    }

    #[test]
    fn a_word_repeated_in_other_paragraphs_gets_new_letters() {
        let mut e = EngineCore::new();
        e.set_samples(vec![wave_sample("1", "м", 300.0, false), wave_sample("2", "м", 360.0, false), wave_sample("3", "м", 240.0, false)]);
        let render = |before: u64| {
            let styles = CharStyles { seen: HashMap::from([("м".to_string(), before)]), ..Default::default() };
            e.render_paragraph("м", 9000.0, 1500.0, 1, &HashMap::new(), &styles).d
        };
        let first = render(0);
        assert_eq!(first, e.render_paragraph("м", 9000.0, 1500.0, 1, &HashMap::new(), &CharStyles::default()).d);
        let all: std::collections::BTreeSet<String> = (0..6).map(render).collect();
        assert!(all.len() >= 3, "a lone letter differs from paragraph to paragraph: {} kinds", all.len());
    }

    #[test]
    fn sag_and_line_jitter_move_the_lines() {
        let mut e = EngineCore::new();
        e.set_samples(vec![wave_sample("1", "м", 300.0, true)]);
        let text = "мм мм мм мм мм мм мм мм мм мм";
        e.set_style(Style { sag: 0.0, line_jitter: 0.0, jitter: 0.0, ..Style::default() });
        let flat = e.render_paragraph(text, 1500.0, 1500.0, 3, &HashMap::new(), &CharStyles::default());
        e.set_style(Style { sag: 1.0, line_jitter: 1.0, jitter: 0.0, ..Style::default() });
        let uneven = e.render_paragraph(text, 1500.0, 1500.0, 3, &HashMap::new(), &CharStyles::default());
        assert_eq!(flat.lines, uneven.lines);
        assert_ne!(flat.d, uneven.d);
    }
}

#[cfg(test)]
mod perf {
    use super::*;

    /// cargo test -p glyph-core --release -- --ignored --nocapture
    #[test]
    #[ignore]
    fn full_alphabet_build_time() {
        let alphabet: Vec<char> = ('а'..='я').chain('А'..='Я').chain('a'..='z').chain('0'..='9').chain("()".chars()).collect();
        let mut samples = Vec::new();
        for (ci, c) in alphabet.iter().enumerate() {
            for v in 0..3 {
                let mut strokes = Vec::new();
                let loop_pts: Vec<InkPoint> = (0..=140)
                    .map(|i| {
                        let t = i as f64 / 140.0 * std::f64::consts::TAU * 1.1;
                        InkPoint { x: 200.0 + (150.0 + v as f64 * 9.0) * t.cos(), y: 220.0 + 200.0 * t.sin() + ci as f64 % 5.0, t: i as f64 * 5.0, p: 0.5 }
                    })
                    .collect();
                strokes.push(loop_pts);
                strokes.push((0..=60).map(|i| InkPoint { x: 350.0 + i as f64 * 2.0, y: 420.0 - i as f64 * 7.0, t: 800.0 + i as f64 * 5.0, p: 0.5 }).collect());
                samples.push(Sample {
                    id: format!("{c}{v}"),
                    ch: c.to_string(),
                    strokes,
                    entry: Some(Anchor { x: 50.0, y: 220.0, connect: true }),
                    exit: Some(Anchor { x: 470.0, y: 0.0, connect: true }),
                    pointer_type: Some("mouse".into()),
                });
            }
        }
        let mut e = EngineCore::new();
        let t0 = std::time::Instant::now();
        e.set_samples(samples);
        let t1 = std::time::Instant::now();
        let font = e.build_font().unwrap();
        let t2 = std::time::Instant::now();
        e.render_paragraph(&"абвгд еёжзи йклмн опрст ".repeat(20), 12000.0, 1500.0, 1, &HashMap::new(), &CharStyles::default());
        let t3 = std::time::Instant::now();
        println!(
            "keys={} prepare+fit={:?} font={:?} ({} KB) paragraph(480 chars)={:?}",
            e.keys.len(),
            t1 - t0,
            t2 - t1,
            font.len() / 1024,
            t3 - t2
        );
    }
}
