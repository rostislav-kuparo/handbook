// Runs a drawing's lines top to bottom and collects what to draw. A line
// with a mistake is reported and skipped; the rest of the drawing still works.
import { findCommand, isIgnored, suggestCommand } from './commands';
import * as g from './geometry';
import { projectSpace } from './epure';
import { canon, formatNumber, parseLine, type BinOp, type CmpOp, type Expr, type Statement } from './lang';
import type { Ctx, Item, Scene, Shape, SpaceKind, Val, Vec, Vec3 } from './types';

/** x (or t) used where it has no value: such a definition is a function. */
class FreeVariable extends Error {
  constructor(readonly variable: string) {
    super(`«${variable}» здесь не задано`);
  }
}

interface Entry {
  val: Val;
  item?: Item;
}

interface Env {
  scope: Map<string, Entry>;
  /** Bound variables: x while a graph is computed, t in a curve. */
  vars: Map<string, number>;
  scene: Scene;
  ctx?: Ctx;
}

const num = (v: number): Val => ({ k: 'num', v });
const bool = (v: boolean): Val => ({ k: 'bool', v });
const point = (p: Vec): Val => ({ k: 'shape', s: { type: 'point', p } });
const point3 = (p: Vec3): Val => ({ k: 'shape', s: { type: 'space', of: 'point', pts: [p] } });
const len3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const CONSTANTS: Record<string, Val> = {
  pi: num(Math.PI),
  e: num(Math.E),
  inf: num(Infinity),
  infinity: num(Infinity),
  true: bool(true),
  false: bool(false),
  да: bool(true),
  нет: bool(false),
  истина: bool(true),
  ложь: bool(false),
};

const MATH: Record<string, (...v: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  tg: Math.tan,
  cot: (v) => 1 / Math.tan(v),
  ctg: (v) => 1 / Math.tan(v),
  sec: (v) => 1 / Math.cos(v),
  csc: (v) => 1 / Math.sin(v),
  asin: Math.asin,
  arcsin: Math.asin,
  acos: Math.acos,
  arccos: Math.acos,
  atan: Math.atan,
  arctan: Math.atan,
  arctg: Math.atan,
  acot: (v) => Math.PI / 2 - Math.atan(v),
  arcctg: (v) => Math.PI / 2 - Math.atan(v),
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sh: Math.sinh,
  ch: Math.cosh,
  th: Math.tanh,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  sgn: Math.sign,
  sign: Math.sign,
  exp: Math.exp,
  ln: Math.log,
  lg: Math.log10,
  ld: Math.log2,
  // As in GeoGebra: log(x) is natural, log(b, x) is to base b.
  log: (a, b) => (b === undefined ? Math.log(a) : Math.log(b) / Math.log(a)),
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: Math.min,
  max: Math.max,
};
const MANY_ARGS = new Set(['log', 'min', 'max']);

/** GeoGebra 3D commands for planes and solids: named in the error instead of «unknown command». */
const SOLIDS = new Set(
  [
    'Plane', 'PerpendicularPlane', 'PlaneBisector', 'Sphere', 'Prism', 'Pyramid', 'Cube', 'Cone', 'Cylinder',
    'Tetrahedron', 'Octahedron', 'Dodecahedron', 'Icosahedron', 'Net', 'Surface',
    'Плоскость', 'Сфера', 'Призма', 'Пирамида', 'Куб', 'Конус', 'Цилиндр',
  ].map((n) => n.toLowerCase()),
);

function describe(v: Val): string {
  if (v.k === 'num') return 'число';
  if (v.k === 'str') return 'текст';
  if (v.k === 'bool') return 'да/нет';
  if (v.k === 'none') return 'команда без значения';
  if (v.s.type === 'space') {
    const space: Record<SpaceKind, string> = {
      point: 'точка в пространстве',
      segment: 'отрезок в пространстве',
      ray: 'луч в пространстве',
      line: 'прямая в пространстве',
      vector: 'вектор в пространстве',
      polygon: 'многоугольник в пространстве',
    };
    return space[v.s.of];
  }
  const names: Record<Shape['type'], string> = {
    point: 'точка',
    segment: 'отрезок',
    ray: 'луч',
    line: 'прямая',
    vector: 'вектор',
    circle: 'окружность',
    arc: 'дуга',
    polygon: 'многоугольник',
    angle: 'угол',
    graph: 'график',
    curve: 'кривая',
    text: 'надпись',
    space: 'фигура в пространстве',
  };
  return names[v.s.type];
}

function toNum(v: Val): number {
  if (v.k === 'num') return v.v;
  if (v.k === 'bool') return v.v ? 1 : 0;
  if (v.k === 'shape') {
    // As in GeoGebra: a segment counts as its length, an angle as its size.
    if (v.s.type === 'segment' || v.s.type === 'vector') return g.dist(v.s.a, v.s.b);
    if (v.s.type === 'angle') return Math.abs(v.s.sweep);
    // The true length of a segment in space.
    if (v.s.type === 'space' && (v.s.of === 'segment' || v.s.of === 'vector')) return len3(v.s.pts[0], v.s.pts[1]);
  }
  throw new Error(`здесь нужно число, а не ${describe(v)}`);
}

/** Points and vectors as coordinates; anything else is not one. */
function vecOf(v: Val): Vec | null {
  if (v.k !== 'shape') return null;
  if (v.s.type === 'point') return v.s.p;
  if (v.s.type === 'vector') return g.sub(v.s.b, v.s.a);
  return null;
}

/** Points and vectors in space as coordinates. */
function vec3Of(v: Val): Vec3 | null {
  if (v.k !== 'shape' || v.s.type !== 'space') return null;
  const [a, b] = v.s.pts;
  if (v.s.of === 'point') return a;
  if (v.s.of === 'vector') return { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  return null;
}

const isVector3 = (v: Val) => v.k === 'shape' && v.s.type === 'space' && v.s.of === 'vector';
const like3 = (v: Val, p: Vec3): Val =>
  isVector3(v) ? { k: 'shape', s: { type: 'space', of: 'vector', pts: [{ x: 0, y: 0, z: 0 }, p] } } : point3(p);

function arithmetic3(op: BinOp, a: Val, b: Val): Val {
  const pa = vec3Of(a);
  const pb = vec3Of(b);
  if ((pa && vecOf(b)) || (pb && vecOf(a))) throw new Error('точку пространства (x, y, z) нельзя смешивать с точкой листа (x, y)');
  const scale = (p: Vec3, k: number): Vec3 => ({ x: p.x * k, y: p.y * k, z: p.z * k });
  if (op === '+' || op === '-') {
    if (!pa || !pb) throw new Error('к точке можно прибавить только точку или вектор');
    const k = op === '+' ? 1 : -1;
    const r = { x: pa.x + k * pb.x, y: pa.y + k * pb.y, z: pa.z + k * pb.z };
    return isVector3(a) && isVector3(b) ? like3(a, r) : point3(r);
  }
  if (op === '*') {
    if (pa && pb) return num(pa.x * pb.x + pa.y * pb.y + pa.z * pb.z);
    if (pa) return like3(a, scale(pa, toNum(b)));
    return like3(b, scale(pb!, toNum(a)));
  }
  if (op === '/' && pa && !pb) return like3(a, scale(pa, 1 / toNum(b)));
  throw new Error('так точки и векторы не считаются');
}

/** The result keeps the kind of its operand: a point stays a point, a vector a vector. */
function like(v: Val, p: Vec): Val {
  return v.k === 'shape' && v.s.type === 'vector' ? { k: 'shape', s: { type: 'vector', a: { x: 0, y: 0 }, b: p } } : point(p);
}

function arithmetic(op: BinOp, a: Val, b: Val): Val {
  if (vec3Of(a) || vec3Of(b)) return arithmetic3(op, a, b);
  const pa = vecOf(a);
  const pb = vecOf(b);
  if (!pa && !pb) {
    const x = toNum(a);
    const y = toNum(b);
    switch (op) {
      case '+':
        return num(x + y);
      case '-':
        return num(x - y);
      case '*':
        return num(x * y);
      case '/':
        return num(x / y);
      case '^':
        return num(Math.pow(x, y));
    }
  }
  if (op === '+' || op === '-') {
    if (!pa || !pb) throw new Error('к точке можно прибавить только точку или вектор');
    const r = op === '+' ? g.add(pa, pb) : g.sub(pa, pb);
    return vecOf(a) && a.k === 'shape' && a.s.type === 'vector' && b.k === 'shape' && b.s.type === 'vector' ? like(a, r) : point(r);
  }
  if (op === '*') {
    if (pa && pb) return num(g.dot(pa, pb));
    if (pa) return like(a, g.mul(pa, toNum(b)));
    return like(b, g.mul(pb!, toNum(a)));
  }
  if (op === '/' && pa && !pb) return like(a, g.mul(pa, 1 / toNum(b)));
  throw new Error('так точки и векторы не считаются');
}

function compare(op: CmpOp, a: number, b: number): boolean {
  switch (op) {
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    case '>=':
      return a >= b;
    case '==':
      return Math.abs(a - b) < 1e-9;
    case '!=':
      return Math.abs(a - b) >= 1e-9;
  }
}

function lookup(name: string, env: Env): Val {
  const key = canon(name);
  const bound = env.vars.get(key);
  if (bound !== undefined) return num(bound);
  const entry = env.scope.get(key);
  if (entry) return entry.val;
  const c = CONSTANTS[key] ?? (key.length > 1 ? CONSTANTS[key.toLowerCase()] : undefined);
  if (c) return c;
  if (key === 'x' || key === 'y' || key === 't') throw new FreeVariable(key);
  if (findCommand(name)) throw new Error(`«${name}» — это команда, после неё нужны скобки: ${name}(…)`);
  throw new Error(`«${name}» ещё не задано (имена задаются выше, чем используются)`);
}

function call(e: Extract<Expr, { t: 'call' }>, env: Env): Val {
  const key = canon(e.name);
  if (!env.vars.has(key)) {
    // A function of the drawing: f(2)
    const entry = env.scope.get(key);
    if (entry?.val.k === 'shape' && entry.val.s.type === 'graph') {
      if (e.args.length !== 1) throw new Error(`${e.name}(…) берёт одно число`);
      return num(entry.val.s.f(toNum(evalExpr(e.args[0], env))));
    }
  }
  if ((key === 'x' || key === 'y' || key === 'z') && e.args.length === 1) {
    const a = evalExpr(e.args[0], env);
    const s3 = vec3Of(a);
    if (s3) return num(s3[key]);
    if (key === 'z') throw new Error('z есть только у точки в пространстве (x, y, z)');
    const p = vecOf(a);
    if (p) return num(key === 'x' ? p.x : p.y);
    // x(x + 1) is x·(x + 1)
    return arithmetic('*', lookup(e.name, env), a);
  }
  const lower = e.name.toLowerCase();
  const m = MATH[lower];
  if (m) {
    if (e.args.length === 0 || (e.args.length > 1 && !MANY_ARGS.has(lower))) throw new Error(`${e.name} берёт одно число`);
    return num(m(...e.args.map((a) => toNum(evalExpr(a, env)))));
  }
  const cmd = findCommand(e.name);
  if (cmd) return cmd.run(e.args, ctxOf(env));
  if (isIgnored(e.name)) return { k: 'none' };
  if (SOLIDS.has(lower)) {
    throw new Error(`«${e.name}» — команда GeoGebra 3D: плоскости и тела на эпюре пока не рисуются. Плоскость задайте треугольником: Polygon(A, B, C)`);
  }
  const near = suggestCommand(e.name);
  throw new Error(`не знаю команду «${e.name}»${near ? `. Может быть, ${near}?` : ''}`);
}

function evalExpr(e: Expr, env: Env): Val {
  switch (e.t) {
    case 'num':
      return num(e.v);
    case 'str':
      return { k: 'str', v: e.v };
    case 'name':
      return lookup(e.name, env);
    case 'tuple': {
      const c = e.items.map((it) => toNum(evalExpr(it, env)));
      if (c.length === 2) return point({ x: c[0], y: c[1] });
      if (c.length === 3) return point3({ x: c[0], y: c[1], z: c[2] });
      throw new Error('у точки две координаты (x, y) на листе или три (x, y, z) в пространстве');
    }
    case 'neg': {
      const a = evalExpr(e.a, env);
      const s3 = vec3Of(a);
      if (s3) return like3(a, { x: -s3.x, y: -s3.y, z: -s3.z });
      const p = vecOf(a);
      return p ? like(a, g.mul(p, -1)) : num(-toNum(a));
    }
    case 'abs': {
      const a = evalExpr(e.a, env);
      const s3 = vec3Of(a);
      if (s3) return num(Math.hypot(s3.x, s3.y, s3.z));
      const p = vecOf(a);
      return num(p ? g.len(p) : Math.abs(toNum(a)));
    }
    case 'bin':
      return arithmetic(e.op, evalExpr(e.a, env), evalExpr(e.b, env));
    case 'cmp': {
      const vals = e.items.map((it) => toNum(evalExpr(it, env)));
      return bool(e.ops.every((op, i) => compare(op, vals[i], vals[i + 1])));
    }
    case 'call':
      return call(e, env);
  }
}

/** A function of one variable; a function's name stands for the function itself. */
function compileFn(e: Expr, param: string, env: Env): (x: number) => number {
  if (e.t === 'name' && !env.vars.has(canon(e.name))) {
    const entry = env.scope.get(canon(e.name));
    if (entry?.val.k === 'shape' && entry.val.s.type === 'graph') return entry.val.s.f;
  }
  const key = canon(param);
  // Later lines may reuse names: the function keeps the ones it was made with.
  const inner: Env = { scope: new Map(env.scope), vars: new Map(env.vars), scene: env.scene };
  const run = (x: number) => {
    inner.vars.set(key, x);
    return toNum(evalExpr(e, inner));
  };
  // Unknown names or a point where a number belongs show up at any x: report them now.
  run(0.5);
  return (x) => {
    try {
      return run(x);
    } catch {
      return NaN;
    }
  };
}

function usesPi(e: Expr): boolean {
  switch (e.t) {
    case 'name':
      return canon(e.name).toLowerCase() === 'pi';
    case 'tuple':
      return e.items.some(usesPi);
    case 'call':
      return e.args.some(usesPi);
    case 'bin':
      return usesPi(e.a) || usesPi(e.b);
    case 'neg':
    case 'abs':
      return usesPi(e.a);
    case 'cmp':
      return e.items.some(usesPi);
    default:
      return false;
  }
}

function ctxOf(env: Env): Ctx {
  if (env.ctx) return env.ctx;
  const val = (e: Expr) => evalExpr(e, env);
  const ctx: Ctx = {
    val,
    num: (e) => toNum(val(e)),
    point: (e) => {
      const v = val(e);
      if (v.k === 'shape' && v.s.type === 'point') return v.s.p;
      if (vec3Of(v)) throw new Error('эта команда работает с точками на листе (x, y), а не в пространстве');
      throw new Error(`здесь нужна точка, а не ${describe(v)}`);
    },
    pointAny: (e) => {
      const v = val(e);
      if (v.k === 'shape' && v.s.type === 'point') return v.s.p;
      if (v.k === 'shape' && v.s.type === 'space' && v.s.of === 'point') return v.s.pts[0];
      throw new Error(`здесь нужна точка, а не ${describe(v)}`);
    },
    vec: (e) => {
      const p = vecOf(val(e));
      if (!p) throw new Error('здесь нужен вектор или точка');
      return p;
    },
    shape: (e) => {
      const v = val(e);
      if (v.k === 'shape') return v.s;
      throw new Error(`здесь нужна фигура, а не ${describe(v)}`);
    },
    fn: (e, param = 'x') => compileFn(e, param, env),
    str: (e) => {
      const v = val(e);
      if (v.k === 'str') return v.v;
      if (v.k === 'num') return formatNumber(v.v);
      throw new Error('здесь нужен текст в кавычках');
    },
    bool: (e) => {
      const v = val(e);
      if (v.k === 'bool') return v.v;
      if (v.k === 'num') return v.v !== 0 && !Number.isNaN(v.v);
      throw new Error('здесь нужно true или false');
    },
    item: (e) => {
      if (e.t !== 'name') throw new Error('здесь нужно имя объекта');
      const entry = env.scope.get(canon(e.name));
      if (!entry) throw new Error(`«${e.name}» ещё не задано`);
      if (!entry.item) throw new Error(`«${e.name}» — ${describe(entry.val)}, его не видно на чертеже`);
      return entry.item;
    },
    usesPi,
    scene: env.scene,
    range: () => env.scene.view.x ?? [-10, 10],
  };
  env.ctx = ctx;
  return ctx;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** f(x) = …: a graph; Function(…, a, b) keeps its own domain. */
function graphOf(expr: Expr, param: string, env: Env): Shape {
  if (expr.t === 'call' && findCommand(expr.name)?.names[1] === 'Function') {
    const v = evalExpr(expr, env);
    if (v.k === 'shape' && v.s.type === 'graph') return v.s;
  }
  return { type: 'graph', f: compileFn(expr, param, env), domain: null };
}

type AddItem = (shape: Shape, name?: string) => Item;

function define(name: string, val: Val, env: Env, add: AddItem) {
  const key = canon(name);
  if (key === 'x' || key === 'y') throw new Error('имена x и y заняты под оси');
  const item = val.k === 'shape' ? add(val.s, name) : undefined;
  env.scope.set(key, { val, item });
}

function exec(stmt: Statement, env: Env, add: AddItem) {
  switch (stmt.kind) {
    case 'function':
      define(stmt.name, { k: 'shape', s: graphOf(stmt.expr, stmt.param, env) }, env, add);
      return;
    case 'graph': {
      const s = graphOf(stmt.expr, 'x', env);
      if (stmt.name) define(stmt.name, { k: 'shape', s }, env, add);
      else add(s);
      return;
    }
    case 'vline': {
      const c = toNum(evalExpr(stmt.expr, env));
      const s: Shape = { type: 'line', a: { x: c, y: 0 }, b: { x: c, y: 1 } };
      if (stmt.name) define(stmt.name, { k: 'shape', s }, env, add);
      else add(s);
      return;
    }
    case 'define': {
      let val: Val;
      try {
        val = evalExpr(stmt.expr, env);
      } catch (err) {
        // g = x^2 is a function, as in GeoGebra.
        if (!(err instanceof FreeVariable) || err.variable !== 'x') throw err;
        val = { k: 'shape', s: graphOf(stmt.expr, 'x', env) };
      }
      define(stmt.name, val, env, add);
      return;
    }
    case 'expr': {
      const val = evalExpr(stmt.expr, env);
      if (val.k === 'shape') add(val.s);
      return;
    }
  }
}

function run(code: string): Scene {
  const scene: Scene = { items: [], view: {}, errors: [] };
  const env: Env = { scope: new Map(), vars: new Map(), scene };
  const lines: { line: number; text: string; stmt: Statement }[] = [];
  code.split(/\r?\n/).forEach((text, i) => {
    try {
      const stmt = parseLine(text);
      if (stmt) lines.push({ line: i + 1, text: text.trim(), stmt });
    } catch (err) {
      // «Here is the drawing:» — a neural net's words around the commands.
      const prose = !/[=(]/.test(text) && /\p{L}{2,}\s+\p{L}{2,}/u.test(text);
      scene.errors.push({ line: i + 1, message: prose ? 'это не команда, а пояснение — строку можно удалить' : (err as Error).message });
    }
  });
  // The window comes first: it decides where graphs are intersected.
  const isView = (s: Statement) => s.kind === 'expr' && s.expr.t === 'call' && !!findCommand(s.expr.name)?.view;
  for (const l of [...lines.filter((l) => isView(l.stmt)), ...lines.filter((l) => !isView(l.stmt))]) {
    let made = 0;
    const add: AddItem = (shape, name) => {
      const item: Item = {
        shape,
        name: name && canon(name),
        label: name,
        showLabel: (!!name && (shape.type === 'point' || (shape.type === 'space' && shape.of === 'point'))) || shape.type === 'angle',
        lineStyle: 0,
        thickness: 5,
        filling: 0,
        hidden: false,
        line: l.line,
        seed: hash(`${l.text}#${made++}`),
      };
      scene.items.push(item);
      return item;
    };
    try {
      exec(l.stmt, env, add);
    } catch (err) {
      scene.errors.push({ line: l.line, message: (err as Error).message });
    }
  }
  scene.errors.sort((a, b) => a.line - b.line);
  // Figures in space are drawn as an epure: their projections, linking lines, the axis.
  projectSpace(scene);
  return scene;
}

const cache = new Map<string, Scene>();

/** What the text of a drawing describes (cached: the same text is the same scene). */
export function compileSketch(code: string): Scene {
  const hit = cache.get(code);
  if (hit) return hit;
  const scene = run(code);
  cache.set(code, scene);
  if (cache.size > 40) cache.delete(cache.keys().next().value!);
  return scene;
}
