import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getHandwriting, useHandwriting } from '../engine/handwriting';
import { CodeEditor } from './CodeEditor';
import type { HtmlBlockAttrs } from './HtmlBlock';
import { buildSrcdoc, HostToBlock, isBlockMessage } from './runtime';
import { useVendor } from './useVendor';
import { LINE_HEIGHT_EM } from '../editor/layout';
import { drawPenOf, MM } from '../editor/page';
import { BlankPicker } from '../blank/BlankPicker';
import { BlockBar, BlockHandles, BlockShield } from './BlockBar';
import { dragBlock, sidesFor, type Side } from './drag';
import { SideEditor, useSideEditor } from './SideEditor';
import { BLANK_LETTERS } from '../blank/letterSize';
import { noteFontSize } from '../blank/note';
import { BlankContext, PageContext } from '../editor/Paper';
import { zoomOf } from '../editor/zoom';
import { blankBox, heightOf, sketchErrors as errorsOf } from '../sketch/render';
import { DrawPenContext, SketchFigure } from '../sketch/SketchFigure';
import { DrawPenPicker } from '../sketch/DrawPenPicker';
import { SketchHelp } from '../sketch/SketchHelp';
import { SketchPanel, type PickKind } from '../sketch/SketchPanel';

const MAX_DATA_BYTES = 500_000;

export function HtmlBlockView({ node, editor, getPos, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const attrs = node.attrs as HtmlBlockAttrs;
  const attrsRef = useRef(attrs);
  attrsRef.current = attrs;

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const fromBlock = useRef(''); // JSON of the data the block itself just sent
  const fromPanel = useRef(''); // JSON of the data typed into the data panel

  const [height, setHeight] = useState(attrs.height);
  const sketch = attrs.kind === 'sketch';
  // The code (commands, data) opens in the window on the left; one block's at a time.
  const [viewId] = useState(() => crypto.randomUUID());
  const [sideOpen, setSideOpen] = useSideEditor(viewId);
  const [panelKind, setPanelKind] = useState<'code' | 'data'>('code');
  const panel = sideOpen ? panelKind : null;
  const setPanel = (p: null | 'code' | 'data') => {
    if (p) setPanelKind(p);
    setSideOpen(p !== null);
  };
  // A new, empty drawing opens with its commands, ready for a paste.
  useEffect(() => {
    if (attrs.kind === 'sketch' && !attrs.code.trim()) setSideOpen(true);
  }, []);
  const [help, setHelp] = useState(false);
  const [appliedCode, setAppliedCode] = useState(attrs.code);
  const [draftCode, setDraftCode] = useState(attrs.code);
  const [draftData, setDraftData] = useState(() => JSON.stringify(attrs.data, null, 2));
  const [dataError, setDataError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { fontVersion } = useHandwriting();

  const vendor = useVendor();
  const srcdoc = useMemo(() => (vendor ? buildSrcdoc(appliedCode, vendor) : ''), [appliedCode, vendor]);

  const post = useCallback((msg: HostToBlock, transfer: Transferable[] = []) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*', transfer);
  }, []);

  const fontCopy = () => {
    const bytes = getHandwriting().fontBytes;
    return bytes ? (bytes.slice().buffer as ArrayBuffer) : undefined;
  };

  // A new document (code applied, restart) waits for a fresh "ready".
  useEffect(() => {
    readyRef.current = false;
  }, [srcdoc, reloadKey]);

  // Code changed from outside (undo/redo).
  useEffect(() => {
    setAppliedCode(attrs.code);
    setDraftCode(attrs.code);
  }, [attrs.code]);

  // Messages from this block's iframe only.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow || !isBlockMessage(e.data)) return;
      const msg = e.data;
      if (msg.type === 'ready') {
        readyRef.current = true;
        const font = fontCopy();
        post({ type: 'init', data: attrsRef.current.data, font }, font ? [font] : []);
      } else if (msg.type === 'height') {
        setHeight(Math.min(Math.max(Math.round(Number(msg.height) || 0), 40), 3000));
      } else if (msg.type === 'setData') {
        const json = JSON.stringify(msg.data ?? null);
        if (json.length > MAX_DATA_BYTES) {
          console.warn('HTML block data too large, ignored');
          return;
        }
        fromBlock.current = json;
        updateAttributes({ data: JSON.parse(json) });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [post, updateAttributes]);

  // Data changed in the document (data panel, undo/redo) -> push into the block.
  useEffect(() => {
    const json = JSON.stringify(attrs.data ?? null);
    if (json !== fromPanel.current) {
      setDraftData(JSON.stringify(attrs.data, null, 2));
      setDataError(null);
    }
    if (json !== fromBlock.current && readyRef.current) post({ type: 'data', data: attrs.data });
  }, [attrs.data, post]);

  // The handwriting font was rebuilt.
  useEffect(() => {
    if (!readyRef.current || fontVersion === 0) return;
    const font = fontCopy();
    if (font) post({ type: 'font', font }, [font]);
  }, [fontVersion, post]);

  const applyCode = () => updateAttributes({ code: draftCode });

  const sketchErrors = useMemo(() => (sketch ? errorsOf(attrs.code).length : 0), [sketch, attrs.code]);
  const insertIntoSketch = (snippet: string) => {
    const code = attrsRef.current.code;
    updateAttributes({ code: code.trim() ? `${code.replace(/\s*$/, '')}\n${snippet}` : snippet });
    setPanel('code');
  };

  const dataTimer = useRef<number | undefined>(undefined);
  const onDataEdit = (text: string) => {
    setDraftData(text);
    window.clearTimeout(dataTimer.current);
    dataTimer.current = window.setTimeout(() => {
      try {
        const parsed = JSON.parse(text);
        setDataError(null);
        fromPanel.current = JSON.stringify(parsed);
        updateAttributes({ data: parsed });
      } catch (err) {
        setDataError((err as Error).message);
      }
    }, 250);
  };

  // ---- Floating over the text, and keeping inline blocks on the ruling.
  const geo = useContext(PageContext);
  const onBlank = useContext(BlankContext);
  const [picking, setPicking] = useState<PickKind | null>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [pad, setPad] = useState(0);
  const [drag, setDrag] = useState<{ x: number; y: number; w: number } | null>(null);
  // A drawing on a blank (НаБланке) lies where its commands put it on the sheet; it floats and is not dragged.
  const box = useMemo(() => (sketch ? blankBox(attrs.code) : null), [sketch, attrs.code]);
  /** Where the editor's column starts below the sheet's writable area (the title above it), px. */
  const [columnTop, setColumnTop] = useState(0);
  useLayoutEffect(() => {
    if (!box) return;
    const root = innerRef.current?.closest('.ProseMirror');
    const content = root?.closest('.sheet-content');
    if (root && content) setColumnTop((root.getBoundingClientRect().top - content.getBoundingClientRect().top) / zoomOf(root));
  }, [box]);
  useEffect(() => {
    if (box && !attrs.float) updateAttributes({ float: true });
  }, [!!box, attrs.float]);
  const pos = box
    ? { x: box.x - geo.margin.left, y: box.y - geo.margin.top - columnTop, w: box.w }
    : (drag ?? { x: attrs.x, y: attrs.y, w: attrs.w });

  // Inline blocks: round the height up to whole lines so the text below stays on the ruling.
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || attrs.float) {
      setPad(0);
      return;
    }
    const ro = new ResizeObserver(() => {
      const editorRoot = inner.closest('.ProseMirror') as HTMLElement | null;
      const lh = (parseFloat(getComputedStyle(editorRoot ?? inner).fontSize) || 16) * LINE_HEIGHT_EM;
      const h = inner.getBoundingClientRect().height / zoomOf(inner);
      setPad(Math.max(0, Math.ceil(h / lh - 0.001) * lh - h));
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [attrs.float]);

  const toggleFloat = () => {
    if (attrs.float) {
      updateAttributes({ float: false });
      return;
    }
    const el = innerRef.current?.parentElement;
    const editorRoot = el?.closest('.ProseMirror');
    if (!el || !editorRoot) return;
    // Screen sizes are zoomed with the sheets: back to sheet pixels.
    const z = zoomOf(el);
    const a = el.getBoundingClientRect();
    const b = editorRoot.getBoundingClientRect();
    const pos = getPos();
    if (typeof pos !== 'number') return;
    // Empty lines take the room the block leaves, so the text below stays where it was.
    const lh = (parseFloat(getComputedStyle(editorRoot).fontSize) || 16) * LINE_HEIGHT_EM;
    const lines = Math.max(1, Math.ceil(a.height / z / lh - 0.05));
    // The figure stays put: a floating block's header goes above it, and it has no border.
    const headH = (el.querySelector('.html-block-head')?.getBoundingClientRect().height ?? 0) / z;
    const paragraph = editor.schema.nodes.paragraph;
    // Stay exactly where it is now; only stop taking room in the text. One undo step.
    editor
      .chain()
      .command(({ tr }) => {
        tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          float: true,
          x: Math.round((a.left - b.left) / z + 1),
          y: Math.round((a.top - b.top) / z + 1 + headH),
          w: Math.round(Math.min(a.width / z, 460)),
        });
        tr.insert(pos + node.nodeSize, Array.from({ length: lines }, () => paragraph.create()));
        return true;
      })
      .run();
  };

  /** Selects this block (a click on it while it is not selected does only that). */
  const select = () => {
    const p = getPos();
    if (typeof p === 'number') editor.commands.setNodeSelection(p);
  };

  /** Stretching (not moving): the width is shown while it changes. */
  const [stretching, setStretching] = useState(false);
  /** Moves the floating block by its blue square, or stretches it by an edge or a corner. */
  const startDrag = (e: React.PointerEvent, how: 'move' | Side) => {
    if (!attrs.float || box) return;
    if (!selected) select();
    // A drawing's height follows its width: its top and bottom edges and corners pull the width too.
    const fig = innerRef.current?.querySelector<HTMLElement>('.sketch-figure');
    const fs = fig ? parseFloat(getComputedStyle(fig).fontSize) || 16 : 16;
    const code = attrs.code;
    setStretching(how !== 'move');
    dragBlock(e, how, {
      start: { x: attrs.x, y: attrs.y, w: attrs.w },
      heightAt: sketch ? (w) => heightOf(code, w, fs) : null,
      place: (b) => ({
        ...b,
        x: Math.min(Math.max(b.x, -geo.margin.left + 4), geo.contentW + geo.margin.right - b.w - 4),
        y: Math.max(b.y, -geo.margin.top),
      }),
      minW: 160,
      maxW: geo.sheet.w - 8,
      onDrag: setDrag, // also turns off pointer events in the iframe while dragging
      onDone: (b) => {
        setDrag(null);
        setStretching(false);
        updateAttributes(b);
      },
    });
  };

  /** The block on the sheet, from the window's title. */
  const showBlock = () => {
    innerRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    select();
  };

  return (
    <NodeViewWrapper
      className={`html-block ${selected ? 'selected' : ''} ${attrs.float ? 'floating' : ''} ${drag ? 'dragging' : ''}`}
      data-panel={panel ?? undefined}
      style={attrs.float ? { left: pos.x, top: pos.y, width: pos.w } : { paddingBottom: pad }}
    >
      <div ref={innerRef} className="html-block-inner">
      {selected ? (
        <BlockBar>
          {box && (
            <span className="grip" title="Чертёж по бланку: стоит там, где задано в НаБланке(…); начало можно сменить пипеткой «⌖ Начало»">
              ⌖
            </span>
          )}
          <input
            className="html-block-title"
            value={attrs.title}
            onChange={(e) => updateAttributes({ title: e.target.value })}
            onDoubleClick={(e) => {
              e.currentTarget.focus();
              e.currentTarget.select();
            }}
            aria-label="Название блока"
          />
          <div className="html-block-tools">
            {!box && (
              <button
                className={attrs.float ? 'on' : ''}
                onClick={toggleFloat}
                title={attrs.float ? 'Вернуть блок в текст' : 'Положить блок поверх текста и двигать свободно'}
              >
                {attrs.float ? '↧ В текст' : '⇱ Поверх'}
              </button>
            )}
            {sketch ? (
              <>
                <PenMenu pen={attrs.pen} onChange={(pen) => updateAttributes({ pen })} />
                <button className={panel === 'code' ? 'on' : ''} onClick={() => setPanel(panel === 'code' ? null : 'code')}>
                  Команды
                </button>
                <button onClick={() => setHelp(true)} title="Все команды, примеры и запрос для нейронки">
                  ? Справка
                </button>
              </>
            ) : (
              <>
                <button className={panel === 'data' ? 'on' : ''} onClick={() => setPanel(panel === 'data' ? null : 'data')}>
                  Данные
                </button>
                <button className={panel === 'code' ? 'on' : ''} onClick={() => setPanel(panel === 'code' ? null : 'code')}>
                  Код
                </button>
                <button onClick={() => setReloadKey((k) => k + 1)} title="Перезапустить блок">
                  ↻
                </button>
              </>
            )}
            <button onClick={() => deleteNode()} title="Удалить блок" className="danger">
              ✕
            </button>
          </div>
        </BlockBar>
      ) : (
        <BlockShield onSelect={select} />
      )}
      {!box && (selected || attrs.float) && (
        <BlockHandles
          onMove={attrs.float ? (e) => startDrag(e, 'move') : undefined}
          onStretch={attrs.float && selected ? startDrag : undefined}
          sides={sidesFor(sketch)}
        />
      )}
      {drag && stretching && <span className="block-size no-print">{Math.round(drag.w / MM)} мм</span>}
      {sketch ? (
        <>
          <SketchFigure
            code={attrs.code}
            pen={attrs.pen}
            width={box?.w}
            fontSize={onBlank ? noteFontSize(onBlank.blank.letters ?? BLANK_LETTERS) : undefined}
            sheetMap={box ? onBlank?.map : null}
            placeholder="Пустой чертёж: напишите команды в окне слева или вставьте ответ нейронки. «? Справка» — все команды и готовый запрос." />
          {sketchErrors > 0 && !panel && (
            <button className="sketch-badge no-print" contentEditable={false} onClick={() => setPanel('code')}>
              ⚠ Строк с ошибками: {sketchErrors} — открыть команды
            </button>
          )}
        </>
      ) : srcdoc ? (
        <iframe
          key={reloadKey}
          ref={iframeRef}
          className="html-block-frame"
          title={attrs.title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={srcdoc}
          style={{ height }}
        />
      ) : (
        <div style={{ height }} />
      )}
      </div>
      {panel && (
        <SideEditor
          title={sketch ? `Команды — ${attrs.title}` : attrs.title}
          onTitle={showBlock}
          onClose={() => setPanel(null)}
          tools={
            sketch ? (
              <button onClick={() => setHelp(true)} title="Все команды, примеры и запрос для нейронки">
                ? Справка
              </button>
            ) : (
              <>
                <button className={panel === 'code' ? 'on' : ''} onClick={() => setPanel('code')}>
                  Код
                </button>
                <button className={panel === 'data' ? 'on' : ''} onClick={() => setPanel('data')}>
                  Данные
                </button>
              </>
            )
          }
        >
          {sketch ? (
            <SketchPanel
              code={attrs.code}
              onChange={(code) => updateAttributes({ code })}
              onHelp={() => setHelp(true)}
              onPick={onBlank ? setPicking : undefined}
            />
          ) : panel === 'code' ? (
            <>
              <CodeEditor value={draftCode} language="html" onChange={setDraftCode} onSubmit={applyCode} />
              <div className="row">
                <button className="btn small primary" onClick={applyCode} disabled={draftCode === attrs.code}>
                  Применить <kbd>Ctrl+Enter</kbd>
                </button>
                <button className="btn small" onClick={() => setDraftCode(attrs.code)} disabled={draftCode === attrs.code}>
                  Отменить правки
                </button>
                <span className="muted small">
                  Блок работает в песочнице: без доступа к редактору и сети. API: block.data, block.setData(),
                  block.onData(), block.onFont().
                </span>
              </div>
            </>
          ) : (
            <>
              <CodeEditor value={draftData} language="json" onChange={onDataEdit} />
              <div className="row">
                {dataError ? (
                  <span className="error small">JSON: {dataError}</span>
                ) : (
                  <span className="muted small">Изменения применяются сразу. Ctrl+Z в документе откатывает их.</span>
                )}
              </div>
            </>
          )}
        </SideEditor>
      )}
      {help && <SketchHelp onClose={() => setHelp(false)} onInsert={insertIntoSketch} />}
      {picking && onBlank && (
        <BlankPicker
          on={onBlank}
          sheet={geo.sheet}
          mode={picking}
          code={attrs.code}
          onCode={(code) => updateAttributes({ code })}
          onClose={() => setPicking(null)}
        />
      )}
    </NodeViewWrapper>
  );
}

/** «Перо» in a drawing's header: pen or pencil and its colour for this drawing, or the document's. */
function PenMenu({ pen, onChange }: { pen: Record<string, unknown> | null; onChange: (pen: Record<string, unknown> | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const value = drawPenOf(useContext(DrawPenContext), pen);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  // The document's ink, for the «auto» swatch (the sheet sets it as a CSS variable).
  const textInk = (ref.current && getComputedStyle(ref.current).getPropertyValue('--ink-base').trim()) || '#1f2a6b';
  return (
    <div className="pen-menu-wrap" ref={ref}>
      <button className={open ? 'on' : ''} onClick={() => setOpen(!open)} title="Чем нарисован этот чертёж: ручкой или карандашом, каким цветом">
        {value.tool === 'pencil' ? '✎ Карандаш' : '✒ Ручка'} ▾
      </button>
      {open && (
        <div className="menu-items pen-menu">
          <label className="check inline small">
            <input type="checkbox" checked={pen === null} onChange={(e) => onChange(e.target.checked ? null : { ...value })} />
            Как во всём документе
          </label>
          <DrawPenPicker value={value} textInk={textInk} onChange={(next) => onChange({ ...next })} />
          <p className="muted small">Для всех чертежей документа — в меню «Лист».</p>
        </div>
      )}
    </div>
  );
}
