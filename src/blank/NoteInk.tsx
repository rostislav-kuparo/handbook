import { useEffect, useState } from 'react';
import type { ParagraphRender } from '../engine/client';
import { FALLBACK_FONTS } from '../engine/constants';
import { useHandwriting } from '../engine/handwriting';
import { INK_VIEWBOX_TOP, LINE_HEIGHT_EM, LINE_HEIGHT_UNITS } from '../editor/layout';
import { noteFontSize, writeNote } from './note';
import { isRomanChar, romanPath, romanPen } from './roman';

/** A note written by hand in the rendered view: its lines one under another, `width` px wide. */
export function NoteInk({ text, size, width, seed, flip = [] }: { text: string; size: number; width: number; seed: number; flip?: number[] }) {
  const fs = noteFontSize(size);
  const lh = fs * LINE_HEIGHT_EM;
  const { fontVersion, style } = useHandwriting();
  const flipKey = flip.join(',');
  const [renders, setRenders] = useState<(ParagraphRender | null)[]>([]);
  useEffect(() => {
    let alive = true;
    void writeNote(text, width, fs, seed, false, flip)
      .then((r) => alive && setRenders(r))
      .catch((err) => console.error(err));
    return () => {
      alive = false;
    };
  }, [text, width, fs, seed, fontVersion, flipKey]);

  const lines: { r: ParagraphRender; line: number; top: number }[] = [];
  let k = 0;
  for (const r of renders) {
    if (!r) {
      k++;
      continue;
    }
    for (let line = 0; line < r.lines; line++, k++) lines.push({ r, line, top: k * lh });
  }
  return (
    <div className="note-ink" style={{ position: 'relative', height: Math.max(k, 1) * lh }}>
      {lines.map(({ r, line, top }) => (
        <svg
          key={top}
          className="ink-line"
          style={{ top, height: lh }}
          viewBox={`0 ${INK_VIEWBOX_TOP + line * LINE_HEIGHT_UNITS} ${r.width} ${LINE_HEIGHT_UNITS}`}
          preserveAspectRatio="xMinYMin meet"
        >
          {(r.lineD[line] ?? []).map((part) => (
            <path key={part.color} d={part.d} className="ink-default" />
          ))}
          {r.fallback
            .filter((f) => f.line === line)
            .map((f, j) =>
              isRomanChar(f.ch) ? (
                <path
                  key={j}
                  d={romanPath(f.ch, f.x, f.y, f.scale, seed + j)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={romanPen(style.weight) * f.scale}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : (
              <text key={j} x={f.x} y={f.y} fontFamily={FALLBACK_FONTS} fontSize={1000 * f.scale} className="ink-default" opacity={0.7}>
                {f.ch}
              </text>
              ),
            )}
        </svg>
      ))}
    </div>
  );
}
