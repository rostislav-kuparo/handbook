import { useEffect, useMemo, useRef, useState } from 'react';
import { CodeEditor } from '../blocks/CodeEditor';
import { sketchErrors } from './render';

/** What the pipette over a blank takes: a printed point, the drawing's origin, a point in space by its projections. */
export type PickKind = 'point' | 'origin' | 'space';

interface Props {
  code: string;
  onChange: (code: string) => void;
  onHelp: () => void;
  /** On a blank: take points off it with the pipette. */
  onPick?: (kind: PickKind) => void;
}

/** The commands of a drawing: typed or pasted from a neural net, applied as you type. */
export function SketchPanel({ code, onChange, onHelp, onPick }: Props) {
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
  const [goTo, setGoTo] = useState<{ line: number }>();

  return (
    <>
      <CodeEditor value={draft} language="plain" onChange={edit} goTo={goTo} />
      {errors.length > 0 ? (
        <ul className="sketch-errors">
          {errors.slice(0, 8).map((e) => (
            <li key={`${e.line}:${e.message}`} onClick={() => setGoTo({ line: e.line })} title="Показать строку">
              <b>Строка {e.line}:</b> {e.message}
            </li>
          ))}
          {errors.length > 8 && <li>…и ещё {errors.length - 8}</li>}
        </ul>
      ) : null}
      {onPick && (
        <div className="row sketch-pick">
          <span className="muted small">С бланка:</span>
          <button className="btn small" onClick={() => onPick('point')} title="Щелчок по напечатанной точке записывает её в команды (A_1 = (…), Скрыть(A_1))">
            ⌖ Точка
          </button>
          <button className="btn small" onClick={() => onPick('space')} title="Точка в пространстве: щелчок по фронтальной проекции, потом по горизонтальной — A = (x, y, z)">
            ⌖ По проекциям
          </button>
          <button className="btn small" onClick={() => onPick('origin')} title="Начало координат чертежа — точка бланка (обычно 0 на оси x₁₂): НаБланке(x, y)">
            ⌖ Начало
          </button>
        </div>
      )}
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
