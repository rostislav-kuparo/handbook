//! The photo and small image helpers: linear light, bilinear sampling,
//! Gaussian blur, box downscaling.

use std::sync::OnceLock;

/// sRGB byte → linear light.
pub fn lut() -> &'static [f32; 256] {
    static LUT: OnceLock<[f32; 256]> = OnceLock::new();
    LUT.get_or_init(|| {
        let mut t = [0f32; 256];
        for (i, v) in t.iter_mut().enumerate() {
            let c = i as f64 / 255.0;
            *v = if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) } as f32;
        }
        t
    })
}

/// Linear light → sRGB byte.
#[cfg(test)]
pub fn to_srgb8(l: f64) -> u8 {
    let l = l.clamp(0.0, 1.0);
    let c = if l <= 0.0031308 { l * 12.92 } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 };
    (c * 255.0).round() as u8
}

/// One channel of floats.
#[derive(Clone)]
pub struct Gray {
    pub w: usize,
    pub h: usize,
    pub data: Vec<f32>,
}

impl Gray {
    pub fn new(w: usize, h: usize) -> Gray {
        Gray { w, h, data: vec![0.0; w * h] }
    }

    #[inline]
    pub fn at(&self, x: usize, y: usize) -> f32 {
        self.data[y * self.w + x]
    }

    /// Bilinear sample at pixel coordinates (pixel centres at +0.5); clamped at the border.
    pub fn sample(&self, x: f64, y: f64) -> f64 {
        let fx = (x - 0.5).clamp(0.0, (self.w - 1) as f64);
        let fy = (y - 0.5).clamp(0.0, (self.h - 1) as f64);
        let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(self.w - 1), (y0 + 1).min(self.h - 1));
        let (tx, ty) = ((fx - x0 as f64) as f32, (fy - y0 as f64) as f32);
        let top = self.at(x0, y0) * (1.0 - tx) + self.at(x1, y0) * tx;
        let bottom = self.at(x0, y1) * (1.0 - tx) + self.at(x1, y1) * tx;
        (top * (1.0 - ty) + bottom * ty) as f64
    }

    /// Separable Gaussian blur.
    pub fn blur(&self, sigma: f64) -> Gray {
        if sigma < 0.2 {
            return self.clone();
        }
        let r = (sigma * 3.0).ceil() as isize;
        let k: Vec<f32> = (-r..=r).map(|i| (-0.5 * (i * i) as f64 / (sigma * sigma)).exp() as f32).collect();
        let sum: f32 = k.iter().sum();
        let k: Vec<f32> = k.iter().map(|v| v / sum).collect();
        let (w, h) = (self.w as isize, self.h as isize);
        let mut tmp = Gray::new(self.w, self.h);
        for y in 0..h {
            let row = &self.data[(y * w) as usize..((y + 1) * w) as usize];
            for x in 0..w {
                let mut s = 0.0;
                for (j, kv) in k.iter().enumerate() {
                    let xx = (x + j as isize - r).clamp(0, w - 1) as usize;
                    s += row[xx] * kv;
                }
                tmp.data[(y * w + x) as usize] = s;
            }
        }
        let mut out = Gray::new(self.w, self.h);
        for y in 0..h {
            for x in 0..w {
                let mut s = 0.0;
                for (j, kv) in k.iter().enumerate() {
                    let yy = (y + j as isize - r).clamp(0, h - 1) as usize;
                    s += tmp.data[yy * self.w + x as usize] * kv;
                }
                out.data[(y * w + x) as usize] = s;
            }
        }
        out
    }
}

/// The photo: sRGB bytes as the camera wrote them, plus linear luminance.
pub struct Photo {
    pub w: usize,
    pub h: usize,
    pub rgba: Vec<u8>,
    pub luma: Gray,
    /// Luminance blurred a little, for finding edges far from where they were marked (made on demand).
    smooth: OnceLock<Gray>,
}

impl Photo {
    pub fn new(rgba: Vec<u8>, w: usize, h: usize) -> Photo {
        assert_eq!(rgba.len(), w * h * 4, "RGBA buffer does not match the size");
        let t = lut();
        let mut luma = Gray::new(w, h);
        for (i, v) in luma.data.iter_mut().enumerate() {
            let p = &rgba[i * 4..i * 4 + 3];
            *v = 0.2126 * t[p[0] as usize] + 0.7152 * t[p[1] as usize] + 0.0722 * t[p[2] as usize];
        }
        Photo { w, h, rgba, luma, smooth: OnceLock::new() }
    }

    pub fn smooth(&self) -> &Gray {
        self.smooth.get_or_init(|| self.luma.blur(1.5))
    }

    /// Linear value of channel `c` at a pixel.
    #[inline]
    pub fn lin(&self, x: usize, y: usize, c: usize) -> f32 {
        lut()[self.rgba[(y * self.w + x) * 4 + c] as usize]
    }

    #[inline]
    pub fn byte(&self, x: usize, y: usize, c: usize) -> u8 {
        self.rgba[(y * self.w + x) * 4 + c]
    }

    /// Bilinear sample of channel `c` in linear light at pixel coordinates (centres at +0.5).
    pub fn lin_at(&self, x: f64, y: f64, c: usize) -> f32 {
        let fx = (x - 0.5).clamp(0.0, (self.w - 1) as f64);
        let fy = (y - 0.5).clamp(0.0, (self.h - 1) as f64);
        let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(self.w - 1), (y0 + 1).min(self.h - 1));
        let (tx, ty) = ((fx - x0 as f64) as f32, (fy - y0 as f64) as f32);
        let top = self.lin(x0, y0, c) * (1.0 - tx) + self.lin(x1, y0, c) * tx;
        let bottom = self.lin(x0, y1, c) * (1.0 - tx) + self.lin(x1, y1, c) * tx;
        top * (1.0 - ty) + bottom * ty
    }
}
