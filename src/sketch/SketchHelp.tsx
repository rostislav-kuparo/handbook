import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { copyText } from '../util/clipboard';
import { COMMANDS, FORMULA_HELP, GROUPS, localizeCode, type Command } from './commands';
import { EXAMPLES, sketchPrompt } from './prompt';
import { SketchFigure } from './SketchFigure';

type Lang = 'ru' | 'en';
const LANG_KEY = 'sketch.helpLang';

function savedLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'ru';
  } catch {
    return 'ru';
  }
}

/** Drawn only once scrolled into view: the help holds dozens of small drawings. */
function LazySketch({ code, width, fontSize }: { code: string; width: number; fontSize: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return (
    <div ref={ref} className="sketch-preview" style={{ width, minHeight: 60 }}>
      {seen && <SketchFigure code={code} width={width} fontSize={fontSize} />}
    </div>
  );
}

interface CardProps {
  cmd: Command;
  lang: Lang;
  onInsert?: (code: string) => void;
  onCopy: (code: string) => void;
}

function CommandCard({ cmd, lang, onInsert, onCopy }: CardProps) {
  const name = lang === 'ru' ? cmd.names[0] : cmd.names[1];
  const other = cmd.names.filter((n) => n !== name).join(', ');
  const example = localizeCode(cmd.example, lang);
  return (
    <div className="sketch-cmd">
      <div className="sketch-cmd-text">
        <div className="sketch-cmd-head">
          {cmd.forms.map((f) => (
            <code key={f}>{f.replace('@', name)}</code>
          ))}
          <span className="muted small">{other}</span>
        </div>
        <p>{cmd.doc.replace(/@/g, name)}</p>
        <pre className="sketch-code">{example}</pre>
        <div className="row">
          {onInsert && (
            <button className="btn small" onClick={() => onInsert(example)}>
              Вставить в чертёж
            </button>
          )}
          <button className="btn small ghost" onClick={() => onCopy(example)}>
            Копировать
          </button>
        </div>
      </div>
      <LazySketch code={example} width={190} fontSize={13} />
    </div>
  );
}

/**
 * Everything a drawing understands, with live examples in the user's hand,
 * and the request for a neural net (instructions + the task) ready to copy.
 */
export function SketchHelp({ onClose, onInsert }: { onClose: () => void; onInsert?: (code: string) => void }) {
  const [lang, setLang] = useState<Lang>(savedLang);
  const [query, setQuery] = useState('');
  const [task, setTask] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(noteTimer.current);
    };
  }, [onClose]);

  const pickLang = (l: Lang) => {
    setLang(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      // Private mode: the choice just is not remembered.
    }
  };

  const tell = (text: string) => {
    setNote(text);
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 2200);
  };
  const copy = async (text: string, what: string) => {
    tell((await copyText(text)) ? `${what} — скопировано` : 'Не получилось скопировать: выделите текст и нажмите Ctrl+C');
  };
  const insert = onInsert
    ? (code: string) => {
        onInsert(code);
        tell('Вставлено в чертёж');
      }
    : undefined;

  const q = query.trim().toLowerCase();
  const matches = (c: Command) => !q || c.names.some((n) => n.toLowerCase().includes(q)) || c.doc.toLowerCase().includes(q);

  return createPortal(
    <div className="sketch-help-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sketch-help" role="dialog" aria-modal="true" aria-label="Команды чертежа">
        <header className="sketch-help-top">
          <h2>Чертёж: все команды</h2>
          <div className="seg" role="group" aria-label="Имена команд">
            <button className={lang === 'ru' ? 'on' : ''} onClick={() => pickLang('ru')}>
              По-русски
            </button>
            <button className={lang === 'en' ? 'on' : ''} onClick={() => pickLang('en')}>
              Как в GeoGebra
            </button>
          </div>
          <button className="sketch-help-close" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </header>

        <div className="sketch-help-body">
          <section className="sketch-ai">
            <h3>Попросить нейронку</h3>
            <p className="muted">
              Опишите, что нарисовать. К описанию добавится инструкция со всеми командами и примерами — вставьте всё в ChatGPT,
              Gemini или другую нейронку. Её ответ скопируйте в «Команды» чертежа или прямо в текст документа: код между
              строками ``` сам станет чертежом, пояснения останутся текстом. Рисовать будет приложение, вашим почерком,
              поэтому чертёж выходит одинаковым, кто бы его ни написал.
            </p>
            <textarea
              value={task}
              rows={2}
              placeholder="Например: треугольник ABC с медианой AM и биссектрисой BL"
              onChange={(e) => setTask(e.target.value)}
            />
            <div className="row">
              <button className="btn small primary" onClick={() => void copy(sketchPrompt(task), 'Запрос для нейронки')}>
                Скопировать запрос
              </button>
              <button className="btn small" onClick={() => void copy(sketchPrompt(), 'Инструкция без задачи')}>
                Только инструкцию
              </button>
            </div>
            <details>
              <summary>Посмотреть, что получит нейронка</summary>
              <pre className="sketch-code prompt">{sketchPrompt(task)}</pre>
            </details>
          </section>

          <section>
            <h3>Как писать</h3>
            <ul className="sketch-rules">
              <li>
                Одна команда — одна строка. Имя можно использовать только ниже строки, где оно задано.
              </li>
              <li>
                Начертательная геометрия: точка в пространстве — <code>A = (2, 1, 3)</code>. Чертёж тогда становится эпюром:
                приложение само рисует проекции A₁ и A₂, линии связи и ось x₁₂ (ось x — влево от O, как в учебниках). Отрезки,
                прямые и многоугольники из таких точек рисуются проекциями. Профильная проекция —{' '}
                <code>{lang === 'ru' ? 'Проекции' : 'Projections'}(1, 2, 3)</code>, плоскость — треугольником{' '}
                <code>{lang === 'ru' ? 'Многоугольник' : 'Polygon'}(A, B, C)</code>.
              </li>
              <li>
                Чертёж можно написать прямо в тексте: строка <code>```</code>, ниже команды, и снова строка <code>```</code>{' '}
                (в русской раскладке та же клавиша даёт <code>ёёё</code> — так тоже можно). Как только закрыта последняя
                строка, на этом месте появится чертёж; Backspace сразу после вернёт текст. Для старого текста — «Вставить
                блок» → «Найти чертежи в тексте».
              </li>
              <li>
                Точка: <code>A = (2, 3)</code>. Дробные числа — через точку <code>(2.5, 3)</code>, или через запятую, если
                координаты разделены точкой с запятой: <code>(2,5; 3)</code>.
              </li>
              <li>
                График: <code>f(x) = x^2 - 1</code> или <code>y = 2x + 1</code>. Вертикальная прямая: <code>x = 3</code>.
                Число: <code>r = 2</code>, дальше <code>{lang === 'ru' ? 'Окружность' : 'Circle'}(A, r)</code>.
              </li>
              <li>
                Имена с индексом и штрихом: <code>A_1</code>, <code>A_{'{12}'}</code>, <code>A'</code> — подписи выйдут A₁, A₁₂, A′.
                Русская «А» и латинская «A» — одна и та же точка.
              </li>
              <li>
                Команды пишутся по-русски или по-английски: <code>Отрезок(A, B)</code> и <code>Segment(A, B)</code> — одно и то
                же. Комментарий — после <code>#</code>.
              </li>
              <li>
                Строку с ошибкой чертёж пропускает и показывает, что не так; остальное рисуется. Экранные команды GeoGebra
                (SetPointStyle, SetDecoration и подобные) пропускаются молча. Старая запись со скобками <code>Segment[A, B]</code>{' '}
                тоже понимается.
              </li>
            </ul>
          </section>

          <input
            className="sketch-search"
            type="search"
            placeholder="Найти команду: отрезок, circle, пересечение…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {GROUPS.map((group) => {
            const list = COMMANDS.filter((c) => c.group === group.id && matches(c));
            if (!list.length) return null;
            return (
              <section key={group.id}>
                <h3>{group.name}</h3>
                {list.map((cmd) => (
                  <CommandCard key={cmd.names[1]} cmd={cmd} lang={lang} onInsert={insert} onCopy={(c) => void copy(c, 'Пример')} />
                ))}
              </section>
            );
          })}

          {!q && (
            <section>
              <h3>Числа и формулы</h3>
              <dl className="sketch-formulas">
                {FORMULA_HELP.map((f) => (
                  <div key={f.code}>
                    <dt>
                      <code>{f.code}</code>
                    </dt>
                    <dd>{f.doc}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {!q && (
            <section>
              <h3>Примеры целиком</h3>
              {EXAMPLES.map((ex) => {
                const code = localizeCode(ex.code, lang);
                return (
                  <div key={ex.title} className="sketch-cmd">
                    <div className="sketch-cmd-text">
                      <div className="sketch-cmd-head">
                        <strong>{ex.title}</strong>
                      </div>
                      <p className="muted">Задача: {ex.task}</p>
                      <pre className="sketch-code">{code}</pre>
                      <div className="row">
                        {insert && (
                          <button className="btn small" onClick={() => insert(code)}>
                            Вставить в чертёж
                          </button>
                        )}
                        <button className="btn small ghost" onClick={() => void copy(code, 'Пример')}>
                          Копировать
                        </button>
                      </div>
                    </div>
                    <LazySketch code={code} width={260} fontSize={15} />
                  </div>
                );
              })}
            </section>
          )}
        </div>
        {note && <div className="sketch-help-note">{note}</div>}
      </div>
    </div>,
    document.body,
  );
}
