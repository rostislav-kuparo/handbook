import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NOTE_SIZE, NOTE_SIZES, noteFontSize, noteRuns } from '../blank/note';
import { romanWords } from '../blank/roman';
import { LINE_HEIGHT_EM } from '../editor/layout';
import { clearPlace } from '../blank/occupancy';
import { BlankContext, PageContext } from '../editor/Paper';
import { BlockBar, BlockHandles, BlockShield } from './BlockBar';
import { dragBlock, sidesFor, type Side } from './drag';
import type { HtmlBlockAttrs } from './HtmlBlock';

/**
 * «Надпись» in the editor: words in the handwriting font, lying anywhere over
 * the sheet like a floating drawing. A click edits the text; the blue square
 * moves it, its left and right edges set its width (longer text wraps); the
 * pill below sets its letters' size and removes it.
 */
export function NoteView({ node, editor, getPos, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const attrs = node.attrs as HtmlBlockAttrs;
  const geo = useContext(PageContext);
  const [editing, setEditing] = useState(!attrs.code);
  const [draft, setDraft] = useState(attrs.code);
  const [drag, setDrag] = useState<{ x: number; y: number; w: number } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const pos = drag ?? { x: attrs.x, y: attrs.y, w: attrs.w };
  const fontSize = noteFontSize(attrs.size);

  // Notes always lie over the sheet.
  useEffect(() => {
    if (!attrs.float) updateAttributes({ float: true });
  }, [attrs.float]);
  // Changed from outside (undo, redo).
  useEffect(() => {
    if (!editing) setDraft(attrs.code);
  }, [attrs.code, editing]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // A click anywhere else ends the editing (also when the text never took the focus).
  const box = useRef<HTMLDivElement>(null);
  const finishRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!editing) return;
    const outside = (e: PointerEvent) => {
      // Its own header (size, width) is part of it.
      const own = box.current?.closest('.note-block');
      // …and so are its actions in the pill below.
      if ((e.target as Element).closest?.('.block-bar')) return;
      if (!own || !own.contains(e.target as Node)) finishRef.current();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [editing]);
  // The box grows with the text.
  useLayoutEffect(() => {
    const t = area.current;
    if (!t) return;
    t.style.height = '0px';
    t.style.height = `${t.scrollHeight}px`;
  }, [draft, editing, pos.w, fontSize]);

  const edit = (text: string) => {
    setDraft(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => updateAttributes({ code: text }), 250);
  };
  const finish = () => {
    window.clearTimeout(timer.current);
    if (draft !== attrs.code) updateAttributes({ code: draft });
    setEditing(false);
    if (!draft.trim()) deleteNode();
  };
  finishRef.current = finish;

  /** Selects this note (a click on it while it is not selected does only that). */
  const select = () => {
    const p = getPos();
    if (typeof p === 'number') editor.commands.setNodeSelection(p);
  };

  /** Moves the note by its blue square, or sets its width by its left or right edge. */
  const startDrag = (e: React.PointerEvent, how: 'move' | Side) => {
    if (!selected) select();
    dragBlock(e, how, {
      start: { x: attrs.x, y: attrs.y, w: attrs.w },
      heightAt: null,
      place: (b) => ({
        ...b,
        x: Math.min(Math.max(b.x, -geo.margin.left), geo.contentW + geo.margin.right - 24),
        y: Math.max(b.y, -geo.margin.top),
      }),
      minW: fontSize * 2,
      maxW: geo.sheet.w,
      onDrag: setDrag,
      onDone: (b) => {
        setDrag(null);
        updateAttributes(b);
      },
    });
  };

  const step = (d: number) => updateAttributes({ size: Math.round(Math.min(Math.max((attrs.size || NOTE_SIZE) + d, NOTE_SIZES.min), NOTE_SIZES.max) * 2) / 2 });
  const style = { fontSize, lineHeight: `${fontSize * LINE_HEIGHT_EM}px` };

  // On a blank: lying on printed lines or on a drawing? Then it can be moved off them.
  const onBlank = useContext(BlankContext);
  const textBox = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => setHeight(textBox.current?.offsetHeight ?? 0));
  const sheetBox = { x: pos.x + geo.margin.left, y: pos.y + geo.margin.top, w: pos.w, h: height };
  const onLines = !!onBlank?.map && height > 0 && !drag && onBlank.map.count(sheetBox, undefined, sheetBox) > 6;
  const moveOff = () => {
    if (!onBlank?.map) return;
    const q = clearPlace(onBlank.map, sheetBox, geo.sheet, sheetBox);
    updateAttributes({ x: Math.round(q.x - geo.margin.left), y: Math.round(q.y - geo.margin.top) });
  };

  // Words that may be Roman numerals: shown as they will be written, a click switches one.
  const flip = ((attrs.data as { roman?: number[] } | null)?.roman ?? []).filter((n) => Number.isFinite(n));
  const words = romanWords(attrs.code, flip);
  const toggleRoman = (from: number) => {
    const next = flip.includes(from) ? flip.filter((n) => n !== from) : [...flip, from];
    updateAttributes({ data: { ...((attrs.data as object | null) ?? {}), roman: next } });
  };
  let offset = 0;
  const lines = attrs.code.split('\n').map((line) => {
    const at = offset;
    offset += line.length + 1;
    return { line, at };
  });
  /** A line cut into plain text and the words that may be numerals. */
  const piecesOf = (line: string, at: number) => {
    const out: { text: string; word?: (typeof words)[number] }[] = [];
    let last = 0;
    for (const w of words) {
      if (w.from < at || w.to > at + line.length) continue;
      if (w.from - at > last) out.push({ text: line.slice(last, w.from - at) });
      out.push({ text: line.slice(w.from - at, w.to - at), word: w });
      last = w.to - at;
    }
    if (last < line.length) out.push({ text: line.slice(last) });
    return out;
  };

  return (
    <NodeViewWrapper
      className={`html-block floating note-block ${selected ? 'selected' : ''} ${drag ? 'dragging' : ''}`}
      style={{ left: pos.x, top: pos.y, width: pos.w }}
    >
      {selected ? (
        <BlockBar>
          <span className="note-title">Надпись</span>
          {onLines && (
            <button className="note-warn" onClick={moveOff} title="Надпись лежит на линиях бланка или чертежа: отодвинуть к ближайшему чистому месту">
              ⚠ Отодвинуть
            </button>
          )}
          <div className="html-block-tools">
            <button onClick={() => step(-0.5)} title="Буквы мельче">
              A−
            </button>
            <span className="note-size" title="Высота заглавных букв">
              {String(attrs.size || NOTE_SIZE).replace('.', ',')} мм
            </span>
            <button onClick={() => step(0.5)} title="Буквы крупнее">
              A+
            </button>
            <button onClick={() => setEditing(true)} title="Изменить текст (или щелчок по тексту)">
              ✎ Текст
            </button>
            <button onClick={() => deleteNode()} title="Удалить надпись" className="danger">
              ✕
            </button>
          </div>
        </BlockBar>
      ) : (
        !editing && <BlockShield onSelect={select} />
      )}
      {!editing && <BlockHandles onMove={(e) => startDrag(e, 'move')} onStretch={selected ? startDrag : undefined} sides={sidesFor(false)} />}
      <div ref={box} contentEditable={false}>
      {editing ? (
        <textarea
          ref={area}
          className="note-text note-edit"
          style={style}
          autoFocus
          value={draft}
          placeholder="Текст надписи"
          spellCheck={false}
          onChange={(e) => edit(e.target.value)}
          onBlur={() => finishRef.current()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              area.current?.blur();
            }
          }}
        />
      ) : (
        <div ref={textBox} className="note-text" style={style} contentEditable={false} onClick={() => setEditing(true)} title="Щёлкните, чтобы изменить текст. $…$ — формула, A_1 — индекс">
          {lines.map(({ line, at }, i) => (
            <div key={i}>
              {line
                ? piecesOf(line, at).map((p, j) =>
                    p.word ? (
                      <span
                        key={j}
                        className={`roman-word ${p.word.roman ? 'on' : ''}`}
                        title={p.word.roman ? 'Римское число (пишется палочками). Щелчок — это буквы' : 'Буквы. Щелчок — это римское число'}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleRoman(p.word!.from);
                        }}
                      >
                        {p.text}
                      </span>
                    ) : (
                      noteRuns(p.text).map((r, k) => (
                        <span key={`${j}-${k}`} className={r.script ? `script-${r.script}` : undefined}>
                          {r.text}
                        </span>
                      ))
                    ),
                  )
                : ' '}
            </div>
          ))}
        </div>
      )}
      </div>
      {onLines && <span className="note-badge no-print" title="Надпись лежит на линиях: «⚠ Отодвинуть» в её шапке">⚠</span>}
    </NodeViewWrapper>
  );
}
