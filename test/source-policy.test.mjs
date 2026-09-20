import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isJobListingUrl,
  isJobProfileUrl,
  isJobIndexUrl,
  isBusinessIndexUrl,
  isSocialUrl,
  isEditorialUrl,
  isLikelyJobListing,
  isSearchNoise
} from '../dist/opportunity/source-policy.js';
import { candidateFromResult } from '../dist/opportunity/strategies.js';

test('accepts a concrete HotNigerianJobs listing and rejects profile pages', () => {
  assert.equal(isJobListingUrl('https://www.hotnigerianjobs.com/hotjobs/791524/full-stack-engineer-nodejstypescript-react-at-swift.html'), true);
  assert.equal(isJobProfileUrl('https://ng.linkedin.com/in/onoja-peter'), true);
  assert.equal(candidateFromResult({ title: 'Software Engineer - LinkedIn', url: 'https://ng.linkedin.com/in/onoja-peter', source: 'duckduckgo' }, 'jobs', 'Abuja'), null);
});

test('rejects job index pages as individual jobs', () => {
  assert.equal(isJobIndexUrl('https://ng.jooble.org/jobs-javascript/Nigeria'), true);
  assert.equal(candidateFromResult({ title: 'Urgent! Javascript jobs in Nigeria', url: 'https://ng.jooble.org/jobs-javascript/Nigeria', source: 'duckduckgo' }, 'jobs', 'Nigeria'), null);
});

test('rejects business directory/editorial pages as businesses', () => {
  assert.equal(isBusinessIndexUrl('https://www.abujaeats.com.ng/areas/central'), true);
  assert.equal(isEditorialUrl('https://wakaabuja.com/bijou-cafe-and-restaurant'), true);
  assert.equal(candidateFromResult({ title: 'Best Businesses in Abuja, FCT | Ranked', url: 'https://ranked.ng/city/abuja', source: 'duckduckgo' }, 'business_website_gap', 'Abuja'), null);
});

test('recognizes concrete social profiles as social sources', () => {
  assert.equal(isSocialUrl('https://www.instagram.com/examplebusiness/'), true);
});

test('rejects current observed generic business result pages', () => {
  assert.equal(isEditorialUrl('https://sabiabuja.com/10-trendy-restaurants-cafes-to-visit-in-abuja-2026'), true);
  assert.equal(isEditorialUrl('https://www.whatsoninabuja.com/eat-drink'), true);
  assert.equal(isSearchNoise('10 Trendy Restaurants & Cafes to Visit in Abuja (2026)'), true);
  assert.equal(isSearchNoise('Find Best Restaurants in Abuja - Eat and Drink in Abuja'), true);
});

test('rejects current observed job index result', () => {
  assert.equal(isLikelyJobListing('https://arc.dev/en-ng/remote-jobs', 'Remote Jobs in Nigeria (September 2026) - Arc', 'Remote jobs in Nigeria. Sign up for similar job alerts.'), false);
});

test('rejects generic job-board pages', () => {
  assert.equal(isLikelyJobListing('https://example.com/remote-jobs', 'Remote Jobs in Nigeria', 'Sign up for similar job alerts.'), false);
});
