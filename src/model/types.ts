// Shared data model. Mirrors crates/glyph-core/src/model.rs (camelCase JSON).
//
// Coordinates are font units: 1000 per em, y up, baseline at y = 0.

import type { PageSetup } from '../editor/page';

export const UNITS_PER_EM = 1000;
export const X_HEIGHT = 450;
export const CAP_HEIGHT = 700;
export const DESCENDER = -250; // guide line for descenders in the copybook

export interface InkPoint {
  x: number;
  y: number;
  /** ms since the sample started */
  t: number;
  /** pen pressure 0..1 */
  p: number;
}

export type Stroke = InkPoint[];

/**
 * Where the pen enters a letter from the previous one, or leaves it towards
 * the next one. `connect` = the letter joins its neighbour on that side.
 */
export interface Anchor {
  x: number;
  y: number;
  connect: boolean;
}

/** One handwritten variant of a character, or of a letter pair like "ст" written in one go. */
export interface Sample {
  id: string;
  /** One character, or 2–3 for a letter pair. */
  char: string;
  strokes: Stroke[];
  entry: Anchor | null;
  exit: Anchor | null;
  pointerType: string;
  createdAt: number;
}

export interface Style {
  variants: number;
  seed: number;
  weight: number;
  pressure: number;
  jitter: number;
  slant: number;
  letterSpacing: number;
  wordSpacing: number;
  connect: boolean;
  /** Rendering: join letters by a connecting stroke, also letters written without a lead-in. */
  bridge: boolean;
  /** Generate new variants from the learned shape model. */
  interpolate: boolean;
  /** 0..2: how far generated variants may stray from the written ones. */
  fantasy: number;
  kerning: boolean;
  /** Use recorded letter pairs. */
  pairs: boolean;
  /** Build missing letters from written ones (й from и, Latin look-alikes, punctuation). */
  derive: boolean;
  /** 0..1: random variation of the distance between lines. */
  lineJitter: number;
  /** 0..1: lines droop and letters sag below the ruling. */
  sag: number;
}

export const DEFAULT_STYLE: Style = {
  variants: 7,
  seed: 1,
  weight: 52,
  pressure: 0.55,
  jitter: 0.5,
  slant: 0,
  letterSpacing: 45,
  wordSpacing: 280,
  connect: true,
  bridge: true,
  interpolate: true,
  fantasy: 1,
  kerning: true,
  pairs: true,
  derive: true,
  lineJitter: 0.3,
  sag: 0.3,
};

/** Tiptap JSON document. */
export type DocContent = Record<string, unknown>;

export interface HandDocument {
  id: string;
  title: string;
  content: DocContent;
  /** Page setup (margins, paper, pen colour); defaults when missing. */
  page?: Partial<PageSetup>;
  createdAt: number;
  updatedAt: number;
}

export function uid(): string {
  return crypto.randomUUID();
}
