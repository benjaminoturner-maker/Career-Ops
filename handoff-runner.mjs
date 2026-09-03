#!/usr/bin/env node

/** Deterministic, idempotent processor for one local ChatGPT handoff. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import yaml from 'js-yaml';
import { dryRunHandoff, importHandoff } from './handoff.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HANDOFF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

function paths(root) {
  const runtime = join(root, 'data', 'handoff-runtime');
  return { inbox: join(root, 'data', 'handoff-inbox'), runtime, lock: join(runtime, 'runner.lock'), state: join(runtime, 'state') };
}
function atomicJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`); }
function acquire(lock) {
  try { mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}
function release(lock) { rmSync(lock, { recursive: true, force: true }); }
function stableId(payload) {
  const id = String(payload?.handoff_id ?? '').trim();
  if (!HANDOFF_RE.test(id)) throw new Error('handoff_id is required and must be 3-128 stable filename-safe characters');
  return id;
}
function fingerprint(payload) { return createHash('sha256').update(String(payload?.job?.jd_text ?? '')).digest('hex'); }
function runVerify(root, verifyFn) {
  if (verifyFn) return verifyFn(root);
  const result = spawnSync(process.execPath, [join(root, 'verify-pipeline.mjs')], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`verify-pipeline failed (exit ${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  return { stdout: result.stdout };
}

export async function runOnce({ rootDir = ROOT, verifyFn } = {}) {
  const root = resolve(rootDir); const p = paths(root);
  mkdirSync(p.inbox, { recursive: true }); mkdirSync(p.state, { recursive: true });
  if (!acquire(p.lock)) return { status: 'busy' };
  try {
    const files = readdirSync(p.inbox).filter(name => /\.yml$/i.test(name)).sort();
    if (!files.length) return { status: 'idle' };
    let file; let path; let payload; let skippedCompleted = false;
    for (const candidate of files) {
      const candidatePath = join(p.inbox, candidate);
      try {
        const candidatePayload = yaml.load(readFileSync(candidatePath, 'utf8'));
        const candidateId = String(candidatePayload?.handoff_id ?? '').trim();
        const candidateIdentity = HANDOFF_RE.test(candidateId) ? `${candidateId}:${fingerprint(candidatePayload)}` : '';
        const candidateStatePath = candidateId ? join(p.state, `${candidateId}.json`) : '';
        if (candidateIdentity && existsSync(candidateStatePath)) {
          const candidateState = JSON.parse(readFileSync(candidateStatePath, 'utf8'));
          if (candidateState.identity === candidateIdentity && candidateState.status === 'completed') { skippedCompleted = true; continue; }
        }
        file = candidate; path = candidatePath; payload = candidatePayload; break;
      } catch {
        file = candidate; path = candidatePath; payload = null; break;
      }
    }
    if (!file) return skippedCompleted ? { status: 'completed', no_op: true } : { status: 'idle' };
    try { payload = yaml.load(readFileSync(path, 'utf8')); } catch (e) { return record(p, file, { status: 'failed_validation', error: `YAML parse failed: ${e.message}` }); }
    let id; try { id = stableId(payload); } catch (e) { return record(p, file, { status: 'failed_validation', error: e.message }); }
    const jdFingerprint = fingerprint(payload); const identity = `${id}:${jdFingerprint}`; const statePath = join(p.state, `${id}.json`);
    const prior = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
    if (prior?.identity === identity && prior.status === 'completed') return { status: 'completed', handoff_id: id, no_op: true };
    if (prior?.identity && prior.identity !== identity) return record(p, file, { status: 'blocked_identity_conflict', handoff_id: id, identity, prior_identity: prior.identity, error: 'handoff_id was reused with a different JD fingerprint' });
    if (prior?.status === 'imported_pending_verify') {
      try { const verification = runVerify(root, verifyFn); return record(p, file, { ...prior, status: 'completed', verified_at: new Date().toISOString(), verification }); }
      catch (e) { return record(p, file, { ...prior, status: 'verify_failed', error: e.message }); }
    }
    try { dryRunHandoff(payload, { rootDir: root }); }
    catch (e) { return record(p, file, { status: 'failed_dry_run', handoff_id: id, identity, error: e.message }); }
    let imported;
    try { imported = await importHandoff(payload, { rootDir: root }); }
    catch (e) { return record(p, file, { status: 'failed_import', handoff_id: id, identity, error: e.message }); }
    const pending = { status: 'imported_pending_verify', handoff_id: id, identity, source_file: file, report: imported.report, report_number: imported.reportNumber, imported_at: new Date().toISOString() };
    atomicJson(statePath, pending);
    try { const verification = runVerify(root, verifyFn); return record(p, file, { ...pending, status: 'completed', verified_at: new Date().toISOString(), verification }); }
    catch (e) { return record(p, file, { ...pending, status: 'verify_failed', error: e.message }); }
  } finally { release(p.lock); }
}
function record(p, file, state) { if (state.handoff_id) atomicJson(join(p.state, `${state.handoff_id}.json`), { ...state, source_file: file, updated_at: new Date().toISOString() }); return state; }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv[2] !== '--once') { console.error('Usage: node handoff-runner.mjs --once'); process.exitCode = 1; }
  else { try { console.log(JSON.stringify(await runOnce(), null, 2)); } catch (e) { console.error(`handoff-runner: ${e.message}`); process.exitCode = 1; } }
}
