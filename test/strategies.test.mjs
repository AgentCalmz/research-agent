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

test('extracts the business name from SEO-style titles', () => {
  const result = candidateFromResult(
    { title: 'Best Spa & Salon Abuja | Luxor Spa & Salon', url: 'https://luxorsalonandspa.com', source: 'duckduckgo' },
    'business_website_gap',
    'Abuja'
  );
  assert.equal(result, null);
});

test('extracts the business name from SEO-style titles', () => {
  const result = candidateFromResult(
    { title: 'Best Spa & Salon Abuja | Luxor Spa & Salon', url: 'https://luxorsalonandspa.com', source: 'duckduckgo' },
    'business_website_gap',
    'Abuja'
  );
  assert.equal(result, null);
});

test('cleans SEO prefixes when the business is discovered from social media', () => {
  const result = candidateFromResult(
    { title: 'Best Spa & Salon Abuja | Luxor Spa & Salon - Instagram', url: 'https://www.instagram.com/luxorsalonandspa/', source: 'duckduckgo' },
    'business_website_gap',
    'Abuja'
  );
  assert.equal(result?.name, 'Luxor Spa & Salon');
});

test('accepts a concrete business listing', () => {
  const result = candidateFromResult(
    { title: 'Food Hub Services - Abuja, Nigeria - Contact Number', url: 'https://www.businesslist.com.ng/company/254728/food-hub-services', source: 'duckduckgo', snippet: 'Food Hub Services based in Abuja, Nigeria established in 2015.' },
    'business_website_gap',
    'Abuja'
  );
  assert.equal(result?.name, 'Food Hub Services');
});

test('accepts a concrete HotNigerianJobs listing', () => {
  const result = candidateFromResult(
    { title: 'Full Stack Engineer (Node.js/TypeScript + React)', url: 'https://www.hotnigerianjobs.com/hotjobs/791524/full-stack-engineer-nodejstypescript-react-at-swift.html', source: 'duckduckgo', snippet: 'SwiftLink Global Services Limited is recruiting to fill the position of Full Stack Engineer.' },
    'jobs',
    'Abuja'
  );
  assert.equal(result?.kind, 'job');
  assert.equal(result?.facts.company, 'SwiftLink Global Services Limited');
});

test('default plan keeps verification bounded', () => {
  const plan = defaultPlan('Find businesses in Abuja without websites');
  assert.equal(plan.verifyLimit <= 6, true);
});

test('strips the requested count from business category extraction', () => {
  const plan = defaultPlan('Find 5 businesses in Abuja without independent websites');
  assert.deepEqual(plan.categories, ['businesses']);
});
