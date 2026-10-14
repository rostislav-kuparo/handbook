import type { Editor } from '@tiptap/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TEMPLATES } from '../blocks/templates';
import { HAND_FONT_STACK } from '../engine/constants';
import { useHandwriting } from '../engine/handwriting';
import type { DocContent, HandDocument } from '../model/types';
import { createDocument, db, exportEverything, getSetting, importEverything, importHandwriting, setSetting } from '../storage/db';
import { downloadBlob } from '../util/download';
import { useLive } from '../util/useLive';
import { exportDocumentJson, exportFont, exportPng, exportSvg } from './exporters';
import { HandEditor } from './HandEditor';
import { InkView } from './InkView';
import { geometry, pageSetup, type PageSetup } from './page';
import { PageMenu } from './PageMenu';
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
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(26);
  const [ink, setInk] = useState(false);
  const [pages, setPages] = useState(1);
  const [printPending, setPrintPending] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  // Content of the open document, tagged with its id so a stale one is never shown.
  const [loaded, setLoaded] = useState<{ id: string; content: DocContent } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const { samples, fontBytes } = useHandwriting();

  // Restore UI state; create the welcome document on first launch.
  useEffect(() => {
    void (async () => {
      setFontSize(await getSetting('editor.fontSize', 26));
      const id = await openInitialDocument();
      if (id) setCurrentId(id);
    })();
  }, []);

  useEffect(() => {
    if (!currentId && docs && docs.length > 0) setCurrentId(docs[0].id);
  }, [docs, currentId]);

  useEffect(() => {
    if (currentId) void setSetting('editor.doc', currentId);
  }, [currentId]);

  const doc = docs?.find((d) => d.id === currentId) ?? null;
  const setup = pageSetup(doc?.page);
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

  const newDoc = async () => {
    const d = await createDocument();
    setCurrentId(d.id);
    setInk(false);
  };

  const openRef = useRef<HTMLInputElement>(null);
  /** Opens a document, or loads a full backup / handwriting file (any Handbook .json). */
  const openDoc = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (data?.format === 'handbook-backup') {
        const n = await importEverything(data);
        alert(`Загружено из резервной копии: документов — ${n.documents}, вариантов букв — ${n.samples}.`);
        return;
      }
      if (data?.format === 'handbook-handwriting') {
        await importHandwriting(data, false);
        alert(`Почерк добавлен: вариантов букв — ${data.samples.length}.`);
        return;
      }
      if (data?.format !== 'handbook-document' || !data.content) throw new Error('Это не файл Handbook (.json)');
      const d = await createDocument(String(data.title ?? 'Без названия'), data.content);
      setCurrentId(d.id);
      setInk(false);
    } catch (err) {
      alert(String(err));
    }
  };

  const saveEverything = async () => {
    const data = await exportEverything();
    const day = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `handbook-backup-${day}.json`);
  };

  const removeDoc = async (d: HandDocument) => {
    if (!confirm(`Удалить «${d.title}»? Это нельзя отменить.`)) return;
    await db.documents.delete(d.id);
    if (d.id === currentId) setCurrentId(null);
  };

  const changeFontSize = (v: number) => {
    setFontSize(v);
    void setSetting('editor.fontSize', v);
  };

  const pageWidth = () => geo.contentW;

  const print = () => {
    setInk(true);
    setPrintPending(true);
  };

  if (!docs) return <div className="loading">Открываю тетрадь…</div>;

  return (
    <div className="documents">
      <aside className="doc-list">
        <button className="btn primary wide" onClick={newDoc}>
          + Новый документ
        </button>
        <button className="btn wide open-doc" onClick={() => openRef.current?.click()} title="Документ, почерк или резервную копию">
          Открыть .json…
        </button>
        <button className="btn wide open-doc" onClick={() => void saveEverything()} title="Почерк, все документы и настройки — одним файлом">
          Резервная копия всего
        </button>
        <input
          ref={openRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openDoc(f);
            e.target.value = '';
          }}
        />
        <ul>
          {docs.map((d) => (
            <li key={d.id} className={d.id === currentId ? 'active' : ''}>
              <button className="doc-link" onClick={() => setCurrentId(d.id)}>
                <span className="doc-title" style={{ fontFamily: HAND_FONT_STACK }}>
                  {d.title || 'Без названия'}
                </span>
                <span className="muted small">{new Date(d.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span>
              </button>
              <button className="doc-delete" onClick={() => void removeDoc(d)} aria-label="Удалить документ" title="Удалить">
                ✕
              </button>
            </li>
          ))}
        </ul>
        {samples.length === 0 && (
          <p className="hint-card">
            Почерк ещё пуст — текст показан системным рукописным шрифтом. Откройте вкладку «Почерк», чтобы написать буквы.
          </p>
        )}
      </aside>

      <main className="doc-main" ref={pageRef}>
        {doc && content && (
          <>
            <div className="toolbar no-print">
              <details className="menu">
                <summary className="btn">Вставить блок ▾</summary>
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

              <button className={`btn push-right ${ink ? 'on' : ''}`} onClick={() => setInk(!ink)} title="Каждая буква уникальна, как на бумаге">
                {ink ? '✎ Редактировать' : '✒ Чернила'}
              </button>

              <details className="menu right">
                <summary className="btn">Экспорт ▾</summary>
                <div className="menu-items">
                  <button onClick={(e) => (closeMenus(e.currentTarget), print())}>
                    <strong>Печать / PDF</strong>
                    <span className="muted small">вместе с блоками</span>
                  </button>
                  <button onClick={(e) => (closeMenus(e.currentTarget), void exportPng(doc.id, doc.title, content, pageWidth(), fontSize, setup.ink))}>
                    <strong>Картинка PNG</strong>
                  </button>
                  <button onClick={(e) => (closeMenus(e.currentTarget), void exportSvg(doc.id, doc.title, content, pageWidth(), fontSize, setup.ink))}>
                    <strong>Вектор SVG</strong>
                  </button>
                  <button disabled={!fontBytes} onClick={(e) => (closeMenus(e.currentTarget), exportFont())}>
                    <strong>Мой шрифт .ttf</strong>
                    <span className="muted small">для Word, Figma и т. п.</span>
                  </button>
                  <button onClick={(e) => (closeMenus(e.currentTarget), exportDocumentJson(doc.title, content))}>
                    <strong>Документ .json</strong>
                  </button>
                </div>
              </details>
            </div>

            {ink ? (
              <InkView
                docId={doc.id}
                title={setup.showTitle ? doc.title : null}
                content={content}
                fontSize={fontSize}
                geo={geo}
                paper={setup.paper}
                ink={setup.ink}
                onRendered={() => {
                  if (printPending) {
                    setPrintPending(false);
                    setTimeout(() => window.print(), 400);
                  }
                }}
              />
            ) : (
              <Paper
                pages={pages}
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
            )}
          </>
        )}
      </main>
    </div>
  );
}
