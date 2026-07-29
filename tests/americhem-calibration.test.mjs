import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';
import {
  buildContentFilter,
  buildLocationFilter,
  buildTitleFilter,
  matchedTitleKeywords,
} from '../scan.mjs';

const portals = yaml.load(readFileSync(new URL('../portals.yml', import.meta.url), 'utf8'));
const profile = readFileSync(new URL('../modes/_profile.md', import.meta.url), 'utf8');
const benchmarkDoc = yaml.load(
  readFileSync(new URL('../config/opportunity-benchmarks.yml', import.meta.url), 'utf8'),
);

const americhem = {
  title: 'Manager, Corporate Development - Remote Eligible',
  location: 'United States - Remote Eligible',
  description: [
    'Build and manage an M&A target pipeline.',
    'Identify acquisition targets and assess strategic fit, technologies, products, customers, and end markets.',
    'Develop company profiles, business cases, and acquisition recommendations for executive leadership.',
    'Cultivate relationships with target companies and owners and support cross-functional due diligence.',
    'Engineering, business development, product management, strategy, or related industrial experience accepted.',
    'M&A transaction experience is beneficial but not required.',
  ].join(' '),
};

test('Americhem pattern is covered by the configured short discovery probes', () => {
  const queries = portals.search_queries.filter(
    (entry) => entry.name.startsWith('Industrial Corporate Development & Technical Growth —'),
  );
  assert.equal(queries.length, 10);
  assert.equal(queries.every((entry) => entry.enabled === true), true);
  const combined = queries.map((entry) => entry.query).join(' ');
  assert.match(combined, /Manager Corporate Development/);
  assert.match(combined, /acquisition targets/);
  assert.match(combined, /M&A pipeline/);
  assert.match(combined, /inorganic growth/i);
  assert.match(combined, /Strategy and M&A/);
  assert.match(combined, /External Growth/);
  assert.match(combined, /strategic fit/);
  assert.match(combined, /business case/);
  assert.match(combined, /due diligence/);
  assert.match(combined, /integration planning/);
  assert.match(combined, /technology evaluation/);
  assert.match(combined, /deal origination/);
  assert.doesNotMatch(combined, /"United States"|\bUSA\b|\bU\.S\./);
  assert.equal(queries.every((entry) => entry.query.length < 150), true);
});

test('Americhem pattern survives the scanner title, location, and content filters', () => {
  const titleFilter = buildTitleFilter(portals.title_filter);
  const locationFilter = buildLocationFilter(portals.location_filter);
  const contentFilter = buildContentFilter(portals.content_filter);
  const matches = matchedTitleKeywords(americhem.title, portals.title_filter);
  assert.equal(titleFilter(americhem.title), true);
  assert.equal(locationFilter(americhem.location), true);
  assert.equal(contentFilter(americhem.description, matches), true);
});

test('industrial lane preserves Manager eligibility, transferability, and Tier 2 boundary', () => {
  assert.match(profile, /Manager-level corporate-development roles are eligible/);
  assert.match(profile, /Do not require conventional investment-banking experience unless the posting requires it/);
  assert.match(profile, /undisclosed compensation and ambiguous Colorado remote eligibility as investigation items/);
  assert.match(profile, /normally Tier 2/);
  assert.match(profile, /ten years of progressive TIORCO specialty-chemicals experience/i);
});

test('positive benchmark records strengths, gaps, and expected regression behavior', () => {
  const benchmark = benchmarkDoc.benchmarks.find(
    (entry) => entry.id === 'industrial-corporate-development-technical-growth',
  );
  assert.equal(benchmark.source_role.score, 4.2);
  assert.equal(benchmark.source_role.expected_tier, 'Tier 2');
  assert.equal(benchmark.expected_regression.retain_for_evaluation, true);
  assert.equal(benchmark.expected_regression.manager_title_is_not_rejected, true);
  assert.equal(benchmark.expected_regression.investment_banking_is_not_required, true);
  assert.equal(benchmark.expected_regression.undisclosed_compensation_is_investigate, true);
  assert.equal(benchmark.expected_regression.remote_eligibility_is_investigate, true);
  assert.equal(benchmark.expected_regression.expected_classification, 'High-priority Tier 2');
  assert.ok(benchmark.material_gaps.includes('No direct plastics or masterbatch experience'));
  assert.ok(benchmark.material_gaps.includes('No conventional investment-banking background'));
});
