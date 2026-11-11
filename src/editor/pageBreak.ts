// «С новой страницы»: a paragraph may start on the next sheet. It is the
// paragraph's own mark (`pageBreak`), so the break stays with its text through
// edits; the editor's sheets, the rendered view and every export honour it.
// Ctrl+Enter puts one in; Backspace at the start of such a paragraph takes it away.
import Paragraph from '@tiptap/extension-paragraph';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageBreak: {
      /** The text after the cursor goes onto the next sheet. */
      setPageBreak: () => ReturnType;
    };
  }
}

/**
 * A line that only says «new page here», typed into text that is pasted:
 * `===`, or LaTeX's `\newpage`, `\pagebreak`, `\clearpage`.
 */
export const PAGE_MARK_LINE = /^[ \t ]*(?:={3,}|\\(?:newpage|pagebreak|clearpage)(?:\{\})?)[ \t ]*$/;

/** Whether a top-level node starts a new sheet (the first node of a document never needs to). */
export const startsPage = (node: { type: string | { name: string }; attrs?: Record<string, unknown> | null }) =>
  (typeof node.type === 'string' ? node.type : node.type.name) === 'paragraph' && node.attrs?.pageBreak === true;

export const HandParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      pageBreak: {
        default: false,
        // Enter in the middle of such a paragraph: only its first part starts the sheet.
        keepOnSplit: false,
        // 'mark': a pasted «new page here» line, gone once the paste is laid out (see pasteText.ts).
        parseHTML: (el) => (el.hasAttribute('data-page-break-mark') ? 'mark' : el.hasAttribute('data-page-break')),
        // Copied into Word or Google Docs, the break goes along.
        renderHTML: (attrs) => (attrs.pageBreak === true ? { 'data-page-break': '', style: 'break-before: page' } : {}),
      },
    };
  },

  addCommands() {
    return {
      ...this.parent?.(),
      setPageBreak:
        () =>
        ({ state, tr, dispatch }) => {
          if (state.selection.$from.depth !== 1 || state.selection.$from.parent.type.name !== 'paragraph') return false;
          if (!dispatch) return true;
          if (!state.selection.empty) tr.deleteSelection();
          const $pos = tr.selection.$from;
          if ($pos.depth !== 1) return false;
          const attrs = { ...$pos.parent.attrs, pageBreak: true };
          // At the start of a line: this very line goes onto the next sheet.
          if ($pos.parentOffset === 0 && $pos.index(0) > 0) tr.setNodeMarkup($pos.before(), undefined, attrs);
          else tr.split($pos.pos, 1, [{ type: $pos.parent.type, attrs }]);
          tr.scrollIntoView();
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      'Mod-Enter': () => this.editor.commands.setPageBreak(),
      // Backspace right at the start of a line that begins a sheet takes the break away first.
      Backspace: () => {
        const { selection } = this.editor.state;
        const $from = selection.$from;
        if (!selection.empty || $from.depth !== 1 || $from.parentOffset !== 0 || $from.parent.attrs.pageBreak !== true) return false;
        return this.editor.commands.command(({ tr }) => {
          tr.setNodeMarkup($from.before(), undefined, { ...$from.parent.attrs, pageBreak: false });
          return true;
        });
      },
    };
  },
});
