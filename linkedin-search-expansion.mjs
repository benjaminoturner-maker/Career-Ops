#!/usr/bin/env node

/** Safe processor boundary for authenticated LinkedIn search expansion. */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { validateLinkedInTask } from './github-linkedin-search-receiver.mjs';
import { DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT, loadImmutableLinkedInTask, readLinkedInExpansionArtifact, stageLinkedInExpansionArtifact } from './linkedin-expansion-artifact.mjs';
import { loadApplicationHistory, matchPriorApplication } from './scan.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function nonempty(value) { return String(value ?? '').trim(); }
function atomicJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`); }

export function receivedLinkedInTaskFiles(receiverResult) {
  return (Array.isArray(receiverResult?.results) ? receiverResult.results : [])
    .filter(result => result?.status === 'received' && result.destination_inbox_filename)
    .map(result => result.destination_inbox_filename);
}

export function selectNextLinkedInTask({ rootDir = ROOT, receiverResult } = {}) {
  const root = resolve(rootDir);
  for (const filename of receivedLinkedInTaskFiles(receiverResult)) {
    if (!/^linkedin-[a-f0-9]{32}\.yml$/.test(filename)) continue;
    const taskId = filename.slice(0, -4);
    const statePath = join(root, 'data', 'linkedin-search-runtime', 'state', `${taskId}.json`);
    let prior = null;
    try { prior = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null; } catch { continue; }
    if (prior?.status === 'completed') continue;
    try {
      const task = loadImmutableLinkedInTask({ rootDir: root, taskId });
      return { task, filename, state_path: statePath, current_state: prior?.status || 'pending' };
    } catch { /* malformed tasks remain visible as receiver/processor blockers */ }
  }
  return null;
}

export async function processLinkedInExpansionArtifact({ artifactPath, rootDir = ROOT, evaluateJob = defaultEvaluate, history, maxJobs = DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT } = {}) {
  const artifact = readLinkedInExpansionArtifact(artifactPath, { maxJobs });
  const staged = stageLinkedInExpansionArtifact(artifact, { rootDir, maxJobs });
  if (artifact.expansion_status !== 'completed') {
    return { status: 'blocked', queue: [], summary: { tasks_received: 1, tasks_completed: 0, jobs_seen: 0, jobs_evaluated: 0, jobs_queued: 0, blockers: [{ status: artifact.expansion_status, task_id: artifact.task_id, error: 'Agent-mediated LinkedIn expansion did not complete' }], artifact: staged } };
  }
  if (staged.status === 'conflict_expansion_changed') return { status: staged.status, queue: [], summary: { tasks_received: 1, tasks_completed: 0, jobs_seen: 0, jobs_evaluated: 0, jobs_queued: 0, blockers: [staged] } };
  const result = await processLinkedInTasks({
    rootDir,
    receiverResult: { status: 'received', results: [{ status: 'received', destination_inbox_filename: `${artifact.task_id}.yml` }] },
    expandTask: async () => ({ status: 'completed', jobs: artifact.jobs }),
    evaluateJob,
    history,
  });
  if (result.summary.tasks_completed > 0) {
    const statePath = join(resolve(rootDir), 'data', 'linkedin-search-runtime', 'artifacts', `${artifact.task_id}.json`);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    atomicJson(statePath, { ...state, status: 'completed', processed_at: new Date().toISOString(), processing_summary: result.summary });
  }
  return { ...result, artifact: staged };
}

function normalizedJob(job, taskId, index) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error('discovered job must be an object');
  const company = nonempty(job.company); const title = nonempty(job.title || job.role); const url = nonempty(job.url);
  if (!company || !title || !url) throw new Error('discovered job requires company, title, and url');
  let parsed; try { parsed = new URL(url); } catch { throw new Error('discovered job URL is invalid'); }
  if (parsed.protocol !== 'https:') throw new Error('discovered job URL must use https');
  return { ...job, id: nonempty(job.id) || `${taskId}-job-${index + 1}`, company, title, url };
}

function queueItem(job, evaluation, task) {
  return {
    ...job,
    ...evaluation,
    id: nonempty(evaluation.id || job.id),
    company: job.company,
    title: job.title,
    url: job.url,
    approved: true,
    priority: evaluation.tier === 'Tier 1' || evaluation.priority === true,
    lane: evaluation.tier === 'Tier 1' || evaluation.priority === true ? 'priority' : 'fast',
    factual_integrity: 'passed',
    hard_blocker: '',
    liveness: evaluation.liveness === 'active' ? 'active' : null,
    source: 'linkedin-authenticated-expansion',
    linkedin_task_id: task.task_id,
  };
}

const defaultExpand = async () => ({ status: 'blocked_browser', error: 'authenticated LinkedIn browser expansion is required' });
const defaultEvaluate = async () => ({ status: 'requires_evaluation', approved: false });

export async function processLinkedInTasks({
  rootDir = ROOT, receiverResult, expandTask = defaultExpand, evaluateJob = defaultEvaluate, precomputedEvaluations = null, completion = null, history,
} = {}) {
  const root = resolve(rootDir);
  const inbox = join(root, 'data', 'linkedin-search-inbox');
  const stateDir = join(root, 'data', 'linkedin-search-runtime', 'state');
  const files = receivedLinkedInTaskFiles(receiverResult);
  const applicationHistory = history || (files.length ? loadApplicationHistory(join(root, 'data', 'applications.md')) : []);
  const receiverBlockers = (receiverResult?.results || []).filter(result => /^(?:blocked_|conflict_)/.test(nonempty(result?.status)));
  if (receiverResult?.status === 'github_error') receiverBlockers.push({ status: 'github_error', error: receiverResult.error });
  const summary = { tasks_received: files.length, tasks_completed: 0, tasks_partial: 0, jobs_seen: 0, jobs_evaluated: 0, jobs_queued: 0, blockers: receiverBlockers };
  const queue = [];
  const seenThisRun = [];
  for (const filename of files) {
    if (!/^linkedin-[a-f0-9]{32}\.yml$/.test(filename)) { summary.blockers.push({ status: 'blocked_invalid_inbox_filename', filename, error: 'LinkedIn inbox filename is not safe' }); continue; }
    const sourcePath = join(inbox, filename);
    let task; let sourceText;
    try {
      sourceText = readFileSync(sourcePath, 'utf8'); task = yaml.load(sourceText, { schema: yaml.JSON_SCHEMA }); validateLinkedInTask(task);
      if (`${task.task_id}.yml` !== filename) throw new Error('task filename does not match task_id');
    } catch (error) { summary.blockers.push({ status: 'blocked_invalid_inbox_task', filename, error: error.message }); continue; }
    const identity = `${task.task_id}:${sha256(sourceText)}`;
    const statePath = join(stateDir, `${task.task_id}.json`);
    let prior;
    try { prior = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null; }
    catch (error) { summary.blockers.push({ status: 'blocked_invalid_task_state', task_id: task.task_id, error: error.message }); continue; }
    if (prior?.identity && prior.identity !== identity) { summary.blockers.push({ status: 'conflict_task_identity', task_id: task.task_id, error: 'Task content changed after first processing attempt' }); continue; }
    if (prior?.status === 'completed') { summary.tasks_completed++; continue; }
    let expanded;
    try { expanded = await expandTask(task); }
    catch (error) { expanded = { status: 'blocked_browser', error: error.message }; }
    if (expanded?.status !== 'completed' || !Array.isArray(expanded.jobs)) {
      const blocker = { status: nonempty(expanded?.status) || 'blocked_browser', task_id: task.task_id, error: nonempty(expanded?.error || expanded?.reason) || 'LinkedIn expansion did not complete' };
      summary.blockers.push(blocker); atomicJson(statePath, { ...blocker, identity, updated_at: new Date().toISOString() }); continue;
    }
    summary.jobs_seen += expanded.jobs.length;
    const results = [];
    for (let index = 0; index < expanded.jobs.length; index++) {
      let job;
      try { job = normalizedJob(expanded.jobs[index], task.task_id, index); }
      catch (error) { results.push({ status: 'blocked_invalid_job', index, error: error.message }); continue; }
      const priorMatch = matchPriorApplication({ company: job.company, title: job.title, url: job.url, requisitionId: job.requisition_id, description: job.jd_text }, [...applicationHistory, ...seenThisRun]);
      if (priorMatch.kind !== 'none') { results.push({ status: 'skipped_history', job: job.id, match: priorMatch.kind }); continue; }
      seenThisRun.push({ trackerNumber: null, company: job.company, jobTitle: job.title, applicationDate: '', status: 'Evaluated', notes: 'LinkedIn expansion this run', jobUrl: job.url, jobId: nonempty(job.requisition_id), jdFingerprint: '' });
      let evaluation;
      if (precomputedEvaluations) {
        evaluation = precomputedEvaluations[job.linkedin_job_id || job.id];
        if (!evaluation) { results.push({ status: 'blocked_missing_evaluation', job: job.id, error: 'No validated agent evaluation exists for this normalized job' }); continue; }
        summary.jobs_evaluated++;
      } else {
        try { evaluation = await evaluateJob(job, task); summary.jobs_evaluated++; }
        catch (error) { results.push({ status: 'blocked_evaluation', job: job.id, error: error.message }); continue; }
      }
      if (evaluation?.hard_gate_mismatch === true || nonempty(evaluation?.hard_blocker)) { results.push({ status: 'rejected_hard_gate', job: job.id, reason: nonempty(evaluation.hard_blocker) || 'central hard-gate mismatch' }); continue; }
      if (evaluation?.status !== 'evaluated' || evaluation?.approved !== true || nonempty(evaluation?.factual_integrity).toLowerCase() !== 'passed') {
        results.push({ status: 'not_queued', job: job.id, reason: 'normal Career Ops approval and factual-integrity checks did not pass' }); continue;
      }
      if (evaluation?.liveness !== 'active') { results.push({ status: 'not_queued', job: job.id, reason: 'normal Career Ops liveness check did not confirm an active posting' }); continue; }
      if (!nonempty(evaluation?.report_path) || !nonempty(evaluation?.tracker_number || evaluation?.report_number)) {
        results.push({ status: 'not_queued', job: job.id, reason: 'normal Career Ops report/tracker evaluation output is required' }); continue;
      }
      const queued = queueItem(job, evaluation, task); queue.push(queued); summary.jobs_queued++; results.push({ status: 'queued', job: job.id });
    }
    const sourceJobIds = completion?.source_job_ids || null;
    const accountedJobIds = completion?.accounted_job_ids || null;
    const taskComplete = !sourceJobIds || sourceJobIds.every(jobId => accountedJobIds.includes(jobId));
    if (taskComplete) summary.tasks_completed++; else summary.tasks_partial++;
    atomicJson(statePath, {
      status: taskComplete ? 'completed' : 'partial', task_id: task.task_id, identity, exact_url: task.linkedin_search.url,
      ...(completion ? { source_job_ids: sourceJobIds, accounted_job_ids: accountedJobIds, remaining_job_ids: sourceJobIds.filter(jobId => !accountedJobIds.includes(jobId)) } : {}),
      ...(taskComplete ? { completed_at: new Date().toISOString() } : { updated_at: new Date().toISOString() }), results,
    });
  }
  return { status: summary.blockers.length ? 'blocked' : completion && summary.tasks_partial > 0 && summary.tasks_completed === 0 ? 'partial' : 'completed', queue, summary };
}
