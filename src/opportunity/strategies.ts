import type { SearchResult } from '../discovery/search.js';
import { normalizeText, hostOf } from './entities.js';
import { isBusinessIndexUrl, isLikelyJobListing, isJobProfileUrl, isSearchNoise } from './source-policy.js';
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
  if (/\b(business|businesses|company|companies|salon|salons|restaurant|restaurants|hotel|hotels|shop|shops|store|stores|clinic|clinics|agency|agencies|without website|no website|website gap)\b/i.test(text)) {
    return 'business_website_gap';
  }
  return 'general';
}

export function defaultPlan(request: string): ResearchPlan {
  const mode = detectMode(request);
  const location = extractLocation(request);
  const roles = mode === 'jobs' ? extractRoles(request) : [];
  const skills = mode === 'jobs' ? extractSkills(request) : [];
  const categories = mode === 'business_website_gap' ? extractCategories(request) : [];
  return {
    mode,
    location,
    roles,
    skills,
    categories,
    experienceLevel: extractExperienceLevel(request),
    workPreference: extractWorkPreference(request),
    excludeTerms: extractExcludeTerms(request),
    queries: buildQueries({ mode, location, roles, skills, categories, workPreference: extractWorkPreference(request) }),
    candidateLimit: mode === 'jobs' ? 40 : 30,
    verifyLimit: mode === 'jobs' ? 8 : 6,
    sourceDomains: mode === 'jobs' ? JOB_SOURCES : BUSINESS_SOURCE_HINTS,
    freshnessDays: mode === 'jobs' ? 30 : 180,
    verificationDepth: 'standard',
    requestedCount: extractRequestedCount(request)
  };
}

function extractRequestedCount(request: string): number {
  const match = request.match(/\b(?:find|get|return|give me|top)\s+(\d{1,3})\b/i);
  const count = Number(match?.[1] ?? 10);
  return Number.isFinite(count) ? Math.max(1, Math.min(100, Math.floor(count))) : 10;
}

function extractSkills(request: string): string[] {
  const match = request.match(/\b(?:skills?|technology|stack|using)\s*[:\-]?\s*([^.!?]+)/i);
  const value = match?.[1];
  return value ? value.split(/,|\s+and\s+/i).map((v) => v.trim()).filter(Boolean).slice(0, 8) : [];
}

function extractExperienceLevel(request: string): string | undefined {
  const match = request.match(/\b(entry[- ]level|junior|mid[- ]level|senior|lead|manager|director|executive|graduate|intern)\b/i);
  return match?.[1]?.toLowerCase();
}

function extractWorkPreference(request: string): 'remote' | 'hybrid' | 'onsite' | 'any' {
  const text = request.toLowerCase();
  if (/\bremote\b/.test(text)) return 'remote';
  if (/\bhybrid\b/.test(text)) return 'hybrid';
  if (/\bonsite|on-site|office\b/.test(text)) return 'onsite';
  return 'any';
}

function extractExcludeTerms(request: string): string[] {
  const match = request.match(/\b(?:exclude|avoid|without)\s+([^.!?]+)/i);
  const value = match?.[1];
  return value ? value.split(/,|\s+and\s+/i).map((v) => v.trim()).filter(Boolean).slice(0, 8) : [];
}

function extractLocation(request: string): string | undefined {
  const match = request.match(/\b(?:in|around|near|at)\s+([A-Za-z][A-Za-z .'-]{2,40}?)(?:\.|,|\s+(?:that|with|and|who|which|for)\b|$)/i);
  return match?.[1]?.trim();
}

function extractRoles(request: string): string[] {
  const direct = request.match(/\b(?:for|as)\s+(.+?)(?:\s+in\s+|\s+around\s+|\s+near\s+|\.|$)/i)?.[1];
  const jobType = request.match(/\b(?:find|get)\s+(?:\d+\s+)?(.+?)\s+(?:jobs?|roles?|positions?)\b/i)?.[1];
  const value = direct || jobType;
  return value ? value.split(/\s+or\s+|\s*,\s*/i).map((v) => v.trim()).filter(Boolean).slice(0, 5) : [];
}

function extractCategories(request: string): string[] {
  const match = request.match(/\b(?:find|discover|list)\s+(?:\d+\s+)?(?:(.+?)\s+)?(businesses|companies|shops|stores|restaurants|salons|hotels|clinics|agencies)\s+(?:in|around|near)\b/i);
  if (!match?.[2]) return [];
  const modifier = match[1]?.trim();
  return [modifier ? `${modifier} ${match[2]}` : match[2]];
}


export function buildQueries(input: { mode: HuntMode; location?: string; roles?: string[]; skills?: string[]; categories?: string[]; workPreference?: 'remote' | 'hybrid' | 'onsite' | 'any' }): string[] {
  const location = input.location?.trim() || 'Nigeria';
  if (input.mode === 'jobs') {
    const roleTerms = input.roles?.length ? input.roles : ['jobs'];
    const skillHint = input.skills?.length ? input.skills.join(' ') : '';
    const preference = input.workPreference && input.workPreference !== 'any' ? input.workPreference : '';
    return [...new Set(roleTerms.flatMap((role) => [
      `site:jobberman.com/listings ${role} ${location}`,
      `site:hotnigerianjobs.com/hotjobs ${role} ${location}`,
      `site:myjobmag.com/job ${role} ${location}`,
      `site:ng.indeed.com/viewjob ${role} ${location}`,
      `site:linkedin.com/jobs/view ${role} ${location}`,
      `site:jobs.leep.gov.ng ${role} ${location}`,
      `${role} ${skillHint} hiring ${preference} ${location}`.replace(/\s+/g, ' ').trim(),
      `${role} ${skillHint} ${preference} ${location}`.replace(/\s+/g, ' ').trim(),
      `${role} ${skillHint} ${location} apply`
    ]))];  }

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
  if (mode === 'business_website_gap' && (NOISE_PATTERNS.some((pattern) => pattern.test(cleanTitle)) || isSearchNoise(cleanTitle, result.snippet))) return null;
  if (mode === 'business_website_gap' && isBusinessIndexUrl(result.url) && !/\/company\//i.test(result.url)) return null;
  if (mode === 'jobs' && !isLikelyJobListing(result.url, cleanTitle, result.snippet)) return null;

  const host = hostOf(result.url);
  const kind = mode === 'jobs' ? 'job' : mode === 'business_website_gap' ? 'business' : 'other';
  return {
    kind,
    name: kind === 'job' ? extractJobName(cleanTitle) : cleanBusinessName(cleanTitle),
    title: kind === 'job' ? cleanTitle : undefined,
    location,
    sourceUrl: result.url,
    sources: [result],
    facts: {
      sourceHost: host,
      sourceType: result.source,
      company: kind === 'job' ? (extractJobCompany(cleanTitle) || extractJobCompany(result.snippet || '')) : undefined
    }
  };
}

function cleanBusinessName(title: string): string {
  return title
    .replace(/\s*[-|]\s*(?:Abuja|Abuja,?\s*Nigeria|Nigeria).*$/i, '')
    .replace(/\s*[-|]\s*Contact.*$/i, '')
    .replace(/\s*[-|]\s*(?:Instagram|Facebook|LinkedIn).*$/i, '')
    .trim();
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

function extractJobCompany(title: string): string | undefined {
  const direct = title.match(/\s+(?:at|@)\s+([^|–—-]+)$/i);
  if (direct?.[1]) return direct[1].trim();
  const recruiting = title.match(/([A-Z][A-Za-z0-9&.' -]{2,80}?)\s+is\s+recruiting\s+to\s+fill\s+the\s+position/i);
  if (recruiting?.[1]) return recruiting[1].trim();
  const hiring = title.match(/([A-Z][A-Za-z0-9&.' -]{2,80}?)\s+(?:is\s+)?hiring\b/i);
  return hiring?.[1]?.trim();
}

export { JOB_SOURCES, BUSINESS_SOURCE_HINTS };
