import type { Editor } from '@tiptap/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TEMPLATES } from '../blocks/templates';
import { DeskDialog } from '../desk/DeskDialog';
import { TopCorner } from '../ExportsButton';
import { HAND_FONT_STACK } from '../engine/constants';
import { useHandwriting } from '../engine/handwriting';
import type { DocContent, HandDocument } from '../model/types';
import { createDocument, db, getSetting, setSetting } from '../storage/db';
import { BlockIcon, ExportIcon, NibIcon, PencilIcon } from '../ui/icons';
import { useLive } from '../util/useLive';
import { docState, PRINT_EVENT, SHOW_DOC_EVENT } from './docState';
import { exportDocumentJson, exportFont, exportPng, exportSvg } from './exporters';
import { HandEditor } from './HandEditor';
import { InkView } from './InkView';
import { geometry, pageSetup, sheetNumber, type PageSetup } from './page';
import { PageMenu } from './PageMenu';
import { RenderMenu } from './RenderMenu';
import { SketchMenu } from './SketchMenu';
import { SymbolsMenu } from './SymbolsMenu';
import { Paper } from './Paper';
import { welcomeContent } from './welcome';

function closeMenus(el: HTMLElement) {
  el.closest('details')?.removeAttribute('open');
}

// Shared promise: effects may run twice (StrictMode) but the welcome document is created once.
let initialDoc: Promise<string | null> | null = null;
function openInitialDocument(): Promise<string | null> {
  initialDoc ??= (async () => {
    if ((await db.documents.count()) === 0) {
      return (await createDocument('Добро пожаловать', welcomeContent())).id;
    }
    const remembered = await getSetting<string | null>('editor.doc', null);
    return remembered && (await db.documents.get(remembered)) ? remembered : null;
  })();
  return initialDoc;
}

export function Documents() {
  const docs = useLive(() => db.documents.orderBy('updatedAt').reverse().toArray(), [], null as HandDocument[] | null);
  const [currentId, setCurrentId] = useState<string | null>(docState.docId);
  const [fontSize, setFontSize] = useState(26);
  const [ink, setInk] = useState(docState.ink);
  const [pages, setPages] = useState(1);
  const [printPending, setPrintPending] = useState(false);
  /** The window menu asked to print (maybe from the other tab): done once the document is here. */
  const [printAsked, setPrintAsked] = useState(docState.print);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [desk, setDesk] = useState(false);
  /** The document whose name is being edited in «Недавние». */
  const [renaming, setRenaming] = useState<string | null>(null);
  // Content of the open document, tagged with its id so a stale one is never shown.
  const [loaded, setLoaded] = useState<{ id: string; content: DocContent } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  /** The rendered view has finished writing: printing can start right away. */
  const inkReady = useRef(false);
  const { samples, fontBytes } = useHandwriting();

  // Restore UI state; create the welcome document on first launch.
  useEffect(() => {
    void (async () => {
      setFontSize(await getSetting('editor.fontSize', 26));
      if (docState.docId) return;
      const id = await openInitialDocument();
      if (id) setCurrentId(id);
    })();
  }, []);

  // The window menu: a new or opened document, printing.
  useEffect(() => {
    const onShow = (e: Event) => {
      setCurrentId((e as CustomEvent<string>).detail);
      setInk(false);
    };
    const onPrint = () => setPrintAsked(true);
    window.addEventListener(SHOW_DOC_EVENT, onShow);
    window.addEventListener(PRINT_EVENT, onPrint);
    return () => {
      window.removeEventListener(SHOW_DOC_EVENT, onShow);
      window.removeEventListener(PRINT_EVENT, onPrint);
    };
  }, []);

  useEffect(() => {
    docState.docId = currentId;
    docState.ink = ink;
  }, [currentId, ink]);

  useEffect(() => {
    if (!currentId && docs && docs.length > 0) setCurrentId(docs[0].id);
  }, [docs, currentId]);

  useEffect(() => {
    if (currentId) void setSetting('editor.doc', currentId);
  }, [currentId]);

  const doc = docs?.find((d) => d.id === currentId) ?? null;
  const setup = pageSetup(doc?.page);
  const firstNumber = sheetNumber(setup, 0);
  const marginsKey = JSON.stringify(setup.margins);
  // The title toggle is part of the key too: a new geometry makes the editor re-paginate.
  const geo = useMemo(() => geometry(setup), [marginsKey, setup.showTitle]);
  const updatePage = (next: PageSetup) => {
    if (doc) void db.documents.update(doc.id, { page: next, updatedAt: Date.now() });
  };

  // Load content once per document (the editor owns it afterwards).
  useEffect(() => {
    if (doc && loaded?.id !== doc.id) setLoaded({ id: doc.id, content: doc.content });
  }, [doc, loaded]);
  const content = doc && loaded?.id === doc.id ? loaded.content : null;

  const onChange = useCallback(
    (next: DocContent) => {
      const id = currentId;
      if (!id) return;
      setLoaded({ id, content: next });
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void db.documents.update(id, { content: next, updatedAt: Date.now() });
      }, 400);
    },
    [currentId],
  );

  const removeDoc = async (d: HandDocument) => {
    if (!confirm(`Удалить «${d.title}»? Это нельзя отменить.`)) return;
    await db.documents.delete(d.id);
    if (d.id === currentId) setCurrentId(null);
  };

  const changeFontSize = (v: number) => {
    setFontSize(v);
    void setSetting('editor.fontSize', v);
  };

  /** What the PNG/SVG export draws: the open document on its sheets, as the rendered view shows it. */
  const pageExport = () => ({
    docId: doc!.id,
    title: doc!.title,
    showTitle: setup.showTitle,
    content: content!,
    fontSize,
    geo,
    paper: setup.paper,
    ink: setup.ink,
    firstNumber,
    drawPen: setup.drawPen,
  });

  useEffect(() => {
    if (!ink) inkReady.current = false;
  }, [ink]);

  const print = () => {
    // Already rendered: nothing is going to finish rendering, so print now.
    if (ink && inkReady.current) {
      window.print();
      return;
    }
    setInk(true);
    setPrintPending(true);
  };

  useEffect(() => {
    if (!printAsked || !doc || !content) return;
    setPrintAsked(false);
    docState.print = false;
    print();
  }, [printAsked, doc, content]);

  if (!docs) return <div className="loading">Открываю тетрадь…</div>;

  return (
    <div className="documents">
      <aside className="recents float no-print">
        <h4 className="recents-head">Недавние</h4>
        <ul className="fade-scroll">
          {docs.map((d) => (
            <li key={d.id} className={d.id === currentId ? 'active' : ''}>
              {renaming === d.id ? (
                <div className="doc-link">
                  <input
                    className="doc-rename"
                    autoFocus
                    defaultValue={d.title}
                    placeholder="Без названия"
                    aria-label="Новое название"
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      else if (e.key === 'Escape') {
                        e.currentTarget.value = d.title;
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={(e) => {
                      const title = e.currentTarget.value.trim();
                      if (title !== d.title) void db.documents.update(d.id, { title, updatedAt: Date.now() });
                      setRenaming(null);
                    }}
                  />
                </div>
              ) : (
                <button className="doc-link" onClick={() => setCurrentId(d.id)} onDoubleClick={() => setRenaming(d.id)}>
                  <span className="doc-title">{d.title || 'Без названия'}</span>
                  <span className="muted small">{new Date(d.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span>
                </button>
              )}
              <button className="doc-action" onClick={() => setRenaming(d.id)} aria-label="Переименовать документ" title="Переименовать">
                ✎
              </button>
              <button className="doc-action doc-delete" onClick={() => void removeDoc(d)} aria-label="Удалить документ" title="Удалить">
                ✕
              </button>
            </li>
          ))}
        </ul>
        {samples.length === 0 && <p className="recents-note muted small">Почерк пуст — напишите буквы во вкладке «Почерк».</p>}
      </aside>

      <main className="doc-main" ref={pageRef}>
        {doc &&
          content &&
          (ink ? (
            <InkView
              docId={doc.id}
              title={setup.showTitle ? doc.title : null}
              firstNumber={firstNumber}
              drawPen={setup.drawPen}
              content={content}
              fontSize={fontSize}
              geo={geo}
              paper={setup.paper}
              ink={setup.ink}
              onRendered={() => {
                inkReady.current = true;
                if (printPending) {
                  setPrintPending(false);
                  setTimeout(() => window.print(), 400);
                }
              }}
            />
          ) : (
            <Paper
              pages={pages}
              firstNumber={firstNumber}
              drawPen={setup.drawPen}
              fontSize={fontSize}
              geo={geo}
              paper={setup.paper}
              ink={setup.ink}
              onBlankClick={() => editor?.commands.focus('end')}
            >
              {setup.showTitle && (
                <input
                  className="page-title"
                  value={doc.title}
                  placeholder="Название"
                  onChange={(e) => void db.documents.update(doc.id, { title: e.target.value, updatedAt: Date.now() })}
                  style={{ fontFamily: HAND_FONT_STACK }}
                  aria-label="Название документа"
                />
              )}
              <HandEditor
                key={doc.id}
                doc={{ ...doc, content }}
                fontSize={fontSize}
                geo={geo}
                onChange={onChange}
                onEditor={setEditor}
                onPages={setPages}
              />
            </Paper>
          ))}
      </main>

      {doc && content && (
        <>
          <TopCorner>
            <details className="menu right">
              <summary className="corner-btn float" title="Экспорт" aria-label="Экспорт">
                <ExportIcon />
              </summary>
              <div className="menu-items">
                <button onClick={(e) => (closeMenus(e.currentTarget), print())}>
                  <strong>Печать / PDF</strong>
                  <span className="muted small">вместе с блоками</span>
                </button>
                <button onClick={(e) => (closeMenus(e.currentTarget), void exportPng(pageExport()))}>
                  <strong>Картинка PNG</strong>
                </button>
                <button onClick={(e) => (closeMenus(e.currentTarget), void exportSvg(pageExport()))}>
                  <strong>Вектор SVG</strong>
                </button>
                <button onClick={(e) => (closeMenus(e.currentTarget), setDesk(true))}>
                  <strong>На столе (фото)…</strong>
                  <span className="muted small">текст на снимке настоящего листа, JPG</span>
                </button>
                <button disabled={!fontBytes} onClick={(e) => (closeMenus(e.currentTarget), void exportFont())}>
                  <strong>Мой шрифт .ttf</strong>
                  <span className="muted small">для Word, Figma и т. п.</span>
                </button>
                <button onClick={(e) => (closeMenus(e.currentTarget), void exportDocumentJson(doc.title, content))}>
                  <strong>Документ .json</strong>
                </button>
              </div>
            </details>
          </TopCorner>

          <div className="tool-rail float no-print" role="toolbar" aria-orientation="vertical" aria-label="Инструменты">
            <details className="menu">
              <summary className="rail-btn" title="Вставить блок" aria-label="Вставить блок">
                <BlockIcon />
              </summary>
              <div className="menu-items">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    disabled={ink || !editor}
                    onClick={(e) => {
                      closeMenus(e.currentTarget);
                      editor
                        ?.chain()
                        .focus()
                        .insertHtmlBlock({ title: t.title, code: t.code, data: structuredClone(t.data) })
                        .run();
                    }}
                  >
                    <strong>{t.name}</strong>
                    <span className="muted small">{t.description}</span>
                  </button>
                ))}
              </div>
            </details>
            <PageMenu setup={setup} onChange={updatePage} fontSize={fontSize} onFontSize={changeFontSize} />
            <SymbolsMenu editor={editor} disabled={ink || !editor} />
            <SketchMenu editor={editor} ink={ink} setup={setup} onChange={updatePage} />
            <span className="rail-sep" />
            <button
              className={`rail-btn ${ink ? 'on' : ''}`}
              onClick={() => setInk(!ink)}
              title={ink ? 'Редактировать' : 'Отрендерить: каждая буква уникальна, строки неровные, как на бумаге'}
              aria-label={ink ? 'Редактировать' : 'Отрендерить'}
              aria-pressed={ink}
            >
              {ink ? <PencilIcon /> : <NibIcon />}
            </button>
            <RenderMenu />
          </div>
        </>
      )}
      {desk && doc && content && <DeskDialog base={pageExport()} setup={setup} onClose={() => setDesk(false)} />}
    </div>
  );
}
