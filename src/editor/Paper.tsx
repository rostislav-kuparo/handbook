import { createContext, type CSSProperties, type ReactNode } from 'react';
import { LINE_HEIGHT_EM } from './layout';
import { DEFAULT_PAGE, geometry, PITCH, SHEET_H, SHEET_W, stackHeight, type Geometry, type PaperStyle } from './page';

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

/** One A4 sheet: ruling, squares or plain paper; margin line; page number. */
export function Sheet({
  index,
  geo,
  paper,
  fontSize,
  style,
  children,
}: {
  index: number;
  geo: Geometry;
  paper: PaperStyle;
  fontSize: number;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const lh = fontSize * LINE_HEIGHT_EM;
  const baseline = fontSize * 1.075 + 2;
  // Squares of half a line, so every text baseline lies on a grid line.
  const cell = lh / 2;
  const mod = (a: number) => ((a % cell) + cell) % cell;
  return (
    <div className="sheet" style={style} data-page={index + 1}>
      {paper === 'ruled' && (
        <div className="sheet-rules" style={{ top: geo.margin.top, height: SHEET_H - geo.margin.top - geo.margin.bottom }} />
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
      {paper !== 'plain' && <div className="sheet-margin" style={{ left: geo.margin.left - 14 }} />}
      <span className="page-number" style={{ bottom: Math.min(28, geo.margin.bottom / 2.5) }}>
        {index + 1}
      </span>
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
  fontSize,
  geo,
  paper,
  ink,
  children,
  onBlankClick,
}: {
  pages: number;
  fontSize: number;
  geo: Geometry;
  paper: PaperStyle;
  ink: string;
  children: ReactNode;
  onBlankClick?: () => void;
}) {
  return (
    <PageContext.Provider value={geo}>
      <div
        className="paper-stack"
        style={{ ...paperVars(fontSize, ink), width: SHEET_W, height: stackHeight(pages) }}
        onMouseDown={(e) => {
          // A click on empty paper puts the cursor at the end of the text, like Word.
          if ((e.target as HTMLElement).closest('.sheet') && !(e.target as HTMLElement).closest('.sheet-content')) {
            e.preventDefault();
            onBlankClick?.();
          }
        }}
      >
        {Array.from({ length: pages }, (_, i) => (
          <Sheet key={i} index={i} geo={geo} paper={paper} fontSize={fontSize} style={{ position: 'absolute', top: i * PITCH, left: 0 }} />
        ))}
        <div className="sheet-content" style={{ left: geo.margin.left, top: geo.margin.top, width: geo.contentW }}>
          {children}
        </div>
      </div>
    </PageContext.Provider>
  );
}
