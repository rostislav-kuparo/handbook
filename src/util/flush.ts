// Writes held back for a moment (the document being typed is saved a little
// after the last key): asked for at once before the window closes, a backup
// is made or the page is left — so the last words are never lost.

type Writer = () => PromiseLike<unknown> | void;

const writers = new Set<Writer>();

/** Registers a held-back write; returns how to take it off again. */
export function onFlush(write: Writer): () => void {
  writers.add(write);
  return () => void writers.delete(write);
}

/** Does every held-back write now; never fails, and never waits longer than `limit` ms. */
export async function flushWrites(limit = 2000): Promise<void> {
  const all = Promise.allSettled([...writers].map(async (w) => w()));
  await Promise.race([all, new Promise((done) => setTimeout(done, limit))]);
}

if (typeof window !== 'undefined') {
  // The page is going away (the window closed from the taskbar, a reload): the writes are started while it still can.
  window.addEventListener('pagehide', () => void flushWrites());
  window.addEventListener('beforeunload', () => void flushWrites());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushWrites();
  });
}
