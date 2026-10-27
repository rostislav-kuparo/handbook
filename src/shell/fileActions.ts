import { exportDesks, importDesks } from '../desk/desks';
import { showDocument } from '../editor/docState';
import { createDocument, exportEverything, exportHandwriting, getSetting, importEverything, importHandwriting } from '../storage/db';
import { saveFile } from '../util/download';
import { pickJsonFile } from '../util/pickFile';

/** The full backup also carries «Мои столы» (their photos make it large). */
export const BACKUP_DESKS_KEY = 'backup.desks';

export async function newDocument() {
  showDocument((await createDocument()).id);
}

/** Opens a document, or loads a full backup / handwriting file (any Handbook .json). */
export async function openJson() {
  const file = await pickJsonFile();
  if (!file) return;
  try {
    const data = JSON.parse(file.text);
    if (data?.format === 'handbook-backup') {
      const n = await importEverything(data);
      const desks = Array.isArray(data.desks) ? await importDesks(data.desks) : 0;
      alert(`Загружено из резервной копии: документов — ${n.documents}, вариантов букв — ${n.samples}${desks ? `, столов — ${desks}` : ''}.`);
      return;
    }
    if (data?.format === 'handbook-handwriting') {
      await importHandwriting(data, false);
      alert(`Почерк добавлен: вариантов букв — ${data.samples.length}.`);
      return;
    }
    if (data?.format !== 'handbook-document' || !data.content) throw new Error('Это не файл Handbook (.json)');
    showDocument((await createDocument(String(data.title ?? 'Без названия'), data.content)).id);
  } catch (err) {
    alert(String(err));
  }
}

/** Handwriting, every document and the settings in one file. */
export async function backupEverything() {
  const withDesks = await getSetting(BACKUP_DESKS_KEY, false);
  const data = await exportEverything(withDesks ? await exportDesks() : undefined);
  const day = new Date().toISOString().slice(0, 10);
  await saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), `handbook-backup-${day}.json`);
}

export async function saveHandwriting() {
  const data = await exportHandwriting();
  await saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'pocherk.handbook.json');
}

export async function loadHandwriting() {
  const file = await pickJsonFile();
  if (!file) return;
  try {
    const data = JSON.parse(file.text);
    const replace = confirm('Заменить текущий почерк? «Отмена» — добавить образцы к текущим.');
    await importHandwriting(data, replace);
  } catch (err) {
    alert(String(err));
  }
}
