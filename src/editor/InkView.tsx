import { useEffect, useMemo, useRef, useState } from 'react';
import { BlockFrame } from '../blocks/BlockFrame';
import { engine, ParagraphRender } from '../engine/client';
import { FALLBACK_FONTS, HAND_FONT_STACK } from '../engine/constants';
import { useHandwriting } from '../engine/handwriting';
import type { DocContent } from '../model/types';
import { docSeed, INK_VIEWBOX_TOP, InkPalette, LINE_HEIGHT_EM, LINE_HEIGHT_UNITS, paragraphRuns, topLevelNodes } from './layout';
import { PITCH, SHEET_GAP, SHEET_H, SHEET_W, type Geometry, type PaperStyle } from './page';
import { PageContext, paperVars, Sheet } from './Paper';

interface Props {
  docId: string;
  /** Title on top of the first sheet; null when the document hides it. */
  title: string | null;
  content: DocContent;
  fontSize: number;
  geo: Geometry;
  paper: PaperStyle;
  ink: string;
  onRendered?: () => void;
}

type Item = { kind: 'line'; para: number; line: number } | { kind: 'block'; node: number };
type Placed = Item & { y: number };

/** Fill for a colour index: 0 is the document pen (theme-aware via CSS), others carry their colour. */
function inkProps(color: number, palette: string[]) {
  return color === 0
    ? { className: 'ink-default' }
    : { className: 'ink-colored', style: { ['--c' as string]: palette[color] ?? palette[0] } };
}

/**
 * "Ink" mode: every letter is a unique synthesized instance (not a font glyph)
 * and lines are uneven like on real paper. Lines and blocks flow onto A4
 * sheets; this is also what gets printed (one sheet per PDF page).
 */
export function InkView({ docId, title, content, fontSize, geo, paper, ink, onRendered }: Props) {
  const [renders, setRenders] = useState<(ParagraphRender | null)[]>([]);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(true);
  const [blockHeights, setBlockHeights] = useState<Record<number, number>>({});
  const { fontVersion, style } = useHandwriting();
  const nodes = useMemo(() => topLevelNodes(content), [content]);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;
  const lh = fontSize * LINE_HEIGHT_EM;
  const titleH = title === null ? 0 : 2 * lh;

  // Text, sizes and colours of every paragraph; the palette maps colour indices to colours.
  const { runs, palette } = useMemo(() => {
    const pal = new InkPalette(ink);
    return { runs: nodes.map((n) => (n.type === 'paragraph' ? paragraphRuns(n, pal) : null)), palette: pal.colors };
  }, [nodes, ink]);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setProgress(0);
    const unitsWidth = (geo.contentW / fontSize) * 1000;
    const total = Math.max(1, runs.reduce((a, r) => a + (r ? r.text.length + 1 : 0), 0));
    let done = 0;
    Promise.all(
      runs.map((r) =>
        r
          ? engine
              .renderParagraph(r.text, unitsWidth, LINE_HEIGHT_UNITS, docSeed(docId), { scales: r.scales, colors: r.colors, shifts: r.shifts })
              .then((out) => {
                done += r.text.length + 1;
                if (alive) setProgress(done / total);
                return out;
              })
          : Promise.resolve(null),
      ),
    ).then((out) => {
      if (!alive) return;
      setRenders(out);
      setBusy(false);
      requestAnimationFrame(() => onRenderedRef.current?.());
    });
    return () => {
      alive = false;
    };
  }, [runs, fontSize, fontVersion, docId, style.sag, style.lineJitter, geo.contentW]);

  // Flow lines and blocks onto sheets. Page 1 starts below the two-line title (if shown).
  const pages = useMemo(() => {
    const out: Placed[][] = [[]];
    let y = titleH;
    const place = (item: Item, h: number) => {
      if (y > 0 && y + h > geo.contentH + 0.5 && h <= geo.contentH) {
        out.push([]);
        y = 0;
      }
      out[out.length - 1].push({ ...item, y });
      y += h;
    };
    nodes.forEach((n, i) => {
      if (n.type === 'htmlBlock') {
        if (n.attrs?.float) return;
        place({ kind: 'block', node: i }, Math.ceil((blockHeights[i] ?? 260) / lh - 0.001) * lh);
      } else {
        const lines = renders[i]?.lines ?? 1;
        for (let k = 0; k < lines; k++) place({ kind: 'line', para: i, line: k }, lh);
      }
    });
    return out;
  }, [nodes, renders, blockHeights, lh, titleH, geo.contentH]);

  // Floating blocks keep the position they have over the editor's text column.
  const floats = nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.type === 'htmlBlock' && n.attrs?.float)
    .map(({ n, i }) => {
      const a = n.attrs ?? {};
      const stackY = geo.margin.top + titleH + Number(a.y ?? 0);
      let page = Math.max(0, Math.floor(stackY / PITCH));
      // A block whose top falls into the gap between sheets goes to the next sheet (print clips sheets).
      if (stackY - page * PITCH > SHEET_H - 40) page += 1;
      const top = Math.max(0, stackY - page * PITCH);
      return { i, a, page, top, left: geo.margin.left + Number(a.x ?? 0), width: Number(a.w ?? 360) };
    });
  const pageCount = Math.max(pages.length, ...floats.map((f) => f.page + 1));
  const missing = [...new Set(renders.flatMap((r) => r?.missing ?? []))];

  return (
    <PageContext.Provider value={geo}>
      <div className="ink-stack" style={{ ...paperVars(fontSize, ink), width: SHEET_W }}>
        {busy && (
          <div className="ink-progress no-print" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
            <span>Пишу от руки… {Math.round(progress * 100)}%</span>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        )}
        {Array.from({ length: pageCount }, (_, p) => (
          <Sheet key={p} index={p} geo={geo} paper={paper} fontSize={fontSize} style={{ position: 'relative', height: SHEET_H, marginBottom: SHEET_GAP }}>
            <div className="sheet-content" style={{ left: geo.margin.left, top: geo.margin.top, width: geo.contentW, height: geo.contentH }}>
              {p === 0 && title !== null && (
                <div className="page-title ink-title" style={{ fontFamily: HAND_FONT_STACK }}>
                  {title}
                </div>
              )}
              {(pages[p] ?? []).map((it) => {
                if (it.kind === 'block') {
                  const a = nodes[it.node].attrs ?? {};
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
                  <BlockFrame code={String(f.a.code ?? '')} data={f.a.data} title={String(f.a.title ?? 'Блок')} />
                </div>
              ))}
          </Sheet>
        ))}
        {missing.length > 0 && (
          <p className="ink-missing no-print">Ещё не написаны (показаны обычным шрифтом): {missing.join(' ')}</p>
        )}
      </div>
    </PageContext.Provider>
  );
}
