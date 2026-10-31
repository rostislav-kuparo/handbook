import { useState } from 'react';
import { updateStyle, useHandwriting } from '../engine/handwriting';
import { Check, Slider, type SliderDef } from '../ui/StyleControls';
import { saveWear, useWear } from '../wear/settings';
import type { LayerShow, PrinterKind, WearSettings } from '../wear/wear';

/** The stages of a rendered sheet that can be left out (and are left out of the files too). */
const SHOWN: { key: keyof LayerShow; label: string; hint: string }[] = [
  { key: 'print', label: 'печать бланка', hint: 'напечатанный бланк под текстом' },
  { key: 'drawings', label: 'чертежи', hint: 'линии чертежей и графиков' },
  { key: 'text', label: 'текст', hint: 'буквы, надписи, подписи' },
  { key: 'wear', label: 'следы', hint: 'потёртости, ластик, проколы циркуля' },
  { key: 'folds', label: 'складки', hint: 'складки бумаги' },
];

const LINES: SliderDef[] = [
  { key: 'lineJitter', label: 'Неровность строк', min: 0, max: 1, step: 0.05, hint: 'случайное расстояние между строками: 0 — ровно по линейке' },
  { key: 'sag', label: 'Просадка', min: 0, max: 1, step: 0.05, hint: 'строка уходит вниз, слова и буквы проседают ниже линии' },
];

const SPACING: SliderDef[] = [
  { key: 'letterSpacing', label: 'Между буквами', min: 0, max: 160, step: 1, hint: 'для несоединённых букв' },
  { key: 'wordSpacing', label: 'Между словами', min: 120, max: 700, step: 10, hint: 'ширина пробела' },
];

type Part = 'lines' | 'text' | 'wear';

/** The traces' sliders: what each does. */
const WEAR_SLIDERS: { key: 'smudge' | 'size' | 'erasers' | 'depth' | 'folds'; label: string; min: number; max: number; step: number; hint: string }[] = [
  { key: 'smudge', label: 'Потёртости', min: 0, max: 2, step: 0.1, hint: 'графит, размазанный рукой у линий и букв, и крошки грифеля: 0 — нет, 1 — обычно, 2 — грязная работа' },
  { key: 'size', label: 'Размер пятен', min: 0.5, max: 2, step: 0.1, hint: 'насколько велики пятна от руки' },
  { key: 'erasers', label: 'Следы ластика', min: 0, max: 3, step: 1, hint: 'сколько стёртых линий на листе: бледный след линии и серое пятно ластика вокруг' },
  { key: 'depth', label: 'Глубина проколов', min: 0.5, max: 2, step: 0.1, hint: 'насколько глубоко вдавлена бумага у прокола иглы циркуля' },
  { key: 'folds', label: 'Складки', min: 0, max: 2, step: 0.1, hint: 'мягкие складки там, где лист тянули рукой: 0 — ровный лист, 2 — мятый' },
];

/** Traces of work on the rendered sheets: shown here, printed and in every export while on. */
function WearPart() {
  const wear = useWear();
  const set = (patch: Partial<WearSettings>) => void saveWear({ ...wear, ...patch });
  return (
    <section>
      <div className="render-show" title="Что видно на отрендеренном листе — и что попадёт в печать и файлы">
        <span className="small muted">Показывать:</span>
        {SHOWN.map((x) => (
          <label key={x.key} className="check inline small" title={x.hint}>
            <input type="checkbox" checked={wear.show[x.key]} onChange={(e) => set({ show: { ...wear.show, [x.key]: e.target.checked } })} />
            {x.label}
          </label>
        ))}
      </div>
      <label className="slider" title="Каким принтером напечатан бланк: на экране, в файлах и на снимке «На столе»">
        <span>Принтер бланка</span>
        <select value={wear.printer} onChange={(e) => set({ printer: e.target.value as PrinterKind })}>
          <option value="new">новый</option>
          <option value="usual">обычный</option>
          <option value="tired">уставший</option>
        </select>
      </label>
      <label className="check" title="Видно после «Отрендерить»; пока включено — и при печати, в PDF, PNG, SVG и «На столе»">
        <input type="checkbox" checked={wear.on} onChange={(e) => set({ on: e.target.checked })} />
        Следы работы: потёртости карандаша, ластик, проколы циркуля
      </label>
      {wear.on && (
        <>
          {WEAR_SLIDERS.map((s) => (
            <label key={s.key} className="slider" title={s.hint}>
              <span>
                {s.label} <output>{String(wear[s.key])}</output>
              </span>
              <input type="range" min={s.min} max={s.max} step={s.step} value={wear[s.key]} onChange={(e) => set({ [s.key]: Number(e.target.value) })} />
            </label>
          ))}
          <label className="slider" title="Куда рука смазывает графит: правша — вправо и вниз от линий">
            <span>Рука</span>
            <select value={wear.hand} onChange={(e) => set({ hand: e.target.value === 'left' ? 'left' : 'right' })}>
              <option value="right">правая</option>
              <option value="left">левая</option>
            </select>
          </label>
          <label className="check" title="Кроме мягких складок изредка — острый залом">
            <input type="checkbox" checked={wear.sharp} onChange={(e) => set({ sharp: e.target.checked })} />
            Острые заломы
          </label>
          <label className="check" title="В центрах окружностей и дуг, начерченных циркулем">
            <input type="checkbox" checked={wear.holes} onChange={(e) => set({ holes: e.target.checked })} />
            Проколы иглы циркуля
          </label>
          <button className="btn small" onClick={() => set({ seed: wear.seed + 1 })} title="Те же настройки, другие места следов и складок">
            ↺ Другие следы
          </button>
          <button className="btn small" onClick={() => set({ printerSeed: wear.printerSeed + 1 })} title="Другие полосы, пятна и точки тонера">
            ↺ Другой принтер
          </button>
        </>
      )}
    </section>
  );
}

/**
 * How the letters are put into text: lines, spacing, joins, pairs. Changes
 * both the editor and the rendered view; the shape of the letters themselves
 * is set in the handwriting studio.
 */
export function RenderSettings() {
  const { style } = useHandwriting();
  const [part, setPart] = useState<Part>('lines');
  return (
    <>
      <div className="pill" role="tablist" aria-label="Настройки рендера">
        <button role="tab" aria-selected={part === 'lines'} className={part === 'lines' ? 'on' : ''} onClick={() => setPart('lines')}>
          Строки
        </button>
        <button role="tab" aria-selected={part === 'text'} className={part === 'text' ? 'on' : ''} onClick={() => setPart('text')}>
          Текст
        </button>
        <button role="tab" aria-selected={part === 'wear'} className={part === 'wear' ? 'on' : ''} onClick={() => setPart('wear')}>
          Следы
        </button>
      </div>
      {part === 'wear' ? (
        <WearPart />
      ) : part === 'lines' ? (
        <section>
          {LINES.map((s) => (
            <Slider key={s.key} s={s} style={style} />
          ))}
        </section>
      ) : (
        <section>
          {SPACING.map((s) => (
            <Slider key={s.key} s={s} style={style} />
          ))}
          <label className="slider" title="Сколько разных вариантов каждой буквы чередуется в тексте">
            <span>Вариантов каждой буквы</span>
            <select value={style.variants} onChange={(e) => updateStyle({ variants: Number(e.target.value) })}>
              {[1, 3, 5, 7, 11, 13].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <Check k="connect" label="Слитное письмо (соединять по точкам входа/выхода)" style={style} />
          <Check
            k="bridge"
            label="Соединять в рендере живым штрихом: буквы не гнутся, связка идёт от выхода к началу следующей, даже если она написана без входа"
            style={style}
          />
          <Check k="kerning" label="Оптический кернинг (Г, Т, У, точки — ближе)" style={style} />
          <Check k="pairs" label="Использовать записанные пары букв (ст, но…)" style={style} />
          <button className="btn small" onClick={() => updateStyle({ seed: style.seed + 1 })} title="Другой выбор вариантов букв во всём тексте">
            Перемешать случайность
          </button>
        </section>
      )}
    </>
  );
}
