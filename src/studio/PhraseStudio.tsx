import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHandwriting } from '../engine/handwriting';
import { changeCase, SUGGESTED_PAIRS } from '../model/alphabet';
import { InkPoint, Stroke, uid, X_HEIGHT } from '../model/types';
import { db } from '../storage/db';
import { CELL, drawGuides, drawStroke, prepareCanvas, themeColors } from './inkDraw';
import { LANG_TITLES, pickPhrase, type PhraseLang } from './phrasePicker';
import { autoBounds, boundaryX, cutLetters, type Boundary } from './segment';

const HEIGHT = 300;
const LETTER_COLORS = ['#2f6fd6', '#d65a3a', '#2f9a5b', '#9a4fd0', '#c58a12'];
/** Boundary handles, in canvas pixels from the top: drag the bottom one to move, the top one to tilt. */
const LINE_TOP = 26;
const TILT_HANDLE = 34;
const MOVE_HANDLE = HEIGHT - 12;
/** Neighbouring boundaries stay this far apart (font units) over the whole height. */
const MIN_GAP = 30;

type Drag = { i: number; mode: 'move'; grab: number } | { i: number; mode: 'tilt' };

/**
 * Write a whole word in one go, then mark where each letter ends. Letters keep
 * their natural joins (the cut points become connecting entries/exits) and
 * neighbouring letters can be saved as pairs too.
 */
export function PhraseStudio({ onDone }: { onDone?: (saved: string[]) => void }) {
  const { style, byChar } = useHandwriting();
  const [lang, setLang] = useState<PhraseLang>('ru');
  const recent = useRef<string[]>([]);
  const byCharRef = useRef(byChar);
  byCharRef.current = byChar;
  /** Next word: random word and case, favouring letters with fewer than three variants. */
  const pick = useCallback((l: PhraseLang, justSaved: string[] = []) => {
    const count = (letter: string) => (byCharRef.current.get(letter)?.length ?? 0) + justSaved.filter((k) => k === letter).length;
    const p = pickPhrase(l, count, recent.current);
    recent.current = [...recent.current, p.text].slice(-8);
    return p.text;
  }, []);
  const [phrase, setPhrase] = useState(() => pick('ru'));
  const [stage, setStage] = useState<'write' | 'mark'>('write');
  const [bounds, setBounds] = useState<Boundary[]>([]);
  const [strokeCount, setStrokeCount] = useState(0);
  const [savePairs, setSavePairs] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [width, setWidth] = useState(800);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);
  const startRef = useRef<number | null>(null);
  const pointerTypeRef = useRef('mouse');
  const dragRef = useRef<Drag | null>(null);

  const scale = HEIGHT / (CELL.top - CELL.bottom);
  const toPx = useCallback((x: number, y: number) => [x * scale, (CELL.top - y) * scale] as const, [scale]);
  /** Font-unit height of a canvas row. */
  const yAt = useCallback((py: number) => CELL.top - py / scale, [scale]);
  /** Canvas x of a boundary at a canvas row. */
  const lineX = useCallback((b: Boundary, py: number) => boundaryX(b, yAt(py)) * scale, [scale, yAt]);

  // Letters to cut (spaces separate words but are not letters).
  const letters = useMemo(() => [...phrase].filter((c) => !/\s/u.test(c)), [phrase]);
  // Word number of each letter, to know which neighbours may form a pair.
  const wordOf = useMemo(() => {
    const out: number[] = [];
    let w = 0;
    let inWord = false;
    for (const c of phrase) {
      if (/\s/u.test(c)) {
        if (inWord) w++;
        inWord = false;
      } else {
        out.push(w);
        inWord = true;
      }
    }
    return out;
  }, [phrase]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = prepareCanvas(canvas, width, HEIGHT);
    const colors = themeColors(canvas);
    drawGuides(ctx, width, HEIGHT, toPx, colors);
    const simulate = pointerTypeRef.current !== 'pen';
    if (stage === 'write') {
      ctx.fillStyle = colors.ink;
      const all = currentRef.current ? [...strokesRef.current, currentRef.current] : strokesRef.current;
      for (const s of all) drawStroke(ctx, s, toPx, style.weight * scale, simulate, s !== currentRef.current);
      return;
    }
    // Mark stage: colour the ink between boundaries, draw boundaries and letter labels.
    const edgeX = (k: number, py: number, fallback: number) => (k < 0 || k >= bounds.length ? fallback : lineX(bounds[k], py));
    letters.forEach((_, i) => {
      ctx.fillStyle = LETTER_COLORS[i % LETTER_COLORS.length];
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(edgeX(i - 1, 0, -50), 0);
      ctx.lineTo(edgeX(i, 0, width + 50), 0);
      ctx.lineTo(edgeX(i, HEIGHT, width + 50), HEIGHT);
      ctx.lineTo(edgeX(i - 1, HEIGHT, -50), HEIGHT);
      ctx.closePath();
      ctx.clip();
      for (const s of strokesRef.current) drawStroke(ctx, s, toPx, style.weight * scale, simulate, true);
      ctx.restore();
    });
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    // Labels sit over the middle of each letter, followed up along the slant.
    const ink = strokesRef.current.flat();
    const inkMin = Math.min(...ink.map((p) => p.x)) * scale;
    const inkMax = Math.max(...ink.map((p) => p.x)) * scale;
    const midRow = toPx(0, X_HEIGHT / 2)[1];
    letters.forEach((ch, i) => {
      const left = edgeX(i - 1, midRow, inkMin);
      const right = edgeX(i, midRow, inkMax);
      const near = [bounds[i - 1], bounds[i]].filter(Boolean);
      const lean = near.length ? near.reduce((acc, b) => acc + b.lean, 0) / near.length : 0;
      const x = (left + right) / 2 + lean * (midRow - 18);
      ctx.fillStyle = LETTER_COLORS[i % LETTER_COLORS.length];
      ctx.fillText(ch, x, 18);
    });
    bounds.forEach((b, i) => {
      const active = dragRef.current?.i === i;
      ctx.strokeStyle = colors.guideStrong;
      ctx.setLineDash(active ? [] : [5, 4]);
      ctx.lineWidth = active ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(lineX(b, LINE_TOP), LINE_TOP);
      ctx.lineTo(lineX(b, HEIGHT - 6), HEIGHT - 6);
      ctx.stroke();
      ctx.setLineDash([]);
      // Bottom: move. Top: tilt (a ring, to tell them apart).
      ctx.fillStyle = colors.guideStrong;
      ctx.beginPath();
      ctx.arc(lineX(b, MOVE_HANDLE), MOVE_HANDLE, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.fillStyle = colors.paper;
      ctx.beginPath();
      ctx.arc(lineX(b, TILT_HANDLE), TILT_HANDLE, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    ctx.textAlign = 'start';
  }, [width, toPx, lineX, stage, bounds, letters, style.weight, scale]);

  useEffect(draw, [draw]);
  // Hover cursors belong to the marking stage only.
  useEffect(() => {
    if (canvasRef.current) canvasRef.current.style.cursor = '';
  }, [stage]);

  const point = (e: PointerEvent | React.PointerEvent): InkPoint => {
    const rect = canvasRef.current!.getBoundingClientRect();
    if (startRef.current === null) startRef.current = e.timeStamp;
    return {
      x: (e.clientX - rect.left) / scale,
      y: CELL.top - (e.clientY - rect.top) / scale,
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
      // synthetic or already released pointer
    }
    if (stage === 'mark') {
      dragRef.current = grab(e);
      draw();
      return;
    }
    pointerTypeRef.current = e.pointerType;
    currentRef.current = [point(e)];
    draw();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (stage === 'mark') {
      const drag = dragRef.current;
      if (!drag) {
        // Hover: show what dragging here would do.
        const hit = grab(e);
        canvasRef.current!.style.cursor = !hit ? '' : hit.mode === 'tilt' ? 'grab' : 'ew-resize';
        return;
      }
      const p = point(e);
      const b = bounds[drag.i];
      let next: Boundary;
      if (drag.mode === 'move') {
        const [lo, hi] = room(drag.i, b.lean);
        next = { ...b, x: Math.min(Math.max(p.x - b.lean * p.y - drag.grab, lo), hi) };
      } else {
        // Tilt around the bottom handle.
        const yPivot = yAt(MOVE_HANDLE);
        const xPivot = boundaryX(b, yPivot);
        if (p.y - yPivot < 60) return;
        const lean = Math.min(Math.max((p.x - xPivot) / (p.y - yPivot), -0.8), 1.2);
        next = { x: xPivot - lean * yPivot, lean };
        const [lo, hi] = room(drag.i, lean);
        if (next.x < lo || next.x > hi) return;
      }
      setBounds(bounds.map((old, k) => (k === drag.i ? next : old)));
      return;
    }
    if (!currentRef.current) return;
    const native = e.nativeEvent;
    const events = native.getCoalescedEvents ? native.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [native]) currentRef.current.push(point(ev));
    draw();
  };

  /** Which boundary (and which handle) is under the pointer. */
  const grab = (e: React.PointerEvent): Drag | null => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let best: Drag | null = null;
    let bestD = 12;
    bounds.forEach((b, i) => {
      const tilt = Math.hypot(px - lineX(b, TILT_HANDLE), py - TILT_HANDLE);
      const move = Math.hypot(px - lineX(b, MOVE_HANDLE), py - MOVE_HANDLE);
      const line = py >= LINE_TOP && py <= HEIGHT ? Math.abs(px - lineX(b, py)) + 4 : Infinity;
      if (tilt < bestD) {
        bestD = tilt;
        best = { i, mode: 'tilt' };
      }
      if (Math.min(move, line) < bestD) {
        bestD = Math.min(move, line);
        const y = yAt(py);
        best = { i, mode: 'move', grab: px / scale - b.lean * y - b.x };
      }
    });
    return best;
  };

  /** Range of x for boundary i with the given lean, so it never crosses its neighbours. */
  const room = (i: number, lean: number): [number, number] => {
    let lo = -Infinity;
    let hi = Infinity;
    for (const y of [CELL.bottom, CELL.top]) {
      if (i > 0) lo = Math.max(lo, boundaryX(bounds[i - 1], y) + MIN_GAP - lean * y);
      if (i < bounds.length - 1) hi = Math.min(hi, boundaryX(bounds[i + 1], y) - MIN_GAP - lean * y);
    }
    return [lo, hi];
  };

  const onPointerUp = () => {
    if (stage === 'mark') {
      dragRef.current = null;
      draw();
      return;
    }
    if (!currentRef.current) return;
    strokesRef.current = [...strokesRef.current, currentRef.current];
    currentRef.current = null;
    setStrokeCount(strokesRef.current.length);
    draw();
  };

  const clear = () => {
    strokesRef.current = [];
    currentRef.current = null;
    startRef.current = null;
    setStrokeCount(0);
    setBounds([]);
    setStage('write');
    draw();
  };

  const toMark = () => {
    setBounds(autoBounds(strokesRef.current, letters.length));
    setStage('mark');
    setMessage(null);
  };

  const save = async () => {
    const now = Date.now();
    const pointerType = pointerTypeRef.current;
    const cuts = cutLetters(strokesRef.current, bounds, letters);
    const rows = cuts
      .map((c, i) => ({ id: uid(), char: letters[i], strokes: c.strokes, entry: c.entry, exit: c.exit, pointerType, createdAt: now + i }))
      .filter((r) => r.strokes.length > 0);
    if (savePairs) {
      for (let i = 0; i + 1 < letters.length; i++) {
        const pair = letters[i] + letters[i + 1];
        if (wordOf[i] !== wordOf[i + 1] || !(SUGGESTED_PAIRS.includes(pair) || byChar.has(pair))) continue;
        // The pair is the same ink without the boundary between its two letters.
        const merged = cutLetters(
          strokesRef.current,
          bounds.filter((_, k) => k !== i),
          [...letters.slice(0, i), pair, ...letters.slice(i + 2)],
        )[i];
        if (merged.strokes.length > 0) {
          rows.push({ id: uid(), char: pair, strokes: merged.strokes, entry: merged.entry, exit: merged.exit, pointerType, createdAt: now + 100 + i });
        }
      }
    }
    await db.samples.bulkAdd(rows);
    const savedKeys = rows.map((r) => r.char);
    setMessage(`Сохранено: ${savedKeys.join(' ')}`);
    onDone?.(savedKeys);
    clear();
    nextWord(savedKeys);
  };

  const nextWord = (justSaved: string[] = []) => {
    setPhrase(pick(lang, justSaved));
    clear();
  };

  const chooseLang = (l: PhraseLang) => {
    setLang(l);
    setPhrase(pick(l));
    clear();
  };

  const recase = (mode: 'capital' | 'upper' | 'lower') => {
    setPhrase(changeCase(phrase, mode));
    clear();
  };

  return (
    <div className="phrase-studio">
      <div className="phrase-sets" role="tablist" aria-label="Язык">
        {(Object.keys(LANG_TITLES) as PhraseLang[]).map((l) => (
          <button key={l} role="tab" aria-selected={l === lang} className={l === lang ? 'active' : ''} onClick={() => chooseLang(l)}>
            {LANG_TITLES[l]}
          </button>
        ))}
        <span className="muted small">
          {lang === 'math'
            ? 'Формулы пишутся как есть, каждый знак — отдельной «буквой». Индексы потом получатся из обычных цифр.'
            : 'Слово и регистр выбираются случайно, чаще — с буквами, у которых ещё меньше 3 вариантов.'}
        </span>
      </div>
      <div className="phrase-head">
        <label>
          Слово или фраза:{' '}
          <input
            value={phrase}
            onChange={(e) => {
              setPhrase(e.target.value);
              clear();
            }}
          />
        </label>
        {lang !== 'math' && (
          <div className="case-buttons" role="group" aria-label="Регистр">
            <button className="btn small" onClick={() => recase('capital')} title="С заглавной буквы">
              Аа
            </button>
            <button className="btn small" onClick={() => recase('upper')} title="Только заглавными">
              АА
            </button>
            <button className="btn small" onClick={() => recase('lower')} title="Только строчными">
              аа
            </button>
          </div>
        )}
        <button className="btn small" onClick={() => nextWord()}>
          {lang === 'math' ? 'Другая формула' : 'Другое слово'}
        </button>
        <span className="muted small">
          {stage === 'write'
            ? 'Напишите слово целиком, как обычно — слитно. Прописную в начале тоже можно: так запишется её соединение.'
            : 'Двигайте границы за нижний кружок, наклоняйте за верхний — так, чтобы каждая буква была своего цвета. Место разреза станет точкой соединения.'}
        </span>
      </div>
      <div className="phrase-canvas" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className={`capture-canvas ${stage === 'mark' ? 'marking' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label="Лист для слова"
        />
      </div>
      <div className="capture-actions">
        {stage === 'write' ? (
          <>
            <button className="btn primary" onClick={toMark} disabled={strokeCount === 0 || letters.length === 0}>
              Разметить буквы →
            </button>
            <button
              className="btn"
              onClick={() => {
                strokesRef.current = strokesRef.current.slice(0, -1);
                setStrokeCount(strokesRef.current.length);
                draw();
              }}
              disabled={strokeCount === 0}
            >
              Отменить штрих
            </button>
            <button className="btn ghost" onClick={clear} disabled={strokeCount === 0}>
              Очистить
            </button>
          </>
        ) : (
          <>
            <button className="btn primary" onClick={() => void save()}>
              Сохранить {letters.length} {letters.length === 1 ? 'букву' : letters.length < 5 ? 'буквы' : 'букв'}
            </button>
            <label className="check inline">
              <input type="checkbox" checked={savePairs} onChange={(e) => setSavePairs(e.target.checked)} />и пары букв
            </label>
            <button className="btn" onClick={() => setStage('write')}>
              ← Назад к письму
            </button>
            <button className="btn ghost" onClick={clear}>
              Заново
            </button>
          </>
        )}
        {message && <span className="muted small">{message}</span>}
      </div>
    </div>
  );
}
