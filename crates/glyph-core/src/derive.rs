//! Letters the user has not written yet, built from the ones they have —
//! so the text stays in their hand instead of falling back to a system font.
//!
//! * diacritics: й = и + breve, ё = е + two dots (and capitals);
//! * Ukrainian: і ↔ Latin i, ї = і with two dots instead of one, є = с + a middle bar;
//! * capitals whose cursive form is an enlarged lowercase: О С Х З Э;
//! * Latin letters that look exactly like Cyrillic ones (a c e o p x y, A B C E H K M O P T X);
//! * Greek letters that look like Cyrillic or Latin ones (Π = П, Φ = Ф, Γ = Г, Α Β Ε Η Κ Μ Ο Ρ Τ Χ …);
//! * punctuation and math signs drawn with the user's pen: . , - — : ; ! ? + − = × < ≤ ≠ ≈ ° ⊥ ∥ ∠ → ∞ √ …
//!
//! A written sample always wins: derivation only fills gaps.

use crate::geom::*;
use crate::model::{Anchor, CAP_HEIGHT, X_HEIGHT};
use crate::synth::Prepared;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Copy,
    Capital,
    Breve { cap: bool },
    Dots { cap: bool },
    /// Replace the single dot above (і) with two dots (ї).
    SwapDots,
    /// Add a short middle bar (с → є).
    Bar { cap: bool },
}

/// (target, source, how). Order matters: later rules may use earlier results.
pub const RULES: &[(&str, &str, Kind)] = &[
    ("О", "о", Kind::Capital),
    ("С", "с", Kind::Capital),
    ("Х", "х", Kind::Capital),
    ("З", "з", Kind::Capital),
    ("Э", "э", Kind::Capital),
    ("й", "и", Kind::Breve { cap: false }),
    ("Й", "И", Kind::Breve { cap: true }),
    ("ё", "е", Kind::Dots { cap: false }),
    ("Ё", "Е", Kind::Dots { cap: true }),
    // Ukrainian
    ("і", "i", Kind::Copy),
    ("i", "і", Kind::Copy),
    ("І", "I", Kind::Copy),
    ("I", "І", Kind::Copy),
    ("ї", "і", Kind::SwapDots),
    ("Ї", "І", Kind::Dots { cap: true }),
    ("є", "с", Kind::Bar { cap: false }),
    ("Є", "С", Kind::Bar { cap: true }),
    ("a", "а", Kind::Copy),
    ("c", "с", Kind::Copy),
    ("e", "е", Kind::Copy),
    ("o", "о", Kind::Copy),
    ("p", "р", Kind::Copy),
    ("x", "х", Kind::Copy),
    ("y", "у", Kind::Copy),
    ("A", "А", Kind::Copy),
    ("B", "В", Kind::Copy),
    ("C", "С", Kind::Copy),
    ("E", "Е", Kind::Copy),
    ("H", "Н", Kind::Copy),
    ("K", "К", Kind::Copy),
    ("M", "М", Kind::Copy),
    ("O", "О", Kind::Copy),
    ("P", "Р", Kind::Copy),
    ("T", "Т", Kind::Copy),
    ("X", "Х", Kind::Copy),
    // Greek look-alikes (geometry and physics notation: Π₁, Φ, Γ …)
    ("Α", "А", Kind::Copy),
    ("Β", "В", Kind::Copy),
    ("Γ", "Г", Kind::Copy),
    ("Ε", "Е", Kind::Copy),
    ("Ζ", "Z", Kind::Copy),
    ("Η", "Н", Kind::Copy),
    ("Ι", "І", Kind::Copy),
    ("Κ", "К", Kind::Copy),
    ("Μ", "М", Kind::Copy),
    ("Ν", "N", Kind::Copy),
    ("Ο", "О", Kind::Copy),
    ("Π", "П", Kind::Copy),
    ("Ρ", "Р", Kind::Copy),
    ("Τ", "Т", Kind::Copy),
    ("Υ", "Y", Kind::Copy),
    ("Φ", "Ф", Kind::Copy),
    ("Χ", "Х", Kind::Copy),
    ("ο", "о", Kind::Copy),
    ("φ", "ф", Kind::Copy),
];

/// Punctuation and math signs that can be drawn without any source letter.
pub const PUNCTUATION: &[&str] = &[
    ".", ",", "-", "—", ":", ";", "!", "?", // punctuation
    "+", "−", "=", "×", "·", "⋅", "÷", "±", "<", ">", "≤", "≥", "≠", "≈", "≡", // arithmetic
    "°", "′", "″", "⊥", "∥", "∠", "△", "Δ", "∈", "⊂", "∪", "∩", "∅", "∀", "∃", // geometry and sets
    "→", "←", "↔", "⇒", "⇔", "∞", "√", "π", "∑", "∫", // arrows and the rest
];

pub fn derive(kind: Kind, source: &[Prepared]) -> Vec<Prepared> {
    source
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let mut p = p.clone();
            let b = strokes_bbox(&p.strokes);
            let wiggle = (i as f64 * 1.7).sin();
            match kind {
                Kind::Copy => {}
                Kind::Capital => {
                    // Scale around the left edge on the baseline; a capital starts a word.
                    let (sx, sy) = (1.35, CAP_HEIGHT / X_HEIGHT);
                    let tf = |x: f64, y: f64| (b.x_min + (x - b.x_min) * sx, y * sy);
                    for s in p.strokes.iter_mut() {
                        for q in s.iter_mut() {
                            (q.x, q.y) = tf(q.x, q.y);
                        }
                    }
                    p.exit = p.exit.map(|a| {
                        let (x, y) = tf(a.x, a.y);
                        Anchor { x, y, ..a }
                    });
                    p.entry = p.entry.map(|a| Anchor { connect: false, ..a });
                }
                Kind::Breve { cap } => {
                    let top = if cap { CAP_HEIGHT } else { X_HEIGHT.max(b.y_max - 20.0) } + 90.0 + wiggle * 10.0;
                    let cx = b.center_x() + wiggle * 15.0;
                    p.strokes.push(
                        (0..=24)
                            .map(|k| {
                                let s = k as f64 / 24.0;
                                Pt::new(cx - 95.0 + 190.0 * s, top + 70.0 * (2.0 * s - 1.0).powi(2), 0.5)
                            })
                            .collect(),
                    );
                }
                Kind::Dots { cap } => {
                    let y = if cap { CAP_HEIGHT } else { X_HEIGHT.max(b.y_max - 20.0) } + 110.0 + wiggle * 8.0;
                    let cx = b.center_x();
                    for dx in [-70.0, 70.0] {
                        p.strokes.push(dot(cx + dx + wiggle * 6.0, y));
                    }
                }
                Kind::SwapDots => {
                    // Drop the small mark(s) above the x-height, then put two dots there.
                    p.strokes.retain(|s| stroke_length(s) > 90.0 || s.iter().map(|q| q.y).fold(f64::MAX, f64::min) < X_HEIGHT * 0.8);
                    let b = strokes_bbox(&p.strokes);
                    let y = X_HEIGHT.max(if b.is_empty() { 0.0 } else { b.y_max }) + 110.0 + wiggle * 8.0;
                    let cx = if b.is_empty() { 150.0 } else { b.center_x() };
                    for dx in [-60.0, 60.0] {
                        p.strokes.push(dot(cx + dx + wiggle * 6.0, y));
                    }
                }
                Kind::Bar { cap } => {
                    let h = if cap { CAP_HEIGHT * 0.5 } else { X_HEIGHT * 0.48 } + wiggle * 6.0;
                    let w = b.x_max - b.x_min;
                    p.strokes.push(line(&[(b.x_min + 0.12 * w, h), (b.x_min + 0.62 * w, h + 6.0)]));
                }
            }
            p
        })
        .collect()
}

fn dot(x: f64, y: f64) -> Stroke {
    (0..=4).map(|k| Pt::new(x + k as f64 * 3.0, y - k as f64 * 2.0, 0.85)).collect()
}

fn line(points: &[(f64, f64)]) -> Stroke {
    let pts: Stroke = points.iter().map(|&(x, y)| Pt::new(x, y, 0.6)).collect();
    resample_spacing(&pts, 5.0)
}

/// A curve given as a function of t in [0, 1].
fn curve(f: impl Fn(f64) -> (f64, f64)) -> Stroke {
    let pts: Vec<(f64, f64)> = (0..=40).map(|k| f(k as f64 / 40.0)).collect();
    line(&pts)
}

/// Elliptic arc around (cx, cy) from angle a0 to a1 (degrees, counter-clockwise from +x).
fn arc(cx: f64, cy: f64, rx: f64, ry: f64, a0: f64, a1: f64) -> Stroke {
    curve(|t| {
        let a = (a0 + (a1 - a0) * t).to_radians();
        (cx + rx * a.cos(), cy + ry * a.sin())
    })
}

/// Hand-drawn math signs in font units (baseline 0, x-height 450, the math axis at 250).
fn math_sign(mark: &str, w: f64) -> Option<Vec<Stroke>> {
    let bar = |y: f64, x0: f64, x1: f64| line(&[(x0, y + w * 0.5), (x1, y + 6.0 - w * 0.5)]);
    let arrow_right = |x: f64, y: f64| line(&[(x - 90.0, y + 85.0 + w), (x, y), (x - 90.0, y - 85.0)]);
    let arrow_left = |x: f64, y: f64| line(&[(x + 90.0, y + 85.0), (x, y), (x + 90.0, y - 85.0 + w)]);
    Some(match mark {
        "+" => vec![bar(250.0, 50.0, 330.0), line(&[(190.0 + w * 0.3, 400.0), (186.0, 100.0)])],
        "−" => vec![bar(250.0, 40.0, 360.0)],
        "=" => vec![bar(320.0, 50.0, 330.0), bar(180.0, 50.0, 330.0)],
        "×" => vec![line(&[(80.0, 380.0 + w), (290.0, 120.0)]), line(&[(290.0, 380.0), (80.0, 120.0 + w)])],
        "·" | "⋅" => vec![dot(70.0 + w, 250.0)],
        "÷" => vec![bar(250.0, 40.0, 330.0), dot(180.0 + w, 400.0), dot(180.0, 100.0)],
        "±" => vec![bar(330.0, 50.0, 330.0), line(&[(190.0 + w * 0.3, 470.0), (188.0, 190.0)]), bar(90.0, 50.0, 330.0)],
        "<" => vec![line(&[(320.0, 420.0), (60.0, 260.0 + w), (320.0, 90.0)])],
        ">" => vec![line(&[(60.0, 420.0), (320.0, 260.0 + w), (60.0, 90.0)])],
        "≤" => vec![line(&[(320.0, 480.0), (60.0, 340.0 + w), (320.0, 200.0)]), bar(80.0, 60.0, 320.0)],
        "≥" => vec![line(&[(60.0, 480.0), (320.0, 340.0 + w), (60.0, 200.0)]), bar(80.0, 60.0, 320.0)],
        "≠" => vec![bar(320.0, 50.0, 330.0), bar(180.0, 50.0, 330.0), line(&[(250.0 + w, 440.0), (130.0, 60.0)])],
        "≈" => {
            let wave = |y: f64| curve(|t| (50.0 + 290.0 * t, y + 35.0 * (t * std::f64::consts::TAU).sin() + w * 0.3));
            vec![wave(320.0), wave(180.0)]
        }
        "≡" => vec![bar(370.0, 50.0, 330.0), bar(250.0, 50.0, 330.0), bar(130.0, 50.0, 330.0)],
        "°" => vec![arc(110.0 + w, 600.0, 55.0, 60.0, 100.0, 470.0)],
        "′" => vec![line(&[(120.0 + w, 720.0), (70.0, 540.0)])],
        "″" => vec![line(&[(110.0 + w, 720.0), (60.0, 540.0)]), line(&[(200.0, 720.0), (150.0, 540.0)])],
        "⊥" => vec![line(&[(200.0 + w * 0.3, 520.0), (196.0, 40.0)]), bar(36.0, 40.0, 360.0)],
        "∥" => vec![line(&[(150.0, 560.0), (110.0 + w * 0.5, 0.0)]), line(&[(270.0 + w * 0.5, 560.0), (230.0, 0.0)])],
        "∠" => vec![line(&[(330.0, 500.0 + w), (40.0, 40.0), (390.0, 46.0)])],
        "△" => vec![line(&[(40.0, 40.0), (215.0, 520.0 + w), (390.0, 40.0), (40.0, 40.0)])],
        "Δ" => vec![line(&[(40.0, 0.0), (250.0, 700.0 + w), (460.0, 0.0), (40.0, 0.0)])],
        "∈" => vec![arc(230.0, 250.0, 170.0, 190.0, 70.0, 290.0), bar(250.0, 70.0, 360.0)],
        "⊂" => vec![
            line(&[(380.0, 440.0), (230.0, 440.0 + w * 0.3)]),
            arc(230.0, 250.0, 170.0, 190.0, 90.0, 270.0),
            line(&[(230.0, 60.0), (380.0, 60.0 + w * 0.3)]),
        ],
        "∪" => vec![line(&[(60.0, 460.0), (60.0, 210.0)]), arc(200.0, 210.0, 140.0, 170.0 + w, 180.0, 360.0), line(&[(340.0, 210.0), (340.0, 460.0)])],
        "∩" => vec![line(&[(60.0, 0.0), (60.0, 250.0)]), arc(200.0, 250.0, 140.0, 170.0 + w, 180.0, 0.0), line(&[(340.0, 250.0), (340.0, 0.0)])],
        "∅" => vec![arc(220.0, 300.0, 160.0, 220.0, 80.0, 440.0), line(&[(390.0 + w, 600.0), (50.0, -20.0)])],
        "∀" => vec![line(&[(30.0, 700.0), (220.0, 0.0), (410.0, 700.0 + w)]), bar(350.0, 110.0, 330.0)],
        "∃" => vec![line(&[(60.0, 700.0), (360.0, 700.0 + w * 0.3), (356.0, 0.0), (60.0, 0.0)]), bar(350.0, 110.0, 350.0)],
        "→" => vec![bar(250.0, 40.0, 380.0), arrow_right(386.0, 256.0)],
        "←" => vec![bar(250.0, 40.0, 380.0), arrow_left(40.0, 250.0)],
        "↔" => vec![bar(250.0, 40.0, 420.0), arrow_left(40.0, 250.0), arrow_right(426.0, 256.0)],
        "⇒" => vec![bar(320.0, 40.0, 330.0), bar(180.0, 40.0, 330.0), line(&[(280.0, 430.0 + w), (410.0, 253.0), (280.0, 80.0)])],
        "⇔" => vec![
            bar(320.0, 70.0, 360.0),
            bar(180.0, 70.0, 360.0),
            line(&[(150.0, 430.0), (20.0, 253.0), (150.0, 80.0 + w)]),
            line(&[(280.0, 430.0 + w), (410.0, 253.0), (280.0, 80.0)]),
        ],
        "∞" => vec![curve(|t| {
            // Lemniscate of Bernoulli.
            let a = t * std::f64::consts::TAU;
            let d = 1.0 + a.sin().powi(2);
            (240.0 + 190.0 * a.cos() / d, 250.0 + (190.0 + w) * a.sin() * a.cos() / d)
        })],
        "√" => vec![line(&[(20.0, 300.0), (80.0, 330.0), (160.0, 0.0), (280.0, 720.0), (470.0, 720.0 + w)])],
        "π" => vec![
            line(&[(30.0, 390.0), (110.0, 450.0), (420.0, 452.0 + w)]),
            line(&[(160.0, 445.0), (150.0 + w * 0.3, 0.0)]),
            line(&[(320.0, 448.0), (326.0, 70.0), (390.0, 0.0)]),
        ],
        "∑" => vec![line(&[(420.0, 640.0), (400.0, 700.0), (40.0, 700.0 + w), (250.0, 350.0), (40.0, 0.0), (400.0, 0.0), (420.0, 60.0)])],
        "∫" => vec![line(&[
            (340.0, 700.0),
            (300.0, 760.0),
            (240.0, 740.0 + w),
            (200.0, 600.0),
            (170.0, 200.0),
            (150.0, -150.0),
            (110.0, -250.0),
            (50.0, -220.0),
        ])],
        _ => return None,
    })
}

/// Three slightly different hand-drawn variants of a punctuation mark.
pub fn punctuation(mark: &str) -> Option<Vec<Prepared>> {
    let make = |v: f64| -> Option<Prepared> {
        let w = v * 12.0; // small per-variant difference
        let comma = |x: f64, y: f64| line(&[(x + 10.0, y + 20.0), (x + 12.0, y - 30.0 - w), (x - 25.0, y - 110.0 + w)]);
        let strokes: Vec<Stroke> = match mark {
            "." => vec![dot(60.0 + w, 15.0)],
            "," => vec![comma(60.0, 20.0)],
            "-" => vec![line(&[(40.0, 220.0 + w), (150.0, 226.0), (250.0, 232.0 - w)])],
            "—" => vec![line(&[(40.0, 230.0 + w), (300.0, 238.0), (620.0, 244.0 - w)])],
            ":" => vec![dot(60.0 + w, 300.0), dot(60.0, 15.0)],
            ";" => vec![dot(70.0 + w, 300.0), comma(60.0, 20.0)],
            "!" => vec![line(&[(90.0 + w, 700.0), (80.0, 400.0), (72.0, 150.0)]), dot(68.0, 15.0)],
            "?" => vec![
                line(&[(60.0, 560.0), (110.0 + w, 680.0), (230.0, 700.0), (310.0, 610.0), (250.0, 470.0), (180.0, 360.0), (175.0, 170.0)]),
                dot(170.0, 15.0),
            ],
            _ => math_sign(mark, w)?,
        };
        Some(Prepared { strokes, entry: None, exit: None })
    };
    [0.0, 1.0, -1.0].into_iter().map(make).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn breve_sits_above_the_letter() {
        let i = Prepared {
            strokes: vec![(0..=20).map(|k| Pt::new(k as f64 * 20.0, (k as f64 * 0.3).sin().abs() * 450.0, 0.5)).collect()],
            entry: None,
            exit: None,
        };
        let out = derive(Kind::Breve { cap: false }, &[i]);
        assert_eq!(out[0].strokes.len(), 2);
        let breve = &out[0].strokes[1];
        assert!(breve.iter().all(|p| p.y > X_HEIGHT));
    }

    #[test]
    fn capital_is_taller_and_does_not_join_on_the_left() {
        let o = Prepared {
            strokes: vec![(0..=30).map(|k| Pt::new(200.0 + 150.0 * (k as f64 / 5.0).cos(), 225.0 + 220.0 * (k as f64 / 5.0).sin(), 0.5)).collect()],
            entry: Some(Anchor { x: 50.0, y: 20.0, connect: true }),
            exit: None,
        };
        let out = derive(Kind::Capital, &[o]);
        assert!(strokes_bbox(&out[0].strokes).y_max > 650.0);
        assert!(!out[0].entry.unwrap().connect);
    }

    #[test]
    fn yi_has_two_dots_instead_of_one() {
        let stem: Stroke = (0..=20).map(|k| Pt::new(100.0, k as f64 * 22.0, 0.5)).collect();
        let i = Prepared { strokes: vec![stem, dot(100.0, 600.0)], entry: None, exit: None };
        let out = derive(Kind::SwapDots, &[i]);
        assert_eq!(out[0].strokes.len(), 3, "stem + two dots");
        let dots: Vec<&Stroke> = out[0].strokes.iter().filter(|s| stroke_length(s) < 90.0).collect();
        assert_eq!(dots.len(), 2);
        assert!(dots.iter().all(|d| d[0].y > X_HEIGHT));
    }

    #[test]
    fn ye_gets_a_middle_bar() {
        let c = Prepared {
            strokes: vec![(0..=30).map(|k| { let t = 0.6 + k as f64 / 30.0 * 5.0; Pt::new(200.0 + 150.0 * t.cos(), 225.0 + 220.0 * t.sin(), 0.5) }).collect()],
            entry: None,
            exit: None,
        };
        let out = derive(Kind::Bar { cap: false }, &[c]);
        assert_eq!(out[0].strokes.len(), 2);
        let bar = &out[0].strokes[1];
        assert!(bar.iter().all(|p| (p.y - X_HEIGHT * 0.48).abs() < 30.0));
    }

    #[test]
    fn punctuation_has_three_variants() {
        for m in PUNCTUATION {
            assert_eq!(punctuation(m).unwrap().len(), 3, "{m}");
        }
    }
}
