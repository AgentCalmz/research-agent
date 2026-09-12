import type { Opportunity } from '../core/types.js';

export type OpportunitySignals = {
  noIndependentWebsite?: boolean;
  socialOnly?: boolean;
  brokenWebsite?: boolean;
  activePresence?: boolean;
  publicContact?: boolean;
  establishedBusiness?: boolean;
  multipleIndependentSources?: boolean;
  websiteFound?: boolean;
  evidenceConfidence?: number;
};

export function scoreSignals(signals: OpportunitySignals): number {
  if (signals.websiteFound && !signals.brokenWebsite) return 0;
  let score = 0;
  if (signals.noIndependentWebsite) score += 3;
  if (signals.brokenWebsite) score += 2;
  if (signals.socialOnly) score += 2;
  if (signals.publicContact) score += 2;
  if (signals.activePresence) score += 1;
  if (signals.establishedBusiness) score += 1;
  if (signals.multipleIndependentSources) score += 1;
  const confidence = Math.max(0, Math.min(1, signals.evidenceConfidence ?? 0.5));
  score += confidence;
  return Math.min(10, Number(score.toFixed(1)));
}

export function classifyWebsiteStatus(input: {
  candidateUrls: string[];
  reachableUrls: string[];
  socialUrls: string[];
}): 'not_found' | 'broken' | 'social_only' | 'found' | 'uncertain' {
  if (input.reachableUrls.length > 0) return 'found';
  if (input.candidateUrls.length > 0) return 'broken';
  if (input.socialUrls.length > 0) return 'social_only';
  return 'not_found';
}

export function makeOpportunity(params: {
  id: string;
  business: Record<string, unknown>;
  description: string;
  evidence: Opportunity['evidence'];
  signals: OpportunitySignals;
}): Opportunity {
  return {
    id: params.id,
    title: 'Potential website / digital presence opportunity',
    description: params.description,
    score: scoreSignals(params.signals),
    entities: params.business,
    evidence: params.evidence
  };
}
