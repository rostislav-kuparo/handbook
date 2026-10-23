// Drawings hidden in plain text: commands between ``` lines (what neural nets
// answer with), or between ёёё — the same key in the Russian layout.
import { compileSketch } from './evaluate';

/** A fence line: ``` or ~~~ or ёёё, optionally with a label (```geogebra). */
export const FENCE = /^\s*(`{3,}|~{3,}|[ёЁ]{3,})\s*([\p{L}\p{N}_+#.-]*)\s*$/u;

/** Labels that always mean a drawing. Any other label (```python) is someone else's code. */
const SKETCH_LABELS = new Set(['geogebra', 'ggb', 'чертёж', 'чертеж', 'sketch', 'drawing', 'черт']);

export interface SketchFence {
  /** Line (paragraph) indices of the opening and closing fences. */
  open: number;
  close: number;
  code: string;
  title: string;
}

/**
 * The commands, if these lines are a drawing. Unlabelled text counts only
 * when it draws something and nearly every line is a working command, so
 * ordinary code or prose between ``` stays text.
 */
export function sketchOf(label: string, lines: string[]): { code: string; title: string } | null {
  const tag = label.trim().toLowerCase();
  if (tag && !SKETCH_LABELS.has(tag)) return null;
  const code = lines.join('\n').trim();
  if (!code) return null;
  const scene = compileSketch(code);
  const drawn = scene.items.length > 0 || !!scene.title;
  if (!tag) {
    const statements = code.split('\n').filter((l) => l.trim() && !/^\s*(#|\/\/)/.test(l)).length;
    const broken = new Set(scene.errors.map((e) => e.line)).size;
    if (!drawn || broken * 3 > statements) return null;
  }
  return { code, title: scene.title?.trim() || 'Чертёж' };
}

/** Closed fences around drawings, in order. Fences are paired top to bottom. */
export function findSketchFences(lines: string[]): SketchFence[] {
  const out: SketchFence[] = [];
  let open: { at: number; label: string } | null = null;
  lines.forEach((text, i) => {
    const m = FENCE.exec(text);
    if (!m) return;
    // A fence with a label always opens: the previous one was never closed.
    if (!open || m[2]) {
      open = { at: i, label: m[2] };
      return;
    }
    const found = sketchOf(open.label, lines.slice(open.at + 1, i));
    if (found) out.push({ open: open.at, close: i, ...found });
    open = null;
  });
  return out;
}
