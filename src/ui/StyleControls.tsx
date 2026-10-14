import { updateStyle } from '../engine/handwriting';
import { Style } from '../model/types';

export interface SliderDef {
  key: keyof Style;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}

/** A style slider: label, current value and the range; saves on every move. */
export function Slider({ s, style }: { s: SliderDef; style: Style }) {
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

export function Check({ k, label, style }: { k: keyof Style; label: string; style: Style }) {
  return (
    <label className="check">
      <input type="checkbox" checked={Boolean(style[k])} onChange={(e) => updateStyle({ [k]: e.target.checked } as Partial<Style>)} />
      {label}
    </label>
  );
}
