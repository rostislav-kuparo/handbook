import type { Editor } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { INK_COLORS } from './page';
import { SIZE_STEPS } from './marks';

type Box = { left: number; top: number };

/**
 * Small panel over a text selection: letter size and pen colour for the
 * selected words or lines. The only "formatting" there is — like writing a
 * word bigger or with another pen.
 */
export function SelectionBar({ editor }: { editor: Editor | null }) {
  const [box, setBox] = useState<Box | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    if (!editor) return;
    // The bar is placed once per selection: changing the size or colour of the
    // selected text (or leaving the window and coming back) must not make it
    // jump around under the cursor. Only a new selection or scrolling moves it.
    let placedFor = '';
    let last: Box | null = null;
    let shown = false;
    const place = () => {
      const { from, to } = editor.state.selection;
      const a = editor.view.coordsAtPos(from);
      const b = editor.view.coordsAtPos(to);
      const top = Math.min(a.top, b.top) - 46;
      const left = Math.min(Math.max((Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2 - 160, 8), window.innerWidth - 330);
      last = { left, top: Math.max(top, 8) };
      setBox(last);
    };
    const update = () => {
      const { from, to, empty } = editor.state.selection;
      if (empty || editor.state.doc.textBetween(from, to).trim() === '') {
        placedFor = '';
        shown = false;
        setBox(null);
        return;
      }
      // Losing focus is handled by `hide`; an unfocused editor never brings the bar up.
      if (!shown && !editor.isFocused) return;
      const key = `${from}:${to}`;
      if (key !== placedFor) {
        placedFor = key;
        place();
      } else if (!shown) {
        setBox(last);
      }
      shown = true;
      force((n) => n + 1);
    };
    // Scrolling moves the text under a fixed bar: follow it (or forget the spot while hidden).
    const onScroll = () => {
      if (shown) place();
      else placedFor = '';
    };
    const hide = () =>
      setTimeout(() => {
        if (editor.isFocused) return;
        shown = false;
        setBox(null);
      }, 150);
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    editor.on('focus', update);
    editor.on('blur', hide);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
      editor.off('focus', update);
      editor.off('blur', hide);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [editor]);

  if (!editor || !box) return null;
  const scale = Number(editor.getAttributes('textSize').scale ?? 1) || 1;
  const step = (dir: number) => {
    const i = SIZE_STEPS.findIndex((s) => Math.abs(s - scale) < 0.01);
    const at = i < 0 ? SIZE_STEPS.indexOf(1) : i;
    const next = SIZE_STEPS[Math.min(Math.max(at + dir, 0), SIZE_STEPS.length - 1)];
    editor.chain().focus().setTextSize(next).run();
  };
  const color = editor.getAttributes('inkColor').color as string | undefined;

  return (
    <div className="selection-bar no-print" style={box} onMouseDown={(e) => e.preventDefault()}>
      <button onClick={() => step(-1)} title="Мельче">
        A−
      </button>
      <span className="selection-size" title="Размер букв">
        {Math.round(scale * 100)}%
      </span>
      <button onClick={() => step(1)} title="Крупнее">
        A+
      </button>
      <button onClick={() => editor.chain().focus().unsetTextSize().run()} title="Обычный размер" disabled={scale === 1}>
        1×
      </button>
      <span className="selection-sep" />
      {INK_COLORS.map((c) => (
        <button
          key={c.color}
          className={`swatch ${color === c.color ? 'on' : ''}`}
          style={{ ['--sw' as string]: c.color }}
          title={`${c.name} ручка`}
          onClick={() => editor.chain().focus().setInkColor(c.color).run()}
        />
      ))}
      <button onClick={() => editor.chain().focus().unsetInkColor().run()} title="Цвет документа" disabled={!color}>
        ✕
      </button>
    </div>
  );
}
