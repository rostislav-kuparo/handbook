// How «Мои столы» are kept: a desk is a whole export onto photos — every
// photo with its markup and what the analysis found on it, and every setting
// of the dialog. The pictures and masks live apart (`deskPhotos`), so saving
// a change of markup does not write the photos again.
import type { PaperStyle, SheetKind } from '../editor/page';
import type { HandMargins, Margins, Measure, ObjectMask, Ruling, Specular, Tilt } from './analysis';
import type { Angles } from './camera';
import type { InkLook } from './compose';
import type { Pt } from './homography';
import type { FitMode } from './inkLayer';
import type { Grid } from './warp';

/** The paper of a desk: one of the formats, or «свой» (`custom`, mm). */
export type DeskFormat = SheetKind | 'custom';

/** A curved sheet: how its sides bow, the grid of corrections, and whether the grid came from the printed lines or by hand. */
export interface DeskBend {
  bulge: number[][];
  grid: Grid;
  /** The grid was fitted to the printed lines, or moved by hand: do not fit it again. */
  fixed: boolean;
  /** The largest bow of the sides, px. */
  max: number;
  /** How far the printed lines strayed before and after fitting, mm. */
  lines?: { before: number; after: number };
}

export interface SheetChoice {
  kind: DeskFormat;
  /** The size of «свой» format, mm. */
  custom: [number, number];
  /** On squared paper the size is read off the squares (5 mm each), whatever the format. */
  byGrid: boolean;
  /**
   * How the sheet lies: upright, on its side, or as its corners show (the top
   * edge the longer one: on its side) — `auto` reads it only for a document on
   * a blank (a clean sheet has no top of its own). Missing: `auto`.
   */
  orient?: 'auto' | 'portrait' | 'landscape';
  paper: PaperStyle;
  mode: FitMode;
  /** Printed lines per line of text and the letters' size; null: as fits best. */
  every: number | null;
  letters: number | null;
  /** On squares, drawings by them. */
  squares: boolean;
}
export const DEFAULT_SHEET: SheetChoice = { kind: 'a4', custom: [210, 297], byGrid: true, paper: 'plain', mode: 'document', every: null, letters: null, squares: true };

/** What of the ink's look is chosen (the rest is measured on each photo). */
export type SavedLook = Pick<InkLook, 'pen' | 'density' | 'grain' | 'texture'>;
export const DEFAULT_LOOK: SavedLook = { pen: 'ballpoint', density: 0.35, grain: 1, texture: 1 };

/** What the analysis found on a photo, each with the shape of the sheet (and paper) it was found for. */
export interface PhotoFindings {
  ruling: Ruling | null;
  rulingKey: string | null;
  gridSize: [number, number] | null;
  gridKey: string | null;
  measure: Measure | null;
  glare: Specular | null;
  measureKey: string | null;
  /** How the phone was held, by the photo's lines (null: they do not tell); missing: not looked for yet. */
  tilt?: Tilt | null;
}

/** One photo of a desk: its markup and findings. Its picture and mask are in `deskPhotos` under the same id. */
export interface SavedPhoto {
  id: string;
  name: string;
  corners: Pt[];
  snapped: boolean[];
  bend: DeskBend | null;
  /** Margin lines moved by hand, mm (by one number when kept before lines had ends); null: as found. */
  margins: HandMargins | Margins | null;
  /** The corners the mask was found for. */
  maskKey: string | null;
  /** The lens's 35 mm equivalent focal length from the photo's EXIF (the kept JPEG has none), mm. */
  focal35?: number | null;
  /** The camera's turn set by hand for a sheet filling the frame; null or missing: as found (or made up). */
  handTilt?: Angles | null;
  /** The lines it was set by: two across the sheet, two down it ([ax, ay, bx, by]). */
  handLines?: number[][] | null;
  /** Missing: found anew when opened. */
  found?: PhotoFindings;
}

/** The picture and the mask of a photo of a desk. */
export interface DeskPhotoRow {
  id: string;
  deskId: string;
  /** The working-size photo (JPEG). */
  photo: Blob;
  /** Things on the sheet as found and brushed; null: found anew when opened. */
  mask: ObjectMask | null;
}

/** Everything chosen in the dialog for a desk. */
export interface DeskSettings {
  sheet: SheetChoice;
  look: SavedLook;
  /** The blur slider relative to what each photo measured. */
  blurGain: number;
  /** The real pen's colour (transmittance) and stroke width, mm (0: unknown). */
  calib: { t: number[]; mm: number } | null;
  /** All the document's sheets onto one photo, or each onto its own. */
  assign: 'one' | 'each';
  /** Which photo (by number) each sheet of the document goes onto. */
  pageDesk: Record<number, number>;
  /** The photo, the sheet of the document and the step shown. */
  current: number;
  page: number;
  step: number;
  /** How the blank is printed (for documents on a blank; see blank/print.ts); missing in older desks. */
  print?: unknown;
  /** How the photo is taken as (desk/camera.ts); missing in older desks. */
  capture?: unknown;
}

export interface SavedDesk {
  id: string;
  name: string;
  /** A small picture of the first photo for the gallery (JPEG). */
  thumb: Blob;
  photos: SavedPhoto[];
  settings: DeskSettings;
  createdAt: number;
  updatedAt: number;
}

/** A desk as kept before 0.5.5: one photo, with only its paper and pen. */
export interface OldDesk {
  id: string;
  name: string;
  photo: Blob;
  thumb: Blob;
  corners: Pt[];
  snapped: boolean[];
  bend?: DeskBend | null;
  kind: DeskFormat;
  custom?: [number, number];
  byGrid?: boolean;
  paper: PaperStyle;
  margins?: Margins | null;
  mask: ObjectMask | null;
  calib: number[] | null;
  createdAt: number;
  updatedAt: number;
}

export const isOldDesk = (d: object): d is OldDesk => 'photo' in d && !('photos' in d);

/**
 * An old desk as a desk of one photo; what it did not keep is taken from
 * `base` (the settings last used), and it opens on «Чернила».
 */
export function fromOld(old: OldDesk, base: { sheet?: Partial<SheetChoice>; look?: Partial<SavedLook> } = {}): { desk: SavedDesk; row: DeskPhotoRow } {
  const photoId = crypto.randomUUID();
  // The remembered choice carries its version too.
  const { v: _, ...sheet } = (base.sheet ?? {}) as Partial<SheetChoice> & { v?: number };
  const desk: SavedDesk = {
    id: old.id,
    name: old.name,
    thumb: old.thumb,
    photos: [
      {
        id: photoId,
        name: old.name,
        corners: old.corners,
        snapped: old.snapped,
        bend: old.bend ?? null,
        margins: old.margins ?? null,
        maskKey: old.mask ? JSON.stringify(old.corners) : null,
      },
    ],
    settings: {
      sheet: { ...DEFAULT_SHEET, ...sheet, kind: old.kind, paper: old.paper, byGrid: old.byGrid ?? true, custom: old.custom ?? DEFAULT_SHEET.custom },
      look: { ...DEFAULT_LOOK, ...base.look },
      blurGain: 1,
      calib: old.calib ? { t: old.calib, mm: 0 } : null,
      assign: 'one',
      pageDesk: {},
      current: 0,
      page: 0,
      step: 3,
    },
    createdAt: old.createdAt,
    updatedAt: old.updatedAt,
  };
  return { desk, row: { id: photoId, deskId: old.id, photo: old.photo, mask: old.mask } };
}
