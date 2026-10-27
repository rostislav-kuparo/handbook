import { useCallback, useEffect, useMemo, useState } from 'react';
import { HAND_FONT_STACK } from '../engine/constants';
import { addSample, deleteSample, updateSample, useHandwriting } from '../engine/handwriting';
import { TEX_CHARS } from '../editor/tex';
import { CHAR_GROUPS, isLetter, isPair, pairShelf, PANGRAM, shelfOf, SUGGESTED_PAIRS, type CharGroup, type Shelf } from '../model/alphabet';
import { detectAnchors } from '../model/anchors';
import { BRACKETS, SYMBOL_GROUPS } from '../model/symbols';
import { Stroke, uid } from '../model/types';
import { getSetting, setSetting } from '../storage/db';
import { CaptureCanvas } from './CaptureCanvas';
import { PhraseStudio } from './PhraseStudio';
import { TARGET_VARIANTS } from './phrasePicker';
import { SampleThumb } from './SampleThumb';
import { LetterSettings } from './LetterSettings';
import { SynthPreview } from './SynthPreview';

type Mode = 'letters' | 'phrase';

const KNOWN = new Set(CHAR_GROUPS.flatMap((g) => g.chars));

/** Signs the program can insert or has been taught in the text, but the alphabet above doesn't list. */
function extraSigns(written: Iterable<string>): string[] {
  const all = [...SYMBOL_GROUPS.flatMap((g) => [...g.chars]), ...TEX_CHARS, ...BRACKETS, ...[...written].filter((k) => !isPair(k))];
  return [...new Set(all)].filter((c) => !KNOWN.has(c) && c.trim() !== '');
}

/** How far a group is: a thin bar that fills when every sign has three variants. */
function GroupProgress({ chars, counts }: { chars: string[]; counts: (ch: string) => number }) {
  const got = chars.map((ch) => Math.min(counts(ch), TARGET_VARIANTS));
  const done = got.filter((n) => n >= TARGET_VARIANTS).length;
  const percent = Math.floor((got.reduce((a, n) => a + n, 0) / (chars.length * TARGET_VARIANTS)) * 100);
  const missing = chars.filter((_, i) => got[i] < TARGET_VARIANTS);
  return (
    <div
      className="group-progress"
      title={missing.length ? `Ещё нужны: ${missing.slice(0, 40).join(' ')}${missing.length > 40 ? ' …' : ''}` : `У каждой — минимум ${TARGET_VARIANTS} варианта`}
    >
      <div className="group-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className={`progress-fill ${percent === 100 ? 'full' : ''}`} style={{ width: `${percent}%` }} />
      </div>
      <span>
        {done}/{chars.length}
      </span>
    </div>
  );
}

export function Studio() {
  const { byChar, style, derived, learned } = useHandwriting();
  const [mode, setMode] = useState<Mode>('letters');
  const [current, setCurrent] = useState('а');
  const [shelf, setShelf] = useState<Shelf>('cyr-lower');
  const [phrase, setPhrase] = useState(PANGRAM);
  const [newPair, setNewPair] = useState('');

  // Remember the open letter and mode; don't write before the saved ones have been read.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    void Promise.all([getSetting('studio.char', 'а'), getSetting<Mode>('studio.mode', 'letters')]).then(([ch, m]) => {
      setCurrent(ch);
      setShelf(shelfOf(ch));
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

  // The groups of every shelf: the suggested pairs plus any the user recorded, and the extra signs.
  const groups = useMemo<CharGroup[]>(() => {
    const ownPairs = [...byChar.keys()].filter((k) => isPair(k) && !SUGGESTED_PAIRS.includes(k));
    const latinPairs = ownPairs.filter((p) => pairShelf(p) === 'lat-lower');
    const list = CHAR_GROUPS.map((g) => (g.id === 'pairs' ? { ...g, chars: [...g.chars, ...ownPairs.filter((p) => !latinPairs.includes(p))] } : g));
    if (latinPairs.length) list.splice(list.findIndex((g) => g.id === 'lat-lower') + 1, 0, { id: 'lat-pairs', title: 'Пары букв', chars: latinPairs, shelf: 'lat-lower' });
    list.push({ id: 'extra', title: 'Ещё символы', chars: extraSigns(byChar.keys()), shelf: 'sym' });
    return list;
  }, [byChar]);
  const shown = groups.filter((g) => g.shelf === shelf);
  const visibleChars = useMemo(() => shown.flatMap((g) => g.chars), [groups, shelf]);
  const variants = byChar.get(current) ?? [];
  const derivedFrom = variants.length === 0 ? derived.get(current) : undefined;

  const open = (ch: string) => {
    setCurrent(ch);
    setMode('letters');
  };

  /** Another shelf: the same letter in the other case when there is one, else the shelf's first. */
  const pickShelf = (next: Shelf) => {
    setShelf(next);
    const chars = groups.filter((g) => g.shelf === next).flatMap((g) => g.chars);
    if (chars.includes(current)) return;
    const twin = next.endsWith('upper') ? current.toUpperCase() : current.toLowerCase();
    open(chars.includes(twin) ? twin : chars[0]);
  };
  const script = shelf === 'sym' ? 'sym' : shelf.slice(0, 3);
  const upper = shelf.endsWith('upper');

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
      setShelf(pairShelf(p));
      open(p);
      setNewPair('');
    }
  };

  const weightKey = `${style.weight}|${style.pressure}`;
  const lower = script === 'lat' ? 'aa' : 'аа';

  return (
    <div className="studio">
      <aside className="alphabet-col">
        <div className="alphabet float">
          <div className="alphabet-groups fade-scroll">
            {shown.map((g) => (
              <section key={g.id}>
                <h4>{g.title}</h4>
                <GroupProgress chars={g.chars} counts={(ch) => byChar.get(ch)?.length ?? 0} />
                <div className={`char-grid ${g.id.endsWith('pairs') ? 'pairs' : ''}`}>
                  {g.chars.map((ch) => {
                    const n = byChar.get(ch)?.length ?? 0;
                    const auto = n === 0 && derived.has(ch);
                    return (
                      <button
                        key={ch}
                        className={`char-cell ${ch === current && mode === 'letters' ? 'active' : ''} ${
                          n === 0 ? (auto ? 'auto' : 'none') : n < 3 ? 'few' : 'ok'
                        }`}
                        onClick={() => open(ch)}
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
          </div>
        </div>
        <div className="alphabet-pills">
          <div className="pill float" role="group" aria-label="Регистр">
            <button className={!upper ? 'on' : ''} disabled={script === 'sym'} onClick={() => pickShelf(`${script}-lower` as Shelf)} title="Строчные">
              {lower}
            </button>
            <button className={upper ? 'on' : ''} disabled={script === 'sym'} onClick={() => pickShelf(`${script}-upper` as Shelf)} title="Прописные">
              {lower.toUpperCase()}
            </button>
          </div>
          <div className="pill float" role="group" aria-label="Алфавит">
            <button className={script === 'cyr' ? 'on' : ''} onClick={() => pickShelf(upper ? 'cyr-upper' : 'cyr-lower')} title="Кириллица">
              Кир
            </button>
            <button className={script === 'lat' ? 'on' : ''} onClick={() => pickShelf(upper ? 'lat-upper' : 'lat-lower')} title="Латиница">
              Lat
            </button>
            <button className={script === 'sym' ? 'on' : ''} onClick={() => pickShelf('sym')} title="Цифры, знаки и формулы">
              ∑
            </button>
          </div>
        </div>
      </aside>

      <section className="workbench">
        <div className="pill mode-switch" role="tablist">
          <button role="tab" aria-selected={mode === 'letters'} className={mode === 'letters' ? 'on' : ''} onClick={() => setMode('letters')}>
            Буквы и пары
          </button>
          <button role="tab" aria-selected={mode === 'phrase'} className={mode === 'phrase' ? 'on' : ''} onClick={() => setMode('phrase')}>
            Напиши фразу
          </button>
        </div>

        {mode === 'phrase' ? (
          <PhraseStudio />
        ) : (
          <>
            <header className="workbench-head">
              <div className="current-char">
                <span className="big">{current}</span>
                <span className="muted" title="Записанных вариантов">
                  · {variants.length}
                </span>
                {(learned[current] ?? 0) > 0 && (
                  <span className="muted small" title="Направлений изменчивости вашего письма, которые выучила модель: новые варианты берутся из этого разброса">
                    модель: {learned[current]}
                  </span>
                )}
              </div>
            </header>

            <CaptureCanvas
              char={current}
              penWidth={style.weight}
              onSave={save}
              extra={
                <span className="letter-arrows">
                  <button className="btn ghost" onClick={() => move(-1)} aria-label="Предыдущая буква" title="Предыдущая буква (←)">
                    ←
                  </button>
                  <button className="btn ghost" onClick={() => move(1)} aria-label="Следующая буква" title="Следующая буква (→)">
                    →
                  </button>
                </span>
              }
            />

            <section className="variants recorded">
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
                {variants.length === 0 && derivedFrom && (
                  <p className="muted small">
                    Сейчас собрана автоматически {derivedFrom === 'перо' ? '(вашим пером)' : `из «${derivedFrom}»`}. Своя заменит её.
                  </p>
                )}
              </div>
            </section>

            <section className="variants">
              <h3>Так движок пишет {isPair(current) ? 'эту пару' : 'эту букву'}</h3>
              <SynthPreview char={current} />
            </section>
          </>
        )}
      </section>

      <aside className="side fade-scroll">
        <section className="panel float">
          <h3>Проба пера</h3>
          <textarea value={phrase} onChange={(e) => setPhrase(e.target.value)} rows={2} />
          <p className="phrase" style={{ fontFamily: HAND_FONT_STACK }}>
            {phrase}
          </p>
        </section>
        <LetterSettings />
      </aside>
    </div>
  );
}
