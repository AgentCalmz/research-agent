import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePhone, tokenSimilarity, sameEntity, canonicalizeUrl } from '../dist/opportunity/entities.js';

test('normalizes Nigerian phones to a comparable representation', () => {
  assert.equal(normalizePhone('0803 123 4567'), '2348031234567');
  assert.equal(normalizePhone('+2348031234567'), '2348031234567');
});

test('merges obvious duplicate entity names', () => {
  assert.equal(tokenSimilarity('Abuja Beauty Hub', 'Abuja Beauty Hub Limited') > 0.8, true);
  assert.equal(sameEntity({ name: 'Abuja Beauty Hub', location: 'Abuja' }, { name: 'Abuja Beauty Hub Ltd', location: 'Abuja' }), true);
});

test('removes tracking parameters from source URLs', () => {
  assert.equal(canonicalizeUrl('https://example.com/shop?utm_source=x&ref=abc#top'), 'https://example.com/shop');
});
