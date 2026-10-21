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
}

/** Thin CodeMirror 6 wrapper. Uncontrolled after mount; `value` changes from outside are synced in. */
export function CodeEditor({ value, language, onChange, onSubmit }: Props) {
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

  return <div className="code-editor" ref={hostRef} />;
}
