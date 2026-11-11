import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { mix32, newMemo, type PageExport } from '../editor/exporters';
import { docSeed } from '../editor/layout';
import { printerLook } from '../blank/printer';
import { reliefOf } from '../wear/relief';
import { saveWear, useWear } from '../wear/settings';
import type { PrinterKind } from '../wear/wear';
import { MM, SHEET_KINDS, type PageSetup, type PaperStyle, type SheetKind } from '../editor/page';
import { LINE_HEIGHT_EM } from '../editor/layout';
import { getHandwriting } from '../engine/handwriting';
import { printShrinkOf, type Blank } from '../blank/blank';
import { DEFAULT_PRINT, printChoice, tonerRaster, uprightTurn, type PrintChoice } from '../blank/print';
import { db, getSetting, setSetting } from '../storage/db';
import { exportFolder, safeFilename, saveFile } from '../util/download';
import { useLive } from '../util/useLive';
import { Analyzer, marginLines, NO_MARGINS, type HandMargins, type Margins, type Measure, type ObjectMask, type Ruling, type Specular, type Tilt } from './analysis';
import { CornerEditor } from './CornerEditor';
import { Hint, LayoutProgress, PhotoStrip, Pill, SavedThumb, Section, Toasts, Tool, type Message } from './DeskParts';
import { oneToOne, ResultView, type Fit } from './ResultView';
import { CropBox, fitAspect, within, type Crop } from './CropBox';
import { FIT, type View } from './view';
import {
  ActualIcon,
  AgainIcon,
  BrushIcon,
  ClearIcon,
  CloseIcon,
  CropIcon,
  CurveIcon,
  DotIcon,
  EraseIcon,
  FindSheetIcon,
  MarginsIcon,
  PipetteIcon,
  RotatePhotoIcon,
  ScanIcon,
  TurnIcon,
} from '../ui/icons';
import {
  anglesOf,
  cameraCorners,
  captureOf,
  completeCorners,
  coverCorners,
  DEFAULT_CAPTURE,
  describeTilt,
  fillsFrame,
  FLAT_TILT,
  focalPx,
  inPlaneOf,
  lensOf,
  lightFrom,
  lightSpread,
  madeUpAngles,
  rotOf,
  scannerLook,
  sidesBeyond,
  startLines,
  SURE_TILT,
  tiltOf,
  turnByLines,
  wavesOf,
  type Angles,
  type Capture,
} from './camera';
import { DEFAULT_PHOTO_LOOK, DeskRenderer, STAGES, type InkLook, type PenKind, type PhotoLook, type Stage } from './compose';
import { DEFAULT_LOOK, DEFAULT_SHEET } from './deskFormat';
import {
  deleteDesk,
  jpeg,
  listDesks,
  openDesk,
  writeDesk,
  type DeskBend,
  type DeskFormat,
  type DeskPhotoRow,
  type DeskSettings,
  type SavedDesk,
  type SavedLook,
  type SavedPhoto,
  type SheetChoice,
} from './desks';
import { isConvexClockwise, type Mat3, type Pt } from './homography';
import {
  blankLayout,
  inkLayout,
  isA4,
  linesOf,
  marginsPx,
  paperSize,
  pageScale,
  pixelsPerMm,
  placement,
  placeOn,
  rasterize,
  rasterizePen,
  rasterScale,
  freeCanvases,
  type InkLayout,
} from './inkLayer';
import { MaskEditor, type Brush, type MaskTool } from './MaskEditor';
import { loadPhoto, WORK_SIDE, type Photo } from './photo';
import { gridAt, warpMap, zeroGrid, type Warp } from './warp';
import { bowOfCubic, spline, type Bow } from './bow';

const LOOK_KEY = 'desk.ink';
const SHEET_KEY = 'desk.sheet';
const PRINT_KEY = 'desk.print';
const CAPTURE_KEY = 'desk.capture';
/** Blur when a photo's edges tell nothing. */
const FALLBACK_BLUR = 0.7;
/** How often the layout's progress is shown, ms: every change redraws the whole dialog. */
const PROGRESS_EVERY = 250;
/** Scanner looks kept at once: each is a copy of a whole photo. */
const SCANS_KEPT = 4;

/** Version of the remembered choice: before 2 «подогнать под лист» was the default and is not kept. */
const SHEET_VERSION = 2;

const formatMm = (s: SheetChoice): [number, number] => (s.kind === 'custom' ? s.custom : SHEET_KINDS[s.kind].mm);

const SIDES: [keyof Margins, string][] = [
  ['left', 'слева'],
  ['right', 'справа'],
  ['top', 'сверху'],
  ['bottom', 'снизу'],
];

const PAPER_NAMES: [PaperStyle, string][] = [
  ['plain', 'чистый'],
  ['ruled', 'в линейку'],
  ['grid', 'в клетку'],
];

const PENS: [PenKind, string][] = [
  ['ballpoint', 'шариковая'],
  ['gel', 'гелевая'],
  ['pencil', 'карандаш'],
];

const STEPS = ['Фото', 'Лист', 'Помехи', 'Чернила'];
/** A side bowing more than this, px, makes the sheet count as curved. */
const CURVED = 1.5;
const NONE = [false, false, false, false];

/** One photo of a desk in this export, with its markup and what was measured on it. */
interface Desk {
  id: string;
  name: string;
  photo: Photo;
  corners: Pt[];
  snapped: boolean[];
  /** The user moved its corners: automatic answers must not overwrite them. */
  touched: boolean;
  /** A curved sheet: the bow of its sides and the grid of corrections; null — flat. */
  bend: DeskBend | null;
  /** The paper's size read off its squares, mm, and the shape and format it was read for. */
  gridSize: [number, number] | null;
  gridKey: string | null;
  /** Margin lines moved by hand, mm (by one number when kept before lines had ends); null — as found. */
  margins: HandMargins | Margins | null;
  /** Results and the corners (and paper) they belong to. */
  ruling: Ruling | null;
  rulingKey: string | null;
  mask: ObjectMask | null;
  maskKey: string | null;
  measure: Measure | null;
  glare: Specular | null;
  measureKey: string | null;
  /** The lens's 35 mm equivalent focal length (EXIF), mm; null: unknown. */
  focal35: number | null;
  /** How the phone was held, by the photo's lines (null: they do not tell); undefined: not looked for yet. */
  tilt: Tilt | null | undefined;
  /** The camera's turn set by hand (a sheet filling the frame on a blank); null: as found or made up. */
  handTilt: Angles | null;
  /** The lines it was set by (two across the sheet, two down it), when it was: [ax, ay, bx, by]. */
  handLines: number[][] | null;
  /** What of the photo is saved, px; null: all of it. */
  crop: Crop | null;
}

/** The proportions a crop keeps: none, the photo's, the sheet's, or width / height. */
type CropShape = 'free' | 'photo' | 'sheet' | number;

/** A sheet-shaped frame in the middle of the photo, to be dragged onto the real corners. */
function startCorners(photo: Photo, [w, h]: [number, number]): Pt[] {
  let ph = photo.height * 0.8;
  let pw = (ph * w) / h;
  if (pw > photo.width * 0.8) {
    pw = photo.width * 0.8;
    ph = (pw * h) / w;
  }
  const [x0, y0] = [(photo.width - pw) / 2, (photo.height - ph) / 2];
  return [
    [x0, y0],
    [x0 + pw, y0],
    [x0 + pw, y0 + ph],
    [x0, y0 + ph],
  ];
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const quadArea = (q: Pt[]) => Math.abs(q.reduce((s, p, k) => s + p[0] * q[(k + 1) % q.length][1] - q[(k + 1) % q.length][0] * p[1], 0)) / 2;

/** The marked top edge looks like a long side while the sheet is upright: the top is probably set wrong. */
function topLooksSideways(c: Pt[], [w, h]: [number, number]): boolean {
  const across = (dist(c[0], c[1]) + dist(c[3], c[2])) / 2;
  const along = (dist(c[1], c[2]) + dist(c[0], c[3])) / 2;
  return across / along > (w / h) * 1.3;
}

const num = (v: number, digits = 1) => v.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const keyOf = (d: Desk) => JSON.stringify(d.corners);
/** The sheet's shape: corners and, when curved, its bow and grid. */
const shapeOf = (corners: Pt[], bend: DeskBend | null) => JSON.stringify([corners, bend?.bows ?? bend?.bulge ?? null, bend?.grid ?? null]);
const warpOf = (d: Pick<Desk, 'corners' | 'bend'>): Warp => ({ corners: d.corners, bows: bowsOf(d.bend), grid: d.bend?.grid ?? null });
/** How a bent sheet's sides bow, as splines (an old cubic turned into one); null: flat. */
const bowsOf = (b: DeskBend | null): Bow[] | null => b?.bows ?? b?.bulge?.map(bowOfCubic) ?? null;
/** The largest bow of the sides, px. */
const bowMax = (bows: Bow[]) =>
  Math.max(
    0,
    ...bows.flatMap((b) => {
      const f = spline(b);
      return Array.from({ length: 41 }, (_, i) => Math.abs(f(i / 40)));
    }),
  );
/** The bows as one smooth arc each: through five knots, where the sides run now. */
const simpleBows = (bows: Bow[]): Bow[] =>
  bows.map((b) => {
    const f = spline(b);
    const t = [0, 0.25, 0.5, 0.75, 1];
    return { t, d: t.map(f) };
  });
/** The whole photo: a scan, the sheet filling the frame. */
const frameOf = (p: Photo): Pt[] => [
  [0, 0],
  [p.width, 0],
  [p.width, p.height],
  [0, p.height],
];
const sizeKey = (mm: [number, number]) => mm.map((v) => v.toFixed(1)).join('x');
/** Which shape of the sheet and size of the paper an answer about the printed lines belongs to. */
const rulingKeyOf = (d: Pick<Desk, 'corners' | 'bend'>, mm: [number, number]) => shapeOf(d.corners, d.bend) + sizeKey(mm);

/**
 * Squares are 5 mm: the paper's size from how big they came out on the
 * assumed format, to 0.5 mm. Null when they are not squares of about 5 mm
 * (then the format stays as chosen).
 */
function sizeBySquares(fmt: [number, number], r: Ruling): [number, number] | null {
  if (r.kind !== 'grid' || r.colStep === null || Math.abs(r.step - 5) > 0.75 || Math.abs(r.colStep - 5) > 0.75) return null;
  const round = (v: number) => Math.round(v * 2) / 2;
  return [round((fmt[0] * 5) / r.colStep), round((fmt[1] * 5) / r.step)];
}

/** The paper of a desk: as its squares say, or the chosen format. */
/** The marked top edge is the longer one: the sheet lies on its side. */
function topIsLong(c: Pt[]): boolean {
  const across = (dist(c[0], c[1]) + dist(c[3], c[2])) / 2;
  const along = (dist(c[1], c[2]) + dist(c[0], c[3])) / 2;
  return across > along * 1.05;
}

/**
 * The real sheet's size, mm, as it lies in the photo: the format, on its side
 * when chosen so (or, `byCorners`, when its corners show it so); on squared
 * paper read off the squares.
 */
function paperOf(d: Pick<Desk, 'corners' | 'bend' | 'gridSize' | 'gridKey'>, sheet: SheetChoice, byCorners = false): [number, number] {
  const upright = formatMm(sheet);
  const side = sheet.orient === 'landscape' || (sheet.orient !== 'portrait' && byCorners && topIsLong(d.corners));
  const fmt: [number, number] = side ? [Math.max(...upright), Math.min(...upright)] : upright;
  return sheet.byGrid && d.gridSize && d.gridKey === rulingKeyOf(d, fmt) ? d.gridSize : fmt;
}

/** What the photo says about itself, as the renderer copies it onto the ink. */
function photoLookOf(d: Desk, calib: number[] | null): PhotoLook {
  const m = d.measure;
  const sigma = m?.sigma ?? 0;
  const ratio = (s: number | null) => (s !== null && sigma > 0.05 ? Math.min(3, Math.max(0.33, s / sigma)) : 1);
  return {
    sides: m ? [ratio(m.sides[0]), ratio(m.sides[1]), ratio(m.sides[2]), ratio(m.sides[3])] : [1, 1, 1, 1],
    sharpen: m?.sharpen ?? 0,
    noise: m?.noise ?? DEFAULT_PHOTO_LOOK.noise,
    specular: d.glare,
    calib,
  };
}

/** A hint when the printed lines do not fit the paper that was chosen. */
function formatHint(r: Ruling, paperMm: [number, number], byGrid: boolean): string | null {
  // Squares tell the size themselves.
  if (byGrid && r.kind === 'grid' && r.colStep !== null) return null;
  const a4 = isA4(paperMm);
  const ratio = r.kind === 'grid' ? r.step / 5 : r.step / 8;
  const what = r.kind === 'grid' ? `Клетка вышла ${num(r.step)} мм вместо 5` : `Строки вышли через ${num(r.step)} мм`;
  if (Math.abs(ratio - 0.707) < 0.05) return `${what}: похоже, лист меньше выбранного (${a4 ? 'A5?' : 'проверьте формат'}).`;
  if (Math.abs(ratio - 1.414) < 0.08) return `${what}: похоже, лист больше выбранного (${!a4 ? 'A4?' : 'проверьте формат'}).`;
  if (r.kind === 'grid' && Math.abs(ratio - 1) > 0.08) return `${what}: проверьте формат листа.`;
  if (r.kind === 'ruled' && (r.step < 5.5 || r.step > 11)) return `${what}: проверьте формат листа.`;
  return null;
}

interface Props {
  /** The open document, as the page export draws it. */
  base: PageExport;
  setup: PageSetup;
  onClose: () => void;
}

/**
 * Export → «На столе (фото)»: the document's handwriting written onto photos
 * of real sheets of paper. Photos → where the sheet is → what lies on it → ink → JPG.
 */
export function DeskDialog(props: Props) {
  // The document cannot change while the dialog is open: keep what it was opened with.
  const [opened] = useState(props.base);
  // The traces of work and the printer are the render's settings: they may change while it is open.
  const wear = useWear();
  const tracesKey = JSON.stringify([wear.on, wear.smudge, wear.size, wear.erasers, wear.hand, wear.holes, wear.depth, wear.seed]);
  const base = useMemo(() => ({ ...opened, wear }), [opened, tracesKey]);
  const reliefKey = JSON.stringify([wear.on, wear.folds, wear.sharp, wear.hand, wear.holes, wear.depth, wear.seed, wear.show.folds, wear.show.wear]);
  /** What the result shows: the render up to this stage; and what the shutter shows on its left. */
  const [stage, setStage] = useState<Stage>('all');
  const [leftStage, setLeftStage] = useState<Stage>('photo');
  const [setup] = useState(props.setup);
  const { onClose } = props;
  const [step, setStep] = useState(0);
  const [desks, setDesks] = useState<Desk[]>([]);
  const [curId, setCurId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetChoice>(DEFAULT_SHEET);
  const [look, setLook] = useState<SavedLook>(DEFAULT_LOOK);
  /** The blur slider relative to what each photo measured (1: as on the photo). */
  const [blurGain, setBlurGain] = useState(1);
  const [split, setSplit] = useState(0);
  const [calib, setCalib] = useState<{ t: number[]; mm: number } | null>(null);
  /** A document on a blank: the blank, printed onto the photographed sheet before the ink, and how. */
  const blankId = base.blank?.id ?? null;
  const [blankRow, setBlankRow] = useState<Blank | null>(null);
  const [print, setPrint] = useState<PrintChoice>(DEFAULT_PRINT);
  /** How the photo is taken as: a photo (a made-up camera when the sheet fills the frame), or a scanner app's page. */
  const [capture, setCapture] = useState<Capture>(DEFAULT_CAPTURE);
  /** Per photo: how unevenly its paper is lit, and its scanner look (made once). */
  const spreads = useRef(new Map<string, number>());
  const scans = useRef(new Map<string, Promise<Photo>>());
  /** Per photo: the search for how the phone was held, while it runs. */
  const tilts = useRef(new Map<string, Promise<Tilt | null>>());
  /** Which photo each sheet of the document goes onto: all onto the selected one, or each its own. */
  const [assign, setAssign] = useState<'one' | 'each'>('one');
  const [pageDesk, setPageDesk] = useState<Record<number, string>>({});
  const [page, setPage] = useState(0);
  const [layout, setLayout] = useState<InkLayout | null>(null);
  /** How far the layout under way got (0..1), and about how many seconds it has left, once that can be told. */
  const [laying, setLaying] = useState<{ part: number; left: number | null }>({ part: 0, left: null });
  const paragraphs = useRef(newMemo());
  const [busy, setBusy] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** What the search for the sheet said, per photo. */
  const [foundNote, setFoundNote] = useState<Record<string, string>>({});
  /** The found lines over the photo (step 1). */
  const [showLines, setShowLines] = useState(false);
  /** Lines being put along a photo's sheet by hand, to read the perspective off. */
  const [guides, setGuides] = useState<{ id: string; lines: number[][] } | null>(null);
  /** How the photo is looked at (zoomed, moved): anew for each photo and step. */
  const [view, setView] = useState<View>(FIT);
  const resultFit = useRef<Fit | null>(null);
  /** The crop frame is being set; which proportions it keeps; how much of the desk «По листу» leaves round the sheet, mm. */
  const [cropping, setCropping] = useState(false);
  const [cropShape, setCropShape] = useState<CropShape>('free');
  const [cropRoom, setCropRoom] = useState(8);
  const [drop, setDrop] = useState(false);
  const [picking, setPicking] = useState(false);
  const [brush, setBrush] = useState<Brush>('erase');
  const [tool, setTool] = useState<MaskTool>('brush');
  const [brushRadius, setBrushRadius] = useState(40);
  /** Messages closed (or faded) by now. */
  const [gone, setGone] = useState<string[]>([]);
  /** The desk in «Мои столы» this export is kept as (from then on it saves itself), and its name. */
  const [deskId, setDeskId] = useState<string | null>(null);
  const [deskName, setDeskName] = useState('');
  const [saving, setSaving] = useState(false);
  /** The photos' JPEGs as kept, the masks last written, and the gallery's picture (and which photo it is of). */
  const blobs = useRef(new Map<string, Blob>());
  const written = useRef(new Map<string, ObjectMask | null>());
  const thumb = useRef<{ id: string; blob: Blob } | null>(null);
  /** Saves run one after another; `dirty`: a change not written yet. */
  const saveChain = useRef(Promise.resolve());
  const dirty = useRef(false);
  /** The settings as they are now, for a save that runs later. */
  const settingsRef = useRef({ sheet, look, blurGain, calib, assign, pageDesk, page, step, curId, deskName, print, capture });
  settingsRef.current = { sheet, look, blurGain, calib, assign, pageDesk, page, step, curId, deskName, print, capture };
  const saved = useLive(listDesks, [], [] as SavedDesk[]);
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<DeskRenderer | null>(null);
  /** The desk whose photo the renderer holds. */
  const shown = useRef<string | null>(null);
  const analyzer = useRef<Analyzer | null>(null);
  /** The desks as they are now, for flows that wait on answers. */
  const desksRef = useRef<Desk[]>([]);
  desksRef.current = desks;
  /** Counts the user's moves of the corners: an answer about older corners is dropped. */
  const edits = useRef(0);
  /** Bumped when the GPU loses the canvas, to draw it all again. */
  const [glEpoch, setGlEpoch] = useState(0);
  /** Version of the ink on the GPU, 0: none yet (each new upload must be drawn). */
  const [inkReady, setInkReady] = useState(0);

  const cur = desks.find((d) => d.id === curId) ?? desks[0] ?? null;
  // On a blank the paper is plain: what is printed on it is the blank.
  const paperKind: PaperStyle = blankId ? 'plain' : sheet.paper;
  const valid = !!cur && isConvexClockwise(cur.corners);
  const allValid = desks.length > 0 && desks.every((d) => isConvexClockwise(d.corners));
  // A clean sheet for a blank lies as its corners show; a sheet to write on, as chosen.
  const paperFor = (d: Desk) => paperOf(d, sheet, !!blankId);
  const hasRuling = (d: Desk) => d.rulingKey === rulingKeyOf(d, paperFor(d));
  /** The margin lines of a desk by their ends: moved by hand, or as found (leaning with the printed lines). */
  const marginsOf = (d: Desk): HandMargins => {
    const r = hasRuling(d) ? d.ruling : null;
    return marginLines(d.margins ?? r?.margins ?? NO_MARGINS, r?.slope ?? 0, paperFor(d));
  };

  useEffect(() => {
    void getSetting<Partial<SavedLook>>(LOOK_KEY, {}).then((l) => setLook((c) => ({ ...c, ...l })));
    void getSetting<unknown>(PRINT_KEY, null).then((p) => setPrint(printChoice(p)));
    void getSetting<unknown>(CAPTURE_KEY, null).then((c) => setCapture(captureOf(c)));
    if (blankId) void db.blanks.get(blankId).then((b) => setBlankRow(b ?? null));
    void getSetting<SheetChoice & { v?: number }>(SHEET_KEY, DEFAULT_SHEET).then(({ v, mode, ...s }) =>
      setSheet({ ...DEFAULT_SHEET, ...s, ...(v === SHEET_VERSION ? { mode } : {}) }),
    );
    const a = new Analyzer();
    analyzer.current = a;
    return () => {
      a.dispose();
      analyzer.current = null;
    };
  }, []);
  useEffect(
    () => () => {
      desksRef.current.forEach((d) => d.photo.bitmap.close());
      scans.current.forEach((job) => void job.then((s) => s.bitmap.close()));
    },
    [],
  );

  const changeLook = (patch: Partial<SavedLook>) => {
    const next = { ...look, ...patch };
    setLook(next);
    void setSetting(LOOK_KEY, next);
  };
  const changeSheet = (patch: Partial<SheetChoice>) => {
    const next = { ...sheet, ...patch };
    setSheet(next);
    void setSetting(SHEET_KEY, { ...next, v: SHEET_VERSION });
  };
  const changeCapture = (patch: Partial<Capture>) => {
    const next = { ...capture, ...patch };
    setCapture(next);
    void setSetting(CAPTURE_KEY, next);
  };
  const changePrint = (patch: Partial<PrintChoice>) => {
    const next = { ...print, ...patch };
    setPrint(next);
    void setSetting(PRINT_KEY, next);
  };
  const patch = (id: string, p: Partial<Desk>) => setDesks((ds) => ds.map((d) => (d.id === id ? { ...d, ...p } : d)));

  /** A name for a new desk: its photo's, or the date for several. */
  const defaultName = (ds: Desk[]) =>
    ds.length === 1 ? ds[0].name : `Стол от ${new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`;

  /** Writes this export as desk `id`: markup, findings and settings, and the photos not written yet or with a new mask. */
  const writeNow = async (id: string) => {
    const ds = desksRef.current;
    const st = settingsRef.current;
    if (!ds.length) return;
    const rows: DeskPhotoRow[] = [];
    for (const d of ds) {
      if (written.current.has(d.id) && written.current.get(d.id) === d.mask) continue;
      let blob = blobs.current.get(d.id);
      if (!blob) {
        blob = await jpeg(d.photo, d.photo.width, 0.92);
        blobs.current.set(d.id, blob);
      }
      rows.push({ id: d.id, deskId: id, photo: blob, mask: d.mask });
    }
    if (thumb.current?.id !== ds[0].id) thumb.current = { id: ds[0].id, blob: await jpeg(ds[0].photo, 320, 0.8) };
    const index = (photoId: string | null | undefined) => Math.max(0, ds.findIndex((d) => d.id === photoId));
    const photos: SavedPhoto[] = ds.map((d) => ({
      id: d.id,
      name: d.name,
      corners: d.corners,
      snapped: d.snapped,
      bend: d.bend,
      margins: d.margins,
      maskKey: d.maskKey,
      focal35: d.focal35,
      handTilt: d.handTilt,
      handLines: d.handLines,
      crop: d.crop,
      found: {
        ruling: d.ruling,
        rulingKey: d.rulingKey,
        gridSize: d.gridSize,
        gridKey: d.gridKey,
        measure: d.measure,
        glare: d.glare,
        measureKey: d.measureKey,
        ...(d.tilt !== undefined && { tilt: d.tilt }),
      },
    }));
    const settings: DeskSettings = {
      sheet: st.sheet,
      look: st.look,
      blurGain: st.blurGain,
      calib: st.calib,
      assign: st.assign,
      pageDesk: Object.fromEntries(Object.entries(st.pageDesk).map(([p, photoId]) => [p, index(photoId)])),
      current: index(st.curId),
      page: st.page,
      step: st.step,
      print: st.print,
      capture: st.capture,
    };
    const now = Date.now();
    await writeDesk({ id, name: st.deskName.trim() || defaultName(ds), thumb: thumb.current.blob, photos, settings, createdAt: now, updatedAt: now }, rows);
    for (const r of rows) written.current.set(r.id, r.mask);
  };

  /** Writes what changed, after any save still running. */
  const flush = (id: string) => {
    dirty.current = false;
    setSaving(true);
    const run = saveChain.current.then(() => writeNow(id));
    saveChain.current = run.catch(() => undefined);
    return run
      .catch((err) => setError(`Стол не сохранился: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => !dirty.current && setSaving(false));
  };
  /** Everything of the kept desk written. */
  const settle = async () => {
    if (deskId && dirty.current) await flush(deskId);
    else await saveChain.current;
  };

  // A kept desk saves itself a second after the last change.
  useEffect(() => {
    if (!deskId) return;
    dirty.current = true;
    setSaving(true);
    const t = setTimeout(() => void flush(deskId), 1000);
    return () => clearTimeout(t);
  }, [deskId, desks, sheet, look, blurGain, calib, assign, pageDesk, page, step, curId, deskName, print, capture]);

  /** Keeps this export in «Мои столы». */
  const keepDesk = () => {
    const id = crypto.randomUUID();
    setDeskName(defaultName(desks));
    setDeskId(id);
    void flush(id);
  };

  const close = async () => {
    setBusy('Сохраняю стол…');
    await settle();
    onClose();
  };

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (picking) setPicking(false);
      else void close();
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, picking, deskId]);

  /** The analysis, looking at this desk's photo. */
  const analysisOf = async (d: Desk) => {
    const a = analyzer.current;
    if (!a) throw new Error('анализ снимка закрыт');
    await a.use(d.id, d.photo);
    return a;
  };

  /** The sheet's edges as curves from these corners: a bend when they bow (or always, `force`). */
  const curve = async (d: Desk, corners: Pt[], force: boolean): Promise<{ corners: Pt[]; bend: DeskBend | null; snapped: boolean[] } | null> => {
    const c = await (await analysisOf(d)).curvedSides(corners);
    if (!force && c.max < CURVED) return null;
    return { corners: c.corners, snapped: c.fitted, bend: { bows: c.bows, grid: zeroGrid(), fixed: false, max: c.max } };
  };

  /** The lens's focal length for a desk's photo, px. */
  const focalOf = (d: Desk) => focalPx(d.photo.width, d.photo.height, d.focal35);
  /** A found tilt sure enough, and not a sheet square to the camera. */
  const sureTilt = (t: Tilt | null | undefined): t is Tilt => !!t && t.confidence >= SURE_TILT && tiltOf(t.rot) >= FLAT_TILT;
  /** Reads how the phone was held off the photo's lines (once per photo) and keeps it. */
  const lookForTilt = (d: Desk): Promise<Tilt | null> => {
    const known = desksRef.current.find((x) => x.id === d.id)?.tilt;
    if (known !== undefined) return Promise.resolve(known);
    let job = tilts.current.get(d.id);
    if (!job) {
      job = analysisOf(d)
        .then((a) => a.perspective(focalOf(d)))
        .catch(() => null)
        .then((tilt) => {
          patch(d.id, { tilt });
          return tilt;
        });
      tilts.current.set(d.id, job);
    }
    return job;
  };

  /**
   * A sheet partly or wholly beyond the frame, in the perspective `turn`:
   * its corners outside the frame drawn anew (all of them for a sheet filling
   * the frame). Null when its edges are all in the photo — the corners tell
   * the perspective then — or the turn does not fit it.
   */
  const refitCorners = (d: Desk, turn: Mat3): Pt[] | null => {
    const { width: w, height: h } = d.photo;
    const beyond = sidesBeyond(d.corners, d.snapped, w, h);
    if (beyond.every(Boolean)) return coverCorners(turn, w, h, focalOf(d));
    if (beyond.some(Boolean)) return completeCorners(d.corners, d.snapped, turn, w, h, focalOf(d), paperFor(d));
    return null;
  };
  /** Sets the camera's turn by hand (null: as found), and the lines it was read off; a notebook's corners beyond the frame follow it. */
  const setHandTilt = (d: Desk, a: Angles | null, lines: number[][] | null = null) => {
    const now = desksRef.current.find((x) => x.id === d.id) ?? d;
    const turn = a ? rotOf(a) : sureTilt(now.tilt) ? now.tilt.rot : null;
    const corners = turn && !blankId ? refitCorners(now, turn) : null;
    patch(d.id, { handTilt: a, handLines: a ? lines : null, ...(corners && { corners, bend: null }) });
  };
  /** The perspective read off lines put along the sheet by hand. */
  const applyLines = (d: Desk, lines: number[][]) => {
    const turn = turnByLines(lines, d.photo.width, d.photo.height, focalOf(d));
    if (!turn) {
      setFoundNote((n) => ({ ...n, [d.id]: 'Линии не сходятся так, как на листе: розовые положите вдоль строк или верхнего края, голубые — вдоль полей или боковых краёв.' }));
      return;
    }
    setHandTilt(d, anglesOf(turn), lines);
    setFoundNote((n) => ({ ...n, [d.id]: `Перспектива по линиям: ${describeTilt(anglesOf(turn))}.` }));
  };

  /** Looks for the sheet and puts the corners on it (unless the user already moved them). */
  const findSheet = async (d: Desk, force: boolean) => {
    const say = (text: string) => setFoundNote((n) => ({ ...n, [d.id]: text }));
    try {
      const a = await analysisOf(d);
      const found = await a.findSheet();
      const tilt = await lookForTilt(d);
      const now = desksRef.current.find((x) => x.id === d.id);
      if (!now || (!force && now.touched)) return;
      // The sheet fills the frame, but its lines converge: photographed close, not scanned — its corners lie
      // outside the frame. (On a blank the camera takes the tilt instead: the printing must stay in the frame.)
      // A bright patch the light made, not the sheet: most of the frame, but out of the plane the lines show.
      const patchy =
        !!found &&
        !found.scan &&
        sureTilt(tilt) &&
        tilt.by === 'two' &&
        quadArea(found.corners) > 0.5 * d.photo.width * d.photo.height &&
        !inPlaneOf(found.corners, tilt.rot, d.photo.width, d.photo.height, focalOf(d));
      const full = !!found && (found.scan || patchy || fillsFrame(found.corners, d.photo.width, d.photo.height));
      const cover = full && !blankId && sureTilt(tilt) ? coverCorners(tilt.rot, d.photo.width, d.photo.height, focalOf(d)) : null;
      if (cover) {
        patch(d.id, { corners: cover, snapped: NONE, bend: null });
        say(`Лист во весь кадр, перспектива найдена по линиям на снимке: ${describeTilt(anglesOf(tilt!.rot))}. Уголки — за краями кадра.`);
      } else if (found?.scan) {
        patch(d.id, { corners: found.corners, snapped: found.snapped, bend: null });
        say('Это скан: лист занимает весь кадр — без перспективы и изгиба.');
      } else if (patchy) {
        patch(d.id, { corners: frameOf(d.photo), snapped: NONE, bend: null });
        say(`Края листа не видны — он во весь кадр; перспектива найдена по линиям на снимке: ${describeTilt(anglesOf(tilt!.rot))}.`);
      } else if (found && found.confidence >= 0.6) {
        // Part of the sheet beyond the frame: its corners there drawn by the lines' perspective.
        const beyond = sidesBeyond(found.corners, found.snapped, d.photo.width, d.photo.height);
        const done =
          !blankId && sureTilt(tilt) && beyond.some(Boolean)
            ? completeCorners(found.corners, found.snapped, tilt.rot, d.photo.width, d.photo.height, focalOf(d), paperFor(now))
            : null;
        if (done) {
          patch(d.id, { corners: done, snapped: found.snapped, bend: null });
          say(`Лист виден не весь: уголки за краями кадра достроены по перспективе снимка (${describeTilt(anglesOf(tilt!.rot))}). Проверьте видимые уголки в лупе.`);
          return;
        }
        const curved = await curve(d, found.corners, false).catch(() => null);
        const again = desksRef.current.find((x) => x.id === d.id);
        if (!again || (!force && again.touched)) return;
        patch(d.id, curved ? { ...curved, snapped: found.snapped } : { corners: found.corners, snapped: found.snapped, bend: null });
        const all = found.snapped.every(Boolean);
        say(
          curved
            ? `Лист найден и он изогнут: края выгнуты до ${num(curved.bend!.max)} px — изгиб учтён. Проверьте уголки в лупе.`
            : all
              ? 'Лист найден, уголки встали на его края. Проверьте их в лупе.'
              : 'Лист найден, но не все края видны: проверьте уголки.',
        );
      } else {
        say('Лист не нашёлся: поставьте уголки сами — стороны прилипнут к краям листа.');
      }
    } catch (err) {
      setError(`Анализ снимка не работает: ${err instanceof Error ? err.message : String(err)}. Уголки можно поставить вручную.`);
    }
  };

  const fresh = (photo: Photo, name: string): Desk => ({
    id: crypto.randomUUID(),
    name,
    photo,
    corners: startCorners(photo, formatMm(sheet)),
    snapped: NONE,
    touched: false,
    bend: null,
    gridSize: null,
    gridKey: null,
    margins: null,
    ruling: null,
    rulingKey: null,
    mask: null,
    maskKey: null,
    measure: null,
    glare: null,
    measureKey: null,
    focal35: photo.focal35 ?? null,
    tilt: undefined,
    handTilt: null,
    handLines: null,
    crop: null,
  });

  /** The photo turned a quarter clockwise (a scan or a photo that came on its side): a new photo in its place, its sheet found anew. */
  const rotatePhoto = async (d: Desk) => {
    setBusy('Поворачиваю снимок…');
    try {
      const { width: w, height: h } = d.photo;
      const canvas = new OffscreenCanvas(h, w);
      const ctx = canvas.getContext('2d')!;
      ctx.translate(h, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(d.photo.bitmap, 0, 0);
      const photo: Photo = { bitmap: await createImageBitmap(canvas), width: h, height: w, name: d.photo.name };
      const next = { ...fresh(photo, d.name), focal35: d.focal35 };
      setDesks((ds) => ds.map((x) => (x.id === d.id ? next : x)));
      setPageDesk((pd) => Object.fromEntries(Object.entries(pd).map(([p, id]) => [p, id === d.id ? next.id : id])));
      setCurId(next.id);
      d.photo.bitmap.close();
      setBusy('Ищу лист на фото…');
      await findSheet(next, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const addFiles = async (files: File[]) => {
    setError(null);
    setNote(null);
    const added: Desk[] = [];
    for (const [i, file] of files.entries()) {
      setBusy(files.length > 1 ? `Открываю фото ${i + 1} из ${files.length}…` : 'Открываю фото…');
      try {
        added.push(fresh(await loadPhoto(file, WORK_SIDE), file.name.replace(/\.[^.]+$/, '')));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    setBusy(null);
    if (!added.length) return;
    setDesks((ds) => [...ds, ...added]);
    if (desksRef.current.length + added.length > 1) setAssign('each');
    setCurId(added[0].id);
    setStep(1);
    for (const [i, d] of added.entries()) {
      setBusy(added.length > 1 ? `Ищу лист на фото ${i + 1} из ${added.length}…` : 'Ищу лист на фото…');
      await findSheet(d, false);
    }
    setBusy(null);
  };

  /** A photo of a saved desk, with its markup and what was found on it. */
  const deskOf = (p: SavedPhoto, photo: Photo, mask: ObjectMask | null): Desk => ({
    ...fresh(photo, p.name),
    ...p.found,
    id: p.id,
    corners: p.corners,
    snapped: p.snapped,
    bend: p.bend,
    touched: true,
    margins: p.margins,
    mask,
    maskKey: mask ? p.maskKey : null,
    focal35: p.focal35 ?? null,
    tilt: p.found?.tilt,
    handTilt: p.handTilt ?? null,
    handLines: p.handLines ?? null,
    crop: p.crop ?? null,
  });

  /** Opens a desk from «Мои столы» instead of the photos here: its photos, markup and settings as they were saved. */
  const openSaved = async (s: SavedDesk) => {
    if (s.id === deskId) return;
    if (!deskId && desks.length && !confirm('Фото этого экспорта не сохранены в «Мои столы». Открыть стол вместо них?')) return;
    setError(null);
    setBusy('Открываю стол…');
    try {
      await settle();
      const photos = await openDesk(s);
      if (!photos.length) throw new Error('Фото этого стола не нашлись.');
      const opened = photos.map(({ id, photo, blob, mask }) => {
        blobs.current.set(id, blob);
        written.current.set(id, mask);
        return deskOf(s.photos.find((p) => p.id === id)!, photo, mask);
      });
      desksRef.current.forEach((d) => d.photo.bitmap.close());
      shown.current = null;
      setDesks(opened);
      const st = s.settings;
      setSheet(st.sheet);
      setLook(st.look);
      setBlurGain(st.blurGain);
      setCalib(st.calib);
      if (st.print) setPrint(printChoice(st.print));
      if (st.capture) setCapture(captureOf(st.capture));
      setAssign(st.assign);
      setPageDesk(Object.fromEntries(Object.entries(st.pageDesk).flatMap(([p, i]) => (opened[i] ? [[p, opened[i].id]] : []))));
      setCurId((opened[st.current] ?? opened[0]).id);
      setPage(st.page);
      setFoundNote({});
      setNote(null);
      thumb.current = { id: opened[0].id, blob: s.thumb };
      dirty.current = false;
      setDeskId(s.id);
      setDeskName(s.name);
      setStep(st.step);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** Adds the photos of a saved desk, with their markup, to this export. */
  const addSaved = async (s: SavedDesk) => {
    setError(null);
    setBusy('Открываю фото стола…');
    try {
      const added = (await openDesk(s)).map(({ id, photo, blob, mask }) => {
        // A copy: the saved desk keeps its own.
        const copy = { ...deskOf(s.photos.find((p) => p.id === id)!, photo, mask), id: crypto.randomUUID() };
        blobs.current.set(copy.id, blob);
        return copy;
      });
      if (!added.length) return;
      setDesks((ds) => [...ds, ...added]);
      if (desksRef.current.length + added.length > 1) setAssign('each');
      setCurId(added[0].id);
      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const removeDesk = (d: Desk) => {
    setDesks((ds) => ds.filter((x) => x.id !== d.id));
    if (shown.current === d.id) shown.current = null;
    d.photo.bitmap.close();
    if (curId === d.id) setCurId(null);
  };

  /** A corner was let go at `at`: the two sides at it stick to the sheet's real edges. */
  const release = async (d: Desk, i: number, free: boolean, at: Pt[]) => {
    const which = NONE.map((_, k) => k === i || k === (i + 3) % 4);
    if (free) {
      patch(d.id, { snapped: d.snapped.map((v, k) => (which[k] ? false : v)) });
      return;
    }
    const seq = edits.current;
    if (d.bend) {
      // A curved sheet: all four sides as curves again, the grid anew.
      const c = await curve(d, at, true).catch(() => null);
      if (c && edits.current === seq) patch(d.id, c);
      return;
    }
    const res = await analysisOf(d)
      .then((a) => a.snap(at, which))
      .catch(() => null);
    // Moved again meanwhile: that newer position wins.
    if (!res || edits.current !== seq) return;
    const now = desksRef.current.find((x) => x.id === d.id);
    if (now) patch(d.id, { corners: res.corners, snapped: now.snapped.map((v, k) => (which[k] ? res.snapped[k] : v)) });
  };

  /** The sides bent by hand (a knot moved, added or taken away); a knot let go sticks to the edge near it. */
  const editBows = (d: Desk, bows: Bow[], done: { side: number; knot: number; free: boolean } | null) => {
    edits.current++;
    const b = d.bend ?? { grid: zeroGrid(), fixed: false, max: 0 };
    patch(d.id, { touched: true, bend: { ...b, bulge: undefined, bows, fixed: false, lines: undefined, max: bowMax(bows) } });
    if (done && !done.free) void stickKnot(d, bows, done.side, done.knot);
  };
  const stickKnot = async (d: Desk, bows: Bow[], k: number, j: number) => {
    const seq = edits.current;
    const t = bows[k].t[j];
    const off = await analysisOf(d)
      .then((a) => a.edgeOffset(d.corners[k], d.corners[(k + 1) % 4], t))
      .catch(() => null);
    const now = desksRef.current.find((x) => x.id === d.id);
    if (off === null || edits.current !== seq || !now?.bend) return;
    // The side runs along its chord, bow and the grid's correction there: the bow takes what is left to the edge.
    const [a, b] = [d.corners[k], d.corners[(k + 1) % 4]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const n: Pt = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
    const uv: Pt = k === 0 ? [t, 0] : k === 1 ? [1, t] : k === 2 ? [1 - t, 1] : [0, 1 - t];
    const g = gridAt(now.bend.grid, ...uv);
    const want = off - (g[0] * n[0] + g[1] * n[1]);
    // Not the edge it was put by: far from it, it is something else.
    if (Math.abs(want - bows[k].d[j]) > 12) return;
    const next = bows.map((w, m) => (m === k ? { t: w.t, d: w.d.map((v, i) => (i === j ? want : v)) } : w));
    patch(d.id, { bend: { ...now.bend, bows: next, max: bowMax(next) } });
  };

  /** Makes sure the desk has what is asked for, for its present corners and paper; returns it up to date. */
  const prepare = async (id: string, need: { ruling?: boolean; mask?: boolean; measure?: boolean }): Promise<Desk | null> => {
    const d = desksRef.current.find((x) => x.id === id);
    if (!d || !isConvexClockwise(d.corners)) return d ?? null;
    const key = keyOf(d);
    const fmt = formatMm(sheet);
    const p: Partial<Desk> = {};
    const a = await analysisOf(d);
    // The paper's size by its squares, read on the chosen format.
    if (need.ruling && d.gridKey !== rulingKeyOf(d, fmt)) {
      const r = await a.ruling(warpOf(d), fmt[0], fmt[1]);
      Object.assign(p, { gridSize: r && sizeBySquares(fmt, r), gridKey: rulingKeyOf(d, fmt) });
    }
    // The paper as its squares say; the lines read again on it.
    const size = paperOf({ ...d, ...p }, sheet, !!blankId);
    const [wMm, hMm] = size;
    if (need.ruling && d.rulingKey !== rulingKeyOf(d, size)) {
      let r = await a.ruling(warpOf(d), wMm, hMm);
      let bend = d.bend;
      if (r && bend && !bend.fixed) {
        // Straighten the curved sheet by its own printed lines, then read them again.
        // As fine a grid as the sheet needs (0 × 0: the analysis decides).
        const fit = await a.bend(warpOf(d), wMm, hMm, r, 0, 0);
        const better = fit.before > 0.12 && fit.after < 0.8 * fit.before;
        bend = { ...bend, fixed: true, ...(better ? { grid: fit.grid, lines: { before: fit.before, after: fit.after } } : {}) };
        if (better) r = (await a.ruling(warpOf({ corners: d.corners, bend }), wMm, hMm)) ?? r;
        p.bend = bend;
      }
      p.ruling = r;
      p.rulingKey = rulingKeyOf({ corners: d.corners, bend }, size);
    }
    if (need.mask && d.maskKey !== key) {
      p.mask = await a.mask(d.corners, wMm, hMm, 2);
      p.maskKey = key;
    }
    // Blur only on the sides that lie on a found edge.
    if (need.measure && d.measureKey !== key + d.snapped) {
      const [m, g] = await Promise.all([a.measure(d.corners, d.snapped), a.specular(d.corners, 4)]);
      Object.assign(p, { measure: m, glare: g, measureKey: key + d.snapped });
    }
    // Moved meanwhile: these answers belong to older corners.
    const now = desksRef.current.find((x) => x.id === id);
    if (!now || keyOf(now) !== key) return now ?? null;
    if (Object.keys(p).length) patch(id, p);
    return { ...now, ...p };
  };

  // «Помехи»: the printed lines and the things on the current sheet.
  const curKey = cur ? shapeOf(cur.corners, cur.bend) + cur.maskKey : '';
  useEffect(() => {
    if (step !== 2 || !cur || !valid) return;
    let alive = true;
    setPreparing('Ищу линовку и предметы на листе…');
    void prepare(cur.id, { ruling: true, mask: true })
      .catch((err) => alive && setError(String(err)))
      .finally(() => alive && setPreparing(null));
    return () => {
      alive = false;
      setPreparing(null);
    };
  }, [step, cur?.id, curKey, sizeKey(formatMm(sheet)), sheet.byGrid]);

  const pageCount = layout?.layers.length ?? 1;
  const deskFor = (p: number): Desk | null => {
    if (assign === 'one' || desks.length < 2) return cur;
    return desks.find((d) => d.id === pageDesk[p]) ?? desks[p % desks.length] ?? null;
  };
  const usedDesks = [...new Set(Array.from({ length: pageCount }, (_, p) => deskFor(p)).filter((d): d is Desk => !!d))];

  // «Чернила»: everything measured for the photos the sheets go onto.
  const usedKey = usedDesks.map((d) => d.id + shapeOf(d.corners, d.bend) + d.maskKey).join('|');
  useEffect(() => {
    if (step !== 3) return;
    let alive = true;
    void (async () => {
      for (const [i, d] of usedDesks.entries()) {
        if (!alive) return;
        setPreparing(usedDesks.length > 1 ? `Измеряю фото ${i + 1} из ${usedDesks.length}: резкость, шум, блики…` : 'Измеряю снимок: резкость, шум, блики…');
        await prepare(d.id, { ruling: paperKind !== 'plain', mask: true, measure: true }).catch((err) => alive && setError(String(err)));
      }
      if (alive) setPreparing(null);
    })();
    return () => {
      alive = false;
      setPreparing(null);
    };
  }, [step, usedKey, sizeKey(formatMm(sheet)), sheet.byGrid, paperKind]);

  // The lines the text is laid onto: those found on the first photo that has them, within its
  // margins, on its paper; the other photos' sheets follow their own lines.
  const refDesk = paperKind !== 'plain' ? (desks.find((d) => d.ruling && hasRuling(d)) ?? null) : null;
  const refLines = refDesk?.ruling ? linesOf(refDesk.ruling, marginsOf(refDesk)) : null;
  const refKey = JSON.stringify(refLines);
  const paperMm = refDesk ? paperFor(refDesk) : cur ? paperFor(cur) : formatMm(sheet);
  // Without printed lines to lay the text on, the margins drawn by hand on the photo still hold.
  const looseMargins = !refLines && cur ? marginsPx(marginsOf(cur)) : null;
  const looseKey = JSON.stringify(looseMargins);
  const paperKey = sizeKey(paperMm);
  // A turned blank stands upright in the photo, unless its turn was chosen by hand.
  const effectivePrint: PrintChoice = print.turnAuto && cur ? { ...print, turn: uprightTurn(cur.corners as [number, number][]) } : print;
  useEffect(() => {
    let alive = true;
    const stop = new AbortController();
    const started = performance.now();
    let shown = 0;
    const onProgress = (part: number) => {
      const now = performance.now();
      if (!alive || now - shown < PROGRESS_EVERY) return;
      shown = now;
      setLaying({ part, left: part > 0.01 && now - started > 2000 ? ((now - started) * (1 - part)) / part / 1000 : null });
    };
    const run = { signal: stop.signal, onProgress, memo: paragraphs.current };
    setLayout(null);
    setLaying({ part: 0, left: null });
    void (blankId
      ? blankLayout(base, paperMm, effectivePrint, blankRow ? printShrinkOf(blankRow, paperSize(paperMm)) : 1, run)
      : inkLayout(base, setup, paperMm, sheet.mode, refLines, { every: sheet.every, letters: sheet.letters, squares: sheet.squares }, looseMargins, run)
    )
      .then((l) => {
        if (!alive) return;
        setLayout(l);
        setPage((p) => Math.min(p, l.layers.length - 1));
      })
      .catch((err) => alive && setError(String(err)));
    return () => {
      alive = false;
      // An unwanted layout must not hold up the next one at the engine, nor keep its sheets in memory.
      stop.abort();
    };
  }, [base, setup, paperKey, sheet.mode, sheet.every, sheet.letters, sheet.squares, refKey, looseKey, effectivePrint.turn, print.skew, print.seed, blankRow?.print]);

  // The GPU canvas lives as long as the dialog.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const lost = (e: Event) => {
      e.preventDefault();
      renderer.current = null;
      shown.current = null;
      setInkReady(0);
    };
    const restored = () => setGlEpoch((n) => n + 1);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    return () => {
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, []);

  /** Effective look for a desk: the blur slider scales what the photo measured. */
  const lookFor = (d: Desk): InkLook => ({ ...look, blur: (d.measure?.sigma ?? FALLBACK_BLUR) * blurGain, split });
  const linesFor = (d: Desk) => (paperKind !== 'plain' && d.ruling && hasRuling(d) ? linesOf(d.ruling, marginsOf(d)) : null);
  /** Where the page goes on a desk's sheet: by its own lines on its own paper. */
  const onDesk = (d: Desk, l: InkLayout) => placeOn(l, linesFor(d), paperSize(paperFor(d)));

  /**
   * Puts sheet `p` of the document onto desk `d` on the GPU. A draw that is no
   * longer wanted (`wanted` false once its picture is ready) changes nothing:
   * a late one must not replace the newer ink.
   */
  /**
   * How the photo is taken as: `scan` — a scanner app's page (light evened
   * out, the sheet straight); `camera` — the sheet fills the frame of a photo
   * lit unevenly: a made-up camera tilts it (only on a blank, whose printing
   * is ours to place); `photo` — as the photo shows it.
   */
  const captureFor = (d: Desk): 'scan' | 'camera' | 'photo' => {
    if (capture.mode === 'scan') return 'scan';
    const full = fillsFrame(d.corners, d.photo.width, d.photo.height);
    if (capture.mode === 'photo') return full && blankId ? 'camera' : 'photo';
    if (!full) return 'photo';
    // The tilt read off the photo (or set by hand) beats the light's guess.
    if (blankId && (d.handTilt || sureTilt(d.tilt))) return 'camera';
    let spread = spreads.current.get(d.id);
    if (spread === undefined) {
      spread = lightSpread(d.photo, d.corners);
      spreads.current.set(d.id, spread);
    }
    if (spread < 0.08) return 'scan';
    return blankId ? 'camera' : 'photo';
  };
  /** The camera's turn for a sheet filling the frame: set by hand, else found sure enough; null — made up. */
  const turnOf = (d: Desk) => (d.handTilt ? rotOf(d.handTilt) : sureTilt(d.tilt) ? d.tilt.rot : null);
  /** Where the sheet lies for the printing and the ink, and what the camera adds (waves only on a blank: a notebook's own lines are in the photo). */
  const geometryFor = (d: Desk) => {
    const how = captureFor(d);
    if (how === 'camera') {
      const corners = cameraCorners(d.corners, d.photo.width, d.photo.height, capture.seed, turnOf(d), focalOf(d));
      return {
        how,
        corners,
        warp: { corners, bulge: null, grid: null } as Warp,
        extras: { lens: lensOf(d.photo.width, d.photo.height, capture.seed), wave: wavesOf(d.photo, d.corners) },
      };
    }
    return { how, corners: d.corners, warp: warpOf(d), extras: how === 'photo' && blankId ? { wave: wavesOf(d.photo, d.corners, 0.0025) } : {} };
  };

  const draw = async (d: Desk, p: number, wanted: () => boolean = () => true) => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) throw new Error('нечего рисовать');
    if (!renderer.current) {
      renderer.current = new DeskRenderer(canvas);
      shown.current = null;
    }
    const r = renderer.current;
    const on = onDesk(d, layout);
    const geo = geometryFor(d);
    const scale = rasterScale(layout, geo.corners, Math.min(r.maxTexture, 8192), on);
    const parts = layout.layers[p];
    // The text, the drawings and the rubbed graphite apart: each stage can be shown without the next.
    const raster = await rasterize(parts?.text ?? '', layout.size, scale);
    const drawn = parts ? await rasterize(parts.drawings, layout.size, scale) : null;
    // The light on the creases comes from where the photo's paper is brighter (page px, y down).
    const lit = lightFrom(d.photo, geo.corners);
    let light = { x: -0.6, y: -0.8 };
    if (lit) {
      const [a, b, , c, e] = on.place;
      const lx = lit.x * on.paper.w;
      const ly = lit.y * on.paper.h;
      const det = a * e - b * c || 1;
      light = { x: (e * lx - b * ly) / det, y: (-c * lx + a * ly) / det };
    }
    const relief = reliefOf(layout.size, wear, mix32(docSeed(base.docId), p), layout.work[p]?.pivots ?? [], light);
    // The blank is printed on the first sheet.
    const toner = blankRow && p === 0 ? await tonerRaster(blankRow, print.color, layout.size, scale) : null;
    // A scanner app's page: the photo with its light evened out (made once per photo).
    let photo = d.photo;
    if (geo.how === 'scan') {
      const job = scans.current.get(d.id) ?? scannerLook(d.photo);
      // The last used stay: a copy of every photo is a lot of memory.
      scans.current.delete(d.id);
      scans.current.set(d.id, job);
      for (const [id, old] of scans.current) {
        if (scans.current.size <= SCANS_KEPT) break;
        scans.current.delete(id);
        void old.then((s) => s.bitmap.close());
      }
      photo = await job;
    }
    if (!wanted() || renderer.current !== r) {
      freeCanvases(raster, drawn);
      return null;
    }
    const shownKey = `${d.id}|${geo.how}`;
    if (shown.current !== shownKey) {
      r.setPhoto(photo);
      shown.current = shownKey;
    }
    r.setMask(d.mask);
    r.setToner(toner);
    const rubbed = parts?.wear?.() ?? null;
    r.setLayers(drawn, rubbed);
    r.setRelief(relief);
    r.setPrinter(printerLook(wear.printer, wear.printerSeed));
    const pen = rasterizePen(layout.strokes[p] ?? [], layout.size, scale);
    r.setInk(raster, pen, placement(layout, geo.warp, on, geo.extras));
    // They are on the GPU now.
    freeCanvases(raster, drawn, rubbed, pen);
    return r;
  };

  const shownDesk = deskFor(page);
  const shownKey = shownDesk
    ? `${shownDesk.id}${shapeOf(shownDesk.corners, shownDesk.bend)}${shownDesk.rulingKey}${JSON.stringify(shownDesk.margins)}${shownDesk.maskKey}${JSON.stringify(turnOf(shownDesk))}`
    : '';
  useEffect(() => {
    if (step !== 3 || !shownDesk || !layout || !isConvexClockwise(shownDesk.corners)) return;
    let alive = true;
    setBusy('Пишу текст на листе…');
    void draw(shownDesk, page, () => alive)
      .then((r) => r && alive && setInkReady((n) => n + 1))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => alive && setBusy(null));
    return () => {
      alive = false;
    };
  }, [step, layout, page, shownKey, glEpoch, refKey, blankRow, print.color, capture.mode, capture.seed, reliefKey, wear.printer, wear.printerSeed]);

  // A photo kept before the tilt was looked for (or whose sheet was not searched): looked at once, when shown.
  const lookAt = step === 3 ? shownDesk : step > 0 ? cur : null;
  useEffect(() => {
    if (lookAt && lookAt.tilt === undefined) void lookForTilt(lookAt);
  }, [lookAt?.id, lookAt?.tilt === undefined]);

  // A brushed mask goes straight to the GPU.
  useEffect(() => {
    if (step === 3 && shownDesk && shown.current?.startsWith(`${shownDesk.id}|`)) renderer.current?.setMask(shownDesk.mask);
  }, [shownDesk?.mask]);

  useEffect(() => {
    if (step === 3 && inkReady && layout && shownDesk) renderer.current?.render(lookFor(shownDesk), photoLookOf(shownDesk, calib?.t ?? null), base.ink, print.toner, stage, leftStage);
  });

  /** Takes the real pen's colour from words written on the sheet (a click on them). */
  const pickPen = async ([x, y]: Pt) => {
    const d = shownDesk;
    if (!picking || !d || !layout) return;
    const perMm = pixelsPerMm(onDesk(d, layout).paper, d.corners);
    setPicking(false);
    try {
      const c = await (await analysisOf(d)).calibrate(x, y, 4 * perMm, d.measure?.sigma ?? FALLBACK_BLUR);
      if (!c) {
        setError('Здесь нет чернил: щёлкните прямо по слову, написанному настоящей ручкой на этом листе.');
        return;
      }
      setError(null);
      setCalib({ t: c.t, mm: c.width / perMm });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Width of the handwriting's pen on this paper, mm. */
  const penMm = layout ? ((getHandwriting().style.weight * layout.fontSize) / 1000) * pageScale(layout) / MM : 0;

  const fileName = (p: number) => `${safeFilename(base.title)}${pageCount > 1 ? ` — лист ${p + 1}` : ''} (фото).jpg`;
  /** All the sheets at once: by the desk's name (or the document's), «Стол_1.jpg», «Стол_2.jpg»… */
  const sheetFile = (p: number) => `${safeFilename(deskName.trim() || base.title)}_${p + 1}.jpg`;

  const savePages = async (pages: number[]) => {
    setError(null);
    try {
      // One export, one folder.
      const folder = await exportFolder();
      for (const [i, p] of pages.entries()) {
        const d0 = deskFor(p);
        if (!d0) continue;
        setBusy(pages.length > 1 ? `Сохраняю лист ${i + 1} из ${pages.length}…` : 'Сохраняю…');
        const d = (await prepare(d0.id, { ruling: paperKind !== 'plain', mask: true, measure: true })) ?? d0;
        const r = await draw(d, p);
        if (!r) continue;
        // What is shown is what is saved: «до чертежей» saves the photo with the printing only.
        r.render({ ...lookFor(d), split: 0 }, photoLookOf(d, calib?.t ?? null), base.ink, print.toner, stage);
        await saveFile(await r.jpeg(0.92, d.crop), pages.length > 1 ? sheetFile(p) : fileName(p), folder);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      // Back to the sheet on screen.
      setInkReady(0);
      setGlEpoch((n) => n + 1);
    }
  };

  const paperName = isA4(paperMm) ? 'A4' : `${num(paperMm[0])} × ${num(paperMm[1])} мм`;
  const lineNote = layout?.ref
    ? (() => {
        const n = Math.round(layout.ref.pitch / layout.ref.lines.step);
        const what = layout.ref.lines.kind === 'grid' ? (n === 1 ? 'клетку' : n < 5 ? 'клетки' : 'клеток') : n === 1 ? 'линейку' : 'линейки';
        return `строка через ${n} ${what} (${num(layout.ref.pitch / MM)} мм)`;
      })()
    : null;
  /** The letters' size now: their line height as a share of the line of text. */
  const lettersNow = layout?.ref ? (layout.fontSize * pageScale(layout) * LINE_HEIGHT_EM) / layout.ref.pitch : null;
  const reflowNote = !layout
    ? null
    : sheet.mode === 'document'
      ? layout.ref
        ? `Строки и листы — как в документе: ${lineNote}, буквы ×${num(pageScale(layout), 2)} от редактора. Листов: ${layout.layers.length}.${
            sheet.every !== null && Math.round(layout.ref.pitch / layout.ref.lines.step) < sheet.every ? ' Шире строка не помещается: лист документа длиннее листа тетради.' : ''
          }`
        : looseMargins && Object.values(looseMargins).some((v) => v !== null)
          ? 'Строки и листы — как в документе, лист вписан между полями.'
          : !isA4(paperMm)
            ? 'Лист A4 уменьшен целиком: буквы мельче, чем в документе.'
            : null
      : `Текст заново разбит на листы ${paperName}${lineNote ? ` по линовке, ${lineNote}` : ''}: ${layout.layers.length}.`;

  const measured = shownDesk?.measure ?? null;
  const measureNote =
    shownDesk && measured
      ? [
          measured.sigma !== null ? `размытость ${num(measured.sigma)} px` : 'размытость и резкость — по умолчанию: краёв листа не видно',
          measured.sharpen >= 0.05 ? `телефон добавил резкости ×${num(measured.sharpen)}` : null,
          measured.noise ? 'шум измерен по чистой бумаге' : 'шум не измерить: мало чистой бумаги',
          shownDesk.glare ? 'есть блик — в нём чернила бледнеют' : 'бликов нет',
          shownDesk.mask?.objects ? `предметов на листе: ${shownDesk.mask.objects}` : null,
        ]
          .filter(Boolean)
          .join(', ')
      : null;

  const calibSwatch = calib ? `rgb(${calib.t.map((t) => Math.round(255 * Math.min(1, 0.92 * t) ** (1 / 2.2))).join(',')})` : null;
  const blurValue = shownDesk ? Math.round((shownDesk.measure?.sigma ?? FALLBACK_BLUR) * blurGain * 100) / 100 : FALLBACK_BLUR;

  /** The sheet's top goes to the next side; the bend turns with it (sides move round, the grid is fitted anew). */
  const turnTop = (d: Desk) => {
    const [c, s, b] = [d.corners, d.snapped, d.bend];
    patch(d.id, {
      corners: [c[1], c[2], c[3], c[0]],
      snapped: [s[1], s[2], s[3], s[0]],
      bend: b && (() => {
        const w = bowsOf(b)!;
        return { ...b, bulge: undefined, bows: [w[1], w[2], w[3], w[0]], grid: zeroGrid(), fixed: false, lines: undefined };
      })(),
    });
  };
  const toggleBend = (d: Desk, again = false) => {
    if (d.bend && !again) {
      patch(d.id, { bend: null });
      return;
    }
    setBusy('Ищу изогнутые края…');
    void curve(d, d.corners, true)
      .then((c) => c && patch(d.id, { ...c, touched: true }))
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(null));
  };

  // «[» and «]» change the brush.
  useEffect(() => {
    if (step !== 2) return;
    const keys = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === '[') setBrushRadius((r) => Math.max(6, Math.round(r / 1.25)));
      if (e.key === ']') setBrushRadius((r) => Math.min(200, Math.round(r * 1.25)));
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, [step]);

  // Another photo or another step: the whole photo again (or the whole crop, or all of it to crop by).
  useEffect(() => setView(FIT), [step, cur?.id, shownDesk?.id, cropping]);
  useEffect(() => {
    if (step !== 3) setCropping(false);
  }, [step]);
  /** The proportions (width / height) of a crop shape on this photo; null: free. */
  const aspectOf = (d: Desk, shape: CropShape): number | null => {
    if (shape === 'free') return null;
    if (shape === 'photo') return d.photo.width / d.photo.height;
    if (shape !== 'sheet') return shape;
    // As the sheet lies in the photo.
    const [pw, ph] = paperFor(d);
    const across = dist(d.corners[0], d.corners[1]) > dist(d.corners[0], d.corners[3]) === pw > ph;
    return across ? pw / ph : ph / pw;
  };
  /** The frame round the sheet with some of the desk: what is seen of it, in the proportions chosen. */
  const cropBySheet = (d: Desk, room: number, shape: CropShape): Crop => {
    const { width: w, height: h } = d.photo;
    const map = warpMap(warpOf(d));
    const pts = Array.from({ length: 33 }, (_, i) => i / 32).flatMap((t) => [map(t, 0), map(1, t), map(t, 1), map(0, t)]);
    const m = room * pixelsPerMm(paperSize(paperFor(d)), d.corners);
    const [x0, x1] = [Math.max(0, Math.min(...pts.map((p) => p[0])) - m), Math.min(w, Math.max(...pts.map((p) => p[0])) + m)];
    const [y0, y1] = [Math.max(0, Math.min(...pts.map((p) => p[1])) - m), Math.min(h, Math.max(...pts.map((p) => p[1])) + m)];
    const a = aspectOf(d, shape);
    if (!a) return [x0, y0, x1, y1];
    // Grown to the proportions (the sheet stays inside), as far as the photo allows.
    const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
    let [cw, ch] = [x1 - x0, y1 - y0];
    if (cw / ch > a) ch = cw / a;
    else cw = ch * a;
    if (cw > w || ch > h) return fitAspect([0, 0, w, h], a, w, h);
    return within([cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2], w, h);
  };
  /** The result shown pixel for pixel. */
  const actual = !!resultFit.current && Math.abs(resultFit.current.fit * view.z * (window.devicePixelRatio || 1) - 1) < 0.02;

  // What the program has to say, over the photo.
  const messages: Message[] = [];
  if (error) messages.push({ key: `error:${error}`, kind: 'error', text: error });
  if (cur && (step === 1 || step === 2) && foundNote[cur.id]) messages.push({ key: `found:${cur.id}:${foundNote[cur.id]}`, kind: 'info', text: foundNote[cur.id] });
  if (note) messages.push({ key: `note:${note}`, kind: 'info', text: note });
  if (step === 1 && cur && !valid) {
    messages.push({ key: 'twisted', kind: 'warn', text: 'Уголки перекрутились: расставьте их по кругу, по часовой стрелке от верхнего левого.' });
  }
  // (Corners outside the frame are the photo's frame seen in perspective: its shape, not the sheet's.)
  const beyond = !!cur && cur.corners.some(([x, y]) => x < -1 || y < -1 || x > cur.photo.width + 1 || y > cur.photo.height + 1);
  if (step === 1 && cur && valid && !blankId && !beyond && sheet.orient !== 'landscape' && topLooksSideways(cur.corners, paperFor(cur))) {
    messages.push({ key: `sideways:${cur.id}`, kind: 'warn', text: 'Похоже, верх листа отмечен сбоку.', action: { label: '↻ Повернуть', run: () => turnTop(cur) } });
  }
  if (step === 2 && cur && hasRuling(cur)) {
    const r = cur.ruling;
    const hint = r && formatHint(r, paperFor(cur), sheet.byGrid);
    if (!r && paperKind !== 'plain') messages.push({ key: `nolines:${cur.id}`, kind: 'warn', text: 'Линии не нашлись: текст ляжет как на чистом листе.' });
    if (hint) messages.push({ key: `format:${hint}`, kind: 'warn', text: hint });
    if (r && sheet.paper === 'plain' && !blankId) {
      const grid = r.kind === 'grid';
      messages.push({
        key: `suggest:${cur.id}`,
        kind: 'warn',
        text: `На листе ${grid ? 'клетка' : 'линейка'}: подогнать текст под неё?`,
        action: { label: grid ? 'Да, в клетку' : 'Да, в линейку', run: () => changeSheet({ paper: r.kind }) },
      });
    }
  }
  const shownMessages = messages.filter((m) => !gone.includes(m.key));
  const dismiss = (key: string) => (key.startsWith('error:') ? setError(null) : setGone((g) => [...g, key]));

  const stepOff = (i: number) => i > 0 && (!cur || (i >= 2 && !valid) || (i === 3 && !allValid));
  const hasPanel = step > 0 || desks.length > 0;
  const hasRail = step > 0 && !!cur;
  const hasStrip = desks.length > 0;

  /** The panel's main button: on to the next step. */
  const next = (to: number, label: string, disabled = false) => (
    <button className="btn primary wide" disabled={disabled} onClick={() => setStep(to)}>
      {label} →
    </button>
  );

  const rulingLine = (() => {
    if (!cur || !hasRuling(cur)) return <p className="muted small">Ищу…</p>;
    const r = cur.ruling;
    if (!r) return <p className="muted small">{paperKind === 'plain' ? 'Линовки на листе нет.' : 'Линии не нашлись.'}</p>;
    const what = r.kind === 'grid' ? `Клетка ${num(r.colStep ?? r.step)} мм` : `Линейка через ${num(r.step)} мм`;
    return (
      <p className="small">
        {what}
        {sheet.byGrid && cur.gridSize ? ` · лист ${num(cur.gridSize[0])} × ${num(cur.gridSize[1])} мм` : ''}
      </p>
    );
  })();
  const rulingHint =
    cur?.ruling && hasRuling(cur) ? (
      <>
        {cur.ruling.kind === 'grid' ? `Клетка ${num(cur.ruling.colStep ?? cur.ruling.step)} × ${num(cur.ruling.step)} мм` : `Линейка через ${num(cur.ruling.step)} мм`}
        {Math.abs(cur.ruling.slope) > 0.001 ? `, наклон к краю ${num((Math.atan(cur.ruling.slope) * 180) / Math.PI, 2)}°` : ''}.
        {sheet.byGrid && cur.gridSize ? ` Размер листа прочитан по клеткам (каждая — 5 мм).` : ''}
        {cur.bend?.lines && ` Изгиб уточнён по линовке: строки отклонялись от прямой на ${num(cur.bend.lines.before, 2)} мм, теперь на ${num(cur.bend.lines.after, 2)} мм.`}
      </>
    ) : (
      'Линии клетки или линейки, найденные на листе: по ним ложатся строки текста.'
    );

  return createPortal(
    <div className="desk-backdrop">
      <div
        className={`desk-dialog ${hasPanel ? 'has-panel' : ''} ${hasRail ? 'has-rail' : ''} ${hasStrip ? 'has-strip' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Текст на фото листа"
      >
        <header className="desk-head">
          <div className="desk-title float">
            <span>На столе</span>
            {deskId && <input className="desk-name" value={deskName} onChange={(e) => setDeskName(e.target.value)} aria-label="Имя стола" title="Имя стола в «Мои столы»" />}
          </div>
          <nav className="pill float desk-steps" aria-label="Шаги">
            {STEPS.map((name, i) => (
              <button key={name} className={i === step ? 'on' : ''} disabled={stepOff(i)} onClick={() => setStep(i)}>
                <span className="desk-step-n">{i + 1}</span>
                {name}
              </button>
            ))}
          </nav>
          <div className="desk-head-end">
            {deskId ? (
              <span className="desk-saved" title="Стол в «Мои столы» сохраняется сам">
                {saving ? 'Сохраняю…' : 'Сохранено ✓'}
              </span>
            ) : (
              desks.length > 0 && (
                <button className="btn desk-keep" disabled={!!busy} onClick={keepDesk} title="Все фото, разметка и настройки — в «Мои столы»; дальше стол сохраняется сам">
                  Сохранить стол
                </button>
              )
            )}
            <button className="rail-btn desk-close" onClick={() => void close()} aria-label="Закрыть" title="Закрыть (Esc)">
              <CloseIcon />
            </button>
          </div>
        </header>

        {hasRail && cur && (
          <div className="desk-rail float">
            {step === 1 && (
              <>
                <Tool icon={<TurnIcon />} label="Верх листа — на следующую сторону" onClick={() => turnTop(cur)} />
                <Tool icon={<RotatePhotoIcon />} label="Повернуть снимок на 90° (скан или фото пришли боком)" disabled={!!busy} onClick={() => void rotatePhoto(cur)} />
                <Tool
                  icon={<FindSheetIcon />}
                  label="Найти лист заново"
                  disabled={!!busy}
                  onClick={() => {
                    setBusy('Ищу лист на фото…');
                    void findSheet(cur, true).finally(() => setBusy(null));
                  }}
                />
                <Tool
                  icon={<ScanIcon />}
                  label="Скан: лист занимает весь снимок, без перспективы и изгиба"
                  onClick={() => patch(cur.id, { corners: frameOf(cur.photo), snapped: NONE, bend: null, touched: true })}
                />
                <Tool icon={<CurveIcon />} label={cur.bend ? 'Изогнутый лист: выключить' : 'Изогнутый лист: края дугой, страница у корешка'} on={!!cur.bend} disabled={!!busy} onClick={() => toggleBend(cur)} />
                <span className="rail-sep" />
                <Hint side="right">
                  Перетащите уголки на уголки листа: отпущенный уголок прилипает к краям (сплошная линия — край найден, пунктир — нет). С Alt — без
                  прилипания, с Shift — точнее, стрелками — на ¼ пикселя, Tab — следующий уголок.
                  {' '}Ромбики на краях гнут край: отпущенный прилипает к краю на снимке (с Alt — нет), двойной щелчок по краю добавляет ромбик, Alt + щелчок убирает.
                  {cur.bend && ' Квадратные точки сетки изогнутого листа можно тянуть там, где текст должен лечь иначе.'}
                </Hint>
              </>
            )}
            {step === 2 && (
              <>
                <Tool
                  icon={<EraseIcon />}
                  label="Стереть: здесь текст не пишется"
                  on={tool === 'brush' && brush === 'erase'}
                  onClick={() => {
                    setBrush('erase');
                    setTool('brush');
                  }}
                />
                <Tool
                  icon={<BrushIcon />}
                  label="Вернуть бумагу"
                  on={tool === 'brush' && brush === 'restore'}
                  onClick={() => {
                    setBrush('restore');
                    setTool('brush');
                  }}
                />
                <Tool icon={<MarginsIcon />} label="Поля: тянуть розовые линии" on={tool === 'margins'} onClick={() => setTool('margins')} />
                <Tool icon={<DotIcon />} label="Размер кисти">
                  <label className="slider desk-brush">
                    <span>
                      Кисть, px <output>{brushRadius}</output>
                    </span>
                    <input type="range" min={6} max={200} step={2} value={brushRadius} onChange={(e) => setBrushRadius(Number(e.target.value))} />
                    <span className="muted small">Клавиши [ и ] — меньше и больше</span>
                  </label>
                </Tool>
                <span className="rail-sep" />
                <Tool icon={<AgainIcon />} label="Найти предметы заново (кисть забудется)" onClick={() => patch(cur.id, { maskKey: null })} />
                <Tool
                  icon={<ClearIcon />}
                  label="Очистить: убрать все красные отметки"
                  disabled={!cur.mask}
                  onClick={() => cur.mask && patch(cur.id, { mask: { ...cur.mask, objects: 0, data: new Uint8Array(cur.mask.data.length).fill(255) } })}
                />
              </>
            )}
            {step === 3 && (
              <>
                {look.pen !== 'pencil' && (
                  <Tool
                    icon={<PipetteIcon />}
                    label={picking ? 'Щёлкните по слову на фото…' : 'Взять цвет с настоящей ручки: щёлкнуть по слову на листе'}
                    on={picking}
                    onClick={() => setPicking(!picking)}
                  />
                )}
                <Tool
                  icon={<CropIcon />}
                  label="Обрезка: что из снимка сохранять"
                  on={cropping}
                  disabled={!shownDesk}
                  onClick={() => {
                    setPicking(false);
                    setCropping(!cropping);
                  }}
                />
                <Tool icon={<ActualIcon />} label="Масштаб 1:1 (колесо мыши — ближе или дальше)" on={actual} onClick={() => setView(actual || !resultFit.current ? FIT : oneToOne(resultFit.current))} />
              </>
            )}
          </div>
        )}

        <main className="desk-main">
          {step === 0 && (
            <div
              className={`desk-drop ${drop ? 'over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrop(true);
              }}
              onDragLeave={() => setDrop(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrop(false);
                void addFiles([...e.dataTransfer.files]);
              }}
            >
              <div className="desk-drop-zone">
                <p className="desk-drop-title">Перетащите сюда фото листов</p>
                <div className="desk-drop-row">
                  <button className="btn primary" onClick={() => fileRef.current?.click()}>
                    {desks.length ? 'Добавить фото…' : 'Выбрать фото…'}
                  </button>
                  <Hint side="below">
                    Программа напишет текст документа на этих листах — с перспективой, под тем же светом и с теми же тенями, что на снимках. Нужны пустые листы,
                    снятые сверху при ровном свете: одно фото на все листы документа или по фото на лист. JPG, PNG или WebP; большие фото уменьшаются до{' '}
                    {WORK_SIDE} px по длинной стороне.
                  </Hint>
                </div>
              </div>
              {saved.length > 0 && (
                <section className="desk-shelf">
                  <h3>
                    Мои столы
                    <Hint side="right">Стол — это все фото экспорта с разметкой и настройками. Открытый стол встаёт как был и сохраняется сам. «+ фото» добавляет его фото к фото здесь.</Hint>
                  </h3>
                  <ul>
                    {saved.map((s) => (
                      <li key={s.id} className={`desk-shelf-card float ${s.id === deskId ? 'on' : ''}`}>
                        <button className="desk-shelf-open" onClick={() => void openSaved(s)} title="Открыть этот стол: фото, разметку и настройки">
                          <SavedThumb blob={s.thumb} />
                          <span className="desk-shelf-name">{s.name}</span>
                          <span className="muted small">
                            {s.photos.length} фото · {new Date(s.updatedAt).toLocaleDateString('ru-RU')}
                          </span>
                        </button>
                        <div className="desk-shelf-actions">
                          {s.id !== deskId && (
                            <button className="link-btn" disabled={!!busy} onClick={() => void addSaved(s)} title="Добавить фото этого стола к фото здесь">
                              + фото
                            </button>
                          )}
                          <button
                            className="link-btn danger"
                            title="Удалить из «Мои столы»"
                            onClick={() => {
                              if (!confirm(`Удалить «${s.name}» из «Мои столы»?`)) return;
                              if (s.id === deskId) setDeskId(null);
                              void deleteDesk(s.id);
                            }}
                          >
                            удалить
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
          {step === 1 && cur && (
            <CornerEditor
              key={cur.id}
              photo={cur.photo}
              corners={cur.corners}
              onChange={(c) => {
                edits.current++;
                patch(cur.id, { corners: c, touched: true });
              }}
              bend={cur.bend}
              onGrid={(grid) => cur.bend && patch(cur.id, { bend: { ...cur.bend, grid, fixed: true, lines: undefined } })}
              snapped={cur.snapped}
              onRelease={(i, free, at) => void release(cur, i, free, at)}
              onNudge={(i) => patch(cur.id, { touched: true, snapped: cur.snapped.map((v, k) => (k === i || k === (i + 3) % 4 ? false : v)) })}
              found={showLines ? cur.tilt?.lines : null}
              guides={guides?.id === cur.id ? guides.lines : null}
              onGuides={(lines, done) => {
                setGuides({ id: cur.id, lines });
                if (done) applyLines(cur, lines);
              }}
              onBows={(bows, done) => editBows(cur, bows, done)}
              view={view}
              onView={setView}
            />
          )}
          {step === 2 && cur && (
            <MaskEditor
              key={cur.id}
              photo={cur.photo}
              warp={warpOf(cur)}
              paperMm={paperFor(cur)}
              ruling={hasRuling(cur) ? cur.ruling : null}
              margins={marginsOf(cur)}
              mask={cur.maskKey === keyOf(cur) ? cur.mask : null}
              tool={tool}
              brush={brush}
              radius={brushRadius}
              onChange={(m) => patch(cur.id, { mask: m })}
              onMargins={(m) => patch(cur.id, { margins: m })}
              view={view}
              onView={setView}
            />
          )}
          <ResultView
            canvasRef={canvasRef}
            width={shownDesk?.photo.width ?? 0}
            height={shownDesk?.photo.height ?? 0}
            hidden={step !== 3}
            view={view}
            onView={setView}
            onFit={(f) => (resultFit.current = f)}
            picking={picking}
            onPick={(p) => void pickPen(p)}
            shutter={step === 3 && inkReady > 0 && shownDesk && !cropping ? { value: split, onChange: setSplit } : null}
            region={cropping ? null : (shownDesk?.crop ?? null)}
            over={
              cropping && shownDesk
                ? (place) => (
                    <CropBox
                      crop={shownDesk.crop ?? [0, 0, shownDesk.photo.width, shownDesk.photo.height]}
                      width={shownDesk.photo.width}
                      height={shownDesk.photo.height}
                      place={place}
                      aspect={aspectOf(shownDesk, cropShape)}
                      onChange={(crop) => patch(shownDesk.id, { crop })}
                    />
                  )
                : undefined
            }
          >
            {step === 3 && inkReady > 0 && (
              <div className="desk-stages" role="group" aria-label="Показать до этапа">
                <span className="small muted">Показать до:</span>
                <Pill value={stage} onChange={setStage} options={STAGES.map((s) => [s.id, s.name, s.hint] as [Stage, ReactNode, string])} />
                {split > 0 && (
                  <label className="small" title="Что показывает шторка слева">
                    слева{' '}
                    <select value={leftStage} onChange={(e) => setLeftStage(e.target.value as Stage)}>
                      {STAGES.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name.toLowerCase()}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
          </ResultView>
          <div className="desk-busy-stack">
            {step === 3 && !layout && <LayoutProgress {...laying} />}
            {(busy || preparing) && <div className="desk-busy">{busy ?? preparing}</div>}
          </div>
          <Toasts messages={shownMessages} onClose={dismiss} />
        </main>

        {hasStrip && (
          <PhotoStrip
            photos={desks}
            current={step > 0 ? (step === 3 ? (shownDesk?.id ?? null) : (cur?.id ?? null)) : null}
            onPick={(id) => {
              if (step === 3 && assign === 'each' && desks.length > 1) setPageDesk({ ...pageDesk, [page]: id });
              else setCurId(id);
              if (step === 0) setStep(1);
            }}
            onRemove={(id) => {
              const d = desks.find((x) => x.id === id);
              if (d) removeDesk(d);
            }}
            onAdd={() => fileRef.current?.click()}
          />
        )}

        {hasPanel && (
          <aside className={`desk-panel float ${step === 0 ? 'short' : ''}`}>
            <div className="desk-panel-body">
              {step === 0 && (
                <Section title="Фото" hint="Каждое фото — лист на столе. Его можно взять для всех листов документа или для одного; это выбирается на шаге «Чернила».">
                  <p className="small">
                    {desks.length} {desks.length === 1 ? 'фото' : 'фото'} в этом экспорте. Щёлкните по фото внизу, чтобы разметить его.
                  </p>
                </Section>
              )}

              {step === 1 && cur && (
                <>
                  <Section title="Формат листа" hint="Размер настоящего листа. На листе в клетку он читается по самим клеткам (каждая — 5 мм), если включено «размер по клеткам».">
                    <Pill
                      wrap
                      value={sheet.kind}
                      onChange={(k) => changeSheet({ kind: k })}
                      options={[
                        ...(Object.keys(SHEET_KINDS) as SheetKind[]).map(
                          (k) => [k, <span className="desk-fmt">{SHEET_KINDS[k].name}<small>{SHEET_KINDS[k].mm[0]}×{SHEET_KINDS[k].mm[1]}</small></span>] as [DeskFormat, ReactNode],
                        ),
                        ['custom', <span className="desk-fmt">Свой<small>{num(sheet.custom[0], 0)}×{num(sheet.custom[1], 0)}</small></span>],
                      ]}
                    />
                    {sheet.kind === 'custom' && (
                      <div className="desk-size">
                        {([0, 1] as const).map((i) => (
                          <label key={i}>
                            {i ? 'высота' : 'ширина'}
                            <input
                              type="number"
                              min={50}
                              max={600}
                              step={0.5}
                              value={sheet.custom[i]}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                if (v >= 50 && v <= 600) changeSheet({ custom: i ? [sheet.custom[0], v] : [v, sheet.custom[1]] });
                              }}
                            />
                            мм
                          </label>
                        ))}
                      </div>
                    )}
                    <div className="desk-field">
                      <span>Лист лежит</span>
                      <Pill
                        value={sheet.orient ?? 'auto'}
                        onChange={(orient) => changeSheet({ orient })}
                        options={[
                          ['auto', 'авто', blankId ? 'Как показывают уголки: верхний край длиннее — альбомный' : 'Книжный (верх — короткая сторона)'],
                          ['portrait', 'книжный'],
                          ['landscape', 'альбомный'],
                        ]}
                      />
                    </div>
                    <label className="check">
                      <input type="checkbox" checked={sheet.byGrid} onChange={(e) => changeSheet({ byGrid: e.target.checked })} />
                      Размер в клетку — по клеткам
                    </label>
                  </Section>
                  {!blankId && (
                    <Section title="Бумага" hint="Чистая, в линейку или в клетку: на линованной бумаге строки текста ложатся на её линии.">
                      <Pill value={sheet.paper} onChange={(k) => changeSheet({ paper: k })} options={PAPER_NAMES.map(([k, name]) => [k, name] as [PaperStyle, ReactNode])} />
                    </Section>
                  )}
                  {(() => {
                    const { width: w, height: h } = cur.photo;
                    const whole = !sidesBeyond(cur.corners, cur.snapped, w, h).some(Boolean);
                    const t = cur.tilt;
                    const found = sureTilt(t) ? t : null;
                    const drawing = guides?.id === cur.id;
                    const lines = t?.lines.length ?? 0;
                    return (
                      <Section
                        title="Перспектива"
                        hint="Как телефон держали над листом. Пока края листа в кадре, перспектива берётся по уголкам. Если лист выходит за кадр, она ищется по прямым линиям на снимке (строки и клетки, края стола и других листов) — их можно показать — или задаётся вручную: проведите две пары линий вдоль листа или поправьте ползунками."
                        aside={
                          cur.handTilt && (
                            <button className="link-btn" onClick={() => setHandTilt(cur, null)} title="Забыть ручную перспективу">
                              ↺ как найдено
                            </button>
                          )
                        }
                      >
                        <p className="small">
                          {cur.handTilt
                            ? `Задана вручную${cur.handLines ? ' по линиям' : ''}: ${describeTilt(cur.handTilt)}.`
                            : t === undefined
                              ? 'Ищу прямые линии на снимке…'
                              : found
                                ? `Найдена по линиям на снимке${found.by === 'one' ? ' (по одному направлению)' : ''}: ${describeTilt(anglesOf(found.rot))}.`
                                : t && t.confidence >= SURE_TILT
                                  ? 'По линиям на снимке лист снят прямо.'
                                  : `Прямых линий на снимке ${lines ? 'мало' : 'нет'} — перспектива не найдена.`}
                        </p>
                        {whole && <p className="muted small">Края листа в кадре — перспектива берётся по уголкам.</p>}
                        <label className="check">
                          <input type="checkbox" checked={showLines && !drawing} disabled={!lines || drawing} onChange={(e) => setShowLines(e.target.checked)} />
                          Показать найденные линии{lines ? ` (${lines})` : ''}
                        </label>
                        {whole && !drawing ? null : drawing ? (
                          <>
                            <p className="muted small">
                              Перетащите концы линий: розовые — вдоль строк или верхнего края листа, голубые — вдоль полей или боковых краёв. Чем длиннее линии и дальше друг от друга, тем точнее.
                            </p>
                            <button className="btn" onClick={() => setGuides(null)}>
                              Готово
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn"
                            onClick={() => setGuides({ id: cur.id, lines: cur.handLines ?? startLines(t?.lines, cur.corners, w, h) })}
                            title="Провести на снимке две пары линий вдоль листа: по ним перспектива считается точно"
                          >
                            ✎ Провести линии
                          </button>
                        )}
                        {!whole && (
                          <TiltSliders
                            value={cur.handTilt ?? (found ? anglesOf(found.rot) : blankId ? madeUpAngles(capture.seed) : { pitch: 0, yaw: 0, roll: 0 })}
                            onChange={(a) => setHandTilt(cur, a)}
                          />
                        )}
                      </Section>
                    );
                  })()}
                  {cur.bend && (
                    <Section
                      title="Изогнутый лист"
                      hint={`Края повторяют снимок: на каждом столько точек, сколько нужно, чтобы пройти по всем изгибам. Ромбики на краях можно тянуть, двойной щелчок по краю добавляет точку.${paperKind !== 'plain' ? ' На линованном листе сетка сама подстроится под линии на шаге «Помехи» — так густо, как нужно.' : ''}`}
                      aside={
                        <button className="link-btn" disabled={!!busy} onClick={() => toggleBend(cur, true)} title="Найти изогнутые края заново по снимку">
                          ↺ как найдено
                        </button>
                      }
                    >
                      {(() => {
                        const bows = bowsOf(cur.bend)!;
                        const g = cur.bend.grid;
                        return (
                          <>
                            <p className="small">
                              Края выгнуты до {num(cur.bend.max)} px; точек на краях: {bows.map((b) => b.t.length - 2).join(', ')}
                              {g.nx > 5 ? `; сетка ${g.nx}×${g.ny}` : ''}.
                            </p>
                            {bows.some((b) => b.t.length > 5) && (
                              <button className="link-btn" onClick={() => editBows(cur, simpleBows(bows), null)} title="Каждый край — одной плавной дугой (если точки легли на что-то лишнее)">
                                Упростить
                              </button>
                            )}
                          </>
                        );
                      })()}
                    </Section>
                  )}
                </>
              )}

              {step === 2 && cur && (
                <>
                  {!blankId && (
                  <>
                  <Section title="Линовка" hint={rulingHint}>
                    {rulingLine}
                  </Section>
                  <Section
                    title="Поля"
                    hint="Текст пишется между розовыми линиями. Инструментом «Поля» слева их можно тянуть целиком или за конец — тогда линия поворачивается вокруг другого конца. Линии прилипают к клетке (с Alt — нет), двойной щелчок выпрямляет линию вдоль клетки. Число можно ввести и здесь."
                    aside={
                      cur.margins && (
                        <button className="link-btn" onClick={() => patch(cur.id, { margins: null })} title="Поля, как их нашла программа">
                          ↺ как найдено
                        </button>
                      )
                    }
                  >
                    <ul className="desk-margins">
                      {SIDES.map(([side, name]) => {
                        const m = marginsOf(cur);
                        const v = m[side];
                        const [pw, ph] = paperFor(cur);
                        const fallback = { left: 20, right: pw - 10, top: 10, bottom: ph - 10 }[side];
                        // A new line goes along the printed ones; one turned off them shows its other end too.
                        const straight = (at: number) => marginLines({ ...NO_MARGINS, [side]: at }, hasRuling(cur) ? (cur.ruling?.slope ?? 0) : 0, [pw, ph])[side]!;
                        const turned = v !== null && Math.abs(v.b - straight(v.a).b) >= 0.05;
                        const commit = (input: HTMLInputElement) => {
                          const a = Number(input.value.replace(',', '.'));
                          if (v && Number.isFinite(a) && Math.abs(a - v.a) >= 0.05) patch(cur.id, { margins: { ...m, [side]: { a, b: a + (v.b - v.a) } } });
                        };
                        return (
                          <li key={side}>
                            <span>{name}</span>
                            {v !== null ? (
                              <>
                                <input
                                  key={v.a.toFixed(1)}
                                  className="desk-mm-input"
                                  defaultValue={num(v.a)}
                                  inputMode="decimal"
                                  aria-label={`Поле ${name}, мм`}
                                  title={side === 'left' || side === 'right' ? 'у верхнего края, мм' : 'у левого края, мм'}
                                  onBlur={(e) => commit(e.currentTarget)}
                                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                                />
                                <span className="muted small desk-mm-end">{turned ? `→ ${num(v.b)}` : 'мм'}</span>
                                <button className="desk-x" aria-label={`Убрать поле ${name}`} title="Убрать" onClick={() => patch(cur.id, { margins: { ...m, [side]: null } })}>
                                  <CloseIcon />
                                </button>
                              </>
                            ) : (
                              <button
                                className="link-btn"
                                onClick={() => {
                                  patch(cur.id, { margins: { ...m, [side]: straight(fallback) } });
                                  setTool('margins');
                                }}
                              >
                                + добавить
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </Section>
                  </>
                  )}
                  <Section title="Предметы на листе" hint="Красным — где текст не пишется: ручка, пальцы, всё, что не похоже на бумагу. Кисти слева добавляют красное или возвращают бумагу.">
                    <p className="small">{cur.maskKey === keyOf(cur) && cur.mask ? `Найдено: ${cur.mask.objects}` : 'Ищу…'}</p>
                  </Section>
                </>
              )}

              {step === 3 && (
                <>
                  {shownDesk && (cropping || shownDesk.crop) && (
                    <Section
                      title="Обрезка"
                      hint="Что из снимка сохранять. Тяните стороны и углы рамки, внутри неё — двигать; Shift держит пропорции. Снимок режется пиксель в пиксель, без пересжатия. У каждого фото своя обрезка."
                      aside={
                        shownDesk.crop && (
                          <button className="link-btn" onClick={() => patch(shownDesk.id, { crop: null })} title="Сохранять весь снимок">
                            ↺ весь снимок
                          </button>
                        )
                      }
                    >
                      {cropping ? (
                        <>
                          <Pill
                            wrap
                            value={cropShape}
                            onChange={(shape) => {
                              setCropShape(shape);
                              const a = aspectOf(shownDesk, shape);
                              const { width: w, height: h } = shownDesk.photo;
                              if (a) patch(shownDesk.id, { crop: fitAspect(shownDesk.crop ?? [0, 0, w, h], a, w, h) });
                            }}
                            options={[
                              ['free', 'свободно'],
                              ['photo', 'как снимок'],
                              [3 / 4, '3:4'],
                              [4 / 3, '4:3'],
                              [1, '1:1'],
                              ['sheet', 'как лист'],
                            ]}
                          />
                          <label className="slider" title="Сколько стола оставить вокруг листа">
                            <span>
                              Отступ от листа <output>{cropRoom} мм</output>
                            </span>
                            <input type="range" min={0} max={20} step={1} value={cropRoom} onChange={(e) => setCropRoom(Number(e.target.value))} />
                          </label>
                          <div className="desk-field">
                            <button className="btn" onClick={() => patch(shownDesk.id, { crop: cropBySheet(shownDesk, cropRoom, cropShape) })} title="Рамка вокруг листа с отступом; где лист выходит за кадр — по краю кадра">
                              По листу
                            </button>
                            <button className="btn primary" onClick={() => setCropping(false)}>
                              Готово
                            </button>
                          </div>
                        </>
                      ) : (
                        <p className="small">
                          Сохранится {Math.round(shownDesk.crop![2] - shownDesk.crop![0])} × {Math.round(shownDesk.crop![3] - shownDesk.crop![1])} px.{' '}
                          <button className="link-btn" onClick={() => setCropping(true)}>
                            Изменить
                          </button>
                        </p>
                      )}
                    </Section>
                  )}
                  {(pageCount > 1 || desks.length > 1) && (
                    <Section title="Лист документа" hint="Какой лист документа сейчас на фото. Если фото несколько, каждому листу можно дать своё: выберите лист и щёлкните по фото внизу.">
                      {pageCount > 1 && (
                        <div className="desk-pager">
                          <button className="btn small" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Предыдущий лист">
                            ‹
                          </button>
                          <span>
                            {page + 1} из {pageCount}
                          </span>
                          <button className="btn small" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)} aria-label="Следующий лист">
                            ›
                          </button>
                        </div>
                      )}
                      {desks.length > 1 && (
                        <>
                          <Pill
                            value={assign}
                            onChange={setAssign}
                            options={[
                              ['one', 'одно фото на все'],
                              ['each', 'своё для листа'],
                            ]}
                          />
                          <p className="muted small">На фото {desks.findIndex((d) => d.id === shownDesk?.id) + 1}: щёлкните по другому внизу, чтобы сменить.</p>
                        </>
                      )}
                    </Section>
                  )}
                  {!blankId && (!isA4(paperMm) || sheet.paper !== 'plain') && (
                    <Section title="Текст" hint={reflowNote ?? 'Как текст ложится на лист.'}>
                      <Pill
                        value={sheet.mode}
                        onChange={(mode) => changeSheet({ mode })}
                        options={[
                          ['document', 'как в документе', 'Те же строки и те же листы, что в редакторе'],
                          ['fit', 'заполнить лист', 'Текст заново разбит по листу: на него войдёт больше'],
                        ]}
                      />
                      {layout?.ref && (
                        <>
                          <div className="desk-field">
                            <span>Строка через, {layout.ref.lines.kind === 'grid' ? 'клеток' : 'линеек'}</span>
                            <Pill value={sheet.every} onChange={(every) => changeSheet({ every })} options={[null, 1, 2, 3].map((n) => [n, n ?? 'авто'] as [number | null, ReactNode])} />
                          </div>
                          <label className="slider" title="Высота строки букв в доле строки тетради: меньше — мельче буквы">
                            <span>
                              Размер букв, % строки
                              <output>
                                {sheet.letters !== null && (
                                  <button className="link-btn" onClick={() => changeSheet({ letters: null })}>
                                    ↺ авто{' '}
                                  </button>
                                )}
                                {Math.round(100 * (sheet.letters ?? lettersNow ?? 1))}
                              </output>
                            </span>
                            <input
                              type="range"
                              min={0.5}
                              max={1.3}
                              step={0.05}
                              value={sheet.letters ?? lettersNow ?? 1}
                              onChange={(e) => changeSheet({ letters: Number(e.target.value) })}
                            />
                          </label>
                        </>
                      )}
                      {layout?.ref?.lines.kind === 'grid' && (
                        <label className="check" title="Единица чертежа — целое число клеток, оси идут по линиям клетки">
                          <input type="checkbox" checked={sheet.squares} onChange={(e) => changeSheet({ squares: e.target.checked })} />
                          Чертежи по клеткам
                        </label>
                      )}
                    </Section>
                  )}
                  {shownDesk && (
                    <Section
                      title="Съёмка"
                      hint="Как снимок «снят». Когда края листа видны, перспектива и изгиб берутся с самого снимка. Если лист занимает весь кадр, наклон телефона ищется по прямым линиям на снимке (строки и клетки тетради, края стола и других листов, рамки): они сходятся вдали. Если линий нет: при ровном свете — как страница из приложения-сканера (свет выровнен, лист прямой); при неровном на бланке камера досоздаётся. Наклон можно поправить ползунками; объектив чуть выгибает линии у краёв, бумага слегка волнится там, где на снимке тени."
                    >
                      <Pill
                        value={capture.mode}
                        onChange={(mode) => changeCapture({ mode })}
                        options={[
                          ['auto', 'авто'],
                          ['photo', 'как снимок'],
                          ['scan', 'как сканер'],
                        ]}
                      />
                      {(() => {
                        const how = captureFor(shownDesk);
                        if (how !== 'camera')
                          return (
                            <p className="muted small">
                              {how === 'scan'
                                ? 'Как страница сканер-приложения: свет выровнен, лист прямой.'
                                : 'Как на снимке: перспектива и изгиб листа — с фото.'}
                            </p>
                          );
                        const found = sureTilt(shownDesk.tilt) ? shownDesk.tilt : null;
                        const angles = shownDesk.handTilt ?? (found ? anglesOf(found.rot) : madeUpAngles(capture.seed));
                        return (
                          <>
                            <p className="muted small">
                              {shownDesk.handTilt
                                ? `Лист во весь кадр — наклон задан вручную: ${describeTilt(angles)}.`
                                : found
                                  ? `Лист во весь кадр — перспектива найдена по линиям на снимке${found.by === 'one' ? ' (по одному направлению)' : ''}: ${describeTilt(angles)}.`
                                  : `Лист во весь кадр, прямых линий на снимке нет — наклон досоздан: ${describeTilt(angles)}.`}{' '}
                              {shownDesk.handTilt ? (
                                <button className="link-btn" onClick={() => setHandTilt(shownDesk, null)} title="Забыть ручной наклон">
                                  ↺ {found ? 'как найдено' : 'досоздать'}
                                </button>
                              ) : (
                                <button className="link-btn" onClick={() => changeCapture({ seed: capture.seed + 1 })} title={found ? 'Другой объектив и место листа в кадре' : 'Другой наклон телефона и другой объектив'}>
                                  ↺ другая камера
                                </button>
                              )}
                            </p>
                            <TiltSliders value={angles} onChange={(a) => setHandTilt(shownDesk, a)} />
                          </>
                        );
                      })()}
                    </Section>
                  )}
                  {blankId && (
                    <Section
                      title="Печать"
                      hint="Бланк печатается на чистый лист с фото, поверх пишет ручка. Альбомный бланк на книжном листе повёрнут, как его кладёт принтер. Принтер не печатает идеально ровно: лёгкий перекос и сдвиг (до 0,3° и 1 мм) делают снимок правдоподобнее."
                    >
                      {!blankRow && <p className="muted small">Бланк этого документа не нашёлся: печатать нечего.</p>}
                      <Pill
                        value={print.color ? 'color' : 'bw'}
                        onChange={(v) => changePrint({ color: v === 'color' })}
                        options={[
                          ['bw', 'ч/б принтер', 'Чёрно-белый лазерный: цветное выйдет серым'],
                          ['color', 'цветной', 'Цвета бланка, как на картинке'],
                        ]}
                      />
                      {layout && layout.size.w > layout.size.h !== layout.paper.w > layout.paper.h && (
                        <div className="desk-field">
                          <span>Верх бланка</span>
                          <Pill
                            value={print.turnAuto ? 0 : print.turn}
                            onChange={(turn) => changePrint(turn === 0 ? { turnAuto: true } : { turnAuto: false, turn: turn as 1 | -1 })}
                            options={[
                              [0, 'авто', 'Так, чтобы бланк на снимке стоял прямо'],
                              [-1, '← слева', 'Верх бланка у левого края листа'],
                              [1, 'справа →', 'Верх бланка у правого края листа'],
                            ]}
                          />
                        </div>
                      )}
                      <div className="desk-field">
                        <label className="check" title="Лёгкий поворот и сдвиг печати, как у настоящего принтера">
                          <input type="checkbox" checked={print.skew} onChange={(e) => changePrint({ skew: e.target.checked })} />
                          Чуть криво, как принтер
                        </label>
                        {print.skew && (
                          <button className="link-btn" onClick={() => changePrint({ seed: print.seed + 1 })} title="Другой перекос">
                            ↺ другой
                          </button>
                        )}
                      </div>
                      <LookSlider label="Густота тонера" hint="Меньше — бледнее, как при экономии тонера" min={0.3} max={1.6} step={0.05} value={print.toner} onChange={(v) => changePrint({ toner: v })} />
                      <div className="desk-field">
                        <span>Принтер</span>
                        <Pill
                          value={wear.printer}
                          onChange={(printer) => void saveWear({ ...wear, printer })}
                          options={[
                            ['new', 'новый', 'Почти как в файле: чуть серый чёрный, мягкие края'],
                            ['usual', 'обычный', 'Офисный лазерный: полосы по ходу бумаги, неровная плотность, редкие точки тонера'],
                            ['tired', 'уставший', 'Изношенный барабан: заметные светлые полосы, бледный край, грязь, иногда повтор печати ниже'],
                          ] as [PrinterKind, ReactNode, string][]}
                        />
                        <button className="link-btn" onClick={() => void saveWear({ ...wear, printerSeed: wear.printerSeed + 1 })} title="Другие полосы, пятна и точки">
                          ↺ другой принтер
                        </button>
                      </div>
                    </Section>
                  )}
                  <Section
                    title="Ручка"
                    hint="Шариковая, гелевая или карандаш. Цвет можно взять с настоящей ручки: пипетка слева, затем щелчок по слову, написанному ею на этом листе."
                  >
                    <Pill value={look.pen} onChange={(pen) => changeLook({ pen })} options={PENS.map(([k, name]) => [k, name] as [PenKind, ReactNode])} />
                    {look.pen !== 'pencil' && calib && (
                      <div className="desk-calib">
                        <span className="desk-swatch" style={{ background: calibSwatch ?? undefined }} />
                        <span className="small">
                          Цвет настоящей ручки
                          {calib.mm > 0 && penMm > 0 && (
                            <Hint>
                              Штрих настоящей ручки {num(calib.mm, 2)} мм, у пера почерка {num(penMm, 2)} мм.
                            </Hint>
                          )}
                        </span>
                        <button className="link-btn" onClick={() => setCalib(null)}>
                          сбросить
                        </button>
                      </div>
                    )}
                    <LookSlider label="Густота чернил" hint="Толщина слоя: меньше — бледнее и прозрачнее" min={0.15} max={1} step={0.01} value={look.density} onChange={(v) => changeLook({ density: v })} />
                  </Section>
                  <details className="desk-more">
                    <summary>
                      Как на снимке
                      <Hint>Размытость, шум и фактура берутся с самого снимка; трогать их нужно редко.{measureNote ? ` По снимку: ${measureNote}.` : ''}</Hint>
                    </summary>
                    <LookSlider
                      label="Размытость, px"
                      hint="Как у самого снимка: 0 — идеально резко"
                      min={0}
                      max={3}
                      step={0.05}
                      value={blurValue}
                      onChange={(v) => setBlurGain(v / (shownDesk?.measure?.sigma ?? FALLBACK_BLUR))}
                    />
                    <LookSlider label="Шум, ×" hint="Зерно камеры под чернилами: 1 — как на самом снимке" min={0} max={3} step={0.05} value={look.grain} onChange={(v) => changeLook({ grain: v })} />
                    <LookSlider label="Фактура бумаги, ×" hint="Насколько волокна бумаги проступают в чернилах" min={0} max={2} step={0.05} value={look.texture} onChange={(v) => changeLook({ texture: v })} />
                    <button
                      className="link-btn"
                      onClick={() => {
                        setBlurGain(1);
                        changeLook({ grain: 1, texture: 1 });
                      }}
                    >
                      ↺ как на снимке
                    </button>
                  </details>
                </>
              )}
            </div>

            <footer className="desk-panel-foot">
              {step === 0 && desks.length > 0 && next(1, 'Дальше: лист')}
              {step === 1 && next(2, 'Дальше: помехи', !valid)}
              {step === 2 && next(3, 'Дальше: чернила', !allValid)}
              {step === 3 && (
                <>
                  <button className="btn primary wide" disabled={!inkReady || !!busy} onClick={() => void savePages([page])} title={fileName(page)}>
                    Сохранить JPG{pageCount > 1 ? ` (лист ${page + 1})` : ''}
                  </button>
                  {pageCount > 1 && (
                    <button className="btn wide" disabled={!inkReady || !!busy} onClick={() => void savePages(Array.from({ length: pageCount }, (_, i) => i))}>
                      Все листы ({pageCount})
                    </button>
                  )}
                </>
              )}
            </footer>
          </aside>
        )}

        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,.heic,.heif"
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void addFiles(files);
          }}
        />
      </div>
    </div>,
    document.body,
  );
}

/** The camera's turn by three sliders, degrees; the sheet is drawn again once a slider rests. */
function TiltSliders({ value, onChange }: { value: Angles; onChange: (a: Angles) => void }) {
  const [v, setV] = useState(value);
  const key = JSON.stringify(value);
  useEffect(() => setV(value), [key]);
  useEffect(() => {
    if (JSON.stringify(v) === key) return;
    const t = setTimeout(() => onChange(v), 250);
    return () => clearTimeout(t);
  }, [v]);
  const one = (k: keyof Angles, label: string, hint: string, max: number) => (
    <label className="slider" title={hint}>
      <span>
        {label} <output>{num(v[k])}°</output>
      </span>
      <input type="range" min={-max} max={max} step={0.5} value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />
    </label>
  );
  return (
    <>
      {one('pitch', 'Наклон вверх-вниз', 'Меньше нуля — верх листа дальше от камеры, больше — низ', 25)}
      {one('yaw', 'Наклон вбок', 'Больше нуля — левый край листа дальше от камеры, меньше — правый', 25)}
      {one('roll', 'Поворот', 'Телефон повёрнут вокруг объектива', 10)}
    </>
  );
}

function LookSlider(p: { label: string; hint: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="slider" title={p.hint}>
      <span>
        {p.label} <output>{p.value}</output>
      </span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
    </label>
  );
}
