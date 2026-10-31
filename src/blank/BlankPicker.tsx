// The pipette over a blank: a click on a printed point writes it into the
// drawing's commands. It sticks to printed points, crossings and line ends
// (Alt: exactly where clicked) and shows them magnified next to the cursor.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MM, type SheetSize } from '../editor/page';
import type { BlankOnSheet } from '../editor/Paper';
import { anchorIn, fromProjections, inDrawing, mmText, nextName, validName, withOrigin, withPoint, type SheetMm } from './pickCode';
import { snapper, type Snap, type SnapPoint } from './snap';

/** A point of the blank; the origin of the drawing; a point in space by its two projections. */
export type PickMode = 'point' | 'origin' | 'space';

interface Props {
  on: BlankOnSheet;
  sheet: SheetSize;
  mode: PickMode;
  code: string;
  /** The commands with what was picked. */
  onCode: (code: string) => void;
  onClose: () => void;
}

const KIND_NAME: Record<SnapPoint['kind'], string> = {
  circle: 'точка (кружок)',
  dot: 'точка',
  cross: 'пересечение линий',
  end: 'конец линии',
  free: 'где щёлкнули',
};

const LOUPE = 150;
const ZOOM = 5;

export function BlankPicker({ on, sheet, mode, code, onCode, onClose }: Props) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [snap, setSnap] = useState<Snap | null>(null);
  const [hover, setHover] = useState<{ sx: number; sy: number; at: SnapPoint } | null>(null);
  /** The frontal projection, picked first (a point in space). */
  const [frontal, setFrontal] = useState<SnapPoint | null>(null);
  /** A picked point waiting for its name. */
  const [naming, setNaming] = useState<{ at: SnapPoint; coords: number[]; suggest: string; note?: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const loupe = useRef<HTMLCanvasElement>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const frame = useRef(0);
  const anchored = !!anchorIn(code);
  // Without an origin on the blank the first click places it.
  const stage: 'origin' | 'frontal' | 'horizontal' | 'point' = mode === 'origin' || !anchored ? 'origin' : mode === 'space' ? (frontal ? 'horizontal' : 'frontal') : 'point';

  // Over the blank's sheet: the first sheet of the editor's stack.
  useLayoutEffect(() => setHost(document.querySelector<HTMLElement>('.paper-stack .sheet[data-page="1"]')), []);
  useEffect(() => {
    let alive = true;
    void snapper(on.blank).then((s) => alive && setSnap(() => s));
    const i = new Image();
    i.src = on.url;
    img.current = i;
    return () => {
      alive = false;
    };
  }, [on.blank, on.url]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (naming) setNaming(null);
      else if (frontal) setFrontal(null);
      else onClose();
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [naming, frontal, onClose]);

  const sheetAt = (e: React.MouseEvent) => {
    const r = overlay.current!.getBoundingClientRect();
    const k = r.width / sheet.w;
    return { sx: (e.clientX - r.left) / k, sy: (e.clientY - r.top) / k };
  };
  const pointAt = (sx: number, sy: number, exact: boolean): SnapPoint => (snap && !exact ? snap(sx, sy, sheet) : { x: sx, y: sy, kind: 'free' });

  const move = (e: React.MouseEvent) => {
    if (naming) return;
    const { sx, sy } = sheetAt(e);
    const exact = e.altKey;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setHover({ sx, sy, at: pointAt(sx, sy, exact) }));
  };

  // The magnified blank round the cursor, the found point ringed.
  useEffect(() => {
    const c = loupe.current;
    const i = img.current;
    if (!c || !i || !hover || !i.complete || !i.naturalWidth) return;
    const ctx = c.getContext('2d')!;
    const kx = i.naturalWidth / on.rect.w;
    const ky = i.naturalHeight / on.rect.h;
    const half = LOUPE / ZOOM / 2;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, LOUPE, LOUPE);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(i, (hover.sx - half - on.rect.x) * kx, (hover.sy - half - on.rect.y) * ky, 2 * half * kx, 2 * half * ky, 0, 0, LOUPE, LOUPE);
    ctx.strokeStyle = 'rgba(47,111,214,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LOUPE / 2, 0);
    ctx.lineTo(LOUPE / 2, LOUPE);
    ctx.moveTo(0, LOUPE / 2);
    ctx.lineTo(LOUPE, LOUPE / 2);
    ctx.stroke();
    const px = LOUPE / 2 + (hover.at.x - hover.sx) * ZOOM;
    const py = LOUPE / 2 + (hover.at.y - hover.sy) * ZOOM;
    ctx.strokeStyle = '#d9533f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, 7, 0, 2 * Math.PI);
    ctx.stroke();
  }, [hover, on]);

  const mm = (p: SnapPoint): SheetMm => ({ x: p.x / MM, y: p.y / MM });

  const click = (e: React.MouseEvent) => {
    // Not a click on the paper for the editor (it would take the cursor away).
    e.preventDefault();
    e.stopPropagation();
    if (naming) return;
    const { sx, sy } = sheetAt(e);
    const at = pointAt(sx, sy, e.altKey);
    if (stage === 'origin') {
      onCode(withOrigin(code, mm(at)));
      setNote(`Начало координат — ${KIND_NAME[at.kind]}, ${mmText(at.x / MM)}; ${mmText(at.y / MM)} мм от угла листа.`);
      if (mode === 'origin') onClose();
      return;
    }
    if (stage === 'frontal') {
      setFrontal(at);
      return;
    }
    if (stage === 'horizontal' && frontal) {
      const p = fromProjections(code, mm(frontal), mm(at));
      if (!p) return;
      setFrontal(null);
      setNaming({
        at,
        coords: [p.x, p.y, p.z],
        suggest: nextName(code),
        note: p.gap > 1 ? `Проекции не на одной линии связи (разошлись на ${mmText(p.gap)} мм): x взят посередине.` : undefined,
      });
      return;
    }
    const p = inDrawing(code, mm(at));
    if (p) setNaming({ at, coords: [p.x, p.y], suggest: nextName(code, '_1') });
  };

  const name = (raw: string) => {
    if (!naming) return;
    const n = raw.trim() || naming.suggest;
    if (!validName(n)) {
      setNote(`«${n}» не годится в имя: буква, потом буквы, цифры или _ (A_1, B, K_2).`);
      return;
    }
    onCode(withPoint(code, n, naming.coords));
    setNote(naming.note ?? `Точка ${n} записана в команды (и не рисуется второй раз: она напечатана).`);
    setNaming(null);
  };

  const hint = {
    origin: 'Щёлкните начало координат чертежа: обычно 0 на оси x₁₂ (пересечение осей).',
    frontal: 'Точка в пространстве: сначала фронтальная проекция (A₂).',
    horizontal: 'Теперь горизонтальная проекция той же точки (A₁).',
    point: 'Щёлкните напечатанную точку.',
  }[stage];

  if (!host) return null;
  const loupeAt = hover && { left: Math.min(hover.sx + 24, sheet.w - LOUPE - 4), top: Math.max(4, hover.sy - LOUPE - 24) };
  return createPortal(
    <div ref={overlay} className="blank-picker no-print" onMouseMove={move} onMouseDown={click} onMouseLeave={() => setHover(null)} contentEditable={false}>
      <div className="blank-picker-bar" onMouseDown={(e) => e.stopPropagation()}>
        <span>{hint}</span>
        <span className="muted">Прилипает к точкам, пересечениям и концам линий · Alt — точно где щёлкнули · Esc — выйти</span>
        {note && <span className="blank-picker-note">{note}</span>}
        <button className="btn small" onClick={onClose}>
          Готово
        </button>
      </div>
      {frontal && <span className="blank-picker-mark first" style={{ left: frontal.x, top: frontal.y }} />}
      {hover && !naming && <span className={`blank-picker-mark ${hover.at.kind}`} style={{ left: hover.at.x, top: hover.at.y }} title={KIND_NAME[hover.at.kind]} />}
      {hover && !naming && loupeAt && <canvas ref={loupe} className="blank-picker-loupe" width={LOUPE} height={LOUPE} style={loupeAt} />}
      {naming && (
        <div className="blank-picker-name" style={{ left: naming.at.x + 10, top: naming.at.y + 10 }} onMouseDown={(e) => e.stopPropagation()}>
          <span className="blank-picker-mark" style={{ left: -10, top: -10 }} />
          <label>
            Имя
            <input
              ref={nameInput}
              autoFocus
              placeholder={naming.suggest}
              onKeyDown={(e) => {
                if (e.key === 'Enter') name(e.currentTarget.value);
              }}
            />
          </label>
          <button className="btn small primary" onClick={() => name(nameInput.current?.value ?? '')}>
            OK
          </button>
        </div>
      )}
    </div>,
    host,
  );
}
