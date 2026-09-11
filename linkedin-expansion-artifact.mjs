#!/usr/bin/env node

/** Validation and immutable staging for agent-mediated LinkedIn expansions. */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { validateLinkedInTask } from './github-linkedin-search-receiver.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const LINKEDIN_EXPANSION_SCHEMA_VERSION = 1;
export const DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT = 25;
const TASK_ID_RE = /^linkedin-[a-f0-9]{32}$/;
const JOB_ID_RE = /^\d+$/;
const COMPLETED = 'completed';

function nonempty(value) { return String(value ?? '').trim(); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value ?? null;
}
function fingerprint(value) { return sha256(JSON.stringify(canonical(value))); }
function atomicJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`); }

export function linkedinJobIdFromUrl(value) {
  let url;
  try { url = new URL(nonempty(value)); } catch { throw new Error('LinkedIn job URL is invalid'); }
  if (url.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(url.hostname)) throw new Error('LinkedIn job URL must be an https LinkedIn URL');
  const match = url.pathname.match(/^\/jobs\/view\/(\d+)(?:\/|$)/i);
  if (!match || !JOB_ID_RE.test(match[1])) throw new Error('LinkedIn job URL must contain a numeric /jobs/view/{id}/ path');
  return match[1];
}

function normalizeJob(job, index) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error(`jobs[${index}] must be an object`);
  const url = nonempty(job.url);
  const derivedId = linkedinJobIdFromUrl(url);
  if (nonempty(job.linkedin_job_id || job.job_id) !== derivedId) throw new Error(`jobs[${index}].linkedin_job_id must match its LinkedIn URL`);
  const title = nonempty(job.title);
  const company = nonempty(job.company);
  const location = nonempty(job.location);
  if (!title || !company || !location) throw new Error(`jobs[${index}] requires title, company, and location`);
  return {
    ...job,
    id: derivedId,
    linkedin_job_id: derivedId,
    url,
    title,
    company,
    location,
    posting_age: nonempty(job.posting_age),
    posting_date: nonempty(job.posting_date),
    work_arrangement: nonempty(job.work_arrangement),
    salary: nonempty(job.salary),
    jd_text: nonempty(job.jd_text),
  };
}

function issueIdentity(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('issue must be an object when supplied');
  const repository = nonempty(value.repository);
  const number = Number(value.number);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isInteger(number) || number < 1) throw new Error('issue requires repository and positive number');
  return { repository, number, url: nonempty(value.url) || null };
}

export function validateLinkedInExpansionArtifact(artifact, { task = null, maxJobs = DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT } = {}) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new Error('LinkedIn expansion artifact must be an object');
  if (artifact.schema_version !== LINKEDIN_EXPANSION_SCHEMA_VERSION) throw new Error(`schema_version must be ${LINKEDIN_EXPANSION_SCHEMA_VERSION}`);
  if (!TASK_ID_RE.test(nonempty(artifact.task_id))) throw new Error('task_id must be a valid LinkedIn task ID');
  const exactUrl = nonempty(artifact.exact_search_url || artifact.linkedin_search_url);
  if (!exactUrl) throw new Error('exact_search_url is required');
  let parsedUrl; try { parsedUrl = new URL(exactUrl); } catch { throw new Error('exact_search_url must be a valid URL'); }
  if (parsedUrl.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(parsedUrl.hostname) || !/(?:^|\/)jobs(?:\/|$)/i.test(parsedUrl.pathname)) throw new Error('exact_search_url must be an https LinkedIn Jobs URL');
  const issue = issueIdentity(artifact.issue);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(nonempty(artifact.expanded_at))) throw new Error('expanded_at must be an ISO timestamp');
  const status = nonempty(artifact.expansion_status);
  if (!status || (status !== COMPLETED && !/^blocked_[a-z0-9_]+$/.test(status))) throw new Error('expansion_status must be completed or blocked_*');
  if (!Number.isInteger(maxJobs) || maxJobs < 1) throw new Error('maxJobs must be a positive integer');
  if (!Array.isArray(artifact.jobs)) throw new Error('jobs must be an array');
  if (artifact.jobs.length > maxJobs) throw new Error(`jobs exceeds the conservative result limit of ${maxJobs}`);
  if (status !== COMPLETED && artifact.jobs.length > 0) throw new Error('blocked expansion artifacts must not contain jobs');
  const seen = new Set(); const jobs = [];
  for (let index = 0; index < artifact.jobs.length; index++) {
    const job = normalizeJob(artifact.jobs[index], index);
    if (seen.has(job.linkedin_job_id)) continue;
    seen.add(job.linkedin_job_id); jobs.push(job);
  }
  if (task) {
    validateLinkedInTask(task);
    if (task.task_id !== artifact.task_id) throw new Error('artifact task_id does not match the immutable LinkedIn task');
    if (task.linkedin_search.url !== exactUrl) throw new Error('artifact exact_search_url does not match the immutable LinkedIn task URL');
  }
  return { ...artifact, task_id: artifact.task_id, exact_search_url: exactUrl, issue, expanded_at: artifact.expanded_at, expansion_status: status, jobs };
}

function taskPath(root, taskId) { return join(root, 'data', 'linkedin-search-inbox', `${taskId}.yml`); }
function artifactStatePath(root, taskId) { return join(root, 'data', 'linkedin-search-runtime', 'artifacts', `${taskId}.json`); }

export function loadImmutableLinkedInTask({ rootDir = ROOT, taskId }) {
  if (!TASK_ID_RE.test(nonempty(taskId))) throw new Error('task_id is invalid');
  const path = taskPath(resolve(rootDir), taskId);
  if (!existsSync(path)) throw new Error(`unknown LinkedIn task: ${taskId}`);
  const task = yaml.load(readFileSync(path, 'utf8'), { schema: yaml.JSON_SCHEMA });
  validateLinkedInTask(task);
  if (task.task_id !== taskId) throw new Error('immutable LinkedIn task filename does not match task_id');
  return task;
}

export function stageLinkedInExpansionArtifact(artifact, { rootDir = ROOT, maxJobs = DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT } = {}) {
  const root = resolve(rootDir);
  const task = loadImmutableLinkedInTask({ rootDir: root, taskId: artifact?.task_id });
  const normalized = validateLinkedInExpansionArtifact(artifact, { task, maxJobs });
  if (normalized.issue) {
    const receiptPath = join(root, 'data', 'linkedin-search-runtime', 'github-receipts', `${normalized.issue.repository.replace('/', '--')}--${normalized.issue.number}.json`);
    if (!existsSync(receiptPath)) throw new Error('artifact Issue identity has no matching immutable receiver receipt');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (receipt.task_id !== normalized.task_id) throw new Error('artifact Issue identity does not match the immutable receiver receipt');
    if (normalized.issue.url && receipt.issue_url && normalized.issue.url !== receipt.issue_url) throw new Error('artifact Issue URL does not match the immutable receiver receipt');
  }
  const path = artifactStatePath(root, normalized.task_id);
  const fp = fingerprint(normalized);
  const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  if (prior?.status === 'completed') {
    if (prior.fingerprint === fp) return { status: 'no_op', task_id: normalized.task_id, artifact_path: path, fingerprint: fp };
    return { status: 'conflict_expansion_changed', task_id: normalized.task_id, artifact_path: path, error: 'Completed LinkedIn expansion already exists with different content' };
  }
  if (prior?.status === 'staged' && prior.fingerprint === fp) return { status: 'no_op', task_id: normalized.task_id, artifact_path: path, fingerprint: fp };
  if (prior?.status === 'blocked' && prior.fingerprint === fp) return { status: 'no_op', task_id: normalized.task_id, artifact_path: path, fingerprint: fp };
  if (prior?.status === 'staged') return { status: 'conflict_expansion_changed', task_id: normalized.task_id, artifact_path: path, error: 'Staged LinkedIn expansion already exists with different content' };
  const state = { status: normalized.expansion_status === COMPLETED ? 'staged' : 'blocked', task_id: normalized.task_id, exact_search_url: normalized.exact_search_url, fingerprint: fp, artifact: normalized, updated_at: new Date().toISOString() };
  atomicJson(path, state);
  return { status: 'staged', task_id: normalized.task_id, artifact_path: path, fingerprint: fp, artifact: normalized };
}

export function readLinkedInExpansionArtifact(path, options = {}) {
  const artifact = JSON.parse(readFileSync(resolve(path), 'utf8'));
  return validateLinkedInExpansionArtifact(artifact, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const artifactPath = process.argv[2];
  if (!artifactPath) { process.stderr.write('Usage: node linkedin-expansion-artifact.mjs <artifact.json>\n'); process.exitCode = 1; }
  else {
    try { process.stdout.write(`${JSON.stringify(stageLinkedInExpansionArtifact(readLinkedInExpansionArtifact(artifactPath)), null, 2)}\n`); }
    catch (error) { process.stderr.write(`${JSON.stringify({ status: 'blocked_invalid_expansion', error: error.message })}\n`); process.exitCode = 1; }
  }
}
