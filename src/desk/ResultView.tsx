import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Crop } from './CropBox';
import type { Pt } from './homography';
import { Shutter, ZoomPill } from './DeskParts';
import { clampView, FIT, MAX_PIXELS, usePan, useViewInput, zoomAround, type View } from './view';

const PAD = 12;

/** The fitted look at a picture `w`×`h` in a box: its scale and the box. */
export interface Fit {
  fit: number;
  bw: number;
  bh: number;
}

/** The view that shows the photo pixel for pixel (1:1 on the screen), round the box's middle. */
export const oneToOne = (f: Fit): View => zoomAround(FIT, 1 / ((window.devicePixelRatio || 1) * f.fit), f.bw / 2, f.bh / 2);

interface Props {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** The picture's size, px. */
  width: number;
  height: number;
  hidden: boolean;
  view: View;
  onView: (v: View) => void;
  /** How the picture is fitted, as the box changes. */
  onFit?: (f: Fit) => void;
  /** A click takes a point of the picture (photo px) instead of moving it. */
  picking: boolean;
  onPick: (p: Pt) => void;
  /** The «before · after» shutter, when shown (its value: a share of the whole picture's width). */
  shutter?: { value: number; onChange: (v: number) => void } | null;
  /** Only this part of the picture is shown (a crop), photo px; null: all of it. */
  region?: Crop | null;
  /** Over the picture, in its own px (it moves and zooms with it): a function of the picture's place on the screen. */
  over?: (place: { left: number; top: number; scale: number }) => ReactNode;
  children?: ReactNode;
}

/**
 * The finished photo, fitted into its box: the wheel zooms round the
 * pointer, a drag (or the middle button, or Space + drag) moves it; with the
 * pipette a click takes a point of it.
 */
export function ResultView({ canvasRef, width, height, hidden, view, onView, onFit, picking, onPick, shutter, region, over, children }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const dpr = window.devicePixelRatio || 1;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [rx0, ry0, rx1, ry1] = region ?? [0, 0, width, height];
  const [rw, rh] = [rx1 - rx0, ry1 - ry0];
  const fit = box.w > 0 && rw > 0 ? Math.min((box.w - 2 * PAD) / rw, (box.h - 2 * PAD) / rh) : 0;
  useEffect(() => {
    if (fit > 0) onFit?.({ fit, bw: box.w, bh: box.h });
  }, [fit, box.w, box.h]);
  const maxZ = fit > 0 ? Math.max(MAX_PIXELS / (dpr * fit), 1 / (dpr * fit)) : 1;
  const v = clampView(view, box.w, box.h, maxZ);
  const scale = fit * v.z;
  const left = ((box.w - rw * fit) / 2 - rx0 * fit) * v.z + v.x;
  const top = ((box.h - rh * fit) / 2 - ry0 * fit) * v.z + v.y;
  const space = useViewInput(wrapRef, box.w, box.h, v, onView, maxZ);
  const pan = usePan(v, onView, box.w, box.h, maxZ);
  const down = useRef<{ x: number; y: number } | null>(null);

  // The shutter's box: the shown part across, its part in view up and down (so the grip stays in sight).
  const [sl, st] = [left + rx0 * scale, top + ry0 * scale];
  const shown = { left: sl, width: rw * scale, top: Math.max(st, 0), height: Math.min(st + rh * scale, box.h) - Math.max(st, 0) };
  // Outside the crop the picture is not shown.
  const clip = region ? `inset(${ry0 * scale}px ${(width - rx1) * scale}px ${(height - ry1) * scale}px ${rx0 * scale}px)` : undefined;
  return (
    <div className={`desk-result ${picking ? 'picking' : ''}`} hidden={hidden} ref={wrapRef}>
      <canvas
        ref={canvasRef}
        style={{ left, top, width: width * scale, height: height * scale, clipPath: clip, imageRendering: scale * dpr > 2.5 ? 'pixelated' : undefined, cursor: pan.active ? 'grabbing' : picking ? 'crosshair' : v.z > 1 ? 'grab' : 'default' }}
        onPointerDown={(e) => {
          down.current = { x: e.clientX, y: e.clientY };
          if (e.button === 1 || space.current || (e.button === 0 && !picking && v.z > 1)) {
            e.preventDefault();
            pan.start(e);
          }
        }}
        onPointerMove={(e) => pan.move(e)}
        onPointerUp={(e) => {
          const moved = down.current && Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y) > 4;
          down.current = null;
          if (pan.end() || moved || !picking || e.button !== 0) return;
          const r = e.currentTarget.getBoundingClientRect();
          onPick([((e.clientX - r.left) / r.width) * width, ((e.clientY - r.top) / r.height) * height]);
        }}
        onPointerCancel={() => pan.end()}
      />
      {over?.({ left, top, scale })}
      {shutter && (
        <Shutter
          value={Math.min(1, Math.max(0, (shutter.value * width - rx0) / rw))}
          onChange={(x) => shutter.onChange(x <= 0 ? 0 : (rx0 + x * rw) / width)}
          box={shown}
        />
      )}
      {v.z > 1 && <ZoomPill percent={scale * dpr * 100} onReset={() => onView(FIT)} />}
      {children}
    </div>
  );
}
