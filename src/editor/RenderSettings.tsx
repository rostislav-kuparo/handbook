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

/**
 * How the letters are put into text: lines, spacing, joins, pairs. Lives next
 * to the «Отрендерить» button; the shape of the letters themselves is set in
 * the handwriting studio.
 */
export function RenderSettings() {
  const { style } = useHandwriting();
  return (
    <>
      <p className="muted small render-note">Меняют вид текста и в редакторе, и в отрендеренном виде. Сами буквы (перо, наклон) — в «Почерке».</p>
      <section className="panel">
        <h3>Строки</h3>
        <p className="muted small">Чтобы текст не был написан «по линеечке».</p>
        {LINES.map((s) => (
          <Slider key={s.key} s={s} style={style} />
        ))}
      </section>
      <section className="panel">
        <h3>Текст</h3>
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
        <Check k="connect" label="Слитное письмо (соединять по точкам входа/выхода, на двух высотах)" style={style} />
        <Check k="kerning" label="Оптический кернинг (Г, Т, У, точки — ближе)" style={style} />
        <Check k="pairs" label="Использовать записанные пары букв (ст, но…)" style={style} />
        <button className="btn small" onClick={() => updateStyle({ seed: style.seed + 1 })} title="Другой выбор вариантов букв во всём тексте">
          Перемешать случайность
        </button>
      </section>
    </>
  );
}
