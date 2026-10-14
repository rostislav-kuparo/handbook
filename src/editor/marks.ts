import { Mark, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    handMarks: {
      /** Letter size of the selection: 1 = normal, 2 = twice as big. */
      setTextSize: (scale: number) => ReturnType;
      unsetTextSize: () => ReturnType;
      setInkColor: (color: string) => ReturnType;
      unsetInkColor: () => ReturnType;
      /** Index letters: x₁ (sub) or x² (sup); toggles. */
      toggleScript: (kind: ScriptKind) => ReturnType;
    };
  }
}

/** Bigger or smaller handwriting for chosen words or lines. Line spacing stays on the ruling. */
export const TextSize = Mark.create({
  name: 'textSize',
  addAttributes() {
    return { scale: { default: 1, rendered: false } };
  },
  parseHTML() {
    return [{ tag: 'span[data-size]', getAttrs: (el) => ({ scale: Number(el.getAttribute('data-size')) || 1 }) }];
  },
  renderHTML({ mark, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-size': mark.attrs.scale, style: `font-size:${mark.attrs.scale}em` }), 0];
  },
  addCommands() {
    return {
      setTextSize:
        (scale) =>
        ({ commands }) =>
          Math.abs(scale - 1) < 0.01 ? commands.unsetMark(this.name) : commands.setMark(this.name, { scale }),
      unsetTextSize:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

/** A different pen colour for chosen words. */
export const InkColor = Mark.create({
  name: 'inkColor',
  addAttributes() {
    return { color: { default: '#1f2a6b', rendered: false } };
  },
  parseHTML() {
    return [{ tag: 'span[data-ink]', getAttrs: (el) => ({ color: el.getAttribute('data-ink') }) }];
  },
  renderHTML({ mark, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-ink': mark.attrs.color, class: 'ink-mark', style: `--mark:${mark.attrs.color}` }),
      0,
    ];
  },
  addCommands() {
    return {
      setInkColor:
        (color) =>
        ({ commands }) =>
          commands.setMark(this.name, { color }),
      unsetInkColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

export type ScriptKind = 'sub' | 'sup';

/** Size of an index relative to its letter. */
export const SCRIPT_SCALE = 0.65;
/** Raise of an index above the baseline, in em of the surrounding text (same in CSS and in ink). */
export const SCRIPT_SHIFT: Record<ScriptKind, number> = { sub: -0.18, sup: 0.36 };

/**
 * Indices for formulas: f₁, Π₂, x². The letters are the same handwriting,
 * only smaller and below or above the line; the line spacing does not change.
 * Pasted <sub>/<sup> become indices too.
 */
export const Script = Mark.create({
  name: 'script',
  addAttributes() {
    return { kind: { default: 'sub', rendered: false } };
  },
  parseHTML() {
    return [
      { tag: 'sub', attrs: { kind: 'sub' } },
      { tag: 'sup', attrs: { kind: 'sup' } },
      { tag: 'span[data-script]', getAttrs: (el) => ({ kind: el.getAttribute('data-script') === 'sup' ? 'sup' : 'sub' }) },
      {
        style: 'vertical-align',
        getAttrs: (value) => (value === 'sub' ? { kind: 'sub' } : value === 'super' ? { kind: 'sup' } : false),
      },
    ];
  },
  renderHTML({ mark, HTMLAttributes }) {
    const kind = mark.attrs.kind === 'sup' ? 'sup' : 'sub';
    return ['span', mergeAttributes(HTMLAttributes, { 'data-script': kind, class: `script-${kind}` }), 0];
  },
  addCommands() {
    return {
      toggleScript:
        (kind) =>
        ({ editor, commands }) =>
          editor.isActive(this.name, { kind }) ? commands.unsetMark(this.name) : commands.setMark(this.name, { kind }),
    };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-,': () => this.editor.commands.toggleScript('sub'),
      'Mod-.': () => this.editor.commands.toggleScript('sup'),
    };
  },
});

export const SIZE_STEPS = [0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];

// Editor plugins are set up once per editor: reload the page instead of hot-swapping.
import.meta.hot?.accept(() => location.reload());
