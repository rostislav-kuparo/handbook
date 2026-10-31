// How close the sheets are looked at: Ctrl + wheel, Ctrl + «+» / «−» / 0.
// Only the stack of sheets is zoomed (CSS zoom); the menus and floating panels
// keep their size. Positions read off the screen (getBoundingClientRect, mouse
// coordinates) are zoomed with it: divide them by `zoomOf` before using them
// as sheet pixels.

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 1.1;

export const clampZoom = (z: number) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100;

/** The zoom of the sheets an element lies on (1 when not zoomed). */
export function zoomOf(el: Element | null | undefined): number {
  const stack = el?.closest<HTMLElement>('.paper-stack, .ink-stack');
  const z = stack ? Number(stack.style.zoom) : NaN;
  return Number.isFinite(z) && z > 0 ? z : 1;
}
