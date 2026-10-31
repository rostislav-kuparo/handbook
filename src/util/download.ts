import { getSetting, setSetting } from '../storage/db';

/** One exported file, for the export history in the top bar. */
export interface ExportEntry {
  id: string;
  name: string;
  /** Full path on disk (desktop app); null in the browser, where the browser decides. */
  path: string | null;
  size: number;
  at: number;
}

const HISTORY_KEY = 'exports.history';
const HISTORY_LIMIT = 30;
/** Fired on window after every export; the history button opens on it. */
export const EXPORTED_EVENT = 'handbook:exported';

/** Running inside the desktop app (Tauri), not a browser tab. */
export const isDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'document';
}

export const exportHistory = () => getSetting<ExportEntry[]>(HISTORY_KEY, []);
export const clearExportHistory = () => setSetting(HISTORY_KEY, []);

/**
 * A new folder for one export (desktop app): Downloads\Handbook\<date>_<n>,
 * the n-th export of the day; null in a browser, which decides itself.
 * An export of several files saves them all into one folder.
 */
export async function exportFolder(): Promise<string | null> {
  if (!isDesktop()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return invoke<string>('new_export_folder', { date: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}` });
}

/**
 * Saves an exported file and remembers it. The desktop app writes it into
 * `folder` (see `exportFolder`; a new one when not given) itself, so it knows
 * where the file is and can show it; a browser downloads it the usual way.
 */
export async function saveFile(blob: Blob, filename: string, folder?: string | null): Promise<ExportEntry> {
  let path: string | null = null;
  if (isDesktop()) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      const dir = folder ?? (await exportFolder());
      path = await invoke<string>('save_download', new Uint8Array(await blob.arrayBuffer()), {
        headers: { 'x-file-name': encodeURIComponent(filename), ...(dir ? { 'x-folder': encodeURIComponent(dir) } : {}) },
      });
    } catch (err) {
      alert(`Не удалось сохранить «${filename}»: ${String(err)}`);
      throw err;
    }
  } else {
    downloadBlob(blob, filename);
  }
  const entry: ExportEntry = {
    id: crypto.randomUUID(),
    name: path ? path.split(/[\\/]/).pop()! : filename,
    path,
    size: blob.size,
    at: Date.now(),
  };
  await setSetting(HISTORY_KEY, [entry, ...(await exportHistory())].slice(0, HISTORY_LIMIT));
  window.dispatchEvent(new CustomEvent<ExportEntry>(EXPORTED_EVENT, { detail: entry }));
  return entry;
}

/** Shows an exported file in its folder (desktop app only). */
export async function revealFile(path: string) {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('reveal_file', { path }).catch((err) => alert(String(err)));
}

/** Opens an exported file in its usual program (desktop app only). */
export async function openFile(path: string) {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_file', { path }).catch((err) => alert(String(err)));
}
