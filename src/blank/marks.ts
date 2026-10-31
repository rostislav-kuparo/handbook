// What a neural net is shown of a blank: its points numbered @1, @2… (printed
// points, where long lines cross or meet at a corner, where they end), the
// free places R1, R2… and a millimetre grid — drawn over the blank as a
// picture to paste into a chat. The app keeps the exact places; the net
// only names them.
import { MM, type SheetSize } from '../editor/page';
import { blankPicture, blankRect, blankSheet, type Blank, type BlankMark } from './blank';
import type { SheetMm } from './pickCode';
import { darkOf, type Dark } from './snap';

/** A free place of the sheet, mm from its top left corner. */
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a mark is on the blank's sheet, mm. */
export function markMm(b: Blank, m: BlankMark, sheet: SheetSize = blankSheet(b)): SheetMm {
  const r = blankRect(b, sheet);
  return { x: (r.x + m.u * r.w) / MM, y: (r.y + m.v * r.h) / MM };
}

/** A point of the sheet (mm) as a mark's place on the picture. */
export function markAt(b: Blank, at: SheetMm, kind: BlankMark['kind'], sheet: SheetSize = blankSheet(b)): BlankMark {
  const r = blankRect(b, sheet);
  return { u: (at.x * MM - r.x) / r.w, v: (at.y * MM - r.y) / r.h, kind };
}

/** Reading order: in bands 8 mm high, top to bottom, then left to right. */
export function sortMarks(b: Blank, marks: BlankMark[]): BlankMark[] {
  const at = (m: BlankMark) => markMm(b, m);
  return [...marks].sort((p, q) => Math.round(at(p).y / 8) - Math.round(at(q).y / 8) || at(p).x - at(q).x);
}

/** How long a line of ink runs from (x, y) in direction a, px (a pixel off it is forgiven), up to `max`. */
function runLength(d: Dark, x: number, y: number, a: number, from: number, max: number): number {
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const on = (px: number, py: number) => {
    for (const o of [0, -1, 1]) {
      const xi = Math.round(px - s * o);
      const yi = Math.round(py + c * o);
      if (xi >= 0 && yi >= 0 && xi < d.w && yi < d.h && d.on[yi * d.w + xi]) return true;
    }
    return false;
  };
  let t = from;
  let gap = 0;
  for (; t < max; t += 1) {
    if (on(x + c * t, y + s * t)) gap = 0;
    else if (++gap > 1) break;
  }
  return t - gap;
}

/**
 * The blank's points, found on it: printed points (small circles with a line
 * from them), where long lines cross or turn, and where long lines end.
 * Tables' grids are left out (their crossings would bury the rest).
 */
export async function findMarks(b: Blank): Promise<BlankMark[]> {
  const d = await darkOf(b);
  const sheet = blankSheet(b);
  const r = blankRect(b, sheet);
  const pmm = (d.w / r.w) * MM;
  const D = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < d.w && yi < d.h && d.on[yi * d.w + xi] === 1;
  };
  const longArm = (x: number, y: number, a: number, need: number) => runLength(d, x, y, a, 1.2 * pmm, need * pmm + 1) >= need * pmm;
  const found: { x: number; y: number; kind: BlankMark['kind'] }[] = [];

  // Printed points: small light holes ringed with ink, a long line leaving the ring.
  const seen = new Uint8Array(d.w * d.h);
  const stack: number[] = [];
  for (let start = 0; start < seen.length; start++) {
    if (seen[start] || d.on[start]) continue;
    let [x0, y0, x1, y1, n, sx, sy] = [d.w, d.h, 0, 0, 0, 0, 0];
    let edge = false;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % d.w;
      const y = (i - x) / d.w;
      if (x === 0 || y === 0 || x === d.w - 1 || y === d.h - 1) edge = true;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      n++;
      sx += x;
      sy += y;
      for (const j of [i - 1, i + 1, i - d.w, i + d.w]) {
        if (j < 0 || j >= seen.length || seen[j] || d.on[j]) continue;
        if (Math.abs((j % d.w) - x) > 1) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (edge || x1 - x0 > 2.2 * pmm || y1 - y0 > 2.2 * pmm) continue;
    const cx = sx / n;
    const cy = sy / n;
    const rad = Math.max(x1 - x0, y1 - y0) / 2 + 1;
    // Round: a ring of ink just round the hole.
    let ring = 0;
    for (let j = 0; j < 24; j++) {
      const a = (2 * Math.PI * j) / 24;
      // The ring of a circle a few pixels across is not quite where its hole's size says.
      if ([rad - 1, rad - 0.5, rad, rad + 1].some((q) => q > 0.6 && D(cx + q * Math.cos(a), cy + q * Math.sin(a)))) ring++;
    }
    if (ring < 20 || Math.abs(x1 - x0 - (y1 - y0)) > Math.max(2, 0.3 * pmm)) continue;
    // A letter «о» has no long line leaving it.
    let arm = false;
    for (let j = 0; j < 36 && !arm; j++) arm = runLength(d, cx, cy, (2 * Math.PI * j) / 36, rad + 1, 4 * pmm + 1) >= 4 * pmm;
    if (arm) found.push({ x: cx, y: cy, kind: 'circle' });
  }

  // Crossings, corners and ends of long lines.
  const rho = Math.max(4, pmm);
  const ringN = 40;
  const lines: typeof found = [];
  for (let y = 2; y < d.h - 2; y++) {
    for (let x = 2; x < d.w - 2; x++) {
      if (!d.on[y * d.w + x]) continue;
      const v: boolean[] = [];
      for (let j = 0; j < ringN; j++) {
        const a = (2 * Math.PI * j) / ringN;
        v.push(D(x + rho * Math.cos(a), y + rho * Math.sin(a)));
      }
      const start = v.findIndex((on, j) => !on && v[(j + 1) % ringN]);
      if (start < 0) continue;
      const arms: number[] = [];
      for (let j = 1, run = -1; j <= ringN; j++) {
        const i = (start + j) % ringN;
        if (v[i] && run < 0) run = j;
        if (!v[i] && run >= 0) {
          arms.push(((2 * Math.PI) / ringN) * (start + (run + j - 1) / 2));
          run = -1;
        }
      }
      if (arms.length === 2) {
        const apart = (((arms[1] - arms[0]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (Math.abs(apart - Math.PI) < 0.5) continue;
      }
      if (arms.length === 1) {
        const back = arms[0] + Math.PI;
        if (D(x + 1.6 * Math.cos(back), y + 1.6 * Math.sin(back))) continue;
        if (longArm(x, y, arms[0], 6)) lines.push({ x, y, kind: 'end' });
        continue;
      }
      if (arms.length < 2) continue;
      const long = arms.filter((a) => longArm(x, y, a, 4)).length;
      if (long >= Math.min(3, arms.length)) lines.push({ x, y, kind: 'cross' });
    }
  }
  // One point per cluster: for a crossing, where the ink is thickest; for an end, its middle.
  const used = new Uint8Array(lines.length);
  const disc = Math.max(2, 0.3 * pmm);
  const ink = (x: number, y: number) => {
    let n = 0;
    for (let dy = -Math.ceil(disc); dy <= disc; dy++) for (let dx = -Math.ceil(disc); dx <= disc; dx++) if (dx * dx + dy * dy <= disc * disc && D(x + dx, y + dy)) n++;
    return n;
  };
  lines.forEach((p, i) => {
    if (used[i]) return;
    const group = lines.map((q, j) => ({ q, j })).filter(({ q, j }) => !used[j] && q.kind === p.kind && Math.hypot(q.x - p.x, q.y - p.y) <= 1.5 * pmm);
    group.forEach(({ j }) => (used[j] = 1));
    if (p.kind === 'cross') {
      const scored = group.map(({ q }) => ({ q, s: ink(q.x, q.y) }));
      const best = Math.max(...scored.map((g) => g.s));
      const top = scored.filter((g) => g.s === best);
      found.push({ x: top.reduce((t, g) => t + g.q.x, 0) / top.length, y: top.reduce((t, g) => t + g.q.y, 0) / top.length, kind: 'cross' });
    } else {
      found.push({ x: group.reduce((t, g) => t + g.q.x, 0) / group.length, y: group.reduce((t, g) => t + g.q.y, 0) / group.length, kind: 'end' });
    }
  });

  // Lines leaving a printed point are no crossing; a table's grid is no point.
  const points = found.filter((f) => f.kind === 'circle');
  const crossings = found.filter((f) => f.kind === 'cross');
  const inRow = (f: (typeof found)[number], by: 'x' | 'y') => crossings.filter((c) => Math.abs(c[by] - f[by]) < 0.6 * pmm).length;
  const kept = found.filter(
    (f) =>
      f.kind === 'circle' ||
      (!points.some((q) => Math.hypot(f.x - q.x, f.y - q.y) < 1.8 * pmm) && (f.kind !== 'cross' || (inRow(f, 'y') < 6 && inRow(f, 'x') < 6))),
  );
  // Close ones are one.
  const out: typeof found = [];
  for (const f of kept) if (!out.some((o) => Math.hypot(o.x - f.x, o.y - f.y) < 1.2 * pmm)) out.push(f);
  return sortMarks(
    b,
    out.slice(0, 120).map((f) => ({ u: f.x / d.w, v: f.y / d.h, kind: f.kind })),
  );
}

/** The marks of a blank: as kept (moved by hand), or found now and kept. */
export async function marksOf(b: Blank, save: (marks: BlankMark[]) => void): Promise<BlankMark[]> {
  if (b.marks) return b.marks;
  const marks = await findMarks(b);
  save(marks);
  return marks;
}

/** Cells of this many mm for the free places. */
const CELL = 2;

/**
 * Free places of the sheet (mm): the largest empty rectangles, at least
 * 25 × 12 mm, a cell clear of any printing, largest first, up to `most`.
 */
export async function freeAreas(b: Blank, most = 8): Promise<Area[]> {
  const d = await darkOf(b);
  const sheet = blankSheet(b);
  const r = blankRect(b, sheet);
  const k = d.w / r.w;
  const cell = CELL * MM * k;
  const cols = Math.floor(d.w / cell);
  const rows = Math.floor(d.h / cell);
  const ink = new Uint8Array(cols * rows);
  for (let y = 0; y < d.h; y++) {
    for (let x = 0; x < d.w; x++) {
      if (!d.on[y * d.w + x]) continue;
      const cx = Math.min(cols - 1, Math.floor(x / cell));
      const cy = Math.min(rows - 1, Math.floor(y / cell));
      ink[cy * cols + cx] = 1;
    }
  }
  // Free: no ink in the cell or round it; the printer's margin is not free.
  const free = new Uint8Array(cols * rows);
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      let clear = true;
      for (let dy = -1; dy <= 1 && clear; dy++) for (let dx = -1; dx <= 1 && clear; dx++) if (ink[(y + dy) * cols + x + dx]) clear = false;
      free[y * cols + x] = clear ? 1 : 0;
    }
  }
  const minW = Math.ceil(25 / CELL);
  const minH = Math.ceil(12 / CELL);
  const out: Area[] = [];
  const heights = new Int32Array(cols);
  while (out.length < most) {
    // The largest all-free rectangle: for each row, the largest rectangle under the histogram of free cells above.
    let best = { area: 0, x: 0, y: 0, w: 0, h: 0 };
    heights.fill(0);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) heights[x] = free[y * cols + x] ? heights[x] + 1 : 0;
      const st: number[] = [];
      for (let x = 0; x <= cols; x++) {
        const h = x < cols ? heights[x] : 0;
        while (st.length && heights[st[st.length - 1]] >= h) {
          const top = st.pop()!;
          const hh = heights[top];
          const left = st.length ? st[st.length - 1] + 1 : 0;
          const w = x - left;
          if (w >= minW && hh >= minH && w * hh > best.area) best = { area: w * hh, x: left, y: y - hh + 1, w, h: hh };
        }
        st.push(x);
      }
    }
    if (!best.area) break;
    for (let y = best.y - 1; y <= best.y + best.h; y++) for (let x = best.x - 1; x <= best.x + best.w; x++) if (x >= 0 && y >= 0 && x < cols && y < rows) free[y * cols + x] = 0;
    const toMm = (px: number) => px / k / MM;
    out.push({
      x: toMm(r.x * k + best.x * cell),
      y: toMm(r.y * k + best.y * cell),
      w: toMm(best.w * cell),
      h: toMm(best.h * cell),
    });
  }
  return out;
}

const roundMm = (v: number) => Math.round(v);

/**
 * The blank as the neural net sees it: the printing (black and white), a
 * light millimetre grid with numbers every 20 mm, the points with their
 * numbers and the free places — a PNG about 2000 px across.
 */
export async function markedPicture(b: Blank, marks: BlankMark[], areas: Area[]): Promise<Blob> {
  const sheet = blankSheet(b);
  const r = blankRect(b, sheet);
  const pic = await blankPicture(b);
  const img = new Image();
  img.src = pic.url;
  await img.decode();
  const scale = 2000 / Math.max(sheet.w, sheet.h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sheet.w * scale);
  canvas.height = Math.round(sheet.h * scale);
  const ctx = canvas.getContext('2d')!;
  const P = (mm: number) => mm * MM * scale;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // The grid under the printing.
  ctx.lineWidth = 1;
  for (let mm = 10; mm < sheet.w / MM; mm += 10) {
    ctx.strokeStyle = mm % 50 === 0 ? 'rgba(60,140,230,0.45)' : 'rgba(60,140,230,0.22)';
    ctx.beginPath();
    ctx.moveTo(P(mm) + 0.5, 0);
    ctx.lineTo(P(mm) + 0.5, canvas.height);
    ctx.stroke();
  }
  for (let mm = 10; mm < sheet.h / MM; mm += 10) {
    ctx.strokeStyle = mm % 50 === 0 ? 'rgba(60,140,230,0.45)' : 'rgba(60,140,230,0.22)';
    ctx.beginPath();
    ctx.moveTo(0, P(mm) + 0.5);
    ctx.lineTo(canvas.width, P(mm) + 0.5);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(img, r.x * scale, r.y * scale, r.w * scale, r.h * scale);
  ctx.globalCompositeOperation = 'source-over';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.fillStyle = 'rgb(30,110,210)';
  for (let mm = 20; mm < sheet.w / MM; mm += 20) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(String(mm), P(mm), 2);
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(mm), P(mm), canvas.height - 2);
  }
  for (let mm = 20; mm < sheet.h / MM; mm += 20) {
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(String(mm), 2, P(mm));
    ctx.textAlign = 'right';
    ctx.fillText(String(mm), canvas.width - 2, P(mm));
  }

  // Free places.
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgb(40,160,80)';
  ctx.fillStyle = 'rgb(30,140,70)';
  ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  areas.forEach((a, i) => {
    ctx.strokeRect(P(a.x), P(a.y), P(a.w), P(a.h));
    ctx.fillText(`R${i + 1}`, P(a.x) + 5, P(a.y) + 4);
  });
  ctx.setLineDash([]);

  // The points: a red ring, and its number in a box beside it, where it covers least.
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const darkIn = (x: number, y: number, w: number, h: number) => {
    let n = 0;
    for (let yy = Math.max(0, Math.round(y)); yy < Math.min(canvas.height, y + h); yy += 2)
      for (let xx = Math.max(0, Math.round(x)); xx < Math.min(canvas.width, x + w); xx += 2) {
        const i = (yy * canvas.width + xx) * 4;
        if (data[i] + data[i + 1] + data[i + 2] < 360) n++;
      }
    return n;
  };
  ctx.font = 'bold 15px system-ui, sans-serif';
  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  const spots = marks.map((m) => markMm(b, m, sheet)).map((p) => ({ x: P(p.x), y: P(p.y) }));
  // Every point counts as taken: no box over another point.
  const taken = spots.map((s) => ({ x: s.x - 8, y: s.y - 8, w: 16, h: 16 }));
  spots.forEach((s, i) => {
    const text = `@${i + 1}`;
    const w = ctx.measureText(text).width + 8;
    const h = 19;
    const d = 12;
    const options = [
      [d, -d - h],
      [-d - w, -d - h],
      [d, d],
      [-d - w, d],
      [d + 4, -h / 2],
      [-d - 4 - w, -h / 2],
      [-w / 2, -d - 6 - h],
      [-w / 2, d + 6],
      [2 * d, -2 * d - h],
      [-2 * d - w, 2 * d],
    ];
    const overlap = (q: { x: number; y: number; w: number; h: number }, o: { x: number; y: number; w: number; h: number }) =>
      Math.max(0, Math.min(q.x + q.w, o.x + o.w) - Math.max(q.x, o.x)) * Math.max(0, Math.min(q.y + q.h, o.y + o.h) - Math.max(q.y, o.y));
    let best = { x: 0, y: 0, w, h, cost: Infinity };
    options.forEach(([dx, dy], j) => {
      const q = { x: s.x + dx, y: s.y + dy, w, h };
      if (q.x < 0 || q.y < 0 || q.x + w > canvas.width || q.y + h > canvas.height) return;
      const cost = darkIn(q.x, q.y, w, h) * 3 + [...boxes, ...taken.filter((_, t) => t !== i)].reduce((c, o) => c + overlap(q, o), 0) * 4 + j * 6;
      if (cost < best.cost) best = { ...q, cost };
    });
    if (!Number.isFinite(best.cost)) best = { x: s.x + d, y: s.y + d, w, h, cost: 0 };
    boxes.push(best);
    ctx.strokeStyle = 'rgba(210,40,40,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 6, 0, 2 * Math.PI);
    ctx.stroke();
    const bx = Math.min(Math.max(s.x, best.x), best.x + w);
    const by = Math.min(Math.max(s.y, best.y), best.y + h);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillRect(best.x, best.y, w, h);
    ctx.strokeRect(best.x + 0.5, best.y + 0.5, w - 1, h - 1);
    ctx.fillStyle = 'rgb(200,30,30)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, best.x + 4, best.y + h / 2 + 1);
  });

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('не удалось нарисовать разметку');
  return blob;
}

/** A mark's place as the prompt writes it, mm. */
export const markText = (p: SheetMm) => `(${roundMm(p.x)}, ${roundMm(p.y)})`;
