import type { ReactNode } from 'react';
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
  onChange: (next: PageSetup) => void;
  /** Letter size in px (one setting for all documents). */
  fontSize: number;
  onFontSize: (px: number) => void;
}

/** Page setup of the open document: letter size, paper, margins, title, pen colour. */
export function PageMenu({ setup, onChange, fontSize, onFontSize }: Props) {
  const same = (m: PageSetup['margins']) => SIDES.every((s) => m[s.key] === setup.margins[s.key]);
  return (
    <details className="menu">
      <summary className="btn">Лист ▾</summary>
      <div className="menu-items page-menu">
        <label className="font-size-row" title="Размер почерка во всех документах">
          <span>
            Размер букв <output>{fontSize} px</output>
          </span>
          <input type="range" min={16} max={48} value={fontSize} onChange={(e) => onFontSize(Number(e.target.value))} />
        </label>

        <div className="icon-row">
          {PAPERS.map((p) => (
            <button
              key={p.id}
              className={`icon-btn ${setup.paper === p.id ? 'on' : ''}`}
              title={p.name}
              aria-label={p.name}
              onClick={() => onChange({ ...setup, paper: p.id })}
            >
              {p.icon}
            </button>
          ))}
          <span className="icon-sep" />
          {MARGIN_PRESETS.map((p, i) => {
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

        <div className="margin-sliders">
          {SIDES.map((s) => (
            <label key={s.key}>
              <span>
                {s.name} <output>{setup.margins[s.key]} мм</output>
              </span>
              <input
                type="range"
                min={5}
                max={60}
                value={setup.margins[s.key]}
                onChange={(e) => onChange({ ...setup, margins: { ...setup.margins, [s.key]: Number(e.target.value) } })}
              />
            </label>
          ))}
        </div>

        <div className="page-menu-foot">
          <label className="check inline">
            <input type="checkbox" checked={setup.showTitle} onChange={(e) => onChange({ ...setup, showTitle: e.target.checked })} />
            Название на листе
          </label>
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
        </div>
      </div>
    </details>
  );
}
