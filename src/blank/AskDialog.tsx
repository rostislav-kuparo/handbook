// «Спросить нейронку»: the blank marked up for a chat, and the request to go
// with it. The marks can be put right first: a click on the picture adds a
// point there (sticking to the printing) or takes away the one clicked.
import { useEffect, useRef, useState } from 'react';
import { MM } from '../editor/page';
import { db, getSetting, setSetting } from '../storage/db';
import { copyText } from '../util/clipboard';
import { saveFile } from '../util/download';
import { blankSheet, type Blank, type BlankMark } from './blank';
import { findMarks, freeAreas, markAt, markedPicture, markMm, marksOf, sortMarks, type Area } from './marks';
import { blankPrompt, DEFAULT_ASK, type AskChoice } from './prompt';
import { snapper } from './snap';

const ASK_KEY = 'blank.ask';

export function AskDialog({ blank, onClose }: { blank: Blank; onClose: () => void }) {
  const [marks, setMarks] = useState<BlankMark[] | null>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [picture, setPicture] = useState<{ blob: Blob; url: string } | null>(null);
  const [ask, setAsk] = useState<AskChoice>(DEFAULT_ASK);
  const [busy, setBusy] = useState<string | null>('Ищу точки на бланке…');
  const [note, setNote] = useState<string | null>(null);
  const sheet = blankSheet(blank);
  const marksRef = useRef<BlankMark[] | null>(null);
  marksRef.current = marks;

  useEffect(() => {
    void getSetting<Partial<AskChoice>>(ASK_KEY, {}).then((a) => setAsk({ ...DEFAULT_ASK, ...a, tasks: '', wishes: '' }));
    void (async () => {
      setAreas(await freeAreas(blank));
      setMarks(await marksOf(blank, (m) => void db.blanks.update(blank.id, { marks: m })));
    })().catch((err) => setNote(`Не удалось разметить бланк: ${String(err)}`));
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [blank.id]);

  // The picture's memory is given back when the dialog closes.
  const pictureUrl = useRef<string | null>(null);
  pictureUrl.current = picture?.url ?? null;
  useEffect(
    () => () => {
      if (pictureUrl.current) URL.revokeObjectURL(pictureUrl.current);
    },
    [],
  );

  // The picture with the marks as they are now.
  useEffect(() => {
    if (!marks) return;
    let alive = true;
    setBusy('Рисую разметку…');
    void markedPicture(blank, marks, areas)
      .then((blob) => {
        if (!alive) return;
        setPicture((old) => {
          if (old) URL.revokeObjectURL(old.url);
          return { blob, url: URL.createObjectURL(blob) };
        });
      })
      .catch((err) => setNote(String(err)))
      .finally(() => alive && setBusy(null));
    return () => {
      alive = false;
    };
  }, [marks, areas]);

  const keep = (next: BlankMark[]) => {
    const sorted = sortMarks(blank, next);
    setMarks(sorted);
    void db.blanks.update(blank.id, { marks: sorted });
  };
  const changeAsk = (patch: Partial<AskChoice>) => {
    const next = { ...ask, ...patch };
    setAsk(next);
    void setSetting(ASK_KEY, { variant: next.variant, name: next.name });
  };

  /** A click on the picture: the mark there goes, or a new one is put (where the printing has a point). */
  const clickPicture = async (e: React.MouseEvent<HTMLImageElement>) => {
    const list = marksRef.current;
    if (!list) return;
    const r = e.currentTarget.getBoundingClientRect();
    const at = { x: ((e.clientX - r.left) / r.width) * (sheet.w / MM), y: ((e.clientY - r.top) / r.height) * (sheet.h / MM) };
    const near = list.findIndex((m) => {
      const p = markMm(blank, m, sheet);
      return Math.hypot(p.x - at.x, p.y - at.y) < 2.5;
    });
    if (near >= 0) {
      keep(list.filter((_, i) => i !== near));
      setNote(`Метка @${near + 1} убрана. Номера после неё сдвинулись.`);
      return;
    }
    const snap = await snapper(blank);
    const p = e.altKey ? { x: at.x * MM, y: at.y * MM, kind: 'free' as const } : snap(at.x * MM, at.y * MM, sheet);
    keep([...list, markAt(blank, { x: p.x / MM, y: p.y / MM }, p.kind, sheet)]);
    setNote('Метка добавлена. Номера идут по строкам сверху вниз, слева направо.');
  };

  const findAgain = async () => {
    setBusy('Ищу точки на бланке…');
    keep(await findMarks(blank));
    setNote('Точки найдены заново.');
  };

  const copyPicture = async () => {
    if (!picture) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': picture.blob })]);
      setNote('Картинка скопирована: вставьте её в чат (Ctrl+V), потом скопируйте запрос.');
    } catch {
      await saveFile(picture.blob, `${blank.name} — для нейронки.png`);
      setNote('Скопировать картинку не дали — она сохранена файлом: перетащите его в чат.');
    }
  };
  const copyPrompt = async () => {
    if (!marks) return;
    const ok = await copyText(blankPrompt(blank, marks, areas, ask));
    setNote(ok ? 'Запрос скопирован: вставьте его в чат после картинки и отправьте.' : 'Не удалось скопировать запрос.');
  };

  return (
    <div className="sketch-help-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sketch-help ask-dialog" role="dialog" aria-modal="true" aria-label="Спросить нейронку">
        <header className="ask-head">
          <h3>Заполнить бланк с нейронкой</h3>
          <button className="rail-btn" onClick={onClose} aria-label="Закрыть" title="Закрыть (Esc)">
            ✕
          </button>
        </header>
        <div className="ask-body">
          <div className="ask-picture">
            {picture ? (
              <img src={picture.url} alt="Бланк с разметкой для нейронки" onClick={(e) => void clickPicture(e)} title="Щелчок по метке убирает её, по точке бланка — добавляет (Alt — точно где щёлкнули)" />
            ) : (
              <p className="muted">{busy}</p>
            )}
          </div>
          <aside className="ask-side">
            <ol className="ask-steps">
              <li>
                <button className="btn primary" disabled={!picture} onClick={() => void copyPicture()}>
                  Копировать картинку
                </button>
                <span className="muted small">и вставить в чат с нейронкой</span>
              </li>
              <li>
                <button className="btn primary" disabled={!marks} onClick={() => void copyPrompt()}>
                  Копировать запрос
                </button>
                <span className="muted small">вставить туда же и отправить</span>
              </li>
              <li>
                <span className="small">
                  Ответ скопировать кнопкой «Копировать» у блока кода и нажать <kbd>Ctrl+V</kbd> в документе: задания лягут на бланк.
                </span>
              </li>
            </ol>
            <label className="ask-field">
              <span>Вариант</span>
              <input value={ask.variant} onChange={(e) => changeAsk({ variant: e.target.value })} placeholder="7" />
            </label>
            <label className="ask-field">
              <span>Подпись</span>
              <input value={ask.name} onChange={(e) => changeAsk({ name: e.target.value })} placeholder="Прізвище І. П." />
            </label>
            <label className="ask-field">
              <span>Задания</span>
              <input value={ask.tasks} onChange={(e) => changeAsk({ tasks: e.target.value })} placeholder="все (или: 3, 4а)" />
            </label>
            <label className="ask-field column">
              <span>Пожелания</span>
              <textarea rows={3} value={ask.wishes} onChange={(e) => changeAsk({ wishes: e.target.value })} placeholder="например: развёртку крупнее" />
            </label>
            <p className="muted small">
              Точек: {marks?.length ?? '…'}, свободных мест: {areas.length}. Щелчок по метке на картинке убирает её, по точке бланка — добавляет.{' '}
              <button className="link-btn" onClick={() => void findAgain()}>
                ↺ найти заново
              </button>
            </p>
            {note && <p className="ask-note small">{note}</p>}
          </aside>
        </div>
      </div>
    </div>
  );
}
