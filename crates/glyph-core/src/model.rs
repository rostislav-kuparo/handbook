//! Data model shared with the TypeScript side (serialized as camelCase JSON).
//!
//! Coordinates are font units: 1000 units per em, y axis points up,
//! the baseline is y = 0. The capture canvas converts pixels into this space.

use serde::{Deserialize, Serialize};

pub const UNITS_PER_EM: u16 = 1000;
pub const ASCENDER: i16 = 850;
pub const DESCENDER: i16 = -300;
pub const X_HEIGHT: f64 = 450.0;
pub const CAP_HEIGHT: f64 = 700.0;
/// Anchors above this height join "high" (like after о, в), below it "low".
pub const JOIN_SPLIT: f64 = 0.55 * X_HEIGHT;

/// One captured pointer sample.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct InkPoint {
    pub x: f64,
    pub y: f64,
    /// Milliseconds since the start of the sample.
    #[serde(default)]
    pub t: f64,
    /// Pen pressure 0..1 (mouse reports a constant 0.5).
    #[serde(default = "default_pressure")]
    pub p: f64,
}

fn default_pressure() -> f64 {
    0.5
}

/// Entry or exit point of a letter: where the pen arrives from the previous
/// letter and where it leaves to the next one. `connect` decides whether the
/// letter joins its neighbour in cursive writing. The height of the point
/// decides the join level (see [`Level`]).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    pub connect: bool,
}

/// Cursive letters join either near the baseline or at the x-height.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Low,
    High,
}

impl Level {
    pub fn of(y: f64) -> Level {
        if y > JOIN_SPLIT { Level::High } else { Level::Low }
    }

    pub fn other(self) -> Level {
        match self {
            Level::Low => Level::High,
            Level::High => Level::Low,
        }
    }
}

/// One handwritten variant of a character — or of a letter pair such as
/// "ст" written in one go (then `ch` holds 2–3 characters).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub id: String,
    #[serde(rename = "char")]
    pub ch: String,
    pub strokes: Vec<Vec<InkPoint>>,
    #[serde(default)]
    pub entry: Option<Anchor>,
    #[serde(default)]
    pub exit: Option<Anchor>,
    #[serde(default)]
    pub pointer_type: Option<String>,
}

/// Global handwriting style knobs, edited in the studio.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Style {
    /// Glyph variants per character baked into the font (cycled by `calt`).
    pub variants: usize,
    pub seed: u32,
    /// Nominal pen width in font units.
    pub weight: f64,
    /// 0..1, how much pressure modulates the width.
    pub pressure: f64,
    /// 0..1, amount of natural variation (scale, rotation, wobble).
    pub jitter: f64,
    /// Extra slant in degrees, positive leans right.
    pub slant: f64,
    /// Side bearing for letters that do not join, in font units.
    pub letter_spacing: f64,
    /// Advance of the space character, in font units.
    pub word_spacing: f64,
    /// Join letters at their entry/exit anchors.
    pub connect: bool,
    /// Ink rendering: join the letters by a connecting stroke from the real exit
    /// to the real start of the next letter, also when it was written without a
    /// lead-in (instead of bending both onto common join lines).
    pub bridge: bool,
    /// Generate new variants from the learned shape model.
    pub interpolate: bool,
    /// 0..2, how far generated variants may wander from the recorded ones.
    pub fantasy: f64,
    /// Optical kerning for letters that do not join.
    pub kerning: bool,
    /// Use recorded letter pairs ("ст", "но"…) when they occur in the text.
    pub pairs: bool,
    /// Build missing letters from written ones (й from и, ё from е, Latin look-alikes, punctuation).
    pub derive: bool,
    /// 0..1, random variation of the distance between lines.
    pub line_jitter: f64,
    /// 0..1, how much lines droop and letters sag below the ruling.
    pub sag: f64,
}

impl Default for Style {
    fn default() -> Self {
        Style {
            variants: 7,
            seed: 1,
            weight: 52.0,
            pressure: 0.55,
            jitter: 0.5,
            slant: 0.0,
            letter_spacing: 45.0,
            word_spacing: 280.0,
            connect: true,
            bridge: true,
            interpolate: true,
            fantasy: 1.0,
            kerning: true,
            pairs: true,
            derive: true,
            line_jitter: 0.3,
            sag: 0.3,
        }
    }
}

impl Style {
    /// Parameters that change glyph shapes (and therefore the cached font glyphs).
    /// Layout-only knobs (line jitter, sag) are excluded so moving them is instant.
    pub fn glyph_key(&self) -> Style {
        Style { line_jitter: 0.0, sag: 0.0, kerning: false, pairs: false, bridge: false, ..self.clone() }
    }
}
