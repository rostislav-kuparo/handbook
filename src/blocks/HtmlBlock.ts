import { mergeAttributes, Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { HtmlBlockView } from './HtmlBlockView';

export interface HtmlBlockAttrs {
  title: string;
  code: string;
  data: unknown;
  height: number;
  /** Lies over the text instead of taking its own room. */
  float: boolean;
  /** Floating position and width, px relative to the text column. */
  x: number;
  y: number;
  w: number;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    htmlBlock: {
      insertHtmlBlock: (attrs: Partial<HtmlBlockAttrs>) => ReturnType;
    };
  }
}

function parseJson(raw: string | null): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * A live HTML block inside the document. Code and data are stored separately:
 * the code renders, the data is what the user edits (a chart's numbers,
 * shapes on a board) and survives code changes.
 */
export const HtmlBlock = Node.create({
  name: 'htmlBlock',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  isolating: true,

  addAttributes() {
    return {
      title: { default: 'Блок', rendered: false },
      code: { default: '', rendered: false },
      data: { default: {}, rendered: false },
      height: { default: 260, rendered: false },
      float: { default: false, rendered: false },
      x: { default: 0, rendered: false },
      y: { default: 0, rendered: false },
      w: { default: 360, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-html-block]',
        getAttrs: (el) => ({
          title: el.getAttribute('data-title') ?? 'Блок',
          code: el.getAttribute('data-code') ?? '',
          data: parseJson(el.getAttribute('data-data')),
          height: Number(el.getAttribute('data-height')) || 260,
          float: el.getAttribute('data-float') === 'true',
          x: Number(el.getAttribute('data-x')) || 0,
          y: Number(el.getAttribute('data-y')) || 0,
          w: Number(el.getAttribute('data-w')) || 360,
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-html-block': '',
        'data-title': node.attrs.title,
        'data-code': node.attrs.code,
        'data-data': JSON.stringify(node.attrs.data),
        'data-height': String(node.attrs.height),
        'data-float': String(node.attrs.float),
        'data-x': String(node.attrs.x),
        'data-y': String(node.attrs.y),
        'data-w': String(node.attrs.w),
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(HtmlBlockView);
  },

  addCommands() {
    return {
      insertHtmlBlock:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent([{ type: this.name, attrs }, { type: 'paragraph' }]),
    };
  },
});
