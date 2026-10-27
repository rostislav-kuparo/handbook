import type { Editor } from '@tiptap/react';
import { useState } from 'react';
import { openHelp } from '../shell/HelpDialogs';
import { DrawPenPicker } from '../sketch/DrawPenPicker';
import { DrawingIcon } from '../ui/icons';
import type { PageSetup } from './page';
import { countSketchFences } from './sketchFences';

interface Props {
  editor: Editor | null;
  /** The rendered view is on: nothing can be inserted. */
  ink: boolean;
  setup: PageSetup;
  onChange: (next: PageSetup) => void;
}

const close = (el: HTMLElement) => el.closest('details')?.removeAttribute('open');

/** Everything about drawings: insert one, turn ``` commands into drawings, the help, and the pen they are drawn with. */
export function SketchMenu({ editor, ink, setup, onChange }: Props) {
  /** Drawings still sitting in the text as ```…```, counted when the menu opens. */
  const [fences, setFences] = useState(0);
  return (
    <details
      className="menu"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && editor) setFences(countSketchFences(editor.state.doc));
      }}
    >
      <summary className="rail-btn" title="Чертежи" aria-label="Чертежи">
        <DrawingIcon />
      </summary>
      <div className="menu-items sketch-menu">
        <button
          disabled={ink || !editor}
          onClick={(e) => {
            close(e.currentTarget);
            editor?.chain().focus().insertHtmlBlock({ kind: 'sketch', title: 'Чертёж', code: '' }).run();
          }}
        >
          <strong>Вставить чертёж</strong>
          <span className="muted small">командами GeoGebra, вашим почерком</span>
        </button>
        <button
          disabled={ink || !editor || fences === 0}
          onClick={(e) => {
            close(e.currentTarget);
            editor?.chain().focus().convertSketchFences().run();
          }}
        >
          <strong>Найти чертежи в тексте{fences > 0 ? ` (${fences})` : ''}</strong>
          <span className="muted small">команды между ``` или ёёё</span>
        </button>
        <button
          onClick={(e) => {
            close(e.currentTarget);
            openHelp('sketch');
          }}
        >
          <strong>Команды и запрос для нейронки</strong>
        </button>
        <div className="sketch-menu-pen">
          <span className="menu-label">Линии чертежей</span>
          <DrawPenPicker value={setup.drawPen} textInk={setup.ink} onChange={(drawPen) => onChange({ ...setup, drawPen })} />
        </div>
      </div>
    </details>
  );
}
