import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BlockFrame } from '../blocks/BlockFrame';
import { engine, type Deal, type ParagraphRender } from '../engine/client';
import { FALLBACK_FONTS, HAND_FONT_STACK } from '../engine/constants';
import { useHandwriting } from '../engine/handwriting';
import type { DocContent } from '../model/types';
import type { SketchLayout } from '../sketch/layout';
import { dealAfter, heightOf, penFor, sketchLayout } from '../sketch/render';
import { DrawPenContext, SketchFigure } from '../sketch/SketchFigure';
import { docSeed, INK_VIEWBOX_TOP, InkPalette, LINE_HEIGHT_EM, LINE_HEIGHT_UNITS, paragraphRuns, topLevelNodes, wordsSeen } from './layout';
import { flowPages, placeFloats } from './inkPages';
import { drawPenOf, SHEET_GAP, SHEET_H, SHEET_W, type DrawPen, type Geometry, type PaperStyle } from './page';
import { numberOf, PageContext, paperVars, Sheet } from './Paper';

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
  onRendered?: () => void;
}

/** Fill for a colour index: 0 is the document pen (theme-aware via CSS), others carry their colour. */
function inkProps(color: number, palette: string[]) {
  return color === 0
    ? { className: 'ink-default' }
    : { className: 'ink-colored', style: { ['--c' as string]: palette[color] ?? palette[0] } };
}

type Runs = ({ text: string; scales: number[]; colors: number[]; shifts: number[] } | null)[];

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
 * and lines are uneven like on real paper. Lines and blocks flow onto A4
 * sheets; this is also what gets printed (one sheet per PDF page).
 */
export function InkView({ docId, title, firstNumber, drawPen, content, fontSize, geo, paper, ink, onRendered }: Props) {
  const { fontVersion, style } = useHandwriting();
  const nodes = useMemo(() => topLevelNodes(content), [content]);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;
  const lh = fontSize * LINE_HEIGHT_EM;
  const titleH = title === null ? 0 : 2 * lh;

  // Text, sizes and colours of every paragraph; the palette maps colour indices to colours.
  const { runs, seen, palette } = useMemo(() => {
    const pal = new InkPalette(ink);
    const runs = nodes.map((n) => (n.type === 'paragraph' ? paragraphRuns(n, pal) : null));
    return { runs, seen: wordsSeen(runs.map((r) => r?.text ?? null)), palette: pal.colors };
  }, [nodes, ink]);
  // Drawings and formulas, whose labels are written in the same run as the text.
  const codes = useMemo(() => nodes.map((n) => (n.attrs?.kind === 'sketch' ? String(n.attrs.code ?? '') : null)), [nodes]);
  const key = useMemo(
    () => JSON.stringify([docId, runs, codes, fontSize, geo.contentW, style.sag, style.lineJitter]),
    [docId, runs, codes, fontSize, geo.contentW, style.sag, style.lineJitter],
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
        codes[i] === null ? null : sketchLayout(codes[i], geo.contentW, fontSize, penFor(style, fontSize, drawPenOf(drawPen, n.attrs?.pen))),
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

  const rewrite = () => {
    acceptHand.current = -1;
    setStale(false);
    setRedo((n) => n + 1);
  };

  // Flow lines and blocks onto sheets (the PNG/SVG export uses the same layout).
  // A drawing knows its height before it is drawn; an HTML block reports it once loaded.
  const pages = useMemo(
    () =>
      flowPages(
        nodes,
        (i) => renders[i]?.lines ?? 1,
        (i) => (nodes[i].attrs?.kind === 'sketch' ? heightOf(String(nodes[i].attrs?.code ?? ''), geo.contentW, fontSize) : blockHeights[i] ?? 260),
        lh,
        titleH,
        geo.contentH,
      ),
    [nodes, renders, blockHeights, lh, titleH, geo.contentH, geo.contentW, fontSize],
  );
  const floats = placeFloats(nodes, geo, titleH);
  const pageCount = Math.max(pages.length, ...floats.map((f) => f.page + 1));
  const missing = [...new Set(renders.flatMap((r) => r?.missing ?? []))];

  return (
    <PageContext.Provider value={geo}>
      <DrawPenContext.Provider value={drawPen}>
      <div ref={stackRef} className="ink-stack" style={{ ...paperVars(fontSize, ink), width: SHEET_W }}>
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
            style={{ position: 'relative', height: SHEET_H, marginBottom: SHEET_GAP }}
          >
            <div className="sheet-content" style={{ left: geo.margin.left, top: geo.margin.top, width: geo.contentW, height: geo.contentH }}>
              {p === 0 && title !== null && (
                <div className="page-title ink-title" style={{ fontFamily: HAND_FONT_STACK }}>
                  {title}
                </div>
              )}
              {(pages[p] ?? []).map((it) => {
                if (it.kind === 'block') {
                  const a = nodes[it.node].attrs ?? {};
                  if (a.kind === 'sketch') {
                    return (
                      <div key={`b${it.node}`} className="ink-block" style={{ top: it.y }}>
                        <SketchFigure code={String(a.code ?? '')} pen={a.pen} width={geo.contentW} fontSize={fontSize} deal={deals[it.node] ?? null} />
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
                if (!r) return null;
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
                      .map((f, k) => (
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
                      ))}
                  </svg>
                );
              })}
            </div>
            {floats
              .filter((f) => f.page === p)
              .map((f) => (
                <div key={`f${f.i}`} className="ink-float" style={{ top: f.top, left: f.left, width: f.width }}>
                  {f.attrs.kind === 'sketch' ? (
                    <SketchFigure code={String(f.attrs.code ?? '')} pen={f.attrs.pen} width={f.width} fontSize={fontSize} deal={deals[f.i] ?? null} />
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
