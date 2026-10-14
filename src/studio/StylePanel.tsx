import { updateStyle, useHandwriting } from '../engine/handwriting';
import { Style } from '../model/types';

interface SliderDef {
  key: keyof Style;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}

const PEN: SliderDef[] = [
  { key: 'weight', label: 'Толщина пера', min: 18, max: 120, step: 1, hint: 'в единицах шрифта (1000 = кегль)' },
  { key: 'pressure', label: 'Нажим', min: 0, max: 1, step: 0.05, hint: 'насколько давление меняет толщину' },
  { key: 'jitter', label: 'Живость', min: 0, max: 1.5, step: 0.05, hint: 'случайные отличия каждой буквы' },
  { key: 'fantasy', label: 'Фантазия модели', min: 0, max: 2, step: 0.05, hint: 'насколько новые варианты могут отходить от написанных: 0 — только как вы писали, 1 — в пределах вашего разброса, 2 — смелее' },
  { key: 'slant', label: 'Наклон', min: -20, max: 20, step: 1, hint: 'градусы, плюс — вправо' },
  { key: 'letterSpacing', label: 'Между буквами', min: 0, max: 160, step: 1, hint: 'для несоединённых букв' },
  { key: 'wordSpacing', label: 'Между словами', min: 120, max: 700, step: 10, hint: 'ширина пробела' },
];

const LINES: SliderDef[] = [
  { key: 'lineJitter', label: 'Неровность строк', min: 0, max: 1, step: 0.05, hint: 'случайное расстояние между строками: 0 — ровно по линейке' },
  { key: 'sag', label: 'Просадка', min: 0, max: 1, step: 0.05, hint: 'строка уходит вниз, слова и буквы проседают ниже линии' },
];

function Slider({ s, style }: { s: SliderDef; style: Style }) {
  return (
    <label className="slider" title={s.hint}>
      <span>
        {s.label} <output>{String(style[s.key])}</output>
      </span>
      <input
        type="range"
        min={s.min}
        max={s.max}
        step={s.step}
        value={Number(style[s.key])}
        onChange={(e) => updateStyle({ [s.key]: Number(e.target.value) } as Partial<Style>)}
      />
    </label>
  );
}

function Check({ k, label, style }: { k: keyof Style; label: string; style: Style }) {
  return (
    <label className="check">
      <input type="checkbox" checked={Boolean(style[k])} onChange={(e) => updateStyle({ [k]: e.target.checked } as Partial<Style>)} />
      {label}
    </label>
  );
}

export function StylePanel() {
  const { style, building, lastBuildMs, samples, joinLow, joinHigh, derived, error } = useHandwriting();
  return (
    <>
      <section className="panel">
        <h3>Строки</h3>
        <p className="muted small">Чтобы текст не был написан «по линеечке». Видно и в редакторе, и в «Чернилах».</p>
        {LINES.map((s) => (
          <Slider key={s.key} s={s} style={style} />
        ))}
      </section>
      <section className="panel">
        <h3>Стиль почерка</h3>
        {PEN.map((s) => (
          <Slider key={s.key} s={s} style={style} />
        ))}
        <label className="slider">
          <span>Вариантов в шрифте</span>
          <select value={style.variants} onChange={(e) => updateStyle({ variants: Number(e.target.value) })}>
            {[1, 3, 5, 7, 11, 13].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Check k="connect" label="Слитное письмо (соединять по точкам входа/выхода, на двух высотах)" style={style} />
        <Check k="interpolate" label="Придумывать новые варианты по выученной модели" style={style} />
        <Check k="kerning" label="Оптический кернинг (Г, Т, У, точки — ближе)" style={style} />
        <Check k="pairs" label="Использовать записанные пары букв (ст, но…)" style={style} />
        <Check k="derive" label="Достраивать недостающие: й, ё, О, С, латиница, знаки" style={style} />
        <button className="btn small" onClick={() => updateStyle({ seed: style.seed + 1 })}>
          Перемешать случайность
        </button>
        <p className="build-status">
          {error ? (
            <span className="error">Ошибка сборки: {error}</span>
          ) : building ? (
            'Собираю шрифт…'
          ) : (
            <>
              Шрифт собран за {lastBuildMs} мс · образцов: {samples.length} · достроено: {derived.size}
              {joinLow !== null && <> · соединения: низ {joinLow}{joinHigh !== null && <>, верх {joinHigh}</>}</>}
            </>
          )}
        </p>
      </section>
    </>
  );
}
