#!/usr/bin/env node

/** Build a validated, receiver-compatible LinkedIn search Issue payload. */
import yaml from 'js-yaml';
import { deriveLinkedInTaskId, LINKEDIN_SEARCH_LABEL, validateLinkedInTask } from './github-linkedin-search-receiver.mjs';

function nonempty(value) { return String(value ?? '').trim(); }

/**
 * Validate without rewriting the URL. This preserves LinkedIn's complete query
 * string and percent encoding exactly as supplied by the alert producer.
 */
export function normalizeLinkedInSearchUrl(value) {
  const raw = nonempty(value);
  if (!raw) throw new Error('linkedin_search.url is required');
  if (/\r|\n|[\u0000-\u001f\u007f]/.test(raw)) throw new Error('linkedin_search.url must not contain whitespace or control characters');
  if (/^\[[^\]]+\]\([^\)]+\)$/.test(raw)) throw new Error('linkedin_search.url must be a raw URL, not Markdown link syntax');
  if (/^<[^>]+>$/.test(raw)) throw new Error('linkedin_search.url must be a raw URL, not angle-bracket syntax');
  if (/[<>]/.test(raw)) throw new Error('linkedin_search.url must not contain angle brackets');
  if (/&amp;|&#x?[0-9a-f]+;/i.test(raw)) throw new Error('linkedin_search.url must preserve URL ampersands, not HTML entities');
  if (/%(?![0-9a-f]{2})/i.test(raw)) throw new Error('linkedin_search.url contains a malformed percent escape');

  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('linkedin_search.url must be a valid URL'); }
  if (parsed.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(parsed.hostname) || !/(?:^|\/)jobs(?:\/|$)/i.test(parsed.pathname)) {
    throw new Error('linkedin_search.url must be an https LinkedIn Jobs URL');
  }
  return raw;
}

export function buildLinkedInSearchTask({ source, linkedin_search }) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('source must be an object');
  if (!linkedin_search || typeof linkedin_search !== 'object' || Array.isArray(linkedin_search)) throw new Error('linkedin_search must be an object');
  const task = {
    schema_version: 1,
    source: { ...source },
    linkedin_search: { ...linkedin_search, url: normalizeLinkedInSearchUrl(linkedin_search.url) },
  };
  task.task_id = deriveLinkedInTaskId(task);
  validateLinkedInTask(task);
  return task;
}

export function renderLinkedInSearchIssueBody(task) {
  validateLinkedInTask(task);
  const text = yaml.dump(task, { noRefs: true, lineWidth: -1 }).replace(/\s+$/, '');
  return `LinkedIn search expansion task.\n\n\`\`\`yaml\n${text}\n\`\`\`\n`;
}

export function prepareLinkedInSearchIssue(input) {
  const task = buildLinkedInSearchTask(input);
  return { label: LINKEDIN_SEARCH_LABEL, task, body: renderLinkedInSearchIssueBody(task) };
}

if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replaceAll('\\', '/'))) {
  process.stderr.write('This module is an importable producer helper; it does not create GitHub Issues.\n');
  process.exitCode = 1;
}
