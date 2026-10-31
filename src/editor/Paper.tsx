import { createContext, type CSSProperties, type ReactNode } from 'react';
import type { Blank, Rect } from '../blank/blank';
import type { Occupancy } from '../blank/occupancy';
import { DrawPenContext } from '../sketch/SketchFigure';
import { LINE_HEIGHT_EM } from './layout';
import { DEFAULT_PAGE, geometry, stackHeight, type DrawPen, type Geometry, type PaperStyle } from './page';

/** A blank's picture on the first sheet: the blank, where it lies (sheet px) and what to show. */
export interface BlankOnSheet {
  blank: Blank;
  url: string;
  rect: Rect;
  /** What lies on the sheet (printing, drawings, notes), once built. */
  map?: Occupancy | null;
}

/** The blank the open document is written on (node views take points from it), or null. */
export const BlankContext = createContext<BlankOnSheet | null>(null);

/** Number of sheet `index` when the first one is `firstNumber` (null: not numbered). */
export const numberOf = (firstNumber: number | null, index: number) => (firstNumber === null ? null : firstNumber + index);

/** Geometry of the open document's sheets (node views read it for floating blocks). */
export const PageContext = createContext<Geometry>(geometry(DEFAULT_PAGE));

/** CSS variables for the ruling and the pen: line pitch, baseline offset (px) and ink colour. */
export function paperVars(fontSize: number, ink: string): CSSProperties {
  const lh = fontSize * LINE_HEIGHT_EM;
  return {
    fontSize,
    ['--lh' as string]: `${lh}px`,
    // First baseline inside a line box: half-leading + ascent (see layout.ts), plus a hair.
    ['--baseline' as string]: `${fontSize * 1.075 + 2}px`,
    ['--ink-base' as string]: ink,
  };
}

/** One sheet: ruling, squares, plain paper or a blank; margin line; page number (null: none). */
export function Sheet({
  index,
  number,
  geo,
  paper,
  fontSize,
  blank,
  style,
  children,
}: {
  index: number;
  number: number | null;
  geo: Geometry;
  paper: PaperStyle;
  fontSize: number;
  /** The blank printed on this sheet. */
  blank?: BlankOnSheet | null;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const lh = fontSize * LINE_HEIGHT_EM;
  const baseline = fontSize * 1.075 + 2;
  // Squares of half a line, so every text baseline lies on a grid line.
  const cell = lh / 2;
  const mod = (a: number) => ((a % cell) + cell) % cell;
  return (
    <div className="sheet" style={{ width: geo.sheet.w, height: geo.sheet.h, ...style }} data-page={index + 1}>
      {blank && (
        <img
          className="sheet-blank"
          src={blank.url}
          alt=""
          draggable={false}
          style={{ left: blank.rect.x, top: blank.rect.y, width: blank.rect.w, height: blank.rect.h }}
        />
      )}
      {paper === 'ruled' && (
        <div className="sheet-rules" style={{ top: geo.margin.top, height: geo.sheet.h - geo.margin.top - geo.margin.bottom }} />
      )}
      {paper === 'grid' && (
        <div
          className="sheet-grid"
          style={{
            backgroundSize: `${cell}px ${cell}px`,
            backgroundPosition: `${mod(geo.margin.left)}px ${mod(geo.margin.top + baseline)}px`,
          }}
        />
      )}
      {paper !== 'plain' && <div className="sheet-margin" style={{ left: geo.leftLine }} />}
      {paper !== 'plain' && geo.rightLine !== null && <div className="sheet-margin" style={{ left: geo.rightLine }} />}
      {number !== null && (
        <span className="page-number" style={{ bottom: Math.min(28, geo.margin.bottom / 2.5) }}>
          {number}
        </span>
      )}
      {children}
    </div>
  );
}

/**
 * Editing view: a stack of sheets behind one continuous text column. The
 * pagination plugin pushes lines past each bottom margin onto the next sheet.
 */
export function Paper({
  pages,
  firstNumber,
  drawPen,
  fontSize,
  geo,
  paper,
  ink,
  blank,
  zoom = 1,
  children,
  onBlankClick,
}: {
  pages: number;
  /** Number of the first sheet; null: sheets are not numbered. */
  firstNumber: number | null;
  /** What the document's drawings are drawn with. */
  drawPen: DrawPen;
  fontSize: number;
  geo: Geometry;
  paper: PaperStyle;
  ink: string;
  /** The blank the first sheet is (the document is written on). */
  blank?: BlankOnSheet | null;
  /** How close the sheets are looked at (see zoom.ts). */
  zoom?: number;
  children: ReactNode;
  onBlankClick?: () => void;
}) {
  return (
    <PageContext.Provider value={geo}>
      <BlankContext.Provider value={blank ?? null}>
      <DrawPenContext.Provider value={drawPen}>
      <div
        className={`paper-stack ${blank ? 'on-blank' : ''}`}
        style={{ ...paperVars(fontSize, ink), width: geo.sheet.w, height: stackHeight(pages, geo.pitch), zoom: zoom === 1 ? undefined : zoom }}
        onMouseDown={(e) => {
          // A click on empty paper puts the cursor at the end of the text, like Word.
          if ((e.target as HTMLElement).closest('.sheet') && !(e.target as HTMLElement).closest('.sheet-content')) {
            e.preventDefault();
            onBlankClick?.();
          }
        }}
      >
        {Array.from({ length: pages }, (_, i) => (
          <Sheet
            key={i}
            index={i}
            number={numberOf(firstNumber, i)}
            geo={geo}
            paper={paper}
            fontSize={fontSize}
            blank={i === 0 ? blank : null}
            style={{ position: 'absolute', top: i * geo.pitch, left: 0 }}
          />
        ))}
        <div className="sheet-content" style={{ left: geo.margin.left, top: geo.margin.top, width: geo.contentW }}>
          {children}
        </div>
      </div>
      </DrawPenContext.Provider>
      </BlankContext.Provider>
    </PageContext.Provider>
  );
}
