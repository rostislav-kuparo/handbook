import { useState, type ReactNode } from 'react';
import { BLANK_FORMATS, fitPercent, openBlankFile, type Blank, type BlankFormat } from '../blank/blank';
import { BLANK_LETTERS, printLetters } from '../blank/letterSize';
import { db } from '../storage/db';
import { SheetIcon } from '../ui/icons';
import { DefaultsRow } from './DefaultsRow';
import { INK_COLORS, MARGIN_PRESETS, type PageSetup, type PaperStyle } from './page';

/** A tiny sheet of paper (16×22) for the icons. */
function PageIcon({ children }: { children?: ReactNode }) {
  return (
    <svg viewBox="0 0 16 22" width="16" height="22" aria-hidden>
      <rect x="0.75" y="0.75" width="14.5" height="20.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      {children}
    </svg>
  );
}

const PAPERS: { id: PaperStyle; name: string; icon: ReactNode }[] = [
  {
    id: 'ruled',
    name: 'Линейка',
    icon: (
      <PageIcon>
        {[6, 10, 14, 18].map((y) => (
          <line key={y} x1="3" x2="13" y1={y} y2={y} stroke="currentColor" strokeWidth="0.9" />
        ))}
      </PageIcon>
    ),
  },
  {
    id: 'grid',
    name: 'Клетка',
    icon: (
      <PageIcon>
        {[5, 9, 13, 17].map((y) => (
          <line key={`h${y}`} x1="1.5" x2="14.5" y1={y} y2={y} stroke="currentColor" strokeWidth="0.6" />
        ))}
        {[4, 8, 12].map((x) => (
          <line key={`v${x}`} x1={x} x2={x} y1="1.5" y2="20.5" stroke="currentColor" strokeWidth="0.6" />
        ))}
      </PageIcon>
    ),
  },
  { id: 'plain', name: 'Чистый лист', icon: <PageIcon /> },
];

/** A printed blank: a frame with a drawing in it. */
const BLANK_ICON = (
  <PageIcon>
    <rect x="3" y="3" width="10" height="16" fill="none" stroke="currentColor" strokeWidth="0.7" />
    <path d="M5 15 L8 7 L11 13 Z" fill="none" stroke="currentColor" strokeWidth="0.8" />
  </PageIcon>
);

/** Margin preset icons: the dashed frame shows how much room the text gets. */
const PRESET_INSETS = [3, 1.8, 4.4];

const SIDES: { key: keyof PageSetup['margins']; name: string }[] = [
  { key: 'top', name: 'Сверху' },
  { key: 'bottom', name: 'Снизу' },
  { key: 'left', name: 'Слева' },
  { key: 'right', name: 'Справа' },
];

interface Props {
  setup: PageSetup;
  /** The blank the document is written on, when it is. */
  blank: Blank | null;
  onChange: (next: PageSetup) => void;
  /** Letter size in px (one setting for all documents). */
  fontSize: number;
  onFontSize: (px: number) => void;
  /** Sets every note of the document to this letter size, mm. */
  onAllNotes?: (mm: number) => void;
}

/** Page setup of the open document: letter size, paper, margins, title, page numbers, pen colour. */
export function PageMenu({ setup, blank, onChange, fontSize, onFontSize, onAllNotes }: Props) {
  const same = (m: PageSetup['margins']) => SIDES.every((s) => m[s.key] === setup.margins[s.key]);
  const [opening, setOpening] = useState(false);

  /** A picture becomes the document's blank (the one it had is forgotten). */
  const openBlank = async (file: File | undefined) => {
    if (!file) return;
    setOpening(true);
    try {
      const b = await openBlankFile(file);
      onChange({ ...setup, blank: b.id });
      if (setup.blank) await db.blanks.delete(setup.blank);
    } catch (err) {
      alert(`Не удалось открыть картинку: ${String(err)}`);
    } finally {
      setOpening(false);
    }
  };
  /** Paper of the document's own instead of the blank (its picture is forgotten). */
  const choosePaper = (paper: PaperStyle) => {
    if (setup.blank) {
      if (!confirm('Убрать бланк? Чертежи останутся, а картинку бланка потом придётся открыть заново.')) return;
      void db.blanks.delete(setup.blank);
    }
    onChange({ ...setup, paper, blank: null });
  };
  const patchBlank = (patch: Partial<Blank>) => {
    if (blank) void db.blanks.update(blank.id, patch);
  };
  return (
    <details className="menu">
      <summary className="rail-btn" title="Лист" aria-label="Лист">
        <SheetIcon />
      </summary>
      <div className="menu-items page-menu">
        {!blank && (
        <label className="font-size-row" title="Размер почерка во всех документах">
          <span>
            Размер букв <output>{fontSize} px</output>
          </span>
          <input type="range" min={16} max={48} value={fontSize} onChange={(e) => onFontSize(Number(e.target.value))} />
        </label>
        )}

        <div className="icon-row">
          {PAPERS.map((p) => (
            <button
              key={p.id}
              className={`icon-btn ${!setup.blank && setup.paper === p.id ? 'on' : ''}`}
              title={p.name}
              aria-label={p.name}
              onClick={() => choosePaper(p.id)}
            >
              {p.icon}
            </button>
          ))}
          <label
            className={`icon-btn ${setup.blank ? 'on' : ''}`}
            title="Бланк: картинка задания (PNG, JPG, WebP) как лист документа — чертежи кладутся поверх неё"
            aria-label="Бланк из файла"
          >
            {BLANK_ICON}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/bmp,image/gif"
              hidden
              disabled={opening}
              onChange={(e) => {
                void openBlank(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          {!setup.blank && <span className="icon-sep" />}
          {!setup.blank && MARGIN_PRESETS.map((p, i) => {
            const inset = PRESET_INSETS[i];
            return (
              <button
                key={p.name}
                className={`icon-btn ${same(p.margins) ? 'on' : ''}`}
                title={`Поля: ${p.name.toLowerCase()}`}
                aria-label={`Поля: ${p.name.toLowerCase()}`}
                onClick={() => onChange({ ...setup, margins: p.margins })}
              >
                <PageIcon>
                  <rect x={inset} y={inset} width={16 - 2 * inset} height={22 - 2 * inset} fill="none" stroke="currentColor" strokeWidth="0.9" strokeDasharray="1.6 1.2" />
                </PageIcon>
              </button>
            );
          })}
        </div>

        {opening && <p className="muted small">Открываю бланк…</p>}
        {blank && <BlankSettings blank={blank} onPatch={patchBlank} onAllNotes={onAllNotes} />}

        {!setup.blank && (
        <div className="margin-sliders">
          {SIDES.map((s) => (
            <label key={s.key}>
              <span>
                {s.name} <output>{setup.margins[s.key]} мм</output>
              </span>
              <input
                type="range"
                min={0}
                max={60}
                value={setup.margins[s.key]}
                onChange={(e) => onChange({ ...setup, margins: { ...setup.margins, [s.key]: Number(e.target.value) } })}
              />
            </label>
          ))}
        </div>
        )}

        <div className="page-menu-foot">
          {!setup.blank && (
          <>
          <label className="check inline" title="Розовая линия поля справа, как слева (на листе в линейку и в клетку)">
            <input type="checkbox" checked={setup.rightLine} onChange={(e) => onChange({ ...setup, rightLine: e.target.checked })} />
            Линия поля справа
          </label>
          <label className="check inline">
            <input type="checkbox" checked={setup.showTitle} onChange={(e) => onChange({ ...setup, showTitle: e.target.checked })} />
            Название на листе
          </label>
          <div className="numbering-row">
            <label className="check inline">
              <input type="checkbox" checked={setup.pageNumbers} onChange={(e) => onChange({ ...setup, pageNumbers: e.target.checked })} />
              Нумерация страниц
            </label>
            {setup.pageNumbers && (
              <label className="first-number" title="Номер первого листа">
                с
                <input
                  type="number"
                  min={0}
                  max={9999}
                  value={setup.firstNumber}
                  onChange={(e) => onChange({ ...setup, firstNumber: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
                />
              </label>
            )}
          </div>
          </>
          )}
          <div className="swatches" role="group" aria-label="Цвет чернил">
            {INK_COLORS.map((c) => (
              <button
                key={c.color}
                className={`swatch ${setup.ink === c.color ? 'on' : ''}`}
                style={{ ['--sw' as string]: c.color }}
                title={`${c.name} ручка`}
                aria-label={`${c.name} ручка`}
                onClick={() => onChange({ ...setup, ink: c.color })}
              />
            ))}
            <label className={`swatch custom ${INK_COLORS.some((c) => c.color === setup.ink) ? '' : 'on'}`} title="Свой цвет">
              <input type="color" value={setup.ink} onChange={(e) => onChange({ ...setup, ink: e.target.value })} />
            </label>
          </div>
          <DefaultsRow
            part={
              setup.blank
                ? { ink: setup.ink }
                : { paper: setup.paper, margins: setup.margins, ink: setup.ink, showTitle: setup.showTitle, pageNumbers: setup.pageNumbers, rightLine: setup.rightLine }
            }
            what={setup.blank ? 'цвет чернил' : 'бумага, поля, название, нумерация, чернила'}
          />
        </div>
      </div>
    </details>
  );
}

/** A blank's paper and how the printer puts it on. */
function BlankSettings({ blank, onPatch, onAllNotes }: { blank: Blank; onPatch: (patch: Partial<Blank>) => void; onAllNotes?: (mm: number) => void }) {
  const letters = blank.letters ?? BLANK_LETTERS;
  const fit = fitPercent(blank);
  return (
    <div className="blank-settings">
      <div className="blank-name" title={blank.name}>
        Бланк: <strong>{blank.name}</strong>
      </div>
      <div className="blank-row">
        <span>Бумага</span>
        <div className="pill small" role="group" aria-label="Формат бумаги">
          {(Object.keys(BLANK_FORMATS) as BlankFormat[]).map((f) => (
            <button key={f} className={blank.format === f ? 'on' : ''} onClick={() => onPatch({ format: f })}>
              {BLANK_FORMATS[f].name}
            </button>
          ))}
        </div>
        <div className="pill small" role="group" aria-label="Ориентация">
          <button className={!blank.landscape ? 'on' : ''} onClick={() => onPatch({ landscape: false })} title="Книжная">
            ▯
          </button>
          <button className={blank.landscape ? 'on' : ''} onClick={() => onPatch({ landscape: true })} title="Альбомная">
            ▭
          </button>
        </div>
      </div>
      <div className="blank-row">
        <span>Печать</span>
        <div className="pill small" role="group" aria-label="Масштаб печати">
          <button
            className={blank.print === 'fit' ? 'on' : ''}
            onClick={() => onPatch({ print: 'fit' })}
            title="Как печатает принтер «по размеру страницы»: при печати и «На столе» вся страница — бланк, чертежи, надписи — уменьшается вместе, у края остаётся полоска около 4 мм"
          >
            по листу · {fit} %
          </button>
          <button
            className={blank.print === 'actual' ? 'on' : ''}
            onClick={() => onPatch({ print: 'actual' })}
            title="Без уменьшения: края бланка могут не пропечататься"
          >
            100 %
          </button>
        </div>
      </div>
      <label className="font-size-row" title="Высота заглавных букв почерка на этом бланке: подписи чертежей и новые надписи">
        <span>
          Буквы на бланке <output>{String(letters).replace('.', ',')} мм</output>
        </span>
        <input type="range" min={2} max={6} step={0.1} value={letters} onChange={(e) => onPatch({ letters: Number(e.target.value) })} />
      </label>
      <div className="blank-row">
        <button className="link-btn" onClick={() => void printLetters(blank).then((v) => onPatch({ letters: v }))} title="Как печатный текст бланка, чуть крупнее">
          ↺ по бланку
        </button>
        {onAllNotes && (
          <button className="link-btn" onClick={() => onAllNotes(letters)} title="Сделать все надписи документа этого размера">
            все надписи — {String(letters).replace('.', ',')} мм
          </button>
        )}
      </div>
      <p className="muted small">Чертежи кладите поверх бланка («⇱ Поверх»): их место — на листе бумаги, в миллиметрах.</p>
    </div>
  );
}
