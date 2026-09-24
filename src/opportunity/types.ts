import type { Evidence, Opportunity } from '../core/types.js';
import type { SearchResult } from '../discovery/search.js';

export type HuntMode = 'jobs' | 'business_website_gap' | 'general';

export type CandidateRecord = {
  id: string;
  kind: 'job' | 'business' | 'other';
  name: string;
  title?: string;
  location?: string;
  sourceUrl: string;
  sources: SearchResult[];
  facts: Record<string, string | number | boolean | undefined>;
  evidence: Evidence[];
  status: 'discovered' | 'verified' | 'rejected' | 'uncertain';
  confidence: number;
  score: number;
};

export type ResearchPlan = {
  mode: HuntMode;
  location?: string;
  sourceUrls: string[];
  roles: string[];
  skills: string[];
  categories: string[];
  experienceLevel?: string;
  workPreference?: 'remote' | 'hybrid' | 'onsite' | 'any';
  excludeTerms: string[];
  queries: string[];
  candidateLimit: number;
  verifyLimit: number;
  sourceDomains: string[];
  freshnessDays: number;
  verificationDepth: 'quick' | 'standard' | 'deep';
  requestedCount: number;
};

export type HuntResult = {
  mode: HuntMode;
  plan: ResearchPlan;
  candidates: CandidateRecord[];
  opportunities: Opportunity[];
  summary: string;
};
