import { cleanHtml, fetchText } from '../runtime/http.js';

export type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
  source: 'duckduckgo' | 'searxng' | 'seed';
};

export interface SearchProvider {
  search(query: string, limit?: number): Promise<SearchResult[]>;
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export class DuckDuckGoSearch implements SearchProvider {
  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetchText(url, { headers: { 'user-agent': 'opportunist-research-agent/0.2' } });
    if (!response.ok) throw new Error(`DuckDuckGo search failed with HTTP ${response.status}`);
    const html = await response.text();
    const results: SearchResult[] = [];
    const linkRe = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRe = /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    const snippets = [...html.matchAll(snippetRe)].map((match) => match[1] ? cleanHtml(match[1], 700) : '');
    let index = 0;

    for (const match of html.matchAll(linkRe)) {
      const rawHref = match[1];
      const rawTitle = match[2];
      if (!rawHref || !rawTitle) continue;
      let href = decode(rawHref);
      try {
        const parsed = new URL(href, 'https://duckduckgo.com');
        const redirected = parsed.searchParams.get('uddg');
        if (redirected) href = decodeURIComponent(redirected);
      } catch { /* keep original href */ }
      try {
        const absolute = new URL(href, 'https://duckduckgo.com').toString();
        results.push({ title: cleanHtml(rawTitle, 300), url: absolute, snippet: snippets[index] || undefined, source: 'duckduckgo' });
        index += 1;
      } catch { /* ignore malformed result links */ }
      if (results.length >= limit) break;
    }

    return results;
  }
}

export class SearxngSearch implements SearchProvider {
  constructor(private readonly baseUrl: string) {}

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('language', 'en');
    const response = await fetchText(url.toString(), { headers: { 'user-agent': 'opportunist-research-agent/0.2' } });
    if (!response.ok) throw new Error(`SearXNG search failed with HTTP ${response.status}`);
    const json = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (json.results ?? []).slice(0, limit).flatMap((item) => item.url && item.title ? [{
      title: item.title,
      url: item.url,
      snippet: item.content,
      source: 'searxng' as const
    }] : []);
  }
}
