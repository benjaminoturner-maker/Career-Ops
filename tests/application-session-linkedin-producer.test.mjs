import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseLinkedInIssuePayload } from '../github-linkedin-search-receiver.mjs';
import { prepareLinkedInSearchIssueCli } from '../application-session.mjs';

const url = 'https://www.linkedin.com/jobs/search/?keywords=Corporate%20Development&location=Denver%2C%20Colorado%2C%20United%20States';
const args = ['--url', url, '--alert-subject', 'Ben: Corporate Development jobs', '--alert-date', '2026-09-10', '--keywords', 'Corporate Development', '--location', 'Denver, Colorado'];

test('CLI preparation is deterministic and receiver-compatible', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-prepared-linkedin-')); try {
    const first = prepareLinkedInSearchIssueCli(args, { rootDir: root });
    const second = prepareLinkedInSearchIssueCli(args, { rootDir: root });
    assert.deepEqual(second, first);
    assert.equal(first.label, 'career-ops-linkedin-search');
    assert.match(first.task_id, /^linkedin-[a-f0-9]{32}$/);
    assert.equal(parseLinkedInIssuePayload(first.body).taskId, first.task_id);
    assert.equal(readFileSync(first.body_path, 'utf8'), first.body);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI fails before creating output for an invalid URL', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-prepared-linkedin-invalid-')); try {
    assert.throws(() => prepareLinkedInSearchIssueCli([...args.slice(0, 0), '--url', `[jobs](${url})`, ...args.slice(1)], { rootDir: root }));
    assert.equal(existsSync(join(root, 'data', 'linkedin-search-runtime', 'prepared-issues')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI preparation performs no GitHub mutation', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-prepared-linkedin-no-gh-')); try {
    const result = prepareLinkedInSearchIssueCli(args, { rootDir: root });
    assert.equal(result.label, 'career-ops-linkedin-search');
    assert.deepEqual(result.body.includes('gh issue create'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
