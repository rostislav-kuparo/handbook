// Local-first storage in IndexedDB. Nothing leaves the machine.
import Dexie, { type EntityTable } from 'dexie';
import type { Blank } from '../blank/blank';
import { fromOld, isOldDesk, type DeskPhotoRow, type SavedDesk } from '../desk/deskFormat';
import type { PageSetup } from '../editor/page';
import { DEFAULT_STYLE, DocContent, HandDocument, Sample, Style, uid } from '../model/types';

interface SettingRow {
  key: string;
  value: unknown;
}

class HandbookDB extends Dexie {
  samples!: EntityTable<Sample, 'id'>;
  documents!: EntityTable<HandDocument, 'id'>;
  settings!: EntityTable<SettingRow, 'key'>;
  /** «Мои столы»: whole exports onto photos — markup and settings (export onto a photo). */
  desks!: EntityTable<SavedDesk, 'id'>;
  /** The pictures and masks of the desks' photos. */
  deskPhotos!: EntityTable<DeskPhotoRow, 'id'>;
  /** «Бланки»: printed task sheets the documents are written on (see blank/blank.ts). */
  blanks!: EntityTable<Blank, 'id'>;

  constructor() {
    super('handbook');
    this.version(1).stores({
      samples: 'id, char, createdAt',
      documents: 'id, updatedAt',
      settings: 'key',
    });
    this.version(2).stores({ desks: 'id, updatedAt' });
    // 0.5.5: a desk keeps all the photos of an export and all its settings; the old ones become desks of one photo.
    this.version(3)
      .stores({ deskPhotos: 'id, deskId' })
      .upgrade(async (tx) => {
        const setting = async (key: string) => ((await tx.table('settings').get(key)) as SettingRow | undefined)?.value as object | undefined;
        const base = { sheet: await setting('desk.sheet'), look: await setting('desk.ink') };
        const desks: SavedDesk[] = [];
        const rows: DeskPhotoRow[] = [];
        for (const d of (await tx.table('desks').toArray()) as object[]) {
          if (!isOldDesk(d)) continue;
          const { desk, row } = fromOld(d, base);
          desks.push(desk);
          rows.push(row);
        }
        await tx.table('desks').bulkPut(desks);
        await tx.table('deskPhotos').bulkPut(rows);
      });
    // 0.7.0: a document may be written on a blank.
    this.version(4).stores({ blanks: 'id' });
  }
}

export const db = new HandbookDB();

export async function loadStyle(): Promise<Style> {
  const row = await db.settings.get('style');
  return { ...DEFAULT_STYLE, ...((row?.value as Partial<Style>) ?? {}) };
}

export async function saveStyle(style: Style) {
  await db.settings.put({ key: 'style', value: style });
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return (row?.value as T) ?? fallback;
}

export async function setSetting(key: string, value: unknown) {
  await db.settings.put({ key, value });
}

/** What new documents start with («Сохранить по умолчанию» in the menus); none saved: the built-in setup. */
const PAGE_DEFAULTS = 'pageDefaults';

export const pageDefaults = () => getSetting<Partial<PageSetup> | null>(PAGE_DEFAULTS, null);

/** Saves these parts of a page setup for new documents (the rest saved before stays). */
export async function savePageDefaults(part: Partial<PageSetup>) {
  await setSetting(PAGE_DEFAULTS, { ...(await pageDefaults()), ...part });
}

/** Forgets these parts: new documents take them built-in again. */
export async function forgetPageDefaults(keys: (keyof PageSetup)[]) {
  const rest: Partial<PageSetup> = { ...(await pageDefaults()) };
  for (const k of keys) delete rest[k];
  await setSetting(PAGE_DEFAULTS, Object.keys(rest).length ? rest : null);
}

export async function createDocument(
  title = 'Без названия',
  content: DocContent = { type: 'doc', content: [{ type: 'paragraph' }] },
): Promise<HandDocument> {
  const now = Date.now();
  // A blank and the first sheet's number belong to one document, never to new ones.
  const { blank: _b, firstNumber: _f, ...page } = (await pageDefaults()) ?? {};
  const doc: HandDocument = {
    id: uid(),
    title,
    content,
    ...(Object.keys(page).length ? { page } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await db.documents.add(doc);
  return doc;
}

/** Backup format for the handwriting (samples + style). */
export interface HandwritingBackup {
  format: 'handbook-handwriting';
  version: 1;
  style: Style;
  samples: Sample[];
}

export async function exportHandwriting(): Promise<HandwritingBackup> {
  return {
    format: 'handbook-handwriting',
    version: 1,
    style: await loadStyle(),
    samples: await db.samples.toArray(),
  };
}

/** Everything in one file: handwriting, documents and settings (moving to another computer or app). */
export interface FullBackup {
  format: 'handbook-backup';
  version: 1;
  exportedAt: number;
  samples: Sample[];
  documents: HandDocument[];
  settings: SettingRow[];
  /** «Мои столы», when asked for (photos make the file large). */
  desks?: unknown[];
  /** The documents' blanks (pictures as data URLs): a document without its blank loses its sheet. */
  blanks?: unknown[];
}

export async function exportEverything(desks?: unknown[], blanks?: unknown[]): Promise<FullBackup> {
  return {
    format: 'handbook-backup',
    version: 1,
    exportedAt: Date.now(),
    samples: await db.samples.toArray(),
    documents: await db.documents.toArray(),
    settings: await db.settings.toArray(),
    ...(desks ? { desks } : {}),
    ...(blanks?.length ? { blanks } : {}),
  };
}

/** Adds a full backup to what is here; rows with the same id are replaced by the backup's. */
export async function importEverything(data: FullBackup): Promise<{ samples: number; documents: number }> {
  if (data?.format !== 'handbook-backup' || !Array.isArray(data.samples) || !Array.isArray(data.documents)) {
    throw new Error('Это не резервная копия Handbook');
  }
  await db.transaction('rw', db.samples, db.documents, db.settings, async () => {
    await db.samples.bulkPut(data.samples);
    await db.documents.bulkPut(data.documents);
    if (Array.isArray(data.settings)) await db.settings.bulkPut(data.settings);
  });
  return { samples: data.samples.length, documents: data.documents.length };
}

export async function importHandwriting(data: HandwritingBackup, replace: boolean) {
  if (data?.format !== 'handbook-handwriting' || !Array.isArray(data.samples)) {
    throw new Error('Это не файл почерка Handbook');
  }
  await db.transaction('rw', db.samples, db.settings, async () => {
    if (replace) await db.samples.clear();
    await db.samples.bulkPut(data.samples);
    if (data.style) await saveStyle({ ...DEFAULT_STYLE, ...data.style });
  });
}
