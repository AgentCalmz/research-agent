import type { SearchResult } from '../discovery/search.js';
import { normalizeText, hostOf } from './entities.js';
import type { HuntMode, ResearchPlan } from './types.js';

const JOB_SOURCES = [
  'linkedin.com/jobs',
  'jobberman.com',
  'hotnigerianjobs.com',
  'myjobmag.com',
  'ng.indeed.com',
  'jobs.leep.gov.ng'
];

const BUSINESS_SOURCE_HINTS = [
  'instagram.com',
  'facebook.com',
  'tripadvisor.',
  'foursquare.com',
  'yellowpages',
  'businesslist',
  'yelp.'
];

const NOISE_PATTERNS = [
  /top\s+\d+/i,
  /best\s+\d+/i,
  /restaurants without websites/i,
  /businesses without websites/i,
  /directory$/i,
  /directory\s*[-|]/i,
  /category/i
];

export function detectMode(request: string): HuntMode {
  const text = normalizeText(request);
  if (/\b(job|jobs|job hunting|vacanc|career|internship|graduate trainee|recruit|hiring|role|position|employment)\b/i.test(text)) return 'jobs';
  if (/\b(business|businesses|company|companies|salon|restaurant|hotel|shop|store|clinic|agency|without website|no website|website gap)\b/i.test(text)) {
    return 'business_website_gap';
  }
  return 'general';
}

export function defaultPlan(request: string): ResearchPlan {
  const mode = detectMode(request);
  const location = extractLocation(request);
  const roles = mode === 'jobs' ? extractRoles(request) : [];
  const categories = mode === 'business_website_gap' ? extractCategories(request) : [];
  return {
    mode,
    location,
    roles,
    categories,
    queries: buildQueries({ mode, location, roles, categories }),
    candidateLimit: mode === 'jobs' ? 40 : 30,
    verifyLimit: mode === 'jobs' ? 8 : 6,
    sourceDomains: mode === 'jobs' ? JOB_SOURCES : BUSINESS_SOURCE_HINTS,
    freshnessDays: mode === 'jobs' ? 30 : 180,
    verificationDepth: 'standard'
  };
}

function extractLocation(request: string): string | undefined {
  const match = request.match(/\b(?:in|around|near|at)\s+([A-Za-z][A-Za-z .'-]{2,40}?)(?:\.|,|\s+(?:that|with|and|who|which|for)\b|$)/i);
  return match?.[1]?.trim();
}

function extractRoles(request: string): string[] {
  const match = request.match(/\b(?:for|as)\s+(.+?)(?:\s+in\s+|\s+around\s+|\s+near\s+|\.|$)/i);
  return match ? match[1].split(/\s+or\s+|\s*,\s*/i).map((v) => v.trim()).filter(Boolean).slice(0, 5) : [];
}

function extractCategories(request: string): string[] {
  const match = request.match(/\b(?:businesses|companies|shops|stores|restaurants|salons|hotels|clinics|agencies)\s+(?:in|around|near)\s+/i);
  if (!match) return [];
  const before = request.slice(0, match.index ?? 0);
  const categoryMatch = before.match(/(?:find|discover|list)\s+(.+?)\s+(?:businesses|companies|shops|stores|restaurants|salons|hotels|clinics|agencies)$/i);
  return categoryMatch ? [categoryMatch[1].trim()] : [];
}

export function buildQueries(input: { mode: HuntMode; location?: string; roles?: string[]; categories?: string[] }): string[] {
  const location = input.location?.trim() || 'Nigeria';
  if (input.mode === 'jobs') {
    const roleTerms = input.roles?.length ? input.roles : ['jobs'];
    return [...new Set(roleTerms.flatMap((role) => [
      `${role} ${location}`,
      `${role} hiring ${location}`,
      `${role} ${location} apply`,
      `site:linkedin.com/jobs ${role} ${location}`,
      `site:jobberman.com ${role} ${location}`,
      `site:hotnigerianjobs.com ${role} ${location}`,
      `site:myjobmag.com ${role} ${location}`,
      `site:ng.indeed.com ${role} ${location}`,
      `site:jobs.leep.gov.ng ${role} ${location}`
    ])];
  }

  if (input.mode === 'business_website_gap') {
    const category = input.categories?.length ? input.categories.join(' ') : 'businesses';
    return [
      `${category} ${location}`,
      `${category} ${location} contact phone`,
      `${category} ${location} Instagram`,
      `${category} ${location} Facebook`,
      `${category} ${location} official website`,
      `site:instagram.com ${category} ${location}`,
      `site:facebook.com ${category} ${location}`,
      `"${category}" "${location}" directory`
    ];
  }

  return [
    `${input.roles?.join(' ') || 'business opportunities'} ${location}`,
    `${requestish(input)} ${location}`
  ];
}

function requestish(input: { roles?: string[]; categories?: string[] }): string {
  return input.roles?.join(' ') || input.categories?.join(' ') || 'opportunities';
}

export function candidateFromResult(result: SearchResult, mode: HuntMode, location?: string) {
  const cleanTitle = cleanResultTitle(result.title);
  if (!cleanTitle) return null;
  if (NOISE_PATTERNS.some((pattern) => pattern.test(cleanTitle)) && mode === 'business_website_gap') return null;

  const host = hostOf(result.url);
  const kind = mode === 'jobs' ? 'job' : mode === 'business_website_gap' ? 'business' : 'other';
  return {
    kind,
    name: kind === 'job' ? extractJobName(cleanTitle) : cleanTitle,
    title: kind === 'job' ? cleanTitle : undefined,
    location,
    sourceUrl: result.url,
    sources: [result],
    facts: {
      sourceHost: host,
      sourceType: result.source,
      company: kind === 'job' ? extractJobCompany(cleanTitle) : undefined
    }
  };
}

function cleanResultTitle(title: string): string {
  return title
    .replace(/\s*[|–—-]\s*(Instagram|Facebook|LinkedIn|Indeed|Jobberman|MyJobMag|HotNigerianJobs).*$/i, '')
    .replace(/\s*[-|]\s*Jobs?\s*$/i, '')
    .trim();
}

function extractJobName(title: string): string {
  return title
    .replace(/\s+(?:at|@)\s+[^|–—-]+$/i, '')
    .trim();
}

export { JOB_SOURCES, BUSINESS_SOURCE_HINTS };
