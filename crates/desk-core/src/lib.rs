//! desk-core: looks at a photo of a sheet on a desk, so handwriting can be
//! written onto it believably.
//!
//! Compiled to WebAssembly and driven from its own Web Worker. Finds the
//! sheet and its edges to a fraction of a pixel, measures the photo's blur
//! (on the sheet's edge) and noise (on the blank paper), maps the glare, reads
//! the colour of a real pen from words written on the sheet, finds a
//! notebook's printed lines and the things lying on the sheet.

mod calib;
mod edges;
mod img;
mod light;
mod mask;
mod noise;
mod quad;
mod rng;
mod ruling;
mod sheet;
mod warp;

#[cfg(test)]
mod tests;

pub use img::Photo;
pub use quad::Pt;

use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Radius of the unsharp mask the shader uses to copy the camera's sharpening, photo px.
pub const SHARPEN_RADIUS: f64 = 1.2;

/// The sheet as found: corners on its edges, how sure, which sides lie on a
/// found edge, and whether the photo is a scan (the sheet fills the frame).
#[derive(Serialize, Debug)]
pub struct Sheet {
    pub corners: [Pt; 4],
    pub confidence: f64,
    pub snapped: [bool; 4],
    pub scan: bool,
}

/// Bright paper on a darker desk first; on a desk as light as the paper, the
/// region its printed lines cover, its sides then moved out onto the edges.
pub fn find(photo: &Photo) -> Option<Sheet> {
    let lined = sheet::find_by_lines(photo);
    // Printed lines up to every border of the frame: a scan, whatever the brightness says.
    if let Some(b) = lined.as_ref().filter(|b| b.scan) {
        return Some(Sheet { corners: b.found.corners, confidence: 1.0, snapped: [false; 4], scan: true });
    }
    // The bright region — unless it is much smaller than the lined one (uneven light cut the sheet).
    let bright = sheet::find_sheet(photo).filter(|f| f.confidence >= 0.6);
    if let Some(f) = bright.filter(|f| lined.as_ref().is_none_or(|b| quad::area(&f.corners) >= 0.7 * quad::area(&b.found.corners))) {
        let s = edges::snap(photo, f.corners, [true; 4]);
        return Some(Sheet { corners: s.corners, confidence: f.confidence, snapped: s.snapped, scan: false });
    }
    let b = lined?;
    // The sides through the outermost lined blocks lie up to half a block
    // outside the paper's edge or (where a block was not lined enough) more
    // than a block inside it: look mostly outward — not inward as far as a
    // margin line printed near the edge.
    let s = edges::snap_within(photo, b.found.corners, [true; 4], edges::reach(photo).max(b.slack), 0.5 * b.slack);
    Some(Sheet { corners: s.corners, confidence: b.found.confidence, snapped: s.snapped, scan: false })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Measure {
    /// Blur of the photo at each side of the sheet (top, right, bottom, left), Gaussian sigma in px; null where the edge could not be read.
    pub sides: [Option<f64>; 4],
    /// The typical blur (median over the sides).
    pub sigma: Option<f64>,
    /// Unsharp-mask amount that copies the camera's sharpening (radius `SHARPEN_RADIUS`).
    pub sharpen: f64,
    pub noise: Option<noise::Noise>,
    /// The blur and sharpening rest on at least two edges of the sheet.
    pub reliable: bool,
}

/// What the photo says about itself. Blur and sharpening are read only on
/// the sides `on` (those lying on a found edge — elsewhere the «edge» may be
/// anything); fewer than two such sides leave them unknown.
pub fn measure(photo: &Photo, corners: &[Pt; 4], on: [bool; 4]) -> Measure {
    let blurs: Vec<Option<edges::EdgeBlur>> = (0..4).map(|k| if on[k] { edges::edge_blur(photo, corners[k], corners[(k + 1) % 4]) } else { None }).collect();
    let mut sig: Vec<f64> = blurs.iter().flatten().map(|b| b.sigma).collect();
    sig.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let reliable = sig.len() >= 2;
    let sigma = reliable.then(|| sig[sig.len() / 2]);
    let mut amounts: Vec<f64> = blurs.iter().flatten().map(|b| b.sharpen).collect();
    amounts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    // A phone rarely sharpens more than this; more means the edges misled.
    let sharpen = if reliable { amounts[amounts.len() / 2].min(1.5) } else { 0.0 };
    Measure {
        sides: std::array::from_fn(|k| blurs[k].map(|b| b.sigma)),
        sigma,
        sharpen,
        noise: noise::measure_noise(photo, corners),
        reliable,
    }
}

fn corners_of(json: &str) -> Result<[Pt; 4], JsError> {
    Ok(serde_json::from_str(json)?)
}

#[wasm_bindgen]
pub struct Desk {
    photo: Photo,
}

#[wasm_bindgen]
impl Desk {
    /// `rgba`: the photo's pixels, sRGB, row by row.
    #[wasm_bindgen(constructor)]
    pub fn new(rgba: Vec<u8>, width: u32, height: u32) -> Result<Desk, JsError> {
        if rgba.len() != width as usize * height as usize * 4 {
            return Err(JsError::new("размер снимка не совпадает с его пикселями"));
        }
        Ok(Desk { photo: Photo::new(rgba, width as usize, height as usize) })
    }

    /// JSON `{ corners, confidence, snapped, scan }` or `null`: the sheet found and its sides moved onto the real edges.
    #[wasm_bindgen(js_name = findSheet)]
    pub fn find_sheet(&self) -> Result<String, JsError> {
        Ok(serde_json::to_string(&find(&self.photo))?)
    }

    /// `corners`: JSON `[[x, y] × 4]`; `which`: JSON `[bool × 4]`, the sides to move onto the real edges.
    /// Returns `{ corners, snapped, rms }`.
    pub fn snap(&self, corners: &str, which: &str) -> Result<String, JsError> {
        let which: [bool; 4] = serde_json::from_str(which)?;
        Ok(serde_json::to_string(&edges::snap(&self.photo, corners_of(corners)?, which))?)
    }

    /// `{ sides, sigma, sharpen, noise, reliable }` for the sheet with these corners;
    /// `sides`: JSON `[bool × 4]`, the sides lying on a found edge.
    pub fn measure(&self, corners: &str, sides: &str) -> Result<String, JsError> {
        let on: [bool; 4] = serde_json::from_str(sides)?;
        Ok(serde_json::to_string(&measure(&self.photo, &corners_of(corners)?, on))?)
    }

    /// The glare `scale` times smaller than the photo: width and height (u32, little-endian), then RGBA; empty without glare.
    #[wasm_bindgen(js_name = specularMap)]
    pub fn specular_map(&self, corners: &str, scale: u32) -> Result<Vec<u8>, JsError> {
        Ok(match light::specular_map(&self.photo, &corners_of(corners)?, scale.max(1) as usize) {
            Some(m) => {
                let mut out = Vec::with_capacity(8 + m.rgba.len());
                out.extend_from_slice(&(m.w as u32).to_le_bytes());
                out.extend_from_slice(&(m.h as u32).to_le_bytes());
                out.extend_from_slice(&m.rgba);
                out
            }
            None => Vec::new(),
        })
    }

    /// The real pen's ink around (x, y): `{ t, width, pixels }` or `null`.
    pub fn calibrate(&self, x: f64, y: f64, radius: f64, sigma: f64) -> Result<String, JsError> {
        Ok(serde_json::to_string(&calib::calibrate(&self.photo, x, y, radius, sigma))?)
    }

    /// The printed lines of a `w_mm`×`h_mm` sheet laid out by `warp` (JSON `{ corners, bulge?, grid? }`):
    /// `{ kind, step, colStep, offset, slope, colOffset, margins: { left, right, top, bottom }, strength }` (mm) or `null`.
    pub fn ruling(&self, warp: &str, w_mm: f64, h_mm: f64) -> Result<String, JsError> {
        let warp: warp::Warp = serde_json::from_str(warp)?;
        Ok(serde_json::to_string(&ruling::detect(&self.photo, &warp, w_mm, h_mm))?)
    }

    /// The sheet's edges as curves: `{ corners, bulge, max, fitted }`.
    #[wasm_bindgen(js_name = curvedSides)]
    pub fn curved_sides(&self, corners: &str) -> Result<String, JsError> {
        Ok(serde_json::to_string(&edges::curved_sides(&self.photo, corners_of(corners)?))?)
    }

    /// A curved sheet straightened by its printed lines (step, offset, slope from `ruling`):
    /// `{ grid: { nx, ny, d }, before, after }` — the corrections and how far the lines strayed (mm).
    #[allow(clippy::too_many_arguments)]
    pub fn bend(&self, warp: &str, w_mm: f64, h_mm: f64, step: f64, offset: f64, slope: f64, nx: u32, ny: u32) -> Result<String, JsError> {
        let warp: warp::Warp = serde_json::from_str(warp)?;
        let b = ruling::bend(&self.photo, &warp, w_mm, h_mm, step, offset, slope, nx.max(2) as usize, ny.max(2) as usize);
        Ok(serde_json::to_string(&b)?)
    }

    /// Things on the sheet, `scale` times smaller than the photo: width, height
    /// and the number of objects (u32, little-endian), then one byte per pixel
    /// (255: free paper, 0: under an object).
    #[wasm_bindgen(js_name = objectMask)]
    pub fn object_mask(&self, corners: &str, w_mm: f64, h_mm: f64, scale: u32) -> Result<Vec<u8>, JsError> {
        let m = mask::object_mask(&self.photo, &corners_of(corners)?, w_mm, h_mm, scale.max(1) as usize);
        let mut out = Vec::with_capacity(12 + m.data.len());
        for v in [m.w as u32, m.h as u32, m.objects as u32] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&m.data);
        Ok(out)
    }
}
