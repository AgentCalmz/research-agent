import { randomUUID } from 'node:crypto';
import type { BrainProvider, Evidence, Opportunity } from '../core/types.js';
import type { SearchProvider, SearchResult } from '../discovery/search.js';
import { cleanHtml, fetchText } from '../runtime/http.js';
import { OpportunityStore } from '../runtime/store.js';
import { canonicalizeUrl, hostOf, normalizeText, sameEntity } from './entities.js';
import { isJobListingUrl, isLikelyJobListing, looksLikeIndependentBusinessSite } from './source-policy.js';
import { candidateFromResult, defaultPlan, buildQueries } from './strategies.js';
import type { CandidateRecord, HuntMode, ResearchPlan } from './types.js';

const MAX_DISCOVERY_RESULTS_PER_QUERY = 8;
const SOCIAL_HOSTS = new Set(['instagram.com', 'facebook.com', 'linkedin.com', 'tiktok.com', 'x.com']);
const DIRECTORY_HINTS = /directory|yellowpages|businesslist|foursquare|tripadvisor|yelp|mapquest|geoleads/i;

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
  return looksLikeIndependentBusinessSite(url);
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

function extractCompany(text: string): string | undefined {
  const direct = text.match(/\b(?:at|@)\s+([A-Z][A-Za-z0-9&.' -]{2,80}?)(?:\.|\s+is\s+|\s+to\s+)/i);
  if (direct?.[1]) return direct[1].trim();

  const recruiting = text.match(/([A-Z][A-Za-z0-9&.' -]{2,80}?)\s+is\s+(?:recruiting|hiring)\b/i);
  if (recruiting?.[1]) return recruiting[1].trim();

  const position = text.match(/([A-Z][A-Za-z0-9&.' -]{2,80}?)\s+is\s+recruiting\s+to\s+fill\s+the\s+position/i);
  return position?.[1]?.trim();
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

function scoreJob(candidate: CandidateRecord, sourceCount: number, fresh: boolean, hasApply: boolean, roleMatch: boolean, skillsMatch: boolean, preferenceMatch: boolean, experienceMatch: boolean): number {
  let score = 3.5;
  if (sourceCount >= 2) score += 1.5;
  if (fresh) score += 2;
  if (hasApply) score += 0.8;
  if (candidate.facts.company) score += 0.4;
  if (roleMatch) score += 0.9;
  if (skillsMatch) score += 0.9;
  if (preferenceMatch) score += 0.7;
  if (experienceMatch) score += 0.6;
  return Math.min(10, Number(score.toFixed(1)));
}

async function verifyJob(candidate: CandidateRecord, plan: ResearchPlan, search: SearchProvider): Promise<CandidateRecord> {
  const query = `"${candidate.title || candidate.name}" ${candidate.facts.company ? `"${candidate.facts.company}" ` : ''}${plan.location || ''}`;
  const results = await parallelSearch(search, [query, `"${candidate.name}" ${plan.location || ''} apply`], 4);
  const sources = uniqueResults([...candidate.sources, ...results]);
  const evidenceItems = [...candidate.evidence];
  let combinedText = sources.map((result) => result.snippet || '').join(' ');

  const fetchTargets = sources.filter((result) => isLikelyJobListing(result.url, result.title, result.snippet)).slice(0, 1);

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

  const company = candidate.facts.company || extractCompany(combinedText) || extractCompany(candidate.title || candidate.name);
  const postedAt = extractDate(combinedText);
  const fresh = postedAt ? ((Date.now() - postedAt.getTime()) / 86400000 <= plan.freshnessDays) : false;
  const applySignal = /apply now|apply|submit (?:cv|resume)|careers portal|how to apply|send (?:your )?(?:cv|resume)/i.test(combinedText);
  const directListing = isLikelyJobListing(candidate.sourceUrl, candidate.title || candidate.name, candidate.sources[0]?.snippet);
  const jobContentSignal = /(?:responsibilit|requirements?|qualifications?|experience|how to apply|apply now|recruiting|vacancy|position|job description)/i.test(combinedText);
  const roleTokens = plan.roles.flatMap((role) => normalizeText(role).split(' ').filter((token) => token.length >= 3));
  const skillTokens = plan.skills.flatMap((skill) => normalizeText(skill).split(' ').filter((token) => token.length >= 3));
  const normalizedJob = normalizeText(candidate.title || candidate.name);
  const normalizedEvidence = normalizeText(combinedText);
  const roleMatch = roleTokens.length > 0 && roleTokens.filter((token) => normalizedJob.includes(token) || normalizedEvidence.includes(token)).length / roleTokens.length >= 0.5;
  const skillsMatch = skillTokens.length > 0 && skillTokens.filter((token) => normalizedJob.includes(token) || normalizedEvidence.includes(token)).length / skillTokens.length >= 0.5;
  const preferenceMatch = plan.workPreference === 'any' || normalizedEvidence.includes(plan.workPreference || '') || normalizedJob.includes(plan.workPreference || '');
  const experienceMatch = !plan.experienceLevel || normalizedEvidence.includes(normalizeText(plan.experienceLevel)) || normalizedJob.includes(normalizeText(plan.experienceLevel));
  const excluded = plan.excludeTerms.some((term) => normalizedJob.includes(normalizeText(term)) || normalizedEvidence.includes(normalizeText(term)));
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
      hasApply: applySignal,
      roleMatch,
      skillsMatch,
      preferenceMatch,
      experienceMatch,
      excluded
    },
    evidence: evidenceItems,
    status: excluded ? 'rejected' : directListing && jobContentSignal && company ? 'verified' : 'uncertain',
    confidence: excluded ? 0 : Math.min(1, 0.45 + (directListing && jobContentSignal ? 0.2 : 0) + Math.min(0.2, sources.length * 0.06) + (company ? 0.12 : 0) + (fresh ? 0.12 : 0) + (skillsMatch ? 0.08 : 0)),
    score: excluded ? 0 : scoreJob(candidate, sources.length, fresh, applySignal, roleMatch, skillsMatch, preferenceMatch, experienceMatch)
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
  let combinedText = sources.map((result) => result.snippet || '').join(' ');

  for (const result of sources.slice(0, 10)) {
    const genericPage = /top\s+\d+|best\s+\d+|without websites|businesses without websites|directory|category|list of/i.test(result.title || '') ||
      /without websites|directory|category|list of/i.test(result.snippet || '');
    const kind = sourceKind(result.url);
    if (kind === 'social') socialUrls.push(result.url);
    if (genericPage || !looksLikeIndependentWebsite(result.url)) continue;
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

function renderDeterministicResults(candidates: CandidateRecord[], mode: HuntMode, requestedCount: number): string {
  const verified = candidates.filter((candidate) => candidate.status === 'verified' && candidate.confidence >= 0.6).slice(0, Math.min(requestedCount, 20));
  if (!verified.length) {
    return [
      '## Result: insufficient verified evidence — objective not met',
      '',
      `No qualifying ${mode === 'jobs' ? 'job listings' : 'opportunities'} reached the verification threshold.`,
      'The engine deliberately withheld weak candidates rather than presenting profiles, directories, or unsupported claims as opportunities.'
    ].join('\n');
  }

  return [
    `## Verified opportunities (${verified.length})`,
    '',
    ...verified.map((candidate, index) => {
      const facts = candidate.facts;
      const sourceUrls = [...new Set(candidate.sources.map((source) => source.url))].slice(0, 4);
      const evidenceUrls = [...new Set(candidate.evidence.map((item) => item.source.url))].slice(0, 6);
      const contacts = [facts.phones ? `Phones: ${facts.phones}` : '', facts.emails ? `Emails: ${facts.emails}` : ''].filter(Boolean);
      return [
        `### ${index + 1}. ${candidate.title || candidate.name}`,
        candidate.kind === 'job' ? `Company: ${facts.company || 'Not verified'}` : `Business: ${candidate.name}`,
        candidate.location ? `Location: ${candidate.location}` : '',
        facts.postedAt ? `Posted: ${facts.postedAt}` : '',
        `Opportunity score: ${candidate.score}/10`,
        `Confidence: ${Math.round(candidate.confidence * 100)}%`,
        contacts.join(' | '),
        candidate.kind === 'job' ? `Application/source: ${candidate.sourceUrl}` : `Source: ${candidate.sourceUrl}`,
        sourceUrls.length ? `Sources: ${sourceUrls.join(' | ')}` : '',
        evidenceUrls.length ? `Evidence: ${evidenceUrls.join(' | ')}` : ''
      ].filter(Boolean).join('\n');
    })
  ].join('\n\n');
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
      skills: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      categories: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      candidate_limit: { type: 'integer', minimum: 10, maximum: 60 },
      verify_limit: { type: 'integer', minimum: 4, maximum: 20 },
      freshness_days: { type: 'integer', minimum: 1, maximum: 3650 },
      verification_depth: { type: 'string', enum: ['quick', 'standard', 'deep'] },
      experience_level: { type: 'string' },
      work_preference: { type: 'string', enum: ['remote', 'hybrid', 'onsite', 'any'] },
      exclude_terms: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      requested_count: { type: 'integer', minimum: 1, maximum: 100 }
    },
    required: ['mode']
  }
} as const;

const REFINE_TOOL = {
  name: 'request_more_discovery',
  description: 'Request up to three new search angles only when the first pass did not produce enough strong opportunities.',
  parameters: {
    type: 'object',
    properties: {
      queries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 }
    },
    required: ['queries']
  }
} as const;

function sanitizePlan(request: string, args: Record<string, unknown>): ResearchPlan {
  const fallback = defaultPlan(request);
  const mode = args.mode === 'jobs' || args.mode === 'business_website_gap' || args.mode === 'general' ? args.mode : fallback.mode;
  const location = typeof args.location === 'string' && args.location.trim() ? args.location.trim() : fallback.location;
  const roles = Array.isArray(args.roles) ? args.roles.filter((v): v is string => typeof v === 'string').slice(0, 5) : fallback.roles;
  const skills = Array.isArray(args.skills) ? args.skills.filter((v): v is string => typeof v === 'string').slice(0, 8) : fallback.skills;
  const categories = Array.isArray(args.categories) ? args.categories.filter((v): v is string => typeof v === 'string').slice(0, 5) : fallback.categories;
  const freshnessDays = Number(args.freshness_days);
  const candidateLimit = Number(args.candidate_limit);
  const verifyLimit = Number(args.verify_limit);
  const verificationDepth = args.verification_depth === 'quick' || args.verification_depth === 'deep' || args.verification_depth === 'standard'
    ? args.verification_depth
    : fallback.verificationDepth;
  const experienceLevel = typeof args.experience_level === 'string' && args.experience_level.trim() ? args.experience_level.trim().toLowerCase() : fallback.experienceLevel;
  const workPreference = args.work_preference === 'remote' || args.work_preference === 'hybrid' || args.work_preference === 'onsite' || args.work_preference === 'any' ? args.work_preference : fallback.workPreference;
  const excludeTerms = Array.isArray(args.exclude_terms) ? args.exclude_terms.filter((v): v is string => typeof v === 'string').slice(0, 8) : fallback.excludeTerms;
  const requestedCount = Number(args.requested_count);
  const safeVerifyLimit = mode === 'jobs' ? 8 : 6;
  return {
    mode,
    location,
    roles,
    skills,
    categories,
    experienceLevel,
    workPreference,
    excludeTerms,
    queries: buildQueries({ mode, location, roles, skills, categories, workPreference }).slice(0, 6),
    candidateLimit: Number.isFinite(candidateLimit) ? Math.max(10, Math.min(60, Math.floor(candidateLimit))) : fallback.candidateLimit,
    verifyLimit: Number.isFinite(verifyLimit) ? Math.max(4, Math.min(safeVerifyLimit, Math.floor(verifyLimit))) : fallback.verifyLimit,
    sourceDomains: fallback.sourceDomains,
    freshnessDays: Number.isFinite(freshnessDays) ? Math.max(1, Math.min(3650, Math.floor(freshnessDays))) : fallback.freshnessDays,
    verificationDepth,
    requestedCount: Number.isFinite(requestedCount) ? Math.max(1, Math.min(100, Math.floor(requestedCount))) : fallback.requestedCount
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
    let verified = await Promise.all(toVerify.map((candidate) =>
      plan.mode === 'jobs'
        ? verifyJob(candidate, plan, this.search)
        : plan.mode === 'business_website_gap'
          ? verifyBusiness(candidate, plan, this.search)
          : verifyJob(candidate, plan, this.search)
    ));

    candidates = [...verified, ...candidates.slice(toVerify.length)]
      .sort((a, b) => (b.score * b.confidence) - (a.score * a.confidence));

    const strongTarget = Math.min(plan.requestedCount, 3);
    const strongCount = verified.filter((candidate) => candidate.status === 'verified' && candidate.confidence >= 0.65 && candidate.score >= 5).length;

    if (strongCount < strongTarget) {
      const refineResponse = await this.brain.complete({
        system: 'The first local discovery pass was weak. Request at most three genuinely different discovery queries. Do not repeat previous query wording.',
        user: [
          `Objective: ${request}`,
          `Mode: ${plan.mode}`,
          `Location: ${plan.location || '(not specified)'}`,
          'Already found candidate names:',
          candidates.slice(0, 8).map((candidate) => candidate.name).join(', ')
        ].join('\\n'),
        tools: [REFINE_TOOL]
      });
      const refineQueries = Array.isArray(refineResponse.toolCalls[0]?.arguments?.queries)
        ? refineResponse.toolCalls[0]!.arguments.queries.filter((value): value is string => typeof value === 'string').slice(0, 3)
        : [];
      if (refineQueries.length) {
        const extraResults = await parallelSearch(this.search, refineQueries, 6);
        const existingKeys = new Set(candidates.map((candidate) => `${candidate.kind}|${normalizeText(candidate.name)}|${normalizeText(String(candidate.facts.company || ''))}|${normalizeText(candidate.location || '')}`));
        const newCandidates = mergeCandidates(extraResults, plan.mode, plan.location)
          .filter((candidate) => !existingKeys.has(`${candidate.kind}|${normalizeText(candidate.name)}|${normalizeText(String(candidate.facts.company || ''))}|${normalizeText(candidate.location || '')}`))
          .slice(0, 2);
        const extraVerified = await Promise.all(newCandidates.map((candidate) =>
          plan.mode === 'jobs'
            ? verifyJob(candidate, plan, this.search)
            : verifyBusiness(candidate, plan, this.search)
        ));
        verified = [...verified, ...extraVerified];
        candidates = [...verified, ...candidates.slice(toVerify.length), ...newCandidates.filter((candidate) => !extraVerified.some((item) => item.id === candidate.id))]
          .sort((a, b) => (b.score * b.confidence) - (a.score * a.confidence));
      }
    }

    const opportunities: Opportunity[] = candidates
      .filter((candidate) => candidate.status === 'verified' && candidate.confidence >= 0.6)
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

    await Promise.all(opportunities.slice(0, Math.min(plan.requestedCount, 20)).map((opportunity) => this.store.save(opportunity)));

    const envelopeLimit = Math.min(20, Math.max(8, plan.requestedCount * 2));
    const evidenceEnvelope = candidates.slice(0, envelopeLimit).map(compactCandidate).join('\n');
    const finalResponse = await this.brain.complete({
      system: `You are the final decision and synthesis brain. Do not invent missing facts. Use only the compact evidence envelope supplied below. Return at most ${plan.requestedCount} opportunities. Prefer verified candidates; clearly label any uncertain candidate instead of presenting it as verified. For jobs, include employer, location, freshness, fit signals, and application/source URLs when present. For business website-gap opportunities, explain why the evidence supports the digital gap and list public contact/source URLs.\n\nEvidence envelope:\n${evidenceEnvelope}`,
      user: request,
      tools: []
    });

    const synthesized = finalResponse.text?.trim();
    if (synthesized && !/^\s*[{[]\"?id/i.test(synthesized)) return synthesized;
    return renderDeterministicResults(candidates, plan.mode, plan.requestedCount);
  }
}
