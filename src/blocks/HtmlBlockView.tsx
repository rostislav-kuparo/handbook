import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getHandwriting, useHandwriting } from '../engine/handwriting';
import { CodeEditor } from './CodeEditor';
import type { HtmlBlockAttrs } from './HtmlBlock';
import { buildSrcdoc, HostToBlock, isBlockMessage } from './runtime';
import { useVendor } from './useVendor';
import { LINE_HEIGHT_EM } from '../editor/layout';
import { SHEET_W } from '../editor/page';
import { PageContext } from '../editor/Paper';

const MAX_DATA_BYTES = 500_000;

export function HtmlBlockView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const attrs = node.attrs as HtmlBlockAttrs;
  const attrsRef = useRef(attrs);
  attrsRef.current = attrs;

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const fromBlock = useRef(''); // JSON of the data the block itself just sent
  const fromPanel = useRef(''); // JSON of the data typed into the data panel

  const [height, setHeight] = useState(attrs.height);
  const [panel, setPanel] = useState<null | 'code' | 'data'>(null);
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
  const innerRef = useRef<HTMLDivElement>(null);
  const [pad, setPad] = useState(0);
  const [drag, setDrag] = useState<{ x: number; y: number; w: number } | null>(null);
  const pos = drag ?? { x: attrs.x, y: attrs.y, w: attrs.w };

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
      const h = inner.getBoundingClientRect().height;
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
    const a = el.getBoundingClientRect();
    const b = editorRoot.getBoundingClientRect();
    // Stay exactly where it is now; only stop taking room in the text.
    updateAttributes({ float: true, x: Math.round(a.left - b.left), y: Math.round(a.top - b.top), w: Math.round(Math.min(a.width, 460)) });
  };

  const startDrag = (e: React.PointerEvent, mode: 'move' | 'resize') => {
    if (!attrs.float) return;
    e.preventDefault(); // also keeps ProseMirror from starting a selection or a drag
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const start = { x: attrs.x, y: attrs.y, w: attrs.w };
    let last = start;
    setDrag(start); // turns off pointer events in the iframe while dragging
    getSelection()?.removeAllRanges();
    document.body.style.userSelect = 'none';
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      last =
        mode === 'move'
          ? {
              ...start,
              x: Math.round(Math.min(Math.max(start.x + dx, -geo.margin.left + 4), geo.contentW + geo.margin.right - start.w - 4)),
              y: Math.round(Math.max(start.y + dy, -geo.margin.top)),
            }
          : { ...start, w: Math.round(Math.min(Math.max(start.w + dx, 160), SHEET_W - 8)) };
      setDrag(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
      setDrag(null);
      updateAttributes(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <NodeViewWrapper
      className={`html-block ${selected ? 'selected' : ''} ${attrs.float ? 'floating' : ''} ${drag ? 'dragging' : ''}`}
      data-panel={panel ?? undefined}
      style={attrs.float ? { left: pos.x, top: pos.y, width: pos.w } : { paddingBottom: pad }}
    >
      <div ref={innerRef} className="html-block-inner">
      <div
        className="html-block-head"
        contentEditable={false}
        onPointerDown={(e) => {
          // A floating block is dragged by its whole header; the title is edited with a double click.
          const target = e.target as HTMLElement;
          if (!attrs.float || target.closest('button')) return;
          if (target.matches('input') && document.activeElement === target) return;
          startDrag(e, 'move');
        }}
      >
        {attrs.float ? (
          <span className="grip" title="Перетащить по листу">
            ✥
          </span>
        ) : (
          <span className="grip" data-drag-handle title="Перетащить блок">
            ⠿
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
          <button
            className={attrs.float ? 'on' : ''}
            onClick={toggleFloat}
            title={attrs.float ? 'Вернуть блок в текст' : 'Положить блок поверх текста и двигать свободно'}
          >
            {attrs.float ? '↧ В текст' : '⇱ Поверх'}
          </button>
          <button className={panel === 'data' ? 'on' : ''} onClick={() => setPanel(panel === 'data' ? null : 'data')}>
            Данные
          </button>
          <button className={panel === 'code' ? 'on' : ''} onClick={() => setPanel(panel === 'code' ? null : 'code')}>
            Код
          </button>
          <button onClick={() => setReloadKey((k) => k + 1)} title="Перезапустить блок">
            ↻
          </button>
          <button onClick={() => deleteNode()} title="Удалить блок" className="danger">
            ✕
          </button>
        </div>
      </div>

      {srcdoc ? (
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

      {panel && (
        <div className="html-block-panel" contentEditable={false}>
          {panel === 'code' ? (
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
        </div>
      )}
      </div>
      {attrs.float && (
        <span className="resize-handle" contentEditable={false} onPointerDown={(e) => startDrag(e, 'resize')} title="Ширина блока" />
      )}
    </NodeViewWrapper>
  );
}
