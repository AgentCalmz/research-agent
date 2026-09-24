import type { SearchResult } from '../discovery/search.js';
import { cleanHtml, fetchText } from '../runtime/http.js';

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extractLinks(html: string, baseUrl: string): Array<{ href: string; text: string; index: number }> {
  const out: Array<{ href: string; text: string; index: number }> = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(re)) {
    const href = match[1];
    const rawText = match[2];
    if (!href || rawText === undefined) continue;
    try {
      const url = new URL(href, baseUrl).toString();
      out.push({ href: url, text: cleanHtml(decodeHtml(rawText), 220), index: match.index ?? 0 });
    } catch {
      // Ignore malformed links.
    }
  }
  return out;
}

function nearbyText(html: string, index: number): string {
  const start = Math.max(0, index - 550);
  const end = Math.min(html.length, index + 900);
  return cleanHtml(decodeHtml(html.slice(start, end)), 1200);
}

function isLikelyProfilePath(pathname: string): boolean {
  return /\/(?:agents?|companies?|business(?:es)?|brokers?|profiles?)\/[^/?#]+/i.test(pathname);
}

function isNextPageLink(link: { href: string; text: string }, origin: string, currentUrl: string): boolean {
  try {
    const parsed = new URL(link.href);
    if (parsed.origin !== origin) return false;
    if (/^(?:next|next page|>|›)$/i.test(link.text.trim())) return true;

    const current = new URL(currentUrl);
    const candidatePage = Number(parsed.searchParams.get('page') || parsed.searchParams.get('p') || '');
    const currentPage = Number(current.searchParams.get('page') || current.searchParams.get('p') || '1');
    if (Number.isFinite(candidatePage) && Number.isFinite(currentPage) && candidatePage === currentPage + 1) return true;

    const candidateOffset = Number(parsed.searchParams.get('offset') || parsed.searchParams.get('start') || '');
    const currentOffset = Number(current.searchParams.get('offset') || current.searchParams.get('start') || '0');
    return Number.isFinite(candidateOffset) && Number.isFinite(currentOffset) && candidateOffset > currentOffset;
  } catch {
    return false;
  }
}

function seedCandidatesFromHtml(pageUrl: string, html: string): SearchResult[] {
  const links = extractLinks(html, pageUrl);
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  for (const link of links) {
    let parsed: URL;
    try {
      parsed = new URL(link.href);
    } catch {
      continue;
    }
    if (!isLikelyProfilePath(parsed.pathname)) continue;
    const canonical = parsed.toString().replace(/[#?].*$/, '');
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const title = link.text.trim();
    if (!title || /^(view profile|view|details|more)$/i.test(title)) continue;
    results.push({
      title,
      url: link.href,
      snippet: nearbyText(html, link.index),
      source: 'seed'
    });
  }

  return results;
}

export function extractSeedUrls(request: string): string[] {
  const matches = request.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  return [...new Set(matches.map((value) => value.replace(/[),.;!?]+$/, '')))];
}

export function inferLocationFromSourceUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const queryValue = parsed.searchParams.get('search') || parsed.searchParams.get('location') || parsed.searchParams.get('city');
    if (queryValue?.trim()) return queryValue.trim().replace(/\+/g, ' ');
    const path = decodeURIComponent(parsed.pathname);
    const match = path.match(/\/(abuja|lagos|ibadan|enugu|kaduna|kano|jos|port-harcourt)\b/i);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export async function discoverFromSeedUrls(
  seedUrls: string[],
  maxCandidates = 60,
  maxPagesPerSeed = 4
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const seenCandidates = new Set<string>();

  for (const seedUrl of seedUrls) {
    let currentUrl = seedUrl;
    const visitedPages = new Set<string>();
    const origin = new URL(seedUrl).origin;

    for (let page = 0; page < maxPagesPerSeed && results.length < maxCandidates; page += 1) {
      if (visitedPages.has(currentUrl)) break;
      visitedPages.add(currentUrl);

      let response: Response;
      try {
        response = await fetchText(currentUrl, {
          headers: { 'user-agent': 'opportunist-research-agent/0.2' }
        });
      } catch {
        break;
      }

      const html = await response.text();
      const pageResults = seedCandidatesFromHtml(response.url, html);

      for (const item of pageResults) {
        const key = item.url.split('#')[0] ?? item.url;
        if (seenCandidates.has(key)) continue;
        seenCandidates.add(key);
        results.push(item);
        if (results.length >= maxCandidates) break;
      }

      if (results.length >= maxCandidates) break;

      const links = extractLinks(html, response.url);
      const next = links.find((link) => isNextPageLink(link, origin, response.url));
      if (!next) break;
      currentUrl = next.href;
    }
  }

  return results;
}
