import { useEffect, useMemo, useRef, useState } from 'react';
import { CodeEditor } from '../blocks/CodeEditor';
import { sketchErrors } from './render';

interface Props {
  code: string;
  onChange: (code: string) => void;
  onHelp: () => void;
}

/** The commands of a drawing: typed or pasted from a neural net, applied as you type. */
export function SketchPanel({ code, onChange, onHelp }: Props) {
  const [draft, setDraft] = useState(code);
  const sent = useRef(code);
  const timer = useRef<number | undefined>(undefined);

  // Changed from outside: undo/redo, «Вставить» in the help.
  useEffect(() => {
    if (code !== sent.current) {
      sent.current = code;
      setDraft(code);
    }
  }, [code]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const edit = (text: string) => {
    setDraft(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      sent.current = text;
      onChange(text);
    }, 300);
  };

  const errors = useMemo(() => sketchErrors(draft), [draft]);

  return (
    <>
      <CodeEditor value={draft} language="plain" onChange={edit} />
      {errors.length > 0 ? (
        <ul className="sketch-errors">
          {errors.slice(0, 8).map((e) => (
            <li key={`${e.line}:${e.message}`}>
              <b>Строка {e.line}:</b> {e.message}
            </li>
          ))}
          {errors.length > 8 && <li>…и ещё {errors.length - 8}</li>}
        </ul>
      ) : null}
      <div className="row">
        <button className="btn small primary" onClick={onHelp}>
          Все команды и запрос для нейронки
        </button>
        <span className="muted small">
          {errors.length
            ? 'Строки с ошибками пропущены, остальное нарисовано.'
            : 'Чертёж обновляется сразу. Ответ нейронки вставляйте целиком, строки ``` не мешают.'}
        </span>
      </div>
    </>
  );
}
