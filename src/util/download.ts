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
 * Saves an exported file and remembers it. The desktop app writes it into the
 * Downloads folder itself (so it knows where the file is and can show it); a
 * browser downloads it the usual way.
 */
export async function saveFile(blob: Blob, filename: string): Promise<ExportEntry> {
  let path: string | null = null;
  if (isDesktop()) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      path = await invoke<string>('save_download', new Uint8Array(await blob.arrayBuffer()), {
        headers: { 'x-file-name': encodeURIComponent(filename) },
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
