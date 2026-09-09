import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { deriveLinkedInTaskId, LINKEDIN_SEARCH_LABEL, receiveLinkedInIssue, receiveLinkedInOnce } from '../github-linkedin-search-receiver.mjs';

function task(overrides = {}) {
  const value = { schema_version: 1, source: { gmail_message_id: 'msg-1', alert_subject: 'New energy jobs', alert_date: '2026-09-09' }, linkedin_search: { url: 'https://www.linkedin.com/jobs/search/?keywords=energy&location=Denver', keywords: 'energy', location: 'Denver' }, ...overrides };
  value.task_id = deriveLinkedInTaskId(value); return value;
}
function body(value) { return `Context\n\n\`\`\`yaml\n${yaml.dump(value)}\`\`\`\n`; }
function issue(value = task(), overrides = {}) { return { number: 10, url: 'https://github.com/example/repo/issues/10', body: body(value), labels: [{ name: LINKEDIN_SEARCH_LABEL }], ...overrides }; }
function setup() { const root = mkdtempSync(join(tmpdir(), 'career-ops-linkedin-receiver-')); mkdirSync(join(root, 'data'), { recursive: true }); return root; }
const options = rootDir => ({ rootDir, repository: 'example/repo', now: () => '2026-09-09T12:00:00.000Z' });

test('valid LinkedIn task is received immutably and duplicate is a no-op', () => {
  const root = setup(); try {
    const value = task(); const first = receiveLinkedInIssue(issue(value), options(root));
    assert.equal(first.status, 'received');
    assert.equal(readFileSync(join(root, 'data/linkedin-search-inbox', `${value.task_id}.yml`), 'utf8').includes(value.linkedin_search.url), true);
    assert.equal(receiveLinkedInIssue(issue(value), options(root)).no_op, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real LinkedIn email redirect path with a jobs segment is accepted', () => {
  const root = setup(); try {
    const value = task({ linkedin_search: { url: 'https://www.linkedin.com/comm/jobs/search-results/?keywords=M%26A&geoId=90000034', keywords: 'M&A', location: 'Denver Metropolitan Area' } });
    assert.equal(receiveLinkedInIssue(issue(value), options(root)).status, 'received');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changed Issue body conflicts instead of overwriting immutable LinkedIn task', () => {
  const root = setup(); try {
    const original = task(); receiveLinkedInIssue(issue(original), options(root));
    const changed = task({ source: { gmail_message_id: 'msg-1', alert_subject: 'Edited subject', alert_date: '2026-09-09' } });
    const result = receiveLinkedInIssue(issue(changed), options(root));
    assert.equal(result.status, 'conflict_changed_issue');
    assert.doesNotMatch(readFileSync(join(root, 'data/linkedin-search-inbox', `${original.task_id}.yml`), 'utf8'), /Edited subject/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bad first LinkedIn task does not block a later valid task', () => {
  const root = setup(); try {
    const valid = task({ source: { gmail_message_id: 'msg-2', alert_subject: 'Later alert', alert_date: '2026-09-09' } });
    const invalid = issue(task(), { number: 1, body: '```yaml\nschema_version: 1\ntask_id: wrong\n```' });
    const result = receiveLinkedInOnce({ ...options(root), gh: () => JSON.stringify([invalid, issue(valid, { number: 2 })]) });
    assert.equal(result.status, 'blocked');
    assert.equal(result.results[0].status, 'blocked_invalid_issue');
    assert.equal(result.results[1].status, 'received');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
