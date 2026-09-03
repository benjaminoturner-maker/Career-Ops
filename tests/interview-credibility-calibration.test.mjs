import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';
import { applyInterviewCredibilityGate } from '../judgment-policy.mjs';

const profileConfig = yaml.load(
  readFileSync(new URL('../config/profile.yml', import.meta.url), 'utf8'),
);
const profile = readFileSync(new URL('../modes/_profile.md', import.meta.url), 'utf8');
const custom = readFileSync(new URL('../modes/_custom.md', import.meta.url), 'utf8');
const benchmarkDoc = yaml.load(
  readFileSync(new URL('../config/opportunity-benchmarks.yml', import.meta.url), 'utf8'),
);

const byId = (id) => benchmarkDoc.benchmarks.find((entry) => entry.id === id);

test('interview credibility is the primary decision basis', () => {
  const policy = profileConfig.screening.interview_credibility;
  assert.equal(policy.enabled, true);
  assert.equal(policy.outweighs_theoretical_transferability, true);
  assert.equal(policy.default_when_no_why_ben, 'Downgrade or reject');
  assert.deepEqual(policy.requirement_strengths, [
    'hard gate', 'strong preference', 'soft preference', 'neutral context',
  ]);
  assert.match(profile, /Why would this employer interview Ben/i);
  assert.match(profile, /generic transferability/i);
});

test('retained-role output requires interview-probability rationale', () => {
  assert.match(custom, /Fit/);
  assert.match(custom, /Concerns/);
  assert.match(custom, /Why Ben could realistically get an interview/);
  assert.match(custom, /Recommended next action/);
  assert.match(custom, /prior-application and possible-repost handling/);
});

test('high-growth SaaS BizOps specialist is rejected without a role-specific bridge', () => {
  const fixture = byId('interview-credibility-high-growth-saas-bizops');
  assert.equal(fixture.requirement_strength, 'hard gate');
  assert.equal(fixture.why_ben, null);
  assert.equal(fixture.expected_regression.expected_tier, 'Reject');
  assert.equal(fixture.expected_regression.generic_transferability_is_insufficient, true);
});

test('manufacturing strategy cannot reach Tier 1 or 2 from surface overlap alone', () => {
  const fixture = byId('interview-credibility-manufacturing-strategy');
  assert.equal(fixture.expected_regression.expected_tier, 'Tier 3 or Reject');
  assert.equal(
    fixture.expected_regression.cannot_be_tier_1_or_2_from_functional_overlap_alone,
    true,
  );
  const result = applyInterviewCredibilityGate({
    stage: 'evaluated',
    sourceChannel: 'gmail',
    proposedTier: 'Tier 1',
    fitScore: 4.4,
    requirementStrength: fixture.requirement_strength,
    hiringIntent: fixture.scenario.hiring_intent,
    candidatePoolDisadvantage: fixture.candidate_pool_disadvantage,
    whyBen: fixture.why_ben,
    roleSpecificBridgeEvidence: '',
  });
  assert.equal(result.finalTier, 'Tier 3');
  assert.ok(result.fitScore < 4);
  assert.equal(result.topTierPermitted, false);
});

test('PE-backed generalist operator remains credible across an unfamiliar end market', () => {
  const fixture = byId('interview-credibility-pe-backed-generalist-operator');
  assert.equal(fixture.requirement_strength, 'soft preference');
  assert.match(fixture.scenario.hiring_intent, /Generalist/);
  assert.equal(fixture.expected_regression.expected_tier, 'Tier 1 or Tier 2');
  assert.equal(fixture.expected_regression.unfamiliar_end_market_is_not_automatic_rejection, true);
  assert.ok(fixture.why_ben);
  const result = applyInterviewCredibilityGate({
    stage: 'evaluated',
    sourceChannel: 'scanner',
    proposedTier: 'Tier 1',
    fitScore: 4.5,
    requirementStrength: fixture.requirement_strength,
    hiringIntent: fixture.scenario.hiring_intent,
    candidatePoolDisadvantage: fixture.candidate_pool_disadvantage,
    whyBen: fixture.why_ben,
    roleSpecificBridgeEvidence: 'Posting explicitly welcomes strategy, business operations, finance, consulting, portfolio, and field-operations backgrounds',
  });
  assert.equal(result.finalTier, 'Tier 1');
  assert.equal(result.topTierPermitted, true);
});

test('adjacent energy bridge is preserved and pure specialist roles are rejected', () => {
  const adjacent = byId('interview-credibility-adjacent-energy');
  const specialist = byId('interview-credibility-pure-specialist');
  assert.equal(adjacent.expected_regression.expected_tier, 'Tier 1 or Tier 2');
  assert.ok(adjacent.why_ben);
  assert.equal(specialist.requirement_strength, 'hard gate');
  assert.equal(specialist.expected_regression.expected_tier, 'Reject');
});

test('Americhem benchmark remains a credible role-specific Tier 2 bridge', () => {
  const americhem = byId('industrial-corporate-development-technical-growth');
  assert.equal(americhem.source_role.expected_tier, 'Tier 2');
  assert.ok(americhem.reusable_pattern.candidate_feeder_backgrounds.includes('related industrial sectors'));
  assert.equal(americhem.reusable_pattern.formal_m_and_a_treatment, 'Beneficial rather than mandatory');
  const result = applyInterviewCredibilityGate({
    stage: 'evaluated',
    sourceChannel: 'linkedin',
    proposedTier: 'Tier 2',
    fitScore: 4.2,
    requirementStrength: 'soft preference',
    hiringIntent: 'Technical-industrial corporate development with related industrial backgrounds accepted',
    candidatePoolDisadvantage: 'Direct polymers candidates have product familiarity, but formal M&A pedigree is not mandatory',
    whyBen: 'Specialty-chemicals operator with technical commercialization and acquisition-evaluation experience',
    roleSpecificBridgeEvidence: 'Posting accepts engineering, business development, product management, strategy, and related industrial sectors',
  });
  assert.equal(result.finalTier, 'Tier 2');
  assert.equal(result.fitScore, 4.2);
});

test('high-growth SaaS BizOps hard gate blocks Tier 1 and Tier 2', () => {
  const fixture = byId('interview-credibility-high-growth-saas-bizops');
  const result = applyInterviewCredibilityGate({
    stage: 'evaluated',
    sourceChannel: 'web',
    proposedTier: 'Tier 2',
    fitScore: 4.1,
    requirementStrength: fixture.requirement_strength,
    hiringIntent: fixture.scenario.hiring_intent,
    candidatePoolDisadvantage: fixture.candidate_pool_disadvantage,
    whyBen: fixture.why_ben,
    roleSpecificBridgeEvidence: '',
  });
  assert.equal(result.finalTier, 'Reject');
  assert.ok(result.fitScore < 3.5);
});

test('scan-only discovery retains a lead without final tier or score', () => {
  const result = applyInterviewCredibilityGate({
    stage: 'discovery',
    sourceChannel: 'scanner',
    proposedTier: 'Tier 1',
    fitScore: 4.8,
  });
  assert.equal(result.disposition, 'requires evaluation');
  assert.equal(result.finalTier, null);
  assert.equal(result.fitScore, null);
});

test('Gmail and scanner discoveries use the same final judgment policy', () => {
  const assessment = {
    stage: 'evaluated',
    proposedTier: 'Tier 1',
    fitScore: 4.4,
    requirementStrength: 'strong preference',
    hiringIntent: 'Manufacturing-strategy specialist',
    candidatePoolDisadvantage: 'Direct manufacturing-network candidates have the same functional strengths',
    whyBen: '',
    roleSpecificBridgeEvidence: '',
  };
  const gmail = applyInterviewCredibilityGate({ ...assessment, sourceChannel: 'gmail' });
  const scanner = applyInterviewCredibilityGate({ ...assessment, sourceChannel: 'scanner' });
  assert.deepEqual(
    { tier: gmail.finalTier, score: gmail.fitScore, allowed: gmail.topTierPermitted },
    { tier: scanner.finalTier, score: scanner.fitScore, allowed: scanner.topTierPermitted },
  );
});
