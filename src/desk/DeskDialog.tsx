import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PageExport } from '../editor/exporters';
import { MM, SHEET_KINDS, type PageSetup, type PaperStyle, type SheetKind } from '../editor/page';
import { LINE_HEIGHT_EM } from '../editor/layout';
import { getHandwriting } from '../engine/handwriting';
import { getSetting, setSetting } from '../storage/db';
import { safeFilename, saveFile } from '../util/download';
import { useLive } from '../util/useLive';
import { Analyzer, NO_MARGINS, type Margins, type Measure, type ObjectMask, type Ruling, type Specular } from './analysis';
import { CornerEditor } from './CornerEditor';
import { DEFAULT_PHOTO_LOOK, DeskRenderer, type InkLook, type PenKind, type PhotoLook } from './compose';
import { deleteDesk, listDesks, openDesk, saveDesk, type DeskBend, type DeskFormat, type SavedDesk } from './desks';
import { isConvexClockwise, type Pt } from './homography';
import {
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
  type FitMode,
  type InkLayout,
} from './inkLayer';
import { MaskEditor, type Brush, type MaskTool } from './MaskEditor';
import { loadPhoto, WORK_SIDE, type Photo } from './photo';
import { GRID_NX, GRID_NY, zeroGrid, type Warp } from './warp';

const LOOK_KEY = 'desk.ink';
const SHEET_KEY = 'desk.sheet';
/** What of the look is remembered between photos. */
type SavedLook = Pick<InkLook, 'pen' | 'density' | 'grain' | 'texture'>;
const DEFAULT_LOOK: SavedLook = { pen: 'ballpoint', density: 0.35, grain: 1, texture: 1 };
/** Blur when a photo's edges tell nothing. */
const FALLBACK_BLUR = 0.7;

interface SheetChoice {
  kind: DeskFormat;
  /** The size of «свой» format, mm. */
  custom: [number, number];
  /** On squared paper the size is read off the squares (5 mm each), whatever the format. */
  byGrid: boolean;
  paper: PaperStyle;
  mode: FitMode;
  /** Printed lines per line of text and the letters' size; null: as fits best. */
  every: number | null;
  letters: number | null;
  /** On squares, drawings by them. */
  squares: boolean;
}
const DEFAULT_SHEET: SheetChoice = { kind: 'a4', custom: [210, 297], byGrid: true, paper: 'plain', mode: 'document', every: null, letters: null, squares: true };
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
  /** Where it is kept in «Мои столы». */
  savedId: string | null;
  /** The paper's size read off its squares, mm, and the shape and format it was read for. */
  gridSize: [number, number] | null;
  gridKey: string | null;
  /** Margin lines moved by hand, mm; null — as found. */
  margins: Margins | null;
  /** Results and the corners (and paper) they belong to. */
  ruling: Ruling | null;
  rulingKey: string | null;
  mask: ObjectMask | null;
  maskKey: string | null;
  measure: Measure | null;
  glare: Specular | null;
  measureKey: string | null;
}

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

/** The marked top edge looks like a long side while the sheet is upright: the top is probably set wrong. */
function topLooksSideways(c: Pt[], [w, h]: [number, number]): boolean {
  const across = (dist(c[0], c[1]) + dist(c[3], c[2])) / 2;
  const along = (dist(c[1], c[2]) + dist(c[0], c[3])) / 2;
  return across / along > (w / h) * 1.3;
}

const num = (v: number, digits = 1) => v.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const keyOf = (d: Desk) => JSON.stringify(d.corners);
/** The sheet's shape: corners and, when curved, its bow and grid. */
const shapeOf = (corners: Pt[], bend: DeskBend | null) => JSON.stringify([corners, bend?.bulge ?? null, bend?.grid ?? null]);
const warpOf = (d: Pick<Desk, 'corners' | 'bend'>): Warp => ({ corners: d.corners, bulge: d.bend?.bulge ?? null, grid: d.bend?.grid ?? null });
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
function paperOf(d: Pick<Desk, 'corners' | 'bend' | 'gridSize' | 'gridKey'>, sheet: SheetChoice): [number, number] {
  const fmt = formatMm(sheet);
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

/** A small picture of a photo for the list. */
function Thumb({ photo }: { photo: Photo }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const k = 96 / Math.max(photo.width, photo.height);
    c.width = Math.round(photo.width * k);
    c.height = Math.round(photo.height * k);
    c.getContext('2d')!.drawImage(photo.bitmap, 0, 0, c.width, c.height);
  }, [photo]);
  return <canvas ref={ref} className="desk-thumb" />;
}

function SavedThumb({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <img src={url} className="desk-thumb" alt="" /> : <span className="desk-thumb" />;
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
  const [base] = useState(props.base);
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
  /** Which photo each sheet of the document goes onto: all onto the selected one, or each its own. */
  const [assign, setAssign] = useState<'one' | 'each'>('one');
  const [pageDesk, setPageDesk] = useState<Record<number, string>>({});
  const [page, setPage] = useState(0);
  const [layout, setLayout] = useState<InkLayout | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** What the search for the sheet said, per photo. */
  const [foundNote, setFoundNote] = useState<Record<string, string>>({});
  const [actual, setActual] = useState(false);
  const [drop, setDrop] = useState(false);
  const [picking, setPicking] = useState(false);
  const [brush, setBrush] = useState<Brush>('erase');
  const [tool, setTool] = useState<MaskTool>('brush');
  const [brushRadius, setBrushRadius] = useState(40);
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
  const valid = !!cur && isConvexClockwise(cur.corners);
  const allValid = desks.length > 0 && desks.every((d) => isConvexClockwise(d.corners));
  const paperFor = (d: Desk) => paperOf(d, sheet);
  const hasRuling = (d: Desk) => d.rulingKey === rulingKeyOf(d, paperFor(d));
  /** The margin lines of a desk: moved by hand, or as found. */
  const marginsOf = (d: Desk): Margins => d.margins ?? (hasRuling(d) ? d.ruling?.margins : null) ?? NO_MARGINS;

  useEffect(() => {
    void getSetting<Partial<SavedLook>>(LOOK_KEY, {}).then((l) => setLook((c) => ({ ...c, ...l })));
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
  useEffect(() => () => desksRef.current.forEach((d) => d.photo.bitmap.close()), []);

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
  const patch = (id: string, p: Partial<Desk>) => setDesks((ds) => ds.map((d) => (d.id === id ? { ...d, ...p } : d)));

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (picking) setPicking(false);
      else onClose();
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, picking]);

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
    return { corners: c.corners, snapped: c.fitted, bend: { bulge: c.bulge, grid: zeroGrid(), fixed: false, max: c.max } };
  };

  /** Looks for the sheet and puts the corners on it (unless the user already moved them). */
  const findSheet = async (d: Desk, force: boolean) => {
    const say = (text: string) => setFoundNote((n) => ({ ...n, [d.id]: text }));
    try {
      const found = await (await analysisOf(d)).findSheet();
      const now = desksRef.current.find((x) => x.id === d.id);
      if (!now || (!force && now.touched)) return;
      if (found?.scan) {
        patch(d.id, { corners: found.corners, snapped: found.snapped, bend: null });
        say('Это скан: лист занимает весь кадр — без перспективы и изгиба.');
      } else if (found && found.confidence >= 0.6) {
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
    savedId: null,
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
  });

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

  const openSaved = async (s: SavedDesk) => {
    setBusy('Открываю стол…');
    try {
      const photo = await openDesk(s);
      const d: Desk = {
        ...fresh(photo, s.name),
        corners: s.corners,
        snapped: s.snapped,
        bend: s.bend ?? null,
        touched: true,
        savedId: s.id,
        margins: s.margins ?? null,
        mask: s.mask,
        maskKey: s.mask ? JSON.stringify(s.corners) : null,
      };
      setDesks((ds) => [...ds, d]);
      if (desksRef.current.length > 0) setAssign('each');
      changeSheet({ kind: s.kind, paper: s.paper, byGrid: s.byGrid ?? true, ...(s.custom ? { custom: s.custom } : {}) });
      if (s.calib && !calib) setCalib({ t: s.calib, mm: 0 });
      setCurId(d.id);
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

  const keep = async (d: Desk) => {
    setBusy('Сохраняю в «Мои столы»…');
    try {
      const id = await saveDesk(
        d.photo,
        {
          name: d.name,
          corners: d.corners,
          snapped: d.snapped,
          bend: d.bend,
          kind: sheet.kind,
          custom: sheet.custom,
          byGrid: sheet.byGrid,
          paper: sheet.paper,
          margins: d.margins,
          mask: d.mask,
          calib: calib?.t ?? null,
        },
        d.savedId ?? undefined,
      );
      patch(d.id, { savedId: id });
      setNote(d.savedId ? 'Стол обновлён в «Мои столы».' : 'Стол сохранён в «Мои столы»: его можно открыть снова на шаге «Фото».');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
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
    const size = paperOf({ ...d, ...p }, sheet);
    const [wMm, hMm] = size;
    if (need.ruling && d.rulingKey !== rulingKeyOf(d, size)) {
      let r = await a.ruling(warpOf(d), wMm, hMm);
      let bend = d.bend;
      if (r && bend && !bend.fixed) {
        // Straighten the curved sheet by its own printed lines, then read them again.
        const fit = await a.bend(warpOf(d), wMm, hMm, r, GRID_NX, GRID_NY);
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

  const pageCount = layout?.pages.length ?? 1;
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
        await prepare(d.id, { ruling: sheet.paper !== 'plain', mask: true, measure: true }).catch((err) => alive && setError(String(err)));
      }
      if (alive) setPreparing(null);
    })();
    return () => {
      alive = false;
      setPreparing(null);
    };
  }, [step, usedKey, sizeKey(formatMm(sheet)), sheet.byGrid, sheet.paper]);

  // The lines the text is laid onto: those found on the first photo that has them, within its
  // margins, on its paper; the other photos' sheets follow their own lines.
  const refDesk = sheet.paper !== 'plain' ? (desks.find((d) => d.ruling && hasRuling(d)) ?? null) : null;
  const refLines = refDesk?.ruling ? linesOf(refDesk.ruling, marginsOf(refDesk)) : null;
  const refKey = JSON.stringify(refLines);
  const paperMm = refDesk ? paperFor(refDesk) : cur ? paperFor(cur) : formatMm(sheet);
  // Without printed lines to lay the text on, the margins drawn by hand on the photo still hold.
  const looseMargins = !refLines && cur ? marginsPx(marginsOf(cur)) : null;
  const looseKey = JSON.stringify(looseMargins);
  const paperKey = sizeKey(paperMm);
  useEffect(() => {
    let alive = true;
    setLayout(null);
    void inkLayout(base, setup, paperMm, sheet.mode, refLines, { every: sheet.every, letters: sheet.letters, squares: sheet.squares }, looseMargins)
      .then((l) => {
        if (!alive) return;
        setLayout(l);
        setPage((p) => Math.min(p, l.pages.length - 1));
      })
      .catch((err) => alive && setError(String(err)));
    return () => {
      alive = false;
    };
  }, [base, setup, paperKey, sheet.mode, sheet.every, sheet.letters, sheet.squares, refKey, looseKey]);

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
  const linesFor = (d: Desk) => (sheet.paper !== 'plain' && d.ruling && hasRuling(d) ? linesOf(d.ruling, marginsOf(d)) : null);
  /** Where the page goes on a desk's sheet: by its own lines on its own paper. */
  const onDesk = (d: Desk, l: InkLayout) => placeOn(l, linesFor(d), paperSize(paperFor(d)));

  /**
   * Puts sheet `p` of the document onto desk `d` on the GPU. A draw that is no
   * longer wanted (`wanted` false once its picture is ready) changes nothing:
   * a late one must not replace the newer ink.
   */
  const draw = async (d: Desk, p: number, wanted: () => boolean = () => true) => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) throw new Error('нечего рисовать');
    if (!renderer.current) {
      renderer.current = new DeskRenderer(canvas);
      shown.current = null;
    }
    const r = renderer.current;
    const on = onDesk(d, layout);
    const scale = rasterScale(layout, d.corners, Math.min(r.maxTexture, 8192), on);
    const raster = await rasterize(layout.pages[p] ?? '', layout.size, scale);
    if (!wanted() || renderer.current !== r) return null;
    if (shown.current !== d.id) {
      r.setPhoto(d.photo);
      shown.current = d.id;
    }
    r.setMask(d.mask);
    r.setInk(raster, rasterizePen(layout.strokes[p] ?? [], layout.size, scale), placement(layout, warpOf(d), on));
    return r;
  };

  const shownDesk = deskFor(page);
  const shownKey = shownDesk ? `${shownDesk.id}${shapeOf(shownDesk.corners, shownDesk.bend)}${shownDesk.rulingKey}${JSON.stringify(shownDesk.margins)}${shownDesk.maskKey}` : '';
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
  }, [step, layout, page, shownKey, glEpoch, refKey]);

  // A brushed mask goes straight to the GPU.
  useEffect(() => {
    if (step === 3 && shownDesk && shown.current === shownDesk.id) renderer.current?.setMask(shownDesk.mask);
  }, [shownDesk?.mask]);

  useEffect(() => {
    if (step === 3 && inkReady && shownDesk) renderer.current?.render(lookFor(shownDesk), photoLookOf(shownDesk, calib?.t ?? null), base.ink);
  });

  /** Takes the real pen's colour from words written on the sheet (a click on them). */
  const pickPen = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    const d = shownDesk;
    if (!picking || !d || !layout) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // The canvas shows the photo «contained» in its box.
    const k = Math.min(rect.width / d.photo.width, rect.height / d.photo.height);
    const x = (e.clientX - rect.left - (rect.width - d.photo.width * k) / 2) / k;
    const y = (e.clientY - rect.top - (rect.height - d.photo.height * k) / 2) / k;
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

  const savePages = async (pages: number[]) => {
    setError(null);
    try {
      for (const [i, p] of pages.entries()) {
        const d0 = deskFor(p);
        if (!d0) continue;
        setBusy(pages.length > 1 ? `Сохраняю лист ${i + 1} из ${pages.length}…` : 'Сохраняю…');
        const d = (await prepare(d0.id, { ruling: sheet.paper !== 'plain', mask: true, measure: true })) ?? d0;
        const r = await draw(d, p);
        if (!r) continue;
        r.render({ ...lookFor(d), split: 0 }, photoLookOf(d, calib?.t ?? null), base.ink);
        await saveFile(await r.jpeg(0.92), fileName(p));
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
        ? `Строки и листы — как в документе: ${lineNote}, буквы ×${num(pageScale(layout), 2)} от редактора. Листов: ${layout.pages.length}.${
            sheet.every !== null && Math.round(layout.ref.pitch / layout.ref.lines.step) < sheet.every ? ' Шире строка не помещается: лист документа длиннее листа тетради.' : ''
          }`
        : looseMargins && Object.values(looseMargins).some((v) => v !== null)
          ? 'Строки и листы — как в документе, лист вписан между полями.'
          : !isA4(paperMm)
            ? 'Лист A4 уменьшен целиком: буквы мельче, чем в документе.'
            : null
      : `Текст заново разбит на листы ${paperName}${lineNote ? ` по линовке, ${lineNote}` : ''}: ${layout.pages.length}.`;

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

  const deskTabs = desks.length > 1 && (
    <div className="desk-tabs">
      {desks.map((d, i) => (
        <button key={d.id} className={d.id === cur?.id ? 'on' : ''} onClick={() => setCurId(d.id)} title={d.name}>
          {i + 1}. {d.name}
        </button>
      ))}
    </div>
  );

  const keepButton = cur && (
    <button className="btn wide" disabled={!!busy || !valid} onClick={() => void keep(cur)} title="Фото и разметку можно будет открыть снова">
      {cur.savedId ? 'Обновить в «Мои столы»' : 'Сохранить в «Мои столы»'}
    </button>
  );

  const rulingInfo = (() => {
    if (!cur || !hasRuling(cur)) return null;
    const r = cur.ruling;
    if (!r) {
      return sheet.paper === 'plain' ? (
        <p className="muted small">Линовки на листе нет.</p>
      ) : (
        <p className="desk-hint">Линии не нашлись: текст ляжет как на чистом листе.</p>
      );
    }
    const what = r.kind === 'grid' ? `Клетка ${num(r.colStep ?? r.step)} × ${num(r.step)} мм` : `Линейка через ${num(r.step)} мм`;
    const lean = Math.abs(r.slope) > 0.001 ? `, наклон к краю ${num((Math.atan(r.slope) * 180) / Math.PI, 2)}°` : '';
    const hint = formatHint(r, paperFor(cur), sheet.byGrid);
    const bySquares = sheet.byGrid && cur.gridSize;
    return (
      <>
        <p className="small">
          {what}
          {lean}.{bySquares ? ` Лист по клеткам: ${num(cur.gridSize![0])} × ${num(cur.gridSize![1])} мм.` : ''}
        </p>
        {hint && <p className="desk-hint">{hint}</p>}
        {cur.bend?.lines && (
          <p className="muted small">
            Изгиб уточнён по линовке: строки отклонялись от прямой на {num(cur.bend.lines.before, 2)} мм, теперь на {num(cur.bend.lines.after, 2)} мм.
          </p>
        )}
        {sheet.paper === 'plain' && (
          <p className="desk-hint">
            На листе {r.kind === 'grid' ? 'клетка' : 'линейка'}: подогнать текст под неё?{' '}
            <button className="link-btn" onClick={() => changeSheet({ paper: r.kind })}>
              Да, {r.kind === 'grid' ? 'в клетку' : 'в линейку'}
            </button>
          </p>
        )}
      </>
    );
  })();

  return createPortal(
    <div className="desk-backdrop">
      <div className="desk-dialog" role="dialog" aria-modal="true" aria-label="Текст на фото листа">
        <header className="desk-top">
          <h2>На столе (фото)</h2>
          <ol className="desk-steps">
            {STEPS.map((name, i) => (
              <li key={name}>
                <button className={i === step ? 'on' : ''} disabled={i > 0 && (!cur || (i >= 2 && !valid) || (i === 3 && !allValid))} onClick={() => setStep(i)}>
                  <span className="desk-step-n">{i + 1}</span> {name}
                </button>
              </li>
            ))}
          </ol>
          <button className="sketch-help-close" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </header>

        <div className="desk-body">
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
                <p className="desk-drop-title">Перетащите сюда фото листов на столе</p>
                <button className="btn primary" onClick={() => fileRef.current?.click()}>
                  {desks.length ? 'Добавить фото…' : 'Выбрать фото…'}
                </button>
                <p className="muted small">
                  Пустые листы, снятые сверху при ровном свете: одно фото на все листы документа или по фото на лист. JPG, PNG или WebP; большие фото
                  уменьшаются до {WORK_SIDE} px по длинной стороне.
                </p>
                {saved.length > 0 && (
                  <div className="desk-gallery">
                    <h3>Мои столы</h3>
                    <ul>
                      {saved.map((s) => (
                        <li key={s.id}>
                          <button className="desk-card" onClick={() => void openSaved(s)} title="Открыть этот стол">
                            <SavedThumb blob={s.thumb} />
                            <span>{s.name}</span>
                            <span className="muted small">{new Date(s.updatedAt).toLocaleDateString('ru-RU')}</span>
                          </button>
                          <button
                            className="doc-delete"
                            aria-label="Удалить стол"
                            title="Удалить из «Мои столы»"
                            onClick={() => confirm(`Удалить «${s.name}» из «Мои столы»?`) && void deleteDesk(s.id)}
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
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
              />
            )}
            <div className={`desk-result ${actual ? 'actual' : ''} ${picking ? 'picking' : ''}`} hidden={step !== 3}>
              <canvas
                ref={canvasRef}
                onClick={(e) => void pickPen(e)}
                style={
                  actual && shownDesk
                    ? { width: shownDesk.photo.width / (window.devicePixelRatio || 1), height: shownDesk.photo.height / (window.devicePixelRatio || 1) }
                    : undefined
                }
              />
            </div>
            {(busy || preparing || (step === 3 && !layout)) && <div className="desk-busy">{busy ?? preparing ?? 'Раскладываю текст по листу…'}</div>}
          </main>

          <aside className="desk-side">
            {error && (
              <p className="desk-error" role="alert">
                {error}
              </p>
            )}

            {step === 0 && (
              <>
                <p className="muted small">
                  Программа напишет текст документа на этих листах: с перспективой, под тем же светом и с теми же тенями, что на снимках.
                </p>
                {desks.length > 0 && (
                  <>
                    <h3>Фото в этом экспорте</h3>
                    <ul className="desk-list">
                      {desks.map((d, i) => (
                        <li key={d.id}>
                          <button
                            className="desk-card"
                            onClick={() => {
                              setCurId(d.id);
                              setStep(1);
                            }}
                          >
                            <Thumb photo={d.photo} />
                            <span>
                              {i + 1}. {d.name}
                            </span>
                          </button>
                          <button className="doc-delete" aria-label="Убрать фото" title="Убрать из экспорта" onClick={() => removeDesk(d)}>
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                    <button className="btn primary wide desk-next" onClick={() => setStep(1)}>
                      Дальше: лист →
                    </button>
                  </>
                )}
              </>
            )}

            {step === 1 && cur && (
              <>
                {deskTabs}
                {foundNote[cur.id] && <p className="desk-hint">{foundNote[cur.id]}</p>}
                {note && <p className="desk-hint">{note}</p>}
                <p className="muted small">
                  Перетащите уголки на уголки листа: отпущенный уголок прилипает к краям (сплошная линия — край найден, пунктир — нет). С Alt — без
                  прилипания, с Shift — точнее, стрелками — на ¼ пикселя (Tab — следующий уголок).
                </p>
                <div className="desk-row">
                  <button
                    className="btn"
                    onClick={() => {
                      const c = cur.corners;
                      const s = cur.snapped;
                      const b = cur.bend;
                      // The bend turns with the sheet: sides move round, the grid is fitted anew.
                      patch(cur.id, {
                        corners: [c[1], c[2], c[3], c[0]],
                        snapped: [s[1], s[2], s[3], s[0]],
                        bend: b && { ...b, bulge: [b.bulge[1], b.bulge[2], b.bulge[3], b.bulge[0]], grid: zeroGrid(), fixed: false, lines: undefined },
                      });
                    }}
                  >
                    ↻ верх листа
                  </button>
                  <button
                    className="btn"
                    disabled={!!busy}
                    onClick={() => {
                      setBusy('Ищу лист на фото…');
                      void findSheet(cur, true).finally(() => setBusy(null));
                    }}
                    title="Найти лист на фото заново"
                  >
                    Найти лист
                  </button>
                  <button
                    className="btn"
                    onClick={() => patch(cur.id, { corners: frameOf(cur.photo), snapped: NONE, bend: null, touched: true })}
                    title="Лист занимает весь снимок, снят ровно: без перспективы и изгиба"
                  >
                    Скан
                  </button>
                </div>
                <label className="check" title="Лист не лежит ровно: края дугой, страница у корешка тетради">
                  <input
                    type="checkbox"
                    checked={!!cur.bend}
                    disabled={!!busy}
                    onChange={(e) => {
                      if (!e.target.checked) {
                        patch(cur.id, { bend: null });
                        return;
                      }
                      setBusy('Ищу изогнутые края…');
                      void curve(cur, cur.corners, true)
                        .then((c) => c && patch(cur.id, { ...c, touched: true }))
                        .catch((err) => setError(String(err)))
                        .finally(() => setBusy(null));
                    }}
                  />
                  Изогнутый лист
                </label>
                {cur.bend && (
                  <p className="muted small">
                    Края выгнуты до {num(cur.bend.max)} px. Квадратные точки сетки можно тянуть там, где текст должен лечь иначе
                    {sheet.paper !== 'plain' ? ' — на линованном листе сетка сама подстроится под линии на шаге «Помехи»' : ''}.
                  </p>
                )}
                {!valid && <p className="desk-error">Уголки перекрутились: расставьте их по кругу, по часовой стрелке от верхнего левого.</p>}
                {valid && topLooksSideways(cur.corners, paperFor(cur)) && <p className="desk-hint">Похоже, верх листа отмечен сбоку. Нажмите «↻ верх листа».</p>}
                <h3>Лист</h3>
                <div className="segmented">
                  {(Object.keys(SHEET_KINDS) as SheetKind[]).map((k) => (
                    <button key={k} className={sheet.kind === k ? 'on' : ''} onClick={() => changeSheet({ kind: k })}>
                      {SHEET_KINDS[k].name}
                      <span className="desk-mm">
                        {SHEET_KINDS[k].mm[0]}×{SHEET_KINDS[k].mm[1]}
                      </span>
                    </button>
                  ))}
                  <button className={sheet.kind === 'custom' ? 'on' : ''} onClick={() => changeSheet({ kind: 'custom' })}>
                    Свой
                    <span className="desk-mm">
                      {num(sheet.custom[0], 0)}×{num(sheet.custom[1], 0)}
                    </span>
                  </button>
                </div>
                {sheet.kind === 'custom' && (
                  <div className="desk-row desk-size">
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
                <label className="check" title="Клетка — 5 мм: по ней видно, какого размера лист на самом деле">
                  <input type="checkbox" checked={sheet.byGrid} onChange={(e) => changeSheet({ byGrid: e.target.checked })} />
                  Размер листа в клетку — по клеткам
                </label>
                <div className="segmented">
                  {PAPER_NAMES.map(([k, name]) => (
                    <button key={k} className={sheet.paper === k ? 'on' : ''} onClick={() => changeSheet({ paper: k })}>
                      {name}
                    </button>
                  ))}
                </div>
                {keepButton}
                <button className="btn primary wide desk-next" disabled={!valid} onClick={() => setStep(2)}>
                  Дальше: помехи →
                </button>
              </>
            )}

            {step === 2 && cur && (
              <>
                {deskTabs}
                {foundNote[cur.id] && <p className="desk-hint">{foundNote[cur.id]}</p>}
                {note && <p className="desk-hint">{note}</p>}
                <h3>Линовка</h3>
                {rulingInfo ?? <p className="muted small">Ищу…</p>}
                <div className="segmented">
                  <button className={tool === 'brush' ? 'on' : ''} onClick={() => setTool('brush')}>
                    кисть
                  </button>
                  <button className={tool === 'margins' ? 'on' : ''} onClick={() => setTool('margins')}>
                    поля
                  </button>
                </div>
                <h3>Поля</h3>
                <p className="muted small">
                  Текст пишется между розовыми линиями полей. В режиме «поля» их можно перетащить — они прилипают к линиям клетки.
                </p>
                <ul className="desk-margins">
                  {SIDES.map(([side, name]) => {
                    const m = marginsOf(cur);
                    const v = m[side];
                    const [pw, ph] = paperFor(cur);
                    const fallback = { left: 20, right: pw - 10, top: 10, bottom: ph - 10 }[side];
                    return (
                      <li key={side}>
                        <span>{name}</span>
                        {v !== null ? (
                          <>
                            <output>{num(v)} мм</output>
                            <button className="link-btn" onClick={() => patch(cur.id, { margins: { ...m, [side]: null } })}>
                              убрать
                            </button>
                          </>
                        ) : (
                          <button
                            className="link-btn"
                            onClick={() => {
                              patch(cur.id, { margins: { ...m, [side]: fallback } });
                              setTool('margins');
                            }}
                          >
                            добавить
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {cur.margins && (
                  <button className="link-btn" onClick={() => patch(cur.id, { margins: null })}>
                    ↺ Как найдено
                  </button>
                )}
                <h3>Предметы на листе</h3>
                <p className="muted small">
                  Красным — где текст не пишется: ручка, пальцы, всё, что не похоже на бумагу. Кистью можно добавить или вернуть бумагу.
                  {cur.maskKey === keyOf(cur) && cur.mask ? ` Найдено: ${cur.mask.objects}.` : ''}
                </p>
                <div className="segmented">
                  <button
                    className={tool === 'brush' && brush === 'erase' ? 'on' : ''}
                    onClick={() => {
                      setBrush('erase');
                      setTool('brush');
                    }}
                  >
                    стереть
                  </button>
                  <button
                    className={tool === 'brush' && brush === 'restore' ? 'on' : ''}
                    onClick={() => {
                      setBrush('restore');
                      setTool('brush');
                    }}
                  >
                    вернуть
                  </button>
                </div>
                <label className="slider">
                  <span>
                    Кисть, px <output>{brushRadius}</output>
                  </span>
                  <input type="range" min={6} max={200} step={2} value={brushRadius} onChange={(e) => setBrushRadius(Number(e.target.value))} />
                </label>
                <div className="desk-row">
                  <button className="btn" onClick={() => patch(cur.id, { maskKey: null })} title="Найти предметы заново (кисть забудется)">
                    Найти заново
                  </button>
                  <button
                    className="btn"
                    disabled={!cur.mask}
                    onClick={() => cur.mask && patch(cur.id, { mask: { ...cur.mask, objects: 0, data: new Uint8Array(cur.mask.data.length).fill(255) } })}
                  >
                    Очистить
                  </button>
                </div>
                {keepButton}
                <button className="btn primary wide desk-next" disabled={!allValid} onClick={() => setStep(3)}>
                  Дальше: чернила →
                </button>
              </>
            )}

            {step === 3 && (
              <>
                {pageCount > 1 && (
                  <label className="slider">
                    <span>Лист документа</span>
                    <select value={page} onChange={(e) => setPage(Number(e.target.value))}>
                      {Array.from({ length: pageCount }, (_, i) => (
                        <option key={i} value={i}>
                          {i + 1} из {pageCount}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {desks.length > 1 && (
                  <>
                    <div className="segmented">
                      <button className={assign === 'one' ? 'on' : ''} onClick={() => setAssign('one')}>
                        одно фото на все
                      </button>
                      <button className={assign === 'each' ? 'on' : ''} onClick={() => setAssign('each')}>
                        своё для листа
                      </button>
                    </div>
                    <label className="slider">
                      <span>Фото для листа {page + 1}</span>
                      <select
                        value={shownDesk?.id ?? ''}
                        onChange={(e) => (assign === 'one' ? setCurId(e.target.value) : setPageDesk({ ...pageDesk, [page]: e.target.value }))}
                      >
                        {desks.map((d, i) => (
                          <option key={d.id} value={d.id}>
                            {i + 1}. {d.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                {(!isA4(paperMm) || sheet.paper !== 'plain') && (
                  <>
                    <h3>Текст</h3>
                    <div className="segmented">
                      <button
                        className={sheet.mode === 'document' ? 'on' : ''}
                        onClick={() => changeSheet({ mode: 'document' })}
                        title="Те же строки и те же листы, что в редакторе"
                      >
                        как в документе
                      </button>
                      <button
                        className={sheet.mode === 'fit' ? 'on' : ''}
                        onClick={() => changeSheet({ mode: 'fit' })}
                        title="Текст заново разбит по листу: на него войдёт больше"
                      >
                        заполнить лист
                      </button>
                    </div>
                  </>
                )}
                {layout?.ref && (
                  <>
                    <p className="small">Строка через, {layout.ref.lines.kind === 'grid' ? 'клеток' : 'линеек'}</p>
                    <div className="segmented">
                      {[null, 1, 2, 3].map((n) => (
                        <button key={n ?? 'auto'} className={sheet.every === n ? 'on' : ''} onClick={() => changeSheet({ every: n })}>
                          {n ?? 'авто'}
                        </button>
                      ))}
                    </div>
                    <label className="slider" title="Высота строки букв в доле строки тетради: меньше — мельче буквы">
                      <span>
                        Размер букв, % строки <output>{Math.round(100 * (sheet.letters ?? lettersNow ?? 1))}</output>
                        {sheet.letters !== null && (
                          <button className="link-btn" onClick={() => changeSheet({ letters: null })}>
                            {' '}
                            ↺ авто
                          </button>
                        )}
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
                {reflowNote && <p className="muted small">{reflowNote}</p>}
                <h3>Ручка</h3>
                <div className="segmented">
                  {PENS.map(([k, name]) => (
                    <button key={k} className={look.pen === k ? 'on' : ''} onClick={() => changeLook({ pen: k })}>
                      {name}
                    </button>
                  ))}
                </div>
                {look.pen !== 'pencil' &&
                  (calib ? (
                    <div className="desk-calib">
                      <span className="desk-swatch" style={{ background: calibSwatch ?? undefined }} />
                      <span className="small">
                        Цвет взят с настоящей ручки
                        {calib.mm > 0 && penMm > 0 && (
                          <span className="muted">
                            {' '}
                            · штрих {num(calib.mm, 2)} мм, у пера почерка {num(penMm, 2)} мм
                          </span>
                        )}
                      </span>
                      <button className="link-btn" onClick={() => setCalib(null)}>
                        Сбросить
                      </button>
                    </div>
                  ) : (
                    <button className={`btn wide ${picking ? 'on' : ''}`} onClick={() => setPicking(!picking)} title="Если на листе есть слова, написанные той же ручкой">
                      {picking ? 'Щёлкните по слову на фото…' : 'Взять цвет с настоящей ручки'}
                    </button>
                  ))}
                <LookSlider label="Густота чернил" hint="толщина слоя: меньше — бледнее и прозрачнее" min={0.15} max={1} step={0.01} value={look.density} onChange={(v) => changeLook({ density: v })} />
                <LookSlider
                  label="Размытость, px"
                  hint="как у самого снимка: 0 — идеально резко"
                  min={0}
                  max={3}
                  step={0.05}
                  value={blurValue}
                  onChange={(v) => setBlurGain(v / (shownDesk?.measure?.sigma ?? FALLBACK_BLUR))}
                />
                <LookSlider label="Шум, ×" hint="зерно камеры под чернилами: 1 — как на самом снимке" min={0} max={3} step={0.05} value={look.grain} onChange={(v) => changeLook({ grain: v })} />
                <LookSlider label="Фактура бумаги, ×" hint="насколько волокна бумаги проступают в чернилах" min={0} max={2} step={0.05} value={look.texture} onChange={(v) => changeLook({ texture: v })} />
                <LookSlider label="До / после" hint="слева — исходное фото" min={0} max={1} step={0.01} value={split} onChange={setSplit} />
                {measureNote && (
                  <p className="muted small">
                    По снимку: {measureNote}.{' '}
                    <button
                      className="link-btn"
                      onClick={() => {
                        setBlurGain(1);
                        changeLook({ grain: 1, texture: 1 });
                      }}
                    >
                      ↺ Как на снимке
                    </button>
                  </p>
                )}
                <label className="check">
                  <input type="checkbox" checked={actual} onChange={(e) => setActual(e.target.checked)} />
                  Масштаб 1:1
                </label>
                <button className="btn primary wide desk-next" disabled={!inkReady || !!busy} onClick={() => void savePages([page])}>
                  Сохранить JPG{pageCount > 1 ? ` (лист ${page + 1})` : ''}
                </button>
                {pageCount > 1 && (
                  <button className="btn wide" disabled={!inkReady || !!busy} onClick={() => void savePages(Array.from({ length: pageCount }, (_, i) => i))}>
                    Сохранить все листы ({pageCount})
                  </button>
                )}
                <p className="muted small">{fileName(page)}</p>
              </>
            )}
          </aside>
        </div>

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
