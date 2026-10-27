/**
 * What «Документы» shows, kept while the tab is closed: what was open when
 * the tab was left for «Почерк» (the same document comes back in the same
 * mode, a render is kept by InkView and shown at once), or what the window
 * menu asked for from the other tab.
 */
export const docState = { docId: null as string | null, ink: false, print: false };

/** Fired on window when the menu opens a document; the app switches to «Документы». */
export const SHOW_DOC_EVENT = 'handbook:show-doc';
/** Fired on window when the menu asks to print the open document. */
export const PRINT_EVENT = 'handbook:print';

export function showDocument(id: string) {
  docState.docId = id;
  docState.ink = false;
  window.dispatchEvent(new CustomEvent<string>(SHOW_DOC_EVENT, { detail: id }));
}

export function requestPrint() {
  docState.print = true;
  window.dispatchEvent(new Event(PRINT_EVENT));
}
