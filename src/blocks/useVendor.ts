import { useEffect, useState } from 'react';
import { loadVendor, type VendorBundle } from './runtime';

let cached: VendorBundle | null = null;

/** Library sources for block srcdocs; null until fetched (once per session). */
export function useVendor(): VendorBundle | null {
  const [vendor, setVendor] = useState(cached);
  useEffect(() => {
    if (cached) return;
    void loadVendor().then((v) => {
      cached = v;
      setVendor(v);
    });
  }, []);
  return vendor;
}
