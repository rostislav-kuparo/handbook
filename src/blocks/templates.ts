// Starter templates for HTML blocks. Each is plain HTML/CSS/JS using the
// `block` SDK (see runtime.ts) plus rough.js / Chart.js, which are preloaded.

export interface BlockTemplate {
  id: string;
  name: string;
  description: string;
  title: string;
  code: string;
  data: unknown;
}

const barChart = String.raw`<div id="chart"></div>
<p class="hint">Потяните столбик вверх или вниз. Подписи и цвета — в панели «Данные».</p>
<style>
  #chart svg { width: 100%; height: auto; display: block; touch-action: none; }
  #chart text { font-family: var(--hand); fill: var(--ink); }
  .hint { margin: 0; font: 13px system-ui, sans-serif; opacity: .55; }
</style>
<script>
const W = 640, H = 320, PAD = 46;
const root = document.getElementById('chart');
let view = null;
let drag = null;

block.onData((d) => { if (!drag) { view = d; render(); } });
block.onFont(() => render());

function render() {
  const d = view;
  if (!d) return;
  root.innerHTML = '';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  root.appendChild(svg);
  const rc = rough.svg(svg);
  const max = drag ? drag.max : Math.max(...d.values, 1) * 1.2;
  const bw = (W - PAD * 1.5) / d.values.length;
  const base = H - PAD;
  svg.appendChild(rc.line(PAD * 0.6, base, W - PAD * 0.4, base, { roughness: 1.3, seed: 99, stroke: block.ink }));
  d.values.forEach((v, i) => {
    const h = (v / max) * (H - PAD * 2.2);
    const x = PAD * 0.8 + i * bw + bw * 0.15;
    const g = rc.rectangle(x, base - h, bw * 0.7, Math.max(h, 1), {
      fill: d.color, fillStyle: 'hachure', hachureGap: 7, roughness: 1.6, stroke: block.ink, seed: i + 1,
    });
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hit.setAttribute('x', x); hit.setAttribute('y', base - h - 6);
    hit.setAttribute('width', bw * 0.7); hit.setAttribute('height', Math.max(h, 1) + 12);
    hit.setAttribute('fill', 'transparent');
    g.appendChild(hit);
    g.style.cursor = 'ns-resize';
    g.addEventListener('pointerdown', (e) => startDrag(e, i, max, svg));
    svg.appendChild(g);
    label(svg, x + bw * 0.35, base + 30, d.labels[i] ?? '', 20);
    label(svg, x + bw * 0.35, base - h - 10, String(v), 18);
  });
  label(svg, W / 2, 30, d.title, 26);
}

function label(svg, x, y, s, size) {
  const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t.setAttribute('x', x); t.setAttribute('y', y);
  t.setAttribute('font-size', size); t.setAttribute('text-anchor', 'middle');
  t.textContent = s;
  svg.appendChild(t);
}

function startDrag(e, i, max, svg) {
  e.preventDefault();
  const pt = svg.createSVGPoint();
  const valueAt = (ev) => {
    pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return Math.max(0, Math.round(((H - PAD) - p.y) / (H - PAD * 2.2) * max));
  };
  drag = { i, max };
  const move = (ev) => {
    view = { ...view, values: view.values.map((v, k) => (k === i ? valueAt(ev) : v)) };
    render();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    drag = null;
    block.setData(view);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
</script>`;

const lineChart = String.raw`<div class="wrap"><canvas id="c"></canvas></div>
<p class="hint">Перетаскивайте точки мышью. Ряды и подписи — в панели «Данные».</p>
<style>
  .wrap { position: relative; width: 100%; height: 280px; }
  .hint { margin: 2px 0 0; font: 13px system-ui, sans-serif; opacity: .55; }
</style>
<script>
const canvas = document.getElementById('c');
let chart = null;
let dragging = null;

function build(d) {
  if (!d) return;
  Chart.defaults.font.family = block.font;
  Chart.defaults.font.size = 16;
  Chart.defaults.color = block.ink;
  if (chart) chart.destroy();
  chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: d.labels,
      datasets: d.series.map((s) => ({
        label: s.name, data: s.values.slice(), borderColor: s.color, backgroundColor: s.color,
        tension: 0.35, pointRadius: 6, pointHoverRadius: 9, borderWidth: 3,
      })),
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      plugins: { title: { display: !!d.title, text: d.title, font: { size: 22 } } },
      scales: { y: { beginAtZero: true } },
    },
  });
}

block.onData((d) => { if (!dragging) build(d); });
block.onFont(() => build(block.data));

canvas.addEventListener('pointerdown', (e) => {
  const hit = chart && chart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, false)[0];
  if (!hit) return;
  dragging = hit;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const v = chart.scales.y.getValueForPixel(e.offsetY);
  chart.data.datasets[dragging.datasetIndex].data[dragging.index] = Math.max(0, Math.round(v * 10) / 10);
  chart.update('none');
});
canvas.addEventListener('pointerup', () => {
  if (!dragging) return;
  const d = structuredClone(block.data);
  d.series[dragging.datasetIndex].values = chart.data.datasets[dragging.datasetIndex].data.slice();
  dragging = null;
  block.setData(d);
});
</script>`;

const shapes = String.raw`<div class="bar">
  <button data-add="rect">▭ Прямоугольник</button>
  <button data-add="ellipse">◯ Овал</button>
  <button data-add="diamond">◇ Ромб</button>
  <button id="arrow">→ Стрелка</button>
  <button id="del">Удалить</button>
  <span class="hint" id="hint">Перетаскивайте фигуры · двойной клик — текст</span>
</div>
<svg id="board" viewBox="0 0 640 320"></svg>
<style>
  body { position: relative; }
  .bar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 6px; font: 13px system-ui, sans-serif; }
  .bar button { border: 1px solid #c9cfdd; background: #fff; border-radius: 6px; padding: 3px 8px; cursor: pointer; font: inherit; color: #1f2a44; }
  .bar button.on { background: #1f2a6b; color: #fff; }
  .hint { opacity: .55; }
  #board { width: 100%; height: auto; display: block; touch-action: none; user-select: none; }
  #board text { font-family: var(--hand); fill: var(--ink); pointer-events: none; }
  .sel path { stroke: #e0523f !important; }
  .edit { position: absolute; font-family: var(--hand); font-size: 20px; text-align: center; color: var(--ink);
          border: 1px solid #1f2a6b; border-radius: 4px; background: #fffdf6; padding: 2px; }
</style>
<script>
const svg = document.getElementById('board');
const NS = 'http://www.w3.org/2000/svg';
let d = null, selected = null, arrowFrom = null, arrowMode = false, drag = null;

block.onData((next) => { if (!drag) { d = structuredClone(next); render(); } });
block.onFont(() => render());

function commit() { block.setData(structuredClone(d)); }

function edgePoint(A, B) {
  const ax = A.x + A.w / 2, ay = A.y + A.h / 2, bx = B.x + B.w / 2, by = B.y + B.h / 2;
  const dx = bx - ax, dy = by - ay;
  const t = Math.min(Math.abs(A.w / 2 / (dx || 1e-9)), Math.abs(A.h / 2 / (dy || 1e-9)));
  const k = A.type === 'rect' ? 1 : 0.85;
  return [ax + dx * t * k, ay + dy * t * k];
}

function render() {
  if (!d) return;
  svg.innerHTML = '';
  const rc = rough.svg(svg);
  const byId = Object.fromEntries(d.shapes.map((s) => [s.id, s]));
  const ink = { stroke: block.ink, strokeWidth: 1.6 };
  for (const a of d.arrows) {
    const A = byId[a.from], B = byId[a.to];
    if (!A || !B) continue;
    const [x1, y1] = edgePoint(A, B), [x2, y2] = edgePoint(B, A);
    svg.appendChild(rc.line(x1, y1, x2, y2, { ...ink, roughness: 1.2, seed: 7 }));
    const ang = Math.atan2(y2 - y1, x2 - x1);
    for (const s of [-1, 1]) {
      svg.appendChild(rc.line(x2, y2, x2 - 14 * Math.cos(ang + s * 0.45), y2 - 14 * Math.sin(ang + s * 0.45), { ...ink, roughness: 0.8, seed: 8 }));
    }
  }
  d.shapes.forEach((s, i) => {
    const o = { fill: s.color, fillStyle: 'hachure', hachureGap: 8, roughness: 1.5, seed: i + 11, ...ink, strokeWidth: 1.4 };
    const diamond = [[s.x + s.w / 2, s.y], [s.x + s.w, s.y + s.h / 2], [s.x + s.w / 2, s.y + s.h], [s.x, s.y + s.h / 2]];
    const g = s.type === 'ellipse' ? rc.ellipse(s.x + s.w / 2, s.y + s.h / 2, s.w, s.h, o)
      : s.type === 'diamond' ? rc.polygon(diamond, o)
      : rc.rectangle(s.x, s.y, s.w, s.h, o);
    // rough.js hachures leave gaps; an invisible shape makes the whole figure clickable.
    const hit = document.createElementNS(NS, s.type === 'ellipse' ? 'ellipse' : 'polygon');
    if (s.type === 'ellipse') {
      hit.setAttribute('cx', s.x + s.w / 2); hit.setAttribute('cy', s.y + s.h / 2);
      hit.setAttribute('rx', s.w / 2); hit.setAttribute('ry', s.h / 2);
    } else {
      const pts = s.type === 'diamond' ? diamond : [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]];
      hit.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
    }
    hit.setAttribute('fill', 'transparent');
    g.appendChild(hit);
    g.dataset.id = s.id;
    g.style.cursor = arrowMode ? 'crosshair' : 'move';
    if (s.id === selected || s.id === arrowFrom) g.classList.add('sel');
    svg.appendChild(g);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', s.x + s.w / 2); t.setAttribute('y', s.y + s.h / 2 + 7);
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', 22);
    t.textContent = s.text;
    svg.appendChild(t);
  });
}

function toSvg(e) {
  const pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function setArrowMode(on) {
  arrowMode = on; arrowFrom = null;
  document.getElementById('arrow').classList.toggle('on', on);
  document.getElementById('hint').textContent = on ? 'Кликните первую фигуру, затем вторую' : 'Перетаскивайте фигуры · двойной клик — текст';
  render();
}

svg.addEventListener('pointerdown', (e) => {
  const g = e.target.closest('[data-id]');
  if (!g) { selected = null; render(); return; }
  const id = g.dataset.id;
  if (arrowMode) {
    if (!arrowFrom) { arrowFrom = id; render(); }
    else if (arrowFrom !== id) { d.arrows.push({ from: arrowFrom, to: id }); setArrowMode(false); commit(); }
    return;
  }
  const s = d.shapes.find((x) => x.id === id);
  const p = toSvg(e);
  selected = id;
  drag = { s, dx: p.x - s.x, dy: p.y - s.y, moved: false };
  svg.setPointerCapture(e.pointerId);
  render();
});
svg.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = toSvg(e);
  drag.s.x = Math.round(p.x - drag.dx);
  drag.s.y = Math.round(p.y - drag.dy);
  drag.moved = true;
  render();
});
svg.addEventListener('pointerup', () => {
  const moved = drag && drag.moved;
  drag = null;
  if (moved) commit();
});
svg.addEventListener('dblclick', (e) => {
  const g = e.target.closest('[data-id]');
  if (g) editText(g.dataset.id);
});

function editText(id) {
  const s = d.shapes.find((x) => x.id === id);
  const k = svg.getBoundingClientRect().width / 640;
  const input = document.createElement('input');
  input.className = 'edit';
  input.value = s.text;
  Object.assign(input.style, {
    left: s.x * k + 'px', top: svg.offsetTop + (s.y + s.h / 2 - 18) * k + 'px', width: s.w * k + 'px',
  });
  document.body.appendChild(input);
  input.focus();
  input.select();
  let finished = false;
  const done = (save) => {
    if (finished) return;
    finished = true;
    if (save) { s.text = input.value; commit(); }
    input.remove();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
}

const COLORS = ['#ffd27a', '#a8d8ff', '#c8f0b0', '#f7b6c8'];
document.querySelectorAll('[data-add]').forEach((b) => {
  b.addEventListener('click', () => {
    const id = Math.random().toString(36).slice(2, 8);
    d.shapes.push({ id, type: b.dataset.add, x: Math.round(60 + Math.random() * 380), y: Math.round(40 + Math.random() * 160),
      w: 150, h: 80, text: 'Текст', color: COLORS[d.shapes.length % COLORS.length] });
    selected = id;
    commit();
  });
});
document.getElementById('arrow').addEventListener('click', () => setArrowMode(!arrowMode));
function removeSelected() {
  if (!selected) return;
  d.shapes = d.shapes.filter((s) => s.id !== selected);
  d.arrows = d.arrows.filter((a) => a.from !== selected && a.to !== selected);
  selected = null;
  commit();
}
document.getElementById('del').addEventListener('click', removeSelected);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' && !e.target.closest('input')) removeSelected();
});
</script>`;

const custom = String.raw`<div class="card">
  <h2>Свой блок</h2>
  <p>Обычный HTML, CSS и JS. Данные блока — <code>block.data</code>, сохранить — <code>block.setData(...)</code>.
     Шрифт с вашим почерком — <code>var(--hand)</code>.</p>
  <button id="inc">Нажато: <span id="n">0</span></button>
</div>
<style>
  .card { padding: 12px 16px; border: 2px dashed #9aa3c7; border-radius: 12px; }
  .card h2 { margin: 0 0 6px; font-weight: normal; }
  .card button { font: inherit; padding: 4px 14px; border-radius: 8px; border: 1.5px solid var(--ink); background: #fff8e6; color: var(--ink); cursor: pointer; }
  code { font: 14px Consolas, monospace; }
</style>
<script>
block.onData((d) => { document.getElementById('n').textContent = d.count; });
document.getElementById('inc').onclick = () => block.update((d) => ({ ...d, count: d.count + 1 }));
</script>`;

export const TEMPLATES: BlockTemplate[] = [
  {
    id: 'bars',
    name: 'Рукописная диаграмма',
    description: 'Столбики rough.js, тянутся мышью',
    title: 'Диаграмма',
    code: barChart,
    data: { title: 'Прочитано книг', labels: ['Янв', 'Фев', 'Мар', 'Апр', 'Май'], values: [3, 5, 2, 6, 4], color: '#e8a33d' },
  },
  {
    id: 'line',
    name: 'График',
    description: 'Chart.js с перетаскиваемыми точками',
    title: 'График',
    code: lineChart,
    data: {
      title: 'Неделя',
      labels: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
      series: [
        { name: 'энергия', values: [5, 6, 4, 7, 8, 9, 6], color: '#2f6fd6' },
        { name: 'сон', values: [7, 6, 7, 5, 6, 9, 8], color: '#d65a8a' },
      ],
    },
  },
  {
    id: 'shapes',
    name: 'Фигуры и стрелки',
    description: 'Мини-схема: двигать, подписывать, соединять',
    title: 'Схема',
    code: shapes,
    data: {
      shapes: [
        { id: 'a', type: 'rect', x: 40, y: 40, w: 160, h: 80, text: 'Идея', color: '#ffd27a' },
        { id: 'b', type: 'ellipse', x: 330, y: 30, w: 170, h: 95, text: 'План', color: '#a8d8ff' },
        { id: 'c', type: 'diamond', x: 200, y: 185, w: 190, h: 110, text: 'Готово?', color: '#c8f0b0' },
      ],
      arrows: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    },
  },
  {
    id: 'custom',
    name: 'Свой HTML',
    description: 'Пустой блок с примером SDK',
    title: 'Блок',
    code: custom,
    data: { count: 0 },
  },
];
