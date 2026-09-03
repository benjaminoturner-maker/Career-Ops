import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HandoffValidationError, importHandoff, validateHandoff } from '../handoff.mjs';

function workspace({ applied = false, priorReq = '123' } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'career-ops-handoff-'));
  mkdirSync(join(rootDir, 'data'), { recursive: true });
  mkdirSync(join(rootDir, 'reports'), { recursive: true });
  writeFileSync(join(rootDir, 'cv.md'), '# CV\n\nLed acquisition evaluation and executive recommendations.\n');
  const history = applied
    ? `| 1 | 2026-06-12 | Example Industrial Co. | Director, Corporate Development | N/A | Applied | - | - | Job ID: ${priorReq}. Job URL: https://jobs.example.com/job/${priorReq} |\n`
    : '';
  writeFileSync(join(rootDir, 'data/applications.md'), `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n${history}`);
  return rootDir;
}

function payload() {
  return {
    schema_version: 1,
    source: { evaluator: 'ChatGPT', evaluated_at: '2026-09-02', authoritative_posting_verified: true },
    job: {
      company: 'Example Industrial Co.', title: 'Director, Corporate Development',
      url: 'https://jobs.example.com/job/123', requisition_id: '123',
      location: 'Denver, Colorado', work_arrangement: 'Hybrid', compensation: '$160,000-$190,000',
      posting_status: 'live',
      jd_text: 'Director, Corporate Development. Example Industrial Co. seeks an executive to identify acquisitions, assess strategic fit, and coordinate cross-functional diligence. Candidates must lead technical diligence with operating teams. The position presents recommendations to executives and supports integration planning.',
    },
    evaluation: {
      tier: 'Tier 2', score: 4.1, recommended_action: 'Apply',
      archetype: 'Industrial Corporate Development',
      specialist_or_generalist: 'Generalist with industrial transaction judgment',
      candidate_pool_disadvantage: 'Career corporate-development candidates have more company-level transaction repetitions.',
      why_ben: 'The role explicitly values technical and operating judgment that Ben can evidence.',
      role_specific_bridge_evidence: 'The posting requires technical diligence with operating teams.',
      material_requirements_complete: true,
      candidate_claims_complete: true,
      requirements: [{
        requirement: 'Lead technical diligence', strength: 'strong preference', status: 'met',
        evidence: 'Candidates must lead technical diligence with operating teams.',
        classification_rationale: 'The capability is explicit, but the posting permits adjacent operating evidence.',
      }],
      strongest_fit: ['Acquisition evaluation and executive recommendations'],
      material_concerns: ['Less company-level M&A repetition than conventional candidates'],
      positioning_strategy: 'Lead with technical-commercial evaluation and executive judgment.',
      likely_questions: ['Why this role now?'],
    },
    candidate_claims: [{
      claim: 'Ben has led acquisition evaluation and executive recommendations.',
      source: 'cv.md', evidence: 'Led acquisition evaluation and executive recommendations.',
    }],
    requested_actions: { create_report: true, update_tracker: true, tracker_status: 'Evaluated' },
  };
}

test('valid trusted handoff imports a concise report and tracker row without materials', async t => {
  const rootDir = workspace();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const result = await importHandoff(payload(), { rootDir });
  const report = readFileSync(result.report, 'utf-8');
  const tracker = readFileSync(join(rootDir, 'data/applications.md'), 'utf-8');
  assert.match(report, /evaluation_source: chatgpt_handoff/);
  assert.match(report, /locally validated, not rescored/);
  assert.match(tracker, /Example Industrial Co\. \| Director, Corporate Development \| 4\.1\/5 \| Evaluated/);
  assert.match(tracker, /application materials not generated; not submitted/);
  assert.equal(result.status, 'Evaluated');
});

test('missing required interview-credibility analysis is rejected', () => {
  const rootDir = workspace();
  try {
    const input = payload();
    input.evaluation.why_ben = '';
    assert.throws(() => validateHandoff(input, { rootDir }), /evaluation\.why_ben is required/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('unsupported candidate claim is rejected against local facts', () => {
  const rootDir = workspace();
  try {
    const input = payload();
    input.candidate_claims[0].evidence = 'Led public-company earnings calls.';
    assert.throws(() => validateHandoff(input, { rootDir }), /evidence was not found in cv\.md/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('candidate claim cannot cite unrelated local evidence', () => {
  const rootDir = workspace();
  try {
    const input = payload();
    input.candidate_claims[0].claim = 'Ben led public-company earnings calls.';
    assert.throws(() => validateHandoff(input, { rootDir }), /claim is not sufficiently supported/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('exact prior application pauses import without writing', async t => {
  const rootDir = workspace({ applied: true });
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  await assert.rejects(() => importHandoff(payload(), { rootDir }), HandoffValidationError);
  assert.doesNotMatch(readFileSync(join(rootDir, 'data/applications.md'), 'utf-8'), /chatgpt handoff/i);
});

test('possible repost with a new requisition pauses for review', async t => {
  const rootDir = workspace({ applied: true, priorReq: '122' });
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  await assert.rejects(
    () => importHandoff(payload(), { rootDir }),
    error => error instanceof HandoffValidationError && /possible repost\/new opportunity \(different requisition ID\)/.test(error.message),
  );
});

test('JD and URL requisition mismatch is rejected', () => {
  const rootDir = workspace();
  try {
    const input = payload();
    input.job.url = 'https://jobs.example.com/job/124';
    assert.throws(() => validateHandoff(input, { rootDir }), /conflicts with URL requisition/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('omitted required JD signal is rejected as a possible hard gate', () => {
  const rootDir = workspace();
  try {
    const input = payload();
    input.evaluation.requirements = [{
      requirement: 'Executive presentations', strength: 'soft preference', status: 'met',
      evidence: 'The position presents recommendations to executives.',
      classification_rationale: 'This is a supporting responsibility rather than an eligibility gate.',
    }];
    assert.throws(() => validateHandoff(input, { rootDir }), /possible omitted hard gate from JD/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('downstream apply mode accepts imported reports and preserves final-submit safeguard', () => {
  const apply = readFileSync(new URL('../modes/apply.md', import.meta.url), 'utf-8');
  assert.match(apply, /evaluation_source: chatgpt_handoff/);
  assert.match(apply, /already evaluated/);
  assert.match(apply, /Do not offer or trigger a full A–G reevaluation/);
  assert.match(apply, /Never invent answers for legal, demographic, work-authorization/);
  assert.match(apply, /If the candidate confirms that they submitted the application/);
});
