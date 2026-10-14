import { useEffect, useState } from 'react';
import { engine, SampleOutline } from '../engine/client';
import { looksTooTall } from '../model/alphabet';
import { anchorOnEdge } from '../model/anchors';
import { Anchor, Sample, X_HEIGHT } from '../model/types';

const outlineCache = new Map<string, SampleOutline>();

/** Outline of one recorded sample, computed by the Rust engine (same pen as the font). */
function useOutline(sample: Sample, weightKey: string) {
  const key = `${sample.id}|${weightKey}`;
  const [outline, setOutline] = useState<SampleOutline | null>(outlineCache.get(key) ?? null);
  useEffect(() => {
    const cached = outlineCache.get(key);
    if (cached) {
      setOutline(cached);
      return;
    }
    let alive = true;
    engine.sampleOutline(sample).then((o) => {
      outlineCache.set(key, o);
      if (alive) setOutline(o);
    });
    return () => {
      alive = false;
    };
  }, [key, sample]);
  return outline;
}

interface Props {
  sample: Sample;
  weightKey: string;
  onDelete: () => void;
  onToggleAnchor: (side: 'entry' | 'exit', anchor: Anchor) => void;
}

export function SampleThumb({ sample, weightKey, onDelete, onToggleAnchor }: Props) {
  const outline = useOutline(sample, weightKey);
  const xMin = (outline?.xMin ?? 0) - 60;
  const xMax = (outline?.xMax ?? 600) + 60;
  const vb = `${xMin} -1000 ${Math.max(xMax - xMin, 400)} 1450`;

  const anchor = (side: 'entry' | 'exit', a: Anchor | null) => {
    if (!a) return null;
    const usable = anchorOnEdge(side, a, sample.strokes);
    const state = !a.connect ? 'off' : usable ? 'on' : 'bad';
    return (
      <g
        className={`anchor ${side} ${state}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleAnchor(side, { ...a, connect: !a.connect });
        }}
      >
        <title>
          {side === 'entry' ? 'Вход' : 'Выход'}:{' '}
          {state === 'on'
            ? 'соединяется с соседней буквой'
            : state === 'bad'
              ? `точка не на ${side === 'entry' ? 'левом' : 'правом'} краю буквы — соединения не будет. Перепишите букву так, чтобы ${side === 'entry' ? 'первый штрих начинался слева' : 'последний штрих заканчивался справа'}`
              : 'без соединения'}{' '}
          (клик — переключить)
        </title>
        <circle cx={a.x} cy={-a.y} r={80} />
      </g>
    );
  };

  // Where this variant goes in a word (only letters join).
  const joinsIn = !!sample.entry?.connect && anchorOnEdge('entry', sample.entry, sample.strokes);
  const joinsOut = !!sample.exit?.connect && anchorOnEdge('exit', sample.exit, sample.strokes);
  const place = !/^\p{L}/u.test(sample.char) ? null : !joinsIn ? 'начало слова' : joinsOut ? 'середина' : null;
  const tooTall = looksTooTall(sample.char, Math.max(...sample.strokes.flat().map((p) => p.y)), X_HEIGHT);

  return (
    <figure
      className={`sample-thumb ${tooTall ? 'warn' : ''}`}
      title={tooTall ? 'Этот вариант заметно выше линии строчных — похоже на прописную. Движок выучит и такой размер.' : undefined}
    >
      <svg viewBox={vb} preserveAspectRatio="xMidYMid meet">
        <line className="guide" x1={xMin} x2={xMax} y1={0} y2={0} />
        <line className="guide dashed" x1={xMin} x2={xMax} y1={-X_HEIGHT} y2={-X_HEIGHT} />
        {outline && <path d={outline.d} className="ink-fill" />}
        {anchor('entry', sample.entry)}
        {anchor('exit', sample.exit)}
      </svg>
      {tooTall && <span className="thumb-warn">выше строчных</span>}
      {place && <span className="thumb-place">{place}</span>}
      <button className="thumb-delete" onClick={onDelete} title="Удалить вариант" aria-label="Удалить вариант">
        ×
      </button>
    </figure>
  );
}
