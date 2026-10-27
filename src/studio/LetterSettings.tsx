import { useHandwriting } from '../engine/handwriting';
import { Check, Slider, type SliderDef } from '../ui/StyleControls';

/** What changes the letters themselves: you see it right here, on the letters you write. */
const LETTERS: SliderDef[] = [
  { key: 'weight', label: 'Толщина пера', min: 18, max: 120, step: 1, hint: 'в единицах шрифта (1000 = кегль)' },
  { key: 'pressure', label: 'Нажим', min: 0, max: 1, step: 0.05, hint: 'насколько давление меняет толщину' },
  { key: 'jitter', label: 'Живость', min: 0, max: 1.5, step: 0.05, hint: 'случайные отличия каждой буквы' },
  { key: 'fantasy', label: 'Фантазия модели', min: 0, max: 2, step: 0.05, hint: 'насколько новые варианты могут отходить от написанных: 0 — только как вы писали, 1 — в пределах вашего разброса, 2 — смелее' },
  { key: 'slant', label: 'Наклон', min: -20, max: 20, step: 1, hint: 'градусы, плюс — вправо' },
];

/** Shape of the letters: pen, slant, the learned model. Lives in the handwriting studio. */
export function LetterSettings() {
  const { style, building, lastBuildMs, samples, joinLow, joinHigh, derived, error } = useHandwriting();
  return (
    <section className="panel float">
      <h3>Стиль букв</h3>
      {LETTERS.map((s) => (
        <Slider key={s.key} s={s} style={style} />
      ))}
      <Check k="interpolate" label="Придумывать новые варианты по выученной модели" style={style} />
      <Check k="derive" label="Достраивать недостающие: й, ё, О, С, латиница, знаки" style={style} />
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
  );
}
