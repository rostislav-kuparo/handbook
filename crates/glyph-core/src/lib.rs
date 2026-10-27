//! glyph-core: the handwriting engine behind Handbook.
//!
//! Compiled to WebAssembly and driven from a Web Worker. All heavy lifting —
//! stroke cleanup, variant synthesis, outlines, font compilation and ink
//! rendering — happens here; the UI only captures strokes and shows results.

mod deal;
mod derive;
mod engine;
mod font;
mod geom;
mod kern;
mod model;
mod outline;
mod rng;
mod shape_model;
mod synth;

pub use engine::EngineCore;
pub use model::{Anchor, InkPoint, Sample, Style};

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Engine {
    core: EngineCore,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Engine {
        Engine { core: EngineCore::new() }
    }

    #[wasm_bindgen(js_name = setFamily)]
    pub fn set_family(&mut self, family: &str) {
        self.core.set_family(family);
    }

    /// `json`: Style object (camelCase).
    #[wasm_bindgen(js_name = setStyle)]
    pub fn set_style(&mut self, json: &str) -> Result<(), JsError> {
        self.core.set_style(serde_json::from_str(json)?);
        Ok(())
    }

    /// `json`: array of Sample objects.
    #[wasm_bindgen(js_name = setSamples)]
    pub fn set_samples(&mut self, json: &str) -> Result<(), JsError> {
        self.core.set_samples(serde_json::from_str(json)?);
        Ok(())
    }

    /// JSON `{ chars, derived: [{key, from}], joinLow, joinHigh, learned: {key: components} }`.
    pub fn info(&self) -> Result<String, JsError> {
        Ok(serde_json::to_string(&self.core.info())?)
    }

    /// TrueType font bytes.
    #[wasm_bindgen(js_name = buildFont)]
    pub fn build_font(&mut self) -> Result<Vec<u8>, JsError> {
        self.core.build_font().map_err(|e| JsError::new(&e))
    }

    /// JSON array of `{ d, advance, entry, exit }`.
    pub fn preview(&self, key: &str, count: usize, seed: u32) -> Result<String, JsError> {
        Ok(serde_json::to_string(&self.core.preview(key, count, seed))?)
    }

    /// `json`: one Sample. Returns `{ d, xMin, xMax, yMin, yMax }`.
    #[wasm_bindgen(js_name = sampleOutline)]
    pub fn sample_outline(&self, json: &str) -> Result<String, JsError> {
        let s: Sample = serde_json::from_str(json)?;
        Ok(serde_json::to_string(&self.core.sample_outline(&s))?)
    }

    /// Returns `{ width, height, lines, d, missing, fallback }` in font units.
    /// `fallback_widths`: JSON `{ "ж": 540, ... }` — measured widths of characters without samples.
    /// `char_styles`: JSON `{ scales: number[], colors: number[] }` per character (may be `{}`).
    #[wasm_bindgen(js_name = renderParagraph)]
    pub fn render_paragraph(
        &self,
        text: &str,
        width: f64,
        line_height: f64,
        seed: u32,
        fallback_widths: &str,
        char_styles: &str,
    ) -> Result<String, JsError> {
        let widths: std::collections::HashMap<String, f64> = serde_json::from_str(fallback_widths).unwrap_or_default();
        let styles: engine::CharStyles = serde_json::from_str(char_styles).unwrap_or_default();
        Ok(serde_json::to_string(&self.core.render_paragraph(text, width, line_height, seed, &widths, &styles))?)
    }
}
