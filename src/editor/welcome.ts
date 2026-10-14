import { TEMPLATES } from '../blocks/templates';
import type { DocContent } from '../model/types';

const p = (text: string) => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' });

const shapes = TEMPLATES.find((t) => t.id === 'shapes')!;

export function welcomeContent(): DocContent {
  return {
    type: 'doc',
    content: [
      p('Привет! Это Handbook — тетрадь, которая пишет вашим почерком.'),
      p('1. Откройте вкладку «Почерк» и напишите каждую букву несколько раз. Чем больше вариантов, тем живее текст: движок смешивает их и придумывает новые.'),
      p('2. Возвращайтесь сюда и печатайте. Буквы, которых ещё нет, подчёркнуты — кликните по такой букве и допишите её прямо здесь.'),
      p('3. Кнопка «Отрендерить» показывает текст так, будто он написан ручкой: каждая буква уникальна, строки чуть плывут. Оттуда же печать в PDF.'),
      p('Ниже — живой HTML-блок. Фигуры можно двигать, подписывать и соединять стрелками. Код и данные блока открываются кнопками в его шапке.'),
      {
        type: 'htmlBlock',
        attrs: { title: shapes.title, code: shapes.code, data: shapes.data, height: 380 },
      },
      p('Форматирования здесь нет и не будет: только ваш почерк и блоки.'),
    ],
  };
}
