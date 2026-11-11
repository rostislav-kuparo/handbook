import { layoutKey, type DocLayout, type NodeLayout } from './docLayout';
import type { Editor } from '@tiptap/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnswerCard, AnswerNames } from '../blank/AnswerCard';
import type { AnswerHooks, AnswerReport } from '../blank/answerPaste';
import { AskDialog } from '../blank/AskDialog';
import { BLANK_LETTERS, printLetters } from '../blank/letterSize';
import { migrateContent } from '../blank/migrate';
import { buildOccupancy, withDrawingLabels, type Occupancy } from '../blank/occupancy';
import { darkOf } from '../blank/snap';
import { topLevelNodes } from './layout';
import { blankPicture, blankRect, blankSheet, printShrinkOf, type Blank, type BlankPicture } from '../blank/blank';
import { TEMPLATES } from '../blocks/templates';
import { DeskDialog } from '../desk/DeskDialog';
import { TopCorner } from '../ExportsButton';
import { HAND_FONT_STACK } from '../engine/constants';
import { useHandwriting } from '../engine/handwriting';
import type { DocContent, HandDocument } from '../model/types';
import { createDocument, db, getSetting, setSetting } from '../storage/db';
import { BlockIcon, ExportIcon, NibIcon, PencilIcon } from '../ui/icons';
import { onFlush } from '../util/flush';
import { useLive } from '../util/useLive';
import { docState, PRINT_EVENT, SHOW_DOC_EVENT } from './docState';
import { exportDocumentJson, exportFont, exportPng, exportSvg } from './exporters';
import { HandEditor } from './HandEditor';
import { InkView } from './InkView';
import { A4, geometry, onBlank, pageSetup, sheetNumber, type PageSetup } from './page';
import { PageMenu } from './PageMenu';
import { RenderMenu } from './RenderMenu';
import { SketchMenu } from './SketchMenu';
import { SymbolsMenu } from './SymbolsMenu';
import { Paper } from './Paper';
import { clampZoom, ZOOM_STEP } from './zoom';
import { useWear } from '../wear/settings';
import { printedPicture, printerLook } from '../blank/printer';
import { MM } from './page';
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
  /** «Спросить нейронку» open; what the last pasted answer did; an answer being laid out. */
  const [asking, setAsking] = useState(false);
  const [report, setReport] = useState<AnswerReport | null>(null);
  const [answerBusy, setAnswerBusy] = useState(false);
  /** The document whose name is being edited in «Недавние». */
  const [renaming, setRenaming] = useState<string | null>(null);
  // Content of the open document, tagged with its id so a stale one is never shown.
  const [loaded, setLoaded] = useState<{ id: string; content: DocContent } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  /** How close the sheets are looked at (Ctrl + wheel); the point under the cursor stays put. */
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const zoomAnchor = useRef<{ x: number; y: number; cx: number; cy: number; from: number } | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  /** The rendered view has finished writing: printing can start right away. */
  const inkReady = useRef(false);
  const { samples, fontBytes, fontVersion } = useHandwriting();
  const wear = useWear();

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
    void getSetting('editor.zoom', 1).then((z) => setZoom(clampZoom(Number(z) || 1)));
  }, []);
  /** Zoom to `next` keeping the sheet point under (cx, cy) on screen there (the middle of the view without a point). */
  const zoomTo = useCallback((next: number, at?: { clientX: number; clientY: number }) => {
    const main = pageRef.current;
    const from = zoomRef.current;
    const z = clampZoom(next);
    if (!main || z === from) return;
    const r = main.getBoundingClientRect();
    const cx = (at?.clientX ?? r.left + r.width / 2) - r.left;
    const cy = (at?.clientY ?? r.top + r.height / 2) - r.top;
    // Several wheel steps before a render: each goes on from the last.
    // (The page has not moved yet: the point is where the zoom on screen puts it.)
    zoomAnchor.current = { x: main.scrollLeft + cx, y: main.scrollTop + cy, cx, cy, from: zoomAnchor.current?.from ?? from };
    zoomRef.current = z;
    setZoom(z);
    void setSetting('editor.zoom', z);
  }, []);
  useLayoutEffect(() => {
    const main = pageRef.current;
    const a = zoomAnchor.current;
    if (!main || !a) return;
    zoomAnchor.current = null;
    const f = zoom / a.from;
    main.scrollLeft = a.x * f - a.cx;
    main.scrollTop = a.y * f - a.cy;
  }, [zoom]);
  // On the window: the sheets' box comes later than this effect (after the documents load).
  useEffect(() => {
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !pageRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      zoomTo(zoomRef.current * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), e);
    };
    const keys = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      if (e.key === '=' || e.key === '+') zoomTo(zoomRef.current * ZOOM_STEP);
      else if (e.key === '-') zoomTo(zoomRef.current / ZOOM_STEP);
      else if (e.key === '0') zoomTo(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', keys);
    return () => {
      window.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', keys);
    };
  }, [zoomTo]);

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
  // A document on a blank: the blank's paper is the sheet, with nothing of the document's own paper.
  const blankId = setup.blank;
  const blankRow = useLive(
    async () => (blankId ? { id: blankId, row: (await db.blanks.get(blankId)) ?? null } : null),
    [blankId],
    null as { id: string; row: Blank | null } | null,
  );
  const blank = blankId && blankRow?.id === blankId ? blankRow.row : null;
  // Until the blank is read (and a blank from before 0.8.1 brought over) the sheet is unknown: the page waits.
  const oldBlank = blank && !blank.version ? blank : null;
  const blankPending = !!blankId && (blankRow?.id !== blankId || !!oldBlank);
  // A blank from before 0.8.1: its documents' drawings and notes go onto the blank's own sheet, once.
  useEffect(() => {
    if (!oldBlank) return;
    void (async () => {
      const docsOn = (await db.documents.toArray()).filter((d) => pageSetup(d.page).blank === oldBlank.id);
      for (const d of docsOn) {
        const next = migrateContent(d.content, oldBlank);
        if (!next) continue;
        await db.documents.update(d.id, { content: next, layout: undefined });
        if (d.id === currentId) setLoaded({ id: d.id, content: next });
      }
      await db.blanks.update(oldBlank.id, { version: 2 });
    })().catch((err) => console.error(err));
  }, [oldBlank?.id]);
  // How big to write on the blank: measured once by its printed text.
  useEffect(() => {
    if (!blank || blank.letters) return;
    void printLetters(blank).then((letters) => db.blanks.update(blank.id, { letters }));
  }, [blank?.id, blank?.letters]);
  const page = blank ? onBlank(setup) : setup;
  const sheet = blank ? blankSheet(blank) : A4;
  const firstNumber = sheetNumber(page, 0);
  const marginsKey = JSON.stringify(page.margins);
  // The title toggle is part of the key too: a new geometry makes the editor re-paginate.
  const geo = useMemo(() => geometry(page, sheet), [marginsKey, page.showTitle, page.rightLine, sheet.w, sheet.h]);
  // The blank as the printer prints it: made once per blank, shown when ready.
  const [picture, setPicture] = useState<{ key: string; pic: BlankPicture } | null>(null);
  const pictureKey = blank ? `${blank.id}|${blank.white}` : null;
  useEffect(() => {
    if (!blank || !pictureKey) return;
    let alive = true;
    blankPicture(blank)
      .then((pic) => alive && setPicture({ key: pictureKey, pic }))
      .catch((err) => console.error(err));
    return () => {
      alive = false;
    };
  }, [pictureKey]);
  const shownPicture = blank && picture?.key === pictureKey ? picture.pic : null;
  const blankRectOn = blank ? blankRect(blank, sheet) : null;
  // A neural net's answer pasted into the editor goes onto this blank.
  const answerContext = useRef<{ blank: Blank; geo: typeof geo } | null>(null);
  answerContext.current = blank ? { blank, geo } : null;
  const answers = useMemo<AnswerHooks>(
    () => ({ context: () => answerContext.current, onBusy: setAnswerBusy, onReport: setReport }),
    [],
  );
  useEffect(() => setReport(null), [currentId]);
  const updatePage = (next: PageSetup) => {
    if (doc) void db.documents.update(doc.id, { page: next, updatedAt: Date.now() });
  };

  // Load content once per document (the editor owns it afterwards).
  useEffect(() => {
    if (doc && loaded?.id !== doc.id) setLoaded({ id: doc.id, content: doc.content });
  }, [doc, loaded]);
  const content = doc && loaded?.id === doc.id ? loaded.content : null;
  // What lies on the blank's sheet — printing, drawings, notes, the drawings' labels — for labels and notes to keep off it.
  const [sheetMap, setSheetMap] = useState<Occupancy | null>(null);
  useEffect(() => {
    if (!blank || !content) {
      setSheetMap(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      void darkOf(blank).then(async (d) => {
        if (!alive) return;
        const blocks = topLevelNodes(content)
          .filter((n) => n.type === 'htmlBlock' && n.attrs?.float)
          .map((n) => {
            const a = n.attrs ?? {};
            return { kind: String(a.kind), code: String(a.code ?? ''), pen: a.pen, x: Number(a.x) + geo.margin.left, y: Number(a.y) + geo.margin.top, w: Number(a.w) || 360, size: Number(a.size) || undefined };
          });
        const letters = blank.letters ?? BLANK_LETTERS;
        const map = buildOccupancy(d, blank, sheet, blocks, letters, setup.drawPen);
        const labelled = await withDrawingLabels(map, blocks, letters, setup.drawPen);
        if (alive) setSheetMap(labelled);
      });
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [blank?.id, blank?.letters, content, sheet.w, sheet.h, fontVersion]);
  const blankOnSheet = blank && shownPicture && blankRectOn ? { blank, url: shownPicture.url, rect: blankRectOn, map: sheetMap } : null;
  // Rendered, the blank is printed as by an ordinary printer (blank/printer.ts) — on screen, in print and in files.
  const [printed, setPrinted] = useState<{ key: string; url: string } | null>(null);
  const printedKey = shownPicture && blankRectOn ? JSON.stringify([pictureKey, blankRectOn.w, wear.printer, wear.printerSeed]) : '';
  useEffect(() => {
    if (!ink || !printedKey || !shownPicture || !blankRectOn) return;
    let alive = true;
    void printedPicture(shownPicture.dataUrl, blankRectOn.w / MM, printerLook(wear.printer, wear.printerSeed))
      .then((url) => alive && setPrinted({ key: printedKey, url }))
      .catch((err) => console.error(err));
    return () => {
      alive = false;
    };
  }, [ink, printedKey]);
  const printedUrl = printed?.key === printedKey ? printed.url : null;
  const inkBlank = blankOnSheet && printedUrl ? { ...blankOnSheet, url: printedUrl } : blankOnSheet;

  // Where the editor put the lines: the rendered view and the exports write them there, as long as
  // the text, the letters' size and the page are still those it was measured for.
  const [liveLayout, setLiveLayout] = useState<{ id: string; layout: DocLayout } | null>(null);
  const layoutTimer = useRef<number | undefined>(undefined);
  const measuredFor = useRef({ fontSize, geo, showTitle: page.showTitle });
  measuredFor.current = { fontSize, geo, showTitle: page.showTitle };
  const onLayout = useCallback(
    (nodes: (NodeLayout | null)[], measured: DocContent) => {
      const id = currentId;
      if (!id) return;
      const m = measuredFor.current;
      const layout: DocLayout = { key: layoutKey(measured, m.fontSize, m.geo, m.showTitle), nodes };
      setLiveLayout({ id, layout });
      window.clearTimeout(layoutTimer.current);
      // Kept with the document (not a change of it: «Недавние» keep their order).
      layoutTimer.current = window.setTimeout(() => void db.documents.update(id, { layout }), 800);
    },
    [currentId],
  );
  const contentKey = useMemo(() => (content ? layoutKey(content, fontSize, geo, page.showTitle) : null), [content, fontSize, geo, page.showTitle]);
  const docLayout = (doc && liveLayout?.id === doc.id ? liveLayout.layout : doc?.layout) ?? null;
  const layout = docLayout && docLayout.key === contentKey ? docLayout.nodes : null;

  /** The text typed last, not yet in the database (it is saved a moment after the last key). */
  const unsaved = useRef<{ id: string; content: DocContent } | null>(null);
  const saveNow = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const u = unsaved.current;
    unsaved.current = null;
    return u ? db.documents.update(u.id, { content: u.content, updatedAt: Date.now() }).catch((err) => console.error(err)) : undefined;
  }, []);
  // Saved at once when asked (the window closes, a backup is made)…
  useEffect(() => onFlush(saveNow), [saveNow]);
  // …and when another document is opened or the tab is left: the timer of one document must not drop the words of another.
  useEffect(() => () => void saveNow(), [currentId, saveNow]);
  const onChange = useCallback(
    (next: DocContent) => {
      const id = currentId;
      if (!id) return;
      setLoaded({ id, content: next });
      if (unsaved.current && unsaved.current.id !== id) void saveNow();
      unsaved.current = { id, content: next };
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void saveNow(), 400);
    },
    [currentId, saveNow],
  );

  /** A new note in the middle of what is in view (over the text column), its text being typed. */
  const insertNote = () => {
    if (!editor) return;
    const col = editor.view.dom.getBoundingClientRect();
    const view = pageRef.current?.getBoundingClientRect();
    const midY = view ? (view.top + view.bottom) / 2 : window.innerHeight / 2;
    const w = 260;
    const x = Math.round(Math.min(Math.max(geo.contentW / 2 - w / 2, -geo.margin.left), geo.contentW - w));
    const y = Math.round(Math.max(-geo.margin.top, (midY - col.top) / zoom));
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'htmlBlock', attrs: { kind: 'note', title: 'Надпись', code: '', float: true, x, y, w, size: blank?.letters ?? 4 } });
  };

  const removeDoc = async (d: HandDocument) => {
    if (!confirm(`Удалить «${d.title}»? Это нельзя отменить.`)) return;
    await db.documents.delete(d.id);
    const own = pageSetup(d.page).blank;
    if (own) await db.blanks.delete(own);
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
    showTitle: page.showTitle,
    content: content!,
    fontSize,
    geo,
    editor: geo,
    paper: page.paper,
    ink: setup.ink,
    firstNumber,
    drawPen: setup.drawPen,
    layout,
    blank: blank && blankRectOn ? { id: blank.id, href: printedUrl ?? shownPicture?.dataUrl ?? '', rect: blankRectOn, letters: blank.letters ?? BLANK_LETTERS, map: sheetMap } : null,
    wear,
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
          !blankPending &&
          (ink ? (
            <InkView
              docId={doc.id}
              title={page.showTitle ? doc.title : null}
              firstNumber={firstNumber}
              drawPen={setup.drawPen}
              content={content}
              fontSize={fontSize}
              geo={geo}
              paper={page.paper}
              ink={setup.ink}
              layout={layout}
              blank={inkBlank}
              zoom={zoom}
              printShrink={blank ? printShrinkOf(blank, sheet) : 1}
              wear={{ settings: wear, source: pageExport }}
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
              paper={page.paper}
              ink={setup.ink}
              blank={blankOnSheet}
              zoom={zoom}
              onBlankClick={() => editor?.commands.focus('end')}
            >
              {page.showTitle && (
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
                onLayout={onLayout}
                answers={answers}
              />
              {report && blank && <AnswerNames report={report} />}
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
                <button disabled={ink || !editor} onClick={(e) => (closeMenus(e.currentTarget), insertNote())}>
                  <strong>Надпись</strong>
                  <span className="muted small">почерком в любом месте листа: ответ, подпись, формула</span>
                </button>
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
            <PageMenu
              setup={setup}
              blank={blank}
              onChange={updatePage}
              fontSize={fontSize}
              onFontSize={changeFontSize}
              onAllNotes={(mm) =>
                editor?.commands.command(({ tr, state }) => {
                  state.doc.forEach((node, pos) => {
                    if (node.type.name === 'htmlBlock' && node.attrs.kind === 'note') tr.setNodeMarkup(pos, undefined, { ...node.attrs, size: mm });
                  });
                  return true;
                })
              }
            />
            <SymbolsMenu editor={editor} disabled={ink || !editor} />
            <SketchMenu editor={editor} ink={ink} setup={setup} onChange={updatePage} />
            {blank && (
              <button
                className="rail-btn"
                disabled={ink}
                onClick={() => setAsking(true)}
                title="Заполнить бланк с нейронкой: картинка с разметкой и запрос для чата; ответ — Ctrl+V в документе"
                aria-label="Спросить нейронку"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden>
                  <path d="M12 3.5 13.9 9.1 19.5 11 13.9 12.9 12 18.5 10.1 12.9 4.5 11 10.1 9.1Z" />
                  <path d="M18.5 3.5v3M17 5h3" strokeLinecap="round" />
                </svg>
              </button>
            )}
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
      {zoom !== 1 && (
        <button className="zoom-pill float no-print" onClick={() => zoomTo(1)} title="Масштаб листа: Ctrl + колесо, Ctrl + «+» / «−»; щелчок — 100 % (Ctrl + 0)">
          {Math.round(zoom * 100)} % · ⟲
        </button>
      )}
      {asking && blank && <AskDialog blank={blank} onClose={() => setAsking(false)} />}
      {report && <AnswerCard report={report} onClose={() => setReport(null)} />}
      {answerBusy && <div className="answer-busy float no-print">Раскладываю ответ нейронки по бланку…</div>}
      {desk && doc && content && <DeskDialog base={pageExport()} setup={page} onClose={() => setDesk(false)} />}
    </div>
  );
}
