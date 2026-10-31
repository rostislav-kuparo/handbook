// A block's code (a drawing's commands, an HTML block's code and data) in a
// window of its own on the left, beside the sheets — not under the block,
// where it pushed the writing apart and covered it. One window at a time:
// opening another block's code moves the window over to that block.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** The block whose code is open in the window (its node view's id), if any. */
let owner: string | null = null;
const listeners = new Set<() => void>();

function setOwner(id: string | null) {
  owner = id;
  // The sheets make room for the window, «Недавние» give it their place.
  document.body.classList.toggle('side-editor-open', id !== null);
  listeners.forEach((f) => f());
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};

/** Whether this block's code is open in the window, and opening (another block's closes) or closing it. */
export function useSideEditor(id: string): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(subscribe, () => owner === id);
  // A block removed with its window open takes the window with it.
  useEffect(
    () => () => {
      if (owner === id) setOwner(null);
    },
    [id],
  );
  return [open, (v) => (v ? setOwner(id) : owner === id && setOwner(null))];
}

const WIDTH_KEY = 'hb-side-editor-width';
const WIDTH = { min: 300, max: 720, start: 400 };

function savedWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return v >= WIDTH.min && v <= WIDTH.max ? v : WIDTH.start;
  } catch {
    return WIDTH.start;
  }
}

interface Props {
  title: string;
  /** A click on the title: show the block on the sheet. */
  onTitle?: () => void;
  onClose: () => void;
  /** Buttons in the header, before ✕. */
  tools?: ReactNode;
  children: ReactNode;
}

/** The window on the left with a block's code; its right edge sets its width (remembered). */
export function SideEditor({ title, onTitle, onClose, tools, children }: Props) {
  const [width, setWidth] = useState(savedWidth);
  useEffect(() => {
    document.body.style.setProperty('--side-editor-w', `${width}px`);
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // Not remembered: the next window opens as wide as usual.
    }
  }, [width]);

  const resize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const [sx, w0] = [e.clientX, width];
    const move = (ev: PointerEvent) =>
      setWidth(Math.round(Math.min(Math.max(w0 + ev.clientX - sx, WIDTH.min), Math.min(WIDTH.max, window.innerWidth - 240))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // In the documents' room (beside «Недавние», under the tabs); the whole window when there is none.
  const host = document.querySelector('.documents') ?? document.body;
  return createPortal(
    <aside
      className="side-editor float no-print"
      style={{ width }}
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="side-editor-head">
        <button className="side-editor-title" onClick={onTitle} title="Показать на листе">
          {title}
        </button>
        <div className="side-editor-tools">
          {tools}
          <button onClick={onClose} title="Закрыть (Esc)" aria-label="Закрыть">
            ✕
          </button>
        </div>
      </header>
      <div className="side-editor-body">{children}</div>
      <span className="side-editor-resize" onPointerDown={resize} title="Ширина окна" />
    </aside>,
    host,
  );
}
