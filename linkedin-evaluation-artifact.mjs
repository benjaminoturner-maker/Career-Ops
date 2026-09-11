#!/usr/bin/env node

/** Validation and deterministic ingestion for supervised-agent evaluations. */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT, loadImmutableLinkedInTask, readLinkedInExpansionArtifact } from './linkedin-expansion-artifact.mjs';
import { processLinkedInTasks } from './linkedin-search-expansion.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const LINKEDIN_EVALUATION_SCHEMA_VERSION = 1;
const TASK_ID_RE = /^linkedin-[a-f0-9]{32}$/;
const JOB_ID_RE = /^\d+$/;
const CLASSIFICATIONS = new Set(['apply', 'consider', 'reject']);
const GATE_RESULTS = new Set(['passed', 'failed', 'unknown']);
const EVIDENCE_RESULTS = new Set(['sufficient', 'insufficient']);
const CONFIDENCE = new Set(['high', 'medium', 'low']);

function nonempty(value) { return String(value ?? '').trim(); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value ?? null;
}
function fingerprint(value) { return sha256(JSON.stringify(canonical(value))); }
function atomicJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`); }
function requireObject(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`); return value; }
function requireArray(value, name) { if (!Array.isArray(value)) throw new Error(`${name} must be an array`); return value; }
function requireEnum(value, set, name) { const normalized = nonempty(value).toLowerCase(); if (!set.has(normalized)) throw new Error(`${name} must be one of ${[...set].join(', ')}`); return normalized; }

function normalizeProcessing(value, classification, index) {
  const processing = requireObject(value, `jobs[${index}].processing`);
  const status = requireEnum(processing.status, new Set(['evaluated', 'requires_evaluation']), `jobs[${index}].processing.status`);
  const factualIntegrity = requireEnum(processing.factual_integrity, new Set(['passed', 'failed', 'unknown']), `jobs[${index}].processing.factual_integrity`);
  const liveness = requireEnum(processing.liveness, new Set(['active', 'expired', 'uncertain', 'unknown']), `jobs[${index}].processing.liveness`);
  const approved = processing.approved === true;
  if (classification === 'reject' && approved) throw new Error(`jobs[${index}] reject classification cannot be approved`);
  if (classification !== 'reject' && status === 'evaluated' && approved !== true) throw new Error(`jobs[${index}] ${classification} classification must be approved or requires_evaluation`);
  return { ...processing, status, factual_integrity: factualIntegrity, liveness, approved, report_path: nonempty(processing.report_path), tracker_number: processing.tracker_number ?? processing.report_number ?? null };
}

function normalizeJob(value, sourceJobs, index) {
  const job = requireObject(value, `jobs[${index}]`);
  const id = nonempty(job.linkedin_job_id || job.job_id);
  if (!JOB_ID_RE.test(id)) throw new Error(`jobs[${index}].linkedin_job_id must be numeric`);
  const source = sourceJobs.find(candidate => candidate.linkedin_job_id === id);
  if (!source) throw new Error(`jobs[${index}] references an unknown normalized job ID ${id}`);
  for (const key of ['url', 'title', 'company', 'location']) {
    if (nonempty(job[key]) !== nonempty(source[key])) throw new Error(`jobs[${index}].${key} does not match the normalized source job`);
  }
  const classification = requireEnum(job.classification, CLASSIFICATIONS, `jobs[${index}].classification`);
  const fit = requireObject(job.fit_assessment, `jobs[${index}].fit_assessment`);
  if (!nonempty(fit.rationale || fit.summary)) throw new Error(`jobs[${index}].fit_assessment requires rationale or summary`);
  const hardRequirements = requireObject(job.hard_requirements, `jobs[${index}].hard_requirements`);
  const hardGate = requireObject(job.hard_gate, `jobs[${index}].hard_gate`);
  const interview = requireObject(job.interview_credibility, `jobs[${index}].interview_credibility`);
  const evidence = requireArray(job.relevant_candidate_evidence, `jobs[${index}].relevant_candidate_evidence`).map(nonempty).filter(Boolean);
  const gaps = requireArray(job.material_gaps, `jobs[${index}].material_gaps`).map(nonempty).filter(Boolean);
  const confidence = requireEnum(job.confidence, CONFIDENCE, `jobs[${index}].confidence`);
  const evidenceSufficiency = requireEnum(job.evidence_sufficiency, EVIDENCE_RESULTS, `jobs[${index}].evidence_sufficiency`);
  const jdComplete = job.jd_complete === true;
  if (evidenceSufficiency === 'sufficient' && !jdComplete) throw new Error(`jobs[${index}] sufficient evidence requires jd_complete=true`);
  return {
    ...job,
    linkedin_job_id: id,
    url: source.url,
    title: source.title,
    company: source.company,
    location: source.location,
    classification,
    fit_assessment: fit,
    hard_requirements: hardRequirements,
    hard_gate: { ...hardGate, result: requireEnum(hardGate.result, GATE_RESULTS, `jobs[${index}].hard_gate.result`) },
    relevant_candidate_evidence: evidence,
    material_gaps: gaps,
    interview_credibility: { ...interview, result: requireEnum(interview.result, GATE_RESULTS, `jobs[${index}].interview_credibility.result`) },
    compensation: requireObject(job.compensation || {}, `jobs[${index}].compensation`),
    location_assessment: requireObject(job.location_assessment || {}, `jobs[${index}].location_assessment`),
    rationale: nonempty(job.rationale),
    confidence,
    evidence_sufficiency: evidenceSufficiency,
    jd_complete: jdComplete,
    processing: normalizeProcessing(job.processing, classification, index),
  };
}

export function validateLinkedInEvaluationArtifact(artifact, { sourceArtifact, sourceRaw, maxJobs = DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT } = {}) {
  requireObject(artifact, 'evaluation artifact');
  if (artifact.schema_version !== LINKEDIN_EVALUATION_SCHEMA_VERSION) throw new Error(`schema_version must be ${LINKEDIN_EVALUATION_SCHEMA_VERSION}`);
  const source = requireObject(artifact.source, 'source');
  if (!TASK_ID_RE.test(nonempty(source.task_id))) throw new Error('source.task_id must be a valid LinkedIn task ID');
  if (!sourceArtifact || sourceArtifact.task_id !== source.task_id) throw new Error('evaluation source task does not match the normalized artifact');
  if (nonempty(source.artifact_sha256) !== sha256(sourceRaw)) throw new Error('evaluation source artifact hash does not match the normalized artifact');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(nonempty(artifact.evaluated_at))) throw new Error('evaluated_at must be an ISO timestamp');
  const evaluator = requireObject(artifact.evaluator, 'evaluator');
  if (nonempty(evaluator.type) !== 'codex-agent-supervised') throw new Error('evaluator.type must be codex-agent-supervised');
  const jobs = requireArray(artifact.jobs, 'jobs');
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || jobs.length > maxJobs) throw new Error(`jobs must contain at most ${maxJobs} entries`);
  const seen = new Set();
  const normalizedJobs = jobs.map((job, index) => {
    const normalized = normalizeJob(job, sourceArtifact.jobs, index);
    if (seen.has(normalized.linkedin_job_id)) throw new Error(`duplicate evaluated LinkedIn job ID ${normalized.linkedin_job_id}`);
    seen.add(normalized.linkedin_job_id);
    return normalized;
  });
  return { ...artifact, schema_version: LINKEDIN_EVALUATION_SCHEMA_VERSION, source: { ...source, task_id: source.task_id, artifact_sha256: source.artifact_sha256 }, evaluator, evaluated_at: artifact.evaluated_at, jobs: normalizedJobs };
}

function evaluationStatePath(root, taskId) { return join(root, 'data', 'linkedin-search-runtime', 'evaluation-artifacts', `${taskId}.json`); }
function taskStatePath(root, taskId) { return join(root, 'data', 'linkedin-search-runtime', 'state', `${taskId}.json`); }

export function readLinkedInEvaluationArtifact(path, options = {}) {
  return validateLinkedInEvaluationArtifact(JSON.parse(readFileSync(resolve(path), 'utf8')), options);
}

export function stageLinkedInEvaluationArtifact(artifact, { rootDir = ROOT, sourceArtifactPath, maxJobs = DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT } = {}) {
  const root = resolve(rootDir);
  if (!sourceArtifactPath) throw new Error('sourceArtifactPath is required');
  const sourcePath = resolve(sourceArtifactPath);
  const sourceRaw = readFileSync(sourcePath, 'utf8');
  const sourceArtifact = readLinkedInExpansionArtifact(sourcePath, { maxJobs });
  const task = loadImmutableLinkedInTask({ rootDir: root, taskId: sourceArtifact.task_id });
  if (sourceArtifact.expansion_status !== 'completed') throw new Error('source normalized artifact is not completed');
  if (sourceArtifact.exact_search_url !== task.linkedin_search.url) throw new Error('source normalized artifact does not match the immutable task');
  const normalized = validateLinkedInEvaluationArtifact(artifact, { sourceArtifact, sourceRaw, maxJobs });
  const path = evaluationStatePath(root, normalized.source.task_id);
  const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const priorJobs = Array.isArray(prior?.artifact?.jobs) ? prior.artifact.jobs : [];
  const priorById = new Map(priorJobs.map(job => [job.linkedin_job_id, job]));
  for (const job of normalized.jobs) {
    const existing = priorById.get(job.linkedin_job_id);
    if (existing && fingerprint(existing) !== fingerprint(job)) return { status: 'conflict_evaluation_changed', task_id: normalized.source.task_id, artifact_path: path, error: `Evaluation for LinkedIn job ${job.linkedin_job_id} changed` };
    priorById.set(job.linkedin_job_id, existing || job);
  }
  const mergedJobs = [...priorById.values()];
  const merged = { ...normalized, jobs: mergedJobs };
  const fp = fingerprint(merged);
  const sourceJobIds = sourceArtifact.jobs.map(job => job.linkedin_job_id);
  const accountedJobIds = mergedJobs.map(job => job.linkedin_job_id);
  const terminal = sourceJobIds.every(jobId => accountedJobIds.includes(jobId));
  const newJobIds = normalized.jobs.map(job => job.linkedin_job_id).filter(jobId => !priorJobs.some(job => job.linkedin_job_id === jobId));
  if (prior && newJobIds.length === 0) return { status: 'no_op', task_id: normalized.source.task_id, artifact_path: path, fingerprint: prior.fingerprint, artifact: prior.artifact, source_job_ids: sourceJobIds, accounted_job_ids: accountedJobIds, remaining_job_ids: sourceJobIds.filter(jobId => !accountedJobIds.includes(jobId)), new_job_ids: [] };
  atomicJson(path, { status: terminal ? 'completed' : 'partial', task_id: normalized.source.task_id, fingerprint: fp, artifact: merged, source_job_ids: sourceJobIds, accounted_job_ids: accountedJobIds, remaining_job_ids: sourceJobIds.filter(jobId => !accountedJobIds.includes(jobId)), updated_at: new Date().toISOString() });
  return { status: 'staged', task_id: normalized.source.task_id, artifact_path: path, fingerprint: fp, artifact: merged, source_job_ids: sourceJobIds, accounted_job_ids: accountedJobIds, remaining_job_ids: sourceJobIds.filter(jobId => !accountedJobIds.includes(jobId)), new_job_ids: newJobIds };
}

export async function processLinkedInEvaluationArtifact({ evaluationArtifactPath, sourceArtifactPath, rootDir = ROOT, history, maxJobs = DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT } = {}) {
  if (!evaluationArtifactPath || !sourceArtifactPath) throw new Error('evaluationArtifactPath and sourceArtifactPath are required');
  const sourceRaw = readFileSync(resolve(sourceArtifactPath), 'utf8');
  const sourceArtifact = readLinkedInExpansionArtifact(sourceArtifactPath, { maxJobs });
  const evaluationArtifact = readLinkedInEvaluationArtifact(evaluationArtifactPath, { sourceArtifact, sourceRaw, maxJobs });
  const staged = stageLinkedInEvaluationArtifact(evaluationArtifact, { rootDir, sourceArtifactPath, maxJobs });
  if (staged.status === 'conflict_evaluation_changed') return { status: staged.status, queue: [], summary: { tasks_received: 1, tasks_completed: 0, jobs_seen: 0, jobs_evaluated: 0, jobs_queued: 0, blockers: [staged] }, evaluation: staged };
  if (staged.status === 'no_op') return { status: 'no_op', queue: [], summary: { tasks_received: 1, tasks_completed: 0, tasks_partial: 0, jobs_seen: 0, jobs_evaluated: 0, jobs_queued: 0, blockers: [] }, evaluation: staged };
  const byId = Object.fromEntries(evaluationArtifact.jobs.map(job => [job.linkedin_job_id, job.processing]));
  const selectedJobs = sourceArtifact.jobs.filter(job => byId[job.linkedin_job_id] && staged.new_job_ids.includes(job.linkedin_job_id));
  const result = await processLinkedInTasks({
    rootDir,
    receiverResult: { status: 'received', results: [{ status: 'received', destination_inbox_filename: `${sourceArtifact.task_id}.yml` }] },
    expandTask: async () => ({ status: 'completed', jobs: selectedJobs }),
    precomputedEvaluations: byId,
    completion: { source_job_ids: staged.source_job_ids, accounted_job_ids: staged.accounted_job_ids },
    history,
  });
  if (result.summary.tasks_completed > 0 || result.summary.tasks_partial > 0) {
    const path = evaluationStatePath(resolve(rootDir), evaluationArtifact.source.task_id);
    const state = JSON.parse(readFileSync(path, 'utf8'));
    atomicJson(path, { ...state, status: result.status === 'completed' ? 'completed' : 'partial', processed_at: new Date().toISOString(), processing_summary: result.summary });
  }
  return { ...result, evaluation: staged };
}

export function recoverLinkedInEvaluationTask({ taskId, sourceArtifactPath, rootDir = ROOT, maxJobs = DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT } = {}) {
  const root = resolve(rootDir);
  const sourcePath = resolve(sourceArtifactPath);
  const sourceRaw = readFileSync(sourcePath, 'utf8');
  const sourceArtifact = readLinkedInExpansionArtifact(sourcePath, { maxJobs });
  if (sourceArtifact.task_id !== taskId) throw new Error('source artifact task_id does not match recovery task_id');
  const evalPath = evaluationStatePath(root, taskId);
  const evaluationState = JSON.parse(readFileSync(evalPath, 'utf8'));
  const evaluation = validateLinkedInEvaluationArtifact(evaluationState.artifact, { sourceArtifact, sourceRaw, maxJobs });
  const sourceJobIds = sourceArtifact.jobs.map(job => job.linkedin_job_id);
  const accountedJobIds = evaluation.jobs.map(job => job.linkedin_job_id);
  const remainingJobIds = sourceJobIds.filter(jobId => !accountedJobIds.includes(jobId));
  const taskPath = taskStatePath(root, taskId);
  const priorTaskState = existsSync(taskPath) ? JSON.parse(readFileSync(taskPath, 'utf8')) : {};
  const terminal = remainingJobIds.length === 0;
  const nextEvaluationState = { ...evaluationState, status: terminal ? 'completed' : 'partial', source_job_ids: sourceJobIds, accounted_job_ids: accountedJobIds, remaining_job_ids: remainingJobIds, artifact: evaluation, recovery: { reason: 'repaired premature task completion', prior_task_status: priorTaskState.status || null, preserved_accounted_job_ids: accountedJobIds }, updated_at: evaluationState.updated_at };
  const nextTaskState = { ...priorTaskState, status: terminal ? 'completed' : 'partial', task_id: taskId, source_job_ids: sourceJobIds, accounted_job_ids: accountedJobIds, remaining_job_ids: remainingJobIds, recovery: { reason: 'repaired premature task completion', prior_status: priorTaskState.status || null, preserved_accounted_job_ids: accountedJobIds } };
  atomicJson(evalPath, nextEvaluationState);
  atomicJson(taskPath, nextTaskState);
  return { status: terminal ? 'completed' : 'partial', task_id: taskId, source_job_count: sourceJobIds.length, accounted_count: accountedJobIds.length, remaining_count: remainingJobIds.length, evaluation_artifact_path: evalPath, task_state_path: taskPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stderr.write('Use the host-mediated evaluation artifact ingestion API; no evaluator is implemented in this module.\n');
  process.exitCode = 1;
}
