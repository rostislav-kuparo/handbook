// Runtime for HTML blocks.
//
// Every block runs in <iframe sandbox="allow-scripts"> WITHOUT allow-same-origin:
// the code gets an opaque origin, so it cannot touch the editor, IndexedDB or
// cookies. A CSP inside the frame forbids any network access, so a block cannot
// send document data anywhere. Libraries (rough.js, Chart.js) are inlined into
// the srcdoc for the same reason. The only channel is postMessage, wrapped by
// the tiny `block` SDK below.
import { FONT_FAMILY } from '../engine/constants';

/** Messages the editor accepts from a block. Everything else is ignored. */
export type BlockToHost =
  | { type: 'ready' }
  | { type: 'height'; height: number }
  | { type: 'setData'; data: unknown };

export type HostToBlock =
  | { type: 'init'; data: unknown; font?: ArrayBuffer }
  | { type: 'data'; data: unknown }
  | { type: 'font'; font: ArrayBuffer };

const SDK = `
(() => {
  const FAMILY = ${JSON.stringify(FONT_FAMILY)};
  const dataListeners = new Set();
  const fontListeners = new Set();
  let data = null;
  let face = null;
  const post = (msg) => parent.postMessage(msg, '*');
  const emit = () => dataListeners.forEach((cb) => { try { cb(data); } catch (e) { console.error(e); } });

  const block = {
    /** Current data of this block (persisted in the document). */
    get data() { return data; },
    /** Subscribe to data changes; called immediately if data is already there. */
    onData(cb) { dataListeners.add(cb); if (data !== null) cb(data); return () => dataListeners.delete(cb); },
    /** Replace the data. It is saved into the document (and undoable with Ctrl+Z). */
    setData(next) { data = next; post({ type: 'setData', data: next }); emit(); },
    /** Update helper: block.update(d => ({ ...d, n: d.n + 1 })). */
    update(fn) { block.setData(fn(structuredClone(data))); },
    /** Called when the user's handwriting font is available (and on every rebuild). */
    onFont(cb) { fontListeners.add(cb); if (face) cb(FAMILY); return () => fontListeners.delete(cb); },
    /** CSS font stack with the user's handwriting. */
    font: '"' + FAMILY + '", "Segoe Print", cursive',
    /** Ink colour of the current theme (light/dark), for canvas and SVG drawing. */
    get ink() { return getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#1f2a6b'; },
    /** Report content height to the editor (done automatically on resize). */
    resize() { post({ type: 'height', height: Math.ceil(document.body.getBoundingClientRect().height) }); },
  };
  window.block = block;

  async function installFont(buf) {
    try {
      const next = new FontFace(FAMILY, buf);
      await next.load();
      document.fonts.add(next);
      if (face) document.fonts.delete(face);
      face = next;
      fontListeners.forEach((cb) => { try { cb(FAMILY); } catch (e) { console.error(e); } });
    } catch (e) { console.warn('font', e); }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const msg = e.data || {};
    if (msg.type === 'init' || msg.type === 'data') { data = msg.data; emit(); }
    if (msg.font) installFont(msg.font);
  });
  // The SDK runs in <head>: wait for <body> before observing it.
  document.addEventListener('DOMContentLoaded', () => {
    new ResizeObserver(() => block.resize()).observe(document.body);
    post({ type: 'ready' });
  });
})();
`;

const BASE_CSS = `
:root { --hand: "${FONT_FAMILY}", "Segoe Print", cursive; --ink: #1f2a6b; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --ink: #c3d0ff; } }
html, body { margin: 0; padding: 0; background: transparent; }
body { font-family: var(--hand); color: var(--ink); font-size: 18px; display: flow-root; overflow: hidden; }
* { box-sizing: border-box; }
`;

/** Libraries a block may use, inlined only when its code mentions them. */
const VENDOR = {
  rough: { url: '/vendor/rough.js', uses: /\brough\b/ },
  chart: { url: '/vendor/chart.umd.min.js', uses: /\bChart\b/ },
} as const;

export type VendorBundle = Record<keyof typeof VENDOR, string>;

let vendorPromise: Promise<VendorBundle> | null = null;

/** Fetch the library sources once (same-origin, from public/vendor). */
export function loadVendor(): Promise<VendorBundle> {
  vendorPromise ??= Promise.all(
    Object.entries(VENDOR).map(async ([name, v]) => {
      const text = await (await fetch(v.url)).text();
      // A literal "</script" inside the library would end the inline <script>.
      return [name, text.replace(/<\/script/gi, '<\\/script')] as const;
    }),
  ).then((entries) => Object.fromEntries(entries) as VendorBundle);
  return vendorPromise;
}

/** Build the srcdoc for a block. Everything is inline: no network, works offline. */
export function buildSrcdoc(code: string, vendor: VendorBundle): string {
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data: blob:',
  ].join('; ');
  const libs = (Object.keys(VENDOR) as (keyof typeof VENDOR)[])
    .filter((k) => VENDOR[k].uses.test(code))
    .map((k) => `<script>${vendor[k]}</script>`)
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${BASE_CSS}</style>
<script>${SDK}</script>
${libs}
</head><body>
${code}
</body></html>`;
}

export function isBlockMessage(msg: unknown): msg is BlockToHost {
  if (!msg || typeof msg !== 'object') return false;
  const t = (msg as { type?: unknown }).type;
  return t === 'ready' || t === 'height' || t === 'setData';
}
