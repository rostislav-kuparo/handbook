import type { Expr } from './lang';

export interface Vec {
  x: number;
  y: number;
}

/** A point in space (descriptive geometry): x along the axis x₁₂, y towards the viewer, z up. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type SpaceKind = 'point' | 'segment' | 'ray' | 'line' | 'vector' | 'polygon';

/** Geometry in world coordinates (y up), as the commands build it. */
export type Shape =
  | { type: 'point'; p: Vec }
  | { type: 'segment'; a: Vec; b: Vec }
  /** From a through b and on. */
  | { type: 'ray'; a: Vec; b: Vec }
  /** Through a and b. */
  | { type: 'line'; a: Vec; b: Vec }
  | { type: 'vector'; a: Vec; b: Vec }
  | { type: 'circle'; c: Vec; r: number }
  /** Angles in radians; sweep > 0 is counterclockwise. */
  | { type: 'arc'; c: Vec; r: number; from: number; sweep: number }
  | { type: 'polygon'; pts: Vec[] }
  /** The angle mark at vertex v, from direction `from` turning by `sweep` (|sweep| ≤ π). */
  | { type: 'angle'; v: Vec; from: number; sweep: number }
  | { type: 'graph'; f: (x: number) => number; domain: [number, number] | null }
  | { type: 'curve'; f: (t: number) => Vec; t0: number; t1: number }
  | { type: 'text'; text: string; at: Vec | null }
  /** A figure in space; the drawing shows it as an epure, by its projections (see epure.ts). */
  | { type: 'space'; of: SpaceKind; pts: Vec3[] };

export type Val =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  /** Points, figures, graphs (a function is its graph). */
  | { k: 'shape'; s: Shape }
  | { k: 'none' };

/** Something on the drawing, with the look the commands gave it. */
export interface Item {
  shape: Shape;
  /** Lookup key (see canon). */
  name?: string;
  /** The name as written: A_1, f. */
  label?: string;
  caption?: string;
  showLabel: boolean;
  /** Pen colour, or undefined for the document pen. */
  color?: string;
  /** 0 solid, 1 dashed, 2 short dashes, 3 dotted, 4 dash-dot (as in GeoGebra). */
  lineStyle: number;
  /** 1..13, 5 is normal (as in GeoGebra). */
  thickness: number;
  /** 0..1: hatching inside polygons and circles. */
  filling: number;
  hidden: boolean;
  /** Source line, 1-based. */
  line: number;
  /** Seeds the hand: the same line always shakes the same way. */
  seed: number;
}

export interface View {
  x?: [number, number];
  y?: [number, number];
  /** The window was given in multiples of π: ticks go by π/2. */
  xPi?: boolean;
  yPi?: boolean;
  axes?: boolean;
  grid?: boolean;
  /** Length of a y unit / length of an x unit; set when the scale must be fixed. */
  ratio?: number;
  /** Projection planes of the epure: 1 horizontal, 2 frontal, 3 profile. */
  planes?: number[];
  /** The x axis of the epure points right (textbooks point it left). */
  xRight?: boolean;
  /** The drawing is an epure: figures in space were turned into projections. */
  epure?: boolean;
}

export interface Scene {
  items: Item[];
  title?: string;
  view: View;
  errors: { line: number; message: string }[];
}

/** What a command can do with its arguments. */
export interface Ctx {
  val(e: Expr): Val;
  num(e: Expr): number;
  /** A point: A, (1, 2), Midpoint(A, B). */
  point(e: Expr): Vec;
  /** A point on the sheet (x, y) or in space (x, y, z). */
  pointAny(e: Expr): Vec | Vec3;
  /** A shift: a vector or a point taken as one. */
  vec(e: Expr): Vec;
  /** Any figure; functions become graphs. */
  shape(e: Expr): Shape;
  /** A function of `param` (x by default): an expression or a function's name. */
  fn(e: Expr, param?: string): (x: number) => number;
  str(e: Expr): string;
  bool(e: Expr): boolean;
  /** An object on the drawing, by name, to change its look. */
  item(e: Expr): Item;
  /** Whether the expression is written with π (ticks then go by π/2). */
  usesPi(e: Expr): boolean;
  scene: Scene;
  /** Where graphs are searched for intersections: the window, or −10…10. */
  range(): [number, number];
}
