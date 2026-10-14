import { useEffect, useState } from 'react';
import { engine, PreviewGlyph } from '../engine/client';
import { useHandwriting } from '../engine/handwriting';

/** A row of freshly synthesized instances of one letter — what the engine invents. */
export function SynthPreview({ char, count = 9 }: { char: string; count?: number }) {
  const { fontVersion } = useHandwriting();
  const [seed, setSeed] = useState(1);
  const [glyphs, setGlyphs] = useState<PreviewGlyph[]>([]);

  useEffect(() => {
    let alive = true;
    // fontVersion: the engine has the latest samples/style once a build finished.
    engine.preview(char, count, seed).then((g) => alive && setGlyphs(g));
    return () => {
      alive = false;
    };
  }, [char, count, seed, fontVersion]);

  if (glyphs.length === 0) return <p className="muted">Напишите хотя бы один вариант — и движок начнёт варьировать букву.</p>;

  let x = 0;
  const placed = glyphs.map((g) => {
    const at = x;
    x += g.advance + 80;
    return { g, at };
  });
  return (
    <div className="synth-preview">
      <svg viewBox={`-40 -1000 ${x + 40} 1450`} preserveAspectRatio="xMinYMid meet">
        <line className="guide" x1={-40} x2={x} y1={0} y2={0} />
        {placed.map(({ g, at }, i) => (
          <g key={i} transform={`translate(${at} 0)`}>
            <path d={g.d} className="ink-fill" />
            {g.entry && <circle className="join-dot" cx={g.entry[0]} cy={g.entry[1]} r={14} />}
            {g.exit && <circle className="join-dot" cx={g.exit[0]} cy={g.exit[1]} r={14} />}
          </g>
        ))}
      </svg>
      <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
        Ещё варианты
      </button>
    </div>
  );
}
