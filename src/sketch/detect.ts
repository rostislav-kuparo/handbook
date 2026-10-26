// Drawings hidden in plain text: commands between ``` lines (what neural nets
// answer with), or between ёёё — the same key in the Russian layout.
import { compileSketch } from './evaluate';

const MARK = '(`{3,}|~{3,}|[ёЁ]{3,})';

/** A fence line: ``` or ~~~ or ёёё, optionally with a label (```geogebra). */
export const FENCE = new RegExp(`^\\s*${MARK}\\s*([\\p{L}\\p{N}_+#.-]*)\\s*$`, 'u');
/** A fence and then commands on the same line: ``` A = (1, 2) */
const LEADING = new RegExp(`^\\s*${MARK}\\s*(.*\\S)\\s*$`, 'u');
/** Commands and then a fence at the end of the line: Polygon(A, B, C) ``` */
const TRAILING = new RegExp(`^(.*\\S)\\s*${MARK}\\s*$`, 'u');

/** Labels that always mean a drawing. Any other label (```python) is someone else's code. */
const SKETCH_LABELS = new Set(['geogebra', 'ggb', 'чертёж', 'чертеж', 'sketch', 'drawing', 'черт']);

export interface SketchFence {
  /** Line (paragraph) indices of the opening and closing fences. */
  open: number;
  close: number;
  code: string;
  title: string;
}

/** A piece of a line: a fence (which may open, close, or either) or text. */
type Part =
  | { line: number; fence: true; role: 'open' | 'close' | 'any'; label: string }
  | { line: number; fence: false; text: string };

/** A line as fences and text. Besides a fence on its own line, one may start or end a line of commands. */
function partsOf(text: string, line: number): Part[] {
  const whole = FENCE.exec(text);
  if (whole) return [{ line, fence: true, role: 'any', label: whole[2] }];
  const out: Part[] = [];
  let rest = text;
  const lead = LEADING.exec(rest);
  if (lead) {
    let label = '';
    rest = lead[2];
    const tagged = /^([\p{L}\p{N}_+#.-]+)\s+(.*)$/u.exec(rest);
    if (tagged && SKETCH_LABELS.has(tagged[1].toLowerCase())) {
      label = tagged[1];
      rest = tagged[2];
    }
    out.push({ line, fence: true, role: 'open', label });
  }
  const trail = TRAILING.exec(rest);
  if (trail) {
    out.push({ line, fence: false, text: trail[1] }, { line, fence: true, role: 'close', label: '' });
    return out;
  }
  out.push({ line, fence: false, text: rest });
  return out;
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

/**
 * Closed fences around drawings, in order. A fence that closes no drawing
 * (someone else's code block, a stray ``` left from an earlier try) does
 * not spoil the rest: it may still open the next one.
 */
export function findSketchFences(lines: string[]): SketchFence[] {
  const parts = lines.flatMap((text, i) => partsOf(text, i));
  const out: SketchFence[] = [];
  let open: { at: number; line: number; label: string } | null = null;
  parts.forEach((p, at) => {
    if (!p.fence) return;
    if (open && p.role !== 'open' && !p.label) {
      const body = parts.slice(open.at + 1, at).flatMap((q) => (q.fence ? [] : [q.text]));
      const found = sketchOf(open.label, body);
      if (found) {
        out.push({ open: open.line, close: p.line, ...found });
        open = null;
        return;
      }
    }
    open = p.role === 'close' ? null : { at, line: p.line, label: p.label };
  });
  return out;
}
