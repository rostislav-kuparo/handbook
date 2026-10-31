// The traces of work are one setting of the render, kept with the other settings.
import { getSetting, setSetting } from '../storage/db';
import { useLive } from '../util/useLive';
import { wearOf, type WearSettings } from './wear';

const KEY = 'render.wear';

export const loadWear = async (): Promise<WearSettings> => wearOf(await getSetting<unknown>(KEY, null));

export const saveWear = (w: WearSettings) => setSetting(KEY, w);

/** The traces' settings, live: every view redraws when they change. */
export function useWear(): WearSettings {
  return wearOf(useLive(() => getSetting<unknown>(KEY, null), [], null));
}
