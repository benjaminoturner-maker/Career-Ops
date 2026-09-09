import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import {
  addAttention,
  advanceSession,
  classifyLane,
  confirmSubmitted,
  createSession,
  loadSession,
  markPrepared,
  recordConfirmedSubmission,
  receivedHandoffFiles,
  saveSession,
  sessionSummary,
  startHandoffs,
} from '../application-session.mjs';

const active = async () => ({ result: 'active', reason: 'fixture active' });
const prepared = async () => ({ status: 'prepared_for_review', source: 'fixture preparation' });
const base = (id, overrides = {}) => ({
  id,
  company: `${id} Company`,
  title: `${id} Role`,
  url: `https://jobs.example.com/${id}`,
  approved: true,
  liveness: 'active',
  factual_integrity: 'passed',
  friction: 'low',
  ...overrides,
});
const adapters = (overrides = {}) => ({ history: [], blacklist: new Map(), checkLiveness: active, prepareItem: prepared, recordSubmission: async () => ({ changed: true }), ...overrides });

test('already-applied duplicate is skipped', async () => {
  const item = base('duplicate', { company: 'Acme', title: 'Director Strategy' });
  const state = createSession([item], { sessionId: 'duplicate-session' });
  await advanceSession(state, adapters({ history: [{ trackerNumber: 1, company: 'Acme', jobTitle: 'Director Strategy', applicationDate: '2026-09-01', status: 'Applied', notes: '', jobUrl: item.url, jobId: '', jdFingerprint: '' }] }));
  assert.equal(state.status, 'complete');
  assert.equal(state.skipped_items[0].reason, 'already-applied');
});

test('dead posting is skipped', async () => {
  const state = createSession([base('dead')], { sessionId: 'dead-session' });
  await advanceSession(state, adapters({ checkLiveness: async () => ({ result: 'expired', reason: '404' }) }));
  assert.match(state.skipped_items[0].reason, /dead-posting/);
});

test('approved sub-4.0 job proceeds without score gating', async () => {
  const state = createSession([base('low-score', { fit_score: 3.1 })], { sessionId: 'low-score-session' });
  await advanceSession(state, adapters());
  assert.equal(state.status, 'awaiting_submission_confirmation');
  assert.equal(state.current_item.id, 'low-score');
});

test('hard eligibility blocker stops only that item and later work continues', async () => {
  const state = createSession([base('blocked', { hard_blocker: 'required license missing' }), base('later')], { sessionId: 'hard-gate-session' });
  await advanceSession(state, adapters());
  assert.match(state.deferred_items[0].reason, /hard-eligibility-blocker/);
  assert.equal(state.current_item.id, 'later');
});

test('known company hard-gate outcome defers a changed role and continues', async () => {
  const disa = base('disa-corpdev', { company: 'DISA Uranium', title: 'Director of Corporate Development' });
  const blackHills = base('black-hills', { company: 'Black Hills Energy', title: 'Director of Data Center Development' });
  const state = createSession([disa, blackHills], { sessionId: 'prior-company-hard-gate-session' });
  const history = [{
    trackerNumber: 4,
    company: 'DISA Technologies, Inc.',
    jobTitle: 'Vice President of Business Development',
    applicationDate: '2026-07-28',
    status: 'Rejected',
    notes: '[prior-company-hard-gate: DISA Uranium | mining/geology depth for exploration evaluation]',
    jobUrl: '',
    jobId: '',
    jdFingerprint: '',
  }];
  await advanceSession(state, adapters({ history }));
  assert.equal(state.deferred_items[0].id, 'disa-corpdev');
  assert.match(state.deferred_items[0].reason, /prior-company-hard-gate: mining\/geology depth/);
  assert.equal(state.current_item.id, 'black-hills');
});

test('high-friction item is deferred and later item continues', async () => {
  const state = createSession([base('workday', { friction: 'high', friction_reason: 'long Workday flow' }), base('fast')], { sessionId: 'friction-session' });
  await advanceSession(state, adapters());
  assert.equal(state.deferred_items[0].id, 'workday');
  assert.equal(state.current_item.id, 'fast');
});

test('confirmation advances beyond the first successful application', async () => {
  let records = 0;
  const state = createSession([base('first'), base('second')], { sessionId: 'continue-session' });
  const deps = adapters({ recordSubmission: async () => { records++; return { changed: true }; } });
  await advanceSession(state, deps);
  await confirmSubmitted(state, { confirmedByBen: true, date: '2026-09-08', attentionMinutes: 3 }, deps);
  assert.equal(records, 1);
  assert.equal(state.completed_items[0].id, 'first');
  assert.equal(state.current_item.id, 'second');
});

test('near-session-end selection prefers a later fast item', async () => {
  const state = createSession([base('priority', { priority: true }), base('fast')], { sessionId: 'near-end-session' });
  addAttention(state, 27);
  await advanceSession(state, adapters());
  assert.equal(state.current_item.id, 'fast');
  assert.equal(state.remaining_queue[0].id, 'priority');
});

test('near-session-end does not start a non-fast item', async () => {
  const state = createSession([base('priority-only', { priority: true })], { sessionId: 'near-end-stop-session' });
  addAttention(state, 27);
  await advanceSession(state, adapters());
  assert.equal(state.status, 'budget_near_end');
  assert.equal(state.current_item, null);
  assert.equal(state.remaining_queue[0].id, 'priority-only');
});

test('adapter failure is retained as a resumable blocker', async () => {
  const state = createSession([base('adapter-error')], { sessionId: 'adapter-error-session' });
  await advanceSession(state, adapters({ checkLiveness: async () => { throw new Error('service unavailable'); } }));
  assert.equal(state.status, 'blocked');
  assert.equal(state.current_item.id, 'adapter-error');
  assert.match(state.blocker_reason, /service unavailable/);
});

test('durable state resumes after interruption', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-application-session-'));
  try {
    const path = join(root, 'state.json');
    const state = createSession([base('resume')], { sessionId: 'resume-session', now: '2026-09-08T12:00:00.000Z' });
    state.skipped_items.push({ id: 'prior' });
    saveSession(state, path);
    const loaded = loadSession(path);
    assert.equal(loaded.session_id, 'resume-session');
    assert.equal(loaded.remaining_queue[0].id, 'resume');
    assert.equal(loaded.skipped_items[0].id, 'prior');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('post-submit confirmation uses the injected canonical transition adapter', async () => {
  const calls = [];
  const deps = adapters({ recordSubmission: async (item, confirmation) => { calls.push({ item, confirmation }); return { status: { num: 18, newStatus: 'Applied' }, followup: { seeded: true } }; } });
  const state = createSession([base('post-submit', { tracker_number: 18 })], { sessionId: 'post-submit-session' });
  await advanceSession(state, deps);
  await confirmSubmitted(state, { confirmedByBen: true, date: '2026-09-08', provenance: 'Ben-confirmed' }, deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].item.tracker_number, 18);
  assert.equal(state.completed_items[0].record.status.newStatus, 'Applied');
  assert.equal(state.completed_items[0].record.followup.seeded, true);
});

test('no-submit invariant: preparing alone never records Applied and confirmation is mandatory', async () => {
  let records = 0;
  const deps = adapters({ recordSubmission: async () => { records++; return {}; } });
  const state = createSession([base('human-submit')], { sessionId: 'human-submit-session' });
  await advanceSession(state, deps);
  markPrepared(state);
  assert.equal(records, 0);
  assert.equal(state.completed_items.length, 0);
  await assert.rejects(() => confirmSubmitted(state, { confirmedByBen: false, date: '2026-09-08' }, deps), /explicit Ben submission confirmation/);
  assert.equal(records, 0);
});

test('malformed answer snapshots fail before the canonical tracker transition', async () => {
  let transitionCalls = 0;
  await assert.rejects(
    () => recordConfirmedSubmission(
      base('bad-answers'),
      { confirmedByBen: true, date: '2026-09-08', answers: { freeText: ['not structured'] } },
      { runJson: () => { transitionCalls++; return {}; } },
    ),
    /freeText\[0\] must be an object/,
  );
  assert.equal(transitionCalls, 0);
});

test('receiver blocked aggregate still exposes later successfully received work', () => {
  const files = receivedHandoffFiles({ status: 'blocked', results: [{ status: 'blocked_invalid_issue', issue_number: 1 }, { status: 'received', issue_number: 2, destination_inbox_filename: 'valid-002.yml' }] });
  assert.deepEqual(files, ['valid-002.yml']);
});

test('minimum multi-item scenario skips, defers, continues, and never submits', async () => {
  const duplicate = base('A', { company: 'Applied Co', title: 'Applied Role' });
  const queue = [duplicate, base('B'), base('C', { fit_score: 3.5 }), base('D', { friction: 'assessment', friction_reason: 'assessment required' }), base('E')];
  const state = createSession(queue, { sessionId: 'minimum-scenario', now: '2026-09-08T12:00:00.000Z' });
  let records = 0;
  const deps = adapters({
    history: [{ trackerNumber: 1, company: 'Applied Co', jobTitle: 'Applied Role', applicationDate: '2026-09-01', status: 'Applied', notes: '', jobUrl: duplicate.url, jobId: '', jdFingerprint: '' }],
    checkLiveness: async item => item.id === 'B' ? { result: 'expired', reason: 'fixture expired' } : { result: 'active', reason: 'fixture active' },
    recordSubmission: async () => { records++; return { status: { newStatus: 'Applied' }, followup: { seeded: true } }; },
  });
  await advanceSession(state, deps);
  assert.equal(state.current_item.id, 'C');
  await confirmSubmitted(state, { confirmedByBen: true, date: '2026-09-08', attentionMinutes: 3 }, deps);
  assert.equal(state.current_item.id, 'E');
  assert.equal(state.skipped_items.length, 2);
  assert.equal(state.deferred_items.length, 1);
  assert.equal(state.deferred_items[0].id, 'D');
  assert.equal(records, 1);
  const summary = sessionSummary(state, new Date('2026-09-08T12:12:00.000Z'));
  assert.equal(summary.applied, 1);
  assert.equal(summary.prepared_not_submitted, 1);
  assert.equal(summary.skipped, 2);
  assert.equal(summary.deferred, 1);
  assert.equal(summary.current, 'E Company — E Role');
});

test('lane classifier honors explicit priority and friction-driven defer', () => {
  assert.equal(classifyLane(base('p', { priority: true })), 'priority');
  assert.equal(classifyLane(base('d', { friction: 'captcha' })), 'defer');
});

test('controller source has no browser or final-submit action', () => {
  const source = readFileSync(new URL('../application-session.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]playwright/);
  assert.doesNotMatch(source, /\.click\s*\(/);
  assert.doesNotMatch(source, /\bsubmitApplication\s*\(/);
});

test('blocked receiver imports later valid handoffs into priority and fast lanes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-handoff-start-'));
  try {
    const inbox = join(root, 'data', 'handoff-inbox');
    mkdirSync(inbox, { recursive: true });
    const payload = (id, tier, title) => ({ handoff_id: id, job: { company: `${id} Co`, title, url: `https://jobs.example.com/${id}`, requisition_id: id, jd_text: `${title} ${id} description` }, evaluation: { tier } });
    writeFileSync(join(inbox, 'good-1.yml'), yaml.dump(payload('good-1', 'Tier 1', 'Priority Role')));
    writeFileSync(join(inbox, 'good-2.yml'), yaml.dump(payload('good-2', 'Tier 2', 'Fast Role')));
    const state = await startHandoffs({ rootDir: root, sessionId: 'handoff-start-test', linkedinReceiver: async () => ({ status: 'idle', results: [] }), linkedinProcessor: async () => ({ queue: [], summary: { tasks_received: 0, tasks_completed: 0, jobs_seen: 0, jobs_evaluated: 0, jobs_queued: 0, blockers: [] } }), receiver: async () => ({ status: 'blocked', results: [{ status: 'blocked_invalid_issue', issue_number: 1 }, { status: 'received', destination_inbox_filename: 'good-1.yml' }, { status: 'received', destination_inbox_filename: 'good-2.yml' }] }), runner: async ({ filename }) => ({ status: 'completed', reportNumber: filename === 'good-1.yml' ? '21' : '22', report: join(root, 'reports', `${filename}.md`) }), adapters: adapters() });
    assert.equal(state.handoff_sync.queue_additions.length, 2);
    assert.equal(state.handoff_sync.blockers[0].status, 'blocked_invalid_issue');
    assert.equal(state.current_item.lane, 'priority');
    assert.equal(state.current_item.source, 'trusted-chatgpt-handoff');
    assert.equal(state.remaining_queue[0].lane, 'fast');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('zero received handoffs returns a clean completed session with blocker provenance', async () => {
  const state = await startHandoffs({ sessionId: 'empty-handoff-test', linkedinReceiver: async () => ({ status: 'idle', results: [] }), linkedinProcessor: async () => ({ queue: [], summary: { tasks_received: 0, tasks_completed: 0, jobs_seen: 0, jobs_evaluated: 0, jobs_queued: 0, blockers: [] } }), receiver: async () => ({ status: 'idle', results: [] }), runner: async () => { throw new Error('must not run'); }, adapters: adapters() });
  assert.equal(state.status, 'complete');
  assert.deepEqual(state.handoff_sync.queue_additions, []);
  assert.deepEqual(state.handoff_sync.blockers, []);
});

test('session start processes LinkedIn expansion before trusted handoffs and preserves both summaries', async () => {
  const order = [];
  const state = await startHandoffs({ sessionId: 'ordered-operational-start',
    linkedinReceiver: async () => { order.push('linkedin-receive'); return { status: 'received', results: [] }; },
    linkedinProcessor: async () => { order.push('linkedin-expand'); return { queue: [base('linkedin-credible', { source: 'linkedin-authenticated-expansion' })], summary: { tasks_received: 1, tasks_completed: 1, jobs_seen: 2, jobs_evaluated: 1, jobs_queued: 1, blockers: [] } }; },
    receiver: async () => { order.push('handoff-receive'); return { status: 'idle', results: [] }; },
    runner: async () => { throw new Error('must not run'); }, adapters: adapters(),
  });
  assert.deepEqual(order, ['linkedin-receive', 'linkedin-expand', 'handoff-receive']);
  assert.equal(state.linkedin_expansion.jobs_queued, 1);
  assert.deepEqual(state.handoff_sync.queue_additions, []);
  assert.equal(state.current_item.id, 'linkedin-credible');
});

test('manual start --queue remains available and does not submit', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-manual-session-'));
  try {
    const queuePath = join(root, 'queue.json'); const statePath = join(root, 'state.json');
    writeFileSync(queuePath, JSON.stringify([base('manual', { approved: false, liveness: 'active' })]));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../application-session.mjs', import.meta.url)), 'start', '--queue', queuePath, '--state', statePath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.completed_items.length, 0);
    assert.equal(state.deferred_items[0].reason, 'requires-evaluation: no trusted approval/handoff');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
