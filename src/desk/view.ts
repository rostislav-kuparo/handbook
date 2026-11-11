// How a photo fitted into its box is looked at: zoomed round the fit and
// moved. The wheel zooms round the pointer (a touchpad's pinch too), Ctrl +
// «+» / «−» / «0» from the keyboard; the middle button, Space + drag or a
// drag on an empty place moves the picture.
import { useEffect, useRef, type RefObject } from 'react';

/** `z` times the fit, moved by (x, y) screen px: a point the fit shows at b is at b · z + (x, y). */
export interface View {
  z: number;
  x: number;
  y: number;
}

export const FIT: View = { z: 1, x: 0, y: 0 };

/** The closest look: this many screen (device) pixels per photo pixel. */
export const MAX_PIXELS = 8;

/** The view kept sensible: from the fit to `maxZ`, the picture's fitted box not dragged off the screen. */
export function clampView(v: View, w: number, h: number, maxZ: number): View {
  const z = Math.min(Math.max(1, maxZ), Math.max(1, v.z));
  if (z === 1) return FIT;
  const keep = (t: number, size: number) => Math.min(0, Math.max(size * (1 - z), t));
  return { z, x: keep(v.x, w), y: keep(v.y, h) };
}

/** Zoomed `k` times more, the screen point (cx, cy) staying where it is. */
export function zoomAround(v: View, k: number, cx: number, cy: number): View {
  const z = Math.max(1, v.z * k);
  const f = z / v.z;
  return { z, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
}

/**
 * The wheel and the keys on a view of a box `w`×`h`: the wheel over `el`
 * zooms round the pointer, Ctrl + «+» / «−» / «0» round the box's middle.
 * Returns whether Space is held (a drag then moves the picture).
 */
export function useViewInput(el: RefObject<HTMLElement | null>, w: number, h: number, view: View, onView: (v: View) => void, maxZ: number) {
  const now = useRef({ view, onView, w, h, maxZ });
  now.current = { view, onView, w, h, maxZ };
  const space = useRef(false);
  useEffect(() => {
    const target = el.current;
    if (!target) return;
    const set = (v: View) => {
      const c = now.current;
      // Kept at once: several wheel steps may come before the next render.
      c.view = clampView(v, c.w, c.h, c.maxZ);
      c.onView(c.view);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = target.getBoundingClientRect();
      // A notch of a wheel (~100) zooms by about 1.2; a touchpad's small steps smoothly.
      const k = Math.exp(-Math.max(-300, Math.min(300, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY)) * 0.0018);
      set(zoomAround(clampView(now.current.view, now.current.w, now.current.h, now.current.maxZ), k, e.clientX - r.left, e.clientY - r.top));
    };
    const keys = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) space.current = e.type === 'keydown';
      if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey)) return;
      const c = now.current;
      const k = e.key === '=' || e.key === '+' ? 1.25 : e.key === '-' ? 1 / 1.25 : e.key === '0' ? 0 : null;
      if (k === null) return;
      // Not the document's zoom behind the dialog too.
      e.preventDefault();
      e.stopPropagation();
      set(k === 0 ? FIT : zoomAround(clampView(c.view, c.w, c.h, c.maxZ), k, c.w / 2, c.h / 2));
    };
    const blur = () => (space.current = false);
    target.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', keys, true);
    window.addEventListener('keyup', keys, true);
    window.addEventListener('blur', blur);
    return () => {
      target.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', keys, true);
      window.removeEventListener('keyup', keys, true);
      window.removeEventListener('blur', blur);
    };
  }, [el]);
  return space;
}

/** Moving the picture by dragging: start on a pointer down, then each move shifts the view. */
export function usePan(view: View, onView: (v: View) => void, w: number, h: number, maxZ: number) {
  const from = useRef<{ x: number; y: number; view: View } | null>(null);
  return {
    get active() {
      return from.current !== null;
    },
    start(e: React.PointerEvent) {
      e.currentTarget.setPointerCapture(e.pointerId);
      from.current = { x: e.clientX, y: e.clientY, view };
    },
    move(e: React.PointerEvent) {
      const f = from.current;
      if (!f) return false;
      onView(clampView({ ...f.view, x: f.view.x + e.clientX - f.x, y: f.view.y + e.clientY - f.y }, w, h, maxZ));
      return true;
    },
    end() {
      const was = from.current !== null;
      from.current = null;
      return was;
    },
  };
}
