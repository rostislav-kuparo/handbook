import { useEffect, useState } from 'react';
import { Documents } from './editor/Documents';
import { useHandwriting } from './engine/handwriting';
import { getSetting, setSetting } from './storage/db';
import { ExportsButton } from './ExportsButton';
import { Studio } from './studio/Studio';

type Tab = 'docs' | 'studio';
type Theme = 'system' | 'light' | 'dark';

const THEME_KEY = 'handbook.theme';
const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: '◐ Как в системе' },
  { id: 'light', label: '☀ Светлая' },
  { id: 'dark', label: '☾ Тёмная' },
];

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

// Before the first render, so the app never flashes in the wrong theme.
applyTheme(readTheme());

/**
 * The window never scrolls: only the panels inside it do. The CSS stops the
 * wheel and the touchpad bounce; this puts the app back when something else
 * shifted it anyway (a focus or scrollIntoView reaching past the panels).
 */
function pinWindow() {
  const pinned = (el: EventTarget | null) =>
    el === document || el === document.documentElement || el === document.body || (el instanceof HTMLElement && (el.id === 'root' || el.classList.contains('app')));
  document.addEventListener(
    'scroll',
    (e) => {
      if (!pinned(e.target)) return;
      const el = e.target === document ? document.documentElement : (e.target as HTMLElement);
      if (el.scrollTop || el.scrollLeft) el.scrollTo(0, 0);
    },
    { capture: true, passive: true },
  );
}
pinWindow();

/** App theme: system / light / dark (a per-device preference). */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const next = () => {
    const t = THEMES[(THEMES.findIndex((x) => x.id === theme) + 1) % THEMES.length].id;
    setTheme(t);
    applyTheme(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      // storage unavailable: the choice lasts for this session
    }
  };
  return (
    <button className="theme-toggle" onClick={next} title="Тема оформления (клик — следующая)">
      {THEMES.find((x) => x.id === theme)!.label}
    </button>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>('docs');
  const { byChar, building, loaded } = useHandwriting();

  useEffect(() => {
    void getSetting<Tab>('app.tab', 'docs').then(setTab);
  }, []);
  const go = (t: Tab) => {
    setTab(t);
    void setSetting('app.tab', t);
  };

  return (
    <div className="app">
      <header className="topbar no-print">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={26} height={26} />
          Handbook
        </div>
        <nav className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'docs'} className={tab === 'docs' ? 'active' : ''} onClick={() => go('docs')}>
            Документы
          </button>
          <button role="tab" aria-selected={tab === 'studio'} className={tab === 'studio' ? 'active' : ''} onClick={() => go('studio')}>
            Почерк
          </button>
        </nav>
        <div className="topbar-right">
          <div className="font-status" title="Шрифт собирается из ваших образцов на лету">
            {!loaded ? 'загрузка…' : building ? <span className="pulse">собираю шрифт…</span> : `букв в почерке: ${byChar.size}`}
          </div>
          <ExportsButton />
          <ThemeToggle />
        </div>
      </header>
      {tab === 'docs' ? <Documents /> : <Studio />}
    </div>
  );
}
