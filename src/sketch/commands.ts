// Every command a drawing understands. This one list drives the evaluator,
// the help window and the instructions for neural nets, so they never disagree.
import * as g from './geometry';
import type { Expr } from './lang';
import type { Ctx, Shape, SpaceKind, Val, Vec, Vec3 } from './types';

export type GroupId = 'points' | 'lines' | 'shapes' | 'graphs' | 'space' | 'text' | 'style' | 'view';

export const GROUPS: { id: GroupId; name: string }[] = [
  { id: 'points', name: 'Точки и преобразования' },
  { id: 'lines', name: 'Прямые и отрезки' },
  { id: 'shapes', name: 'Окружности, многоугольники, углы' },
  { id: 'graphs', name: 'Графики' },
  { id: 'space', name: 'Пространство и эпюр' },
  { id: 'text', name: 'Подписи и текст' },
  { id: 'style', name: 'Оформление' },
  { id: 'view', name: 'Окно и оси' },
];

export interface Command {
  /** Russian name first, then GeoGebra's English one (then other accepted spellings). */
  names: string[];
  group: GroupId;
  /** Ways to call it; «@» stands for the name. */
  forms: string[];
  doc: string;
  /** Works on its own: shown in the help and inserted by its button. Written with English names. */
  example: string;
  /** Concerns the whole drawing: runs before everything else. */
  view?: boolean;
  run(args: Expr[], c: Ctx): Val;
}

/** Pen colours a drawing may use (null = the document's pen). */
export const COLORS: Record<string, string | null> = {
  black: null,
  чёрный: null,
  черный: null,
  red: '#d9533f',
  красный: '#d9533f',
  blue: '#2f6fd6',
  синий: '#2f6fd6',
  green: '#2f9a5b',
  зелёный: '#2f9a5b',
  зеленый: '#2f9a5b',
  orange: '#e07b2a',
  оранжевый: '#e07b2a',
  purple: '#9a4fd0',
  violet: '#9a4fd0',
  фиолетовый: '#9a4fd0',
  brown: '#8b5a2b',
  коричневый: '#8b5a2b',
  gray: '#7a8194',
  grey: '#7a8194',
  серый: '#7a8194',
  pink: '#d6487e',
  розовый: '#d6487e',
  cyan: '#2a9fc4',
  голубой: '#2a9fc4',
  yellow: '#c9a227',
  жёлтый: '#c9a227',
  желтый: '#c9a227',
};

const shape = (s: Shape): Val => ({ k: 'shape', s });
const point = (p: Vec): Val => shape({ type: 'point', p });
const num = (v: number): Val => ({ k: 'num', v });
const NONE: Val = { k: 'none' };
const ORIGIN: Vec = { x: 0, y: 0 };

function args(list: Expr[], ...counts: number[]) {
  if (counts.includes(list.length)) return;
  const word = (n: number) => `${n} ${n % 10 === 1 && n !== 11 ? 'аргумент' : n >= 2 && n <= 4 ? 'аргумента' : 'аргументов'}`;
  throw new Error(`нужно ${counts.map(word).join(' или ')}, а дано ${list.length}`);
}

const is3 = (p: Vec | Vec3): p is Vec3 => 'z' in p;

/** The points of a figure: all on the sheet, or all in space (then it is drawn as an epure). */
function pointsOf(c: Ctx, list: Expr[]): { flat: Vec[] } | { space: Vec3[] } {
  const pts = list.map((e) => c.pointAny(e));
  const n = pts.filter(is3).length;
  if (n === 0) return { flat: pts };
  if (n === pts.length) return { space: pts as Vec3[] };
  throw new Error('нельзя смешивать точки листа (x, y) и точки пространства (x, y, z)');
}

const space = (of: SpaceKind, pts: Vec3[]): Val => shape({ type: 'space', of, pts });
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Segment, line, ray or vector through two points, on the sheet or in space. */
function twoPoints(of: 'segment' | 'line' | 'ray' | 'vector', c: Ctx, list: Expr[]): Val {
  const pts = pointsOf(c, list);
  if ('space' in pts) return space(of, pts.space);
  return shape({ type: of, a: pts.flat[0], b: pts.flat[1] });
}

function lineOf(c: Ctx, e: Expr): Shape {
  const s = c.shape(e);
  if (!g.isLineLike(s)) throw new Error('нужна прямая, отрезок, луч или вектор');
  return s;
}

function circumcircle(a: Vec, b: Vec, p: Vec): Shape {
  const d = 2 * (a.x * (b.y - p.y) + b.x * (p.y - a.y) + p.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) throw new Error('точки лежат на одной прямой — окружность через них не провести');
  const sa = a.x * a.x + a.y * a.y;
  const sb = b.x * b.x + b.y * b.y;
  const sp = p.x * p.x + p.y * p.y;
  const c = {
    x: (sa * (b.y - p.y) + sb * (p.y - a.y) + sp * (a.y - b.y)) / d,
    y: (sa * (p.x - b.x) + sb * (a.x - p.x) + sp * (b.x - a.x)) / d,
  };
  return { type: 'circle', c, r: g.dist(c, a) };
}

function hex(v: number): string {
  return Math.round(Math.min(Math.max(v, 0), 255)).toString(16).padStart(2, '0');
}

export const COMMANDS: Command[] = [
  // ---------------------------------------------------------------- points
  {
    names: ['Середина', 'Midpoint'],
    group: 'points',
    forms: ['@(A, B)', '@(отрезок)'],
    doc: 'Середина отрезка AB.',
    example: 'A = (0, 0)\nB = (4, 2)\nSegment(A, B)\nM = Midpoint(A, B)',
    run(a, c) {
      args(a, 1, 2);
      if (a.length === 1) {
        const s = c.shape(a[0]);
        if (s.type === 'space' && s.of !== 'point' && s.of !== 'polygon') {
          const [p, q] = s.pts;
          return space('point', [{ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 }]);
        }
        const l = lineOf(c, a[0]) as { a: Vec; b: Vec };
        return point(g.mid(l.a, l.b));
      }
      const pts = pointsOf(c, a);
      if ('space' in pts) {
        const [p, q] = pts.space;
        return space('point', [{ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 }]);
      }
      return point(g.mid(pts.flat[0], pts.flat[1]));
    },
  },
  {
    names: ['Пересечение', 'Intersect'],
    group: 'points',
    forms: ['@(a, b)', '@(a, b, n)', '@(a, b, точка рядом)'],
    doc: 'Точка пересечения прямых, отрезков, окружностей или графиков. Если точек несколько: n — номер (слева направо), или точка, рядом с которой искать. Графики пересекаются в пределах окна, а без него — при x от −10 до 10.',
    example: 'f(x) = x^2 - 2\ng(x) = x\nA = Intersect(f, g, 1)\nB = Intersect(f, g, 2)',
    run(a, c) {
      args(a, 2, 3);
      const pts = g.intersect(c.shape(a[0]), c.shape(a[1]), c.range());
      if (!pts.length) throw new Error('эти объекты не пересекаются');
      if (a.length === 2) return point(pts[0]);
      const third = c.val(a[2]);
      if (third.k === 'shape' && third.s.type === 'point') {
        const near = third.s.p;
        return point(pts.reduce((best, p) => (g.dist(p, near) < g.dist(best, near) ? p : best)));
      }
      const n = Math.round(c.num(a[2]));
      if (n < 1 || n > pts.length) throw new Error(`точек пересечения ${pts.length}, а нужна ${n}-я`);
      return point(pts[n - 1]);
    },
  },
  {
    names: ['Расстояние', 'Distance'],
    group: 'points',
    forms: ['@(A, B)', '@(A, прямая)'],
    doc: 'Число: расстояние между точками или от точки до прямой. Для точек в пространстве — настоящее расстояние (натуральная величина).',
    example: 'A = (0, 0)\nB = (3, 4)\nd = Distance(A, B)\nCircle(A, d)',
    run(a, c) {
      args(a, 2);
      const first = c.pointAny(a[0]);
      if (is3(first)) {
        const second = c.pointAny(a[1]);
        if (!is3(second)) throw new Error('нельзя смешивать точки листа (x, y) и точки пространства (x, y, z)');
        return num(dist3(first, second));
      }
      return num(g.distanceTo(first, c.shape(a[1])));
    },
  },
  {
    names: ['Длина', 'Length'],
    group: 'points',
    forms: ['@(отрезок)'],
    doc: 'Число: длина отрезка или вектора, периметр многоугольника, длина окружности или дуги.',
    example: 'A = (0, 0)\nB = (3, 4)\ns = Segment(A, B)\nCircle(B, Length(s) / 2)',
    run(a, c) {
      args(a, 1);
      const s = c.shape(a[0]);
      if (s.type === 'space') {
        if (s.of === 'point' || s.of === 'line' || s.of === 'ray') throw new Error('длина есть у отрезка, вектора и многоугольника');
        const closed = s.of === 'polygon';
        let sum = 0;
        for (let i = 0; i + (closed ? 0 : 1) < s.pts.length; i++) sum += dist3(s.pts[i], s.pts[(i + 1) % s.pts.length]);
        return num(sum);
      }
      if (s.type === 'segment' || s.type === 'vector') return num(g.dist(s.a, s.b));
      if (s.type === 'polygon') return num(s.pts.reduce((sum, p, i) => sum + g.dist(p, s.pts[(i + 1) % s.pts.length]), 0));
      if (s.type === 'circle') return num(2 * Math.PI * s.r);
      if (s.type === 'arc') return num(s.r * Math.abs(s.sweep));
      throw new Error('длина есть у отрезка, вектора, многоугольника, окружности и дуги');
    },
  },
  {
    names: ['Поворот', 'Rotate'],
    group: 'points',
    forms: ['@(объект, угол)', '@(объект, угол, центр)'],
    doc: 'Объект, повёрнутый против часовой стрелки вокруг центра (по умолчанию — начало координат). Угол в градусах пишется со знаком °: 60°.',
    example: 'O = (0, 0)\nA = (3, 0)\nB = Rotate(A, 60°, O)\nSegment(O, A)\nSegment(O, B)',
    run(a, c) {
      args(a, 2, 3);
      const angle = c.num(a[1]);
      const o = a[2] ? c.point(a[2]) : ORIGIN;
      return shape(g.mapShape(c.shape(a[0]), (p) => g.rotate(p, angle, o), false, 1, c.range()));
    },
  },
  {
    names: ['Перенос', 'Translate'],
    group: 'points',
    forms: ['@(объект, вектор)'],
    doc: 'Объект, сдвинутый на вектор.',
    example: 'A = (0, 0)\nB = (2, 1)\nC = (1, 3)\nt = Polygon(A, B, C)\nv = Vector((0, 0), (4, 0))\nTranslate(t, v)',
    run(a, c) {
      args(a, 2);
      const d = c.vec(a[1]);
      return shape(g.mapShape(c.shape(a[0]), (p) => g.add(p, d), false, 1, c.range()));
    },
  },
  {
    names: ['Отражение', 'Reflect'],
    group: 'points',
    forms: ['@(объект, прямая)', '@(объект, точка)'],
    doc: 'Объект, симметричный относительно прямой или точки.',
    example: 'A = (1, 1)\nB = (3, 2)\nm = Line((0, 0), (0, 1))\ns = Segment(A, B)\nReflect(s, m)',
    run(a, c) {
      args(a, 2);
      const s = c.shape(a[0]);
      const m = c.shape(a[1]);
      if (m.type === 'point') {
        const o = m.p;
        return shape(g.mapShape(s, (p) => g.sub(g.mul(o, 2), p), false, 1, c.range()));
      }
      const l = g.lineParams(m);
      const d = g.unit(l.d);
      const mirror = (p: Vec) => {
        const foot = g.add(l.a, g.mul(d, g.dot(g.sub(p, l.a), d)));
        return g.sub(g.mul(foot, 2), p);
      };
      return shape(g.mapShape(s, mirror, true, 1, c.range()));
    },
  },
  {
    names: ['Гомотетия', 'Dilate'],
    group: 'points',
    forms: ['@(объект, k)', '@(объект, k, центр)'],
    doc: 'Объект, растянутый в k раз от центра (по умолчанию — начало координат).',
    example: 'O = (0, 0)\nA = (1, 0)\nB = (0, 1)\nt = Polygon(O, A, B)\nDilate(t, 2, O)',
    run(a, c) {
      args(a, 2, 3);
      const k = c.num(a[1]);
      const o = a[2] ? c.point(a[2]) : ORIGIN;
      return shape(g.mapShape(c.shape(a[0]), (p) => g.add(o, g.mul(g.sub(p, o), k)), false, k, c.range()));
    },
  },

  // ---------------------------------------------------------------- lines
  {
    names: ['Отрезок', 'Segment'],
    group: 'lines',
    forms: ['@(A, B)'],
    doc: 'Отрезок AB.',
    example: 'A = (0, 0)\nB = (4, 1)\nSegment(A, B)',
    run(a, c) {
      args(a, 2);
      return twoPoints('segment', c, a);
    },
  },
  {
    names: ['Прямая', 'Line'],
    group: 'lines',
    forms: ['@(A, B)', '@(A, a)'],
    doc: 'Прямая через точки A и B, или прямая через A параллельно прямой a. Прямая тянется до краёв чертежа.',
    example: 'A = (0, 0)\nB = (3, 1)\na = Line(A, B)\nC = (0, 2)\nLine(C, a)',
    run(a, c) {
      args(a, 2);
      const second = c.val(a[1]);
      if (second.k === 'shape' && second.s.type === 'space' && second.s.of !== 'point' && second.s.of !== 'polygon') {
        const p = c.pointAny(a[0]);
        if (!is3(p)) throw new Error('нельзя смешивать точки листа (x, y) и точки пространства (x, y, z)');
        const [u, v] = second.s.pts;
        return space('line', [p, { x: p.x + v.x - u.x, y: p.y + v.y - u.y, z: p.z + v.z - u.z }]);
      }
      if (second.k === 'shape' && g.isLineLike(second.s)) {
        const p = c.point(a[0]);
        const l = g.lineParams(second.s);
        return shape({ type: 'line', a: p, b: g.add(p, l.d) });
      }
      return twoPoints('line', c, a);
    },
  },
  {
    names: ['Луч', 'Ray'],
    group: 'lines',
    forms: ['@(A, B)'],
    doc: 'Луч из A через B.',
    example: 'A = (0, 0)\nB = (2, 1)\nRay(A, B)',
    run(a, c) {
      args(a, 2);
      return twoPoints('ray', c, a);
    },
  },
  {
    names: ['Вектор', 'Vector'],
    group: 'lines',
    forms: ['@(A, B)', '@(B)'],
    doc: 'Вектор из A в B со стрелкой (или из начала координат в B).',
    example: 'A = (0, 0)\nB = (3, 2)\nv = Vector(A, B)',
    run(a, c) {
      args(a, 1, 2);
      if (a.length === 1) {
        const b = c.pointAny(a[0]);
        return is3(b) ? space('vector', [{ x: 0, y: 0, z: 0 }, b]) : shape({ type: 'vector', a: ORIGIN, b });
      }
      return twoPoints('vector', c, a);
    },
  },
  {
    names: ['Перпендикуляр', 'PerpendicularLine', 'Perpendicular'],
    group: 'lines',
    forms: ['@(A, a)'],
    doc: 'Прямая через A перпендикулярно прямой (отрезку) a.',
    example: 'A = (0, 0)\nB = (5, 1)\nC = (2, 3)\na = Line(A, B)\nPerpendicularLine(C, a)',
    run(a, c) {
      args(a, 2);
      const p = c.point(a[0]);
      const l = g.lineParams(lineOf(c, a[1]));
      return shape({ type: 'line', a: p, b: g.add(p, g.perp(l.d)) });
    },
  },
  {
    names: ['СерединныйПерпендикуляр', 'PerpendicularBisector'],
    group: 'lines',
    forms: ['@(A, B)', '@(отрезок)'],
    doc: 'Серединный перпендикуляр к отрезку AB.',
    example: 'A = (0, 0)\nB = (4, 2)\nSegment(A, B)\nPerpendicularBisector(A, B)',
    run(a, c) {
      args(a, 1, 2);
      let p: Vec;
      let q: Vec;
      if (a.length === 1) {
        const s = lineOf(c, a[0]) as { a: Vec; b: Vec };
        p = s.a;
        q = s.b;
      } else {
        p = c.point(a[0]);
        q = c.point(a[1]);
      }
      const m = g.mid(p, q);
      return shape({ type: 'line', a: m, b: g.add(m, g.perp(g.sub(q, p))) });
    },
  },
  {
    names: ['Биссектриса', 'AngleBisector'],
    group: 'lines',
    forms: ['@(A, B, C)'],
    doc: 'Биссектриса угла ABC (вершина — средняя точка).',
    example: 'A = (4, 0)\nB = (0, 0)\nC = (1, 3)\nSegment(B, A)\nSegment(B, C)\nAngleBisector(A, B, C)',
    run(a, c) {
      args(a, 3);
      const p = c.point(a[0]);
      const v = c.point(a[1]);
      const q = c.point(a[2]);
      const u = g.add(g.unit(g.sub(p, v)), g.unit(g.sub(q, v)));
      const d = g.len(u) < 1e-9 ? g.perp(g.sub(p, v)) : u;
      return shape({ type: 'line', a: v, b: g.add(v, d) });
    },
  },
  {
    names: ['Касательная', 'Tangent'],
    group: 'lines',
    forms: ['@(x₀, f)', '@(A, f)'],
    doc: 'Касательная к графику f в точке x₀ (или в точке A графика).',
    example: 'f(x) = x^2 / 2\nA = (1, f(1))\nTangent(A, f)',
    run(a, c) {
      args(a, 2);
      const first = c.val(a[0]);
      const x0 = first.k === 'shape' && first.s.type === 'point' ? first.s.p.x : c.num(a[0]);
      const f = c.fn(a[1]);
      const h = 1e-5 * (1 + Math.abs(x0));
      const y0 = f(x0);
      const k = (f(x0 + h) - f(x0 - h)) / (2 * h);
      if (!Number.isFinite(y0) || !Number.isFinite(k)) throw new Error('в этой точке у графика нет касательной');
      return shape({ type: 'line', a: { x: x0, y: y0 }, b: { x: x0 + 1, y: y0 + k } });
    },
  },

  // ---------------------------------------------------------------- shapes
  {
    names: ['Окружность', 'Circle'],
    group: 'shapes',
    forms: ['@(O, r)', '@(O, A)', '@(A, B, C)'],
    doc: 'Окружность с центром O и радиусом r, или с центром O через точку A, или через три точки.',
    example: 'O = (0, 0)\nCircle(O, 2)',
    run(a, c) {
      args(a, 2, 3);
      if (a.length === 3) return shape(circumcircle(c.point(a[0]), c.point(a[1]), c.point(a[2])));
      const o = c.point(a[0]);
      const second = c.val(a[1]);
      const r = second.k === 'shape' && second.s.type === 'point' ? g.dist(o, second.s.p) : c.num(a[1]);
      if (!(r > 0)) throw new Error('радиус должен быть больше нуля');
      return shape({ type: 'circle', c: o, r });
    },
  },
  {
    names: ['Дуга', 'CircularArc', 'ДугаОкружности'],
    group: 'shapes',
    forms: ['@(O, A, B)'],
    doc: 'Дуга окружности с центром O от точки A против часовой стрелки до луча OB.',
    example: 'O = (0, 0)\nA = (3, 0)\nB = (0, 3)\nCircularArc(O, A, B)',
    run(a, c) {
      args(a, 3);
      const o = c.point(a[0]);
      const p = c.point(a[1]);
      const q = c.point(a[2]);
      const from = g.angleOf(g.sub(p, o));
      let sweep = g.angleOf(g.sub(q, o)) - from;
      while (sweep <= 0) sweep += 2 * Math.PI;
      return shape({ type: 'arc', c: o, r: g.dist(o, p), from, sweep });
    },
  },
  {
    names: ['Полуокружность', 'Semicircle'],
    group: 'shapes',
    forms: ['@(A, B)'],
    doc: 'Полуокружность на отрезке AB (слева, если идти от A к B).',
    example: 'A = (-2, 0)\nB = (2, 0)\nSegment(A, B)\nSemicircle(A, B)',
    run(a, c) {
      args(a, 2);
      const p = c.point(a[0]);
      const q = c.point(a[1]);
      const m = g.mid(p, q);
      return shape({ type: 'arc', c: m, r: g.dist(p, q) / 2, from: g.angleOf(g.sub(q, m)), sweep: Math.PI });
    },
  },
  {
    names: ['Многоугольник', 'Polygon'],
    group: 'shapes',
    forms: ['@(A, B, C, …)', '@(A, B, n)'],
    doc: 'Многоугольник по вершинам, или правильный n-угольник на стороне AB.',
    example: 'A = (0, 0)\nB = (4, 0)\nC = (1, 3)\nPolygon(A, B, C)',
    run(a, c) {
      if (a.length < 3) throw new Error('у многоугольника хотя бы три вершины');
      if (a.length === 3 && c.val(a[2]).k === 'num') {
        const n = Math.round(c.num(a[2]));
        if (n < 3 || n > 100) throw new Error('правильный многоугольник — от 3 до 100 сторон');
        const pts = [c.point(a[0]), c.point(a[1])];
        for (let i = 2; i < n; i++) {
          const prev = pts[i - 2];
          const cur = pts[i - 1];
          pts.push(g.add(cur, g.rotate(g.sub(cur, prev), (2 * Math.PI) / n)));
        }
        return shape({ type: 'polygon', pts });
      }
      const pts = pointsOf(c, a);
      return 'space' in pts ? space('polygon', pts.space) : shape({ type: 'polygon', pts: pts.flat });
    },
  },
  {
    names: ['Угол', 'Angle'],
    group: 'shapes',
    forms: ['@(A, B, C)'],
    doc: 'Дужка угла ABC с вершиной B и его величина в градусах. Прямой угол отмечается квадратиком.',
    example: 'A = (4, 0)\nB = (0, 0)\nC = (2, 3)\nSegment(B, A)\nSegment(B, C)\nAngle(A, B, C)',
    run(a, c) {
      args(a, 3);
      const p = c.point(a[0]);
      const v = c.point(a[1]);
      const q = c.point(a[2]);
      if (g.dist(p, v) < 1e-12 || g.dist(q, v) < 1e-12) throw new Error('стороны угла не могут начинаться в вершине');
      const from = g.angleOf(g.sub(p, v));
      return shape({ type: 'angle', v, from, sweep: g.turn(from, g.angleOf(g.sub(q, v))) });
    },
  },

  // ---------------------------------------------------------------- graphs
  {
    names: ['Функция', 'Function'],
    group: 'graphs',
    forms: ['@(выражение, a, b)'],
    doc: 'График выражения от x только при x от a до b. Сами графики пишутся как f(x) = … или y = …',
    example: 'f(x) = Function(x^2, -1, 2)',
    run(a, c) {
      args(a, 1, 3);
      const f = c.fn(a[0]);
      if (a.length === 1) return shape({ type: 'graph', f, domain: null });
      const lo = Math.min(c.num(a[1]), c.num(a[2]));
      const hi = Math.max(c.num(a[1]), c.num(a[2]));
      return shape({ type: 'graph', f: (x) => (x < lo || x > hi ? NaN : f(x)), domain: [lo, hi] });
    },
  },
  {
    names: ['Кривая', 'Curve'],
    group: 'graphs',
    forms: ['@(x(t), y(t), t, a, b)'],
    doc: 'Кривая, заданная параметрически: x и y как выражения от t, при t от a до b.',
    example: 'Curve(3cos(t), 2sin(t), t, 0, 2pi)',
    run(a, c) {
      args(a, 5);
      const t = a[2];
      if (t.t !== 'name') throw new Error('третьим аргументом пишется имя параметра, например t');
      const fx = c.fn(a[0], t.name);
      const fy = c.fn(a[1], t.name);
      return shape({ type: 'curve', f: (v) => ({ x: fx(v), y: fy(v) }), t0: c.num(a[3]), t1: c.num(a[4]) });
    },
  },
  {
    names: ['Если', 'If'],
    group: 'graphs',
    forms: ['@(условие, a)', '@(условие, a, b)'],
    doc: 'Значение a, если условие верно, иначе b (или ничего). Для кусочных функций: f(x) = If(x < 0, -x, x^2).',
    example: 'f(x) = If(x < 0, -x, x^2)',
    run(a, c) {
      args(a, 2, 3);
      if (c.bool(a[0])) return c.val(a[1]);
      return a[2] ? c.val(a[2]) : num(NaN);
    },
  },

  // ---------------------------------------------------------------- space
  {
    names: ['Точка', 'Point'],
    group: 'space',
    forms: ['@(x, y, z)', '@(x, y)'],
    doc: 'Точка по координатам; то же, что A = (x, y, z). Точка с тремя координатами — в пространстве: чертёж тогда становится эпюром — приложение само рисует её проекции A₁, A₂, линию связи и ось x₁₂. Отрезки, прямые и многоугольники из таких точек тоже рисуются проекциями.',
    example: 'A = Point(4, 2, 3)',
    run(a, c) {
      args(a, 2, 3);
      const v = a.map((e) => c.num(e));
      return v.length === 3 ? space('point', [{ x: v[0], y: v[1], z: v[2] }]) : point({ x: v[0], y: v[1] });
    },
  },
  {
    names: ['Проекции', 'Projections'],
    group: 'space',
    forms: ['@(1, 2)', '@(1, 2, 3)'],
    doc: 'Какие проекции рисовать на эпюре: 1 — горизонтальная (П₁), 2 — фронтальная (П₂), 3 — профильная (П₃). По умолчанию @(1, 2); с профильной появляются оси z и y и постоянная прямая под 45°.',
    example: 'Projections(1, 2, 3)\nA = (4, 2, 3)',
    view: true,
    run(a, c) {
      if (!a.length) throw new Error('укажите номера плоскостей: 1, 2 или 3');
      const planes = a.map((e) => Math.round(c.num(e)));
      if (planes.some((k) => k < 1 || k > 3)) throw new Error('плоскости проекций — 1, 2 и 3');
      c.scene.view.planes = planes;
      return NONE;
    },
  },
  {
    names: ['ОсьX', 'XAxis'],
    group: 'space',
    forms: ['@("влево")', '@("вправо")'],
    doc: 'Куда смотрит ось x на эпюре. По умолчанию влево от точки O, как в учебниках начертательной геометрии.',
    example: 'XAxis("вправо")\nA = (4, 2, 3)',
    view: true,
    run(a, c) {
      args(a, 1);
      const dir = c.str(a[0]).trim().toLowerCase();
      if (['вправо', 'right', 'направо'].includes(dir)) c.scene.view.xRight = true;
      else if (['влево', 'left', 'налево'].includes(dir)) c.scene.view.xRight = false;
      else throw new Error('ось x направляется "влево" или "вправо"');
      return NONE;
    },
  },

  // ---------------------------------------------------------------- text
  {
    names: ['Текст', 'Text'],
    group: 'text',
    forms: ['@("строка", A)', '@("строка", (x, y))'],
    doc: 'Надпись почерком; её левый нижний угол — в точке. Индексы пишутся как A_1, степени — x^2.',
    example: 'Text("Вершина", (1, 2))',
    run(a, c) {
      args(a, 1, 2);
      return shape({ type: 'text', text: c.str(a[0]), at: a[1] ? c.point(a[1]) : null });
    },
  },
  {
    names: ['Заголовок', 'Title'],
    group: 'text',
    forms: ['@("строка")'],
    doc: 'Заголовок над чертежом.',
    example: 'Title("График функции")\nf(x) = x^2',
    view: true,
    run(a, c) {
      args(a, 1);
      c.scene.title = c.str(a[0]);
      return NONE;
    },
  },
  {
    names: ['Подпись', 'SetCaption'],
    group: 'text',
    forms: ['@(объект, "текст")'],
    doc: 'Своя подпись у объекта вместо его имени. Точки подписаны своими именами и без этого.',
    example: 'f(x) = sin(x)\nSetCaption(f, "y = sin x")',
    run(a, c) {
      args(a, 2);
      const it = c.item(a[0]);
      it.caption = c.str(a[1]);
      it.showLabel = true;
      return NONE;
    },
  },
  {
    names: ['ПоказатьПодпись', 'ShowLabel'],
    group: 'text',
    forms: ['@(объект, true)', '@(объект, false)'],
    doc: 'Показать или спрятать подпись объекта. Без подписи по умолчанию всё, кроме точек и углов.',
    example: 'f(x) = x^2\nShowLabel(f, true)',
    run(a, c) {
      args(a, 1, 2);
      c.item(a[0]).showLabel = a[1] ? c.bool(a[1]) : true;
      return NONE;
    },
  },

  // ---------------------------------------------------------------- style
  {
    names: ['Цвет', 'SetColor'],
    group: 'style',
    forms: ['@(объект, "red")'],
    doc: 'Цвет пера: red, blue, green, orange, purple, brown, gray, pink, cyan, yellow, black (или по-русски: «красный»…).',
    example: 'f(x) = x^2\nSetColor(f, "red")',
    run(a, c) {
      args(a, 2, 4);
      const it = c.item(a[0]);
      if (a.length === 4) {
        const rgb = a.slice(1).map((e) => c.num(e));
        const k = rgb.every((v) => v <= 1) ? 255 : 1;
        it.color = `#${rgb.map((v) => hex(v * k)).join('')}`;
        return NONE;
      }
      const name = c.str(a[1]).trim().toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(name)) it.color = name;
      else if (name in COLORS) it.color = COLORS[name] ?? undefined;
      else throw new Error(`не знаю цвет «${name}»: есть red, blue, green, orange, purple, brown, gray, pink, cyan, yellow, black`);
      return NONE;
    },
  },
  {
    names: ['СтильЛинии', 'SetLineStyle'],
    group: 'style',
    forms: ['@(объект, n)'],
    doc: 'Вид линии: 0 — сплошная, 1 — штриховая (невидимые линии), 2 — мелкий штрих, 3 — точки, 4 — штрихпунктир (оси).',
    example: 'A = (0, 0)\nB = (4, 2)\ns = Segment(A, B)\nSetLineStyle(s, 1)',
    run(a, c) {
      args(a, 2);
      const n = Math.round(c.num(a[1]));
      if (n < 0 || n > 4) throw new Error('стиль линии — число от 0 до 4');
      c.item(a[0]).lineStyle = n;
      return NONE;
    },
  },
  {
    names: ['Толщина', 'SetLineThickness'],
    group: 'style',
    forms: ['@(объект, n)'],
    doc: 'Толщина линии от 1 до 13; обычная — 5, тонкая (линии связи, построения) — 2.',
    example: 'A = (0, 0)\nB = (4, 2)\ns = Segment(A, B)\nSetLineThickness(s, 2)',
    run(a, c) {
      args(a, 2);
      c.item(a[0]).thickness = Math.min(Math.max(c.num(a[1]), 1), 13);
      return NONE;
    },
  },
  {
    names: ['Заливка', 'SetFilling'],
    group: 'style',
    forms: ['@(объект, доля)'],
    doc: 'Штриховка внутри многоугольника или окружности: 0 — нет, 1 — самая густая.',
    example: 'A = (0, 0)\nB = (4, 0)\nC = (1, 3)\nt = Polygon(A, B, C)\nSetFilling(t, 0.3)',
    run(a, c) {
      args(a, 2);
      c.item(a[0]).filling = Math.min(Math.max(c.num(a[1]), 0), 1);
      return NONE;
    },
  },
  {
    names: ['Скрыть', 'Hide', 'SetVisibleInView'],
    group: 'style',
    forms: ['@(объект)'],
    doc: 'Не рисовать объект, но пользоваться им в построениях (вспомогательные точки и прямые). Понимается и SetVisibleInView(объект, 1, false).',
    example: 'A = (0, 0)\nB = (4, 0)\na = Line(A, B)\nHide(a)\nC = (2, 3)\nH = Intersect(PerpendicularLine(C, a), a)\nSegment(C, H)',
    run(a, c) {
      args(a, 1, 3);
      c.item(a[0]).hidden = a.length === 3 ? !c.bool(a[2]) : true;
      return NONE;
    },
  },

  // ---------------------------------------------------------------- view
  {
    names: ['Окно', 'ZoomIn'],
    group: 'view',
    forms: ['@(xmin, ymin, xmax, ymax)', '@(xmin, xmax)'],
    doc: 'Какую часть плоскости показать. Без этой команды окно подбирается само, чтобы всё было видно.',
    example: 'ZoomIn(-2pi, -1.5, 2pi, 1.5)\nf(x) = sin(x)',
    view: true,
    run(a, c) {
      args(a, 2, 4);
      const [x0, x1] = a.length === 4 ? [a[0], a[2]] : [a[0], a[1]];
      const xr: [number, number] = [c.num(x0), c.num(x1)];
      if (!(xr[0] < xr[1])) throw new Error('xmin должен быть меньше xmax');
      c.scene.view.x = xr;
      c.scene.view.xPi = c.usesPi(x0) || c.usesPi(x1);
      if (a.length === 4) {
        const yr: [number, number] = [c.num(a[1]), c.num(a[3])];
        if (!(yr[0] < yr[1])) throw new Error('ymin должен быть меньше ymax');
        c.scene.view.y = yr;
        c.scene.view.yPi = c.usesPi(a[1]) || c.usesPi(a[3]);
      }
      return NONE;
    },
  },
  {
    names: ['Оси', 'ShowAxes'],
    group: 'view',
    forms: ['@(true)', '@(false)'],
    doc: 'Показать или убрать оси координат. По умолчанию оси есть, только когда на чертеже есть графики.',
    example: 'ShowAxes(true)\nA = (2, 1)',
    view: true,
    run(a, c) {
      c.scene.view.axes = a.length ? c.bool(a[a.length - 1]) : true;
      return NONE;
    },
  },
  {
    names: ['Сетка', 'ShowGrid'],
    group: 'view',
    forms: ['@(true)', '@(false)'],
    doc: 'Показать или убрать сетку.',
    example: 'ShowGrid(true)\nf(x) = x / 2',
    view: true,
    run(a, c) {
      c.scene.view.grid = a.length ? c.bool(a[a.length - 1]) : true;
      return NONE;
    },
  },
  {
    names: ['Пропорции', 'SetAxesRatio'],
    group: 'view',
    forms: ['@(1, 1)', '@(a, b)'],
    doc: 'Масштаб осей: a единиц по x той же длины, что b единиц по y. @(1, 1) — одинаковый масштаб (так уже есть, если на чертеже нет графиков или есть окружности).',
    example: 'SetAxesRatio(1, 1)\nf(x) = x^2 / 4',
    view: true,
    run(a, c) {
      args(a, 2);
      const p = c.num(a[0]);
      const q = c.num(a[1]);
      if (!(p > 0 && q > 0)) throw new Error('пропорции — два положительных числа');
      c.scene.view.ratio = p / q;
      return NONE;
    },
  },
];

/** Numbers and formulas: shown in the help and in the instructions. */
export const FORMULA_HELP: { code: string; doc: string }[] = [
  { code: '+ − * / ^ ( )', doc: 'действия; умножение можно не писать: 2x, 3sin(x), 2(x + 1)' },
  { code: 'pi, e', doc: 'числа π и e; π можно писать и значком' },
  { code: '30°', doc: 'градусы; без знака ° углы в радианах' },
  { code: 'sqrt(x), abs(x), |x|', doc: 'корень и модуль' },
  { code: 'sin cos tan cot', doc: 'тригонометрия (можно tg, ctg), аргумент в радианах' },
  { code: 'asin acos atan', doc: 'обратные (можно arcsin, arccos, arctg)' },
  { code: 'ln(x), lg(x), log(b, x), exp(x)', doc: 'логарифмы: натуральный, десятичный, по основанию b; log(x) — натуральный, как в GeoGebra' },
  { code: 'floor ceil round sgn min max', doc: 'округления, знак, минимум и максимум' },
  { code: 'x(A), y(A)', doc: 'координаты точки A' },
  { code: 'f(2)', doc: 'значение заданной функции' },
  { code: 'A + (1, 0), 2v', doc: 'точки и векторы можно складывать и умножать на число' },
];

/** GeoGebra commands that only matter on a screen: skipped without complaint. */
export const IGNORED = [
  'SetPointStyle',
  'SetPointSize',
  'SetDecoration',
  'SetLabelMode',
  'SetLayer',
  'SetFixed',
  'SetTooltipMode',
  'SetDynamicColor',
  'SetLevelOfDetail',
  'SetTrace',
  'SetBackgroundColor',
  'SetPerspective',
  'SetSpinSpeed',
  'SetTooltip',
  'ShowLayer',
  'HideLayer',
  'StartAnimation',
  'SelectObjects',
  'UpdateConstruction',
  'CenterView',
];
const ignored = new Set(IGNORED.map((n) => n.toLowerCase()));

export function isIgnored(name: string): boolean {
  return ignored.has(name.toLowerCase());
}

const byName = new Map<string, Command>();
for (const cmd of COMMANDS) for (const n of cmd.names) byName.set(n.toLowerCase().replace(/ё/g, 'е'), cmd);

export function findCommand(name: string): Command | undefined {
  return byName.get(name.toLowerCase().replace(/ё/g, 'е'));
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** «Segmnt» → «Segment»: the closest known command, if any is close. */
export function suggestCommand(name: string): string | null {
  const key = name.toLowerCase();
  let best: string | null = null;
  let bestD = Infinity;
  for (const cmd of COMMANDS) {
    for (const n of cmd.names) {
      const d = distance(key, n.toLowerCase());
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
  }
  return bestD <= Math.max(2, Math.floor(key.length / 4)) ? best : null;
}

/** The example or any code with command names in one language: «ru» or «en». */
export function localizeCode(code: string, lang: 'ru' | 'en'): string {
  return code.replace(/[\p{L}]+(?=\()/gu, (word) => {
    const cmd = findCommand(word);
    if (!cmd) return word;
    return lang === 'ru' ? cmd.names[0] : cmd.names[1];
  });
}
