// What the pipette writes into a drawing's commands: its origin on the blank
// (НаБланке) and points taken off the printing — hidden, since they are
// printed already, but there to build from.
import { compileSketch } from '../sketch/evaluate';
import { formulaOf } from '../sketch/formula';

/** A point of the sheet, mm from its top left corner (y down). */
export interface SheetMm {
  x: number;
  y: number;
}

/** A number as the commands write it: a tenth of a millimetre is plenty. */
export const mmText = (v: number) => {
  const r = Math.round(v * 10) / 10;
  return String(Object.is(r, -0) ? 0 : r);
};

/** The drawing's place on the blank, or null: it has none (or is a formula). */
export function anchorIn(code: string): { x: number; y: number; unit: number; xRight: boolean } | null {
  if (formulaOf(code) !== null) return null;
  const view = compileSketch(code).view;
  return view.blank ? { ...view.blank, xRight: !!view.xRight } : null;
}

const ANCHOR_LINE = /^(\s*)(?:НаБланке|OnBlank)\s*\(([^)]*)\)\s*$/imu;

/** The drawing's origin at `at`: its НаБланке line changed (its unit kept), or a new one at the top. */
export function withOrigin(code: string, at: SheetMm): string {
  const m = ANCHOR_LINE.exec(code);
  if (m) {
    const unit = m[2].split(',')[2]?.trim();
    return code.replace(ANCHOR_LINE, `${m[1]}НаБланке(${mmText(at.x)}, ${mmText(at.y)}${unit ? `, ${unit}` : ''})`);
  }
  return `НаБланке(${mmText(at.x)}, ${mmText(at.y)})${code.trim() ? `\n${code}` : ''}`;
}

/** A point of the sheet in the drawing's own units (x right, y up from its origin). */
export function inDrawing(code: string, at: SheetMm): { x: number; y: number } | null {
  const a = anchorIn(code);
  return a && { x: (at.x - a.x) / a.unit, y: (a.y - at.y) / a.unit };
}

/**
 * A point in space from its frontal (A₂) and horizontal (A₁) projection on
 * the sheet: x along the axis x₁₂ through the origin (to the left, as in
 * textbooks), y — how far A₁ is below the axis, z — how far A₂ is above it.
 * `gap`: how far apart the two projections are along the axis, mm (0 on a
 * true linking line).
 */
export function fromProjections(code: string, frontal: SheetMm, horizontal: SheetMm): { x: number; y: number; z: number; gap: number } | null {
  const a = anchorIn(code);
  if (!a) return null;
  const sx = a.xRight ? 1 : -1;
  const x = (sx * ((frontal.x + horizontal.x) / 2 - a.x)) / a.unit;
  return { x, y: (horizontal.y - a.y) / a.unit, z: (a.y - frontal.y) / a.unit, gap: Math.abs(frontal.x - horizontal.x) };
}

/** The commands with a point added: named, at these coordinates, not drawn again (it is printed). */
export function withPoint(code: string, name: string, coords: number[]): string {
  const line = `${name} = (${coords.map(mmText).join(', ')})\nСкрыть(${name})`;
  return code.trim() ? `${code.replace(/\s*$/, '')}\n${line}` : line;
}

/** Names already given in the commands (to suggest the next free one). */
export function namesIn(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(/^\s*([\p{L}][\p{L}\p{N}_'′]*)\s*=/gmu)) out.add(m[1]);
  return out;
}

/** A name not taken yet: A, B, C… (with `_1`, `_2` for projections taken one by one). */
export function nextName(code: string, suffix = ''): string {
  const taken = namesIn(code);
  for (const c of 'ABCDEFGHKLMNPQRST') if (!taken.has(c + suffix)) return c + suffix;
  for (let i = 1; ; i++) if (!taken.has(`P${i}${suffix}`)) return `P${i}${suffix}`;
}

/** A name the commands accept. */
export const validName = (s: string) => /^[\p{L}][\p{L}\p{N}_'′]*$/u.test(s) && !/^(x|y|z|pi|e)$/i.test(s);
