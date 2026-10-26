import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_DRAW_PEN, drawPenOf, type DrawPen } from '../editor/page';
import { useHandwriting } from '../engine/handwriting';
import { drawingSvg, drawSketch, linesOnly, penFor, sketchLayout, type Drawing } from './render';

/** The document's drawing pen (a drawing's own choice goes over it). */
export const DrawPenContext = createContext<DrawPen>(DEFAULT_DRAW_PEN);

interface Props {
  code: string;
  /** The drawing's own pen (block attribute); unset parts come from the document. */
  pen?: unknown;
  /** Letter size, px; taken from the surrounding text when omitted. */
  fontSize?: number;
  /** Width, px; measured when omitted. */
  width?: number;
  /** Shown instead of an empty drawing. */
  placeholder?: string;
}

/**
 * A «Чертёж» drawn in the user's hand: lines appear at once, labels as soon
 * as the engine has written them. The height is known up front, so nothing
 * around it jumps.
 */
export function SketchFigure({ code, pen, fontSize, width, placeholder }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{ w: number; fs: number } | null>(null);
  const { style, fontVersion } = useHandwriting();
  const docPen = useContext(DrawPenContext);
  const draw = drawPenOf(docPen, pen);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || (width && fontSize)) return;
    const measure = () => {
      const w = Math.round(el.clientWidth);
      const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
      setMeasured((m) => (m && m.w === w && m.fs === fs ? m : { w, fs }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, fontSize]);

  const w = width ?? measured?.w ?? 0;
  const fs = fontSize ?? measured?.fs ?? 16;
  const layout = useMemo(
    () => (w > 40 ? sketchLayout(code, w, fs, penFor(style, fs, draw)) : null),
    // The pen's parts, not the object (it is rebuilt on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [code, w, fs, style, draw.tool, draw.weight, draw.wobble, draw.pressure, draw.overshoot],
  );

  const [drawing, setDrawing] = useState<Drawing | null>(null);
  useEffect(() => {
    if (!layout) return;
    let alive = true;
    void drawSketch(layout).then((d) => {
      if (alive) setDrawing(d);
    });
    return () => {
      alive = false;
    };
  }, [layout, fontVersion]);

  // The previous drawing stays until the new labels are written (no flicker while typing).
  const html = useMemo(() => {
    if (!layout) return '';
    const same = drawing && drawing.width === layout.width && drawing.height === layout.height;
    return drawingSvg(same ? drawing : linesOnly(layout), undefined, draw);
    // The pen's parts, not the object (it is rebuilt on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, layout, draw.tool, draw.color, draw.labelsInPen]);

  return (
    <div ref={ref} className="sketch-figure" style={{ height: layout?.empty && placeholder ? 110 : layout?.height ?? 110 }}>
      {layout?.empty && placeholder ? <p className="sketch-empty">{placeholder}</p> : <div dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  );
}
