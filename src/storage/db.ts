// Local-first storage in IndexedDB. Nothing leaves the machine.
import Dexie, { type EntityTable } from 'dexie';
import { DEFAULT_STYLE, DocContent, HandDocument, Sample, Style, uid } from '../model/types';

interface SettingRow {
  key: string;
  value: unknown;
}

class HandbookDB extends Dexie {
  samples!: EntityTable<Sample, 'id'>;
  documents!: EntityTable<HandDocument, 'id'>;
  settings!: EntityTable<SettingRow, 'key'>;

  constructor() {
    super('handbook');
    this.version(1).stores({
      samples: 'id, char, createdAt',
      documents: 'id, updatedAt',
      settings: 'key',
    });
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

export async function createDocument(
  title = 'Без названия',
  content: DocContent = { type: 'doc', content: [{ type: 'paragraph' }] },
): Promise<HandDocument> {
  const now = Date.now();
  const doc: HandDocument = {
    id: uid(),
    title,
    content,
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
}

export async function exportEverything(): Promise<FullBackup> {
  return {
    format: 'handbook-backup',
    version: 1,
    exportedAt: Date.now(),
    samples: await db.samples.toArray(),
    documents: await db.documents.toArray(),
    settings: await db.settings.toArray(),
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
