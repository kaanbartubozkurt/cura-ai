'use client';

import { useEffect } from 'react';
import routes from './timingRoutes.json';

type Status = '2xx' | '3xx' | '4xx' | '5xx' | 'error';
type Sample = {
  metric: 'api' | 'image' | 'library_first_images';
  key: string;
  duration_ms: number;
  status: Status;
  connection?: string;
};
const templates = [...routes].sort((a, b) => a.split(':id').length - b.split(':id').length || b.length - a.length);
const patterns = templates.map(route => ({ route, parts: route.split('/') }));
let buffer: Sample[] = [];
let started = false;
const endpoint = `${process.env.NEXT_PUBLIC_API_URL || ''}/api/telemetry/timings`;

export function normalizeTimingPath(value: string): string {
  try {
    const path = new URL(value, 'https://telemetry.invalid').pathname.replace(/\/$/, '') || '/';
    const parts = path.split('/');
    return patterns.find(candidate => candidate.parts.length === parts.length && candidate.parts.every((part, index) => part === ':id' ? !!parts[index] : part === parts[index]))?.route || '/:id';
  } catch { return '/:id'; }
}

function flush(): void {
  try {
    if (!buffer.length) return;
    const samples = buffer.splice(0, 100);
    const body = JSON.stringify({ samples });
    // text/plain is CORS-safelisted, so the cross-origin beacon needs no preflight;
    // the backend parses the body as JSON regardless of content type.
    const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
    if (!navigator.sendBeacon?.(endpoint, blob)) {
      void fetch(endpoint, { method: 'POST', body: blob, keepalive: true, credentials: 'omit' }).catch(() => {});
    }
  } catch { /* Timing collection is best effort. */ }
}

export function recordTiming(sample: Sample): void {
  try {
    if (typeof window === 'undefined' || !Number.isFinite(sample.duration_ms)) return;
    if (!started) {
      started = true;
      window.setInterval(flush, 30_000);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    }
    const connection = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType;
    // 80 samples keeps even maximum-size keys comfortably within the 16KB body limit.
    if (buffer.length >= 80) return;
    buffer.push({ ...sample, duration_ms: Math.min(120000, Math.max(0, sample.duration_ms)),
      ...(connection && ['slow-2g', '2g', '3g', '4g'].includes(connection) ? { connection } : {}) });
  } catch { /* Telemetry must never break application behavior. */ }
}

export function recordApiTiming(config?: { url?: string; method?: string; metadata?: { startTime: number } }, status?: number): void {
  try {
    if (!config?.metadata || config.url?.split('?')[0].includes('/telemetry/timings')) return;
    let path = config.url || '';
    if (!path.startsWith('/api/') && !path.startsWith('http')) path = `/api/${path.replace(/^\//, '')}`;
    const method = (config.method || 'GET').toUpperCase();
    const key = `${method} ${normalizeTimingPath(path)}`;
    if (key.length > 80) return;
    recordTiming({ metric: 'api', key, duration_ms: Date.now() - config.metadata.startTime,
      status: status && status >= 200 && status < 600 ? `${Math.floor(status / 100)}xx` as Status : 'error' });
  } catch { /* Best effort. */ }
}

export function startImageTiming(source: string): () => void {
  try {
    if (Math.random() >= 0.2) return () => {};
    const path = new URL(source, 'https://telemetry.invalid').pathname;
    const kind = /generated_thumbnails|generation\/thumbnails/.test(path) ? 'generation_thumb'
      : /thumbnails/.test(path) ? 'library_thumb' : 'full';
    const start = performance.now();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      recordTiming({ metric: 'image', key: kind, duration_ms: performance.now() - start, status: '2xx' });
    };
  } catch { return () => {}; }
}

/** Count distinct card previews, including images already in the browser cache. */
export function useFirstImagesTiming(view: string): void {
  useEffect(() => {
    let cleanup = () => {};
    try {
      const start = performance.now();
      let hidden = document.visibilityState !== 'visible';
      let done = false;
      const loaded = new Set<string>();
      const check = () => {
        try {
          if (done || hidden) return;
          const cards = Array.from(document.querySelectorAll('[data-load-card]'));
          for (const card of cards) {
            const image = card instanceof HTMLImageElement ? card : card.querySelector('img');
            if (image?.complete && image.naturalWidth > 0) loaded.add(card.getAttribute('data-load-card')!);
          }
          const target = Math.min(4, new Set(cards.map(card => card.getAttribute('data-load-card'))).size);
          if (target && loaded.size >= target) {
            done = true;
            recordTiming({ metric: 'library_first_images', key: normalizeTimingPath(view.split('?')[0]),
              duration_ms: performance.now() - start, status: '2xx' });
            cleanup();
          }
        } catch { /* Best effort. */ }
      };
      const visibility = () => { if (document.visibilityState !== 'visible') { hidden = true; cleanup(); } };
      const observer = new MutationObserver(check);
      cleanup = () => {
        observer.disconnect();
        document.removeEventListener('load', check, true);
        document.removeEventListener('visibilitychange', visibility);
      };
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
      document.addEventListener('load', check, true);
      document.addEventListener('visibilitychange', visibility);
      check();
    } catch { cleanup(); }
    return () => cleanup();
  }, [view]);
}
