import { normalizeTimingPath } from './loadTimings';

const urlKeys = new Set(['url', 'http.url', 'url.full', 'http.target', 'url.path']);
const queryKeys = new Set(['http.query', 'url.query', 'url.fragment']);

export function stripUrlQuery(value: string): string {
  return value.split(/[?#]/, 1)[0];
}

function scrubData(data?: Record<string, unknown>): void {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (queryKeys.has(key)) data[key] = '';
    else if (urlKeys.has(key) && typeof data[key] === 'string') data[key] = stripUrlQuery(data[key] as string);
  }
}

export function sanitizeSpan<T extends { description?: string; op?: string; data?: Record<string, unknown> }>(
  span: T, apiUrl: string = '', origin: string = '',
): T {
  const description = span.description || '';
  const match = description.match(/^([A-Z]+)\s+(.+)$/);
  const source = span.data?.['url.full'] || span.data?.['http.url'] || span.data?.url || match?.[2] || description;
  if (span.description) span.description = stripUrlQuery(span.description);
  scrubData(span.data);
  if (typeof source !== 'string' || !source) return span;
  try {
    const base = origin || 'https://sentry.invalid';
    const url = new URL(source, base);
    const apiOrigin = new URL(apiUrl || base, base).origin;
    if (span.op === 'http.client' && (url.origin === apiOrigin || url.origin === new URL(base).origin)) {
      const template = normalizeTimingPath(url.pathname);
      const method = span.data?.['http.request.method'] || span.data?.['http.method'] || match?.[1] || 'GET';
      span.description = `${String(method).toUpperCase()} ${template}`;
      span.data = { ...span.data, 'url.template': template };
    } else if (span.op?.startsWith('resource')) {
      const path = url.pathname.replace(/\/([^/]+)$/, (segment, file: string) =>
        /^(?:[a-f\d]{8,}|[a-f\d-]{32,})$/i.test(file) || /\.(?:png|jpe?g|webp)$/i.test(file) ? '/:file' : segment);
      span.description = `${url.origin === 'https://sentry.invalid' ? '' : url.origin}${path}`;
    }
  } catch { /* Malformed URLs still have their query and fragment removed. */ }
  return span;
}

export function sanitizeBreadcrumb<T extends { category?: string; data?: Record<string, unknown> }>(breadcrumb: T): T {
  scrubData(breadcrumb.data);
  if (breadcrumb.category === 'navigation' && breadcrumb.data) {
    for (const key of ['from', 'to']) {
      if (typeof breadcrumb.data[key] === 'string') breadcrumb.data[key] = stripUrlQuery(breadcrumb.data[key] as string);
    }
  }
  return breadcrumb;
}

export function sanitizeEvent<T extends { request?: { url?: string }; transaction?: string; breadcrumbs?: { category?: string; data?: Record<string, unknown> }[] }>(event: T): T {
  if (event.request?.url) event.request.url = stripUrlQuery(event.request.url);
  if (event.transaction && /^(?:[A-Z]+\s+)?(?:https?:\/\/|\/)/i.test(event.transaction)) event.transaction = stripUrlQuery(event.transaction);
  event.breadcrumbs?.forEach(sanitizeBreadcrumb);
  return event;
}
