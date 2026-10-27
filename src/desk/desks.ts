// «Мои столы»: photos of desks with their markup, kept to write onto again.
import type { PaperStyle, SheetKind } from '../editor/page';
import { db } from '../storage/db';
import type { Margins, ObjectMask } from './analysis';
import type { Pt } from './homography';
import { loadPhoto, type Photo } from './photo';
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

export interface SavedDesk {
  id: string;
  name: string;
  /** The working-size photo (JPEG). */
  photo: Blob;
  /** A small picture for the gallery (JPEG). */
  thumb: Blob;
  corners: Pt[];
  snapped: boolean[];
  /** A curved sheet (missing in desks saved before it existed). */
  bend?: DeskBend | null;
  kind: DeskFormat;
  /** The size of «свой» format, mm. */
  custom?: [number, number];
  /** The size read off the squares (missing in desks saved before it existed: on). */
  byGrid?: boolean;
  paper: PaperStyle;
  /** Margin lines moved by hand, mm; null or missing: as found. */
  margins?: Margins | null;
  /** Things on the sheet as found and brushed; null: found anew when opened. */
  mask: ObjectMask | null;
  /** Transmittance of the real pen taken from this photo. */
  calib: number[] | null;
  createdAt: number;
  updatedAt: number;
}

export type DeskMarkup = Pick<SavedDesk, 'name' | 'corners' | 'snapped' | 'bend' | 'kind' | 'custom' | 'byGrid' | 'paper' | 'margins' | 'mask' | 'calib'>;

async function jpeg(photo: Photo, width: number, quality: number): Promise<Blob> {
  const k = Math.min(1, width / photo.width);
  const canvas = new OffscreenCanvas(Math.round(photo.width * k), Math.round(photo.height * k));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo.bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

export const listDesks = () => db.desks.orderBy('updatedAt').reverse().toArray();

/** Saves a desk (a new one, or over the one with `id`); returns its id. */
export async function saveDesk(photo: Photo, markup: DeskMarkup, id?: string): Promise<string> {
  const now = Date.now();
  const old = id ? await db.desks.get(id) : undefined;
  const desk: SavedDesk = {
    id: old?.id ?? crypto.randomUUID(),
    photo: old?.photo ?? (await jpeg(photo, photo.width, 0.92)),
    thumb: old?.thumb ?? (await jpeg(photo, 320, 0.8)),
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
    ...markup,
  };
  await db.desks.put(desk);
  return desk.id;
}

export const deleteDesk = (id: string) => db.desks.delete(id);

export async function openDesk(saved: SavedDesk): Promise<Photo> {
  return loadPhoto(new File([saved.photo], `${saved.name}.jpg`, { type: 'image/jpeg' }));
}

const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const fromDataUrl = async (url: string) => (await fetch(url)).blob();

const base64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unbase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The saved desks as plain JSON, for the full backup (photos as data URLs). */
export async function exportDesks(): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const d of await db.desks.toArray()) {
    out.push({
      ...d,
      photo: await toDataUrl(d.photo),
      thumb: await toDataUrl(d.thumb),
      mask: d.mask && { ...d.mask, data: base64(d.mask.data) },
    });
  }
  return out;
}

/** Adds desks from a backup; ones with the same id are replaced. */
export async function importDesks(list: unknown[]): Promise<number> {
  const desks: SavedDesk[] = [];
  for (const raw of list) {
    const d = raw as Omit<SavedDesk, 'photo' | 'thumb' | 'mask'> & { photo: string; thumb: string; mask: (Omit<ObjectMask, 'data'> & { data: string }) | null };
    if (!d?.id || typeof d.photo !== 'string') continue;
    desks.push({
      ...d,
      photo: await fromDataUrl(d.photo),
      thumb: await fromDataUrl(d.thumb),
      mask: d.mask && { ...d.mask, data: unbase64(d.mask.data) },
    });
  }
  await db.desks.bulkPut(desks);
  return desks.length;
}
