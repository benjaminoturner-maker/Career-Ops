import test from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { buildLinkedInSearchTask, normalizeLinkedInSearchUrl, prepareLinkedInSearchIssue, renderLinkedInSearchIssueBody } from '../linkedin-search-issue-producer.mjs';
import { parseLinkedInIssuePayload } from '../github-linkedin-search-receiver.mjs';

const source = { gmail_message_id: 'producer-test-1', alert_subject: 'New jobs', alert_date: '2026-09-10' };
const valid = 'https://www.linkedin.com/jobs/search/?keywords=Corporate%20Development&location=Denver%2C%20Colorado%2C%20United%20States';

test('accepts a raw LinkedIn Jobs URL and preserves it exactly', () => {
  assert.equal(normalizeLinkedInSearchUrl(`  ${valid}  `), valid);
  assert.equal(buildLinkedInSearchTask({ source, linkedin_search: { url: valid, keywords: 'Corporate Development' } }).linkedin_search.url, valid);
});

test('preserves long encoded query strings and ampersands', () => {
  const url = 'https://www.linkedin.com/comm/jobs/search-results/?keywords=M%26A&f_SAL=f_SA_id_227001%3A272003%2C279001%24f_SA_id_226001%3A272015&geoId=90000034&origin=SEMANTIC_SEARCH_JOB_ALERT_EMAIL';
  assert.equal(normalizeLinkedInSearchUrl(url), url);
  const task = buildLinkedInSearchTask({ source, linkedin_search: { url } });
  assert.equal(task.linkedin_search.url, url);
});

test('rejects Markdown, angle brackets, HTML entities, and malformed or truncated URLs', () => {
  for (const value of [`[jobs](${valid})`, `<${valid}>`, valid.replace('&', '&amp;'), valid.replace('United%20States', 'United%2'), 'not-a-url']) {
    assert.throws(() => normalizeLinkedInSearchUrl(value));
  }
});

test('rejects non-LinkedIn URLs', () => {
  assert.throws(() => normalizeLinkedInSearchUrl('https://example.com/jobs/search/?keywords=energy'));
  assert.throws(() => normalizeLinkedInSearchUrl('http://www.linkedin.com/jobs/search/?keywords=energy'));
});

test('emitted YAML round-trips through receiver validation', () => {
  const prepared = prepareLinkedInSearchIssue({ source, linkedin_search: { url: valid, keywords: 'Corporate Development', location: 'Denver, Colorado' } });
  assert.equal(prepared.label, 'career-ops-linkedin-search');
  const parsed = parseLinkedInIssuePayload(prepared.body);
  assert.equal(parsed.taskId, prepared.task.task_id);
  assert.deepEqual(parsed.payload.linkedin_search, prepared.task.linkedin_search);
  assert.deepEqual(yaml.load(parsed.yamlText).linkedin_search, prepared.task.linkedin_search);
});

test('producer fails closed before an Issue body can be emitted', () => {
  assert.throws(() => prepareLinkedInSearchIssue({ source, linkedin_search: { url: `[jobs](${valid})` } }));
});

test('renderer preserves receiver-compatible task identity', () => {
  const task = buildLinkedInSearchTask({ source, linkedin_search: { url: valid } });
  assert.equal(parseLinkedInIssuePayload(renderLinkedInSearchIssueBody(task)).taskId, task.task_id);
});
