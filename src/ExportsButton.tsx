import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DownloadIcon } from './ui/icons';
import { useLive } from './util/useLive';
import {
  clearExportHistory,
  EXPORTED_EVENT,
  exportHistory,
  isDesktop,
  openFile,
  revealFile,
  type ExportEntry,
} from './util/download';

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} Б` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ`;

const when = (at: number) =>
  new Date(at).toLocaleString('ru-RU', new Date(at).toDateString() === new Date().toDateString() ? { timeStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' });

/**
 * Export history in the top corner, like a browser's downloads button: it shows
 * up after the first export, opens by itself when a file is saved, and in the
 * desktop app opens the file or its folder.
 */
export function ExportsButton() {
  const history = useLive(exportHistory, [], [] as ExportEntry[]);
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onExport = (e: Event) => {
      setFresh((e as CustomEvent<ExportEntry>).detail.id);
      setOpen(true);
    };
    window.addEventListener(EXPORTED_EVENT, onExport);
    return () => window.removeEventListener(EXPORTED_EVENT, onExport);
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (history.length === 0) return null;
  const desktop = isDesktop();

  return (
    <div className="exports" ref={ref}>
      <button
        className={`exports-btn ${fresh && !open ? 'new' : ''} ${open ? 'on' : ''}`}
        onClick={() => {
          setOpen(!open);
          if (open) setFresh(null);
        }}
        title="История экспорта"
        aria-label="История экспорта"
        aria-expanded={open}
      >
        <DownloadIcon />
      </button>
      {open && (
        <div className="exports-panel" role="dialog" aria-label="История экспорта">
          <div className="exports-head">
            <strong>Экспорт</strong>
            <button className="link-btn" onClick={() => void clearExportHistory().then(() => setOpen(false))}>
              Очистить
            </button>
          </div>
          <ul>
            {history.map((e) => (
              <li key={e.id} className={e.id === fresh ? 'fresh' : ''}>
                <span className="exports-ext">{e.name.split('.').pop()?.toUpperCase().slice(0, 4)}</span>
                <div className="exports-info">
                  <span className="exports-name" title={e.path ?? e.name}>
                    {e.name}
                  </span>
                  <span className="muted small">
                    {size(e.size)} · {when(e.at)}
                  </span>
                </div>
                {e.path && (
                  <div className="exports-actions">
                    <button className="btn small" onClick={() => void openFile(e.path!)}>
                      Открыть
                    </button>
                    <button className="btn small" onClick={() => void revealFile(e.path!)} title="Показать файл в папке">
                      В папке
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="muted small exports-foot">
            {desktop
              ? 'Файлы сохраняются в папку «Загрузки».'
              : 'Файлы сохранены в папку загрузок браузера. Открыть папку можно в настольном приложении.'}
          </p>
        </div>
      )}
    </div>
  );
}

/** The floating top-right corner: the tab's export menu, then the export history. */
export function TopCorner({ children }: { children?: ReactNode }) {
  return (
    <div className="corner-top no-print">
      {children}
      <ExportsButton />
    </div>
  );
}
