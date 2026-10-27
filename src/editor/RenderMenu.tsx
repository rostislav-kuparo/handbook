import { SlidersIcon } from '../ui/icons';
import { RenderSettings } from './RenderSettings';

/** Settings of how the text is drawn, next to the «Отрендерить» button. */
export function RenderMenu() {
  return (
    <details className="menu">
      <summary className="rail-btn" title="Настройки рендера: строки, интервалы, соединения" aria-label="Настройки рендера">
        <SlidersIcon />
      </summary>
      <div className="menu-items render-menu">
        <RenderSettings />
      </div>
    </details>
  );
}
