import { fetchText } from './http.js';

const cache = new Map<string, { fetchedAt: number; rules: string[] }>();
const TTL_MS = 60 * 60 * 1000;

function pathRuleMatches(rule: string, path: string): boolean {
  if (!rule) return false;
  const escaped = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*').replace(/\\\$/g, '$');
  try { return new RegExp(`^${escaped}`).test(path); } catch { return false; }
}

export async function allowedByRobots(targetUrl: string, userAgent = 'OpportunistBot'): Promise<boolean> {
  const target = new URL(targetUrl);
  const origin = target.origin;
  const cached = cache.get(origin);
  let rules: string[];
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    rules = cached.rules;
  } else {
    try {
      const response = await fetchText(`${origin}/robots.txt`, { headers: { 'user-agent': userAgent } }, 10000);
      if (!response.ok) rules = [];
      else rules = parseRules(await response.text(), userAgent);
    } catch {
      rules = [];
    }
    cache.set(origin, { fetchedAt: Date.now(), rules });
  }
  return !rules.some((rule) => pathRuleMatches(rule, target.pathname + target.search));
}

function parseRules(text: string, userAgent: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => (line.split('#')[0] ?? '').trim())
    .filter(Boolean);
  const groups: Array<{ agents: string[]; disallow: string[] }> = [];
  let current: { agents: string[]; disallow: string[] } | null = null;
  let hasDirective = false;

  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!current || hasDirective) {
        current = { agents: [], disallow: [] };
        groups.push(current);
        hasDirective = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (key === 'disallow' && current) {
      current.disallow.push(value);
      hasDirective = true;
    } else if (key === 'allow') {
      hasDirective = true;
    }
  }

  const wanted = userAgent.toLowerCase();
  const selected = groups.filter((group) => group.agents.includes('*') || group.agents.some((agent) => wanted.includes(agent)));
  return selected.flatMap((group) => group.disallow).filter(Boolean);
}
