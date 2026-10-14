import { RenderSettings } from './RenderSettings';

/** Settings of how the text is drawn, attached to the «Отрендерить» button. */
export function RenderMenu() {
  return (
    <details className="menu right">
      <summary className="btn render-settings-btn" title="Настройки рендера: строки, перо, наклон, интервалы">
        ⚙
      </summary>
      <div className="menu-items render-menu">
        <RenderSettings />
      </div>
    </details>
  );
}
