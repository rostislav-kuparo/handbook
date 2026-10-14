// The handwriting store: samples + style from IndexedDB, rebuilt into a live
// web font whenever they change. Components read it with `useHandwriting()`.
import { liveQuery } from 'dexie';
import { useSyncExternalStore } from 'react';
import { DEFAULT_STYLE, Sample, Style } from '../model/types';
import { db, loadStyle, saveStyle } from '../storage/db';
import { engine } from './client';
import { FONT_FAMILY } from './constants';

export interface HandState {
  loaded: boolean;
  samples: Sample[];
  byChar: Map<string, Sample[]>;
  style: Style;
  /** Increments every time a new font is installed. */
  fontVersion: number;
  fontBytes: Uint8Array | null;
  building: boolean;
  lastBuildMs: number;
  joinLow: number | null;
  joinHigh: number | null;
  /** Letters built automatically (key -> source). */
  derived: Map<string, string>;
  /** Learned directions of variation per key. */
  learned: Record<string, number>;
  error: string | null;
}

let state: HandState = {
  loaded: false,
  samples: [],
  byChar: new Map(),
  style: DEFAULT_STYLE,
  fontVersion: 0,
  fontBytes: null,
  building: false,
  lastBuildMs: 0,
  joinLow: null,
  joinHigh: null,
  derived: new Map(),
  learned: {},
  error: null,
};

const listeners = new Set<() => void>();
function set(patch: Partial<HandState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useHandwriting(): HandState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export function getHandwriting(): HandState {
  return state;
}

/** True when the text can show this character in the user's hand (written or derived). */
export function hasGlyph(ch: string): boolean {
  return state.byChar.has(ch) || state.derived.has(ch);
}

export function subscribeHandwriting(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ---------------------------------------------------------------- font build

let installed: FontFace | null = null;
let rebuildTimer: number | undefined;
let building = false;
let again = false;

async function installFont(bytes: Uint8Array) {
  const face = new FontFace(FONT_FAMILY, bytes.slice().buffer, { display: 'block' });
  await face.load();
  document.fonts.add(face);
  if (installed) document.fonts.delete(installed);
  installed = face;
}

async function rebuild() {
  if (building) {
    again = true;
    return;
  }
  building = true;
  set({ building: true });
  try {
    const t0 = performance.now();
    await engine.setStyle(state.style);
    await engine.setSamples(state.samples);
    const bytes = await engine.buildFont();
    const info = await engine.info();
    await installFont(bytes);
    set({
      fontBytes: bytes,
      fontVersion: state.fontVersion + 1,
      lastBuildMs: Math.round(performance.now() - t0),
      joinLow: info.joinLow,
      joinHigh: info.joinHigh,
      derived: new Map(info.derived.map((d) => [d.key, d.from])),
      learned: info.learned,
      error: null,
    });
  } catch (err) {
    console.error(err);
    set({ error: String(err) });
  } finally {
    building = false;
    set({ building: false });
    if (again) {
      again = false;
      void rebuild();
    }
  }
}

function scheduleRebuild(delay = 200) {
  window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => void rebuild(), delay);
}

// ---------------------------------------------------------------- wiring

let started = false;
export function startHandwriting() {
  if (started) return;
  started = true;
  void loadStyle().then((style) => {
    set({ style });
    liveQuery(() => db.samples.orderBy('createdAt').toArray()).subscribe({
      next: (samples) => {
        const byChar = new Map<string, Sample[]>();
        for (const s of samples) {
          const list = byChar.get(s.char);
          if (list) list.push(s);
          else byChar.set(s.char, [s]);
        }
        set({ samples, byChar, loaded: true });
        scheduleRebuild(state.fontVersion === 0 ? 0 : 200);
      },
      error: (err) => set({ error: String(err) }),
    });
  });
}

// ---------------------------------------------------------------- actions

export async function addSample(sample: Sample) {
  await db.samples.add(sample);
}

export async function deleteSample(id: string) {
  await db.samples.delete(id);
}

export async function updateSample(id: string, patch: Partial<Sample>) {
  await db.samples.update(id, patch);
}

export async function updateStyle(patch: Partial<Style>) {
  const style = { ...state.style, ...patch };
  set({ style });
  await saveStyle(style);
  scheduleRebuild(350);
}
