import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BLANK_LETTERS } from '../blank/letterSize';
import { noteFontSize, noteSeed } from '../blank/note';
import { NoteInk } from '../blank/NoteInk';
import { isRomanChar, romanPath, romanPen } from '../blank/roman';
import { BlockFrame } from '../blocks/BlockFrame';
import { engine, type Deal, type ParagraphRender } from '../engine/client';
import { FALLBACK_FONTS, HAND_FONT_STACK } from '../engine/constants';
import { useHandwriting } from '../engine/handwriting';
import type { DocContent } from '../model/types';
import type { SketchLayout } from '../sketch/layout';
import { dealAfter, heightOf, penFor, sketchLayout } from '../sketch/render';
import { DrawPenContext, SketchFigure } from '../sketch/SketchFigure';
import { docSeed, INK_VIEWBOX_TOP, InkPalette, LINE_HEIGHT_EM, LINE_HEIGHT_UNITS, paragraphRuns, topLevelNodes, wordsSeen } from './layout';
import { breaksOf, type NodeLayout } from './docLayout';
import { flowPages, layoutPages, placeFloats } from './inkPages';
import { A4, drawPenOf, MM, SHEET_GAP, type DrawPen, type Geometry, type PaperStyle } from './page';
import { numberOf, PageContext, paperVars, Sheet, type BlankOnSheet } from './Paper';
import { documentPages, mix32, type PageExport } from './exporters';
import { wearCanvas, type WearSettings, type WorkMap } from '../wear/wear';
import { reliefOf, shadeOverlay } from '../wear/relief';

interface Props {
  docId: string;
  /** Title on top of the first sheet; null when the document hides it. */
  title: string | null;
  /** Number of the first sheet; null: sheets are not numbered. */
  firstNumber: number | null;
  /** What the document's drawings are drawn with. */
  drawPen: DrawPen;
  content: DocContent;
  fontSize: number;
  geo: Geometry;
  paper: PaperStyle;
  ink: string;
  /** Where the editor put the lines (measured for this text and page), or null: laid out here. */
  layout: (NodeLayout | null)[] | null;
  /** The blank the first sheet is printed with. */
  blank?: BlankOnSheet | null;
  /** How close the sheets are looked at (see zoom.ts); printing ignores it. */
  zoom?: number;
  /** Printed shrunk this much, each page whole (a blank printed «по размеру листа»). */
  printShrink?: number;
  /** Traces of work over the sheets: how they look, and the document as the export sees it (where its lines are). */
  wear?: { settings: WearSettings; source: () => PageExport } | null;
  onRendered?: () => void;
}

/** Pixels per sheet px of the traces on screen (they are printed from here too). */
const SCREEN_WEAR_SCALE = 2;

/** Fill for a colour index: 0 is the document pen (theme-aware via CSS), others carry their colour. */
function inkProps(color: number, palette: string[]) {
  return color === 0
    ? { className: 'ink-default' }
    : { className: 'ink-colored', style: { ['--c' as string]: palette[color] ?? palette[0] } };
}

/** Every paragraph's text and styles, and where its lines break (as in the editor; empty: by width). */
type Runs = ({ text: string; scales: number[]; colors: number[]; shifts: number[]; breaks: number[] } | null)[];

/**
 * A render of a document. Kept while the program runs, so going to «Почерк»
 * and back (or to editing and back without changes) shows the same sheets at
 * once, and a render left unfinished goes on in the background.
 */
interface InkJob {
  /** What it is written from: the document, its paragraphs, size, width and line knobs. */
  key: string;
  /** The handwriting it is written in (font build counter). */
  hand: number;
  /** Every paragraph's ink once done; null while writing. */
  renders: (ParagraphRender | null)[] | null;
  /** Per drawing (by node), the letter variants used last before it: its labels go on from there. */
  deals: (Deal | null)[];
  progress: number;
  cancelled: boolean;
  listeners: Set<() => void>;
}

/** The latest render per document, the most recently used last (a few documents are kept). */
const jobs = new Map<string, InkJob>();
const KEPT_RENDERS = 6;
/** Where the reader was in each rendered document, and how tall its HTML blocks turned out. */
const places = new Map<string, { scrollTop: number; blockHeights: Record<number, number> }>();

function keep(docId: string, job: InkJob) {
  jobs.delete(docId);
  jobs.set(docId, job);
  for (const id of jobs.keys()) {
    if (jobs.size <= KEPT_RENDERS) break;
    jobs.delete(id);
  }
}

/**
 * Writes a document paragraph by paragraph, in reading order: each goes on with
 * the variants the text before left unused — the labels of drawings and
 * formulas (`drawings`, by node) in between too — and between paragraphs the
 * worker can answer the studio.
 */
function startJob(
  docId: string,
  key: string,
  hand: number,
  runs: Runs,
  seen: Record<string, number>[],
  drawings: (SketchLayout | null)[],
  unitsWidth: number,
): InkJob {
  const old = jobs.get(docId);
  if (old && !old.renders) old.cancelled = true;
  const job: InkJob = { key, hand, renders: null, deals: [], progress: 0, cancelled: false, listeners: new Set() };
  keep(docId, job);
  const notify = () => job.listeners.forEach((l) => l());
  const total = Math.max(1, runs.reduce((a, r) => a + (r ? r.text.length + 1 : 0), 0));
  const out: (ParagraphRender | null)[] = [];
  void (async () => {
    let done = 0;
    let deal: Deal | undefined;
    for (const [i, r] of runs.entries()) {
      if (job.cancelled) return;
      const drawing = drawings[i];
      if (drawing) {
        job.deals[i] = deal ?? {};
        deal = await dealAfter(drawing, deal ?? {});
      }
      const res = r
        ? await engine.renderParagraph(r.text, unitsWidth, LINE_HEIGHT_UNITS, docSeed(docId), {
            scales: r.scales,
            colors: r.colors,
            shifts: r.shifts,
            seen: seen[i],
            deal,
            breaks: r.breaks,
          })
        : null;
      if (res) deal = res.deal;
      out.push(res);
      done += r ? r.text.length + 1 : 0;
      job.progress = done / total;
      notify();
    }
  })()
    .catch((err) => console.error(err))
    .finally(() => {
      if (job.cancelled) return;
      job.renders = runs.map((_, i) => out[i] ?? null);
      notify();
    });
  return job;
}

/**
 * "Ink" mode: every letter is a unique synthesized instance (not a font glyph)
 * and lines are uneven like on real paper. Lines and blocks flow onto the
 * sheets (A4, or a blank's paper); this is also what gets printed (one sheet
 * per PDF page).
 */
export function InkView({ docId, title, firstNumber, drawPen, content, fontSize, geo, paper, ink, layout: measured, blank, zoom = 1, printShrink = 1, wear, onRendered }: Props) {
  const { fontVersion, style } = useHandwriting();
  const nodes = useMemo(() => topLevelNodes(content), [content]);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;
  const lh = fontSize * LINE_HEIGHT_EM;
  // Drawings on a blank write their labels as big as the blank's letters, not the text's.
  const sketchFs = blank ? noteFontSize(blank.blank.letters ?? BLANK_LETTERS) : fontSize;
  const titleH = title === null ? 0 : 2 * lh;

  // The editor's lines, when they belong to these nodes.
  const layout = measured && measured.length === nodes.length ? measured : null;
  // Text, sizes, colours and line breaks of every paragraph; the palette maps colour indices to colours.
  const { runs, seen, palette } = useMemo(() => {
    const pal = new InkPalette(ink);
    const runs = nodes.map((n, i) => (n.type === 'paragraph' ? { ...paragraphRuns(n, pal), breaks: breaksOf(layout?.[i]) } : null));
    return { runs, seen: wordsSeen(runs.map((r) => r?.text ?? null)), palette: pal.colors };
  }, [nodes, ink, layout]);
  // Drawings and formulas, whose labels are written in the same run as the text.
  const codes = useMemo(() => nodes.map((n) => (n.attrs?.kind === 'sketch' ? String(n.attrs.code ?? '') : null)), [nodes]);
  // The drawings' pens too: they move the lines, and the labels with them.
  const pens = useMemo(() => JSON.stringify([drawPen, nodes.map((n) => (n.attrs?.kind === 'sketch' ? (n.attrs.pen ?? null) : null))]), [drawPen, nodes]);
  const key = useMemo(
    () => JSON.stringify([docId, runs, codes, fontSize, sketchFs, geo.contentW, style.sag, style.lineJitter, pens]),
    [docId, runs, codes, fontSize, sketchFs, geo.contentW, style.sag, style.lineJitter, pens],
  );

  // A render kept from before (the same text and page) is shown at once — also in an older
  // handwriting: then the reader is told and decides when to write it anew.
  const kept = jobs.get(docId);
  const [renders, setRenders] = useState<(ParagraphRender | null)[]>(() => (kept?.key === key && kept.renders) || []);
  const [deals, setDeals] = useState<(Deal | null)[]>(() => (kept?.key === key && kept.renders && kept.deals) || []);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(!(kept?.key === key && kept.renders));
  const [stale, setStale] = useState(false);
  const [blockHeights, setBlockHeights] = useState<Record<number, number>>(() => (kept?.key === key && places.get(docId)?.blockHeights) || {});
  /** The handwriting an older render may stay in: the one there was when the view opened, until «Перерисовать». */
  const acceptHand = useRef(fontVersion);
  const [redo, setRedo] = useState(0);
  const stackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unitsWidth = (geo.contentW / fontSize) * 1000;
    let job = jobs.get(docId);
    const reuse = job && job.key === key && (job.hand === fontVersion || (fontVersion === acceptHand.current && job.renders !== null));
    if (!job || !reuse) {
      const drawings = nodes.map((n, i) =>
        codes[i] === null ? null : sketchLayout(codes[i], geo.contentW, sketchFs, penFor(style, sketchFs, drawPenOf(drawPen, n.attrs?.pen))),
      );
      job = startJob(docId, key, fontVersion, runs, seen, drawings, unitsWidth);
    }
    else keep(docId, job);
    const current = job;
    let done = false;
    const update = () => {
      setProgress(current.progress);
      if (!current.renders || done) return;
      done = true;
      setRenders(current.renders);
      setDeals(current.deals);
      setBusy(false);
      setStale(current.hand !== fontVersion);
      requestAnimationFrame(() => onRenderedRef.current?.());
    };
    setBusy(!current.renders);
    current.listeners.add(update);
    update();
    return () => {
      current.listeners.delete(update);
    };
  }, [key, fontVersion, redo]);

  // Back where the reader left the document after going to «Почерк» (the page opens at its top
  // then; switching from editing keeps the place the editor was at). Remembered when the view closes.
  useLayoutEffect(() => {
    const scroller = stackRef.current?.closest('.doc-main');
    const at = places.get(docId)?.scrollTop;
    if (scroller && at !== undefined && scroller.scrollTop === 0 && renders.length > 0) scroller.scrollTop = at;
    return () => {
      places.set(docId, { scrollTop: scroller?.scrollTop ?? 0, blockHeights: places.get(docId)?.blockHeights ?? {} });
    };
  }, [docId]);
  useEffect(() => {
    places.set(docId, { scrollTop: places.get(docId)?.scrollTop ?? 0, blockHeights });
  }, [docId, blockHeights]);

  // The traces of work: where the sheets' letters and lines are, found by laying the document out as the
  // export does (once the writing is done), then drawn sheet by sheet.
  const [traces, setTraces] = useState<{ rubbed: string | null; creases: string | null }[]>([]);
  const show = wear?.settings.show;
  const wearKey = wear?.settings.on
    ? JSON.stringify([key, fontVersion, { ...wear.settings, show: undefined, printer: undefined, printerSeed: undefined }, show?.wear, show?.folds, blank?.blank.id ?? null, geo.sheet])
    : '';
  const wearSource = useRef(wear?.source);
  wearSource.current = wear?.source;
  useEffect(() => {
    if (!wearKey || busy || !wear) {
      setTraces([]);
      return;
    }
    let alive = true;
    const stop = new AbortController();
    const settings = wear.settings;
    const timer = setTimeout(() => {
      const source = wearSource.current?.();
      if (!source) return;
      const work: WorkMap[] = [];
      void documentPages({ ...source, wear: null }, { inkOnly: true, work, signal: stop.signal })
        .then(() => {
          if (!alive) return;
          setTraces(
            work.map((w, p) => {
              const seed = mix32(docSeed(docId), p);
              const relief = reliefOf(geo.sheet, settings, seed, w.pivots);
              return {
                rubbed: settings.show.wear ? wearCanvas(w, geo.sheet, SCREEN_WEAR_SCALE, settings, seed).toDataURL('image/png') : null,
                creases: relief.flat ? null : shadeOverlay(relief).toDataURL('image/png'),
              };
            }),
          );
        })
        .catch((err) => alive && console.error(err));
    }, 300);
    return () => {
      alive = false;
      stop.abort();
      clearTimeout(timer);
    };
  }, [wearKey, busy]);

  const rewrite = () => {
    acceptHand.current = -1;
    setStale(false);
    setRedo((n) => n + 1);
  };

  // Flow lines and blocks onto sheets (the PNG/SVG export uses the same layout).
  // A drawing knows its height before it is drawn; an HTML block reports it once loaded.
  // Where the editor put them, when it is known.
  const pages = useMemo(
    () =>
      layout
        ? layoutPages(nodes, layout, (i) => renders[i]?.lines ?? 1, lh)
        : flowPages(
            nodes,
            (i) => renders[i]?.lines ?? 1,
            (i) => (nodes[i].attrs?.kind === 'sketch' ? heightOf(String(nodes[i].attrs?.code ?? ''), geo.contentW, sketchFs) : blockHeights[i] ?? 260),
            lh,
            titleH,
            geo.contentH,
          ),
    [nodes, layout, renders, blockHeights, lh, titleH, geo.contentH, geo.contentW, sketchFs],
  );
  const floats = placeFloats(nodes, geo, titleH);
  const pageCount = Math.max(pages.length, ...floats.map((f) => f.page + 1));
  const missing = [...new Set(renders.flatMap((r) => r?.missing ?? []))];
  // Printed one sheet per page of the sheet's own size (a blank may be landscape).
  const mm = (px: number) => `${Math.round((px / MM) * 10) / 10}mm`;
  const printSize = { ['--print-w' as string]: mm(geo.sheet.w), ['--print-h' as string]: mm(geo.sheet.h) };
  const a4 = Math.abs(geo.sheet.w - A4.w) < 1 && Math.abs(geo.sheet.h - A4.h) < 1;

  return (
    <PageContext.Provider value={geo}>
      <DrawPenContext.Provider value={drawPen}>
      <div ref={stackRef} className="ink-stack" style={{ ...paperVars(fontSize, ink), ...printSize, width: geo.sheet.w, zoom: zoom === 1 ? undefined : zoom }}>
        {!a4 && <style>{`@media print { @page { size: ${mm(geo.sheet.w)} ${mm(geo.sheet.h)}; } }`}</style>}
        {printShrink < 1 && <style>{`@media print { .ink-stack .sheet { transform: scale(${printShrink}); transform-origin: 50% 50%; } }`}</style>}
        {stale && !busy && (
          <div className="ink-progress ink-stale no-print" role="status">
            <span>Почерк изменился после этого рендера.</span>
            <button className="btn primary" onClick={rewrite}>
              Перерисовать
            </button>
          </div>
        )}
        {busy && (
          <div className="ink-progress no-print" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
            <span>Пишу от руки… {Math.round(progress * 100)}%</span>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        )}
        {Array.from({ length: pageCount }, (_, p) => (
          <Sheet
            key={p}
            index={p}
            number={numberOf(firstNumber, p)}
            geo={geo}
            paper={paper}
            fontSize={fontSize}
            blank={p === 0 && show?.print !== false ? blank : null}
            style={{ position: 'relative', marginBottom: SHEET_GAP }}
          >
            {traces[p]?.creases && <img className="sheet-wear sheet-creases" src={traces[p].creases!} alt="" draggable={false} />}
            {traces[p]?.rubbed && <img className="sheet-wear" src={traces[p].rubbed!} alt="" draggable={false} />}
            <div className="sheet-content" style={{ left: geo.margin.left, top: geo.margin.top, width: geo.contentW, height: geo.contentH }}>
              {p === 0 && title !== null && show?.text !== false && (
                <div className="page-title ink-title" style={{ fontFamily: HAND_FONT_STACK }}>
                  {title}
                </div>
              )}
              {(pages[p] ?? []).map((it) => {
                if (it.kind === 'block') {
                  const a = nodes[it.node].attrs ?? {};
                  if (a.kind === 'sketch') {
                    if (show?.drawings === false) return null;
                    return (
                      <div key={`b${it.node}`} className="ink-block" style={{ top: it.y }}>
                        <SketchFigure code={String(a.code ?? '')} pen={a.pen} width={geo.contentW} fontSize={sketchFs} deal={deals[it.node] ?? null} />
                      </div>
                    );
                  }
                  return (
                    <div key={`b${it.node}`} className="ink-block" style={{ top: it.y }}>
                      <BlockFrame
                        code={String(a.code ?? '')}
                        data={a.data}
                        title={String(a.title ?? 'Блок')}
                        onHeight={(h) => setBlockHeights((m) => (m[it.node] === h ? m : { ...m, [it.node]: h }))}
                      />
                    </div>
                  );
                }
                const r = renders[it.para];
                if (!r || show?.text === false) return null;
                return (
                  <svg
                    key={`l${it.para}-${it.line}`}
                    className="ink-line"
                    style={{ top: it.y, height: lh }}
                    viewBox={`0 ${INK_VIEWBOX_TOP + it.line * LINE_HEIGHT_UNITS} ${r.width} ${LINE_HEIGHT_UNITS}`}
                    preserveAspectRatio="xMinYMin meet"
                  >
                    {(r.lineD[it.line] ?? []).map((part) => (
                      <path key={part.color} d={part.d} {...inkProps(part.color, palette)} />
                    ))}
                    {r.fallback
                      .filter((f) => f.line === it.line)
                      .map((f, k) =>
                        isRomanChar(f.ch) ? (
                          // A Roman numeral's letter as sticks.
                          <path
                            key={k}
                            d={romanPath(f.ch, f.x, f.y, f.scale, docSeed(docId) + it.line * 131 + k)}
                            fill="none"
                            stroke={f.color === 0 ? 'currentColor' : (palette[f.color] ?? 'currentColor')}
                            strokeWidth={romanPen(style.weight) * f.scale}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        ) : (
                        <text
                          key={k}
                          x={f.x}
                          y={f.y}
                          fontFamily={FALLBACK_FONTS}
                          fontSize={1000 * f.scale}
                          {...inkProps(f.color, palette)}
                          opacity={0.7}
                        >
                          {f.ch}
                        </text>
                        ),
                      )}
                  </svg>
                );
              })}
            </div>
            {floats
              .filter((f) => f.page === p)
              .filter((f) => (f.attrs.kind === 'sketch' ? show?.drawings !== false : f.attrs.kind !== 'note' || show?.text !== false))
              .map((f) => (
                <div key={`f${f.i}`} className="ink-float" style={{ top: f.top, left: f.left, width: f.width }}>
                  {f.attrs.kind === 'note' ? (
                    <NoteInk
                      text={String(f.attrs.code ?? '')}
                      size={Number(f.attrs.size)}
                      width={f.width}
                      seed={noteSeed(docSeed(docId), f.i)}
                      flip={(f.attrs.data as { roman?: number[] } | null)?.roman ?? []}
                    />
                  ) : f.attrs.kind === 'sketch' ? (
                    <SketchFigure code={String(f.attrs.code ?? '')} pen={f.attrs.pen} width={f.width} fontSize={sketchFs} deal={deals[f.i] ?? null} sheetMap={blank?.map} />
                  ) : (
                    <BlockFrame code={String(f.attrs.code ?? '')} data={f.attrs.data} title={String(f.attrs.title ?? 'Блок')} />
                  )}
                </div>
              ))}
          </Sheet>
        ))}
        {missing.length > 0 && (
          <p className="ink-missing no-print">Ещё не написаны (показаны обычным шрифтом): {missing.join(' ')}</p>
        )}
      </div>
      </DrawPenContext.Provider>
    </PageContext.Provider>
  );
}
