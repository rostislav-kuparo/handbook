import { isDesktop } from './download';

export interface PickedFile {
  name: string;
  text: string;
}

/**
 * Asks for a Handbook .json file. The desktop app shows its own dialog: a
 * command from the window menu is not a click on the page, and the browser
 * would refuse to open its file chooser for it.
 */
export async function pickJsonFile(): Promise<PickedFile | null> {
  if (isDesktop()) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      const picked = await invoke<[string, string] | null>('pick_json');
      return picked && { name: picked[0], text: picked[1] };
    } catch (err) {
      alert(`Не удалось открыть файл: ${String(err)}`);
      return null;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void f.text().then((text) => resolve({ name: f.name, text }));
      else resolve(null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
