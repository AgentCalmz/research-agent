import { hostOf, normalizeText } from './entities.js';

const JOB_PROFILE_PATHS = [/^\/in\//i, /\/freelancers?\//i, /\/profile\//i];
const JOB_INDEX_PATHS = [/\/jobs-[^/]+\//i, /\/jobs\/(?:search|collections|categories)/i, /\/jobs\/[^/]+$/i];
const BUSINESS_INDEX_PATHS = [
  /\/city(?:-guide)?\//i,
  /\/areas?\//i,
  /\/category\//i,
  /\/categories\//i,
  /\/list(?:-food|ings?)?[/?]/i,
  /\/region\//i,
  /\/archives?\//i
];

const JOB_LISTING_HOSTS = new Map<string, RegExp>([
  ['hotnigerianjobs.com', /\/hotjobs\/[^/]+/i],
  ['jobberman.com', /\/listings?\/[^/]+/i],
  ['myjobmag.com', /\/job\/|\/job-opening|\/jobs\/[^/]+/i],
  ['indeed.com', /\/viewjob\//i],
  ['linkedin.com', /\/jobs\/view\//i],
  // Jooble search/category pages are treated as indexes; require a concrete listing from other sources.
]);

const PROFILE_HOSTS = /(^|\.)(linkedin\.com|upwork\.com)$/i;
const SOCIAL_HOSTS = /(^|\.)(instagram\.com|facebook\.com|linkedin\.com|tiktok\.com|x\.com)$/i;
const DIRECTORY_HOSTS = /(^|\.)(businesslist\.com\.ng|finelib\.com|yellowpages|connectciti\.com|foursquare\.com|tripadvisor\.|yelp\.|directory\.org\.ng|nigeriabusinessweb\.com|geoleadsweb\.com)$/i;
const EDITORIAL_HOSTS = /(^|\.)(wakaabuja\.com|abujaeats\.com\.ng|ranked\.ng|abujabusinessnews\.com)$/i;

export function isSocialUrl(url: string): boolean {
  return SOCIAL_HOSTS.test(hostOf(url));
}

export function isDirectoryUrl(url: string): boolean {
  return DIRECTORY_HOSTS.test(hostOf(url));
}

export function isEditorialUrl(url: string): boolean {
  return EDITORIAL_HOSTS.test(hostOf(url));
}

export function isJobProfileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return JOB_PROFILE_PATHS.some((pattern) => pattern.test(parsed.pathname)) || PROFILE_HOSTS.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function isJobListingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const rule = [...JOB_LISTING_HOSTS.entries()].find(([domain]) => host === domain || host.endsWith(`.${domain}`));
    return Boolean(rule?.[1].test(parsed.pathname));
  } catch {
    return false;
  }
}

export function isJobIndexUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return JOB_INDEX_PATHS.some((pattern) => pattern.test(parsed.pathname)) && !isJobListingUrl(url);
  } catch {
    return false;
  }
}

export function isBusinessIndexUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return BUSINESS_INDEX_PATHS.some((pattern) => pattern.test(parsed.pathname));
  } catch {
    return false;
  }
}

export function isBusinessCandidateUrl(url: string): boolean {
  return !isBusinessIndexUrl(url);
}

export function isSearchNoise(title: string, snippet = ''): boolean {
  const text = normalizeText(`${title} ${snippet}`);
  return /\b(top \d+|best \d+|list of|directory|category|city guide|popular|without websites|businesses without websites|how to|guide|review of|my experience)\b/.test(text);
}

export function looksLikeIndependentBusinessSite(url: string): boolean {
  return !isSocialUrl(url) && !isDirectoryUrl(url) && !isEditorialUrl(url) &&
    !/google\.|bing\.|duckduckgo\.|youtube\.|wikipedia\./i.test(hostOf(url));
}

export function isLikelyJobListing(url: string, title = '', snippet = ''): boolean {
  if (isJobProfileUrl(url) || isJobIndexUrl(url)) return false;
  if (isJobListingUrl(url)) return true;
  const text = normalizeText(`${title} ${snippet}`);
  const hasJobSignal = /\b(job|jobs|vacancy|vacancies|position|role|hiring|recruiting|recruitment|apply|career|careers)\b/.test(text);
  const hasEmployerSignal = /\b(?:at|for|with)\s+[a-z0-9]/.test(text) || /\brecruiting\b/.test(text);
  const profileSignal = /\b(engineer|developer|designer|consultant|freelancer|portfolio|about me|my profile)\b/.test(text) &&
    /\b(i am|years? experience|my work|portfolio)\b/.test(text);
  return hasJobSignal && hasEmployerSignal && !profileSignal;
}
