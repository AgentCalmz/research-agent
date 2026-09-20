import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQueries, detectMode, defaultPlan, candidateFromResult } from '../dist/opportunity/strategies.js';

test('detects job-hunting objectives', () => {
  assert.equal(detectMode('Find remote software engineering jobs in Nigeria'), 'jobs');
});

test('detects business website-gap objectives', () => {
  assert.equal(detectMode('Find Abuja salons that appear to have no independent website'), 'business_website_gap');
});

test('job strategy creates multi-source queries', () => {
  const queries = buildQueries({ mode: 'jobs', location: 'Abuja', roles: ['accountant'] });
  assert.equal(queries.some((q) => q.includes('site:jobberman.com')), true);
  assert.equal(queries.some((q) => q.includes('site:linkedin.com/jobs')), true);
});

test('business strategy rejects generic listicle candidates', () => {
  const result = candidateFromResult(
    { title: 'Top 10 Massage Spas in Abuja', url: 'https://example.com/list', source: 'duckduckgo' },
    'business_website_gap',
    'Abuja'
  );
  assert.equal(result, null);
});

test('default plan keeps verification bounded', () => {
  const plan = defaultPlan('Find businesses in Abuja without websites');
  assert.equal(plan.verifyLimit <= 6, true);
});
