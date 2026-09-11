import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  evaluationReadyLinkedInJobs,
  readLinkedInJDEnrichmentArtifact,
  sourceArtifactSha256,
  stageLinkedInJDEnrichmentArtifact,
  validateLinkedInJDEnrichmentArtifact,
} from '../linkedin-jd-enrichment.mjs';
import { readLinkedInExpansionArtifact } from '../linkedin-expansion-artifact.mjs';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-linkedin-jd-'));
  const sourceDir = join(root, 'source'); mkdirSync(sourceDir, { recursive: true });
  const source = { schema_version: 1, task_id: 'linkedin-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', exact_search_url: 'https://www.linkedin.com/jobs/search/?keywords=Corporate%20Development', expanded_at: '2026-09-11T12:00:00.000Z', expansion_status: 'completed', max_jobs: 3, jobs: [0, 1, 2].map(index => ({ linkedin_job_id: `123456789${index}`, url: `https://www.linkedin.com/jobs/view/123456789${index}/`, title: `Role ${index}`, company: 'Example Co', location: 'Denver, CO', work_arrangement: 'Hybrid', salary: '', jd_text: '' })) };
  const sourcePath = join(sourceDir, 'source.json'); writeFileSync(sourcePath, JSON.stringify(source));
  return { root, source, sourcePath };
}

function enrichment(source, statuses = ['complete', 'complete', 'complete']) {
  return {
    schema_version: 1,
    artifact_type: 'linkedin-jd-enrichment',
    task_id: source.task_id,
    source_artifact_sha256: sourceArtifactSha256(JSON.stringify(source)),
    enriched_at: '2026-09-11T12:30:00.000Z',
    jobs: source.jobs.map((job, index) => ({ ...job, jd_retrieval_status: statuses[index], jd_retrieval_reason: statuses[index] === 'complete' ? '' : `Observed ${statuses[index]} during detail retrieval`, jd_text: statuses[index] === 'complete' ? `Authoritative rendered job description ${index}. `.repeat(20) : '' })),
  };
}

function validate(root, source, sourcePath, value, maxJobs = 3) {
  const sourceRaw = readFileSync(sourcePath, 'utf8');
  return validateLinkedInJDEnrichmentArtifact(value, { sourceArtifact: readLinkedInExpansionArtifact(sourcePath, { maxJobs }), sourceRaw, maxJobs });
}

test('three-pass enrichment accepts three complete JDs and exposes all as evaluation-ready', () => {
  const { root, source, sourcePath } = setup();
  try {
    const value = validate(root, source, sourcePath, enrichment(source));
    assert.equal(value.jobs.length, 3);
    assert.equal(evaluationReadyLinkedInJobs(value).length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('individual unavailable and dead/stale jobs remain accounted while other jobs are ready', () => {
  const { root, source, sourcePath } = setup();
  try {
    const value = validate(root, source, sourcePath, enrichment(source, ['complete', 'unavailable', 'dead_or_stale']));
    assert.deepEqual(value.jobs.map(job => job.jd_retrieval_status), ['complete', 'unavailable', 'dead_or_stale']);
    assert.equal(evaluationReadyLinkedInJobs(value).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('complete requires nontrivial JD text and unknown status fails closed', () => {
  const { root, source, sourcePath } = setup();
  try {
    const short = enrichment(source); short.jobs[0].jd_text = '';
    assert.throws(() => validate(root, source, sourcePath, short), /complete JD text is too short/);
    const unknown = enrichment(source); unknown.jobs[0].jd_retrieval_status = 'maybe';
    assert.throws(() => validate(root, source, sourcePath, unknown), /status is invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('new artifacts require retrieval status and legacy discovery artifacts remain readable', () => {
  const { root, source, sourcePath } = setup();
  try {
    const legacy = readLinkedInExpansionArtifact(sourcePath, { maxJobs: 3 });
    assert.equal(legacy.jobs.length, 3);
    const missing = enrichment(source); delete missing.jobs[1].jd_retrieval_status;
    assert.throws(() => validate(root, source, sourcePath, missing), /status is invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('partial requires text; unavailable/access-blocked/not-attempted require a reason and no text', () => {
  const { root, source, sourcePath } = setup();
  try {
    const partial = enrichment(source, ['partial', 'unavailable', 'not_attempted']);
    partial.jobs[0].jd_text = 'Some rendered text';
    assert.equal(validate(root, source, sourcePath, partial).jobs[0].evaluation_ready, false);
    const noReason = enrichment(source, ['complete', 'access_blocked', 'complete']); delete noReason.jobs[1].jd_retrieval_reason;
    assert.throws(() => validate(root, source, sourcePath, noReason), /requires jd_retrieval_reason/);
    const textOnBlocked = enrichment(source, ['complete', 'access_blocked', 'complete']); textOnBlocked.jobs[1].jd_text = 'not allowed';
    assert.throws(() => validate(root, source, sourcePath, textOnBlocked), /must not contain JD text/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no source job can disappear or be duplicated between discovery and retrieval', () => {
  const { root, source, sourcePath } = setup();
  try {
    const missing = enrichment(source); missing.jobs.pop();
    assert.throws(() => validate(root, source, sourcePath, missing), /every source job/);
    const duplicate = enrichment(source); duplicate.jobs[2] = { ...duplicate.jobs[1] };
    assert.throws(() => validate(root, source, sourcePath, duplicate), /identity fields do not match|duplicate enrichment job/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('staging records complete retrieval accounting without invoking evaluation', () => {
  const { root, source, sourcePath } = setup();
  try {
    const enrichmentPath = join(root, 'enrichment.json'); writeFileSync(enrichmentPath, JSON.stringify(enrichment(source, ['complete', 'unavailable', 'dead_or_stale'])));
    const result = stageLinkedInJDEnrichmentArtifact({ enrichmentPath, sourceArtifactPath: sourcePath, rootDir: root, maxJobs: 3 });
    assert.equal(result.status, 'completed');
    assert.equal(result.discovered_count, 3);
    assert.equal(result.accounted_count, 3);
    assert.equal(result.evaluation_ready_count, 1);
    assert.equal(result.retrieval_status_counts.unavailable, 1);
    assert.equal(JSON.parse(readFileSync(result.retrieval_state_path, 'utf8')).accounted_count, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
