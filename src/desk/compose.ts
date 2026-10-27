// Writes the ink onto the photo on the GPU (WebGL2). Every pixel of the photo
// stays as it was except where ink lies: there it is multiplied by how much
// light the ink lets through, in linear light — so shadows, warm lamps and
// vignetting fall onto the writing by themselves. On top of that the ink
// takes what the photo measured of itself: its blur (per side of the sheet),
// the phone's sharpening, its grain, the glare, the paper's fibres — and
// behaves like the chosen pen.
import { PAPER } from '../editor/exporters';
import type { ObjectMask, Specular } from './analysis';
import type { Mat3 } from './homography';
import type { Photo } from './photo';

export type PenKind = 'ballpoint' | 'gel' | 'pencil';

export interface InkLook {
  pen: PenKind;
  /** Thickness of the ink layer: T = (ink / paper)^density, Beer–Lambert. */
  density: number;
  /** Softness of the ink like the photo's own blur: Gaussian sigma, photo px (the sides keep their measured proportions). */
  blur: number;
  /** Grain under the ink, × the photo's own (1: as measured). */
  grain: number;
  /** How much the paper's fibres show in the ink, × the pen's natural amount. */
  texture: number;
  /** Left of this fraction of the width the original photo is shown (0: the result everywhere). */
  split: number;
}

/** What the photo tells about itself (the analysis), copied onto the ink. */
export interface PhotoLook {
  /** Blur at the top, right, bottom and left edge relative to the typical one (1: even). */
  sides: [number, number, number, number];
  /** Unsharp-mask amount (radius `SHARPEN_RADIUS`) the phone added. */
  sharpen: number;
  /** Grain: variance a·L + b per channel (linear), shared by the channels as `rho`, smeared over `smooth` px. */
  noise: { a: number[]; b: number[]; rho: number; smooth: number };
  specular: Specular | null;
  /** Transmittance of a real pen taken from the photo (stands for density 0.35), or null. */
  calib: number[] | null;
}

export const SHARPEN_RADIUS = 1.2;

/** Until the photo is measured: grain of about 2 levels on bright paper, grey, slightly smeared. */
export const DEFAULT_PHOTO_LOOK: PhotoLook = {
  sides: [1, 1, 1, 1],
  sharpen: 0,
  noise: { a: [3.1e-4, 3.1e-4, 3.1e-4], b: [0, 0, 0], rho: 0.85, smooth: 0.6 },
  specular: null,
  calib: null,
};

/** Where the sheet lies in the photo. */
export interface Placement {
  /** The page as triangles: per vertex photo x, y, the perspective's w, and page u, v (0..1, y down). */
  mesh: Float32Array;
  indices: Uint16Array;
  /** Photo px → coordinates on the photographed paper (0..1). */
  toPaper: Mat3;
  /** The page in page px (for patterns that must stay put on the paper). */
  inkSize: [number, number];
  /** Mip level of the photo that averages ~0.4 mm of paper: fibres are compared with it. */
  fibreLod: number;
}

const PEN_CODE: Record<PenKind, number> = { ballpoint: 0, gel: 1, pencil: 2 };

const COMMON = /* glsl */ `
vec3 toLinear(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float uniform01(uint h) { return (float(h >> 8u) + 0.5) / 16777216.0; }
float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)) + 65536);
  return uniform01(pcg(q.x * 1973u + pcg(q.y + 9277u)));
}
// Smooth value noise in 0..1.
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}`;

const VERTEX = /* glsl */ `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

/** The page's mesh laid over the photo; w makes the perspective exact. */
const MESH_VERTEX = /* glsl */ `#version 300 es
in vec3 aPos;
in vec2 aUv;
uniform vec2 uSize;
out vec2 vUv;
void main() {
  vec2 ndc = vec2(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0);
  gl_Position = vec4(ndc * aPos.z, 0.0, aPos.z);
  vUv = aUv;
}`;

/** Transmittance of the ink at each photo pixel (1: bare paper), the way the chosen pen lays it. */
const WARP = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uInk;
uniform sampler2D uPen;
uniform sampler2D uPhoto;
uniform vec2 uInkSize;
uniform vec2 uSize;
uniform vec3 uPaper;
uniform vec3 uDocInk;
uniform vec3 uCalib;
uniform float uDensity;
uniform int uPenKind;
uniform float uTexture;
uniform float uFibreLod;
in vec2 vUv;
out vec4 outColor;
${COMMON}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y);
  vec2 uv = vUv;
  // Mipmaps and anisotropic filtering pick the right detail for the far edge of the sheet.
  vec4 ink = texture(uInk, uv);
  vec4 pen = texture(uPen, uv);
  float soft = texture(uInk, uv, 1.5).a;
  bool inside = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
  float a = inside ? ink.a : 0.0;
  if (a <= 0.0) {
    outColor = vec4(1.0);
    return;
  }
  vec3 color = ink.rgb / max(ink.a, 1e-4);

  // The pen here: pressure (1 at the letter's median) and the stroke's direction; none in drawings.
  float has = smoothstep(0.2, 0.6, pen.a);
  vec3 pv = pen.rgb / max(pen.a, 1e-4);
  float pn = mix(1.0, 0.3 + 1.2 * pv.r, has);
  float th = 0.5 * atan(2.0 * pv.b - 1.0, 2.0 * pv.g - 1.0);
  vec2 dir = vec2(cos(th), sin(th));
  vec2 P = uv * uInkSize;
  vec2 along = vec2(dot(P, dir), dot(P, vec2(-dir.y, dir.x)));

  // The paper's fibres: this pixel against the paper around it.
  vec2 pu = p / uSize;
  vec2 o = 0.5 * exp2(uFibreLod) / uSize;
  float around = 0.25 * (lum(textureLod(uPhoto, pu + o, uFibreLod).rgb) + lum(textureLod(uPhoto, pu - o, uFibreLod).rgb)
    + lum(textureLod(uPhoto, pu + vec2(o.x, -o.y), uFibreLod).rgb) + lum(textureLod(uPhoto, pu + vec2(-o.x, o.y), uFibreLod).rgb));
  float hp = clamp(lum(texelFetch(uPhoto, ivec2(p), 0).rgb) / max(around, 1e-4), 0.8, 1.25);

  vec3 base = clamp(toLinear(color) / uPaper, 1e-4, 1.0);
  if (uCalib.x >= 0.0 && distance(color, uDocInk) < 0.06) base = pow(clamp(uCalib, 1e-4, 1.0), vec3(1.0 / 0.35));
  float d = uDensity;
  if (uPenKind == 0) {
    // Ballpoint: thinner where pressed lightly, ink on the fibres' tops, and
    // streaks along the stroke where the ball runs dry (more under light pressure).
    d *= 0.7 + 0.3 * pn;
    d *= pow(hp, 1.5 * uTexture);
    float n = vnoise(vec2(along.x / 7.0, along.y / 0.9) + 17.0);
    float thr = 0.78 + 0.15 * (pn - 1.0);
    d *= 1.0 - 0.8 * has * smoothstep(thr, thr + 0.08, n);
  } else if (uPenKind == 1) {
    // Gel: dense and even, darker along the edges where the ink dries.
    d *= 1.6 * (0.92 + 0.08 * pn);
    d *= pow(hp, 0.3 * uTexture);
    d *= 1.0 + 0.8 * clamp(a - soft, 0.0, 1.0);
  } else {
    // Pencil: grey graphite on the fibres' tops, much lighter when pressed lightly.
    base = vec3(0.10, 0.10, 0.11);
    d *= 0.45 + 0.55 * pn;
    d *= pow(hp, 3.0 * uTexture);
    d *= 0.55 + 0.9 * vnoise(P / 0.8 + 3.0);
  }
  outColor = vec4(mix(vec3(1.0), pow(base, vec3(max(d, 0.0))), a), 1.0);
}`;

/** One direction of a Gaussian blur; sigma from the sides of the sheet unless fixed. */
const BLUR = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform ivec2 uDir;
uniform float uFixed;
uniform vec4 uSides;
uniform mat3 uToPaper;
uniform float uHeight;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 f = ivec2(gl_FragCoord.xy);
  float sigma = uFixed;
  if (sigma <= 0.0) {
    vec3 q = uToPaper * vec3(gl_FragCoord.x, uHeight - gl_FragCoord.y, 1.0);
    vec2 uv = clamp(q.xy / q.z, 0.0, 1.0);
    sigma = 0.5 * ((1.0 - uv.y) * uSides.x + uv.y * uSides.z + (1.0 - uv.x) * uSides.w + uv.x * uSides.y);
  }
  if (sigma < 0.15) {
    outColor = texelFetch(uSrc, f, 0);
    return;
  }
  int r = int(ceil(min(sigma, 8.0) * 3.0));
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int k = -24; k <= 24; k++) {
    if (k < -r || k > r) continue;
    float w = exp(-0.5 * float(k * k) / (sigma * sigma));
    sum += texelFetch(uSrc, clamp(f + uDir * k, ivec2(0), size - 1), 0).rgb * w;
    total += w;
  }
  outColor = vec4(sum / total, 1.0);
}`;

/** (Photo − glare) × transmittance + glare, with the camera's grain where the ink made it darker. */
const FINAL = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uPhoto;
uniform sampler2D uT;
uniform sampler2D uSoft;
uniform sampler2D uSpec;
uniform sampler2D uMask;
uniform bool uHasMask;
uniform vec2 uSize;
uniform float uSplit;
uniform float uSharpen;
uniform bool uHasSpec;
uniform vec3 uNoiseA;
uniform vec3 uNoiseB;
uniform float uRho;
uniform float uSmooth;
uniform float uGrain;
out vec4 outColor;
${COMMON}
// Four independent standard normal numbers for a pixel.
vec4 gauss4(ivec2 p) {
  uint h = pcg(uint(p.x + 65536) * 1973u + pcg(uint(p.y + 65536) + 9277u));
  uint h2 = pcg(h), h3 = pcg(h2), h4 = pcg(h3);
  float r1 = sqrt(-2.0 * log(uniform01(h))), r2 = sqrt(-2.0 * log(uniform01(h3)));
  float a1 = 6.2831853 * uniform01(h2), a2 = 6.2831853 * uniform01(h4);
  return vec4(r1 * cos(a1), r1 * sin(a1), r2 * cos(a2), r2 * sin(a2));
}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  ivec2 p = ivec2(f.x, int(uSize.y) - 1 - f.y);
  vec3 photo = texelFetch(uPhoto, p, 0).rgb;
  if (float(p.x) + 0.5 < uSplit) {
    outColor = vec4(toSrgb(photo), 1.0);
    return;
  }
  vec3 T = texelFetch(uT, f, 0).rgb;
  if (uSharpen > 0.0) T = clamp(T + uSharpen * (T - texelFetch(uSoft, f, 0).rgb), 0.0, 1.0);
  // Nothing is written over things lying on the sheet.
  if (uHasMask) T = mix(vec3(1.0), T, texture(uMask, (vec2(p) + 0.5) / uSize).r);
  vec3 S = uHasSpec ? min(texture(uSpec, (vec2(p) + 0.5) / uSize).rgb, photo) : vec3(0.0);
  vec3 lin = (photo - S) * T + S;
  if (uGrain > 0.0 && min(T.r, min(T.g, T.b)) < 0.999) {
    // What darker ink would have in grain, minus what is left of the photo's own.
    vec3 v = uNoiseA * photo * T * (1.0 - T) + uNoiseB * (1.0 - T * T);
    int r = uSmooth < 0.25 ? 0 : (uSmooth < 0.6 ? 1 : 2);
    vec3 n = vec3(0.0);
    float w2 = 0.0;
    for (int dy = -2; dy <= 2; dy++) {
      for (int dx = -2; dx <= 2; dx++) {
        if (abs(dx) > r || abs(dy) > r) continue;
        float w = r == 0 ? 1.0 : exp(-float(dx * dx + dy * dy) / (2.0 * uSmooth * uSmooth));
        vec4 g = gauss4(p + ivec2(dx, dy));
        n += w * (sqrt(uRho) * g.x + sqrt(1.0 - uRho) * g.yzw);
        w2 += w * w;
      }
    }
    lin += uGrain * sqrt(max(v, 0.0)) * n / sqrt(w2);
  }
  outColor = vec4(toSrgb(lin), 1.0);
}`;

const hexLinear = (hex: string): [number, number, number] => {
  const v = (i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return [lin(v(0)), lin(v(1)), lin(v(2))];
};

const hexSrgb = (hex: string): [number, number, number] => {
  const h = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#1f2a6b';
  return [0, 1, 2].map((i) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16) / 255) as [number, number, number];
};

/** GLSL wants matrices by columns. */
const columns = (m: Mat3) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

type Program = { prog: WebGLProgram; loc: (name: string) => WebGLUniformLocation | null };
type Target = { tex: WebGLTexture; fb: WebGLFramebuffer };

export class DeskRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly maxTexture: number;
  private readonly warp: Program;
  private readonly blur: Program;
  private readonly final: Program;
  private photo: WebGLTexture | null = null;
  private ink: WebGLTexture | null = null;
  private pen: WebGLTexture | null = null;
  private spec: WebGLTexture | null = null;
  private specOf: Specular | null = null;
  private mask: WebGLTexture | null = null;
  private place: Placement | null = null;
  private targets: Target[] = [];
  private readonly quad: WebGLVertexArrayObject;
  private readonly meshVao: WebGLVertexArrayObject;
  private readonly meshBuf: WebGLBuffer;
  private readonly meshIdx: WebGLBuffer;
  private meshCount = 0;
  private width = 0;
  private height = 0;
  private readonly floatTargets: boolean;
  private readonly aniso: EXT_texture_filter_anisotropic | null;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: false });
    if (!gl) throw new Error('Видеокарта недоступна: этому окну не дали WebGL2.');
    this.gl = gl;
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.warp = this.program(WARP, MESH_VERTEX);
    this.blur = this.program(BLUR);
    this.final = this.program(FINAL);
    // One triangle covering the whole viewport, for the passes over every pixel.
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // The page's mesh.
    this.meshVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.meshVao);
    this.meshBuf = gl.createBuffer()!;
    this.meshIdx = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuf);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshIdx);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);
  }

  private program(fragment: string, vertex = VERTEX): Program {
    const gl = this.gl;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Шейдер: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, vertex));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, fragment));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aUv');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Шейдер: ${gl.getProgramInfoLog(prog)}`);
    const cache = new Map<string, WebGLUniformLocation | null>();
    const loc = (name: string) => {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(prog, name));
      return cache.get(name)!;
    };
    return { prog, loc };
  }

  /**
   * The photo, kept as sRGB: the GPU turns it into linear light on every read.
   * Its mipmaps give the paper's local average, against which fibres show.
   */
  setPhoto(photo: Photo) {
    const gl = this.gl;
    this.width = photo.width;
    this.height = photo.height;
    this.canvas.width = photo.width;
    this.canvas.height = photo.height;
    if (this.photo) gl.deleteTexture(this.photo);
    this.photo = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.photo);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, photo.bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.params(gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
    for (const t of this.targets) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
    }
    this.targets = [this.target(), this.target()];
  }

  /** Premultiplied, so mipmaps leave no dark fringe. */
  private upload(old: WebGLTexture | null, raster: HTMLCanvasElement): WebGLTexture {
    const gl = this.gl;
    if (old) gl.deleteTexture(old);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, raster);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.params(gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
    if (this.aniso) {
      const max = gl.getParameter(this.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
      gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, max));
    }
    return tex;
  }

  /** The sheet's ink, the pen's pressure and direction under it, and where the sheet lies. */
  setInk(ink: HTMLCanvasElement, pen: HTMLCanvasElement, place: Placement) {
    this.ink = this.upload(this.ink, ink);
    this.pen = this.upload(this.pen, pen);
    this.place = place;
    const gl = this.gl;
    gl.bindVertexArray(this.meshVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuf);
    gl.bufferData(gl.ARRAY_BUFFER, place.mesh, gl.STATIC_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, place.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.meshCount = place.indices.length;
  }

  private params(min: number, mag: number) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** A photo-sized buffer for the transmittance; half floats when the GPU can draw into them (8 bits band after blurring). */
  private target(): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, this.floatTargets ? gl.RGBA16F : gl.RGBA8, this.width, this.height);
    this.params(gl.NEAREST, gl.NEAREST);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb };
  }

  /** Where the sheet is free (255) and where objects lie (0), or null: write everywhere. */
  setMask(mask: ObjectMask | null) {
    const gl = this.gl;
    if (this.mask) gl.deleteTexture(this.mask);
    this.mask = null;
    if (!mask) return;
    this.mask = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.width, mask.height, 0, gl.RED, gl.UNSIGNED_BYTE, mask.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.params(gl.LINEAR, gl.LINEAR);
  }

  /** The glare map, uploaded when it changes. */
  private glare(spec: Specular | null): WebGLTexture | null {
    if (spec === this.specOf) return this.spec;
    const gl = this.gl;
    if (this.spec) gl.deleteTexture(this.spec);
    this.spec = null;
    this.specOf = spec;
    if (!spec) return null;
    this.spec = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.spec);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, spec.width, spec.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, spec.rgba);
    this.params(gl.LINEAR, gl.LINEAR);
    return this.spec;
  }

  private pass(p: Program, target: WebGLFramebuffer | null, textures: [string, WebGLTexture | null][], set: () => void) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(p.prog);
    textures.forEach(([name, tex], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(p.loc(name), unit);
    });
    set();
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** The warp pass: bare paper (T = 1) everywhere, then the page's mesh over it. */
  private drawMesh(target: Target, textures: [string, WebGLTexture][], set: () => void) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.warp.prog);
    textures.forEach(([name, tex], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(this.warp.loc(name), unit);
    });
    set();
    gl.bindVertexArray(this.meshVao);
    gl.drawElements(gl.TRIANGLES, this.meshCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  render(look: InkLook, ph: PhotoLook, docInk: string) {
    const gl = this.gl;
    const place = this.place;
    if (!this.photo || !this.ink || !this.pen || !place) return;
    const [a, b] = this.targets;
    const paper = hexLinear(PAPER);
    const spec = this.glare(ph.specular);

    this.drawMesh(
      a,
      [
        ['uInk', this.ink],
        ['uPen', this.pen],
        ['uPhoto', this.photo],
      ],
      () => {
        const u = (n: string) => this.warp.loc(n);
        gl.uniform2f(u('uInkSize'), ...place.inkSize);
        gl.uniform2f(u('uSize'), this.width, this.height);
        gl.uniform3f(u('uPaper'), ...paper);
        gl.uniform3f(u('uDocInk'), ...hexSrgb(docInk));
        gl.uniform3f(u('uCalib'), ...((ph.calib ?? [-1, -1, -1]) as [number, number, number]));
        gl.uniform1f(u('uDensity'), look.density);
        gl.uniform1i(u('uPenKind'), PEN_CODE[look.pen]);
        gl.uniform1f(u('uTexture'), look.texture);
        gl.uniform1f(u('uFibreLod'), place.fibreLod);
      },
    );

    const blurPass = (src: Target, dst: Target, dir: [number, number], fixed: number) =>
      this.pass(this.blur, dst.fb, [['uSrc', src.tex]], () => {
        const u = (n: string) => this.blur.loc(n);
        gl.uniform2i(u('uDir'), ...dir);
        gl.uniform1f(u('uFixed'), fixed);
        gl.uniform4f(u('uSides'), ...(ph.sides.map((k) => k * look.blur) as [number, number, number, number]));
        gl.uniformMatrix3fv(u('uToPaper'), false, columns(place.toPaper));
        gl.uniform1f(u('uHeight'), this.height);
      });
    if (look.blur >= 0.15) {
      blurPass(a, b, [1, 0], 0);
      blurPass(b, a, [0, 1], 0);
    }
    // The phone's sharpening: a softer copy to subtract.
    const sharpen = ph.sharpen >= 0.05;
    if (sharpen) {
      if (this.targets.length < 3) this.targets.push(this.target());
      const c = this.targets[2];
      blurPass(a, b, [1, 0], SHARPEN_RADIUS);
      blurPass(b, c, [0, 1], SHARPEN_RADIUS);
    }

    this.pass(
      this.final,
      null,
      [
        ['uPhoto', this.photo],
        ['uT', a.tex],
        ['uSoft', sharpen ? this.targets[2].tex : a.tex],
        ['uSpec', spec ?? a.tex],
        ['uMask', this.mask ?? a.tex],
      ],
      () => {
        const u = (n: string) => this.final.loc(n);
        const n = ph.noise;
        gl.uniform2f(u('uSize'), this.width, this.height);
        gl.uniform1f(u('uSplit'), look.split * this.width);
        gl.uniform1f(u('uSharpen'), sharpen ? ph.sharpen : 0);
        gl.uniform1i(u('uHasSpec'), spec ? 1 : 0);
        gl.uniform1i(u('uHasMask'), this.mask ? 1 : 0);
        gl.uniform3f(u('uNoiseA'), n.a[0], n.a[1], n.a[2]);
        gl.uniform3f(u('uNoiseB'), n.b[0], n.b[1], n.b[2]);
        gl.uniform1f(u('uRho'), Math.min(1, Math.max(0, n.rho)));
        gl.uniform1f(u('uSmooth'), n.smooth);
        gl.uniform1f(u('uGrain'), look.grain);
      },
    );
  }

  /** The current picture as a JPEG file. */
  async jpeg(quality = 0.92): Promise<Blob> {
    const blob = await new Promise<Blob | null>((res) => this.canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob) throw new Error('Не удалось сохранить картинку');
    return blob;
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
