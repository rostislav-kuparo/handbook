import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { basicSetup, EditorView } from 'codemirror';
import { useEffect, useRef } from 'react';

interface Props {
  value: string;
  language: 'html' | 'json' | 'plain';
  onChange: (value: string) => void;
  /** Ctrl+Enter */
  onSubmit?: () => void;
  /** Selects this line (1-based) and scrolls to it; a new object selects it again. */
  goTo?: { line: number };
}

/** Thin CodeMirror 6 wrapper. Uncontrolled after mount; `value` changes from outside are synced in. */
export function CodeEditor({ value, language, onChange, onSubmit, goTo }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const cbRef = useRef({ onChange, onSubmit });
  cbRef.current = { onChange, onSubmit };

  useEffect(() => {
    const view = new EditorView({
      doc: value,
      parent: hostRef.current!,
      extensions: [
        basicSetup,
        language === 'html' ? html() : language === 'json' ? json() : [],
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cbRef.current.onChange(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          keydown: (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              cbRef.current.onSubmit?.();
              return true;
            }
            return false;
          },
        }),
      ],
    });
    viewRef.current = view;
    return () => view.destroy();
  }, [language]);

  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !goTo) return;
    const line = view.state.doc.line(Math.min(Math.max(Math.round(goTo.line), 1), view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
    view.focus();
  }, [goTo]);

  return <div className="code-editor" ref={hostRef} />;
}
