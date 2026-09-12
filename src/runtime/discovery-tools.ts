import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { Evidence, Source } from '../core/types.js';
import { classifyWebsiteStatus, makeOpportunity, type OpportunitySignals } from '../opportunity/scoring.js';
import { absoluteUrl, cleanHtml, fetchText } from './http.js';
import { allowedByRobots } from './robots.js';
import { OpportunityStore } from './store.js';
import type { ToolRegistry } from './tools.js';
import type { SearchProvider, SearchResult } from '../discovery/search.js';

function source(url: string, sourceType: Source['sourceType']): Source {
  return { url, sourceType, retrievedAt: new Date().toISOString() };
}

function extractLinks(base: string, html: string): string[] {
  const links: string[] = [];
  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
    const href = match[1];
    if (!href) continue;
    const url = absoluteUrl(base, href);
    if (url) links.push(url);
  }
  return [...new Set(links)];
}

function extractContacts(text: string): { phones: string[]; emails: string[] } {
  const emails = [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])];
  const phones = [...new Set(text.match(/(?:\+?234|0)[ -]?(?:7\d{2}|8\d{2}|9\d{2})[ -]?\d{3}[ -]?\d{4}/g) ?? [])];
  return { phones, emails };
}

export function registerDiscoveryTools(
  registry: ToolRegistry,
  search: SearchProvider,
  store: OpportunityStore
): ToolRegistry {
  registry.register({
    name: 'search_web',
    description: 'Search the public web for discovery. Prefer several narrowly targeted searches over one vague query.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 }
      },
      required: ['query']
    },
    execute: async (args) => search.search(String(args.query), Number(args.limit ?? 10))
  });

  registry.register({
    name: 'discover_businesses',
    description: 'Discover candidate businesses for a location and category using multiple public-web query patterns. Returns candidates with source URLs; it does not assert they lack websites.',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string' },
        category: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
      },
      required: ['location']
    },
    execute: async (args) => {
      const location = String(args.location);
      const category = String(args.category ?? 'businesses');
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
      const queries = [
        `${category} in ${location}`,
        `${category} ${location} contact phone`,
        `${category} ${location} Instagram OR Facebook`,
        `${category} ${location} directory`
      ];
      const merged = new Map<string, SearchResult>();
      for (const query of queries) {
        const results = await search.search(query, Math.min(15, limit));
        for (const result of results) if (!merged.has(result.url)) merged.set(result.url, result);
        if (merged.size >= limit * 2) break;
      }
      return [...merged.values()].slice(0, limit * 2);
    }
  });

  registry.register({
    name: 'crawl_site',
    description: 'Fetch a public site and inspect same-origin links within a strict page limit while respecting robots.txt. Never bypass authentication or CAPTCHAs.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_pages: { type: 'integer', minimum: 1, maximum: 8, default: 4 },
        max_chars: { type: 'integer', minimum: 1000, maximum: 20000, default: 8000 }
      },
      required: ['url']
    },
    execute: async (args) => {
      const start = String(args.url);
      const maxPages = Math.min(8, Math.max(1, Number(args.max_pages ?? 4)));
      const maxChars = Math.min(20000, Math.max(1000, Number(args.max_chars ?? 8000)));
      const origin = new URL(start).origin;
      const queue = [start];
      const queued = new Set(queue);
      const pages: Array<{ url: string; status: number; text: string }> = [];
      while (queue.length && pages.length < maxPages) {
        const current = queue.shift();
        if (!current) break;
        if (!(await allowedByRobots(current))) continue;
        const response = await fetchText(current);
        const html = await response.text();
        pages.push({ url: response.url, status: response.status, text: cleanHtml(html, maxChars) });
        for (const link of extractLinks(response.url, html)) {
          try {
            if (new URL(link).origin === origin && !queued.has(link)) {
              queued.add(link);
              queue.push(link);
            }
          } catch { /* ignore malformed links */ }
        }
      }
      return pages;
    }
  });

  registry.register({
    name: 'find_contact',
    description: 'Fetch a public page and extract likely business phone numbers and email addresses. Returns public contact signals only.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    },
    execute: async (args) => {
      const url = String(args.url);
      const response = await fetchText(url);
      const html = await response.text();
      return { url: response.url, status: response.status, ...extractContacts(cleanHtml(html, 30000)) };
    }
  });

  registry.register({
    name: 'find_social_profiles',
    description: 'Search for likely public social profiles for a business. A social profile is never treated as an independent website.',
    parameters: {
      type: 'object',
      properties: {
        business_name: { type: 'string' },
        location: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: 8 }
      },
      required: ['business_name', 'location']
    },
    execute: async (args) => {
      const name = String(args.business_name);
      const location = String(args.location);
      const limit = Math.min(10, Math.max(1, Number(args.limit ?? 8)));
      const queries = [
        `"${name}" ${location} site:instagram.com`,
        `"${name}" ${location} site:facebook.com`,
        `"${name}" ${location} site:linkedin.com`,
        `"${name}" ${location} social`
      ];
      const results: SearchResult[] = [];
      for (const query of queries) results.push(...await search.search(query, Math.ceil(limit / 2)));
      const seen = new Set<string>();
      return results.filter((r) => !seen.has(r.url) && seen.add(r.url)).slice(0, limit);
    }
  });

  registry.register({
    name: 'check_domain',
    description: 'Resolve a public domain name and return DNS reachability. DNS success is not proof a website is active.',
    parameters: {
      type: 'object',
      properties: { domain: { type: 'string' } },
      required: ['domain']
    },
    execute: async (args) => {
      const raw = String(args.domain).replace(/^https?:\/\//i, '').split('/')[0]?.trim();
      if (!raw) return { domain: '', resolves: false, error: 'Domain is empty' };
      try {
        const records = await lookup(raw, { all: true });
        return { domain: raw, resolves: true, addresses: records.map((r) => r.address) };
      } catch (error) {
        return { domain: raw, resolves: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  });

  registry.register({
    name: 'assess_website_presence',
    description: 'Classify website presence from candidate URLs, reachable URLs, and social evidence. Never treat a failed request alone as proof of absence.',
    parameters: {
      type: 'object',
      properties: {
        candidate_urls: { type: 'array', items: { type: 'string' } },
        reachable_urls: { type: 'array', items: { type: 'string' } },
        social_urls: { type: 'array', items: { type: 'string' } }
      },
      required: ['candidate_urls', 'reachable_urls', 'social_urls']
    },
    execute: async (args) => ({
      website_status: classifyWebsiteStatus({
        candidateUrls: (args.candidate_urls as string[]) ?? [],
        reachableUrls: (args.reachable_urls as string[]) ?? [],
        socialUrls: (args.social_urls as string[]) ?? []
      })
    })
  });

  registry.register({
    name: 'score_opportunity',
    description: 'Score a potential opportunity deterministically from evidence signals. Scores are capped at 10 and should not override contradictory evidence.',
    parameters: {
      type: 'object',
      properties: {
        no_independent_website: { type: 'boolean' },
        social_only: { type: 'boolean' },
        broken_website: { type: 'boolean' },
        active_presence: { type: 'boolean' },
        public_contact: { type: 'boolean' },
        established_business: { type: 'boolean' },
        multiple_independent_sources: { type: 'boolean' },
        website_found: { type: 'boolean' },
        evidence_confidence: { type: 'number', minimum: 0, maximum: 1 }
      }
    },
    execute: async (args) => {
      const signals: OpportunitySignals = {
        noIndependentWebsite: Boolean(args.no_independent_website),
        socialOnly: Boolean(args.social_only),
        brokenWebsite: Boolean(args.broken_website),
        activePresence: Boolean(args.active_presence),
        publicContact: Boolean(args.public_contact),
        establishedBusiness: Boolean(args.established_business),
        multipleIndependentSources: Boolean(args.multiple_independent_sources),
        websiteFound: Boolean(args.website_found),
        evidenceConfidence: Number(args.evidence_confidence ?? 0.5)
      };
      const opportunity = makeOpportunity({ id: randomUUID(), business: {}, description: 'Scored opportunity from supplied evidence signals.', evidence: [], signals });
      return { score: opportunity.score, signals };
    }
  });

  registry.register({
    name: 'save_opportunity',
    description: 'Persist a concrete opportunity locally with provenance. Save findings supported by returned source URLs.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        score: { type: 'number', minimum: 0, maximum: 10 },
        entities: { type: 'object' },
        evidence: { type: 'array', items: { type: 'object' } }
      },
      required: ['title', 'description', 'score', 'entities', 'evidence']
    },
    execute: async (args) => {
      const evidence = (args.evidence as Evidence[]).map((item) => ({
        ...item,
        source: { ...item.source, retrievedAt: item.source?.retrievedAt ?? new Date().toISOString() }
      }));
      const opportunity = {
        id: randomUUID(),
        title: String(args.title),
        description: String(args.description),
        score: Number(args.score),
        entities: (args.entities as Record<string, unknown>) ?? {},
        evidence
      };
      await store.save(opportunity);
      return opportunity;
    }
  });

  registry.register({
    name: 'list_opportunities',
    description: 'List locally saved opportunities from previous hunts.',
    parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } } },
    execute: async (args) => store.list(Math.min(100, Math.max(1, Number(args.limit ?? 25))))
  });

  return registry;
}

export { source };
