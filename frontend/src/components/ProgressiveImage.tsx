'use client';

import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import LibraryImage, { resolveLibraryImageUrl } from './LibraryImage';

const pending: Array<() => void> = [];
let inFlight = 0;
function drain() {
  while (inFlight < 4 && pending.length) pending.shift()!();
}

function enqueue(run: () => Promise<void>) {
  let cancelled = false;
  const start = () => {
    if (cancelled) return;
    inFlight++;
    void run().catch(() => {}).finally(() => { inFlight--; drain(); });
  };
  pending.push(start);
  drain();
  return () => {
    cancelled = true;
    const index = pending.indexOf(start);
    if (index >= 0) pending.splice(index, 1);
  };
}

type Props = ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  highSrc?: string;
  resolvedSource?: string;
  onPreviewLoaded?: (source: string, url: string) => void;
};

export default function ProgressiveImage(props: Props) {
  return <ProgressiveContent key={props.src} {...props} />;
}

function ProgressiveContent({ src, highSrc, resolvedSource, onPreviewLoaded, ...props }: Props) {
  const host = useRef<HTMLSpanElement>(null);
  const callback = useRef(onPreviewLoaded);
  callback.current = onPreviewLoaded;
  const [loaded, setLoaded] = useState(false);
  const [near, setNear] = useState(false);
  const [upgraded, setUpgraded] = useState<{ source: string; url: string }>();

  useEffect(() => {
    if (!host.current) return;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      setNear(entry.isIntersecting);
    }, { rootMargin: `${window.innerHeight}px` });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!loaded || !near || !highSrc || highSrc === src || upgraded?.source === highSrc) return;
    let active = true;
    let preload: HTMLImageElement | undefined;
    let stop: (() => void) | undefined;
    const cancel = enqueue(async () => {
      const url = await resolveLibraryImageUrl(highSrc);
      if (!active) return;
      preload = new window.Image();
      const image = preload;
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => { image.src = ''; reject(new Error('Image timed out')); }, 20_000);
        stop = () => { window.clearTimeout(timer); image.onload = null; image.onerror = null; resolve(); };
        image.onload = () => { window.clearTimeout(timer); resolve(); };
        image.onerror = () => { window.clearTimeout(timer); reject(new Error('Image unavailable')); };
        image.src = url;
      });
      if (!active) return;
      await image.decode();
      if (active) {
        setUpgraded({ source: highSrc, url });
        callback.current?.(highSrc, url);
      }
    });
    return () => { active = false; cancel(); stop?.(); if (preload) preload.src = ''; };
  }, [loaded, near, highSrc, src, upgraded?.source]);

  return (
    <span ref={host} className="block h-full w-full">
      <LibraryImage
        {...props}
        src={upgraded?.source || src}
        resolvedSource={upgraded?.url || resolvedSource}
        onLoad={event => {
          setLoaded(true);
          callback.current?.(upgraded?.source || src, event.currentTarget.currentSrc);
          props.onLoad?.(event);
        }}
      />
    </span>
  );
}
