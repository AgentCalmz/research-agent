import { ToolRegistry } from './tools.js';

export function registerBuiltinTools(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: 'fetch_url',
    description: 'Fetch a public HTTP(S) URL and return basic page text and metadata. Use this for evidence gathering.',
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
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are allowed');
      const response = await fetch(parsed, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
      const contentType = response.headers.get('content-type') ?? '';
      const body = await response.text();
      const maxChars = Math.min(Number(args.max_chars ?? 12000), 30000);
      return {
        requestedUrl: url,
        finalUrl: response.url,
        status: response.status,
        ok: response.ok,
        contentType,
        text: body.replace(/<script[\\s\\S]*?<\\/script>/gi, ' ').replace(/<style[\\s\\S]*?<\\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, maxChars)
      };
    }
  });

  registry.register({
    name: 'check_website',
    description: 'Check whether a business website candidate responds. This is evidence only; a failed request does not by itself prove that a business has no website.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Website URL to check' } },
      required: ['url']
    },
    execute: async (args) => {
      const url = String(args.url);
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are allowed');
      try {
        const response = await fetch(parsed, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10000) });
        return { url, reachable: response.ok, status: response.status, finalUrl: response.url };
      } catch (error) {
        return { url, reachable: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  });

  return registry;
}
