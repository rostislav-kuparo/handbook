import { useEffect, useRef, useState } from 'react';
import { isDesktop } from '../util/download';
import { WebMenu, type CommandId } from './menu';

const appWindow = async () => (await import('@tauri-apps/api/window')).getCurrentWindow();

/** Minimise, maximise / restore, close: the window has no frame of its own. */
function WindowButtons() {
  const [maximized, setMaximized] = useState(false);
  // Hovering «Развернуть» opens Windows 11's snap layouts, as on a window with a frame.
  const snapTimer = useRef<number | undefined>(undefined);
  const snapLater = () => {
    snapTimer.current = window.setTimeout(() => {
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke('snap_layouts')).catch(() => {});
    }, 500);
  };
  const snapCancel = () => window.clearTimeout(snapTimer.current);
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    void (async () => {
      const w = await appWindow();
      const update = async () => setMaximized(await w.isMaximized());
      await update();
      const unlisten = await w.onResized(() => void update());
      if (gone) unlisten();
      else off = unlisten;
    })();
    return () => {
      gone = true;
      off?.();
    };
  }, []);
  return (
    <div className="window-buttons">
      <button onClick={() => void appWindow().then((w) => w.minimize())} title="Свернуть" aria-label="Свернуть">
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
          <path d="M0 5.5h10" stroke="currentColor" />
        </svg>
      </button>
      <button
        onClick={() => {
          snapCancel();
          void appWindow().then((w) => w.toggleMaximize());
        }}
        onMouseEnter={snapLater}
        onMouseLeave={snapCancel}
        aria-label={maximized ? 'Свернуть в окно' : 'Развернуть'}
      >
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden fill="none" stroke="currentColor">
          {maximized ? (
            <>
              <rect x="0.5" y="2.5" width="7" height="7" />
              <path d="M2.5 2.5V0.5h7v7h-2" />
            </>
          ) : (
            <rect x="0.5" y="0.5" width="9" height="9" />
          )}
        </svg>
      </button>
      <button className="close" onClick={() => void appWindow().then((w) => w.close())} title="Закрыть" aria-label="Закрыть">
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}

/** One line at the top: the app's name, its menu and (desktop app) the window buttons; drag it to move the window. */
export function TitleBar({ run, checked }: { run: (id: CommandId) => void; checked: Partial<Record<CommandId, boolean>> }) {
  return (
    <header className="titlebar no-print" data-tauri-drag-region>
      <img className="titlebar-icon" src="/favicon.svg" alt="" width={16} height={16} data-tauri-drag-region />
      <span className="titlebar-name" data-tauri-drag-region>
        Handbook
      </span>
      <WebMenu run={run} checked={checked} />
      <div className="titlebar-drag" data-tauri-drag-region />
      {isDesktop() && <WindowButtons />}
    </header>
  );
}
