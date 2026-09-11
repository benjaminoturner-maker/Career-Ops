#!/usr/bin/env node

/**
 * Durable, human-in-the-loop application-session controller.
 *
 * This module coordinates queue selection and cheap preflight. It deliberately
 * does not drive a browser or expose a final-submit action. Existing Career Ops
 * modes prepare/fill the application; Ben reviews and submits it; only an
 * explicit `confirm-submitted --confirmed-by-ben` transition records Applied.
 */
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { checkLivenessViaApi } from './liveness-api.mjs';
import { loadApplicationHistory, loadBlacklist, matchPriorApplication } from './scan.mjs';
import { normalizeCompany, writeFileAtomic } from './tracker-utils.mjs';
import { normalizeApplicationAnswersSnapshot, upsertApplicationAnswersSection } from './application-answers.mjs';
import { seedFollowup } from './followup-seed.mjs';
import { receiveOnce } from './github-handoff-receiver.mjs';
import { receiveLinkedInOnce } from './github-linkedin-search-receiver.mjs';
import { processLinkedInTasks, selectNextLinkedInTask } from './linkedin-search-expansion.mjs';
import { readLinkedInExpansionArtifact, stageLinkedInExpansionArtifact, DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT } from './linkedin-expansion-artifact.mjs';
import { prepareLinkedInSearchIssue } from './linkedin-search-issue-producer.mjs';
import { processLinkedInEvaluationArtifact } from './linkedin-evaluation-artifact.mjs';
import { recoverLinkedInEvaluationTask } from './linkedin-evaluation-artifact.mjs';
import { runOnce as runHandoffOnce } from './handoff-runner.mjs';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCHEMA_VERSION = 1;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const SAFE_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LANES = new Set(['fast', 'priority', 'defer']);
const LIVENESS = new Set(['active', 'expired', 'uncertain']);
const PRIOR_COMPANY_HARD_GATE_RE = /\[prior-company-hard-gate:\s*([^|\]]+)\|\s*([^\]]+)\]/gi;

function iso(now = new Date()) { return now.toISOString(); }
function round1(value) { return Math.round(value * 10) / 10; }
function nonempty(value) { return String(value ?? '').trim(); }

export function matchPriorCompanyHardGate(item, history = []) {
  const company = normalizeCompany(item?.company);
  if (!company) return null;
  for (const record of history) {
    const notes = nonempty(record?.notes);
    for (const match of notes.matchAll(PRIOR_COMPANY_HARD_GATE_RE)) {
      if (normalizeCompany(match[1]) !== company) continue;
      return { record, reason: nonempty(match[2]) || 'known employer-specific hard-gate mismatch' };
    }
  }
  return null;
}

function safeSessionId(value) {
  const id = nonempty(value) || `session-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  if (!SAFE_ID.test(id)) throw new Error('session id must be 3-128 filename-safe characters');
  return id;
}

function itemId(item, index) {
  const supplied = nonempty(item?.id);
  if (supplied && SAFE_ITEM_ID.test(supplied)) return supplied;
  return `item-${String(index + 1).padStart(3, '0')}`;
}

function normalizeItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`queue item ${index + 1} must be an object`);
  const company = nonempty(item.company);
  const title = nonempty(item.title || item.role);
  const url = nonempty(item.url);
  if (!company || !title || !url) throw new Error(`queue item ${index + 1} requires company, title/role, and url`);
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`queue item ${index + 1} has an invalid url`); }
  if (parsed.protocol !== 'https:') throw new Error(`queue item ${index + 1} url must use https`);
  const explicitLane = nonempty(item.lane).toLowerCase();
  if (explicitLane && !LANES.has(explicitLane)) throw new Error(`queue item ${index + 1} lane must be fast, priority, or defer`);
  const explicitLiveness = nonempty(item.liveness).toLowerCase();
  if (explicitLiveness && !LIVENESS.has(explicitLiveness)) throw new Error(`queue item ${index + 1} liveness must be active, expired, or uncertain`);
  return {
    ...item,
    id: itemId(item, index),
    company,
    title,
    url,
    approved: item.approved === true,
    priority: item.priority === true,
    lane: explicitLane || null,
    liveness: explicitLiveness || null,
    friction: nonempty(item.friction || 'low').toLowerCase(),
    friction_reason: nonempty(item.friction_reason),
    hard_blocker: nonempty(item.hard_blocker),
    required_facts: Array.isArray(item.required_facts) ? item.required_facts.map(nonempty).filter(Boolean) : [],
    factual_integrity: nonempty(item.factual_integrity).toLowerCase() || 'unknown',
  };
}

export function classifyLane(item) {
  const highFriction = ['high', 'captcha', 'assessment', 'essay', 'login', 'workday', 'blocked'].includes(item.friction);
  if (item.lane === 'defer' || highFriction || item.hard_blocker || (item.required_facts?.length || 0) > 0) return 'defer';
  if (item.lane === 'priority' || item.priority) return 'priority';
  return 'fast';
}

export function createSession(items, options = {}) {
  if (!Array.isArray(items) || (items.length === 0 && options.allowEmpty !== true)) throw new Error('session queue must contain at least one item');
  const targetMinutes = Number(options.targetMinutes ?? 30);
  if (!Number.isFinite(targetMinutes) || targetMinutes <= 0) throw new Error('target minutes must be greater than zero');
  const now = options.now ? new Date(options.now) : new Date();
  const sessionId = safeSessionId(options.sessionId);
  return {
    schema_version: SCHEMA_VERSION,
    session_id: sessionId,
    started_at: iso(now),
    updated_at: iso(now),
    ended_at: null,
    target_minutes: targetMinutes,
    ben_attention_minutes: 0,
    status: 'active',
    current_item: null,
    remaining_queue: items.map(normalizeItem),
    completed_items: [],
    prepared_items: [],
    skipped_items: [],
    deferred_items: [],
    blocker_reason: null,
    next_recommended_item: null,
  };
}

export function defaultStatePath(sessionId, rootDir = ROOT) {
  return join(resolve(rootDir), 'data', 'application-sessions', `${safeSessionId(sessionId)}.json`);
}

export function saveSession(state, statePath) {
  if (!statePath) throw new Error('state path is required');
  state.updated_at = iso();
  state.next_recommended_item = state.current_item || state.remaining_queue[0] || null;
  mkdirSync(dirname(resolve(statePath)), { recursive: true });
  writeFileAtomic(resolve(statePath), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function loadSession(statePath) {
  const state = JSON.parse(readFileSync(resolve(statePath), 'utf8'));
  if (state?.schema_version !== SCHEMA_VERSION || !SAFE_ID.test(String(state?.session_id || ''))) throw new Error('unsupported or malformed application-session state');
  for (const key of ['remaining_queue', 'completed_items', 'prepared_items', 'skipped_items', 'deferred_items']) {
    if (!Array.isArray(state[key])) throw new Error(`malformed application-session state: ${key} must be an array`);
  }
  return state;
}

function elapsedWallMinutes(state, now = new Date()) {
  const end = state.ended_at ? new Date(state.ended_at) : now;
  return Math.max(0, round1((end.getTime() - new Date(state.started_at).getTime()) / 60_000));
}

function remainingAttentionMinutes(state) {
  return Math.max(0, round1(state.target_minutes - Number(state.ben_attention_minutes || 0)));
}

function selectNextIndex(state) {
  if (remainingAttentionMinutes(state) > 5) return 0;
  const fast = state.remaining_queue.findIndex(item => classifyLane(item) === 'fast');
  return fast;
}

function outcome(item, lane, reason, extra = {}) {
  return { id: item.id, company: item.company, title: item.title, url: item.url, lane, reason, recorded_at: iso(), ...extra };
}

async function defaultLiveness(item) {
  if (item.liveness) return { result: item.liveness, reason: item.liveness_reason || 'queue-provided liveness result' };
  const result = await checkLivenessViaApi(item.url);
  return result || { result: 'uncertain', code: 'browser_check_required', reason: 'ATS API could not confirm liveness; run the existing browser liveness check' };
}

function defaultPreparation(item, lane) {
  return {
    status: 'ready_for_preparation',
    lane,
    instruction: `Use the existing Career Ops PDF/apply workflow for ${item.company} — ${item.title}; return with the form ready for Ben's review.`,
  };
}

export function createDefaultAdapters(options = {}) {
  const rootDir = resolve(options.rootDir || ROOT);
  const history = options.history || loadApplicationHistory(join(rootDir, 'data', 'applications.md'));
  const blacklist = options.blacklist || loadBlacklist(join(rootDir, 'data', 'blacklist.md'));
  return {
    history,
    blacklist,
    checkLiveness: options.checkLiveness || defaultLiveness,
    prepareItem: options.prepareItem || defaultPreparation,
    recordSubmission: options.recordSubmission || ((item, confirmation) => recordConfirmedSubmission(item, confirmation, { rootDir })),
  };
}

export async function advanceSession(state, adapters = createDefaultAdapters()) {
  if (state.current_item) return state;
  state.blocker_reason = null;
  while (state.remaining_queue.length > 0) {
    if (remainingAttentionMinutes(state) <= 0) {
      state.status = 'budget_exhausted';
      state.ended_at = state.ended_at || iso();
      state.next_recommended_item = state.remaining_queue[0];
      return state;
    }
    const index = selectNextIndex(state);
    if (index < 0) {
      state.status = 'budget_near_end';
      state.ended_at = state.ended_at || iso();
      state.next_recommended_item = state.remaining_queue[0];
      return state;
    }
    const [item] = state.remaining_queue.splice(index, 1);
    const lane = classifyLane(item);
    const priorHardGate = matchPriorCompanyHardGate(item, adapters.history || []);
    if (priorHardGate) {
      state.deferred_items.push(outcome(item, 'defer', `prior-company-hard-gate: ${priorHardGate.reason}`, { prior_application: priorHardGate.record }));
      continue;
    }
    const prior = matchPriorApplication({ company: item.company, title: item.title, url: item.url, requisitionId: item.requisition_id, description: item.jd_text }, adapters.history || []);
    if (prior.kind === 'previously_applied') {
      state.skipped_items.push(outcome(item, lane, 'already-applied', { prior_application: prior.record }));
      continue;
    }
    if (prior.kind === 'possible_repost') {
      state.deferred_items.push(outcome(item, 'defer', `possible-repost: ${prior.reason}`));
      continue;
    }
    let live;
    try {
      live = await adapters.checkLiveness(item);
    } catch (error) {
      state.current_item = { ...item, lane, stage: 'liveness-check' };
      state.status = 'blocked';
      state.blocker_reason = `liveness-check-failed: ${error.message}`;
      state.next_recommended_item = state.current_item;
      return state;
    }
    if (live?.result === 'expired') {
      state.skipped_items.push(outcome(item, lane, `dead-posting: ${live.reason || 'expired'}`));
      continue;
    }
    if (live?.result !== 'active') {
      state.deferred_items.push(outcome(item, 'defer', `liveness-unconfirmed: ${live?.reason || 'browser check required'}`));
      continue;
    }
    const blacklisted = adapters.blacklist?.get(normalizeCompany(item.company));
    if (blacklisted) {
      state.skipped_items.push(outcome(item, lane, `blacklisted: ${blacklisted.reason || blacklisted.scope || 'company exclusion'}`));
      continue;
    }
    if (!item.approved) {
      state.deferred_items.push(outcome(item, 'defer', 'requires-evaluation: no trusted approval/handoff'));
      continue;
    }
    if (item.hard_blocker) {
      state.deferred_items.push(outcome(item, 'defer', `hard-eligibility-blocker: ${item.hard_blocker}`));
      continue;
    }
    if (item.required_facts.length > 0) {
      state.deferred_items.push(outcome(item, 'defer', `candidate-confirmation-required: ${item.required_facts.join('; ')}`));
      continue;
    }
    if (item.factual_integrity !== 'passed') {
      state.deferred_items.push(outcome(item, 'defer', 'factual-integrity-check-required'));
      continue;
    }
    if (lane === 'defer') {
      state.deferred_items.push(outcome(item, lane, item.friction_reason || `high-friction: ${item.friction}`));
      continue;
    }
    let preparation;
    try {
      preparation = await adapters.prepareItem(item, lane);
    } catch (error) {
      state.current_item = { ...item, lane, stage: 'preparation' };
      state.status = 'blocked';
      state.blocker_reason = `preparation-failed: ${error.message}`;
      state.next_recommended_item = state.current_item;
      return state;
    }
    if (preparation?.status === 'blocked' || preparation?.status === 'deferred') {
      state.deferred_items.push(outcome(item, 'defer', preparation.reason || 'preparation-blocked'));
      continue;
    }
    state.current_item = { ...item, lane, preparation: preparation || defaultPreparation(item, lane) };
    state.status = preparation?.status === 'prepared_for_review' ? 'awaiting_submission_confirmation' : 'ready_for_preparation';
    if (state.status === 'awaiting_submission_confirmation') markPrepared(state, preparation);
    state.next_recommended_item = state.current_item;
    return state;
  }
  state.status = 'complete';
  state.ended_at = state.ended_at || iso();
  state.next_recommended_item = null;
  return state;
}

export function markPrepared(state, details = {}) {
  if (!state.current_item) throw new Error('no current item to mark prepared');
  const existing = state.prepared_items.find(entry => entry.id === state.current_item.id);
  const prepared = outcome(state.current_item, state.current_item.lane, 'prepared-for-human-review', { details });
  if (existing) Object.assign(existing, prepared);
  else state.prepared_items.push(prepared);
  state.status = 'awaiting_submission_confirmation';
  state.current_item.preparation = { ...state.current_item.preparation, ...details, status: 'prepared_for_review' };
  return state;
}

export function addAttention(state, minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value < 0) throw new Error('attention minutes must be a non-negative number');
  state.ben_attention_minutes = round1(Number(state.ben_attention_minutes || 0) + value);
  return state;
}

export async function deferCurrent(state, reason, adapters = createDefaultAdapters()) {
  if (!state.current_item) throw new Error('no current item to defer');
  state.deferred_items.push(outcome(state.current_item, 'defer', nonempty(reason) || 'deferred-by-Ben'));
  state.current_item = null;
  state.status = 'active';
  return advanceSession(state, adapters);
}

export async function confirmSubmitted(state, confirmation, adapters = createDefaultAdapters()) {
  if (!state.current_item || state.status !== 'awaiting_submission_confirmation') throw new Error('no prepared application is awaiting submission confirmation');
  if (confirmation?.confirmedByBen !== true) throw new Error('explicit Ben submission confirmation is required');
  const date = nonempty(confirmation.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('submission date must be YYYY-MM-DD');
  const record = await adapters.recordSubmission(state.current_item, { ...confirmation, date });
  if (Array.isArray(adapters.history)) {
    adapters.history.push({
      trackerNumber: Number(record?.status?.num || state.current_item.tracker_number) || null,
      company: state.current_item.company,
      jobTitle: state.current_item.title,
      applicationDate: date,
      status: 'Applied',
      notes: nonempty(confirmation.provenance) || 'Ben-confirmed',
      jobUrl: state.current_item.url,
      jobId: nonempty(state.current_item.requisition_id),
      jdFingerprint: '',
    });
  }
  state.completed_items.push(outcome(state.current_item, state.current_item.lane, 'submission-confirmed', { submission_date: date, provenance: nonempty(confirmation.provenance) || 'Ben-confirmed', record }));
  state.current_item = null;
  state.status = 'active';
  if (confirmation.attentionMinutes != null) addAttention(state, confirmation.attentionMinutes);
  return advanceSession(state, adapters);
}

function inside(base, target) {
  const rel = relative(resolve(base), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function runJson(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: options.cwd, env: options.env || process.env, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `command failed (${result.status})`).trim());
  const text = String(result.stdout || '').trim();
  return text ? JSON.parse(text) : {};
}

export async function recordConfirmedSubmission(item, confirmation, options = {}) {
  if (confirmation?.confirmedByBen !== true) throw new Error('explicit Ben submission confirmation is required before tracker mutation');
  const rootDir = resolve(options.rootDir || ROOT);
  const target = nonempty(item.tracker_number || item.report_number || item.company);
  const provenance = nonempty(confirmation.provenance) || 'Ben-confirmed';
  const note = `Application submitted ${confirmation.date}; ${provenance}.`;
  const args = [join(rootDir, 'set-status.mjs'), target, 'Applied', '--note', note, '--json'];
  if (!item.tracker_number && !item.report_number && item.title) args.push('--role', item.title);

  let answersPlan = null;
  if (confirmation.answersPath || confirmation.answers) {
    const snapshot = confirmation.answers || JSON.parse(readFileSync(resolve(rootDir, confirmation.answersPath), 'utf8'));
    for (const key of ['freeText', 'selections', 'fieldValues', 'files']) {
      if (snapshot[key] != null && !Array.isArray(snapshot[key])) throw new Error(`application answers ${key} must be an array`);
      for (const [index, entry] of (snapshot[key] || []).entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`application answers ${key}[${index}] must be an object`);
      }
    }
    const normalized = normalizeApplicationAnswersSnapshot({ ...snapshot, date: confirmation.date, state: 'submitted' });
    const reportPath = resolve(rootDir, nonempty(item.report_path));
    const reportsDir = join(rootDir, 'reports');
    if (!item.report_path || !inside(reportsDir, reportPath) || !existsSync(reportPath)) throw new Error('a valid report_path under reports/ is required to persist application answers');
    answersPlan = {
      reportPath,
      content: upsertApplicationAnswersSection(readFileSync(reportPath, 'utf8'), normalized),
      result: { report: item.report_path, state: 'submitted' },
    };
  }

  const status = (options.runJson || runJson)(process.execPath, args, { cwd: rootDir });
  if (answersPlan) writeFileAtomic(answersPlan.reportPath, answersPlan.content);

  const appNum = Number(status.num || item.tracker_number);
  const followup = Number.isInteger(appNum) && appNum > 0
    ? await (options.seedFollowup || seedFollowup)(appNum, {
      date: confirmation.date,
      trackerPath: join(rootDir, 'data', 'applications.md'),
      followupsPath: join(rootDir, 'data', 'follow-ups.md'),
      profilePath: join(rootDir, 'config', 'profile.yml'),
    })
    : { seeded: false, reason: 'tracker-number-unavailable' };
  return { status, answers: answersPlan?.result || null, followup };
}

export function receivedHandoffFiles(receiverResult) {
  return (Array.isArray(receiverResult?.results) ? receiverResult.results : [])
    .filter(result => result?.status === 'received' && result.destination_inbox_filename)
    .map(result => result.destination_inbox_filename);
}

function handoffQueueItem(payload, imported) {
  const job = payload.job || {}; const evaluation = payload.evaluation || {};
  const tier = nonempty(evaluation.tier);
  return {
    id: nonempty(payload.handoff_id), handoff_id: nonempty(payload.handoff_id), company: nonempty(job.company),
    title: nonempty(job.title), url: nonempty(job.url), requisition_id: nonempty(job.requisition_id),
    jd_text: nonempty(job.jd_text), approved: true, priority: tier === 'Tier 1', lane: tier === 'Tier 1' ? 'priority' : 'fast',
    fit_score: evaluation.score, report_number: imported.reportNumber, report_path: imported.report,
    tracker_number: Number(imported.reportNumber) || null, factual_integrity: 'passed', friction: 'low',
    source: 'trusted-chatgpt-handoff', liveness: 'active',
  };
}

export async function startHandoffs({
  rootDir = ROOT, minutes = 30, sessionId,
  linkedinReceiver = receiveLinkedInOnce, linkedinProcessor = processLinkedInTasks, linkedinExpandTask, linkedinEvaluateJob,
  receiver = receiveOnce, runner = runHandoffOnce, verifyFn, adapters,
} = {}) {
  const linkedinReceiverResult = await linkedinReceiver({ rootDir });
  const linkedinResult = await linkedinProcessor({
    rootDir, receiverResult: linkedinReceiverResult, expandTask: linkedinExpandTask, evaluateJob: linkedinEvaluateJob,
    history: adapters?.history,
  });
  const receiverResult = await receiver({ rootDir });
  const blockers = (receiverResult?.results || []).filter(result => String(result?.status || '').startsWith('blocked_') || String(result?.status || '').startsWith('conflict_'));
  const queue = [...(linkedinResult?.queue || [])]; const imports = [];
  for (const filename of receivedHandoffFiles(receiverResult)) {
    let result;
    try { result = await runner({ rootDir, filename, verifyFn }); }
    catch (error) { blockers.push({ status: 'blocked_import', destination_inbox_filename: filename, error: error.message }); continue; }
    if (result?.status !== 'completed') { blockers.push({ status: 'blocked_import', destination_inbox_filename: filename, result }); continue; }
    try {
      const payload = yaml.load(readFileSync(join(resolve(rootDir), 'data', 'handoff-inbox', filename), 'utf8'));
      queue.push(handoffQueueItem(payload, result)); imports.push({ filename, status: result.status, handoff_id: payload.handoff_id, report_number: result.reportNumber });
    } catch (error) { blockers.push({ status: 'blocked_queue_mapping', destination_inbox_filename: filename, error: error.message }); }
  }
  const state = createSession(queue, { targetMinutes: minutes, sessionId, allowEmpty: true });
  state.linkedin_expansion = linkedinResult?.summary || { tasks_received: 0, tasks_completed: 0, jobs_seen: 0, jobs_evaluated: 0, jobs_queued: 0, blockers: [] };
  state.handoff_sync = { receiver_status: receiverResult?.status || 'unknown', queue_additions: imports, blockers };
  await advanceSession(state, adapters || createDefaultAdapters({ rootDir }));
  return state;
}

export function sessionSummary(state, now = new Date()) {
  const completedIds = new Set(state.completed_items.map(item => item.id));
  const preparedNotSubmitted = state.prepared_items.filter(item => !completedIds.has(item.id)).length;
  return {
    session_id: state.session_id,
    status: state.status,
    applied: state.completed_items.length,
    prepared_not_submitted: preparedNotSubmitted,
    skipped: state.skipped_items.length,
    deferred: state.deferred_items.length,
    ben_attention_minutes: round1(Number(state.ben_attention_minutes || 0)),
    elapsed_session_minutes: elapsedWallMinutes(state, now),
    target_minutes: state.target_minutes,
    current: state.current_item ? `${state.current_item.company} — ${state.current_item.title}` : null,
    lane: state.current_item?.lane || null,
    next_item: state.next_recommended_item ? `${state.next_recommended_item.company} — ${state.next_recommended_item.title}` : null,
    blocker: state.blocker_reason,
    linkedin_expansion: state.linkedin_expansion || null,
  };
}

export function formatStatus(state, now = new Date()) {
  const s = sessionSummary(state, now);
  const lines = [
    `Session: ${s.elapsed_session_minutes} min elapsed / ~${s.target_minutes} min; Ben attention ${s.ben_attention_minutes} min`,
    `Applied: ${s.applied} | Prepared: ${s.prepared_not_submitted} | Skipped: ${s.skipped} | Deferred: ${s.deferred}`,
    `Current: ${s.current || 'none'}`,
    `Lane: ${s.lane || 'none'}`,
    `Next: ${s.next_item || 'none'}`,
  ];
  if (s.linkedin_expansion) lines.push(`LinkedIn expansion: ${s.linkedin_expansion.tasks_completed}/${s.linkedin_expansion.tasks_received} tasks | ${s.linkedin_expansion.jobs_seen} seen | ${s.linkedin_expansion.jobs_evaluated} evaluated | ${s.linkedin_expansion.jobs_queued} queued | ${s.linkedin_expansion.blockers.length} blockers`);
  return lines.join('\n');
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
}

function usage() {
  return [
    'Usage:',
    '  node application-session.mjs start --queue queue.json [--minutes 30] [--session ID] [--state path]',
    '  node application-session.mjs start-handoffs [--minutes 30] [--session ID] [--state path]',
    '  node application-session.mjs process-linkedin-expansion <artifact.json> [--max-jobs N]',
    '  node application-session.mjs process-linkedin-evaluation <evaluation.json> --source-artifact <artifact.json> [--max-jobs N]',
    '  node application-session.mjs recover-linkedin-evaluation-task --task-id <task_id> --source-artifact <artifact.json> [--max-jobs N]',
    '  node application-session.mjs prepare-linkedin-search-issue --url "<raw LinkedIn URL>" --alert-subject "<subject>" --alert-date YYYY-MM-DD [--gmail-message-id ID] [--keywords text] [--location text] [--title text]',
    '  node application-session.mjs linkedin-expansion-next',
    '  node application-session.mjs resume --state path',
    '  node application-session.mjs prepared --state path',
    '  node application-session.mjs confirm-submitted --state path --confirmed-by-ben --date YYYY-MM-DD [--provenance text] [--attention-minutes N] [--answers answers.json]',
    '  node application-session.mjs defer --state path --reason text [--attention-minutes N]',
    '  node application-session.mjs attention --state path --minutes N',
    '  node application-session.mjs summary --state path',
  ].join('\n');
}

function optionalArg(argv, flag) {
  const value = argValue(argv, flag);
  return value == null || !nonempty(value) ? undefined : value;
}

function writePreparedIssueFile(path, content) {
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== content) throw new Error(`prepared Issue output already exists with different content: ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, content);
}

export function prepareLinkedInSearchIssueCli(argv, { rootDir = ROOT } = {}) {
  const url = argValue(argv, '--url');
  const alertSubject = argValue(argv, '--alert-subject');
  const alertDate = argValue(argv, '--alert-date');
  if (!url || !alertSubject || !alertDate) throw new Error('prepare-linkedin-search-issue requires --url, --alert-subject, and --alert-date');
  const keywords = optionalArg(argv, '--keywords');
  const location = optionalArg(argv, '--location');
  const title = optionalArg(argv, '--title') || `LinkedIn search expansion: ${nonempty(alertSubject)}`;
  const source = { alert_subject: alertSubject, alert_date: alertDate };
  const gmailMessageId = optionalArg(argv, '--gmail-message-id');
  if (gmailMessageId) source.gmail_message_id = gmailMessageId;
  const linkedinSearch = { url };
  for (const [flag, key] of [['--keywords', 'keywords'], ['--location', 'location'], ['--geo-id', 'geo_id'], ['--distance', 'distance'], ['--posted-window', 'posted_window']]) {
    const value = optionalArg(argv, flag);
    if (value) linkedinSearch[key] = value;
  }
  const prepared = prepareLinkedInSearchIssue({ source, linkedin_search: linkedinSearch });
  const runtimeDir = join(resolve(rootDir), 'data', 'linkedin-search-runtime', 'prepared-issues');
  const bodyPath = join(runtimeDir, `${prepared.task.task_id}.body.yml`);
  const metadataPath = join(runtimeDir, `${prepared.task.task_id}.json`);
  const metadata = { label: prepared.label, title, task_id: prepared.task.task_id, body_path: bodyPath, body: prepared.body };
  writePreparedIssueFile(bodyPath, prepared.body);
  writePreparedIssueFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  let state;
  let statePath = argValue(argv, '--state');
  if (command === 'start') {
    const queuePath = argValue(argv, '--queue');
    if (!queuePath) throw new Error(usage());
    const input = JSON.parse(readFileSync(resolve(queuePath), 'utf8'));
    state = createSession(Array.isArray(input) ? input : input.items, { targetMinutes: argValue(argv, '--minutes') || 30, sessionId: argValue(argv, '--session') || input.session_id });
    statePath = statePath || defaultStatePath(state.session_id);
    await advanceSession(state);
  } else if (command === 'start-handoffs') {
    state = await startHandoffs({ minutes: argValue(argv, '--minutes') || 30, sessionId: argValue(argv, '--session') || undefined });
    statePath = statePath || defaultStatePath(state.session_id);
  } else if (command === 'process-linkedin-expansion') {
    const artifactPath = argv[1];
    if (!artifactPath) throw new Error(usage());
    const maxJobs = Number(argValue(argv, '--max-jobs') || DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT);
    const artifact = readLinkedInExpansionArtifact(artifactPath, { maxJobs });
    const result = stageLinkedInExpansionArtifact(artifact, { maxJobs });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  } else if (command === 'process-linkedin-evaluation') {
    const evaluationArtifactPath = argv[1];
    const sourceArtifactPath = argValue(argv, '--source-artifact');
    if (!evaluationArtifactPath || !sourceArtifactPath) throw new Error(usage());
    const maxJobs = Number(argValue(argv, '--max-jobs') || DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT);
    const result = await processLinkedInEvaluationArtifact({ evaluationArtifactPath, sourceArtifactPath, rootDir: ROOT, maxJobs });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  } else if (command === 'recover-linkedin-evaluation-task') {
    const taskId = argValue(argv, '--task-id');
    const sourceArtifactPath = argValue(argv, '--source-artifact');
    if (!taskId || !sourceArtifactPath) throw new Error(usage());
    const maxJobs = Number(argValue(argv, '--max-jobs') || DEFAULT_LINKEDIN_EXPANSION_RESULT_LIMIT);
    const result = recoverLinkedInEvaluationTask({ taskId, sourceArtifactPath, rootDir: ROOT, maxJobs });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  } else if (command === 'prepare-linkedin-search-issue') {
    const prepared = prepareLinkedInSearchIssueCli(argv.slice(1));
    process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
    return;
  } else if (command === 'linkedin-expansion-next') {
    const received = receiveLinkedInOnce({ rootDir: ROOT });
    const next = selectNextLinkedInTask({ rootDir: ROOT, receiverResult: received });
    process.stdout.write(`${JSON.stringify({ status: received.status === 'github_error' ? 'github_error' : next ? 'pending' : 'idle', receiver: received, next }, null, 2)}\n`);
    return;
  } else {
    if (!statePath) throw new Error(usage());
    state = loadSession(statePath);
    if (command === 'resume') await advanceSession(state);
    else if (command === 'prepared') markPrepared(state);
    else if (command === 'confirm-submitted') {
      await confirmSubmitted(state, {
        confirmedByBen: argv.includes('--confirmed-by-ben'),
        date: argValue(argv, '--date'),
        provenance: argValue(argv, '--provenance') || 'Ben-confirmed',
        attentionMinutes: argValue(argv, '--attention-minutes'),
        answersPath: argValue(argv, '--answers'),
      });
    } else if (command === 'defer') {
      if (argValue(argv, '--attention-minutes') != null) addAttention(state, argValue(argv, '--attention-minutes'));
      await deferCurrent(state, argValue(argv, '--reason'));
    } else if (command === 'attention') addAttention(state, argValue(argv, '--minutes'));
    else if (command !== 'summary') throw new Error(usage());
  }
  saveSession(state, statePath);
  process.stdout.write(`${formatStatus(state)}\nState: ${resolve(statePath)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`application-session: ${error.message}\n`);
    process.exitCode = 1;
  });
}
