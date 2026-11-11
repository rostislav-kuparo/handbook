// Pasted text keeps its paragraphs: every line of plain text is a line of the
// document, empty lines included (the editor used to squeeze them out), and
// the line breaks of copied HTML (<br>: Word, Google Docs, VS Code, many
// sites) are lines too instead of being joined with a space. Numbered and
// bulleted lists keep their numbers and dashes.
//
// A line that says «new page here» — `===`, `\newpage`, a form feed, a page
// break from Word or Google Docs — is not written: the text after it starts on
// the next sheet (see pageBreak.ts).
import { Extension } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode, type ResolvedPos, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { PAGE_MARK_LINE } from './pageBreak';

/** A paragraph that only marks a page break (from plain text, HTML or a typed line). */
function isMark(node: PMNode): boolean {
  return node.type.name === 'paragraph' && (node.attrs.pageBreak === 'mark' || PAGE_MARK_LINE.test(node.textContent));
}

/** Plain text as lines of the document; null when it is a piece of one line (pasted as usual). */
function plainSlice(text: string, $context: ResolvedPos, schema: Schema): Slice | null {
  if (!/[\r\n\f]/.test(text) && !PAGE_MARK_LINE.test(text)) return null;
  const para = schema.nodes.paragraph;
  const marks = $context.marks();
  const nodes: PMNode[] = [];
  // A form feed (Word's page break in plain text) parts the pages; the line it stands on is not doubled.
  const pages = text.split('\f');
  pages.forEach((page, i) => {
    const lines = page.split(/\r\n?|\n/);
    if (i > 0) {
      if (lines.length > 1 && lines[0] === '') lines.shift();
      nodes.push(para.create({ pageBreak: 'mark' }));
    }
    if (i < pages.length - 1 && lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) nodes.push(para.create(null, line ? schema.text(line, marks) : null));
  });
  // Open at both ends: the first line goes on the line of the cursor, the last one takes the rest of it.
  return new Slice(Fragment.from(nodes), 1, 1);
}

/** The marks of «new page here» turned into breaks before the text after them. */
function applyPageMarks(slice: Slice, schema: Schema): Slice {
  if (!slice.content.firstChild || slice.content.firstChild.isInline) return slice;
  const nodes: PMNode[] = [];
  let pending = false;
  let changed = false;
  slice.content.forEach((node) => {
    if (isMark(node)) {
      pending = true;
      changed = true;
      return;
    }
    if (pending) {
      // Before a block (a drawing, a table): an empty line starts the sheet, the block below it.
      nodes.push(node.type.name === 'paragraph' ? node.type.create({ ...node.attrs, pageBreak: true }, node.content, node.marks) : schema.nodes.paragraph.create({ pageBreak: true }));
      if (node.type.name !== 'paragraph') nodes.push(node);
      pending = false;
      return;
    }
    nodes.push(node);
  });
  // The paste ends with a break: what comes after it is on the next sheet.
  if (pending) nodes.push(schema.nodes.paragraph.create({ pageBreak: true }));
  const first = nodes[0];
  // A first line that starts a sheet must not melt into the line of the cursor (it would lose its break).
  const breaksFirst = first?.attrs.pageBreak === true;
  if (!changed && !breaksFirst) return slice;
  const last = nodes[nodes.length - 1];
  return new Slice(Fragment.fromArray(nodes), breaksFirst || !first.isTextblock ? 0 : slice.openStart, last.isTextblock ? slice.openEnd : 0);
}

// ---------------------------------------------------------------- HTML

const BLOCK_TAGS =
  'ADDRESS ARTICLE ASIDE BLOCKQUOTE CENTER DD DETAILS DIV DL DT FIELDSET FIGCAPTION FIGURE FOOTER FORM H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN NAV OL P PRE SECTION SUMMARY TABLE TBODY TD TFOOT TH THEAD TR UL';
const BLOCKS = new Set(BLOCK_TAGS.split(' '));
const BLOCK_SELECTOR = BLOCK_TAGS.toLowerCase().split(' ').join(',');

const isBlock = (n: Node | null): n is Element => !!n && n.nodeType === 1 && BLOCKS.has((n as Element).tagName);
const hasContent = (n: Node) => (n.textContent ?? '').trim() !== '' || (n.nodeType === 1 && (n as Element).querySelector('img, svg, br') !== null);

const PAGE_BEFORE = /page-break-before\s*:\s*always|(?:^|[;\s])break-before\s*:\s*page/i;
const PAGE_AFTER = /page-break-after\s*:\s*always|(?:^|[;\s])break-after\s*:\s*page/i;

function markParagraph(doc: Document): HTMLElement {
  const p = doc.createElement('p');
  p.setAttribute('data-page-break-mark', '');
  return p;
}

/** Copied HTML with its line breaks made into lines, its lists numbered and its page breaks marked. */
export function linesInHtml(html: string): string {
  if (!/<br|<li|page-break|break-(?:before|after)/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;

  // Page breaks given by style (Word: <br style="page-break-before:always">, Google Docs: <hr style="page-break-before:always">).
  body.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
    // The editor's own lines carry their break themselves.
    if (el.hasAttribute('data-page-break')) return;
    const style = el.getAttribute('style') ?? '';
    const before = PAGE_BEFORE.test(style);
    const after = PAGE_AFTER.test(style);
    if (!before && !after) return;
    if (el.tagName === 'BR') el.setAttribute('data-page-br', '');
    else if (isBlock(el)) (before ? el.before(markParagraph(doc)) : el.after(markParagraph(doc)));
  });

  // Lists keep their numbers and dashes (the editor has no lists of its own).
  body.querySelectorAll('li').forEach((li) => {
    const list = li.parentElement;
    if (/^\s*(?:\d+[.)]|[—–•·*-])\s/.test(li.textContent ?? '')) return;
    let prefix = '— ';
    if (list?.tagName === 'OL') {
      const items = [...list.children].filter((c) => c.tagName === 'LI');
      prefix = `${(Number(list.getAttribute('start')) || 1) + items.indexOf(li)}. `;
    }
    li.prepend(doc.createTextNode(prefix));
  });

  // Line breaks among bare text at the top (no paragraph around): that text becomes a paragraph to split.
  let run: Node[] = [];
  const wrap = () => {
    if (run.some((n) => n.nodeName === 'BR' || (n.nodeType === 1 && (n as Element).querySelector('br')))) {
      const p = doc.createElement('p');
      body.insertBefore(p, run[0]);
      for (const n of run) p.appendChild(n);
    }
    run = [];
  };
  for (const n of [...body.childNodes]) {
    if (isBlock(n) || (n.nodeType === 1 && (n as Element).querySelector(BLOCK_SELECTOR))) wrap();
    else run.push(n);
  }
  wrap();

  for (const br of [...body.querySelectorAll('br')]) {
    if (!br.isConnected || br.closest('pre, [data-html-block]')) continue;
    const page = br.hasAttribute('data-page-br');
    if (br.classList.contains('Apple-interchange-newline')) {
      br.remove();
      continue;
    }
    const parent = br.parentElement ?? body;
    const block = parent.closest(BLOCK_SELECTOR);
    // Between paragraphs (Google Docs' empty lines): an empty line of its own.
    if (!block || !body.contains(block) || [...parent.children].some(isBlock)) {
      br.replaceWith(page ? markParagraph(doc) : doc.createElement('p'));
      continue;
    }
    const rest = doc.createRange();
    rest.setStartAfter(br);
    rest.setEnd(block, block.childNodes.length);
    // The last <br> of a block only ends its line (as the browser shows it): no new line after it.
    if (!page && !hasContent(rest.cloneContents())) {
      br.remove();
      continue;
    }
    const next = doc.createElement('p');
    next.appendChild(rest.extractContents());
    br.remove();
    block.after(next);
    if (page) block.after(markParagraph(doc));
    // A block left with nothing in it (the <br> stood first): an empty line — or nothing, when the <br> was a page break.
    if (!hasContent(block) && block.tagName !== 'LI') {
      if (page) block.remove();
      else block.replaceWith(doc.createElement('p'));
    }
  }
  return body.innerHTML;
}

/** Keeps the paragraphs and page breaks of pasted text (see the top of the file). */
export const PasteText = Extension.create({
  name: 'pasteText',
  // After the drawings' fences (110), whose commands are not lines of text.
  priority: 105,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('pasteText'),
        props: {
          clipboardTextParser: (text, $context, _plain, view) => plainSlice(text, $context, view.state.schema) as Slice,
          transformPastedHTML: linesInHtml,
          transformPasted: (slice, view) => applyPageMarks(slice, view.state.schema),
        },
      }),
    ];
  },
});

// Editor plugins are set up once per editor: reload the page instead of hot-swapping.
import.meta.hot?.accept(() => location.reload());
