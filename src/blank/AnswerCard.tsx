// What a pasted answer did: the tasks laid out, what went wrong (with a
// request to mend it), and how the net read the printed points — those are
// shown on the blank too while the card is open.
import { useState } from 'react';
import { MM } from '../editor/page';
import { copyText } from '../util/clipboard';
import type { AnswerReport } from './answerPaste';
import { fixPrompt } from './prompt';

const sub = (name: string) => name.replace(/_\{?([^}]*)\}?/, (_, i: string) => [...i].map((c) => '₀₁₂₃₄₅₆₇₈₉'[Number(c)] ?? c).join(''));

export function AnswerCard({ report, onClose }: { report: AnswerReport; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const byTask = report.tasks.map((t) => ({ task: t, names: report.names.filter((n) => n.task === t), problems: report.problems.filter((p) => p.task === t) }));
  const other = report.problems.filter((p) => !report.tasks.includes(p.task));
  return (
    <div className="answer-card float no-print" role="status">
      <header>
        <strong>{report.tasks.length ? `Нейронка заполнила: ${report.tasks.join(', ')}` : 'Ответ не разложился'}</strong>
        <button className="link-btn" onClick={onClose} aria-label="Закрыть">
          ✕
        </button>
      </header>
      <p className="muted small">
        Блоков: {report.blocks}. {report.problems.length ? `Ошибок: ${report.problems.length}.` : 'Ошибок нет.'} Ctrl+Z убирает всю вставку.
      </p>
      <ul>
        {byTask.map((t) => (
          <li key={t.task}>
            <b>{t.task}</b>
            {t.names.length > 0 && <span className="muted small"> {t.names.map((n) => `${sub(n.name)} = @${n.mark}`).join(', ')}</span>}
            {t.problems.map((p, i) => (
              <div key={i} className="answer-problem small">
                ⚠ {p.text}
              </div>
            ))}
          </li>
        ))}
        {other.map((p, i) => (
          <li key={`o${i}`} className="answer-problem small">
            ⚠ {p.text}
          </li>
        ))}
      </ul>
      {report.names.length > 0 && <p className="muted small">На бланке подписано, какую точку как назвала нейронка: проверьте, совпадает ли с печатью.</p>}
      {report.problems.length > 0 && (
        <button
          className="btn small primary"
          onClick={() => void copyText(fixPrompt(report.problems)).then((ok) => setCopied(ok))}
          title="Короткий запрос с ошибками — вставить в тот же чат; ответ снова Ctrl+V"
        >
          {copied ? 'Скопировано ✓' : 'Попросить исправить'}
        </button>
      )}
    </div>
  );
}

/** The names the net gave to printed points, over the blank (sheet px from the sheet's corner). */
export function AnswerNames({ report }: { report: AnswerReport }) {
  return (
    <div className="answer-names no-print">
      {report.names.map((n, i) => (
        <span key={i} className="answer-name" style={{ left: n.x * MM, top: n.y * MM }}>
          {sub(n.name)}
        </span>
      ))}
    </div>
  );
}
