#!/usr/bin/env node

/** Two-pass, non-evaluating JD retrieval accounting for LinkedIn expansions. */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT, readLinkedInExpansionArtifact } from './linkedin-expansion-artifact.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const LINKEDIN_JD_ENRICHMENT_SCHEMA_VERSION = 1;
export const LINKEDIN_JD_RETRIEVAL_STATUSES = Object.freeze([
  'complete', 'partial', 'unavailable', 'dead_or_stale', 'access_blocked', 'not_attempted',
]);
export const MIN_COMPLETE_JD_TEXT_LENGTH = 200;

function nonempty(value) { return String(value ?? '').trim(); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function atomicJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`); }

export function sourceArtifactSha256(sourceRaw) { return sha256(sourceRaw); }

function normalizeJob(job, index, sourceById) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error(`jobs[${index}] must be an object`);
  const id = nonempty(job.linkedin_job_id);
  const source = sourceById.get(id);
  if (!source) throw new Error(`jobs[${index}] is not present in the source artifact`);
  const status = nonempty(job.jd_retrieval_status);
  if (!LINKEDIN_JD_RETRIEVAL_STATUSES.includes(status)) throw new Error(`jobs[${index}].jd_retrieval_status is invalid`);
  const jdText = nonempty(job.jd_text);
  const reason = nonempty(job.jd_retrieval_reason);
  if (status === 'complete' && jdText.length < MIN_COMPLETE_JD_TEXT_LENGTH) throw new Error(`jobs[${index}] complete JD text is too short`);
  if (status === 'partial' && !jdText) throw new Error(`jobs[${index}] partial retrieval requires JD text`);
  if (['unavailable', 'dead_or_stale', 'access_blocked', 'not_attempted'].includes(status) && jdText) throw new Error(`jobs[${index}] ${status} must not contain JD text`);
  if (status !== 'complete' && !reason) throw new Error(`jobs[${index}] ${status} requires jd_retrieval_reason`);
  if (id !== source.linkedin_job_id || nonempty(job.url) !== nonempty(source.url) || nonempty(job.title) !== nonempty(source.title) || nonempty(job.company) !== nonempty(source.company) || nonempty(job.location) !== nonempty(source.location)) {
    throw new Error(`jobs[${index}] identity fields do not match the source artifact`);
  }
  return {
    ...source,
    ...job,
    linkedin_job_id: id,
    url: nonempty(source.url),
    title: nonempty(source.title),
    company: nonempty(source.company),
    location: nonempty(source.location),
    posting_age: nonempty(job.posting_age || source.posting_age),
    posting_date: nonempty(job.posting_date || source.posting_date),
    work_arrangement: nonempty(job.work_arrangement || source.work_arrangement),
    salary: nonempty(job.salary || source.salary),
    jd_text: jdText,
    jd_retrieval_status: status,
    jd_retrieval_reason: reason,
    evaluation_ready: status === 'complete',
  };
}

export function validateLinkedInJDEnrichmentArtifact(artifact, { sourceArtifact, sourceRaw, maxJobs = DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT } = {}) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new Error('LinkedIn JD enrichment artifact must be an object');
  if (artifact.schema_version !== LINKEDIN_JD_ENRICHMENT_SCHEMA_VERSION || artifact.artifact_type !== 'linkedin-jd-enrichment') throw new Error('invalid LinkedIn JD enrichment artifact schema');
  if (!sourceArtifact || !sourceRaw) throw new Error('sourceArtifact and sourceRaw are required');
  if (artifact.task_id !== sourceArtifact.task_id) throw new Error('enrichment task_id does not match the source artifact');
  if (artifact.source_artifact_sha256 !== sourceArtifactSha256(sourceRaw)) throw new Error('source_artifact_sha256 does not match the immutable source artifact');
  if (!/^[0-9a-f]{64}$/.test(nonempty(artifact.source_artifact_sha256))) throw new Error('source_artifact_sha256 is invalid');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(nonempty(artifact.enriched_at))) throw new Error('enriched_at must be an ISO timestamp');
  if (!Number.isInteger(maxJobs) || maxJobs < 1) throw new Error('maxJobs must be a positive integer');
  if (!Array.isArray(artifact.jobs) || artifact.jobs.length !== sourceArtifact.jobs.length || artifact.jobs.length > maxJobs) throw new Error('enrichment must account for every source job within maxJobs');
  const sourceById = new Map(sourceArtifact.jobs.map(job => [nonempty(job.linkedin_job_id), job]));
  const seen = new Set();
  const jobs = artifact.jobs.map((job, index) => {
    const normalized = normalizeJob(job, index, sourceById);
    if (seen.has(normalized.linkedin_job_id)) throw new Error(`duplicate enrichment job ${normalized.linkedin_job_id}`);
    seen.add(normalized.linkedin_job_id);
    return normalized;
  });
  if (seen.size !== sourceById.size || [...sourceById.keys()].some(id => !seen.has(id))) throw new Error('no source job may disappear between discovery and enrichment');
  return { ...artifact, jobs };
}

export function readLinkedInJDEnrichmentArtifact(enrichmentPath, { sourceArtifactPath, maxJobs = DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT } = {}) {
  const sourcePath = resolve(sourceArtifactPath);
  const sourceRaw = readFileSync(sourcePath, 'utf8');
  const sourceArtifact = readLinkedInExpansionArtifact(sourcePath, { maxJobs });
  const artifact = JSON.parse(readFileSync(resolve(enrichmentPath), 'utf8'));
  return validateLinkedInJDEnrichmentArtifact(artifact, { sourceArtifact, sourceRaw, maxJobs });
}

export function evaluationReadyLinkedInJobs(artifact) {
  return artifact.jobs.filter(job => job.evaluation_ready === true && job.jd_retrieval_status === 'complete');
}

export function stageLinkedInJDEnrichmentArtifact({ enrichmentPath, sourceArtifactPath, rootDir = ROOT, maxJobs = DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT } = {}) {
  const sourcePath = resolve(sourceArtifactPath);
  const enrichment = readLinkedInJDEnrichmentArtifact(enrichmentPath, { sourceArtifactPath: sourcePath, maxJobs });
  const root = resolve(rootDir);
  const stagedPath = join(root, 'data', 'linkedin-search-runtime', 'jd-enrichment', `${enrichment.task_id}.json`);
  const statePath = join(root, 'data', 'linkedin-search-runtime', 'retrieval-state', `${enrichment.task_id}.json`);
  const state = {
    status: 'completed', task_id: enrichment.task_id, source_artifact_sha256: enrichment.source_artifact_sha256,
    discovered_count: enrichment.jobs.length, accounted_count: enrichment.jobs.length,
    evaluation_ready_count: evaluationReadyLinkedInJobs(enrichment).length,
    retrieval_status_counts: Object.fromEntries(LINKEDIN_JD_RETRIEVAL_STATUSES.map(status => [status, enrichment.jobs.filter(job => job.jd_retrieval_status === status).length])),
    updated_at: new Date().toISOString(),
  };
  atomicJson(stagedPath, enrichment);
  atomicJson(statePath, state);
  return { status: state.status, task_id: enrichment.task_id, staged_path: stagedPath, retrieval_state_path: statePath, discovered_count: state.discovered_count, accounted_count: state.accounted_count, evaluation_ready_count: state.evaluation_ready_count, retrieval_status_counts: state.retrieval_status_counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const enrichmentPath = process.argv[2];
  const sourceArtifactPath = process.argv.find((arg, index) => arg === '--source-artifact' && process.argv[index + 1]) ? process.argv[process.argv.indexOf('--source-artifact') + 1] : null;
  if (!enrichmentPath || !sourceArtifactPath) { process.stderr.write('Usage: node linkedin-jd-enrichment.mjs <enrichment.json> --source-artifact <source.json>\n'); process.exitCode = 1; }
  else {
    try { process.stdout.write(`${JSON.stringify(stageLinkedInJDEnrichmentArtifact({ enrichmentPath, sourceArtifactPath }), null, 2)}\n`); }
    catch (error) { process.stderr.write(`${JSON.stringify({ status: 'blocked_invalid_jd_enrichment', error: error.message })}\n`); process.exitCode = 1; }
  }
}
