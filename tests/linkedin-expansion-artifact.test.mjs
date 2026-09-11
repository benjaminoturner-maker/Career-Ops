import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { deriveLinkedInTaskId } from '../github-linkedin-search-receiver.mjs';
import { processLinkedInExpansionArtifact, selectNextLinkedInTask } from '../linkedin-search-expansion.mjs';
import { linkedinJobIdFromUrl, readLinkedInExpansionArtifact, stageLinkedInExpansionArtifact, validateLinkedInExpansionArtifact } from '../linkedin-expansion-artifact.mjs';

function task() {
  const value = { schema_version: 1, source: { gmail_message_id: 'msg-artifact', alert_subject: 'Corporate Development', alert_date: '2026-09-10' }, linkedin_search: { url: 'https://www.linkedin.com/jobs/search/?keywords=Corporate%20Development&location=Denver', keywords: 'Corporate Development', location: 'Denver' } };
  value.task_id = deriveLinkedInTaskId(value); return value;
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-linkedin-artifact-'));
  const t = task(); mkdirSync(join(root, 'data/linkedin-search-inbox'), { recursive: true });
  mkdirSync(join(root, 'data/linkedin-search-runtime/github-receipts'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data/linkedin-search-inbox', `${t.task_id}.yml`), `${JSON.stringify(t)}\n`);
  writeFileSync(join(root, 'data/applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n');
  return { root, task: t };
}
function artifact(t, overrides = {}) {
  return { schema_version: 1, task_id: t.task_id, exact_search_url: t.linkedin_search.url, expanded_at: '2026-09-10T21:00:00.000Z', expansion_status: 'completed', jobs: [{ linkedin_job_id: '1234567890', url: 'https://www.linkedin.com/jobs/view/1234567890/', title: 'Director, Corporate Development', company: 'Example Co', location: 'Denver, CO', jd_text: 'Complete rendered job description.' }, ...overrides.jobs || []], ...overrides };
}

test('validates exact task identity, derives IDs, deduplicates cards, and preserves optional fields', () => {
  const { root, task: t } = setup();
  try {
    const value = validateLinkedInExpansionArtifact(artifact(t, { jobs: [{ linkedin_job_id: '1234567890', url: 'https://www.linkedin.com/jobs/view/1234567890/?trk=a', title: 'Director, Corporate Development', company: 'Example Co', location: 'Denver, CO', jd_text: 'Full JD' }, { linkedin_job_id: '1234567890', url: 'https://www.linkedin.com/jobs/view/1234567890/', title: 'Duplicate', company: 'Example Co', location: 'Denver, CO' }] }), { task: t });
    assert.equal(value.jobs.length, 1);
    assert.equal(value.jobs[0].linkedin_job_id, '1234567890');
    assert.equal(value.jobs[0].jd_text, 'Full JD');
    assert.equal(value.jobs[0].salary, '');
    assert.equal(linkedinJobIdFromUrl(value.jobs[0].url), '1234567890');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verifies optional originating Issue identity against the receiver receipt', () => {
  const { root, task: t } = setup();
  try {
    const receiptPath = join(root, 'data/linkedin-search-runtime/github-receipts/example--repo--7.json');
    writeFileSync(receiptPath, JSON.stringify({ task_id: t.task_id, issue_url: 'https://github.com/example/repo/issues/7' }));
    const value = artifact(t, { issue: { repository: 'example/repo', number: 7, url: 'https://github.com/example/repo/issues/7' } });
    assert.equal(stageLinkedInExpansionArtifact(value, { rootDir: root }).status, 'staged');
    assert.throws(() => stageLinkedInExpansionArtifact({ ...value, issue: { repository: 'example/repo', number: 8 } }, { rootDir: root }), /no matching immutable receiver receipt/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects unknown tasks, exact URL mismatches, malformed IDs, and malformed URLs', () => {
  const { root, task: t } = setup();
  try {
    assert.throws(() => stageLinkedInExpansionArtifact({ ...artifact(t), task_id: 'linkedin-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { rootDir: root }), /unknown LinkedIn task/);
    assert.throws(() => validateLinkedInExpansionArtifact(artifact(t, { exact_search_url: 'https://www.linkedin.com/jobs/search/?keywords=other' }), { task: t }), /does not match/);
    assert.throws(() => validateLinkedInExpansionArtifact(artifact(t, { jobs: [{ ...artifact(t).jobs[0], linkedin_job_id: 'wrong' }] }), { task: t }), /must match/);
    assert.throws(() => validateLinkedInExpansionArtifact(artifact(t, { jobs: [{ ...artifact(t).jobs[0], url: 'https://example.com/jobs/1' }] }), { task: t }), /LinkedIn job URL/);
    assert.throws(() => validateLinkedInExpansionArtifact(artifact(t, { expansion_status: 'unknown', jobs: [] }), { task: t }), /completed or blocked/);
    assert.throws(() => validateLinkedInExpansionArtifact(artifact(t, { expansion_status: 'blocked_login' }), { task: t }), /must not contain jobs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('enforces the conservative result limit and records resumable blockers', () => {
  const { root, task: t } = setup();
  try {
    const tooMany = artifact(t, { jobs: Array.from({ length: 3 }, (_, i) => ({ linkedin_job_id: String(1234567891 + i), url: `https://www.linkedin.com/jobs/view/${1234567891 + i}/`, title: `Role ${i}`, company: 'Example Co', location: 'Denver' })) });
    assert.throws(() => stageLinkedInExpansionArtifact(tooMany, { rootDir: root, maxJobs: 2 }), /result limit/);
    const blocked = artifact(t, { expansion_status: 'blocked_captcha', jobs: [] });
    const result = stageLinkedInExpansionArtifact(blocked, { rootDir: root });
    assert.equal(result.status, 'staged');
    assert.equal(JSON.parse(readFileSync(join(root, 'data/linkedin-search-runtime/artifacts', `${t.task_id}.json`), 'utf8')).status, 'blocked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('replays are idempotent and conflicting completed content fails closed', () => {
  const { root, task: t } = setup();
  try {
    const first = stageLinkedInExpansionArtifact(artifact(t), { rootDir: root });
    assert.equal(first.status, 'staged');
    assert.equal(stageLinkedInExpansionArtifact(artifact(t), { rootDir: root }).status, 'no_op');
    assert.equal(stageLinkedInExpansionArtifact(artifact(t, { jobs: [{ ...artifact(t).jobs[0], title: 'Changed' }] }), { rootDir: root }).status, 'conflict_expansion_changed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent expansion feeds complete JD into the existing downstream processor', async () => {
  const { root, task: t } = setup(); const path = join(root, 'artifact.json');
  try {
    writeFileSync(path, JSON.stringify(artifact(t)));
    let seenJd = '';
    const result = await processLinkedInExpansionArtifact({ rootDir: root, artifactPath: path, evaluateJob: async job => { seenJd = job.jd_text; return { status: 'evaluated', approved: true, tier: 'Tier 1', factual_integrity: 'passed', liveness: 'active', report_path: 'reports/099-example.md', tracker_number: 99 }; } });
    assert.equal(result.summary.jobs_queued, 1);
    assert.equal(seenJd, 'Complete rendered job description.');
    assert.equal(result.queue[0].source, 'linkedin-authenticated-expansion');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('blocked artifact does not mark the task completed', async () => {
  const { root, task: t } = setup(); const path = join(root, 'artifact.json');
  try {
    writeFileSync(path, JSON.stringify(artifact(t, { expansion_status: 'blocked_login', jobs: [] })));
    const result = await processLinkedInExpansionArtifact({ rootDir: root, artifactPath: path });
    assert.equal(result.status, 'blocked');
    assert.equal(result.summary.tasks_completed, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('selects the first non-completed task in receiver order and retries blocked tasks', () => {
  const { root, task: first } = setup(); const second = task(); second.source.gmail_message_id = 'msg-second'; second.task_id = deriveLinkedInTaskId(second);
  writeFileSync(join(root, 'data/linkedin-search-inbox', `${second.task_id}.yml`), `${JSON.stringify(second)}\n`);
  try {
    const receiverResult = { status: 'received', results: [
      { status: 'received', destination_inbox_filename: `${first.task_id}.yml` },
      { status: 'received', destination_inbox_filename: `${second.task_id}.yml` },
    ] };
    mkdirSync(join(root, 'data/linkedin-search-runtime/state'), { recursive: true });
    writeFileSync(join(root, 'data/linkedin-search-runtime/state', `${first.task_id}.json`), JSON.stringify({ status: 'completed' }));
    assert.equal(selectNextLinkedInTask({ rootDir: root, receiverResult }).task.task_id, second.task_id);
    writeFileSync(join(root, 'data/linkedin-search-runtime/state', `${second.task_id}.json`), JSON.stringify({ status: 'blocked_login' }));
    assert.equal(selectNextLinkedInTask({ rootDir: root, receiverResult }).current_state, 'blocked_login');
    writeFileSync(join(root, 'data/linkedin-search-runtime/state', `${second.task_id}.json`), JSON.stringify({ status: 'completed' }));
    assert.equal(selectNextLinkedInTask({ rootDir: root, receiverResult }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
