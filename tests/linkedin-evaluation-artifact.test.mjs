import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { deriveLinkedInTaskId } from '../github-linkedin-search-receiver.mjs';
import { processLinkedInEvaluationArtifact, validateLinkedInEvaluationArtifact } from '../linkedin-evaluation-artifact.mjs';

function task() {
  const value = { schema_version: 1, source: { gmail_message_id: 'eval-msg', alert_subject: 'Corporate Development', alert_date: '2026-09-10' }, linkedin_search: { url: 'https://www.linkedin.com/jobs/search/?keywords=Corporate%20Development', keywords: 'Corporate Development' } };
  value.task_id = deriveLinkedInTaskId(value); return value;
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-linkedin-evaluation-'));
  const t = task();
  mkdirSync(join(root, 'data/linkedin-search-inbox'), { recursive: true });
  writeFileSync(join(root, 'data/linkedin-search-inbox', `${t.task_id}.yml`), `${JSON.stringify(t)}\n`);
  writeFileSync(join(root, 'data/applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n');
  const source = { schema_version: 1, task_id: t.task_id, exact_search_url: t.linkedin_search.url, expanded_at: '2026-09-10T21:00:00.000Z', expansion_status: 'completed', jobs: [0, 1, 2].map(index => ({ linkedin_job_id: `123456789${index}`, url: `https://www.linkedin.com/jobs/view/123456789${index}/`, title: `Role ${index}`, company: 'Example Co', location: 'Denver, CO', jd_text: `Complete rendered job description ${index}.` })) };
  const sourcePath = join(root, 'source.json');
  writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  return { root, task: t, source, sourcePath };
}
function evaluation(source, index = 0, overrides = {}) {
  const sourceRaw = readFileSync(source.sourcePath, 'utf8');
  const job = source.source.jobs[index];
  return {
    schema_version: 1,
    source: { task_id: source.task.task_id, artifact_sha256: createHash('sha256').update(sourceRaw).digest('hex') },
    evaluated_at: '2026-09-11T12:00:00.000Z',
    evaluator: { type: 'codex-agent-supervised' },
    jobs: [{
      linkedin_job_id: job.linkedin_job_id, url: job.url, title: job.title, company: job.company, location: job.location,
      jd_complete: true, classification: 'reject', fit_assessment: { rationale: 'Insufficient alignment with the target profile.' }, hard_requirements: { result: 'unknown' }, hard_gate: { result: 'passed' }, relevant_candidate_evidence: ['Authoritative candidate evidence was reviewed.'], material_gaps: ['Required domain depth is not established.'], interview_credibility: { result: 'passed' }, compensation: {}, location_assessment: {}, rationale: 'The role is not a credible fit based on the available evidence.', confidence: 'high', evidence_sufficiency: 'sufficient',
      processing: { status: 'evaluated', approved: false, factual_integrity: 'passed', liveness: 'active' },
    }],
    ...overrides,
  };
}

test('three-job source remains partial until every job is accounted for', async () => {
  const source = setup(); const evaluationPath = join(source.root, 'evaluation.json');
  try {
    writeFileSync(evaluationPath, JSON.stringify(evaluation(source)));
    const first = await processLinkedInEvaluationArtifact({ evaluationArtifactPath: evaluationPath, sourceArtifactPath: source.sourcePath, rootDir: source.root });
    assert.equal(first.status, 'partial'); assert.equal(first.summary.tasks_completed, 0); assert.equal(first.summary.tasks_partial, 1); assert.equal(first.summary.jobs_evaluated, 1);
    assert.deepEqual(first.evaluation.remaining_job_ids, ['1234567891', '1234567892']);
    const replay = await processLinkedInEvaluationArtifact({ evaluationArtifactPath: evaluationPath, sourceArtifactPath: source.sourcePath, rootDir: source.root });
    assert.equal(replay.status, 'no_op'); assert.equal(replay.summary.jobs_evaluated, 0);
    writeFileSync(evaluationPath, JSON.stringify(evaluation(source, 1)));
    const second = await processLinkedInEvaluationArtifact({ evaluationArtifactPath: evaluationPath, sourceArtifactPath: source.sourcePath, rootDir: source.root });
    assert.equal(second.status, 'partial'); assert.equal(second.summary.jobs_evaluated, 1); assert.equal(second.summary.tasks_completed, 0);
    assert.deepEqual(second.evaluation.accounted_job_ids, ['1234567890', '1234567891']);
    writeFileSync(evaluationPath, JSON.stringify(evaluation(source, 2)));
    const final = await processLinkedInEvaluationArtifact({ evaluationArtifactPath: evaluationPath, sourceArtifactPath: source.sourcePath, rootDir: source.root });
    assert.equal(final.status, 'completed'); assert.equal(final.summary.tasks_completed, 1); assert.equal(final.summary.tasks_partial, 0); assert.equal(final.summary.jobs_evaluated, 1);
    assert.deepEqual(final.evaluation.remaining_job_ids, []);
  } finally { rmSync(source.root, { recursive: true, force: true }); }
});

test('rejects unknown IDs, source mismatches, malformed classifications, and duplicate evaluations', () => {
  const source = setup();
  try {
    const valid = evaluation(source);
    assert.throws(() => validateLinkedInEvaluationArtifact({ ...valid, jobs: [{ ...valid.jobs[0], linkedin_job_id: '9999999999' }] }, { sourceArtifact: source.source, sourceRaw: readFileSync(source.sourcePath, 'utf8') }), /unknown normalized job ID/);
    assert.throws(() => validateLinkedInEvaluationArtifact({ ...valid, source: { ...valid.source, task_id: 'linkedin-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }, { sourceArtifact: source.source, sourceRaw: readFileSync(source.sourcePath, 'utf8') }), /source task does not match/);
    assert.throws(() => validateLinkedInEvaluationArtifact({ ...valid, jobs: [{ ...valid.jobs[0], classification: 'maybe' }] }, { sourceArtifact: source.source, sourceRaw: readFileSync(source.sourcePath, 'utf8') }), /classification must be one of/);
    assert.throws(() => validateLinkedInEvaluationArtifact({ ...valid, jobs: [valid.jobs[0], valid.jobs[0]] }, { sourceArtifact: source.source, sourceRaw: readFileSync(source.sourcePath, 'utf8') }), /duplicate evaluated/);
  } finally { rmSync(source.root, { recursive: true, force: true }); }
});

test('replay is idempotent and completed task protection remains authoritative', async () => {
  const source = setup(); const evaluationPath = join(source.root, 'evaluation.json');
  try {
    writeFileSync(evaluationPath, JSON.stringify(evaluation(source)));
    const first = await processLinkedInEvaluationArtifact({ evaluationArtifactPath: evaluationPath, sourceArtifactPath: source.sourcePath, rootDir: source.root });
    const second = await processLinkedInEvaluationArtifact({ evaluationArtifactPath: evaluationPath, sourceArtifactPath: source.sourcePath, rootDir: source.root });
    assert.equal(first.status, 'partial');
    assert.equal(second.status, 'no_op');
    assert.equal(second.summary.jobs_evaluated, 0);
    assert.equal(second.summary.jobs_queued, 0);
  } finally { rmSync(source.root, { recursive: true, force: true }); }
});

test('conflicting replay, one-job completion, and insufficient evidence remain fail-closed', async () => {
  const source = setup();
  try {
    const valid = evaluation(source);
    const firstPath = join(source.root, 'first.json'); writeFileSync(firstPath, JSON.stringify(valid));
    await processLinkedInEvaluationArtifact({ evaluationArtifactPath: firstPath, sourceArtifactPath: source.sourcePath, rootDir: source.root });
    const conflictPath = join(source.root, 'conflict.json'); writeFileSync(conflictPath, JSON.stringify({ ...valid, jobs: [{ ...valid.jobs[0], classification: 'apply', processing: { ...valid.jobs[0].processing, approved: true } }] }));
    const conflict = await processLinkedInEvaluationArtifact({ evaluationArtifactPath: conflictPath, sourceArtifactPath: source.sourcePath, rootDir: source.root });
    assert.equal(conflict.status, 'conflict_evaluation_changed');
    const one = setup(); one.source.jobs = one.source.jobs.slice(0, 1); writeFileSync(one.sourcePath, `${JSON.stringify(one.source, null, 2)}\n`);
    const onePath = join(one.root, 'evaluation.json'); writeFileSync(onePath, JSON.stringify(evaluation(one)));
    const oneResult = await processLinkedInEvaluationArtifact({ evaluationArtifactPath: onePath, sourceArtifactPath: one.sourcePath, rootDir: one.root });
    assert.equal(oneResult.status, 'completed'); assert.equal(oneResult.summary.tasks_completed, 1);
    rmSync(one.root, { recursive: true, force: true });
    const insufficient = evaluation(source, 1, { jobs: [{ ...evaluation(source, 1).jobs[0], jd_complete: false, evidence_sufficiency: 'insufficient', confidence: 'low', processing: { status: 'requires_evaluation', approved: false, factual_integrity: 'unknown', liveness: 'unknown' } }] });
    const insufficientPath = join(source.root, 'insufficient.json'); writeFileSync(insufficientPath, JSON.stringify(insufficient));
    const result = await processLinkedInEvaluationArtifact({ evaluationArtifactPath: insufficientPath, sourceArtifactPath: source.sourcePath, rootDir: source.root });
    assert.equal(result.status, 'partial'); assert.equal(result.summary.jobs_evaluated, 1); assert.equal(result.summary.jobs_queued, 0);
  } finally { if (existsSync(source.root)) rmSync(source.root, { recursive: true, force: true }); }
});
