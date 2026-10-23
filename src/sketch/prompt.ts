// Instructions for neural nets: the command list, the rules and examples,
// built from the same registry the app runs, so a model can only be told
// about commands that really work.
import { COMMANDS, FORMULA_HELP, GROUPS } from './commands';

export interface SketchExample {
  title: string;
  /** What one would ask for. */
  task: string;
  /** The answer, with English command names. */
  code: string;
}

export const EXAMPLES: SketchExample[] = [
  {
    title: 'Графики функций',
    task: 'графики синуса и косинуса от −2π до 2π, подписать оба',
    code: `Title("Графики функций")
ZoomIn(-2pi, -1.5, 2pi, 1.5)
f(x) = sin(x)
g(x) = cos(x)
SetColor(g, "red")
SetCaption(f, "y = sin x")
SetCaption(g, "y = cos x")`,
  },
  {
    title: 'Треугольник с высотой',
    task: 'треугольник ABC, высота CH пунктиром, прямой угол при H отмечен',
    code: `A = (0, 0)
B = (6, 0)
C = (2, 4)
Polygon(A, B, C)
H = Intersect(PerpendicularLine(C, Line(A, B)), Line(A, B))
h = Segment(C, H)
SetLineStyle(h, 1)
Angle(B, H, C)`,
  },
  {
    title: 'Точки пересечения',
    task: 'парабола y = x² − 2, прямая y = x и точки их пересечения A и B',
    code: `f(x) = x^2 - 2
g(x) = x
SetCaption(f, "y = x^2 - 2")
SetCaption(g, "y = x")
A = Intersect(f, g, 1)
B = Intersect(f, g, 2)`,
  },
  {
    title: 'Эпюр плоскости',
    task: 'эпюр плоскости, заданной треугольником ABC: A(2, 1, 3), B(5, 3, 1), C(1, 4, 4)',
    code: `Title("Плоскость ABC")
A = (2, 1, 3)
B = (5, 3, 1)
C = (1, 4, 4)
Polygon(A, B, C)`,
  },
  {
    title: 'Эпюр отрезка в трёх проекциях',
    task: 'отрезок AB в трёх проекциях и его середина M: A(6, 2, 4), B(2, 4, 1)',
    code: `Projections(1, 2, 3)
A = (6, 2, 4)
B = (2, 4, 1)
Segment(A, B)
M = Midpoint(A, B)`,
  },
];

const RULES = [
  'Ответь одним блоком кода: команды, по одной на строке. Никаких пояснений ни до, ни после блока.',
  'Пиши только команды из списка ниже, с английскими именами, как в GeoGebra. Никакого HTML, SVG, TikZ, Python и команд, которых нет в списке.',
  'Сначала задай точки и функции, потом то, что из них строится: имя можно использовать только ниже строки, где оно задано. Каждое имя задаётся один раз.',
  'Точки называй заглавными латинскими буквами, при необходимости с индексом или штрихом: A, B, A_1, A_2, A\'. Прямые, отрезки и функции — строчными: a, s, f, g. Имена x и y заняты под оси.',
  'Дробные числа — через точку: 2.5. Углы в градусах — со знаком °: 30°. Число π — pi. Знак умножения можно не писать: 2x.',
  'Не задавай цвет, толщину, стиль линий и окно (ZoomIn), если об этом не просят и без этого можно обойтись: приложение само оформит чертёж и подберёт окно. Исключения: невидимые и вспомогательные линии — SetLineStyle(…, 1); линии связи и построения — SetLineThickness(…, 2); несколько графиков на одном чертеже — разные SetColor и SetCaption, чтобы их различать.',
  'Вспомогательные построения, которые не нужно рисовать, вкладывай прямо в команду — Intersect(PerpendicularLine(C, a), a) — или прячь через Hide(…).',
  'Точки подписываются своими именами сами. SetCaption — только если нужна другая подпись. Подписи и тексты — по-русски, в кавычках; индексы и степени в них: "A_1", "x^2".',
  'Задачи в пространстве (начертательная геометрия, эпюр) задавай точками с тремя координатами — A = (x, y, z) — и строй из них Segment, Line, Ray, Polygon, Midpoint. Приложение само нарисует эпюр Монжа: проекции A₁ и A₂, линии связи и ось x₁₂. Не вычисляй проекции сам (никаких A1 = (x, y, 0) или A_2 = (x, z)), не рисуй ось и линии связи. Называй точки пространства без индексов проекций — A, B, C: индексы 1, 2, 3 приложение добавит само. Профильная проекция — Projections(1, 2, 3).',
  'Команд GeoGebra 3D для плоскостей и тел (Plane, Sphere, Prism, Pyramid…) нет: плоскость задавай треугольником Polygon(A, B, C).',
  'Комментарии, если нужны, — после знака #.',
];

/** Plain-text instructions for a chat with a neural net, optionally with the task. */
export function sketchPrompt(task = ''): string {
  const out: string[] = [];
  out.push(
    'Ты рисуешь чертежи и графики для приложения Handbook. Приложение само рисует их от руки, почерком пользователя. ' +
      'Поэтому от тебя нужен только список команд в стиле GeoGebra — что нарисовать, а не как.',
    '',
    'ПРАВИЛА ОТВЕТА',
    ...RULES.map((r, i) => `${i + 1}. ${r}`),
    '',
    'ЗАПИСЬ',
    'A = (2, 3) — точка; f(x) = x^2 - 1 или y = 2x + 1 — график; x = 3 — вертикальная прямая; r = 2 — число;',
    's = Segment(A, B) — объект с именем s, к нему можно обращаться дальше; Segment(A, B) — без имени;',
    'A = (x, y, z) — точка в пространстве: чертёж становится эпюром (x — вдоль оси x₁₂, y — к наблюдателю, z — вверх).',
    '',
    'КОМАНДЫ',
  );
  for (const group of GROUPS) {
    out.push(`# ${group.name}`);
    for (const cmd of COMMANDS.filter((c) => c.group === group.id)) {
      const name = cmd.names[1];
      out.push(`${cmd.forms.map((f) => f.replace('@', name)).join(' | ')} — ${cmd.doc.replace(/@/g, name)}`);
    }
  }
  out.push('', 'ЧИСЛА И ФОРМУЛЫ');
  for (const f of FORMULA_HELP) out.push(`${f.code} — ${f.doc}`);
  out.push('', 'ПРИМЕРЫ');
  for (const ex of EXAMPLES) out.push('', `Задача: ${ex.task}`, '```', ex.code, '```');
  out.push('', 'ЗАДАЧА', task.trim() || '(опишите здесь, что нарисовать)');
  return out.join('\n');
}
