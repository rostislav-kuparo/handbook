import { useEditorState, type Editor } from '@tiptap/react';
import { useState } from 'react';
import { HAND_FONT_STACK } from '../engine/constants';
import { hasGlyph } from '../engine/handwriting';
import { SYMBOL_GROUPS } from '../model/symbols';
import { SigmaIcon } from '../ui/icons';
import { countRawMath } from './mathText';

/**
 * Formulas: indices (x₁, x²), Greek letters and math signs in the user's own
 * hand, and a converter for LaTeX already sitting in the text ($f_1$ → f₁).
 */
export function SymbolsMenu({ editor, disabled }: { editor: Editor | null; disabled: boolean }) {
  const [raw, setRaw] = useState(0);
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      sub: !!e?.isActive('script', { kind: 'sub' }),
      sup: !!e?.isActive('script', { kind: 'sup' }),
    }),
  }) ?? { sub: false, sup: false };

  // Typed with the marks at the cursor (ink colour, size, an index being written).
  const insert = (ch: string) =>
    editor
      ?.chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(ch);
        return true;
      })
      .run();

  return (
    <details
      className="menu"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && editor) setRaw(countRawMath(editor.state.doc));
      }}
    >
      <summary className="rail-btn" title="Формулы" aria-label="Формулы">
        <SigmaIcon />
      </summary>
      <div className="menu-items symbols-menu">
        <div className="symbols-row">
          <span className="symbols-label">Индекс</span>
          <button
            className={`symbol-btn wide ${active.sub ? 'on' : ''}`}
            disabled={disabled}
            title="Нижний индекс (Ctrl+,)"
            onClick={() => editor?.chain().focus().toggleScript('sub').run()}
          >
            x<sub>2</sub>
          </button>
          <button
            className={`symbol-btn wide ${active.sup ? 'on' : ''}`}
            disabled={disabled}
            title="Верхний индекс (Ctrl+.)"
            onClick={() => editor?.chain().focus().toggleScript('sup').run()}
          >
            x<sup>2</sup>
          </button>
        </div>
        {SYMBOL_GROUPS.map((g) => (
          <div key={g.name} className="symbols-row">
            <span className="symbols-label">{g.name}</span>
            <div className="symbols-grid">
              {[...g.chars].map((ch) => (
                <button
                  key={ch}
                  className={`symbol-btn ${hasGlyph(ch) ? '' : 'unwritten'}`}
                  style={{ fontFamily: HAND_FONT_STACK }}
                  disabled={disabled}
                  title={hasGlyph(ch) ? ch : `${ch} — ещё не написан вашей рукой (можно дописать по клику в тексте)`}
                  onClick={() => insert(ch)}
                >
                  {ch}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="symbols-foot">
          <button
            className="btn small"
            disabled={disabled || raw === 0}
            onClick={() => {
              editor?.chain().focus().convertMathInDocument().run();
              setRaw(0);
            }}
          >
            Распознать формулы $…$ {raw > 0 ? `(${raw})` : ''}
          </button>
        </div>
      </div>
    </details>
  );
}
