import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HAND_FONT_STACK } from '../engine/constants';
import { addSample, deleteSample, updateSample, useHandwriting } from '../engine/handwriting';
import { CHAR_GROUPS, isLetter, isPair, PANGRAM, SUGGESTED_PAIRS } from '../model/alphabet';
import { detectAnchors } from '../model/anchors';
import { Stroke, uid } from '../model/types';
import { exportHandwriting, getSetting, importHandwriting, setSetting } from '../storage/db';
import { saveFile } from '../util/download';
import { CaptureCanvas } from './CaptureCanvas';
import { PhraseStudio } from './PhraseStudio';
import { Progress } from './Progress';
import { SampleThumb } from './SampleThumb';
import { LetterSettings } from './LetterSettings';
import { SynthPreview } from './SynthPreview';

type Mode = 'letters' | 'phrase';

function Hint({ char }: { char: string }) {
  if (isPair(char)) {
    return (
      <p className="hint-line">
        Пара пишется <b>одним движением</b>, как в слове: «{char}» целиком, с соединением между буквами. В тексте пара
        заменит отдельные буквы и даст естественную связку.
      </p>
    );
  }
  if (isLetter(char) && char !== char.toLowerCase()) {
    return (
      <p className="hint-line">
        Прописная — до линии «прописные». Чтобы она <b>соединялась</b> со следующей буквой, напишите соединяющий штрих{' '}
        <b>последним</b> и закончите его хвостиком справа у линии строки (или на высоте строчных). Тогда кружок выхода
        станет зелёным. Г, П, Т, Ф обычно не соединяются — это нормально.
      </p>
    );
  }
  if (isLetter(char)) {
    return (
      <p className="hint-line">
        Строчная — между «строкой» и «строчными»; хвосты (д, у, р) — до «хвостов». Подводящий штрих от строки слева и
        хвостик вправо в конце — это точки входа и выхода для слитного письма.
      </p>
    );
  }
  return null;
}

export function Studio() {
  const { byChar, style, derived, learned } = useHandwriting();
  const [mode, setMode] = useState<Mode>('letters');
  const [current, setCurrent] = useState('а');
  const [phrase, setPhrase] = useState(PANGRAM);
  const [newPair, setNewPair] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // Remember the open letter and mode; don't write before the saved ones have been read.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    void Promise.all([getSetting('studio.char', 'а'), getSetting<Mode>('studio.mode', 'letters')]).then(([ch, m]) => {
      setCurrent(ch);
      setMode(m);
      setRestored(true);
    });
  }, []);
  useEffect(() => {
    if (restored) {
      void setSetting('studio.char', current);
      void setSetting('studio.mode', mode);
    }
  }, [current, mode, restored]);

  // Pairs: the suggested ones plus any the user recorded.
  const groups = useMemo(() => {
    const ownPairs = [...byChar.keys()].filter((k) => isPair(k) && !SUGGESTED_PAIRS.includes(k));
    return CHAR_GROUPS.map((g) => (g.id === 'pairs' ? { ...g, chars: [...g.chars, ...ownPairs] } : g));
  }, [byChar]);
  const visibleChars = useMemo(() => groups.flatMap((g) => g.chars), [groups]);
  const variants = byChar.get(current) ?? [];
  const derivedFrom = variants.length === 0 ? derived.get(current) : undefined;

  const move = useCallback(
    (delta: number) => {
      const i = visibleChars.indexOf(current);
      setCurrent(visibleChars[(Math.max(i, 0) + delta + visibleChars.length) % visibleChars.length]);
    },
    [current, visibleChars],
  );

  useEffect(() => {
    if (mode !== 'letters') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key === 'ArrowRight') move(1);
      if (e.key === 'ArrowLeft') move(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, mode]);

  const save = useCallback(
    (strokes: Stroke[], pointerType: string) => {
      const { entry, exit } = detectAnchors(current, strokes);
      void addSample({ id: uid(), char: current, strokes, entry, exit, pointerType, createdAt: Date.now() });
    },
    [current],
  );

  const addPair = () => {
    const p = newPair.trim().toLowerCase();
    if ([...p].length >= 2 && [...p].length <= 3 && [...p].every(isLetter)) {
      setCurrent(p);
      setMode('letters');
      setNewPair('');
    }
  };

  const exportBackup = async () => {
    const data = await exportHandwriting();
    await saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'pocherk.handbook.json');
  };

  const importBackup = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const replace = confirm('Заменить текущий почерк? «Отмена» — добавить образцы к текущим.');
      await importHandwriting(data, replace);
    } catch (err) {
      alert(String(err));
    }
  };

  const weightKey = `${style.weight}|${style.pressure}`;

  return (
    <div className="studio">
      <aside className="alphabet">
        {groups.map((g) => (
          <section key={g.id}>
            <h4>{g.title}</h4>
            <div className={`char-grid ${g.id === 'pairs' ? 'pairs' : ''}`}>
              {g.chars.map((ch) => {
                const n = byChar.get(ch)?.length ?? 0;
                const auto = n === 0 && derived.has(ch);
                return (
                  <button
                    key={ch}
                    className={`char-cell ${ch === current && mode === 'letters' ? 'active' : ''} ${
                      n === 0 ? (auto ? 'auto' : 'none') : n < 3 ? 'few' : 'ok'
                    }`}
                    onClick={() => {
                      setCurrent(ch);
                      setMode('letters');
                    }}
                    title={auto ? `${ch}: собрана автоматически из «${derived.get(ch)}»` : `${ch}: вариантов ${n}`}
                  >
                    <span>{ch}</span>
                    {n > 0 ? <small>{n}</small> : auto && <small className="auto-mark">авто</small>}
                  </button>
                );
              })}
            </div>
            {g.id === 'pairs' && (
              <div className="row pair-add">
                <input
                  value={newPair}
                  onChange={(e) => setNewPair(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addPair()}
                  placeholder="своя пара"
                  maxLength={3}
                  aria-label="Своя пара букв"
                />
                <button className="btn small" onClick={addPair}>
                  +
                </button>
              </div>
            )}
          </section>
        ))}
      </aside>

      <section className="workbench">
        <Progress />
        <div className="mode-switch" role="tablist">
          <button role="tab" aria-selected={mode === 'letters'} className={mode === 'letters' ? 'active' : ''} onClick={() => setMode('letters')}>
            Буквы и пары
          </button>
          <button role="tab" aria-selected={mode === 'phrase'} className={mode === 'phrase' ? 'active' : ''} onClick={() => setMode('phrase')}>
            Напиши фразу
          </button>
        </div>

        {mode === 'phrase' ? (
          <PhraseStudio />
        ) : (
          <>
            <header className="workbench-head">
              <button className="btn ghost" onClick={() => move(-1)} aria-label="Предыдущая буква">
                ←
              </button>
              <div className="current-char">
                <span className="big">{current}</span>
                <span className="muted">
                  вариантов: {variants.length} · пишите сколько угодно — каждый вариант делает почерк живее
                </span>
              </div>
              <button className="btn ghost" onClick={() => move(1)} aria-label="Следующая буква">
                →
              </button>
            </header>
            <Hint char={current} />

            <CaptureCanvas char={current} penWidth={style.weight} onSave={save} />

            <section className="variants">
              <h3>Записанные варианты</h3>
              <p className="muted small">
                Кружки — точки входа и выхода. Зелёный — буква соединяется с соседней в этой точке (у строки или на высоте
                строчных). Жёлтый — соединение включено, но точка не на краю буквы, поэтому оно не сработает. Клик
                переключает, а если точка встала не туда — перетащите кружок: он встанет на ближайший конец штриха.
                В редакторе вариант без входа ставится в начало слова, с входом и выходом — в середину; в «Отрендерить»
                в середине слова бывают все варианты, а соединение к букве без входа дорисовывается само.
              </p>
              <div className="thumbs">
                {variants.map((s) => (
                  <SampleThumb
                    key={s.id}
                    sample={s}
                    weightKey={weightKey}
                    onDelete={() => void deleteSample(s.id)}
                    onAnchor={(side, anchor) => void updateSample(s.id, { [side]: anchor })}
                  />
                ))}
                {variants.length === 0 && (
                  <p className="muted">
                    {derivedFrom
                      ? `Пока буква собрана автоматически (${derivedFrom === 'перо' ? 'нарисована вашим пером' : `из «${derivedFrom}»`}). Напишите свою — она заменит автоматическую.`
                      : 'Пока пусто.'}
                  </p>
                )}
              </div>
            </section>

            <section className="variants">
              <h3>Так движок пишет {isPair(current) ? 'эту пару' : 'эту букву'}</h3>
              <SynthPreview char={current} />
              {(learned[current] ?? 0) > 0 && (
                <p className="muted small">
                  Модель выучила направлений изменчивости вашего письма: {learned[current]}. Новые варианты берутся из этого
                  разброса.
                </p>
              )}
            </section>
          </>
        )}
      </section>

      <aside className="side">
        <section className="panel">
          <h3>Проба пера</h3>
          <textarea value={phrase} onChange={(e) => setPhrase(e.target.value)} rows={2} />
          <p className="phrase" style={{ fontFamily: HAND_FONT_STACK }}>
            {phrase}
          </p>
        </section>
        <LetterSettings />
        <section className="panel">
          <h3>Резервная копия</h3>
          <div className="row">
            <button className="btn small" onClick={exportBackup}>
              Сохранить почерк
            </button>
            <button className="btn small" onClick={() => fileRef.current?.click()}>
              Загрузить…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importBackup(f);
                e.target.value = '';
              }}
            />
          </div>
        </section>
      </aside>
    </div>
  );
}
