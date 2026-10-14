import { useEffect, useMemo, useRef, useState } from 'react';
import { getHandwriting } from '../engine/handwriting';
import { buildSrcdoc, isBlockMessage } from './runtime';
import { useVendor } from './useVendor';

/** Read-only rendering of an HTML block (ink view, print). Data changes are not saved. */
export function BlockFrame({
  code,
  data,
  title,
  onHeight,
}: {
  code: string;
  data: unknown;
  title: string;
  /** Reported content height (px), e.g. to flow the block onto pages. */
  onHeight?: (height: number) => void;
}) {
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(260);
  const vendor = useVendor();
  const srcdoc = useMemo(() => (vendor ? buildSrcdoc(code, vendor) : ''), [code, vendor]);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !isBlockMessage(e.data)) return;
      if (e.data.type === 'ready') {
        const bytes = getHandwriting().fontBytes;
        const font = bytes ? (bytes.slice().buffer as ArrayBuffer) : undefined;
        ref.current?.contentWindow?.postMessage({ type: 'init', data: dataRef.current, font }, '*', font ? [font] : []);
      } else if (e.data.type === 'height') {
        const h = Math.min(Math.max(Math.round(Number(e.data.height) || 0), 40), 3000);
        setHeight(h);
        onHeightRef.current?.(h);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (!srcdoc) return <div style={{ height }} />;
  return (
    <iframe
      ref={ref}
      className="html-block-frame static"
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcdoc}
      style={{ height }}
    />
  );
}
