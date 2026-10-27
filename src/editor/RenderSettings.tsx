import { useState } from 'react';
import { updateStyle, useHandwriting } from '../engine/handwriting';
import { Check, Slider, type SliderDef } from '../ui/StyleControls';

const LINES: SliderDef[] = [
  { key: 'lineJitter', label: 'Неровность строк', min: 0, max: 1, step: 0.05, hint: 'случайное расстояние между строками: 0 — ровно по линейке' },
  { key: 'sag', label: 'Просадка', min: 0, max: 1, step: 0.05, hint: 'строка уходит вниз, слова и буквы проседают ниже линии' },
];

const SPACING: SliderDef[] = [
  { key: 'letterSpacing', label: 'Между буквами', min: 0, max: 160, step: 1, hint: 'для несоединённых букв' },
  { key: 'wordSpacing', label: 'Между словами', min: 120, max: 700, step: 10, hint: 'ширина пробела' },
];

type Part = 'lines' | 'text';

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
      </div>
      {part === 'lines' ? (
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
