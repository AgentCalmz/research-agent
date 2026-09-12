import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWebsiteStatus, scoreSignals } from '../dist/opportunity/scoring.js';

test('high-confidence social-only opportunity scores strongly', () => {
  const score = scoreSignals({
    noIndependentWebsite: true,
    socialOnly: true,
    activePresence: true,
    publicContact: true,
    establishedBusiness: true,
    multipleIndependentSources: true,
    evidenceConfidence: 1
  });
  assert.equal(score, 10);
});

test('reachable independent website prevents no-website classification', () => {
  assert.equal(classifyWebsiteStatus({ candidateUrls: [], reachableUrls: ['https://example.com'], socialUrls: [] }), 'found');
});

test('social presence without site is classified as social-only', () => {
  assert.equal(classifyWebsiteStatus({ candidateUrls: [], reachableUrls: [], socialUrls: ['https://instagram.com/example'] }), 'social_only');
});
