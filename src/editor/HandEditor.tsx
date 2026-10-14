import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Dropcursor, Gapcursor, Placeholder, UndoRedo } from '@tiptap/extensions';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { HtmlBlock } from '../blocks/HtmlBlock';
import { getHandwriting, hasGlyph, useHandwriting } from '../engine/handwriting';
import type { DocContent, HandDocument } from '../model/types';
import { HandLayout } from './handLayout';
import { InkColor, Script, TextSize } from './marks';
import { MathText } from './mathText';
import type { Geometry } from './page';
import { SelectionBar } from './SelectionBar';
import { Pagination, remeasure } from './pagination';
import { docSeed } from './layout';
import { MissingGlyphPopover } from './MissingGlyphPopover';
import { MissingGlyphs, missingGlyphsKey } from './missingGlyphs';

interface Props {
  doc: HandDocument;
  /** Font size in px: a change moves every line, so pages are re-measured. */
  fontSize: number;
  /** Sheet geometry (margins) for page breaks. */
  geo: Geometry;
  onChange: (content: DocContent) => void;
  onEditor: (editor: Editor | null) => void;
  /** Number of A4 sheets the text needs. */
  onPages: (pages: number) => void;
}

/**
 * The writing surface. The schema has only paragraphs, plain text and HTML
 * blocks — no bold, headings or lists — so formatting is impossible even when
 * pasting from Word: ProseMirror drops anything the schema does not know.
 * What a hand can do stays: bigger letters, another pen, indices in formulas.
 */
export function HandEditor({ doc, fontSize, geo, onChange, onEditor, onPages }: Props) {
  const onPagesRef = useRef(onPages);
  onPagesRef.current = onPages;
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const [missing, setMissing] = useState<{ char: string; rect: DOMRect } | null>(null);
  const { byChar, derived, fontVersion, style } = useHandwriting();

  const editor = useEditor(
    {
      extensions: [
        Document,
        Paragraph,
        Text,
        UndoRedo,
        Dropcursor.configure({ color: '#e0523f', width: 2 }),
        Gapcursor,
        Placeholder.configure({ placeholder: 'Пишите… (недостающие буквы подчёркнуты — по клику их можно дописать)' }),
        HtmlBlock,
        MissingGlyphs.configure({
          hasGlyph,
          onMissingClick: (char, rect) => setMissing({ char, rect }),
        }),
        TextSize,
        InkColor,
        Script,
        MathText,
        Pagination.configure({ onPages: (n) => onPagesRef.current(n), getGeometry: () => geoRef.current }),
        HandLayout.configure({
          getParams: () => {
            const s = getHandwriting().style;
            return { sag: s.sag, lineJitter: s.lineJitter, seed: (docSeed(doc.id) ^ s.seed) >>> 0 };
          },
        }),
      ],
      content: doc.content,
      editorProps: { attributes: { class: 'hand-text', spellcheck: 'false', 'aria-label': 'Текст документа' } },
      onUpdate: ({ editor }) => onChange(editor.getJSON() as DocContent),
    },
    [doc.id],
  );

  useEffect(() => {
    onEditor(editor);
    return () => onEditor(null);
  }, [editor, onEditor]);

  // The set of written letters changed: refresh the "missing" underlines.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(missingGlyphsKey, true));
  }, [byChar, derived, editor]);

  // Font rebuilt, size or line style changed: the text moved, measure lines and pages again.
  useEffect(() => {
    if (editor && !editor.isDestroyed) remeasure(editor.view);
  }, [fontVersion, fontSize, geo, style.sag, style.lineJitter, style.seed, editor]);

  return (
    <>
      <EditorContent editor={editor} />
      <SelectionBar editor={editor} />
      {missing && <MissingGlyphPopover char={missing.char} rect={missing.rect} onClose={() => setMissing(null)} />}
    </>
  );
}
