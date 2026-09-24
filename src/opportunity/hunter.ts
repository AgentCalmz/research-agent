import { randomUUID } from 'node:crypto';
import type { BrainProvider, Evidence, Opportunity } from '../core/types.js';
import type { SearchProvider, SearchResult } from '../discovery/search.js';
import { cleanHtml, fetchText, getRequestCount } from '../runtime/http.js';
import { OpportunityStore } from '../runtime/store.js';
import { canonicalizeUrl, hostOf, normalizePhone, normalizeText, sameEntity } from './entities.js';
import { isDirectoryUrl, isEditorialUrl, isJobListingUrl, isLikelyJobListing, looksLikeIndependentBusinessSite, isSocialUrl } from './source-policy.js';
import { candidateFromResult, defaultPlan, buildQueries } from './strategies.js';
import { discoverFromSeedUrls, extractSeedUrls, inferLocationFromSourceUrl } from './seed-source.js';
import type { CandidateRecord, HuntMode, ResearchPlan } from './types.js';

const MAX_DISCOVERY_RESULTS_PER_QUERY = 8;
const SOCIAL_HOSTS = new Set(['instagram.com', 'facebook.com', 'linkedin.com', 'tiktok.com', 'x.com']);
const DIRECTORY_HINTS = /directory|yellowpages|businesslist|foursquare|tripadvisor|yelp|mapquest|geoleads|nigeriapropertycentre/i;

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

function candidatesEquivalent(left: CandidateRecord, right: CandidateRecord): boolean {
  if (left.kind !== right.kind) return false;
  if (right.kind === 'job') {
    const leftCompany = typeof left.facts.company === 'string' ? left.facts.company : '';
    const rightCompany = typeof right.facts.company === 'string' ? right.facts.company : '';
    const companyMatches = Boolean(leftCompany && rightCompany && normalizeText(leftCompany) === normalizeText(rightCompany));
    return companyMatches
      ? sameEntity({ name: left.name, location: left.location }, { name: right.name, location: right.location })
      : Boolean(left.name && right.name && normalizeText(left.name) === normalizeText(right.name) && left.location === right.location);
  }
  return sameEntity(
    { name: left.name, location: left.location, phone: typeof left.facts.phone === 'string' ? left.facts.phone : undefined },
    { name: right.name, location: right.location }
  );
}

function mergeCandidates(results: SearchResult[], mode: HuntMode, location?: string): CandidateRecord[] {
  const output: CandidateRecord[] = [];
  for (const result of uniqueResults(results)) {
    const base = candidateFromResult(result, mode, location);
    if (!base) continue;
    const candidate = base as Omit<CandidateRecord, 'id' | 'evidence' | 'status' | 'confidence' | 'score'>;
    const existing = output.find((item) => candidatesEquivalent(item, candidate as CandidateRecord));
    if (existing) {
      if (!existing.sources.some((source) => canonicalizeUrl(source.url) === canonicalizeUrl(result.url))) existing.sources.push(result);
      continue;
    }
    output.push({
      ...candidate,
      id: randomUUID(),
      evidence: [evidence(
        result.url,
        result.source === 'duckduckgo' || result.source === 'searxng' ? 'search' : 'other',
        result.source === 'seed' ? 'Candidate enumerated from the user-supplied source page.' : 'Candidate discovered from public web search.',
        result.snippet
      )],
      status: 'discovered',
      confidence: 0,
      score: 0
    });
  }
  return output;
}

function mergeCandidateLists(existingCandidates: CandidateRecord[], discoveredCandidates: CandidateRecord[]): CandidateRecord[] {
  const output = [...existingCandidates];
  for (const discovered of discoveredCandidates) {
    const existing = output.find((candidate) => candidatesEquivalent(candidate, discovered));
    if (!existing) {
      output.push(discovered);
      continue;
    }
    for (const source of discovered.sources) {
      if (!existing.sources.some((current) => canonicalizeUrl(current.url) === canonicalizeUrl(source.url))) existing.sources.push(source);
    }
    for (const item of discovered.evidence) {
      if (!existing.evidence.some((current) => current.source.url === item.source.url && current.claim === item.claim)) existing.evidence.push(item);
    }
    for (const [key, value] of Object.entries(discovered.facts)) {
      if (existing.facts[key] === undefined && value !== undefined) existing.facts[key] = value;
    }
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

function extractHttpLinks(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
    const href = match[1];
    if (!href) continue;
    try {
      const url = new URL(href, baseUrl);
      if (!/^https?:$/i.test(url.protocol)) continue;
      urls.push(canonicalizeUrl(url.toString()));
    } catch {
      // Ignore malformed links.
    }
  }
  return [...new Set(urls)];
}

function isSearchEngineHost(url: string): boolean {
  return /(^|\.)google\.|(^|\.)bing\.|(^|\.)duckduckgo\.|(^|\.)yahoo\./i.test(hostOf(url));
}

function isIndependentCandidateUrl(url: string): boolean {
  return looksLikeIndependentWebsite(url) && !isSearchEngineHost(url);
}

function nameMatch(candidateName: string, pageText: string): number {
  const tokens = normalizeText(candidateName).split(' ').filter((token) => token.length >= 3);
  if (!tokens.length) return 0;
  const normalized = normalizeText(pageText);
  return tokens.filter((token) => normalized.includes(token)).length / tokens.length;
}

function extractContacts(text: string): { phones: string[]; emails: string[] } {
  const phones = [...new Set(text.match(/(?:\+?234|0)[ -]?(?:7\d{2}|8\d{2}|9\d{2})[ -]?\d{3}[ -]?\d{4}/g) ?? [])];
  const emails = [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])]
    .filter((email) => !/^(?:anonymous|example|test|demo|sample|noreply|no-reply)@/i.test(email))
    .filter((email) => !/(?:^|\.)example\.(?:com|org|net)$/i.test(email.split('@')[1] || ''))
    .filter((email) => !/^anonymous\.[a-z]{2,}$/i.test(email.split('@')[1] || ''));
  return { phones, emails };
}

async function brainCompleteWithRetry(
  brain: BrainProvider,
  input: Parameters<BrainProvider['complete']>[0]
): Promise<Awaited<ReturnType<BrainProvider['complete']>> | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await brain.complete(input);
    } catch {
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
  return null;
}

function extractCompany(text: string): string | undefined {
  const labeled = text.match(/\b(?:company|employer|company name|employer name)\s*[:\-]\s*([A-Z][A-Za-z0-9&.' -]{2,80}?)(?=\s{2,}|\.|$)/i);
  if (labeled?.[1]) return labeled[1].trim();

  const recruiting = text.match(/([A-Z][A-Za-z0-9&.' -]{2,80}?)\s+is\s+(?:recruiting|hiring)\b/i);
  if (recruiting?.[1]) return recruiting[1].trim();

  const position = text.match(/([A-Z][A-Za-z0-9&.' -]{2,80}?)\s+is\s+recruiting\s+to\s+fill\s+the\s+position/i);
  return position?.[1]?.trim();
}

function extractDate(text: string): Date | undefined {
  const normalized = text.replace(/\s+/g, ' ');

  const relative = normalized.match(/\b(?:posted|published)\s*:?\s*(today|yesterday|\d+\s+(?:hours?|days?|weeks?|months?)\s+ago)\b/i)?.[1];
  if (relative) {
    const now = new Date();
    const value = relative.toLowerCase();
    if (value === 'today') return now;
    if (value === 'yesterday') return new Date(now.getTime() - 86400000);
    const amount = Number(value.match(/\d+/)?.[0] || 0);
    if (value.includes('hour')) return new Date(now.getTime() - amount * 3600000);
    if (value.includes('day')) return new Date(now.getTime() - amount * 86400000);
    if (value.includes('week')) return new Date(now.getTime() - amount * 7 * 86400000);
    if (value.includes('month')) return new Date(now.getTime() - amount * 30 * 86400000);
  }

  const labeledPatterns = [
    /\b(?:posted|published)\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+20\d{2})/i,
    /\b(?:posted|published)\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},\s+20\d{2})/i,
    /\b(?:posted|published)\s*:?\s*(20\d{2}-\d{2}-\d{2})/i,
    /\b(?:date posted|publication date)\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+20\d{2})/i,
    /\b(?:date posted|publication date)\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},\s+20\d{2})/i
  ];

  for (const pattern of labeledPatterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      const date = new Date(match[1]);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }

  return undefined;
}

function extractJobLocation(text: string): string | undefined {
  const match = text.match(/\b(?:location|locations?|job location)\s*:?\s*([A-Za-z][A-Za-z0-9 ,&/()'–—-]{2,80}?)(?=\s+(?:job field|job type|qualification|experience|deadline|method of application|requirements|responsibilities|salary|method of application)\b|[.;]|$)/i);
  if (match?.[1]) return match[1].replace(/\s+/g, ' ').trim();
  const remote = text.match(/\b(?:location|work location)\s*:?\s*((?:fully\s+)?remote(?:\s+in\s+Nigeria)?|Nigeria(?:\s+remote)?)\b/i)?.[1];
  return remote?.trim();
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

function extractApplicationUrl(html: string, baseUrl: string): string | undefined {
  const matches = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const preferred = matches.find((match) => {
    const label = cleanHtml(match[2] || '', 240);
    return /\b(?:apply|application|apply now|submit application|careers)\b/i.test(label);
  });
  const fallback = matches.find((match) => {
    const label = cleanHtml(match[2] || '', 240);
    const href = match[1] || '';
    return /\b(?:go to|company website|employer|official site)\b/i.test(label) && href;
  });
  const href = preferred?.[1] || fallback?.[1];
  if (!href) return undefined;
  try {
    const url = new URL(href, baseUrl);
    if (!/^https?:$/.test(url.protocol)) return undefined;
    return canonicalizeUrl(url.toString());
  } catch {
    return undefined;
  }
}

async function verifyJob(candidate: CandidateRecord, plan: ResearchPlan, search: SearchProvider): Promise<CandidateRecord> {
  const query = `"${candidate.title || candidate.name}" ${candidate.facts.company ? `"${candidate.facts.company}" ` : ''}${plan.location || ''}`;
  const results = await parallelSearch(search, [query], 8);
  const listingResults = results.filter((result) => isLikelyJobListing(result.url, result.title, result.snippet));
  const sources = uniqueResults([...candidate.sources, ...listingResults]);
  const listingSources = sources.filter((result) => isLikelyJobListing(result.url, result.title, result.snippet));
  const evidenceItems = [...candidate.evidence];
  let combinedText = listingSources.map((result) => result.snippet || '').join(' ');
  let applicationUrl: string | undefined;

  const fetchTargets = listingSources.slice(0, 2);
  for (const result of fetchTargets) {
    try {
      const response = await fetchText(result.url);
      const html = await response.text();
      const text = cleanHtml(html, 7000);
      combinedText += ` ${text}`;
      applicationUrl ||= extractApplicationUrl(html, response.url);
      evidenceItems.push(evidence(response.url, sourceKind(response.url), 'Job listing page was reachable.', text.slice(0, 280), 0.8));
    } catch {
      // Search evidence remains usable when a page blocks fetching.
    }
  }

  const company = candidate.facts.company || extractCompany(combinedText) || extractCompany(candidate.title || candidate.name);
  const cleanedCompany = typeof company === 'string'
    ? company
        .replace(/\s*,\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+20\d{2}\s*$/i, '')
        .replace(/\s+\d{4}\s*$/i, '')
        .trim()
    : undefined;
  const companyLooksLikeUiText = typeof cleanedCompany === 'string' && /\b(hired in|sign up|similar job alerts|today|rest of nigeria)\b/i.test(cleanedCompany);
  const verifiedCompany = companyLooksLikeUiText ? undefined : cleanedCompany;
  const postedAt = extractDate(combinedText);
  const ageDays = postedAt ? (Date.now() - postedAt.getTime()) / 86400000 : undefined;
  const fresh = ageDays !== undefined && ageDays >= 0 && ageDays <= plan.freshnessDays;
  const jobLocation = extractJobLocation(combinedText);
  const applySignal = /apply now|apply|submit (?:cv|resume)|careers portal|how to apply|send (?:your )?(?:cv|resume)/i.test(combinedText);
  const jobContacts = extractContacts(combinedText);
  const directListing = isLikelyJobListing(candidate.sourceUrl, candidate.title || candidate.name, candidate.sources[0]?.snippet);
  const jobContentSignal = /(?:responsibilit|requirements?|qualifications?|experience|how to apply|apply now|recruiting|vacancy|position|job description)/i.test(combinedText);
  const roleTokens = plan.roles.flatMap((role) => normalizeText(role).split(' ').filter((token) => token.length >= 3));
  const skillTokens = plan.skills.flatMap((skill) => normalizeText(skill).split(' ').filter((token) => token.length >= 3));
  const normalizedJob = normalizeText(candidate.title || candidate.name);
  const normalizedEvidence = normalizeText(combinedText);
  const roleMatch = roleTokens.length > 0 && roleTokens.filter((token) => normalizedJob.includes(token) || normalizedEvidence.includes(token)).length / roleTokens.length >= 0.5;
  const skillsMatch = skillTokens.length > 0 && skillTokens.filter((token) => normalizedJob.includes(token) || normalizedEvidence.includes(token)).length / skillTokens.length >= 0.5;
  const remoteSignal = /\b(?:remote|work from home|fully remote)\b/i.test(normalizedEvidence) || /\b(?:remote|work from home|fully remote)\b/i.test(normalizedJob);
  const requestedAbuja = /\babuja\b/i.test(plan.location || '');
  const jobIsAbuja = /\babuja\b/i.test(jobLocation || '');
  const preferenceMatch = plan.workPreference === 'any'
    || (plan.workPreference === 'remote' && remoteSignal)
    || (plan.workPreference === 'hybrid' && /\bhybrid\b/i.test(normalizedEvidence))
    || (plan.workPreference === 'onsite' && /\bon[- ]site\b/i.test(normalizedEvidence))
    || (requestedAbuja && jobIsAbuja);
  const experienceMatch = !plan.experienceLevel || normalizedEvidence.includes(normalizeText(plan.experienceLevel)) || normalizedJob.includes(normalizeText(plan.experienceLevel));
  const excluded = plan.excludeTerms.some((term) => normalizedJob.includes(normalizeText(term)) || normalizedEvidence.includes(normalizeText(term)));
  const distinctListingHosts = new Set(listingSources.map((result) => hostOf(result.url)).filter(Boolean));
  if (verifiedCompany) evidenceItems.push(evidence(candidate.sourceUrl, 'search', `Employer identified as ${verifiedCompany}.`, undefined, 0.8));
  if (postedAt) evidenceItems.push(evidence(candidate.sourceUrl, 'search', `Posting date identified as ${postedAt.toISOString().slice(0, 10)}.`, undefined, fresh ? 0.85 : 0.65));
  if (fresh) evidenceItems.push(evidence(candidate.sourceUrl, 'search', `Posting appears within the requested ${plan.freshnessDays}-day freshness window.`, undefined, 0.8));
  if (applySignal) evidenceItems.push(evidence(candidate.sourceUrl, 'website', 'Page contains an application signal.', undefined, 0.75));

  return {
    ...candidate,
    location: jobLocation || candidate.location,
    sources: listingSources,
    facts: {
      ...candidate.facts,
      company: verifiedCompany,
      postedAt: postedAt?.toISOString(),
      jobLocation,
      hasApply: applySignal,
      applicationUrl: applicationUrl || candidate.sourceUrl,
      phones: jobContacts.phones.join(', '),
      emails: jobContacts.emails.join(', '),
      roleMatch,
      skillsMatch,
      preferenceMatch,
      experienceMatch,
      excluded,
      verifiedSourceCount: listingSources.length,
      verifiedSourceHosts: distinctListingHosts.size
    },
    evidence: evidenceItems,
    status: excluded
      ? 'rejected'
      : directListing && jobContentSignal && verifiedCompany && fresh
        ? 'verified'
        : postedAt && !fresh
          ? 'rejected'
          : 'uncertain',
    confidence: excluded
      ? 0
      : Math.min(
          0.95,
          0.45 +
          (directListing && jobContentSignal ? 0.2 : 0) +
          Math.min(0.12, Math.max(0, distinctListingHosts.size - 1) * 0.06) +
          (verifiedCompany ? 0.12 : 0) +
          (fresh ? 0.1 : 0) +
          (skillsMatch ? 0.05 : 0)
        ),
    score: excluded ? 0 : scoreJob(candidate, distinctListingHosts.size, fresh, applySignal, roleMatch, skillsMatch, preferenceMatch, experienceMatch)
  };
}
async function verifyBusiness(candidate: CandidateRecord, plan: ResearchPlan, search: SearchProvider): Promise<CandidateRecord> {
  const location = plan.location?.trim() || '';
  const name = candidate.name.trim();
  const seedProfile = canonicalizeUrl(candidate.sourceUrl);
  const seedHost = hostOf(seedProfile);

  const seedSourceText = candidate.sources
    .filter((source) => canonicalizeUrl(source.url) === seedProfile || hostOf(source.url) === seedHost)
    .map((source) => `${source.title || ''} ${source.snippet || ''}`)
    .join(' ');

  const seedContacts = extractContacts(seedSourceText);
  const knownPhones = [...seedContacts.phones];

  const websiteQueries = [
    `"${name}" "${location}" website`,
    `"${name}" "${location}" "official website"`,
    knownPhones[0] ? `"${name}" "${knownPhones[0]}" website` : `"${name}" "${location}" domain`,
    knownPhones[0] ? `"${knownPhones[0]}" website` : `"${name}" "${location}" "www."`
  ];
  const corroborationQueries = [
    `"${name}" "${location}" Instagram OR Facebook`,
    knownPhones[0] ? `"${name}" "${knownPhones[0]}"` : `"${name}" "${location}" phone address`,
    `"${name}" "${location}" contact`
  ];

  const [websiteResults, corroborationResults] = await Promise.all([
    parallelSearch(search, websiteQueries, 8),
    parallelSearch(search, corroborationQueries, 8)
  ]);
  const results = uniqueResults([...candidate.sources, ...websiteResults, ...corroborationResults]);
  const evidenceItems = [...candidate.evidence];

  const socialUrls = new Set<string>();
  const directoryUrls = new Set<string>();
  const otherWebUrls = new Set<string>();
  const candidateWebsiteUrls = new Set<string>();
  const matchedIdentityUrls = new Set<string>();
  const outboundWebsiteUrls = new Set<string>();

  let reachableIndependent = false;
  let matchedWebsiteUrl: string | undefined;
  let publicContact = seedContacts.phones.length > 0 || seedContacts.emails.length > 0;
  const contactPhones = [...seedContacts.phones];
  const contactEmails = [...seedContacts.emails];
  let websiteChecks = 0;
  let combinedText = seedSourceText;

  const sourceIdentity = (source: SearchResult): { strong: boolean; phoneMatch: boolean; nameScore: number } => {
    const text = `${source.title || ''} ${source.snippet || ''}`;
    const nameScore = nameMatch(name, text);
    const normalized = normalizeText(text);
    const phoneMatch = knownPhones.some((phone) => {
      const normalizedPhone = normalizePhone(phone);
      return Boolean(normalizedPhone && normalized.includes(normalizedPhone.slice(-10)));
    });
    const locationMatch = !location || normalizeText(text).includes(normalizeText(location));
    const strong = phoneMatch || nameScore >= 0.62 || (nameScore >= 0.48 && locationMatch);
    return { strong, phoneMatch, nameScore };
  };

  // Fetch the supplied profile directly. This is the primary identity/contact source,
  // but it is never counted as independent corroboration.
  try {
    const response = await fetchText(seedProfile);
    const html = await response.text();
    const text = cleanHtml(html, 10000);
    combinedText += ` ${text}`;

    const contacts = extractContacts(text);
    if (contacts.phones.length || contacts.emails.length) publicContact = true;
    contactPhones.push(...contacts.phones);
    contactEmails.push(...contacts.emails);
    knownPhones.push(...contacts.phones);

    const outbound = extractHttpLinks(html, response.url);
    for (const url of outbound) {
      const host = hostOf(url);
      if (!host || host === seedHost) continue;
      if (isSocialUrl(url)) {
        socialUrls.add(url);
      } else if (isDirectoryUrl(url) || isSearchEngineHost(url)) {
        directoryUrls.add(url);
      } else if (isIndependentCandidateUrl(url)) {
        outboundWebsiteUrls.add(url);
      }
    }

    evidenceItems.push(
      evidence(response.url, 'directory',
        'The supplied source profile was fetched directly and used as the primary identity/contact source.',
        text.slice(0, 300), 0.95)
    );
  } catch {
    evidenceItems.push(
      evidence(seedProfile, 'directory',
        'The supplied source profile was used as the primary identity source, but direct fetching was unavailable.',
        undefined, 0.65)
    );
  }

  for (const source of results) {
    if (canonicalizeUrl(source.url) === seedProfile) continue;
    const match = sourceIdentity(source);
    if (!match.strong) continue;

    const sourceText = `${source.title || ''} ${source.snippet || ''}`;
    matchedIdentityUrls.add(source.url);
    combinedText += ` ${sourceText}`;

    const contacts = extractContacts(sourceText);
    if (contacts.phones.length || contacts.emails.length) publicContact = true;
    contactPhones.push(...contacts.phones);
    contactEmails.push(...contacts.emails);
    knownPhones.push(...contacts.phones);

    if (isSocialUrl(source.url)) {
      socialUrls.add(source.url);
    } else if (isDirectoryUrl(source.url)) {
      directoryUrls.add(source.url);
    } else if (!isSearchEngineHost(source.url)) {
      otherWebUrls.add(source.url);
    }

    if (isIndependentCandidateUrl(source.url)) {
      candidateWebsiteUrls.add(source.url);
    }
  }

  // Re-scan outbound website links now that we have any additional phone identity signals.
  for (const url of outboundWebsiteUrls) candidateWebsiteUrls.add(url);

  const websiteTargets = [...candidateWebsiteUrls]
    .filter((url) => hostOf(url) !== seedHost)
    .slice(0, 4);

  for (const url of websiteTargets) {
    websiteChecks += 1;
    try {
      const response = await fetchText(url);
      const html = await response.text();
      const text = cleanHtml(html, 9000);
      const nameScore = nameMatch(name, text);
      const phoneMatch = knownPhones.some((phone) => {
        const normalizedPhone = normalizePhone(phone);
        const normalizedText = normalizeText(text);
        return Boolean(normalizedPhone && normalizedText.includes(normalizedPhone.slice(-10)));
      });
      const locationMatch = !location || normalizeText(text).includes(normalizeText(location));
      if (response.ok && (phoneMatch || nameScore >= 0.62 || (nameScore >= 0.48 && locationMatch))) {
        reachableIndependent = true;
        matchedWebsiteUrl = response.url;
        evidenceItems.push(
          evidence(response.url, 'website',
            'A reachable external website matches the agent/business identity.',
            text.slice(0, 300), 0.97)
        );
        break;
      }

      evidenceItems.push(
        evidence(url, 'website',
          'A possible external website was checked but did not produce a sufficiently strong identity match.',
          text.slice(0, 240), 0.72)
      );
    } catch {
      evidenceItems.push(
        evidence(url, 'website',
          'A possible external website was discovered but could not be reached during verification.',
          undefined, 0.55)
      );
    }
  }

  const socialHostSet = new Set([...socialUrls].map(hostOf).filter(Boolean).filter((host) => host !== seedHost));
  const directoryHostSet = new Set([...directoryUrls].map(hostOf).filter(Boolean).filter((host) => host !== seedHost));
  const otherWebHostSet = new Set([...otherWebUrls]
    .map(hostOf)
    .filter(Boolean)
    .filter((host) => host !== seedHost)
    .filter((host) => !isSearchEngineHost(`https://${host}`)));

  const independentIdentityHosts = new Set(
    [...matchedIdentityUrls]
      .map(hostOf)
      .filter((host) => host && host !== seedHost && !isSearchEngineHost(`https://${host}`))
  );

  const hasSocial = socialHostSet.size >= 1;
  const hasStrongSocial = [...socialUrls].some((url) => {
    const source = results.find((item) => canonicalizeUrl(item.url) === canonicalizeUrl(url));
    return source ? sourceIdentity(source).strong : true;
  });
  const hasIndependentCorroboration = independentIdentityHosts.size >= 2
    || (independentIdentityHosts.size >= 1 && hasStrongSocial && publicContact);

  // "No website" is treated as an evidence-backed negative finding, not as a
  // universal proof of absence. We require several independent website-search
  // angles, no credible matched site, and corroborated identity/contact data.
  const noWebsiteSignal = !reachableIndependent
    && websiteQueries.length >= 4
    && hasIndependentCorroboration
    && publicContact;

  const independentSourceCount = independentIdentityHosts.size;

  if (hasSocial) {
    const firstSocial = [...socialUrls][0];
    if (firstSocial) {
      evidenceItems.push(
        evidence(firstSocial, 'social',
          'A public social profile was found and identity-matched; social presence is not treated as an independent website.',
          undefined, 0.88)
      );
    }
  }

  if (publicContact) {
    evidenceItems.push(
      evidence(seedProfile, 'directory',
        'Public contact information was recovered from the supplied source or identity-matched public sources.',
        undefined, 0.9)
    );
  }

  if (hasIndependentCorroboration) {
    const corroborationUrl = [...matchedIdentityUrls].find((url) => hostOf(url) !== seedHost);
    if (corroborationUrl) {
      evidenceItems.push(
        evidence(corroborationUrl, sourceKind(corroborationUrl),
          `The agent identity is corroborated by ${independentSourceCount} independent public host(s).`,
          undefined, 0.88)
      );
    }
  }

  evidenceItems.push(
    evidence(seedProfile, 'directory',
      `Website absence sweep completed across ${websiteQueries.length} targeted search angle(s); ${websiteTargets.length} candidate website URL(s) were directly checked.`,
      undefined,
      noWebsiteSignal ? 0.84 : 0.65
    )
  );

  const score = Math.min(10, Number((
    (noWebsiteSignal ? 4 : 0) +
    (hasSocial ? 1.2 : 0) +
    (publicContact ? 1.6 : 0) +
    (hasIndependentCorroboration ? 1.7 : 0) +
    (independentSourceCount >= 2 ? 0.5 : 0) +
    Math.min(1, nameMatch(name, combinedText))
  ).toFixed(1)));

  const confidence = reachableIndependent
    ? 0
    : noWebsiteSignal
      ? Math.min(0.96,
          0.63 +
          (hasSocial ? 0.06 : 0) +
          (independentSourceCount >= 2 ? 0.1 : 0) +
          (publicContact ? 0.09 : 0))
      : Math.min(0.78,
          0.42 +
          (hasIndependentCorroboration ? 0.12 : 0) +
          (publicContact ? 0.08 : 0) +
          (websiteTargets.length === 0 ? 0.04 : 0));

  return {
    ...candidate,
    sources: results,
    facts: {
      ...candidate.facts,
      socialUrls: [...socialUrls].join(','),
      candidateWebsiteUrls: [...candidateWebsiteUrls].join(','),
      matchedWebsiteUrl,
      publicContact,
      phones: [...new Set(contactPhones)].join(', '),
      emails: [...new Set(contactEmails)].join(', '),
      socialOnly: hasSocial && !reachableIndependent,
      noIndependentWebsite: noWebsiteSignal,
      verifiedSourceCount: results.length,
      verifiedSourceHosts: independentIdentityHosts.size,
      independentCorroboration: hasIndependentCorroboration,
      independentSourceCount,
      websiteChecks: websiteTargets.length,
      websiteSearchAngles: websiteQueries.length,
      matchedIdentitySourceCount: matchedIdentityUrls.size
    },
    evidence: evidenceItems,
    status: reachableIndependent ? 'rejected' : noWebsiteSignal ? 'verified' : 'uncertain',
    confidence,
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
      skills: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      categories: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      candidate_limit: { type: 'integer', minimum: 10, maximum: 60 },
      verify_limit: { type: 'integer', minimum: 4, maximum: 20 },
      freshness_days: { type: 'integer', minimum: 1, maximum: 3650 },
      verification_depth: { type: 'string', enum: ['quick', 'standard', 'deep'] },
      experience_level: { type: 'string' },
      work_preference: { type: 'string', enum: ['remote', 'hybrid', 'onsite', 'any'] },
      exclude_terms: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      requested_count: { type: 'integer', minimum: 1, maximum: 100 },
      source_urls: { type: 'array', items: { type: 'string' }, maxItems: 5 }
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
  const explicitSourceUrls = Array.isArray(args.source_urls)
    ? args.source_urls.filter((value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value)).slice(0, 5)
    : [];
  const sourceUrls = explicitSourceUrls.length ? explicitSourceUrls : extractSeedUrls(request);
  const sourceLocation = sourceUrls.map(inferLocationFromSourceUrl).find(Boolean);
  const finalLocation = location || sourceLocation;
  const safeVerifyLimit = mode === 'jobs' ? 8 : 6;
  return {
    mode,
    location: finalLocation,
    sourceUrls,
    roles,
    skills,
    categories,
    experienceLevel,
    workPreference,
    excludeTerms,
    queries: buildQueries({ mode, location: finalLocation, roles, skills, categories, workPreference }).slice(0, 6),
    candidateLimit: Number.isFinite(candidateLimit)
      ? Math.max(sourceUrls.length ? Math.max(30, requestedCount * 3) : 10, Math.min(60, Math.floor(candidateLimit)))
      : (sourceUrls.length ? Math.max(30, requestedCount * 3) : fallback.candidateLimit),
    verifyLimit: Number.isFinite(verifyLimit) ? Math.max(4, Math.min(safeVerifyLimit, Math.floor(verifyLimit))) : fallback.verifyLimit,
    sourceDomains: fallback.sourceDomains,
    freshnessDays: Number.isFinite(freshnessDays) ? Math.max(1, Math.min(3650, Math.floor(freshnessDays))) : fallback.freshnessDays,
    verificationDepth,
    requestedCount: Number.isFinite(requestedCount) ? Math.max(1, Math.min(100, Math.floor(requestedCount))) : fallback.requestedCount
  };
}

const MAX_RESEARCH_ROUNDS = 5;
const MAX_NO_PROGRESS_ROUNDS = 2;

function candidateKey(candidate: CandidateRecord): string {
  return [
    candidate.kind,
    normalizeText(candidate.name),
    normalizeText(String(candidate.facts.company || '')),
    normalizeText(candidate.location || '')
  ].join('|');
}

function fallbackResearchQueries(plan: ResearchPlan, round: number): string[] {
  const location = plan.location || 'Nigeria';
  if (plan.mode === 'jobs') {
    const roles = plan.roles.length ? plan.roles : ['software engineer', 'developer', 'engineering'];
    const role = roles[round % roles.length];
    const preference = plan.workPreference && plan.workPreference !== 'any' ? plan.workPreference : '';
    const sourceQueries = [
      `site:jobberman.com/listings ${role} ${location}`,
      `site:hotnigerianjobs.com/hotjobs ${role} ${location}`,
      `site:myjobmag.com/job ${role} ${location}`,
      `site:linkedin.com/jobs/view ${role} ${location}`,
      `site:ng.indeed.com/viewjob ${role} ${location}`,
      `site:jobs.leep.gov.ng ${role} ${location}`
    ];
    if (round === 0) return sourceQueries;
    if (round === 1) return [
      `${role} ${preference} hiring ${location}`.replace(/\s+/g, ' ').trim(),
      `${role} ${location} vacancy apply`,
      `${role} ${location} recruiter company`
    ];
    if (round === 2) return [
      `\"${role}\" ${location} \"apply now\"`,
      `\"${role}\" ${location} requirements employer`,
      `\"${role}\" ${location} \"job description\"`
    ];
    return [
      `site:jobberman.com/listings ${role} Nigeria`,
      `site:hotnigerianjobs.com/hotjobs ${role} Nigeria`,
      `site:myjobmag.com/job ${role} Nigeria`
    ];
  }

  if (plan.mode === 'business_website_gap') {
    const category = plan.categories.length ? plan.categories.join(' ') : 'businesses';
    if (round === 0) return [
      `${category} ${location} directory phone`,
      `site:businesslist.com.ng/company ${category} ${location}`,
      `site:finelib.com ${category} ${location}`,
      `site:instagram.com ${category} ${location}`,
      `site:facebook.com ${category} ${location}`
    ];
    if (round === 1) return [
      `${category} ${location} contact phone address`,
      `\"${category}\" \"${location}\" Instagram`,
      `\"${category}\" \"${location}\" Facebook`,
      `\"${category}\" \"${location}\" official website`
    ];
    if (round === 2) return [
      `${category} ${location} WhatsApp phone`,
      `${category} ${location} Google business social`,
      `site:businesslist.com.ng/company ${category} ${location} phone`
    ];
    return [
      `${category} ${location} local business contact`,
      `${category} ${location} social media phone`
    ];
  }

  return buildQueries({
    mode: plan.mode,
    location: plan.location,
    roles: plan.roles,
    skills: plan.skills,
    categories: plan.categories,
    workPreference: plan.workPreference
  });
}

function replaceCandidates(target: CandidateRecord[], updates: CandidateRecord[]): CandidateRecord[] {
  const byId = new Map(updates.map((candidate) => [candidate.id, candidate]));
  return target.map((candidate) => byId.get(candidate.id) || candidate);
}

function reasonForToCheck(candidate: CandidateRecord, mode: HuntMode): string {
  if (mode === 'business_website_gap') {
    if (candidate.facts.matchedWebsiteUrl) return 'An independent website was found, so the no-website claim was not established.';
    if (candidate.status === 'uncertain' && candidate.facts.socialOnly) return 'Social presence was found, but non-social corroboration is not strong enough yet.';
    if (candidate.facts.candidateWebsiteUrls) return 'A possible website signal was found but could not be confidently matched or reached.';
    if (!candidate.facts.publicContact) return 'A public contact point is still missing.';
    return 'Candidate identity or website-gap evidence is incomplete.';
  }

  const missing: string[] = [];
  if (!candidate.facts.company) missing.push('employer');
  if (!candidate.facts.postedAt) missing.push('freshness');
  if (!candidate.facts.hasApply) missing.push('application path');
  if (candidate.status === 'uncertain' && missing.length) return `Still need verified ${missing.join(', ')} evidence.`;
  return 'Candidate looks relevant but has not yet crossed the verification threshold.';
}

function renderDeterministicResults(
  candidates: CandidateRecord[],
  mode: HuntMode,
  requestedCount: number,
  rounds: number,
  exhaustedReason: string
): string {
  const verified = candidates
    .filter((candidate) => isEligibleCandidate(candidate, mode))
    .sort((a, b) => (b.score * b.confidence) - (a.score * a.confidence))
    .slice(0, Math.min(requestedCount, 20));
  const toCheckLimit = candidates.some((candidate) => candidate.sources.some((source) => source.source === 'seed'))
    ? Math.max(requestedCount, 20)
    : 8;
  const toCheck = candidates
    .filter((candidate) => candidate.status === 'uncertain' && candidate.confidence >= 0.35)
    .sort((a, b) => (b.score * b.confidence) - (a.score * a.confidence))
    .slice(0, toCheckLimit);

  const lines = [
    '## Research result',
    '',
    `Strong opportunities found: ${verified.length}/${requestedCount}.`,
    `Research rounds completed: ${rounds}.`,
    `Research status: ${exhaustedReason}.`,
    ''
  ];

  if (verified.length) {
    lines.push(
      '## Verified opportunities',
      '',
      ...verified.map((candidate, index) => renderCandidate(candidate, index + 1, mode)),
      ''
    );
  }

  if (toCheck.length) {
    lines.push(
      '## To check',
      '',
      'These are credible near-misses retained for manual follow-up; they are not presented as verified opportunities.',
      '',
      ...toCheck.map((candidate, index) => renderToCheck(candidate, index + 1, mode))
    );
  }

  if (!verified.length && !toCheck.length) {
    lines.push('No credible candidates survived the discovery filters.');
  }

  return lines.join('\n');
}

function renderCandidate(candidate: CandidateRecord, index: number, mode: HuntMode): string {
  const facts = candidate.facts;
  const sourceUrls = [...new Set(candidate.sources.map((source) => source.url))].slice(0, 5);
  const evidenceUrls = [...new Set(candidate.evidence.map((item) => item.source.url))].slice(0, 6);
  const contacts = [facts.phones ? `Phones: ${facts.phones}` : '', facts.emails ? `Emails: ${facts.emails}` : ''].filter(Boolean);
  return [
    `### ${index}. ${candidate.title || candidate.name}`,
    mode === 'jobs' ? `Company: ${facts.company || 'Not verified'}` : `Business: ${candidate.name}`,
    candidate.location ? `Location: ${candidate.location}` : '',
    mode === 'jobs' ? `Freshness: ${facts.postedAt ? `${String(facts.postedAt).slice(0, 10)}${facts.postedAt && (Date.now() - new Date(String(facts.postedAt)).getTime()) / 86400000 <= 30 ? ' (fresh)' : ' (older than requested window)'}` : 'not verified'}` : '',
    mode === 'jobs' ? `Fit signals: role=${facts.roleMatch ? 'match' : 'unknown'}, skills=${facts.skillsMatch ? 'match' : 'unknown'}, preference=${facts.preferenceMatch ? 'match' : 'unknown'}, experience=${facts.experienceMatch ? 'match' : 'unknown'}` : '',
    `Opportunity score: ${candidate.score}/10`,
    `Confidence: ${Math.round(candidate.confidence * 100)}%`,
    contacts.join(' | '),
    mode === 'jobs' ? `Application URL: ${facts.applicationUrl || candidate.sourceUrl}` : `Source: ${candidate.sourceUrl}`,
    sourceUrls.length ? `Sources: ${sourceUrls.join(' | ')}` : '',
    evidenceUrls.length ? `Evidence: ${evidenceUrls.join(' | ')}` : ''
  ].filter(Boolean).join('\n');
}

function renderToCheck(candidate: CandidateRecord, index: number, mode: HuntMode): string {
  const sourceUrls = [...new Set(candidate.sources.map((source) => source.url))].slice(0, 4);
  const evidenceUrls = [...new Set(candidate.evidence.map((item) => item.source.url))].slice(0, 5);
  const contacts = [candidate.facts.phones ? `Phones: ${candidate.facts.phones}` : '', candidate.facts.emails ? `Emails: ${candidate.facts.emails}` : ''].filter(Boolean);
  return [
    `### ${index}. ${candidate.title || candidate.name}`,
    mode === 'jobs' ? `Company: ${candidate.facts.company || 'Not verified'}` : `Business: ${candidate.name}`,
    candidate.location ? `Location: ${candidate.location}` : '',
    `Reason: ${reasonForToCheck(candidate, mode)}`,
    `Opportunity score: ${candidate.score}/10`,
    `Confidence: ${Math.round(candidate.confidence * 100)}%`,
    ...contacts,
    `Source: ${candidate.sourceUrl}`,
    sourceUrls.length ? `Other sources: ${sourceUrls.join(' | ')}` : '',
    evidenceUrls.length ? `Evidence: ${evidenceUrls.join(' | ')}` : ''
  ].filter(Boolean).join('\n');
}

function isEligibleCandidate(candidate: CandidateRecord, mode: HuntMode): boolean {
  if (candidate.status !== 'verified' || candidate.confidence < 0.6) return false;
  if (mode === 'business_website_gap') {
    return candidate.facts.noIndependentWebsite === true
      && !candidate.facts.matchedWebsiteUrl
      && candidate.facts.publicContact === true;
  }
  return true;
}
export class OpportunityHunter {
  constructor(
    private readonly brain: BrainProvider,
    private readonly search: SearchProvider,
    private readonly store: OpportunityStore
  ) {}

  async run(request: string): Promise<string> {
    const planResponse = await brainCompleteWithRetry(this.brain, {
      system: 'You are the planning brain for an autonomous opportunity hunter. Produce a compact plan only by calling set_research_plan. Do not browse the web yourself.',
      user: request,
      tools: [PLAN_TOOL]
    });

    const plan = sanitizePlan(request, planResponse?.toolCalls[0]?.arguments ?? {});
    let candidates: CandidateRecord[] = [];

    // When the user supplies a source URL, enumerate that source first. Do not reduce it to a search hint.
    if (plan.sourceUrls.length) {
      const seededResults = await discoverFromSeedUrls(
        plan.sourceUrls,
        Math.min(plan.candidateLimit, Math.max(plan.requestedCount * 3, 30)),
        12
      );
      const seededCandidates = mergeCandidates(seededResults, plan.mode, plan.location);
      candidates = mergeCandidateLists(candidates, seededCandidates).slice(0, plan.candidateLimit);
    }

    let queryQueue = [...new Set([...plan.queries, ...fallbackResearchQueries(plan, 0)])];
    const searchedQueries = new Set<string>();
    let noProgressRounds = 0;
    let refineUsed = false;
    let rounds = 0;
    let exhaustedReason = 'target reached';

    const maxResearchRounds = plan.sourceUrls.length ? 12 : MAX_RESEARCH_ROUNDS;
    for (let round = 0; round < maxResearchRounds; round += 1) {
      rounds = round + 1;
      const sourcePoolStillActive = plan.sourceUrls.length > 0 &&
        candidates.some((candidate) => candidate.status === 'discovered' || candidate.status === 'uncertain');

      if (!sourcePoolStillActive) {
        const remainingQueries = queryQueue.filter((query) => !searchedQueries.has(query)).slice(0, round === 0 ? 8 : 5);
        if (!remainingQueries.length) {
          const next = fallbackResearchQueries(plan, round);
          for (const query of next) if (!searchedQueries.has(query)) queryQueue.push(query);
        }
      }

      const activeQueries = plan.sourceUrls.length
        ? []
        : queryQueue.filter((query) => !searchedQueries.has(query)).slice(0, round === 0 ? 8 : 5);
      for (const query of activeQueries) searchedQueries.add(query);

      const beforeCount = candidates.length;
      const beforeSourceCount = candidates.reduce((total, candidate) => total + candidate.sources.length, 0);
      if (activeQueries.length) {
        const discovery = await parallelSearch(this.search, activeQueries, MAX_DISCOVERY_RESULTS_PER_QUERY);
        const discovered = mergeCandidates(discovery, plan.mode, plan.location);
        candidates = mergeCandidateLists(candidates, discovered).slice(0, plan.candidateLimit);
      }

      const eligibleBeforeVerify = candidates.filter((candidate) => isEligibleCandidate(candidate, plan.mode)).length;
      if (eligibleBeforeVerify >= plan.requestedCount) {
        exhaustedReason = 'requested target reached';
        break;
      }

      const verificationBatchLimit = plan.mode === 'jobs' ? 5 : (plan.sourceUrls.length ? 5 : 4);
      const toVerify = candidates
        .filter((candidate) => {
          if (candidate.status === 'discovered') return true;
          if (candidate.status !== 'uncertain') return false;
          const lastVerifiedSourceCount = Number(candidate.facts.verifiedSourceCount);
          return !Number.isFinite(lastVerifiedSourceCount) || candidate.sources.length > lastVerifiedSourceCount;
        })
        .sort((a, b) => (b.score * b.confidence) - (a.score * a.confidence))
        .slice(0, verificationBatchLimit);

      if (toVerify.length) {
        const updates = await Promise.all(toVerify.map((candidate) =>
          plan.mode === 'jobs'
            ? verifyJob(candidate, plan, this.search)
            : plan.mode === 'business_website_gap'
              ? verifyBusiness(candidate, plan, this.search)
              : verifyJob(candidate, plan, this.search)
        ));
        candidates = replaceCandidates(candidates, updates);
      }

      const strongCount = candidates.filter((candidate) => isEligibleCandidate(candidate, plan.mode)).length;
      if (strongCount >= plan.requestedCount) {
        exhaustedReason = 'requested target reached';
        break;
      }

      const sourceCandidatesPending = candidates.some((candidate) => candidate.status === 'discovered' || candidate.status === 'uncertain');
      if (plan.sourceUrls.length && !sourceCandidatesPending) {
        exhaustedReason = 'all candidates from the supplied source were investigated';
        break;
      }

      const gainedCandidates = candidates.length - beforeCount;
      const afterSourceCount = candidates.reduce((total, candidate) => total + candidate.sources.length, 0);
      const gainedEvidence = afterSourceCount > beforeSourceCount;
      const processedCandidates = toVerify.length > 0;
      if (gainedCandidates === 0 && !gainedEvidence && !(sourcePoolStillActive && processedCandidates)) noProgressRounds += 1;
      else noProgressRounds = 0;

      if (!refineUsed && strongCount < Math.min(plan.requestedCount, 3) && getRequestCount() < 60) {
        refineUsed = true;
        const refineResponse = await brainCompleteWithRetry(this.brain, {
          system: 'The local research pass is incomplete. Request at most three genuinely different discovery queries. Do not repeat previous wording or return generic advice.',
          user: [
            `Objective: ${request}`,
            `Mode: ${plan.mode}`,
            `Location: ${plan.location || '(not specified)'}`,
            `Already found: ${candidates.slice(0, 10).map((candidate) => candidate.name).join(', ') || '(none)'}`
          ].join('\n'),
          tools: [REFINE_TOOL]
        });
        const refined = Array.isArray(refineResponse?.toolCalls[0]?.arguments?.queries)
          ? refineResponse.toolCalls[0]!.arguments.queries.filter((value): value is string => typeof value === 'string').slice(0, 3)
          : [];
        queryQueue.push(...refined);
      }

      if (noProgressRounds >= MAX_NO_PROGRESS_ROUNDS) {
        exhaustedReason = 'no new credible evidence found after repeated research rounds';
        break;
      }
      if (getRequestCount() >= 72) {
        exhaustedReason = 'HTTP research budget reached';
        break;
      }
    }

    if (rounds >= maxResearchRounds && candidates.filter((candidate) => isEligibleCandidate(candidate, plan.mode)).length < plan.requestedCount) {
      exhaustedReason = 'research round limit reached';
    }

    candidates.sort((a, b) => (b.score * b.confidence) - (a.score * a.confidence));
    const eligibleCandidates = candidates.filter((candidate) => isEligibleCandidate(candidate, plan.mode));

    const opportunities: Opportunity[] = eligibleCandidates
      .slice(0, Math.min(plan.requestedCount, 20))
      .map((candidate) => ({
        id: candidate.id,
        title: candidate.title || candidate.name,
        description: candidate.kind === 'job'
          ? `Job opportunity at ${candidate.facts.company || 'an identified employer'}.`
          : 'Potential website/digital-presence opportunity supported by public evidence.',
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

    if (!candidates.length) {
      return renderDeterministicResults(candidates, plan.mode, plan.requestedCount, rounds, exhaustedReason === 'target reached' ? 'no viable candidates discovered' : exhaustedReason);
    }

    const toCheck = candidates
      .filter((candidate) => candidate.status === 'uncertain' && candidate.confidence >= 0.35)
      .slice(0, plan.sourceUrls.length ? Math.max(plan.requestedCount, 20) : 8);
    const envelopeCandidates = [...eligibleCandidates.slice(0, plan.requestedCount), ...toCheck].slice(0, 16);
    if (!envelopeCandidates.length) {
      return renderDeterministicResults(candidates, plan.mode, plan.requestedCount, rounds, exhaustedReason);
    }
    if (plan.sourceUrls.length) {
      return renderDeterministicResults(candidates, plan.mode, plan.requestedCount, rounds, exhaustedReason);
    }

    const evidenceEnvelope = envelopeCandidates.map(compactCandidate).join('\n');
    const finalResponse = await brainCompleteWithRetry(this.brain, {
      system: `You are the final synthesis brain. Use only the supplied evidence envelope. Never invent facts. The research engine has already enforced objective-specific verification. Return up to ${plan.requestedCount} verified opportunities when available. If fewer than requested were verified, explicitly keep the remaining credible near-misses in a separate 'To check' section; never promote them to verified. Include direct URLs and public contacts only when present in evidence.\n\nEvidence envelope:\n${evidenceEnvelope}` ,
      user: request,
      tools: []
    });

    const synthesized = finalResponse?.text?.trim();
    if (synthesized && !/^\s*[{[]\"?id/i.test(synthesized)) return synthesized;
    return renderDeterministicResults(candidates, plan.mode, plan.requestedCount, rounds, exhaustedReason);
  }
}
