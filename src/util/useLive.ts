import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';

/** Re-runs a Dexie query whenever the underlying tables change. */
export function useLive<T>(query: () => Promise<T>, deps: unknown[], initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({ next: setValue, error: console.error });
    return () => sub.unsubscribe();
  }, deps);
  return value;
}
