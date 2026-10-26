import { mergeAttributes, Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { HtmlBlockView } from './HtmlBlockView';

export interface HtmlBlockAttrs {
  /** «html»: live HTML in a sandbox; «sketch»: a drawing from commands (src/sketch). */
  kind: 'html' | 'sketch';
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
  /** A drawing's own pen (Partial<DrawPen>); null: the document's. */
  pen: Record<string, unknown> | null;
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
 *
 * A «Чертёж» is the same node with kind «sketch»: its code is drawing
 * commands, drawn by the app in the user's hand (no iframe, no data).
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
      kind: { default: 'html', rendered: false },
      title: { default: 'Блок', rendered: false },
      code: { default: '', rendered: false },
      data: { default: {}, rendered: false },
      height: { default: 260, rendered: false },
      float: { default: false, rendered: false },
      x: { default: 0, rendered: false },
      y: { default: 0, rendered: false },
      w: { default: 360, rendered: false },
      pen: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-html-block]',
        getAttrs: (el) => ({
          kind: el.getAttribute('data-kind') === 'sketch' ? 'sketch' : 'html',
          title: el.getAttribute('data-title') ?? 'Блок',
          code: el.getAttribute('data-code') ?? '',
          data: parseJson(el.getAttribute('data-data')),
          height: Number(el.getAttribute('data-height')) || 260,
          float: el.getAttribute('data-float') === 'true',
          x: Number(el.getAttribute('data-x')) || 0,
          y: Number(el.getAttribute('data-y')) || 0,
          w: Number(el.getAttribute('data-w')) || 360,
          pen: el.hasAttribute('data-pen') ? (parseJson(el.getAttribute('data-pen')) as Record<string, unknown>) : null,
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-html-block': '',
        'data-kind': node.attrs.kind,
        'data-title': node.attrs.title,
        'data-code': node.attrs.code,
        'data-data': JSON.stringify(node.attrs.data),
        'data-height': String(node.attrs.height),
        'data-float': String(node.attrs.float),
        'data-x': String(node.attrs.x),
        'data-y': String(node.attrs.y),
        'data-w': String(node.attrs.w),
        ...(node.attrs.pen ? { 'data-pen': JSON.stringify(node.attrs.pen) } : {}),
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
