'use client';

import { useEffect, useRef, useState } from 'react';

/** Pixel need for the longest edge, including object-cover cropping. */
export function useImagePixels(width: number | null, height: number | null) {
  const host = useRef<HTMLSpanElement>(null);
  const [pixels, setPixels] = useState(0);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      const ratio = width && height ? width / height : 1;
      setPixels(Math.max(box.width, box.height, box.width / ratio, box.height * ratio) * window.devicePixelRatio);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [width, height]);
  return { host, pixels };
}
