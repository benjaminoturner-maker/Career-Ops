#!/usr/bin/env node

/** Receive labeled GitHub Issue handoffs into the local Phase 1 inbox. */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { writeFileAtomic } from './tracker-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY = 'benjaminoturner-maker/Career-Ops';
export const HANDOFF_LABEL = 'career-ops-handoff';
const HANDOFF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`invalid GitHub repository: ${value}`);
  return value;
}

function statePaths(root, repository, issueNumber) {
  const key = `${repository.replace('/', '--')}--${issueNumber}`;
  const runtime = join(root, 'data', 'handoff-runtime', 'github-receipts');
  return { runtime, receipt: join(runtime, `${key}.json`), key };
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function labelsOf(issue) {
  return Array.isArray(issue?.labels) ? issue.labels.map(label => typeof label === 'string' ? label : label?.name).filter(Boolean) : [];
}

export function parseIssuePayload(body) {
  const blocks = [];
  const pattern = /^```(?:yaml|yml)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gmi;
  for (const match of String(body ?? '').matchAll(pattern)) blocks.push(match[1]);
  if (blocks.length === 0) throw new Error('Issue body must contain exactly one fenced YAML handoff block');
  if (blocks.length > 1) throw new Error('Issue body contains more than one candidate YAML handoff block');
  let payload;
  try { payload = yaml.load(blocks[0]); }
  catch (error) { throw new Error(`malformed YAML: ${error.message}`); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('YAML handoff must be an object');
  const handoffId = String(payload.handoff_id ?? '').trim();
  if (!HANDOFF_RE.test(handoffId)) throw new Error('handoff_id is required and must be 3-128 stable filename-safe characters');
  return { payload, handoffId, yamlText: `${blocks[0].replace(/\s+$/, '')}\n` };
}

export function runGitHubCli(args, options = {}) {
  const executable = options.executable || process.env.GH_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh');
  const result = spawnSync(executable, args, { cwd: options.cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(`GitHub CLI failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`GitHub CLI failed (exit ${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  return result.stdout;
}

export function listHandoffIssues({ repository, gh = runGitHubCli, rootDir = ROOT }) {
  const output = gh(['issue', 'list', '--repo', repository, '--label', HANDOFF_LABEL, '--state', 'open', '--limit', '100', '--json', 'number,url,title,body,labels'], { cwd: rootDir });
  let issues;
  try { issues = JSON.parse(output); }
  catch (error) { throw new Error(`GitHub CLI returned invalid JSON: ${error.message}`); }
  if (!Array.isArray(issues)) throw new Error('GitHub CLI issue response must be an array');
  return issues.sort((a, b) => Number(a.number) - Number(b.number));
}

export function receiveIssue(issue, { rootDir = ROOT, repository = DEFAULT_REPOSITORY, now = () => new Date().toISOString() } = {}) {
  const root = resolve(rootDir);
  const issueNumber = Number(issue?.number);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('GitHub Issue number must be a positive integer');
  if (!labelsOf(issue).includes(HANDOFF_LABEL)) return { status: 'ignored', issue_number: issueNumber, reason: `missing ${HANDOFF_LABEL} label` };

  const body = String(issue.body ?? '');
  const bodyHash = sha256(body);
  const p = statePaths(root, repository, issueNumber);
  const prior = existsSync(p.receipt) ? JSON.parse(readFileSync(p.receipt, 'utf8')) : null;
  if (prior?.status === 'received' && prior.body_hash === bodyHash) return { ...prior, status: 'received', no_op: true };
  if (prior?.status === 'received' && prior.body_hash !== bodyHash) {
    const conflict = { status: 'conflict_changed_issue', repository, issue_number: issueNumber, issue_url: issue.url || null, received_body_hash: prior.body_hash, observed_body_hash: bodyHash, observed_at: now(), error: 'Previously received GitHub Issue body changed; inbox file was not overwritten' };
    atomicJson(join(p.runtime, 'conflicts', `${p.key}--${bodyHash.slice(0, 16)}.json`), conflict);
    return conflict;
  }

  let parsed;
  try { parsed = parseIssuePayload(body); }
  catch (error) {
    const blocked = { status: 'blocked_invalid_issue', repository, issue_number: issueNumber, issue_url: issue.url || null, body_hash: bodyHash, observed_at: now(), error: error.message };
    atomicJson(p.receipt, blocked);
    return blocked;
  }

  const inbox = join(root, 'data', 'handoff-inbox');
  const destinationFilename = `${parsed.handoffId}.yml`;
  const destination = join(inbox, destinationFilename);
  mkdirSync(inbox, { recursive: true });
  if (existsSync(destination)) {
    const existing = readFileSync(destination, 'utf8');
    if (existing !== parsed.yamlText) {
      const conflict = { status: 'conflict_destination', repository, issue_number: issueNumber, issue_url: issue.url || null, body_hash: bodyHash, handoff_id: parsed.handoffId, destination_inbox_filename: destinationFilename, observed_at: now(), error: 'Destination inbox file exists with different content; it was not overwritten' };
      atomicJson(p.receipt, conflict);
      return conflict;
    }
  } else {
    writeFileSync(destination, parsed.yamlText, { encoding: 'utf8', flag: 'wx' });
  }
  const receipt = { status: 'received', repository, issue_number: issueNumber, issue_url: issue.url || null, received_at: now(), body_hash: bodyHash, payload_hash: sha256(parsed.yamlText), handoff_id: parsed.handoffId, destination_inbox_filename: destinationFilename };
  atomicJson(p.receipt, receipt);
  return receipt;
}

export function receiveOnce({ rootDir = ROOT, repository = DEFAULT_REPOSITORY, gh = runGitHubCli, now } = {}) {
  const repo = safeRepository(repository);
  let issues;
  try { issues = listHandoffIssues({ repository: repo, gh, rootDir }); }
  catch (error) { return { status: 'github_error', repository: repo, error: error.message }; }
  const results = [];
  for (const issue of issues) {
    let result;
    try {
      result = receiveIssue(issue, { rootDir, repository: repo, now });
    } catch (error) {
      const issueNumber = Number(issue?.number);
      result = {
        status: 'blocked_receiver_error',
        repository: repo,
        issue_number: Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : null,
        issue_url: issue?.url || null,
        error: error.message,
      };
    }
    results.push(result);
  }
  const hasBlocker = results.some(result => result.status.startsWith('blocked_') || result.status.startsWith('conflict_'));
  if (hasBlocker) return { status: 'blocked', repository: repo, results };
  return { status: results.some(result => result.status === 'received' && !result.no_op) ? 'received' : 'idle', repository: repo, results };
}

function parseArgs(argv) {
  const args = { repository: DEFAULT_REPOSITORY };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--once') args.once = true;
    else if (argv[i] === '--repo' && argv[i + 1]) args.repository = argv[++i];
    else throw new Error(`unknown or incomplete argument: ${argv[i]}`);
  }
  if (!args.once) throw new Error('Usage: node github-handoff-receiver.mjs --once [--repo owner/name]');
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = receiveOnce({ repository: args.repository });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'blocked' || result.status === 'github_error') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`github-handoff-receiver: ${error.message}\n`);
    process.exitCode = 1;
  }
}
