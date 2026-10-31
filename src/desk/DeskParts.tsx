// The pieces the «На столе» dialog is built of: floating over the photo, in
// the look of the rest of the app (cards, pills, icon buttons, hints behind «?»).
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from '../ui/icons';
import type { Photo } from './photo';

/**
 * A «?» that shows its text on hover or focus; `side`: where the text opens.
 * The text floats over everything (a scrolling card must not cut it off).
 */
export function Hint({ children, side = 'left', mark = '?' }: { children: ReactNode; side?: 'left' | 'right' | 'below'; mark?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<DOMRect | null>(null);
  const show = () => ref.current && setAt(ref.current.getBoundingClientRect());
  const hide = () => setAt(null);
  const top = (y: number) => Math.max(8, Math.min(y, window.innerHeight - 240));
  const place: CSSProperties | null = !at
    ? null
    : side === 'left'
      ? { top: top(at.top - 8), right: window.innerWidth - at.left + 8 }
      : side === 'right'
        ? { top: top(at.top - 8), left: at.right + 8 }
        : { top: at.bottom + 8, left: Math.max(150, Math.min(at.left + at.width / 2, window.innerWidth - 150)), transform: 'translateX(-50%)' };
  return (
    <span className="desk-hint-q">
      <button type="button" ref={ref} className="desk-q" aria-label="Подсказка" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
        {mark}
      </button>
      {place &&
        createPortal(
          <span className="desk-pop" role="tooltip" style={place}>
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** A part of the settings card: its title, a «?» with what it is about, its controls. */
export function Section({ title, hint, children, aside }: { title: string; hint?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="desk-section">
      <h3>
        {title}
        {hint && <Hint>{hint}</Hint>}
        {aside && <span className="desk-section-aside">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

/** A segmented switch of the app (`.pill`). */
export function Pill<T extends string | number | null>({ value, options, onChange, wrap }: { value: T; options: [T, ReactNode, string?][]; onChange: (v: T) => void; wrap?: boolean }) {
  return (
    <div className={`pill small desk-pill ${wrap ? 'wrap' : ''}`}>
      {options.map(([v, label, title]) => (
        <button key={String(v)} type="button" className={v === value ? 'on' : ''} title={title} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export interface Message {
  key: string;
  text: ReactNode;
  /** «info» fades by itself, the others stay until closed (or until the cause is gone). */
  kind: 'info' | 'warn' | 'error';
  action?: { label: string; run: () => void };
}

/** What the program says, in a short line over the photo. */
export function Toasts({ messages, onClose }: { messages: Message[]; onClose: (key: string) => void }) {
  return (
    <div className="desk-toasts" aria-live="polite">
      {messages.map((m) => (
        <Toast key={m.key} m={m} onClose={() => onClose(m.key)} />
      ))}
    </div>
  );
}

function Toast({ m, onClose }: { m: Message; onClose: () => void }) {
  useEffect(() => {
    if (m.kind !== 'info') return;
    const t = setTimeout(onClose, 7000);
    return () => clearTimeout(t);
  }, [m.key]);
  return (
    <div className={`desk-toast float ${m.kind}`} role={m.kind === 'error' ? 'alert' : undefined}>
      <span>{m.text}</span>
      {m.action && (
        <button type="button" className="link-btn" onClick={m.action.run}>
          {m.action.label}
        </button>
      )}
      <button type="button" className="desk-toast-x" aria-label="Закрыть" onClick={onClose}>
        <CloseIcon />
      </button>
    </div>
  );
}

/** A button of the tool rail on the left of the photo. */
export function Tool({ icon, label, on, disabled, onClick, children }: { icon: ReactNode; label: string; on?: boolean; disabled?: boolean; onClick?: () => void; children?: ReactNode }) {
  return (
    <span className="desk-tool">
      <button type="button" className={`rail-btn desk-tool-btn ${on ? 'on' : ''}`} aria-label={label} aria-pressed={on} disabled={disabled} onClick={onClick}>
        {icon}
      </button>
      {/* Its name, or a little panel of its own (the brush size). */}
      <span className={`desk-tool-pop ${children ? 'panel' : 'name'}`}>{children ?? label}</span>
    </span>
  );
}

/** A small picture of a photo. */
export function Thumb({ photo, size = 96 }: { photo: Photo; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const k = size / Math.max(photo.width, photo.height);
    c.width = Math.round(photo.width * k);
    c.height = Math.round(photo.height * k);
    c.getContext('2d')!.drawImage(photo.bitmap, 0, 0, c.width, c.height);
  }, [photo, size]);
  return <canvas ref={ref} className="desk-thumb" />;
}

export function SavedThumb({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <img src={url} className="desk-thumb" alt="" /> : <span className="desk-thumb" />;
}

/** The photos of this export in a row at the bottom: the one at hand stands out; «＋» adds more. */
export function PhotoStrip({
  photos,
  current,
  onPick,
  onRemove,
  onAdd,
}: {
  photos: { id: string; name: string; photo: Photo }[];
  current: string | null;
  onPick: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The wheel scrolls the row sideways.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  return (
    <div className="desk-strip float" ref={ref}>
      {photos.map((p, i) => (
        <span key={p.id} className={`desk-strip-item ${p.id === current ? 'on' : ''}`}>
          <button type="button" className="desk-strip-photo" title={`${i + 1}. ${p.name}`} onClick={() => onPick(p.id)}>
            <Thumb photo={p.photo} size={72} />
            <span className="desk-strip-n">{i + 1}</span>
          </button>
          <button type="button" className="desk-strip-x" aria-label="Убрать фото" title="Убрать из экспорта" onClick={() => onRemove(p.id)}>
            <CloseIcon />
          </button>
        </span>
      ))}
      <button type="button" className="desk-strip-add" title="Добавить фото" aria-label="Добавить фото" onClick={onAdd}>
        ＋
      </button>
    </div>
  );
}

/**
 * «До / после» as a curtain over the result: left of it the photo as it
 * was. `box`: the photo's place in the canvas (it is shown «contained»).
 */
export function Shutter({ value, onChange, aspect }: { value: number; onChange: (v: number) => void; aspect: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const [pl, pt] = [parseFloat(s.paddingLeft), parseFloat(s.paddingTop)];
      const [w, h] = [r.width - pl - parseFloat(s.paddingRight), r.height - pt - parseFloat(s.paddingBottom)];
      const [bw, bh] = w / h > aspect ? [h * aspect, h] : [w, w / aspect];
      setBox({ left: pl + (w - bw) / 2, top: pt + (h - bh) / 2, width: bw, height: bh });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);
  const drag = (e: React.PointerEvent) => {
    if (!box || !(e.buttons & 1)) return;
    const r = ref.current!.getBoundingClientRect();
    onChange(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };
  return (
    <div className="desk-shutter" ref={ref} style={box ?? { display: 'none' }}>
      <div
        className="desk-shutter-handle"
        style={{ left: `${value * 100}%` }}
        title="До / после: тяните — слева исходное фото; двойной щелчок убирает"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag(e);
        }}
        onPointerMove={drag}
        onDoubleClick={() => onChange(0)}
      >
        <span className="desk-shutter-grip">до · после</span>
      </div>
    </div>
  );
}
