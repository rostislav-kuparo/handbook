import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import pkg from '../../package.json';
import { copyText } from '../util/clipboard';

export type HelpId = 'letters' | 'keys' | 'about';

const REPO = 'https://github.com/rostislav-kuparo/handbook';

/** Fired on window to open a help page of the «Информация» menu (or the drawing help). */
export const HELP_EVENT = 'handbook:help';
export const openHelp = (which: HelpId | 'sketch') => window.dispatchEvent(new CustomEvent(HELP_EVENT, { detail: which }));

function Dialog({ title, onClose, children, narrow }: { title: string; onClose: () => void; children: ReactNode; narrow?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="sketch-help-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sketch-help help-dialog ${narrow ? 'narrow' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="sketch-help-top">
          <h2>{title}</h2>
          <button className="sketch-help-close" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </header>
        <div className="sketch-help-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** The hints that used to stand over the handwriting studio. */
function LettersHelp() {
  return (
    <>
      <section>
        <h3>Строчные и прописные</h3>
        <p>
          Строчная пишется между «строкой» и «строчными», хвосты (д, у, р) — до «хвостов». Подводящий штрих от строки
          слева и хвостик вправо в конце — это точки входа и выхода для слитного письма.
        </p>
        <p>
          Прописная — до линии «прописные». Чтобы она <b>соединялась</b> со следующей буквой, напишите соединяющий штрих{' '}
          <b>последним</b> и закончите его хвостиком справа у линии строки (или на высоте строчных). Тогда кружок выхода
          станет зелёным. Г, П, Т, Ф обычно не соединяются — это нормально.
        </p>
        <p>Пишите сколько угодно вариантов: каждый делает почерк живее.</p>
      </section>
      <section>
        <h3>Пары букв</h3>
        <p>
          Пара пишется <b>одним движением</b>, как в слове: целиком, с соединением между буквами. В тексте пара заменит
          отдельные буквы и даст естественную связку. Свою пару можно добавить полем «своя пара» под парами.
        </p>
      </section>
      <section>
        <h3>Точки входа и выхода</h3>
        <p>
          Кружки на вариантах — точки входа и выхода. Зелёный — буква соединяется с соседней в этой точке (у строки или на
          высоте строчных). Жёлтый — соединение включено, но точка не на краю буквы, поэтому оно не сработает. Клик
          переключает, а если точка встала не туда — перетащите кружок: он встанет на ближайший конец штриха.
        </p>
        <p>
          Вариант без входа пишется в начале слова, с входом и выходом — в середине, без выхода — в конце, без того и
          другого — отдельно (одна буква, формулы, индексы, сокращения). Если вариантов нужного вида меньше трёх, берутся
          и другие: у них обрезается подводка или хвост. Варианты чередуются: один и тот же не встанет дважды подряд и
          вернётся, только когда пройдёт хотя бы половина остальных.
        </p>
      </section>
      <section>
        <h3>Напиши фразу</h3>
        <p>
          Напишите слово целиком, как обычно — слитно. Прописную в начале тоже можно: так запишется её соединение. Слово и
          регистр выбираются случайно, чаще — с буквами, у которых ещё меньше трёх вариантов.
        </p>
        <p>
          После «Разметить буквы» двигайте границы за нижний кружок и наклоняйте за верхний — так, чтобы каждая буква была
          своего цвета. Место разреза станет точкой соединения. В наборе «Формулы» каждый знак — отдельная «буква»,
          индексы потом получатся из обычных цифр.
        </p>
      </section>
      <section>
        <h3>Алфавит</h3>
        <p>
          Пилюли внизу алфавита: <b>аа / АА</b> — строчные или прописные, <b>Кир / Lat / ∑</b> — кириллица, латиница или
          цифры, знаки и формулы. В «Ещё символах» — знаки, которые программа умеет вставлять (меню «Формулы», формулы
          LaTeX, скобки), и те, что вы дописали прямо в тексте. Пунктирная клетка — знака ещё нет, точками — он собран
          автоматически. Стрелки ← → открывают соседнюю букву.
        </p>
        <p>
          «Модель» у буквы — сколько направлений изменчивости вашего письма выучил движок: новые варианты берутся из этого
          разброса, а «Фантазия модели» в «Стиле букв» задаёт, насколько смело.
        </p>
      </section>
    </>
  );
}

function KeysHelp() {
  const rows: [string, string][] = [
    ['Ctrl+N', 'новый документ'],
    ['Ctrl+O', 'открыть документ, почерк или резервную копию (.json)'],
    ['Ctrl+P', 'печать / PDF'],
    ['Ctrl+,  Ctrl+.', 'нижний и верхний индекс'],
    ['← →', '«Почерк»: соседняя буква'],
    ['Enter', '«Почерк»: сохранить вариант'],
    ['Esc', '«Почерк»: очистить лист'],
    ['Ctrl+Z', '«Почерк»: отменить штрих'],
  ];
  return (
    <>
      <section>
        <h3>Клавиши</h3>
        <dl className="sketch-formulas">
          {rows.map(([k, what]) => (
            <div key={k}>
              <dt>
                <code>{k}</code>
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <h3>Формулы</h3>
        <p>
          Формулы из ChatGPT, Gemini, Википедии вставляются сразу рукописными: <code>$f_1$</code> → f₁. Можно и набрать:{' '}
          <code>$\Pi_1$</code> превратится в Π₁, как только закроете знаком <code>$</code>; Backspace сразу после вернёт
          исходный текст. Формулы, которые уже лежат в документе, переводит кнопка «Распознать формулы $…$» в меню Σ.
        </p>
      </section>
      <section>
        <h3>Чертежи</h3>
        <p>
          Строка <code>```</code> (или <code>ёёё</code>), ниже команды и снова <code>```</code> — кусок станет чертежом.
          Так же срабатывает вставка ответа нейронки целиком. Для уже написанного — «Найти чертежи в тексте» в меню
          чертежей.
        </p>
      </section>
    </>
  );
}

function About() {
  const [copied, setCopied] = useState(false);
  return (
    <section className="about">
      <p className="about-name">
        Handbook <span className="muted">{pkg.version}</span>
      </p>
      <p>Текстовый редактор, который пишет вашим почерком.</p>
      <p className="muted">
        Почерк, документы и настройки хранятся только на этом компьютере. Чтобы перенести их, сохраните «Файл → Резервная
        копия всего», а на новом месте откройте её через «Файл → Открыть…».
      </p>
      <div className="row">
        <code>{REPO}</code>
        <button className="btn small" onClick={() => void copyText(REPO).then(setCopied)}>
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
    </section>
  );
}

export function HelpDialog({ which, onClose }: { which: HelpId; onClose: () => void }) {
  if (which === 'letters')
    return (
      <Dialog title="Как писать буквы" onClose={onClose}>
        <LettersHelp />
      </Dialog>
    );
  if (which === 'keys')
    return (
      <Dialog title="Горячие клавиши и формулы" onClose={onClose}>
        <KeysHelp />
      </Dialog>
    );
  return (
    <Dialog title="О программе" onClose={onClose} narrow>
      <About />
    </Dialog>
  );
}
