import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHtml } from '../generate-cover-letter.mjs';

const payload = (letter = {}) => ({
  candidate: { name: 'Ben Turner' },
  letter: {
    role_title: 'Senior Executive - Corporate Development',
    opening: 'Opening narrative.',
    profile_intro: 'Relevant executive and operating narrative with an honest software-domain gap.',
    problems_section: 'Why this company and the value I would bring.',
    closing: 'Thank you for your consideration.',
    achievements: [{ lead: 'Resume achievement', impact: 'Should not be mechanically appended.' }],
    ...letter,
  },
});

test('finished executive cover letters keep narrative content and omit resume bullets by default', () => {
  const html = buildHtml(payload());
  assert.match(html, /Opening narrative/);
  assert.match(html, /honest software-domain gap/);
  assert.match(html, /Why this company/);
  assert.match(html, /Thank you for your consideration/);
  assert.doesNotMatch(html, /Resume achievement|<ul class="achievements">/);
  assert.ok(html.indexOf('Thank you for your consideration') < html.indexOf('</body>'));
});

test('structured accomplishment bullets require explicit opt-in and remain before the closing', () => {
  const html = buildHtml(payload({ include_achievements: true }));
  const bullets = html.indexOf('Resume achievement');
  const closing = html.indexOf('Thank you for your consideration');
  assert.ok(bullets >= 0);
  assert.ok(bullets < closing);
});
