import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { isPair } from '../model/alphabet';
import { InkPoint, Stroke } from '../model/types';
import { CELL, drawGuides, drawStroke, prepareCanvas, themeColors } from './inkDraw';

export interface CaptureHandle {
  save: () => void;
  undo: () => void;
  clear: () => void;
  isEmpty: () => boolean;
}

interface Props {
  /** A character, or a letter pair (gets a wider sheet). */
  char: string;
  /** Pen width in font units, so the live ink matches the final glyph. */
  penWidth: number;
  height?: number;
  onSave: (strokes: Stroke[], pointerType: string) => void;
  /** Bind Enter / Esc / Ctrl+Z on the window. */
  hotkeys?: boolean;
  handle?: Ref<CaptureHandle>;
}

export function CaptureCanvas({ char, penWidth, height = 420, onSave, hotkeys = true, handle }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);
  const startRef = useRef<number | null>(null);
  const pointerTypeRef = useRef('mouse');
  const [width, setWidth] = useState(600);
  const [strokeCount, setStrokeCount] = useState(0);

  const scale = height / (CELL.top - CELL.bottom);
  const cellWidthPx = Math.min(width, (isPair(char) ? 2300 : 1500) * scale);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toPx = useCallback((x: number, y: number) => [x * scale, (CELL.top - y) * scale] as const, [scale]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = cellWidthPx;
    const ctx = prepareCanvas(canvas, w, height);
    const colors = themeColors(canvas);

    // Faint reference letter, top-left corner.
    ctx.fillStyle = colors.guide;
    ctx.globalAlpha = 0.35;
    ctx.font = `${Math.round(height * 0.16)}px Georgia, serif`;
    ctx.fillText(char, 10, height * 0.17);
    ctx.globalAlpha = 1;
    drawGuides(ctx, w, height, toPx, colors);

    ctx.fillStyle = colors.ink;
    const all = currentRef.current ? [...strokesRef.current, currentRef.current] : strokesRef.current;
    const simulate = pointerTypeRef.current !== 'pen';
    for (const s of all) drawStroke(ctx, s, toPx, penWidth * scale, simulate, s !== currentRef.current);
  }, [cellWidthPx, height, char, penWidth, scale, toPx]);

  useEffect(draw, [draw]);

  const point = (e: PointerEvent | React.PointerEvent): InkPoint => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (startRef.current === null) startRef.current = e.timeStamp;
    return {
      x: px / scale,
      y: CELL.top - py / scale,
      t: Math.round(e.timeStamp - startRef.current),
      p: e.pointerType === 'pen' ? e.pressure : 0.5,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      // pointer already gone (or synthetic) — drawing still works without capture
    }
    pointerTypeRef.current = e.pointerType;
    currentRef.current = [point(e)];
    draw();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!currentRef.current) return;
    const native = e.nativeEvent;
    const events = native.getCoalescedEvents ? native.getCoalescedEvents() : [native];
    for (const ev of events.length ? events : [native]) currentRef.current.push(point(ev));
    draw();
  };

  const endStroke = () => {
    if (!currentRef.current) return;
    strokesRef.current = [...strokesRef.current, currentRef.current];
    currentRef.current = null;
    setStrokeCount(strokesRef.current.length);
    draw();
  };

  const clear = useCallback(() => {
    strokesRef.current = [];
    currentRef.current = null;
    startRef.current = null;
    setStrokeCount(0);
    draw();
  }, [draw]);

  const undo = useCallback(() => {
    strokesRef.current = strokesRef.current.slice(0, -1);
    if (strokesRef.current.length === 0) startRef.current = null;
    setStrokeCount(strokesRef.current.length);
    draw();
  }, [draw]);

  const save = useCallback(() => {
    if (strokesRef.current.length === 0) return;
    onSave(strokesRef.current, pointerTypeRef.current);
    clear();
  }, [onSave, clear]);

  useImperativeHandle(handle, () => ({ save, undo, clear, isEmpty: () => strokesRef.current.length === 0 }), [
    save,
    undo,
    clear,
  ]);

  // Switching letters starts a fresh sheet (but resizing must not wipe the ink).
  const shownChar = useRef(char);
  useEffect(() => {
    if (shownChar.current !== char) {
      shownChar.current = char;
      clear();
    }
  }, [char, clear]);

  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        clear();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys, save, clear, undo]);

  return (
    <div className="capture" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="capture-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        aria-label={`Холст для буквы ${char}`}
      />
      <div className="capture-actions">
        <button className="btn primary" onClick={save} disabled={strokeCount === 0}>
          Сохранить вариант {hotkeys && <kbd>Enter</kbd>}
        </button>
        <button className="btn" onClick={undo} disabled={strokeCount === 0}>
          Отменить штрих {hotkeys && <kbd>Ctrl+Z</kbd>}
        </button>
        <button className="btn ghost" onClick={clear} disabled={strokeCount === 0}>
          Очистить {hotkeys && <kbd>Esc</kbd>}
        </button>
      </div>
    </div>
  );
}
