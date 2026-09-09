#!/usr/bin/env node

/** Transport labeled LinkedIn search tasks into a separate immutable local inbox. */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { DEFAULT_REPOSITORY, runGitHubCli } from './github-handoff-receiver.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const LINKEDIN_SEARCH_LABEL = 'career-ops-linkedin-search';
const TASK_ID_RE = /^linkedin-[a-f0-9]{32}$/;

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function atomicJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`); }
function labelsOf(issue) { return Array.isArray(issue?.labels) ? issue.labels.map(label => typeof label === 'string' ? label : label?.name).filter(Boolean) : []; }
function safeRepository(value) { if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`invalid GitHub repository: ${value}`); return value; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value ?? null;
}

export function deriveLinkedInTaskId(payload) {
  const identity = canonical({ source: payload?.source || {}, linkedin_search: payload?.linkedin_search || {} });
  return `linkedin-${sha256(JSON.stringify(identity)).slice(0, 32)}`;
}

export function validateLinkedInTask(payload) {
  if (payload?.schema_version !== 1) throw new Error('schema_version must be 1');
  if (!payload.source || typeof payload.source !== 'object' || Array.isArray(payload.source)) throw new Error('source must be an object');
  for (const key of ['alert_subject', 'alert_date']) if (!String(payload.source[key] ?? '').trim()) throw new Error(`source.${key} is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.source.alert_date))) throw new Error('source.alert_date must be YYYY-MM-DD');
  if (!payload.linkedin_search || typeof payload.linkedin_search !== 'object' || Array.isArray(payload.linkedin_search)) throw new Error('linkedin_search must be an object');
  const exactUrl = String(payload.linkedin_search.url ?? '').trim();
  let url;
  try { url = new URL(exactUrl); } catch { throw new Error('linkedin_search.url must be a valid URL'); }
  if (url.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(url.hostname) || !url.pathname.startsWith('/jobs')) {
    throw new Error('linkedin_search.url must be an https LinkedIn Jobs URL');
  }
  const expected = deriveLinkedInTaskId(payload);
  if (!TASK_ID_RE.test(String(payload.task_id ?? '')) || payload.task_id !== expected) {
    throw new Error(`task_id must be the deterministic ID for the supplied search context: ${expected}`);
  }
  return payload.task_id;
}

export function parseLinkedInIssuePayload(body) {
  const blocks = [];
  const pattern = /^```(?:yaml|yml)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gmi;
  for (const match of String(body ?? '').matchAll(pattern)) blocks.push(match[1]);
  if (blocks.length === 0) throw new Error('Issue body must contain exactly one fenced YAML LinkedIn search-task block');
  if (blocks.length > 1) throw new Error('Issue body contains more than one candidate YAML LinkedIn search-task block');
  let payload;
  try { payload = yaml.load(blocks[0], { schema: yaml.JSON_SCHEMA }); } catch (error) { throw new Error(`malformed YAML: ${error.message}`); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('YAML LinkedIn search task must be an object');
  const taskId = validateLinkedInTask(payload);
  return { payload, taskId, yamlText: `${blocks[0].replace(/\s+$/, '')}\n` };
}

function statePaths(root, repository, issueNumber) {
  const key = `${repository.replace('/', '--')}--${issueNumber}`;
  const runtime = join(root, 'data', 'linkedin-search-runtime', 'github-receipts');
  return { runtime, receipt: join(runtime, `${key}.json`), key };
}

export function listLinkedInSearchIssues({ repository, gh = runGitHubCli, rootDir = ROOT }) {
  const output = gh(['issue', 'list', '--repo', repository, '--label', LINKEDIN_SEARCH_LABEL, '--state', 'open', '--limit', '100', '--json', 'number,url,title,body,labels'], { cwd: rootDir });
  let issues;
  try { issues = JSON.parse(output); } catch (error) { throw new Error(`GitHub CLI returned invalid JSON: ${error.message}`); }
  if (!Array.isArray(issues)) throw new Error('GitHub CLI issue response must be an array');
  return issues.sort((a, b) => Number(a.number) - Number(b.number));
}

export function receiveLinkedInIssue(issue, { rootDir = ROOT, repository = DEFAULT_REPOSITORY, now = () => new Date().toISOString() } = {}) {
  const root = resolve(rootDir);
  const issueNumber = Number(issue?.number);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('GitHub Issue number must be a positive integer');
  if (!labelsOf(issue).includes(LINKEDIN_SEARCH_LABEL)) return { status: 'ignored', issue_number: issueNumber, reason: `missing ${LINKEDIN_SEARCH_LABEL} label` };
  const body = String(issue.body ?? '');
  const bodyHash = sha256(body);
  const p = statePaths(root, repository, issueNumber);
  const prior = existsSync(p.receipt) ? JSON.parse(readFileSync(p.receipt, 'utf8')) : null;
  if (prior?.status === 'received' && prior.body_hash === bodyHash) return { ...prior, status: 'received', no_op: true };
  if (prior?.status === 'received' && prior.body_hash !== bodyHash) {
    const conflict = { status: 'conflict_changed_issue', repository, issue_number: issueNumber, issue_url: issue.url || null, received_body_hash: prior.body_hash, observed_body_hash: bodyHash, observed_at: now(), error: 'Previously received LinkedIn search Issue body changed; inbox file was not overwritten' };
    atomicJson(join(p.runtime, 'conflicts', `${p.key}--${bodyHash.slice(0, 16)}.json`), conflict);
    return conflict;
  }
  let parsed;
  try { parsed = parseLinkedInIssuePayload(body); } catch (error) {
    const blocked = { status: 'blocked_invalid_issue', repository, issue_number: issueNumber, issue_url: issue.url || null, body_hash: bodyHash, observed_at: now(), error: error.message };
    atomicJson(p.receipt, blocked); return blocked;
  }
  const inbox = join(root, 'data', 'linkedin-search-inbox');
  const filename = `${parsed.taskId}.yml`;
  const destination = join(inbox, filename);
  mkdirSync(inbox, { recursive: true });
  if (existsSync(destination)) {
    if (readFileSync(destination, 'utf8') !== parsed.yamlText) {
      const conflict = { status: 'conflict_destination', repository, issue_number: issueNumber, issue_url: issue.url || null, body_hash: bodyHash, task_id: parsed.taskId, destination_inbox_filename: filename, observed_at: now(), error: 'LinkedIn task destination exists with different content; it was not overwritten' };
      atomicJson(p.receipt, conflict); return conflict;
    }
  } else writeFileSync(destination, parsed.yamlText, { encoding: 'utf8', flag: 'wx' });
  const receipt = { status: 'received', repository, issue_number: issueNumber, issue_url: issue.url || null, received_at: now(), body_hash: bodyHash, payload_hash: sha256(parsed.yamlText), task_id: parsed.taskId, destination_inbox_filename: filename };
  atomicJson(p.receipt, receipt); return receipt;
}

export function receiveLinkedInOnce({ rootDir = ROOT, repository = DEFAULT_REPOSITORY, gh = runGitHubCli, now } = {}) {
  const repo = safeRepository(repository);
  let issues;
  try { issues = listLinkedInSearchIssues({ repository: repo, gh, rootDir }); } catch (error) { return { status: 'github_error', repository: repo, error: error.message }; }
  const results = [];
  for (const issue of issues) {
    try { results.push(receiveLinkedInIssue(issue, { rootDir, repository: repo, now })); }
    catch (error) { results.push({ status: 'blocked_receiver_error', repository: repo, issue_number: Number(issue?.number) || null, issue_url: issue?.url || null, error: error.message }); }
  }
  const blocked = results.some(result => /^(?:blocked_|conflict_)/.test(result.status));
  return { status: blocked ? 'blocked' : results.some(result => result.status === 'received' && !result.no_op) ? 'received' : 'idle', repository: repo, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--once') { process.stderr.write('Usage: node github-linkedin-search-receiver.mjs --once [--repo owner/name]\n'); process.exitCode = 1; }
  else {
    const index = process.argv.indexOf('--repo');
    const result = receiveLinkedInOnce({ repository: index >= 0 ? process.argv[index + 1] : DEFAULT_REPOSITORY });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'blocked' || result.status === 'github_error') process.exitCode = 1;
  }
}
