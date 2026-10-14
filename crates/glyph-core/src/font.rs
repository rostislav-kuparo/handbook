//! TrueType font assembly.
//!
//! Glyph order: `.notdef`, then for every key (a character or a letter pair)
//! a block of N variants, optionally followed by a block of N "alternate entry"
//! variants (the same letters starting at the other join height).
//!
//! GSUB, in lookup order:
//! 1. ligatures — "с"+"т" becomes the recorded pair "ст" (its variant 0);
//! 2. cycle — each glyph picks its variant from the variant of the previous
//!    glyph: `next = (prev + shift(key)) mod N`, shift differs per key, so
//!    repeated letters never look identical and the sequence looks random;
//! 3. entry adaptation — after a glyph that leaves high (о, в) a letter that
//!    normally enters low switches to its high-entry alternate, and vice versa.
//!
//! GPOS: class-based pair kerning (one class per key) from the ink profiles.

use write_fonts::read::tables::glyf::CurvePoint;
use write_fonts::tables::cmap::Cmap;
use write_fonts::tables::glyf::{Contour, GlyfLocaBuilder, Glyph, SimpleGlyph};
use write_fonts::tables::gpos::{Class1Record, Class2Record, Gpos, PairPos, PositionLookup, PositionLookupList, ValueRecord};
use write_fonts::tables::gsub::{
    Gsub, Ligature, LigatureSet, LigatureSubstFormat1, SingleSubst, SubstitutionChainContext, SubstitutionLookup,
    SubstitutionLookupList,
};
use write_fonts::tables::head::{Flags, Head, MacStyle};
use write_fonts::tables::hhea::Hhea;
use write_fonts::tables::hmtx::{Hmtx, LongMetric};
use write_fonts::tables::layout::{
    ChainedClassSequenceRule, ChainedClassSequenceRuleSet, ChainedSequenceContext, ClassDef, CoverageTable, Feature,
    FeatureList, FeatureRecord, LangSys, Lookup, LookupFlag, Script, ScriptList, ScriptRecord, SequenceLookupRecord,
};
use write_fonts::tables::loca::LocaFormat;
use write_fonts::tables::maxp::Maxp;
use write_fonts::tables::name::{Name, NameRecord};
use write_fonts::tables::os2::{Os2, SelectionFlags};
use write_fonts::tables::post::Post;
use write_fonts::types::{FWord, Fixed, GlyphId, GlyphId16, LongDateTime, NameId, Tag, UfWord, Version16Dot16};
use write_fonts::FontBuilder;

use crate::kern::{pair_kern, Profile};
use crate::model::{Level, ASCENDER, CAP_HEIGHT, DESCENDER, UNITS_PER_EM, X_HEIGHT};
use crate::rng::hash_str;

/// One glyph ready for the font: integer contours (control polygons of
/// quadratic B-splines), advance and join levels.
#[derive(Clone, Debug, Default)]
pub struct FontGlyph {
    pub contours: Vec<Vec<[i16; 2]>>,
    pub advance: u16,
    pub entry: Option<Level>,
    pub exit: Option<Level>,
}

#[derive(Clone, Debug)]
pub struct KeyGlyphs {
    /// One character (mapped in cmap) or a sequence of 2–3 (a ligature).
    pub key: String,
    /// Word-initial forms (or the only forms), mapped in cmap.
    pub variants: Vec<FontGlyph>,
    /// Middle-of-word forms, used after any letter; empty when the key has one kind only.
    pub medial: Vec<FontGlyph>,
    /// Joining forms (middle ones if present) entering at the other join height; empty if the key never joins on the left.
    pub alts: Vec<FontGlyph>,
    /// Stand-alone forms for abbreviations (СССР, т.е.); empty if not needed.
    pub isolated: Vec<FontGlyph>,
}

#[derive(Clone, Debug)]
pub struct FontOptions {
    pub family: String,
    pub variants: usize,
    pub kerning: bool,
    pub letter_spacing: f64,
}

pub fn round_contours(contours: &[Vec<[f64; 2]>], dx: f64) -> Vec<Vec<[i16; 2]>> {
    contours
        .iter()
        .map(|c| {
            let mut out: Vec<[i16; 2]> = Vec::with_capacity(c.len());
            for p in c {
                let q = [(p[0] + dx).round() as i16, p[1].round() as i16];
                if out.last() != Some(&q) {
                    out.push(q);
                }
            }
            while out.len() > 1 && out.first() == out.last() {
                out.pop();
            }
            out
        })
        .filter(|c| c.len() >= 3)
        .collect()
}

/// Contour = one explicit on-curve start point (midpoint of the last and first
/// control points) followed by off-curve control points; TrueType implies the
/// on-curve points between consecutive off-curve ones.
fn tt_contour(c: &[[i16; 2]]) -> Contour {
    let n = c.len();
    let (last, first) = (c[n - 1], c[0]);
    let start = CurvePoint::on_curve(
        ((last[0] as i32 + first[0] as i32) / 2) as i16,
        ((last[1] as i32 + first[1] as i32) / 2) as i16,
    );
    let mut pts = Vec::with_capacity(n + 1);
    pts.push(start);
    pts.extend(c.iter().map(|p| CurvePoint::off_curve(p[0], p[1])));
    Contour::from(pts)
}

/// A hollow box with square corners (on-curve points only).
fn notdef_glyph() -> SimpleGlyph {
    let rect = |x0: i16, y0: i16, x1: i16, y1: i16, clockwise: bool| {
        let mut pts = vec![[x0, y0], [x0, y1], [x1, y1], [x1, y0]];
        if !clockwise {
            pts.reverse();
        }
        Contour::from(pts.iter().map(|p| CurvePoint::on_curve(p[0], p[1])).collect::<Vec<_>>())
    };
    let mut sg = SimpleGlyph {
        contours: vec![rect(60, 0, 440, 700, true), rect(110, 50, 390, 650, false)],
        ..Default::default()
    };
    sg.recompute_bounding_box();
    sg
}

/// Per-key variant step for the calt cycle (1..n-1).
fn shift_for(key: &str, n: usize) -> u16 {
    if n <= 1 {
        return 0;
    }
    (1 + (hash_str(key) % (n as u64 - 1))) as u16
}

/// Majority vote over variants (ties count as "no").
fn majority<T: PartialEq + Copy>(items: impl Iterator<Item = Option<T>>, want: impl Fn(Option<T>) -> bool) -> bool {
    let (mut yes, mut total) = (0, 0);
    for i in items {
        total += 1;
        if want(i) {
            yes += 1;
        }
    }
    yes * 2 > total
}

struct Block {
    base: u16,
    medial: Option<u16>,
    alt: Option<u16>,
    iso: Option<u16>,
}

impl Block {
    /// First glyph id of every block of this key.
    fn starts(&self) -> impl Iterator<Item = u16> {
        [Some(self.base), self.medial, self.alt, self.iso].into_iter().flatten()
    }
}

pub fn build_font(opts: &FontOptions, keys: &[KeyGlyphs]) -> Result<Vec<u8>, String> {
    let n = opts.variants.max(1);
    let mut keys: Vec<KeyGlyphs> = keys.iter().filter(|k| !k.key.is_empty()).cloned().collect();
    keys.sort_by(|a, b| a.key.cmp(&b.key));
    keys.dedup_by(|a, b| a.key == b.key);
    for k in keys.iter_mut() {
        for list in [&mut k.variants, &mut k.medial, &mut k.alts, &mut k.isolated] {
            if list.is_empty() {
                continue;
            }
            let have = list.len();
            for i in have..n {
                let v = list[i % have].clone();
                list.push(v);
            }
            list.truncate(n);
        }
        if k.variants.is_empty() {
            k.variants = vec![FontGlyph { advance: 300, ..Default::default() }; n];
        }
    }

    // Glyph order.
    let mut blocks = Vec::with_capacity(keys.len());
    let mut next: usize = 1;
    for k in &keys {
        let mut take = |present: bool| {
            present.then(|| {
                let start = next as u16;
                next += n;
                start
            })
        };
        let base = take(true).unwrap();
        let medial = take(!k.medial.is_empty());
        let alt = take(!k.alts.is_empty());
        let iso = take(!k.isolated.is_empty());
        blocks.push(Block { base, medial, alt, iso });
    }
    let num_glyphs = next;
    if num_glyphs > u16::MAX as usize {
        return Err("too many glyphs".into());
    }
    let all_glyphs: Vec<&FontGlyph> =
        keys.iter().flat_map(|k| k.variants.iter().chain(k.medial.iter()).chain(k.alts.iter()).chain(k.isolated.iter())).collect();

    // glyf / loca / hmtx
    let mut builder = GlyfLocaBuilder::new();
    let mut metrics = Vec::with_capacity(num_glyphs);
    let nd = notdef_glyph();
    builder.add_glyph(&nd).map_err(|e| e.to_string())?;
    metrics.push(LongMetric::new(500, nd.bbox.x_min));
    let (mut x_min, mut y_min, mut x_max, mut y_max) = (nd.bbox.x_min, nd.bbox.y_min, nd.bbox.x_max, nd.bbox.y_max);
    let (mut max_points, mut max_contours) = (8u16, 2u16);
    let (mut adv_max, mut min_lsb, mut min_rsb, mut max_extent) = (500u16, 0i16, 0i16, 0i16);
    let mut adv_sum: u64 = 0;
    for v in &all_glyphs {
        if v.contours.is_empty() {
            builder.add_glyph(&Glyph::Empty).map_err(|e| e.to_string())?;
            metrics.push(LongMetric::new(v.advance, 0));
        } else {
            let mut sg = SimpleGlyph { contours: v.contours.iter().map(|c| tt_contour(c)).collect(), ..Default::default() };
            sg.recompute_bounding_box();
            let b = sg.bbox;
            builder.add_glyph(&sg).map_err(|e| e.to_string())?;
            metrics.push(LongMetric::new(v.advance, b.x_min));
            x_min = x_min.min(b.x_min);
            y_min = y_min.min(b.y_min);
            x_max = x_max.max(b.x_max);
            y_max = y_max.max(b.y_max);
            let pts: usize = v.contours.iter().map(|c| c.len() + 1).sum();
            max_points = max_points.max(pts.min(u16::MAX as usize) as u16);
            max_contours = max_contours.max(v.contours.len() as u16);
            min_lsb = min_lsb.min(b.x_min);
            min_rsb = min_rsb.min(v.advance as i16 - b.x_max);
            max_extent = max_extent.max(b.x_max);
        }
        adv_max = adv_max.max(v.advance);
        adv_sum += v.advance as u64;
    }
    let (glyf, loca, loca_format) = builder.build();
    let hmtx = Hmtx::new(metrics, vec![]);

    let head = Head {
        font_revision: Fixed::from_f64(1.0),
        flags: Flags::from_bits_truncate(0x0003),
        units_per_em: UNITS_PER_EM,
        created: LongDateTime::new(0),
        modified: LongDateTime::new(0),
        x_min,
        y_min,
        x_max,
        y_max,
        mac_style: MacStyle::empty(),
        lowest_rec_ppem: 8,
        index_to_loc_format: match loca_format {
            LocaFormat::Short => 0,
            LocaFormat::Long => 1,
        },
        ..Default::default()
    };
    let hhea = Hhea::new(
        FWord::new(ASCENDER),
        FWord::new(DESCENDER),
        FWord::new(0),
        UfWord::new(adv_max),
        FWord::new(min_lsb),
        FWord::new(min_rsb),
        FWord::new(max_extent),
        1,
        0,
        0,
        num_glyphs as u16,
    );
    let mut maxp = Maxp::new(num_glyphs as u16);
    maxp.max_points = Some(max_points);
    maxp.max_contours = Some(max_contours);
    maxp.max_composite_points = Some(0);
    maxp.max_composite_contours = Some(0);
    maxp.max_zones = Some(2);
    maxp.max_twilight_points = Some(0);
    maxp.max_storage = Some(0);
    maxp.max_function_defs = Some(0);
    maxp.max_instruction_defs = Some(0);
    maxp.max_stack_elements = Some(0);
    maxp.max_size_of_instructions = Some(0);
    maxp.max_component_elements = Some(0);
    maxp.max_component_depth = Some(0);

    let singles: Vec<(char, u16)> = keys
        .iter()
        .zip(&blocks)
        .filter_map(|(k, b)| {
            let mut it = k.key.chars();
            match (it.next(), it.next()) {
                (Some(c), None) => Some((c, b.base)),
                _ => None,
            }
        })
        .collect();
    let cmap = Cmap::from_mappings(singles.iter().map(|&(c, g)| (c, GlyphId::new(g as u32))))
        .map_err(|e| format!("cmap: {e:?}"))?;

    let first_char = singles.first().map(|c| c.0 as u32).unwrap_or(0x20);
    let last_char = singles.last().map(|c| c.0 as u32).unwrap_or(0x20);
    let os2 = Os2 {
        x_avg_char_width: (adv_sum / (all_glyphs.len() as u64).max(1)) as i16,
        us_weight_class: 400,
        us_width_class: 5,
        fs_type: 0,
        y_subscript_x_size: 650,
        y_subscript_y_size: 600,
        y_subscript_y_offset: 75,
        y_superscript_x_size: 650,
        y_superscript_y_size: 600,
        y_superscript_y_offset: 350,
        y_strikeout_size: 50,
        y_strikeout_position: 250,
        // Basic Latin (bit 0) + Cyrillic (bit 9)
        ul_unicode_range_1: (1 << 0) | (1 << 9),
        ach_vend_id: Tag::new(b"NONE"),
        fs_selection: SelectionFlags::REGULAR | SelectionFlags::USE_TYPO_METRICS,
        us_first_char_index: first_char.min(0xFFFF) as u16,
        us_last_char_index: last_char.min(0xFFFF) as u16,
        s_typo_ascender: ASCENDER,
        s_typo_descender: DESCENDER,
        s_typo_line_gap: 0,
        us_win_ascent: (ASCENDER.max(y_max)) as u16,
        us_win_descent: (-DESCENDER).max(-y_min) as u16,
        // Latin 1 (bit 0) + Cyrillic (bit 2)
        ul_code_page_range_1: Some((1 << 0) | (1 << 2)),
        ul_code_page_range_2: Some(0),
        sx_height: Some(X_HEIGHT as i16),
        s_cap_height: Some(CAP_HEIGHT as i16),
        us_default_char: Some(0),
        us_break_char: Some(0x20),
        us_max_context: Some(3),
        ..Default::default()
    };

    let ps_name: String = opts.family.chars().filter(|c| c.is_ascii_alphanumeric()).take(40).collect();
    let ps_name = if ps_name.is_empty() { "Handwriting".to_string() } else { ps_name };
    let rec = |id: NameId, s: &str| NameRecord::new(3, 1, 0x409, id, s.to_string().into());
    let name = Name::new(vec![
        rec(NameId::FAMILY_NAME, &opts.family),
        rec(NameId::SUBFAMILY_NAME, "Regular"),
        rec(NameId::UNIQUE_ID, &format!("{ps_name}-Regular;handbook")),
        rec(NameId::FULL_NAME, &format!("{} Regular", opts.family)),
        rec(NameId::VERSION_STRING, "Version 1.000"),
        rec(NameId::POSTSCRIPT_NAME, &format!("{ps_name}-Regular")),
    ]);
    let post = Post {
        version: Version16Dot16::VERSION_3_0,
        underline_position: FWord::new(-150),
        underline_thickness: FWord::new(50),
        ..Default::default()
    };

    let mut fb = FontBuilder::new();
    fb.add_table(&head).map_err(|e| e.to_string())?;
    fb.add_table(&hhea).map_err(|e| e.to_string())?;
    fb.add_table(&maxp).map_err(|e| e.to_string())?;
    fb.add_table(&os2).map_err(|e| e.to_string())?;
    fb.add_table(&hmtx).map_err(|e| e.to_string())?;
    fb.add_table(&cmap).map_err(|e| e.to_string())?;
    fb.add_table(&loca).map_err(|e| e.to_string())?;
    fb.add_table(&glyf).map_err(|e| e.to_string())?;
    fb.add_table(&name).map_err(|e| e.to_string())?;
    fb.add_table(&post).map_err(|e| e.to_string())?;
    if let Some(gsub) = build_gsub(&keys, &blocks, &singles, n, num_glyphs) {
        fb.add_table(&gsub).map_err(|e| e.to_string())?;
    }
    if opts.kerning {
        if let Some(gpos) = build_gpos(&keys, &blocks, num_glyphs, opts.letter_spacing) {
            fb.add_table(&gpos).map_err(|e| e.to_string())?;
        }
    }
    Ok(fb.build())
}

fn scripts(feature_count: u16) -> ScriptList {
    let script = || Script::new(Some(LangSys::new((0..feature_count).collect())), vec![]);
    ScriptList::new(vec![
        ScriptRecord::new(Tag::new(b"DFLT"), script()),
        ScriptRecord::new(Tag::new(b"cyrl"), script()),
        ScriptRecord::new(Tag::new(b"latn"), script()),
    ])
}

fn coverage(mut glyphs: Vec<u16>) -> CoverageTable {
    glyphs.sort();
    glyphs.dedup();
    CoverageTable::format_1(glyphs.into_iter().map(GlyphId16::new).collect())
}

fn build_gsub(keys: &[KeyGlyphs], blocks: &[Block], singles: &[(char, u16)], n: usize, num_glyphs: usize) -> Option<Gsub> {
    let total = num_glyphs;
    // Ligatures: sequences whose characters all exist as single glyphs.
    let single_gid = |c: char| singles.iter().find(|s| s.0 == c).map(|s| s.1);
    let mut ligs: Vec<(u16, Vec<u16>, u16)> = Vec::new(); // (first, rest, ligature)
    for (k, b) in keys.iter().zip(blocks) {
        let chars: Vec<char> = k.key.chars().collect();
        if chars.len() < 2 {
            continue;
        }
        let gids: Option<Vec<u16>> = chars.iter().map(|&c| single_gid(c)).collect();
        if let Some(g) = gids {
            ligs.push((g[0], g[1..].to_vec(), b.base));
        }
    }
    let any_medial = blocks.iter().any(|b| b.medial.is_some());
    let any_alts = blocks.iter().any(|b| b.alt.is_some());
    let any_iso = blocks.iter().any(|b| b.iso.is_some());
    if ligs.is_empty() && n <= 1 && !any_alts && !any_medial && !any_iso {
        return None;
    }

    // Lookup indices, in the order the lookups are pushed below.
    let mut idx = 0u16;
    let mut reserve = |present: bool, count: u16| {
        present.then(|| {
            let i = idx;
            idx += count;
            i
        })
    };
    let lig_idx = reserve(!ligs.is_empty(), 1);
    let cycle_idx = reserve(n > 1, 1);
    let medial_idx = reserve(any_medial, 1);
    let iso_idx = reserve(any_iso, 1);
    let adapt_idx = reserve(any_alts, 1);
    let singles_start = reserve(n > 1, (n - 1) as u16);
    let medial_delta_idx = reserve(any_medial, 1);
    let iso_map_idx = reserve(any_iso, 1);
    let alt_delta_idx = reserve(any_alts, 1);

    let mut lookups: Vec<SubstitutionLookup> = Vec::new();
    let mut feature_lookups = Vec::new();
    let class_def = |classes: Vec<u16>| ClassDef::format_1(GlyphId16::new(1), classes);
    let rule = |back: u16, lookup: u16| {
        ChainedClassSequenceRuleSet::new(vec![ChainedClassSequenceRule::new(
            vec![back],
            vec![],
            vec![],
            vec![SequenceLookupRecord::new(0, lookup)],
        )])
    };

    if let Some(i) = lig_idx {
        ligs.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.len().cmp(&a.1.len())));
        let firsts: Vec<u16> = {
            let mut f: Vec<u16> = ligs.iter().map(|l| l.0).collect();
            f.dedup();
            f
        };
        let sets = firsts
            .iter()
            .map(|&f| {
                LigatureSet::new(
                    ligs.iter()
                        .filter(|l| l.0 == f)
                        .map(|l| Ligature::new(GlyphId16::new(l.2), l.1.iter().map(|&g| GlyphId16::new(g)).collect()))
                        .collect(),
                )
            })
            .collect();
        lookups.push(SubstitutionLookup::Ligature(Lookup::new(
            LookupFlag::empty(),
            vec![LigatureSubstFormat1::new(coverage(firsts.clone()), sets)],
        )));
        feature_lookups.push(i);
    }

    // Variant index + 1 of every glyph (all blocks alike).
    let mut variant_class = vec![0u16; total - 1];
    for b in blocks {
        for start in b.starts() {
            for k in 0..n {
                variant_class[start as usize - 1 + k] = (k + 1) as u16;
            }
        }
    }

    if let (Some(i), Some(s0)) = (cycle_idx, singles_start) {
        let mut in_classes = vec![0u16; total - 1];
        for (k, b) in keys.iter().zip(blocks) {
            in_classes[b.base as usize - 1] = shift_for(&k.key, n);
        }
        let mut sets: Vec<Option<ChainedClassSequenceRuleSet>> = vec![None; n];
        for (s, set) in sets.iter_mut().enumerate().skip(1) {
            let rules: Vec<ChainedClassSequenceRule> = (0..n)
                .filter_map(|prev| {
                    let target = (prev + s) % n;
                    (target != 0).then(|| {
                        ChainedClassSequenceRule::new(
                            vec![(prev + 1) as u16],
                            vec![],
                            vec![],
                            vec![SequenceLookupRecord::new(0, s0 + target as u16 - 1)],
                        )
                    })
                })
                .collect();
            *set = Some(ChainedClassSequenceRuleSet::new(rules));
        }
        let chain = SubstitutionChainContext::from(ChainedSequenceContext::format_2(
            coverage(blocks.iter().map(|b| b.base).collect()),
            class_def(variant_class.clone()),
            class_def(in_classes),
            class_def(vec![]),
            sets,
        ));
        lookups.push(SubstitutionLookup::ChainContextual(Lookup::new(LookupFlag::empty(), vec![chain])));
        feature_lookups.push(i);
    }

    // Middle of a word: after any letter, the word-initial form becomes the middle form.
    let medial_cov: Vec<u16> = blocks
        .iter()
        .filter(|b| b.medial.is_some())
        .flat_map(|b| (0..n as u16).map(move |k| b.base + k))
        .collect();
    if let (Some(i), Some(delta)) = (medial_idx, medial_delta_idx) {
        let mut letter_class = vec![0u16; total - 1];
        for (k, b) in keys.iter().zip(blocks) {
            if k.key.chars().all(char::is_alphabetic) {
                for start in b.starts() {
                    for j in 0..n {
                        letter_class[start as usize - 1 + j] = 1;
                    }
                }
            }
        }
        let mut input_class = vec![0u16; total - 1];
        for &g in &medial_cov {
            input_class[g as usize - 1] = 1;
        }
        let chain = SubstitutionChainContext::from(ChainedSequenceContext::format_2(
            coverage(medial_cov.clone()),
            class_def(letter_class),
            class_def(input_class),
            class_def(vec![]),
            vec![None, Some(rule(1, delta))],
        ));
        lookups.push(SubstitutionLookup::ChainContextual(Lookup::new(LookupFlag::empty(), vec![chain])));
        feature_lookups.push(i);
    }

    // Abbreviations: capitals next to capitals (СССР) and letters at a dot (т.е., А.С.)
    // take their stand-alone forms. Classes: 1 = dot, 2 = capital letter, 3 = other letter.
    let is_cap = |k: &KeyGlyphs| k.key.chars().all(|c| c.is_alphabetic() && c.is_uppercase());
    let is_letter = |k: &KeyGlyphs| k.key.chars().all(char::is_alphabetic);
    let mut iso_pairs: Vec<(u16, u16)> = Vec::new(); // (form in use, its stand-alone form)
    for b in blocks {
        if let Some(iso) = b.iso {
            for start in [Some(b.base), b.medial].into_iter().flatten() {
                for j in 0..n as u16 {
                    iso_pairs.push((start + j, iso + j));
                }
            }
        }
    }
    iso_pairs.sort();
    if let (Some(i), Some(map)) = (iso_idx, iso_map_idx) {
        let mut context = vec![0u16; total - 1];
        let mut input = vec![0u16; total - 1];
        for (k, b) in keys.iter().zip(blocks) {
            let class = if k.key == "." {
                1
            } else if is_cap(k) {
                2
            } else if is_letter(k) {
                3
            } else {
                0
            };
            for start in b.starts() {
                for j in 0..n {
                    context[start as usize - 1 + j] = class;
                }
            }
        }
        for &(g, _) in &iso_pairs {
            let k = keys.iter().zip(blocks).find(|(_, b)| b.starts().any(|s| g >= s && g < s + n as u16)).unwrap().0;
            input[g as usize - 1] = if is_cap(k) { 1 } else { 2 };
        }
        let r = |back: Vec<u16>, ahead: Vec<u16>, apply: bool| {
            ChainedClassSequenceRule::new(back, vec![], ahead, if apply { vec![SequenceLookupRecord::new(0, map)] } else { vec![] })
        };
        // Rules are tried in order; a rule without lookups just stops the search ("not an abbreviation").
        let capitals = ChainedClassSequenceRuleSet::new(vec![
            r(vec![1], vec![], true),  // after a dot: А.С.
            r(vec![2], vec![], true),  // after a capital: СССР
            r(vec![], vec![2], true),  // before a capital
            r(vec![3], vec![1], false), // word ending before a dot
            r(vec![], vec![1], true),  // single capital before a dot
        ]);
        let small = ChainedClassSequenceRuleSet::new(vec![
            r(vec![1], vec![], true),  // after a dot: т.е.
            r(vec![2], vec![1], false),
            r(vec![3], vec![1], false), // "мама." — an ordinary word end
            r(vec![], vec![1], true),  // single letter before a dot
        ]);
        let chain = SubstitutionChainContext::from(ChainedSequenceContext::format_2(
            coverage(iso_pairs.iter().map(|p| p.0).collect()),
            class_def(context.clone()),
            class_def(input),
            class_def(context),
            vec![None, Some(capitals), Some(small)],
        ));
        lookups.push(SubstitutionLookup::ChainContextual(Lookup::new(LookupFlag::empty(), vec![chain])));
        feature_lookups.push(i);
    }

    // Entry adaptation works on each key's joining forms: the middle forms when they exist.
    let joining = |k: &KeyGlyphs, b: &Block| -> (u16, Vec<Option<Level>>) {
        match b.medial {
            Some(m) => (m, k.medial.iter().map(|g| g.entry).collect()),
            None => (b.base, k.variants.iter().map(|g| g.entry).collect()),
        }
    };
    let alt_cov: Vec<u16> = keys
        .iter()
        .zip(blocks)
        .filter(|(_, b)| b.alt.is_some())
        .flat_map(|(k, b)| {
            let start = joining(k, b).0;
            (0..n as u16).map(move |j| start + j)
        })
        .collect();
    if let (Some(i), Some(delta)) = (adapt_idx, alt_delta_idx) {
        // Backtrack: 1 = leaves high, 2 = leaves low.
        let mut exit_class = vec![0u16; total - 1];
        // Input: 1 = enters low (alternate enters high), 2 = enters high (alternate enters low).
        let mut entry_class = vec![0u16; total - 1];
        let level_class = |l: Option<Level>| match l {
            Some(Level::High) => 1,
            Some(Level::Low) => 2,
            None => 0,
        };
        for (k, b) in keys.iter().zip(blocks) {
            for (start, list) in [(Some(b.base), &k.variants), (b.medial, &k.medial), (b.alt, &k.alts), (b.iso, &k.isolated)] {
                if let Some(start) = start {
                    for (j, g) in list.iter().enumerate() {
                        exit_class[start as usize - 1 + j] = level_class(g.exit);
                    }
                }
            }
            if b.alt.is_some() {
                let (start, entries) = joining(k, b);
                for (j, e) in entries.into_iter().enumerate() {
                    entry_class[start as usize - 1 + j] = match e {
                        Some(Level::Low) => 1,
                        Some(Level::High) => 2,
                        None => 0,
                    };
                }
            }
        }
        let chain = SubstitutionChainContext::from(ChainedSequenceContext::format_2(
            coverage(alt_cov.clone()),
            class_def(exit_class),
            class_def(entry_class),
            class_def(vec![]),
            vec![None, Some(rule(1, delta)), Some(rule(2, delta))],
        ));
        lookups.push(SubstitutionLookup::ChainContextual(Lookup::new(LookupFlag::empty(), vec![chain])));
        feature_lookups.push(i);
    }

    // Referenced lookups: default glyph -> variant k (variants are consecutive ids).
    if singles_start.is_some() {
        let cov = coverage(blocks.iter().map(|b| b.base).collect());
        for k in 1..n {
            lookups.push(SubstitutionLookup::Single(Lookup::new(
                LookupFlag::empty(),
                vec![SingleSubst::format_1(cov.clone(), k as i16)],
            )));
        }
    }
    // Each extra block follows the block it is derived from, so a delta of N maps variant k to variant k.
    if medial_delta_idx.is_some() {
        lookups.push(SubstitutionLookup::Single(Lookup::new(
            LookupFlag::empty(),
            vec![SingleSubst::format_1(coverage(medial_cov), n as i16)],
        )));
    }
    if iso_map_idx.is_some() {
        lookups.push(SubstitutionLookup::Single(Lookup::new(
            LookupFlag::empty(),
            vec![SingleSubst::format_2(
                coverage(iso_pairs.iter().map(|p| p.0).collect()),
                iso_pairs.iter().map(|p| GlyphId16::new(p.1)).collect(),
            )],
        )));
    }
    if alt_delta_idx.is_some() {
        lookups.push(SubstitutionLookup::Single(Lookup::new(
            LookupFlag::empty(),
            vec![SingleSubst::format_1(coverage(alt_cov), n as i16)],
        )));
    }

    let feature_list = FeatureList::new(vec![FeatureRecord::new(Tag::new(b"calt"), Feature::new(None, feature_lookups))]);
    Some(Gsub::new(scripts(1), feature_list, SubstitutionLookupList::new(lookups)))
}

fn build_gpos(keys: &[KeyGlyphs], blocks: &[Block], num_glyphs: usize, letter_spacing: f64) -> Option<Gpos> {
    // Kerning classes: one per key (all its glyphs, base and alternates).
    // Spaces get classes too: a joining letter whose ink overhangs its exit
    // must not eat the following space.
    let is_space = |i: usize| keys[i].key.chars().all(char::is_whitespace);
    let kerned: Vec<usize> = (0..keys.len()).collect();
    if kerned.iter().filter(|&&i| !is_space(i)).count() < 1 {
        return None;
    }
    let n = keys[kerned[0]].variants.len();
    let mut class_of = vec![0u16; num_glyphs - 1];
    let mut covered = Vec::new();
    for (class, &ki) in kerned.iter().enumerate() {
        let b = &blocks[ki];
        for g in b.starts() {
            for k in 0..n as u16 {
                class_of[(g + k) as usize - 1] = class as u16 + 1;
                covered.push(g + k);
            }
        }
    }
    let envelopes: Vec<(Vec<f64>, Vec<f64>)> = kerned
        .iter()
        .map(|&ki| {
            let profiles: Vec<(Profile, f64)> = keys[ki]
                .variants
                .iter()
                .map(|g| {
                    let contours: Vec<Vec<[f64; 2]>> =
                        g.contours.iter().map(|c| c.iter().map(|p| [p[0] as f64, p[1] as f64]).collect()).collect();
                    (Profile::of(&contours, 0.0), g.advance as f64)
                })
                .collect();
            Profile::envelope(&profiles)
        })
        .collect();
    let joins_right = |k: &KeyGlyphs| majority(k.variants.iter().map(|g| g.exit), |e| e.is_some());
    let joins_left = |k: &KeyGlyphs| {
        let joining = if k.medial.is_empty() { &k.variants } else { &k.medial };
        majority(joining.iter().map(|g| g.entry), |e| e.is_some()) || !k.alts.is_empty()
    };

    let zero = || Class2Record::new(ValueRecord::new().with_x_advance(0), ValueRecord::new());
    let classes = kerned.len() + 1;
    let mut any = false;
    let mut records = vec![Class1Record::new(vec![zero(); classes])];
    for (a, &ka) in kerned.iter().enumerate() {
        let mut row = vec![zero()];
        for (b, &kb) in kerned.iter().enumerate() {
            let v = if is_space(ka) {
                0
            } else if is_space(kb) {
                // Ink past the advance (an exit tail inside a loop) + the normal side bearing.
                let overhang = envelopes[a].1.iter().cloned().fold(f64::NEG_INFINITY, f64::max) + letter_spacing;
                if overhang > 8.0 { overhang.round() as i16 } else { 0 }
            } else if joins_right(&keys[ka]) && joins_left(&keys[kb]) {
                0
            } else {
                let k = pair_kern(&envelopes[a].1, &envelopes[b].0, letter_spacing).round() as i16;
                if k.abs() < 8 { 0 } else { k }
            };
            any |= v != 0;
            row.push(Class2Record::new(ValueRecord::new().with_x_advance(v), ValueRecord::new()));
        }
        records.push(Class1Record::new(row));
    }
    if !any {
        return None;
    }
    let pair = PairPos::format_2(
        coverage(covered),
        ClassDef::format_1(GlyphId16::new(1), class_of.clone()),
        ClassDef::format_1(GlyphId16::new(1), class_of),
        records,
    );
    let lookups = PositionLookupList::new(vec![PositionLookup::Pair(Lookup::new(LookupFlag::empty(), vec![pair]))]);
    let features = FeatureList::new(vec![FeatureRecord::new(Tag::new(b"kern"), Feature::new(None, vec![0]))]);
    Some(Gpos::new(scripts(1), features, lookups))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: i16, y0: i16, x1: i16, y1: i16) -> Vec<[i16; 2]> {
        vec![[x0, y0], [x0, y1], [x1, y1], [x1, y0]]
    }

    fn glyph(w: u16, entry: Option<Level>, exit: Option<Level>) -> FontGlyph {
        FontGlyph { contours: vec![rect(40, 0, w as i16 - 40, 450)], advance: w, entry, exit }
    }

    fn key(k: &str, n: usize, entry: Option<Level>, exit: Option<Level>, alts: bool) -> KeyGlyphs {
        let variants: Vec<FontGlyph> = (0..n).map(|i| glyph(500 + i as u16, entry, exit)).collect();
        let alts = if alts { (0..n).map(|i| glyph(400 + i as u16, entry.map(Level::other), exit)).collect() } else { vec![] };
        KeyGlyphs { key: k.into(), variants, medial: vec![], alts, isolated: vec![] }
    }

    fn opts(n: usize) -> FontOptions {
        FontOptions { family: "Test Hand".into(), variants: n, kerning: true, letter_spacing: 45.0 }
    }

    pub fn shape(font: &[u8], text: &str) -> (Vec<u32>, Vec<i32>) {
        let face = rustybuzz::Face::from_slice(font, 0).expect("font parses");
        let mut buf = rustybuzz::UnicodeBuffer::new();
        buf.push_str(text);
        let out = rustybuzz::shape(&face, &[], buf);
        (
            out.glyph_infos().iter().map(|g| g.glyph_id).collect(),
            out.glyph_positions().iter().map(|p| p.x_advance).collect(),
        )
    }

    #[test]
    fn repeated_letters_get_different_variants() {
        let n = 7;
        let font = build_font(&opts(n), &[key(" ", n, None, None, false), key("а", n, None, None, false)]).unwrap();
        let (ids, _) = shape(&font, "ааааааа");
        let mut uniq = ids.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), 7, "seven repeats cover all seven variants: {ids:?}");
        let base = shape(&font, "а").0[0];
        assert!(ids.iter().all(|&g| g >= base && g < base + n as u32));
    }

    #[test]
    fn letter_pair_becomes_a_ligature_and_keeps_cycling() {
        let n = 5;
        let keys = [key("с", n, None, None, false), key("т", n, None, None, false), key("ст", n, None, None, false)];
        let font = build_font(&opts(n), &keys).unwrap();
        let (ids, _) = shape(&font, "стст");
        assert_eq!(ids.len(), 2, "two pair glyphs: {ids:?}");
        assert_ne!(ids[0], ids[1], "pair variants cycle too");
        let (single, _) = shape(&font, "тс");
        assert_eq!(single.len(), 2, "other order is not a pair");
    }

    #[test]
    fn letter_after_a_high_exit_switches_to_its_high_entry_alternate() {
        let n = 3;
        let keys = [
            key("о", n, None, Some(Level::High), false),
            key("л", n, Some(Level::Low), Some(Level::Low), true),
        ];
        let font = build_font(&opts(n), &keys).unwrap();
        let (alone, _) = shape(&font, "лл");
        let (after_o, adv) = shape(&font, "ол");
        let l_base = shape(&font, "л").0[0];
        assert!(alone.iter().all(|&g| g < l_base + n as u32), "after a low exit the normal form stays: {alone:?}");
        assert!(after_o[1] >= l_base + n as u32, "after о the high-entry alternate is used: {after_o:?}");
        assert_eq!(adv[1], 400 + (after_o[1] - l_base - n as u32) as i32, "alternate advance");
    }

    #[test]
    fn open_shapes_are_kerned_but_joined_letters_are_not() {
        let n = 1;
        // "Г"-like: stem + top bar; "о"-like: low box.
        let g = FontGlyph { contours: vec![rect(45, 0, 105, 700), rect(45, 640, 445, 700)], advance: 490, entry: None, exit: None };
        let o = FontGlyph { contours: vec![rect(45, 0, 345, 450)], advance: 390, entry: None, exit: None };
        let keys = [
            KeyGlyphs { key: "Г".into(), variants: vec![g], medial: vec![], alts: vec![], isolated: vec![] },
            KeyGlyphs { key: "о".into(), variants: vec![o], medial: vec![], alts: vec![], isolated: vec![] },
            key("м", n, Some(Level::Low), Some(Level::Low), false),
        ];
        let font = build_font(&opts(n), &keys).unwrap();
        let (_, adv) = shape(&font, "Го");
        assert!(adv[0] < 490 - 150, "Г is pulled over о: {adv:?}");
        let (_, joined) = shape(&font, "мм");
        assert_eq!(joined[0], 500, "joined letters keep their advance");
        let no_kern = build_font(&FontOptions { kerning: false, ..opts(n) }, &keys).unwrap();
        assert_eq!(shape(&no_kern, "Го").1[0], 490);
    }

    #[test]
    fn letters_inside_a_word_use_their_middle_forms() {
        let n = 3;
        let mut a = key("а", n, None, Some(Level::Low), false);
        a.medial = (0..n).map(|i| glyph(600 + i as u16, Some(Level::Low), Some(Level::Low))).collect();
        let keys = [a, key(" ", n, None, None, false), key(".", n, None, None, false)];
        let font = build_font(&opts(n), &keys).unwrap();
        let base = shape(&font, "а").0[0];
        let (ids, adv) = shape(&font, "аа а.а");
        let medial = |g: u32| g >= base + n as u32 && g < base + 2 * n as u32;
        assert!(!medial(ids[0]), "word start: initial form");
        assert!(medial(ids[1]), "after a letter: middle form {ids:?}");
        assert!(!medial(ids[3]), "after a space: initial form again");
        assert!(!medial(ids[5]), "after punctuation: initial form");
        assert!(adv[1] >= 600, "middle form advance");
    }

    #[test]
    fn abbreviations_use_stand_alone_forms() {
        let n = 3;
        let with_iso = |k: &str| {
            let mut g = key(k, n, Some(Level::Low), Some(Level::Low), false);
            g.isolated = (0..n).map(|i| glyph(700 + i as u16, None, None)).collect();
            g
        };
        let keys = [with_iso("С"), with_iso("Р"), with_iso("т"), with_iso("е"), with_iso("м"), key(".", n, None, None, false), key(" ", n, None, None, false)];
        let font = build_font(&opts(n), &keys).unwrap();
        let iso = |text: &str| -> Vec<bool> { shape(&font, text).1.iter().map(|&a| a >= 700).collect() };
        assert_eq!(iso("СССР"), vec![true; 4], "capitals in a row");
        assert_eq!(iso("т.е."), vec![true, false, true, false], "letters at dots");
        assert_eq!(iso("С.Р."), vec![true, false, true, false], "initials");
        assert_eq!(iso("тем."), vec![false, false, false, false], "an ordinary word before a full stop");
        assert_eq!(iso("Стем"), vec![false, false, false, false], "a capitalised word joins normally");
    }

    #[test]
    fn overhanging_exit_does_not_eat_the_space() {
        // Exit (advance) at 400, but the bowl's ink reaches 520.
        let v = FontGlyph { contours: vec![rect(40, 0, 520, 450)], advance: 400, entry: None, exit: Some(Level::High) };
        let keys = [
            KeyGlyphs { key: "в".into(), variants: vec![v], medial: vec![], alts: vec![], isolated: vec![] },
            KeyGlyphs { key: " ".into(), variants: vec![FontGlyph { advance: 280, ..Default::default() }], medial: vec![], alts: vec![], isolated: vec![] },
        ];
        let font = build_font(&opts(1), &keys).unwrap();
        let (_, adv) = shape(&font, "в ");
        assert_eq!(adv[0], 400 + 120 + 45, "advance grows by the overhang plus the side bearing");
        assert_eq!(adv[1], 280);
    }

    #[test]
    fn single_variant_font_still_shapes() {
        let font = build_font(&opts(1), &[key("а", 1, None, None, false)]).unwrap();
        let (ids, _) = shape(&font, "аа");
        assert_eq!(ids[0], ids[1]);
    }
}
