import { useEffect, useState } from 'react';
import { Documents } from './editor/Documents';
import { requestPrint, SHOW_DOC_EVENT } from './editor/docState';
import { useHandwriting } from './engine/handwriting';
import { SketchHelp } from './sketch/SketchHelp';
import { BACKUP_DESKS_KEY, backupEverything, loadHandwriting, newDocument, openJson, saveHandwriting } from './shell/fileActions';
import { HELP_EVENT, HelpDialog, type HelpId } from './shell/HelpDialogs';
import { useMenuKeys, type CommandId } from './shell/menu';
import { TitleBar } from './shell/TitleBar';
import { getSetting, setSetting } from './storage/db';
import { Studio } from './studio/Studio';
import { isDesktop } from './util/download';
import { useLive } from './util/useLive';

type Tab = 'docs' | 'studio';
type Theme = 'system' | 'light' | 'dark';

const THEME_KEY = 'handbook.theme';

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

/** The window's own parts (its shadow, Windows dialogs) follow the app's theme (desktop app). */
async function applyWindowTheme(theme: Theme) {
  if (!isDesktop()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow()
    .setTheme(theme === 'system' ? null : theme)
    .catch(() => {});
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

/**
 * One panel at a time: opening a menu closes the others; a click outside or
 * Esc closes it.
 */
function oneMenuAtATime() {
  const openMenus = () => [...document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')];
  document.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      if (!(d instanceof HTMLDetailsElement) || !d.open || !d.classList.contains('menu')) return;
      for (const other of openMenus()) if (other !== d && !other.contains(d)) other.open = false;
    },
    true,
  );
  document.addEventListener(
    'mousedown',
    (e) => {
      for (const m of openMenus()) if (!m.contains(e.target as Node)) m.open = false;
    },
    true,
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') for (const m of openMenus()) m.open = false;
  });
}
oneMenuAtATime();

export function App() {
  const [tab, setTab] = useState<Tab>('docs');
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [help, setHelp] = useState<HelpId | 'sketch' | null>(null);
  const backupDesks = useLive(() => getSetting(BACKUP_DESKS_KEY, false), [], false);
  const { byChar, building, loaded } = useHandwriting();

  useEffect(() => {
    void getSetting<Tab>('app.tab', 'docs').then(setTab);
  }, []);
  const go = (t: Tab) => {
    setTab(t);
    void setSetting('app.tab', t);
  };

  useEffect(() => {
    const onShow = () => go('docs');
    const onHelp = (e: Event) => setHelp((e as CustomEvent<HelpId | 'sketch'>).detail);
    window.addEventListener(SHOW_DOC_EVENT, onShow);
    window.addEventListener(HELP_EVENT, onHelp);
    return () => {
      window.removeEventListener(SHOW_DOC_EVENT, onShow);
      window.removeEventListener(HELP_EVENT, onHelp);
    };
  }, []);

  useEffect(() => {
    applyTheme(theme);
    void applyWindowTheme(theme);
  }, [theme]);
  const pickTheme = (t: Theme) => {
    setTheme(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      // storage unavailable: the choice lasts for this session
    }
  };

  const run = (id: CommandId) => {
    switch (id) {
      case 'file.new':
        return void newDocument();
      case 'file.open':
        return void openJson();
      case 'file.backup':
        return void backupEverything();
      case 'file.backupDesks':
        return void setSetting(BACKUP_DESKS_KEY, !backupDesks);
      case 'file.saveHandwriting':
        return void saveHandwriting();
      case 'file.loadHandwriting':
        return void loadHandwriting();
      case 'file.print':
        go('docs');
        return requestPrint();
      case 'app.quit':
        return void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().close());
      case 'theme.system':
      case 'theme.light':
      case 'theme.dark':
        return pickTheme(id.slice(6) as Theme);
      case 'help.letters':
      case 'help.sketch':
      case 'help.keys':
      case 'help.about':
        return setHelp(id.slice(5) as HelpId | 'sketch');
    }
  };
  const checked = {
    'file.backupDesks': backupDesks,
    'theme.system': theme === 'system',
    'theme.light': theme === 'light',
    'theme.dark': theme === 'dark',
  };
  useMenuKeys(run);

  return (
    <div className="app">
      <TitleBar run={run} checked={checked} />
      {tab === 'docs' ? <Documents /> : <Studio />}
      <nav className="tabs pill float no-print" role="tablist">
        <button role="tab" aria-selected={tab === 'docs'} className={tab === 'docs' ? 'on' : ''} onClick={() => go('docs')}>
          Документы
        </button>
        <button
          role="tab"
          aria-selected={tab === 'studio'}
          className={tab === 'studio' ? 'on' : ''}
          onClick={() => go('studio')}
          title={!loaded ? 'Почерк загружается' : building ? 'Собираю шрифт…' : `Букв в почерке: ${byChar.size}`}
        >
          Почерк
          {(!loaded || building) && <span className="tab-busy pulse" aria-label="собираю шрифт" />}
        </button>
      </nav>
      {help === 'sketch' && <SketchHelp onClose={() => setHelp(null)} />}
      {help && help !== 'sketch' && <HelpDialog which={help} onClose={() => setHelp(null)} />}
    </div>
  );
}
