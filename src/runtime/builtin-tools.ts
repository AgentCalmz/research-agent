import type { ToolRegistry } from './tools.js';
import { cleanHtml, fetchText } from './http.js';

export function registerBuiltinTools(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: 'fetch_url',
    description: 'Fetch a public HTTP(S) URL and return page text and metadata for evidence gathering.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public HTTP or HTTPS URL to fetch' },
        max_chars: { type: 'integer', minimum: 1000, maximum: 30000, default: 12000 }
      },
      required: ['url']
    },
    execute: async (args) => {
      const url = String(args.url);
      const maxChars = Math.min(Number(args.max_chars ?? 12000), 30000);
      const response = await fetchText(url);
      const contentType = response.headers.get('content-type') ?? '';
      const body = await response.text();
      return {
        requestedUrl: url,
        finalUrl: response.url,
        status: response.status,
        ok: response.ok,
        contentType,
        text: cleanHtml(body, maxChars)
      };
    }
  });

  registry.register({
    name: 'check_website',
    description: 'Check a public website candidate. Uses HEAD first and falls back to GET because some valid sites reject HEAD. Failure is evidence of unreachability, not proof of absence.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Website URL to check' } },
      required: ['url']
    },
    execute: async (args) => {
      const url = String(args.url);
      try {
        const head = await fetchText(url, { method: 'HEAD' }, 10000);
        if (head.ok) return { url, reachable: true, status: head.status, finalUrl: head.url, method: 'HEAD' };
      } catch { /* fall through to GET */ }
      try {
        const get = await fetchText(url, { method: 'GET' }, 10000);
        return { url, reachable: get.ok, status: get.status, finalUrl: get.url, method: 'GET' };
      } catch (error) {
        return { url, reachable: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  });

  return registry;
}
