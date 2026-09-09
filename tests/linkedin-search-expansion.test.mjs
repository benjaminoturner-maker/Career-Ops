import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { deriveLinkedInTaskId } from '../github-linkedin-search-receiver.mjs';
import { processLinkedInTasks } from '../linkedin-search-expansion.mjs';

function makeTask(message, subject) { const value = { schema_version: 1, source: { gmail_message_id: message, alert_subject: subject, alert_date: '2026-09-09' }, linkedin_search: { url: `https://www.linkedin.com/jobs/search/?keywords=${message}`, keywords: message } }; value.task_id = deriveLinkedInTaskId(value); return value; }
function setup(tasks) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-linkedin-expansion-'));
  mkdirSync(join(root, 'data/linkedin-search-inbox'), { recursive: true });
  writeFileSync(join(root, 'data/applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-09-01 | Prior Co | Prior Role | 4/5 | Evaluated | - | - | Job URL: https://jobs.example.com/prior |\n');
  const results = tasks.map(task => { const filename = `${task.task_id}.yml`; writeFileSync(join(root, 'data/linkedin-search-inbox', filename), yaml.dump(task)); return { status: 'received', destination_inbox_filename: filename }; });
  return { root, receiverResult: { status: 'received', results } };
}

test('browser blocker is isolated; duplicates and hard gates are rejected; credible role is queued', async () => {
  const blocked = makeTask('blocked', 'Blocked alert'); const good = makeTask('good', 'Good alert');
  const { root, receiverResult } = setup([blocked, good]);
  try {
    const result = await processLinkedInTasks({ rootDir: root, receiverResult,
      history: [{ trackerNumber: 1, company: 'Prior Co', jobTitle: 'Prior Role', applicationDate: '2026-09-01', status: 'Evaluated', notes: '', jobUrl: 'https://jobs.example.com/prior', jobId: '', jdFingerprint: '' }],
      expandTask: async task => task.task_id === blocked.task_id ? { status: 'blocked_captcha', error: 'CAPTCHA shown' } : { status: 'completed', jobs: [
        { id: 'duplicate', company: 'Prior Co', title: 'Prior Role', url: 'https://jobs.example.com/prior' },
        { id: 'hard-gate', company: 'Gate Co', title: 'Licensed Role', url: 'https://jobs.example.com/gate' },
        { id: 'credible', company: 'Credible Co', title: 'VP Operations', url: 'https://jobs.example.com/credible' },
      ] },
      evaluateJob: async job => job.id === 'hard-gate'
        ? { status: 'evaluated', approved: false, hard_gate_mismatch: true, hard_blocker: 'required license missing', factual_integrity: 'passed' }
        : { status: 'evaluated', approved: true, tier: 'Tier 1', factual_integrity: 'passed', liveness: 'active', report_path: 'reports/099-credible.md', tracker_number: 99 },
    });
    assert.equal(result.summary.tasks_received, 2);
    assert.equal(result.summary.tasks_completed, 1);
    assert.equal(result.summary.jobs_seen, 3);
    assert.equal(result.summary.jobs_evaluated, 2);
    assert.equal(result.summary.jobs_queued, 1);
    assert.equal(result.summary.blockers[0].status, 'blocked_captcha');
    assert.equal(result.queue[0].id, 'credible');
    assert.equal(result.queue[0].source, 'linkedin-authenticated-expansion');
    assert.equal(result.queue[0].approved, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
