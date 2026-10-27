import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { engine, SampleOutline } from '../engine/client';
import { looksTooTall } from '../model/alphabet';
import { anchorOnEdge, nearestEnd, strokeEnds } from '../model/anchors';
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
  /** A new entry or exit: toggled (click) or moved to another stroke end (drag). */
  onAnchor: (side: 'entry' | 'exit', anchor: Anchor) => void;
}

/** A press that moved less than this (screen px) is a click. */
const CLICK_SLOP = 4;

export function SampleThumb({ sample, weightKey, onDelete, onAnchor }: Props) {
  const outline = useOutline(sample, weightKey);
  const svgRef = useRef<SVGSVGElement>(null);
  /** The anchor being dragged: where the pointer is, in sample units (y up). */
  const [drag, setDrag] = useState<{ side: 'entry' | 'exit'; x: number; y: number; moved: boolean } | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const xMin = (outline?.xMin ?? 0) - 60;
  const xMax = (outline?.xMax ?? 600) + 60;
  const vb = `${xMin} -1000 ${Math.max(xMax - xMin, 400)} 1450`;

  /** Pointer position in sample units (the drawing is y-up, the SVG y-down). */
  const toSample = (e: ReactPointerEvent) => {
    const m = svgRef.current?.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: -p.y };
  };
  const target = drag ? nearestEnd(sample.strokes, drag.x, drag.y) : null;

  const anchor = (side: 'entry' | 'exit', a: Anchor | null) => {
    if (!a) return null;
    const usable = anchorOnEdge(side, a, sample.strokes);
    const state = !a.connect ? 'off' : usable ? 'on' : 'bad';
    const shown = drag?.side === side && drag.moved ? { x: drag.x, y: drag.y } : a;
    return (
      <g
        className={`anchor ${side} ${state} ${drag?.side === side ? 'dragging' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          press.current = { x: e.clientX, y: e.clientY };
          setDrag({ side, x: a.x, y: a.y, moved: false });
        }}
        onPointerMove={(e) => {
          if (!press.current || drag?.side !== side) return;
          const moved = drag.moved || Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > CLICK_SLOP;
          const p = toSample(e);
          if (p && moved) setDrag({ side, x: p.x, y: p.y, moved });
        }}
        onPointerUp={() => {
          if (drag?.side !== side) return;
          press.current = null;
          setDrag(null);
          if (!drag.moved) {
            onAnchor(side, { ...a, connect: !a.connect });
            return;
          }
          const end = nearestEnd(sample.strokes, drag.x, drag.y);
          if (end) onAnchor(side, { x: end.x, y: end.y, connect: true });
        }}
        onPointerCancel={() => {
          press.current = null;
          setDrag(null);
        }}
      >
        <title>
          {side === 'entry' ? 'Вход' : 'Выход'}:{' '}
          {state === 'on'
            ? 'соединяется с соседней буквой'
            : state === 'bad'
              ? `точка не на ${side === 'entry' ? 'левом' : 'правом'} краю буквы — соединения не будет. Перепишите букву так, чтобы ${side === 'entry' ? 'первый штрих начинался слева' : 'последний штрих заканчивался справа'}`
              : 'без соединения'}{' '}
          (клик — переключить, перетащить — поставить на другой конец штриха)
        </title>
        <circle cx={shown.x} cy={-shown.y} r={80} />
      </g>
    );
  };

  // Where this variant goes in a word (only letters join).
  const joinsIn = !!sample.entry?.connect && anchorOnEdge('entry', sample.entry, sample.strokes);
  const joinsOut = !!sample.exit?.connect && anchorOnEdge('exit', sample.exit, sample.strokes);
  const place = !/^\p{L}/u.test(sample.char) ? null : joinsIn ? (joinsOut ? 'середина' : 'конец слова') : joinsOut ? 'начало слова' : 'отдельно';
  const tooTall = looksTooTall(sample.char, Math.max(...sample.strokes.flat().map((p) => p.y)), X_HEIGHT);

  return (
    <figure
      className={`sample-thumb ${tooTall ? 'warn' : ''}`}
      title={tooTall ? 'Этот вариант заметно выше линии строчных — похоже на прописную. Движок выучит и такой размер.' : undefined}
    >
      <svg ref={svgRef} viewBox={vb} preserveAspectRatio="xMidYMid meet">
        <line className="guide" x1={xMin} x2={xMax} y1={0} y2={0} />
        <line className="guide dashed" x1={xMin} x2={xMax} y1={-X_HEIGHT} y2={-X_HEIGHT} />
        {outline && <path d={outline.d} className="ink-fill" />}
        {drag?.moved &&
          strokeEnds(sample.strokes).map((e) => (
            <circle
              key={`${e.stroke}${e.atStart ? 's' : 'e'}`}
              className={`anchor-spot ${target && target.stroke === e.stroke && target.atStart === e.atStart ? 'target' : ''}`}
              cx={e.x}
              cy={-e.y}
              r={target && target.stroke === e.stroke && target.atStart === e.atStart ? 70 : 45}
            />
          ))}
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
