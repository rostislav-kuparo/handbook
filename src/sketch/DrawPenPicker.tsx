import type { DrawPen } from '../editor/page';
import { GRAPHITE } from './render';

/** Colours for drawings; null is «auto»: the text's ink for a pen, graphite for a pencil. */
const COLORS: { name: string; color: string }[] = [
  { name: 'Графит', color: GRAPHITE },
  { name: 'Тёмно-синий', color: '#1f2a6b' },
  { name: 'Чёрный', color: '#1b1c20' },
  { name: 'Красный', color: '#b3261e' },
  { name: 'Зелёный', color: '#2e6b3a' },
];

interface Props {
  value: DrawPen;
  onChange: (next: DrawPen) => void;
  /** The document's ink: what «auto» means for a pen. */
  textInk: string;
}

/** Pen or pencil, its colour, and whether labels stay in the text's pen. */
export function DrawPenPicker({ value, onChange, textInk }: Props) {
  const pencil = value.tool === 'pencil';
  const known = value.color === null || COLORS.some((c) => c.color === value.color);
  return (
    <div className="draw-pen">
      <div className="segmented" role="group" aria-label="Чем рисовать">
        <button className={!pencil ? 'on' : ''} onClick={() => onChange({ ...value, tool: 'pen' })} title="Ровная линия чернилами">
          ✒ Ручка
        </button>
        <button className={pencil ? 'on' : ''} onClick={() => onChange({ ...value, tool: 'pencil' })} title="Тонкая серая линия с зерном бумаги">
          ✎ Карандаш
        </button>
      </div>
      <div className="swatches" role="group" aria-label="Цвет линий">
        <button
          className={`swatch auto ${value.color === null ? 'on' : ''}`}
          style={{ ['--sw' as string]: pencil ? GRAPHITE : textInk }}
          title={pencil ? 'Как обычный карандаш (графит)' : 'Как текст'}
          aria-label={pencil ? 'Графит' : 'Как текст'}
          onClick={() => onChange({ ...value, color: null })}
        />
        {COLORS.filter((c) => !(pencil && c.color === GRAPHITE)).map((c) => (
          <button
            key={c.color}
            className={`swatch ${value.color === c.color ? 'on' : ''}`}
            style={{ ['--sw' as string]: c.color }}
            title={c.name}
            aria-label={c.name}
            onClick={() => onChange({ ...value, color: c.color })}
          />
        ))}
        <label className={`swatch custom ${known ? '' : 'on'}`} title="Свой цвет">
          <input type="color" value={value.color ?? (pencil ? GRAPHITE : textInk)} onChange={(e) => onChange({ ...value, color: e.target.value })} />
        </label>
      </div>
      {pencil && (
        <label className="check inline small">
          <input type="checkbox" checked={value.labelsInPen} onChange={(e) => onChange({ ...value, labelsInPen: e.target.checked })} />
          Подписи — ручкой, как текст
        </label>
      )}
    </div>
  );
}
