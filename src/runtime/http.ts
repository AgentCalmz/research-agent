const DEFAULT_TIMEOUT = 15000;
let requestCount = 0;
let maxRequests = 60;

export function configureHttp(limit: number): void {
  maxRequests = limit;
  requestCount = 0;
}

export function getRequestCount(): number {
  return requestCount;
}

export async function fetchText(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT): Promise<Response> {
  if (requestCount >= maxRequests) {
    throw new Error(`HTTP request budget exhausted (${maxRequests})`);
  }
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are allowed');
  requestCount += 1;
  return fetch(parsed, {
    ...init,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
}

export function cleanHtml(html: string, maxChars = 12000): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

export function absoluteUrl(base: string, href: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
