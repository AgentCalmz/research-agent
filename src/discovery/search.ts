import { absoluteUrl, cleanHtml, fetchText } from '../runtime/http.js';

export type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
  source: 'duckduckgo' | 'searxng';
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
    const response = await fetchText(url, { headers: { 'user-agent': 'opportunist-research-agent/0.1' } });
    if (!response.ok) throw new Error(`DuckDuckGo search failed with HTTP ${response.status}`);
    const html = await response.text();
    const results: SearchResult[] = [];
    const blockRe = /<div class="result results_links results_links_deep web-result(?:[\s\S]*?)<\/div>\s*<\/div>/gi;

    for (const match of html.matchAll(blockRe)) {
      const block = match[0];
      const linkMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;
      let href = decode(linkMatch[1]);
      if (href.includes('uddg=')) {
        try { href = decodeURIComponent(new URL(href, 'https://duckduckgo.com').searchParams.get('uddg') ?? href); } catch { /* keep original */ }
      }
      const absolute = absoluteUrl('https://duckduckgo.com', href);
      if (!absolute) continue;
      const title = cleanHtml(linkMatch[2], 300);
      const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
      const snippet = cleanHtml(snippetMatch?.[1] ?? snippetMatch?.[2] ?? '', 500);
      results.push({ title, url: absolute, snippet, source: 'duckduckgo' });
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
    const response = await fetchText(url.toString(), { headers: { 'user-agent': 'opportunist-research-agent/0.1' } });
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
