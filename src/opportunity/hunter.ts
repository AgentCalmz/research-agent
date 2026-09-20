import { randomUUID } from 'node:crypto';
import type { BrainProvider, Evidence, Opportunity } from '../core/types.js';
import type { SearchProvider, SearchResult } from '../discovery/search.js';
import { cleanHtml, fetchText } from '../runtime/http.js';
import { OpportunityStore } from '../runtime/store.js';
import { canonicalizeUrl, hostOf, normalizeText, sameEntity } from './entities.js';
import { candidateFromResult, defaultPlan, buildQueries } from './strategies.js';
import type { CandidateRecord, HuntMode, ResearchPlan } from './types.js';

const MAX_DISCOVERY_RESULTS_PER_QUERY = 8;
const SOCIAL_HOSTS = new Set(['instagram.com', 'facebook.com', 'linkedin.com', 'tiktok.com', 'x.com']);
const DIRECTORY_HINTS = /directory|yellowpages|businesslist|foursquare|tripadvisor|yelp|mapquest/i;

function evidence(url: string, sourceType: Evidence['source']['sourceType'], claim: string, excerpt?: string, confidence?: number): Evidence {
  return {
    claim,
    source: { url: canonicalizeUrl(url), sourceType, retrievedAt: new Date().toISOString() },
    excerpt: excerpt ? excerpt.slice(0, 280) : undefined,
    confidence
  };
}

function uniqueResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const result of results) {
    const url = canonicalizeUrl(result.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ...result, url });
  }
  return out;
}

function mergeCandidates(results: SearchResult[], mode: HuntMode, location?: string): CandidateRecord[] {
  const output: CandidateRecord[] = [];
  for (const result of uniqueResults(results)) {
    const base = candidateFromResult(result, mode, location);
    if (!base) continue;
    const candidate = base as Omit<CandidateRecord, 'id' | 'evidence' | 'status' | 'confidence' | 'score'>;
    const existing = output.find((item) => {
      if (item.kind !== candidate.kind) return false;
      if (candidate.kind === 'job') {
        const leftCompany = typeof item.facts.company === 'string' ? item.facts.company : '';
        const rightCompany = typeof candidate.facts.company === 'string' ? candidate.facts.company : '';
        const companyMatches = Boolean(leftCompany && rightCompany && normalizeText(leftCompany) === normalizeText(rightCompany));
        return companyMatches
          ? sameEntity({ name: item.name, location: item.location }, { name: candidate.name, location: candidate.location })
          : Boolean(item.name && candidate.name && normalizeText(item.name) === normalizeText(candidate.name) && item.location === candidate.location);
      }
      return sameEntity(
        { name: item.name, location: item.location, phone: typeof item.facts.phone === 'string' ? item.facts.phone : undefined },
        { name: candidate.name, location: candidate.location }
      );
    });
    if (existing) {
      existing.sources.push(result);
      continue;
    }
    output.push({
      ...candidate,
      id: randomUUID(),
      evidence: [evidence(result.url, result.source === 'duckduckgo' || result.source === 'searxng' ? 'search' : 'other', 'Candidate discovered from public web search.', result.snippet)],
      status: 'discovered',
      confidence: 0,
      score: 0
    });
  }
  return output;
}

async function parallelSearch(search: SearchProvider, queries: string[], limit: number): Promise<SearchResult[]> {
  const results = await Promise.all(queries.map(async (query) => {
    try {
      return await search.search(query, limit);
    } catch {
      return [];
    }
  }));
  return uniqueResults(results.flat());
}

function sourceKind(url: string): Evidence['source']['sourceType'] {
  const host = hostOf(url);
  if (SOCIAL_HOSTS.has(host) || /(^|\.)instagram\.|(^|\.)facebook\.|(^|\.)linkedin\.|(^|\.)tiktok\.|(^|\.)x\.com$/i.test(host)) return 'social';
  if (DIRECTORY_HINTS.test(host)) return 'directory';
  return 'website';
}

function looksLikeIndependentWebsite(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (SOCIAL_HOSTS.has(host)) return false;
  if (/google\.|bing\.|duckduckgo\.|youtube\.|wikipedia\./i.test(host)) return false;
  if (DIRECTORY_HINTS.test(host)) return false;
  return true;
}

function nameMatch(candidateName: string, pageText: string): number {
  const tokens = normalizeText(candidateName).split(' ').filter((token) => token.length >= 3);
  if (!tokens.length) return 0;
  const normalized = normalizeText(pageText);
  return tokens.filter((token) => normalized.includes(token)).length / tokens.length;
}

function extractContacts(text: string): { phones: string[]; emails: string[] } {
  return {
    phones: [...new Set(text.match(/(?:\+?234|0)[ -]?(?:7\d{2}|8\d{2}|9\d{2})[ -]?\d{3}[ -]?\d{4}/g) ?? [])],
    emails: [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])]
  };
}

function extractCompany(title: string): string | undefined {
  const match = title.match(/\b(?:at|@)\s+(.+)$/i);
  return match?.[1]?.trim();
}

function extractDate(text: string): Date | undefined {
  const patterns = [
    /(?:posted|published|updated|date posted|closing date)\D{0,30}(\d{1,2}\s+[A-Za-z]{3,9}\s+202\d)/i,
    /\b(20\d{2}-\d{2}-\d{2})\b/,
    /\b([A-Za-z]{3,9}\s+\d{1,2},\s+20\d{2})\b/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const date = new Date(match[1]);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  return undefined;
}

function scoreJob(candidate: CandidateRecord, sourceCount: number, fresh: boolean, hasApply: boolean): number {
  let score = 4;
  if (sourceCount >= 2) score += 1.5;
  if (fresh) score += 2;
  if (hasApply) score += 1;
  if (candidate.facts.company) score += 0.5;
  if (candidate.facts.location) score += 0.5;
  return Math.min(10, Number(score.toFixed(1)));
}

async function verifyJob(candidate: CandidateRecord, plan: ResearchPlan, search: SearchProvider): Promise<CandidateRecord> {
  const query = `"${candidate.title || candidate.name}" ${candidate.facts.company ? `"${candidate.facts.company}" ` : ''}${plan.location || ''}`;
  const results = await parallelSearch(search, [query, `"${candidate.name}" ${plan.location || ''} apply`], 4);
  const sources = uniqueResults([...candidate.sources, ...results]);
  const evidenceItems = [...candidate.evidence];
  let combinedText = '';

  const fetchTargets = sources
    .filter((result) => !SOCIAL_HOSTS.has(hostOf(result.url)))
    .slice(0, 2);

  for (const result of fetchTargets) {
    try {
      const response = await fetchText(result.url);
      const html = await response.text();
      const text = cleanHtml(html, 7000);
      combinedText += ` ${text}`;
      evidenceItems.push(evidence(response.url, sourceKind(response.url), 'Job listing page was reachable.', text.slice(0, 280), 0.8));
    } catch {
      // Search evidence remains usable when a page blocks fetching.
    }
  }

  const company = candidate.facts.company || extractCompany(candidate.title || candidate.name);
  const postedAt = extractDate(combinedText);
  const fresh = postedAt ? ((Date.now() - postedAt.getTime()) / 86400000 <= plan.freshnessDays) : false;
  const applySignal = /apply now|apply|submit (?:cv|resume)|careers portal/i.test(combinedText);
  if (company) evidenceItems.push(evidence(candidate.sourceUrl, 'search', `Employer identified as ${company}.`, undefined, 0.8));
  if (fresh) evidenceItems.push(evidence(candidate.sourceUrl, 'search', `Posting appears within the requested ${plan.freshnessDays}-day freshness window.`, undefined, 0.8));
  if (applySignal) evidenceItems.push(evidence(candidate.sourceUrl, 'website', 'Page contains an application signal.', undefined, 0.75));

  return {
    ...candidate,
    sources,
    facts: {
      ...candidate.facts,
      company,
      postedAt: postedAt?.toISOString(),
      hasApply: applySignal
    },
    evidence: evidenceItems,
    status: sources.length >= 2 ? 'verified' : 'uncertain',
    confidence: Math.min(1, 0.45 + Math.min(0.25, sources.length * 0.08) + (company ? 0.12 : 0) + (fresh ? 0.12 : 0)),
    score: scoreJob(candidate, sources.length, fresh, applySignal)
  };
}

async function verifyBusiness(candidate: CandidateRecord, plan: ResearchPlan, search: SearchProvider): Promise<CandidateRecord> {
  const location = plan.location || '';
  const name = candidate.name;
  const queries = [
    `"${name}" "${location}" official website`,
    `"${name}" "${location}" phone`,
    `"${name}" "${location}" Instagram OR Facebook`
  ];
  const results = await parallelSearch(search, queries, 4);
  const sources = uniqueResults([...candidate.sources, ...results]);
  const evidenceItems = [...candidate.evidence];
  let socialUrls: string[] = [];
  let reachableIndependent = false;
  let independentCandidateUrls: string[] = [];
  let publicContact = false;
  let matchedWebsiteUrl: string | undefined;
  let combinedText = '';

  for (const result of sources.slice(0, 10)) {
    const kind = sourceKind(result.url);
    if (kind === 'social') socialUrls.push(result.url);
    if (!looksLikeIndependentWebsite(result.url)) continue;
    independentCandidateUrls.push(result.url);
    try {
      const response = await fetchText(result.url);
      const html = await response.text();
      const text = cleanHtml(html, 6000);
      combinedText += ` ${text}`;
      const contacts = extractContacts(text);
      if (contacts.phones.length || contacts.emails.length) publicContact = true;
      if (response.ok && nameMatch(name, text) >= 0.55) {
        reachableIndependent = true;
        matchedWebsiteUrl = response.url;
        evidenceItems.push(evidence(response.url, 'website', 'A reachable page matches the candidate business name strongly enough to count as an independent-site signal.', text.slice(0, 280), 0.9));
      }
    } catch {
      // Unreachable/blocked pages are not treated as proof of absence.
    }
    if (matchedWebsiteUrl) break;
  }

  const independentSources = new Set(sources.map((result) => hostOf(result.url)).filter(Boolean)).size;
  const socialOnly = socialUrls.length > 0 && !reachableIndependent;
  const noIndependentWebsite = !reachableIndependent && socialOnly && independentSources >= 2;

  if (socialOnly) evidenceItems.push(evidence(socialUrls[0]!, 'social', 'Public social presence discovered while no matching independent site was verified.', undefined, 0.75));
  if (publicContact) evidenceItems.push(evidence(candidate.sourceUrl, 'directory', 'Public contact information was found during local verification.', undefined, 0.75));
  if (independentSources >= 2) evidenceItems.push(evidence(candidate.sourceUrl, 'search', 'Candidate is supported by multiple independent source hosts.', undefined, 0.8));

  const score = Math.min(10, Number((
    (noIndependentWebsite ? 4 : 0) +
    (socialOnly ? 2 : 0) +
    (publicContact ? 1.5 : 0) +
    (independentSources >= 2 ? 1.5 : 0) +
    Math.min(1, nameMatch(name, combinedText))
  ).toFixed(1)));

  return {
    ...candidate,
    sources,
    facts: {
      ...candidate.facts,
      socialUrls: socialUrls.join(','),
      candidateWebsiteUrls: independentCandidateUrls.join(','),
      matchedWebsiteUrl,
      publicContact,
      socialOnly,
      noIndependentWebsite
    },
    evidence: evidenceItems,
    status: reachableIndependent ? 'verified' : noIndependentWebsite ? 'verified' : 'uncertain',
    confidence: Math.min(1, reachableIndependent ? 0.95 : noIndependentWebsite ? 0.7 : 0.45),
    score
  };
}

function compactCandidate(candidate: CandidateRecord): string {
  return JSON.stringify({
    id: candidate.id,
    kind: candidate.kind,
    name: candidate.name,
    title: candidate.title,
    location: candidate.location,
    facts: candidate.facts,
    score: candidate.score,
    confidence: candidate.confidence,
    status: candidate.status,
    sources: candidate.sources.slice(0, 5).map((s) => ({ title: s.title, url: s.url })),
    evidence: candidate.evidence.slice(-6).map((e) => ({ claim: e.claim, url: e.source.url, excerpt: e.excerpt }))
  });
}

const PLAN_TOOL = {
  name: 'set_research_plan',
  description: 'Convert the objective into a compact research plan. Use one of jobs, business_website_gap, or general.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['jobs', 'business_website_gap', 'general'] },
      location: { type: 'string' },
      roles: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      categories: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      candidate_limit: { type: 'integer', minimum: 10, maximum: 60 },
      verify_limit: { type: 'integer', minimum: 4, maximum: 20 },
      freshness_days: { type: 'integer', minimum: 1, maximum: 3650 },
      verification_depth: { type: 'string', enum: ['quick', 'standard', 'deep'] }
    },
    required: ['mode']
  }
} as const;

function sanitizePlan(request: string, args: Record<string, unknown>): ResearchPlan {
  const fallback = defaultPlan(request);
  const mode = args.mode === 'jobs' || args.mode === 'business_website_gap' || args.mode === 'general' ? args.mode : fallback.mode;
  const location = typeof args.location === 'string' && args.location.trim() ? args.location.trim() : fallback.location;
  const roles = Array.isArray(args.roles) ? args.roles.filter((v): v is string => typeof v === 'string').slice(0, 5) : fallback.roles;
  const categories = Array.isArray(args.categories) ? args.categories.filter((v): v is string => typeof v === 'string').slice(0, 5) : fallback.categories;
  const freshnessDays = Number(args.freshness_days);
  const candidateLimit = Number(args.candidate_limit);
  const verifyLimit = Number(args.verify_limit);
  const verificationDepth = args.verification_depth === 'quick' || args.verification_depth === 'deep' || args.verification_depth === 'standard'
    ? args.verification_depth
    : fallback.verificationDepth;
  return {
    mode,
    location,
    roles,
    categories,
    queries: buildQueries({ mode, location, roles, categories }).slice(0, mode === 'jobs' ? 6 : 6),
    candidateLimit: Number.isFinite(candidateLimit) ? Math.max(10, Math.min(60, Math.floor(candidateLimit))) : fallback.candidateLimit,
    verifyLimit: Number.isFinite(verifyLimit) ? Math.max(4, Math.min(20, Math.floor(verifyLimit))) : fallback.verifyLimit,
    sourceDomains: fallback.sourceDomains,
    freshnessDays: Number.isFinite(freshnessDays) ? Math.max(1, Math.min(3650, Math.floor(freshnessDays))) : fallback.freshnessDays,
    verificationDepth
  };
}

export class OpportunityHunter {
  constructor(
    private readonly brain: BrainProvider,
    private readonly search: SearchProvider,
    private readonly store: OpportunityStore
  ) {}

  async run(request: string): Promise<string> {
    const planResponse = await this.brain.complete({
      system: 'You are the planning brain for an autonomous opportunity hunter. Produce a compact plan only by calling set_research_plan. Do not browse the web yourself.',
      user: request,
      tools: [PLAN_TOOL]
    });

    const planArgs = planResponse.toolCalls[0]?.arguments ?? {};
    const plan = sanitizePlan(request, planArgs);
    const discovery = await parallelSearch(this.search, plan.queries, MAX_DISCOVERY_RESULTS_PER_QUERY);
    let candidates = mergeCandidates(discovery, plan.mode, plan.location).slice(0, plan.candidateLimit);

    if (!candidates.length) {
      return `No viable candidates were discovered for this objective. Strategy used: ${plan.mode}.`;
    }

    const toVerify = candidates.slice(0, Math.min(plan.verifyLimit, candidates.length));
    const verified = await Promise.all(toVerify.map((candidate) =>
      plan.mode === 'jobs'
        ? verifyJob(candidate, plan, this.search)
        : plan.mode === 'business_website_gap'
          ? verifyBusiness(candidate, plan, this.search)
          : verifyJob(candidate, plan, this.search)
    ));

    candidates = [...verified, ...candidates.slice(toVerify.length)]
      .sort((a, b) => (b.score * b.confidence) - (a.score * a.confidence));

    const opportunities: Opportunity[] = candidates
      .filter((candidate) => candidate.status !== 'rejected')
      .slice(0, Math.min(20, candidates.length))
      .map((candidate) => ({
        id: candidate.id,
        title: candidate.title || candidate.name,
        description: candidate.kind === 'job'
          ? `Job opportunity at ${candidate.facts.company || 'an identified employer'}.`
          : candidate.facts.noIndependentWebsite
            ? 'Potential website/digital-presence opportunity supported by public evidence.'
            : 'Potential business opportunity supported by public evidence.',
        score: candidate.score,
        entities: {
          name: candidate.name,
          title: candidate.title,
          location: candidate.location,
          ...candidate.facts
        },
        evidence: candidate.evidence.slice(-10)
      }));

    await Promise.all(opportunities.map((opportunity) => this.store.save(opportunity)));

    const evidenceEnvelope = candidates.slice(0, 12).map(compactCandidate).join('\n');
    const finalResponse = await this.brain.complete({
      system: `You are the final decision and synthesis brain. Do not invent missing facts. Use only the compact evidence envelope supplied below. Return useful, source-linked results. Distinguish verified facts from uncertain signals. For jobs, include application URLs when present. For business website-gap opportunities, explain why the evidence supports the digital gap and list public contact/source URLs.\n\nEvidence envelope:\n${evidenceEnvelope}`,
      user: request,
      tools: []
    });

    return finalResponse.text || candidates.slice(0, 10).map(compactCandidate).join('\n');
  }
}
