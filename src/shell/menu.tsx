import { useEffect, useRef } from 'react';
import { isDesktop } from '../util/download';

export type CommandId =
  | 'file.new'
  | 'file.open'
  | 'file.backup'
  | 'file.backupDesks'
  | 'file.saveHandwriting'
  | 'file.loadHandwriting'
  | 'file.print'
  | 'app.quit'
  | 'theme.system'
  | 'theme.light'
  | 'theme.dark'
  | 'help.letters'
  | 'help.sketch'
  | 'help.keys'
  | 'help.about';

interface Entry {
  id: CommandId;
  text: string;
  /** Shown next to the item; the keys themselves are handled by useMenuKeys. */
  keys?: string;
  check?: boolean;
}

const MENU: { text: string; items: (Entry | '-')[] }[] = [
  {
    text: 'Файл',
    items: [
      { id: 'file.new', text: 'Новый документ', keys: 'Ctrl+N' },
      { id: 'file.open', text: 'Открыть…', keys: 'Ctrl+O' },
      '-',
      { id: 'file.backup', text: 'Резервная копия всего…' },
      { id: 'file.backupDesks', text: 'Копия вместе со столами (фото)', check: true },
      '-',
      { id: 'file.saveHandwriting', text: 'Сохранить почерк…' },
      { id: 'file.loadHandwriting', text: 'Загрузить почерк…' },
      '-',
      { id: 'file.print', text: 'Печать / PDF…', keys: 'Ctrl+P' },
      '-',
      { id: 'app.quit', text: 'Выход' },
    ],
  },
  {
    text: 'Настройки',
    items: [
      { id: 'theme.system', text: 'Тема как в системе', check: true },
      { id: 'theme.light', text: 'Светлая тема', check: true },
      { id: 'theme.dark', text: 'Тёмная тема', check: true },
    ],
  },
  {
    text: 'Информация',
    items: [
      { id: 'help.letters', text: 'Как писать буквы' },
      { id: 'help.sketch', text: 'Команды чертежа и запрос для нейронки' },
      { id: 'help.keys', text: 'Горячие клавиши и формулы' },
      '-',
      { id: 'help.about', text: 'О программе' },
    ],
  },
];

/** Ctrl + the key's place on the keyboard (so it works in any layout). */
const KEYS: Record<string, CommandId> = { KeyN: 'file.new', KeyO: 'file.open', KeyP: 'file.print' };

type Checked = Partial<Record<CommandId, boolean>>;

/** The menu's shortcuts, handled by the page itself. */
export function useMenuKeys(run: (id: CommandId) => void) {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const id = KEYS[e.code];
      if (!id) return;
      e.preventDefault();
      latest.current(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** The window menu, in the title bar. «Выход» only where there is a window to close. */
export function WebMenu({ run, checked }: { run: (id: CommandId) => void; checked: Checked }) {
  return (
    <nav className="web-menu no-print" aria-label="Меню">
      {MENU.map((g) => (
        <details key={g.text} className="menu">
          <summary>{g.text}</summary>
          <div className="menu-items web-menu-items">
            {g.items
              .filter((it) => it === '-' || it.id !== 'app.quit' || isDesktop())
              .map((it, i) =>
                it === '-' ? (
                  <hr key={i} className="menu-sep" />
                ) : (
                  <button
                    key={it.id}
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      run(it.id);
                    }}
                  >
                    <span className="web-menu-tick">{it.check && checked[it.id] ? '✓' : ''}</span>
                    <span>{it.text}</span>
                    {it.keys && <kbd>{it.keys}</kbd>}
                  </button>
                ),
              )}
          </div>
        </details>
      ))}
    </nav>
  );
}
