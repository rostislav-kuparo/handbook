// «Мои столы»: whole exports onto photos, kept to write onto again.
import { db } from '../storage/db';
import type { ObjectMask } from './analysis';
import { fromOld, isOldDesk, type DeskPhotoRow, type OldDesk, type SavedDesk } from './deskFormat';
import { loadPhoto, type Photo } from './photo';

export type { DeskBend, DeskFormat, DeskPhotoRow, DeskSettings, PhotoFindings, SavedDesk, SavedLook, SavedPhoto, SheetChoice } from './deskFormat';

export async function jpeg(photo: Photo, width: number, quality: number): Promise<Blob> {
  const k = Math.min(1, width / photo.width);
  const canvas = new OffscreenCanvas(Math.round(photo.width * k), Math.round(photo.height * k));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo.bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

export const listDesks = () => db.desks.orderBy('updatedAt').reverse().toArray();

/**
 * Writes a desk: its markup and settings, the photos in `rows` (new ones, or
 * with a changed mask); its photos no longer in it are dropped.
 */
export async function writeDesk(desk: SavedDesk, rows: DeskPhotoRow[]): Promise<void> {
  await db.transaction('rw', db.desks, db.deskPhotos, async () => {
    const old = await db.desks.get(desk.id);
    await db.desks.put({ ...desk, createdAt: old?.createdAt ?? desk.createdAt });
    if (rows.length) await db.deskPhotos.bulkPut(rows);
    const kept = new Set(desk.photos.map((p) => p.id));
    await db.deskPhotos
      .where('deskId')
      .equals(desk.id)
      .filter((r) => !kept.has(r.id))
      .delete();
  });
}

export async function deleteDesk(id: string): Promise<void> {
  await db.transaction('rw', db.desks, db.deskPhotos, async () => {
    await db.desks.delete(id);
    await db.deskPhotos.where('deskId').equals(id).delete();
  });
}

/** The photos of a desk, in its order, with their pictures and masks (photos whose picture is lost are left out). */
export async function openDesk(desk: SavedDesk): Promise<{ id: string; photo: Photo; blob: Blob; mask: ObjectMask | null }[]> {
  const rows = new Map((await db.deskPhotos.where('deskId').equals(desk.id).toArray()).map((r) => [r.id, r]));
  const out = [];
  for (const p of desk.photos) {
    const row = rows.get(p.id);
    if (!row) continue;
    out.push({ id: p.id, photo: await loadPhoto(new File([row.photo], `${p.name}.jpg`, { type: 'image/jpeg' })), blob: row.photo, mask: row.mask });
  }
  return out;
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

type JsonMask = (Omit<ObjectMask, 'data'> & { data: string }) | null;
const maskToJson = (m: ObjectMask | null): JsonMask => m && { ...m, data: base64(m.data) };
const maskFromJson = (m: JsonMask): ObjectMask | null => m && { ...m, data: unbase64(m.data) };

/**
 * The saved desks as plain JSON, for the full backup: photos as data URLs,
 * each with its mask. What the analysis found is left out (found anew).
 */
export async function exportDesks(): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const d of await db.desks.toArray()) {
    const rows = new Map((await db.deskPhotos.where('deskId').equals(d.id).toArray()).map((r) => [r.id, r]));
    const photos = [];
    for (const { found: _, ...p } of d.photos) {
      const row = rows.get(p.id);
      if (row) photos.push({ ...p, photo: await toDataUrl(row.photo), mask: maskToJson(row.mask) });
    }
    out.push({ ...d, thumb: await toDataUrl(d.thumb), photos });
  }
  return out;
}

/** Adds desks from a backup (also one made before desks had several photos); ones with the same id are replaced. */
export async function importDesks(list: unknown[]): Promise<number> {
  const desks: SavedDesk[] = [];
  const rows: DeskPhotoRow[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || typeof (raw as { id?: unknown }).id !== 'string') continue;
    if (isOldDesk(raw)) {
      const d = raw as unknown as Omit<OldDesk, 'photo' | 'thumb' | 'mask'> & { photo: string; thumb: string; mask: JsonMask };
      const { desk, row } = fromOld({ ...d, photo: await fromDataUrl(d.photo), thumb: await fromDataUrl(d.thumb), mask: maskFromJson(d.mask) });
      desks.push(desk);
      rows.push(row);
      continue;
    }
    const d = raw as Omit<SavedDesk, 'thumb' | 'photos'> & { thumb: string; photos: (SavedDesk['photos'][number] & { photo: string; mask: JsonMask })[] };
    if (!Array.isArray(d.photos)) continue;
    const photos = [];
    for (const { photo, mask, ...p } of d.photos) {
      photos.push(p);
      rows.push({ id: p.id, deskId: d.id, photo: await fromDataUrl(photo), mask: maskFromJson(mask) });
    }
    desks.push({ ...d, thumb: await fromDataUrl(d.thumb), photos });
  }
  await db.transaction('rw', db.desks, db.deskPhotos, async () => {
    for (const d of desks) await db.deskPhotos.where('deskId').equals(d.id).delete();
    await db.desks.bulkPut(desks);
    await db.deskPhotos.bulkPut(rows);
  });
  return desks.length;
}
