#!/usr/bin/env node

/**
 * handoff.mjs — import a trusted ChatGPT evaluation without rerunning A-G.
 *
 * The handoff is validated against the authoritative local candidate facts and
 * application history before a concise report and Evaluated/Preparing tracker
 * row are written. It never generates application materials or submits forms.
 */

import {
  existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { applyInterviewCredibilityGate } from './judgment-policy.mjs';
import { loadApplicationHistory, matchPriorApplication, priorApplicationMessage } from './scan.mjs';
import { formatReportNumber, releaseReportNumbers, reserveReportNumbers } from './reserve-report-num.mjs';
import { resolveColumns } from './tracker-parse.mjs';
import { cell, openTrackerTransaction, resolveTrackerPath } from './tracker-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VALID_STRENGTHS = new Set(['hard gate', 'strong preference', 'soft preference', 'neutral context']);
const VALID_STATUSES = new Set(['met', 'unmet', 'unknown']);
const VALID_TIERS = new Set(['Tier 1', 'Tier 2', 'Tier 3', 'Pass', 'Reject']);
const VALID_ACTIONS = new Set(['Apply', 'Consider', 'Research first', 'Skip']);
const VALID_TRACKER_STATUSES = new Set(['Evaluated', 'Preparing']);
const FACT_SOURCES = new Set([
  'cv.md', 'article-digest.md', 'config/profile.yml', 'config/cv-facts.json',
  'modes/_profile.md', 'interview-prep.md', 'voice-dna.md',
]);

export class HandoffValidationError extends Error {
  constructor(issues) {
    super(`Handoff validation failed:\n- ${issues.join('\n- ')}`);
    this.name = 'HandoffValidationError';
    this.issues = issues;
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalized(value) {
  return text(value).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokens(value) {
  const stop = new Set(['and', 'the', 'for', 'with', 'from', 'that', 'this', 'will', 'must', 'required', 'minimum', 'preferred']);
  return normalized(value).split(/\s+/).filter(token => token.length > 2 && !stop.has(token));
}

function titleMatchesJd(title, jd) {
  const wanted = tokens(title).filter(token => !['senior', 'sr', 'junior', 'jr'].includes(token));
  if (wanted.length === 0) return false;
  const available = new Set(tokens(jd));
  return wanted.filter(token => available.has(token)).length / wanted.length >= 0.7;
}

function companyMatchesJd(company, jd) {
  const legal = new Set(['company', 'corporation', 'corp', 'inc', 'incorporated', 'llc', 'limited', 'ltd', 'plc']);
  const wanted = tokens(company).filter(token => !legal.has(token));
  if (wanted.length === 0) return false;
  const available = new Set(tokens(jd));
  return wanted.some(token => available.has(token));
}

function requisitionFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of ['jobId', 'jobid', 'gh_jid', 'requisitionId', 'requisitionid', 'reqId', 'reqid']) {
      const value = url.searchParams.get(key);
      if (value) return value.trim().toUpperCase();
    }
    const match = url.pathname.match(/\/(?:job|jobs|requisition|requisitions)\/([a-z0-9_-]*\d[a-z0-9_-]*)\b/i);
    return match ? match[1].toUpperCase() : '';
  } catch {
    return '';
  }
}

function requiredJdSignals(jd) {
  return text(jd)
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map(line => line.replace(/^[-*•]\s*/, '').trim())
    .filter(line => /\b(?:must|required|minimum qualification|at least)\b/i.test(line))
    .filter(line => tokens(line).length >= 2);
}

function requirementCoversSignal(requirement, signal) {
  const declared = new Set(tokens(`${requirement.requirement} ${requirement.evidence || ''}`));
  const signalTokens = [...new Set(tokens(signal))];
  const overlap = signalTokens.filter(token => declared.has(token)).length;
  return overlap >= Math.min(2, signalTokens.length);
}

function safeFactPath(rootDir, source) {
  if (!FACT_SOURCES.has(source)) return null;
  const absolute = resolve(rootDir, source);
  const rel = relative(rootDir, absolute);
  return rel && !rel.startsWith('..') ? absolute : null;
}

function validateCandidateClaims(payload, rootDir, issues) {
  if (!Array.isArray(payload.candidate_claims) || payload.candidate_claims.length === 0) {
    issues.push('candidate_claims must contain at least one source-backed factual premise');
    return;
  }
  for (const [index, claim] of payload.candidate_claims.entries()) {
    const label = `candidate_claims[${index}]`;
    const source = text(claim?.source).replace(/\\/g, '/');
    const evidence = text(claim?.evidence);
    const sourcePath = safeFactPath(rootDir, source);
    if (!text(claim?.claim) || !source || !evidence) {
      issues.push(`${label} requires claim, source, and evidence`);
      continue;
    }
    if (!sourcePath || !existsSync(sourcePath)) {
      issues.push(`${label}.source is not an available authoritative Career Ops fact source: ${source || '(missing)'}`);
      continue;
    }
    const sourceText = readFileSync(sourcePath, 'utf-8');
    if (!normalized(sourceText).includes(normalized(evidence))) {
      issues.push(`${label}.evidence was not found in ${source}`);
      continue;
    }
    const claimTokens = [...new Set(tokens(claim.claim).filter(token => !['ben', 'benjamin', 'turner', 'experience'].includes(token)))];
    const evidenceTokens = new Set(tokens(evidence));
    const overlap = claimTokens.filter(token => evidenceTokens.has(token)).length;
    if (claimTokens.length > 0 && overlap < Math.min(2, claimTokens.length)) {
      issues.push(`${label}.claim is not sufficiently supported by its cited evidence`);
    }
  }
}

export function validateHandoff(payload, options = {}) {
  const rootDir = resolve(options.rootDir || ROOT);
  const issues = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HandoffValidationError(['handoff must be a YAML/JSON object']);
  }
  if (payload.schema_version !== 1) issues.push('schema_version must be 1');

  const source = payload.source || {};
  if (normalized(source.evaluator) !== 'chatgpt') issues.push('source.evaluator must be ChatGPT');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(source.evaluated_at))) issues.push('source.evaluated_at must be YYYY-MM-DD');
  if (source.authoritative_posting_verified !== true) issues.push('source.authoritative_posting_verified must be true');

  const job = payload.job || {};
  for (const key of ['company', 'title', 'url', 'location', 'work_arrangement', 'posting_status', 'jd_text']) {
    if (!text(job[key])) issues.push(`job.${key} is required`);
  }
  try {
    const url = new URL(text(job.url));
    if (url.protocol !== 'https:') issues.push('job.url must use https');
  } catch {
    issues.push('job.url must be a valid URL');
  }
  if (normalized(job.posting_status) !== 'live') issues.push('job.posting_status must be live for trusted import');
  if (text(job.jd_text).length < 200) issues.push('job.jd_text is too short to validate identity and requirements');
  if (text(job.title) && text(job.jd_text) && !titleMatchesJd(job.title, job.jd_text)) {
    issues.push('job.title does not sufficiently match job.jd_text');
  }
  if (text(job.company) && text(job.jd_text) && !companyMatchesJd(job.company, job.jd_text)) {
    issues.push('job.company does not sufficiently match job.jd_text');
  }
  const urlReq = requisitionFromUrl(job.url);
  const suppliedReq = text(job.requisition_id).toUpperCase();
  if (urlReq && suppliedReq && urlReq !== suppliedReq) {
    issues.push(`job.requisition_id (${suppliedReq}) conflicts with URL requisition (${urlReq})`);
  }

  const evaluation = payload.evaluation || {};
  if (!VALID_TIERS.has(text(evaluation.tier))) issues.push('evaluation.tier must be Tier 1, Tier 2, Tier 3, Pass, or Reject');
  if (!Number.isFinite(evaluation.score) || evaluation.score < 1 || evaluation.score > 5) issues.push('evaluation.score must be a number from 1 to 5');
  if (!VALID_ACTIONS.has(text(evaluation.recommended_action))) issues.push('evaluation.recommended_action must be Apply, Consider, Research first, or Skip');
  for (const key of ['recommended_action', 'archetype', 'specialist_or_generalist', 'why_ben', 'candidate_pool_disadvantage', 'role_specific_bridge_evidence', 'positioning_strategy']) {
    if (!text(evaluation[key])) issues.push(`evaluation.${key} is required`);
  }
  if (evaluation.material_requirements_complete !== true) issues.push('evaluation.material_requirements_complete must be true');
  if (!Array.isArray(evaluation.requirements) || evaluation.requirements.length === 0) {
    issues.push('evaluation.requirements must contain every material requirement');
  } else {
    for (const [index, requirement] of evaluation.requirements.entries()) {
      const label = `evaluation.requirements[${index}]`;
      if (!text(requirement?.requirement)) issues.push(`${label}.requirement is required`);
      if (!VALID_STRENGTHS.has(normalized(requirement?.strength))) issues.push(`${label}.strength is invalid`);
      if (!VALID_STATUSES.has(normalized(requirement?.status))) issues.push(`${label}.status must be met, unmet, or unknown`);
      if (!text(requirement?.evidence)) issues.push(`${label}.evidence is required`);
      else if (!normalized(job.jd_text).includes(normalized(requirement.evidence))) issues.push(`${label}.evidence was not found in job.jd_text`);
      if (!text(requirement?.classification_rationale)) issues.push(`${label}.classification_rationale is required`);
    }
    for (const signal of requiredJdSignals(job.jd_text)) {
      if (!evaluation.requirements.some(requirement => requirementCoversSignal(requirement, signal))) {
        issues.push(`possible omitted hard gate from JD: ${signal.slice(0, 180)}`);
      }
    }
  }
  for (const key of ['strongest_fit', 'material_concerns']) {
    if (!Array.isArray(evaluation[key])) issues.push(`evaluation.${key} must be an array`);
  }

  if (evaluation.candidate_claims_complete !== true) issues.push('evaluation.candidate_claims_complete must be true');
  validateCandidateClaims(payload, rootDir, issues);

  const requested = payload.requested_actions || {};
  if (requested.create_report !== true || requested.update_tracker !== true) {
    issues.push('requested_actions must set create_report and update_tracker to true');
  }
  if (!VALID_TRACKER_STATUSES.has(text(requested.tracker_status || 'Evaluated'))) {
    issues.push('requested_actions.tracker_status must be Evaluated or Preparing');
  }
  for (const prohibited of ['create_resume', 'create_cover_letter', 'start_application', 'submit_application']) {
    if (requested[prohibited] === true) issues.push(`requested_actions.${prohibited} is not allowed in handoff v1`);
  }

  if (issues.length > 0) throw new HandoffValidationError(issues);

  const unmet = evaluation.requirements.filter(requirement => normalized(requirement.status) !== 'met');
  const limiting = unmet.find(requirement => normalized(requirement.strength) === 'hard gate')
    || unmet.find(requirement => normalized(requirement.strength) === 'strong preference')
    || unmet.find(requirement => normalized(requirement.strength) === 'soft preference')
    || { strength: 'neutral context' };
  const gate = applyInterviewCredibilityGate({
    stage: 'evaluated',
    sourceChannel: 'chatgpt_handoff',
    requirementStrength: normalized(limiting.strength),
    hiringIntent: evaluation.specialist_or_generalist,
    candidatePoolDisadvantage: evaluation.candidate_pool_disadvantage,
    whyBen: evaluation.why_ben,
    roleSpecificBridgeEvidence: evaluation.role_specific_bridge_evidence,
    proposedTier: evaluation.tier,
    fitScore: evaluation.score,
  });
  if (gate.finalTier !== evaluation.tier || gate.fitScore !== evaluation.score) {
    throw new HandoffValidationError([
      `interview-credibility gate conflicts with supplied evaluation: proposed ${evaluation.tier} ${evaluation.score}/5; gate yields ${gate.finalTier} ${gate.fitScore}/5 (${gate.reason})`,
    ]);
  }
  return { payload, gate, rootDir, requisitionId: suppliedReq || urlReq };
}

function yamlFence(value) {
  return yaml.dump(value, { lineWidth: 100, noRefs: true, quotingType: '"', forceQuotes: false }).trimEnd();
}

function list(items) {
  return items.length ? items.map(item => `- ${item}`).join('\n') : '- None identified';
}

function slug(value) {
  return normalized(value).replace(/\s+/g, '-').slice(0, 70) || 'handoff';
}

function mdCell(value) {
  return cell(value).replace(/\|/g, '/');
}

export function buildHandoffReport(payload, context) {
  const { job, evaluation, source } = payload;
  const hardStops = evaluation.requirements
    .filter(req => normalized(req.strength) === 'hard gate' && normalized(req.status) !== 'met')
    .map(req => req.requirement);
  const softGaps = evaluation.material_concerns || [];
  const summary = {
    company: job.company,
    role: job.title,
    score: evaluation.score,
    legitimacy_tier: 'High Confidence',
    archetype: evaluation.archetype,
    final_decision: evaluation.recommended_action,
    hard_stops: hardStops,
    soft_gaps: softGaps,
    top_strengths: evaluation.strongest_fit,
    risk_level: hardStops.length ? 'High' : softGaps.length ? 'Medium' : 'Low',
    confidence: 'High',
    next_action: evaluation.recommended_action,
    discard_reasons: [],
    via: null,
    company_confidential: false,
    advertised_comp: job.compensation || null,
    risk_summary: {
      legitimacy: 'high_confidence', classification: 'clear', culture: 'not_evaluated',
      interview_redflags: 'not_evaluated', ai_infra: 'not_evaluated',
    },
    evaluation_source: 'chatgpt_handoff',
    handoff_schema_version: payload.schema_version,
  };
  const requirementRows = evaluation.requirements.map(req =>
    `| ${mdCell(req.requirement)} | ${mdCell(req.strength)} | ${mdCell(req.status)} | ${mdCell(req.evidence)} |`).join('\n');
  const claims = payload.candidate_claims.map(claim => `- ${claim.claim} — ${claim.source}: “${claim.evidence}”`).join('\n');
  return `# Evaluation: ${job.company} — ${job.title}\n\n` +
    `**Date:** ${source.evaluated_at}\n**Archetype:** ${evaluation.archetype}\n**Tier:** ${evaluation.tier}\n` +
    `**Score:** ${evaluation.score}/5\n**Legitimacy:** High Confidence\n**URL:** ${job.url}\n` +
    `**PDF:** not generated — run /career-ops pdf ${slug(job.company)} explicitly\n` +
    `**Evaluation source:** trusted ChatGPT handoff v${payload.schema_version}; locally validated, not rescored\n\n---\n\n` +
    `## Machine Summary\n\n\`\`\`yaml\n${yamlFence(summary)}\n\`\`\`\n\n` +
    `## Handoff Provenance\n\n- Evaluator: ChatGPT\n- Evaluated: ${source.evaluated_at}\n- Authoritative posting verified upstream: yes\n` +
    `- Local validation: identity, application history, candidate evidence, and interview-credibility gate\n- JD SHA-256: ${context.jdHash}\n` +
    `- Requisition: ${context.requisitionId || 'not supplied'}\n\n` +
    `## A) Role Summary\n\n- **Company:** ${job.company}\n- **Role:** ${job.title}\n- **Location:** ${job.location}\n` +
    `- **Work arrangement:** ${job.work_arrangement}\n- **Compensation:** ${job.compensation || 'Not stated'}\n- **Status:** Live when externally verified\n\n` +
    `## B) CV Match\n\n${list(evaluation.strongest_fit)}\n\n### Source-backed candidate claims\n\n${claims}\n\n` +
    `## C) Level and Strategy\n\n- **Hiring intent:** ${evaluation.specialist_or_generalist}\n- **Candidate-pool disadvantage:** ${evaluation.candidate_pool_disadvantage}\n` +
    `- **Why Ben:** ${evaluation.why_ben}\n- **Role-supported bridge:** ${evaluation.role_specific_bridge_evidence}\n\n` +
    `| Material requirement | Strength | Ben status | JD/fit evidence |\n|---|---|---|---|\n${requirementRows}\n\n` +
    `## D) Compensation and Demand\n\n${job.compensation || 'Compensation was not stated in the supplied authoritative posting.'}\n\n` +
    `## E) Personalization Plan\n\n${evaluation.positioning_strategy}\n\n### Material concerns\n\n${list(evaluation.material_concerns)}\n\n` +
    `## F) Interview Plan\n\n${list(evaluation.likely_questions || [])}\n\n` +
    `## G) Posting Legitimacy\n\nThe handoff states that ChatGPT verified the authoritative posting as live. Career Ops must verify liveness again before application execution.\n\n` +
    `## Risk Summary\n\n- **Interview credibility:** ${context.gate.reason}\n- **Local import decision:** accepted without mechanical rescoring\n\n` +
    `## Job Description\n\n${job.jd_text.trim()}\n`;
}

function insertTrackerRow(markdown, row) {
  const lines = markdown.split(/\r?\n/);
  const colmap = resolveColumns(lines);
  const maxIndex = Math.max(...Object.values(colmap));
  const parts = Array(maxIndex + 1).fill('');
  const put = (key, value) => { if (colmap[key] != null) parts[colmap[key]] = cell(value); };
  put('num', row.num);
  put('date', row.date);
  put('company', row.company);
  put('role', row.role);
  put('score', row.score);
  put('status', row.status);
  put('pdf', row.pdf);
  put('report', row.report);
  put('notes', row.notes);
  if (colmap.location != null) put('location', row.location);
  if (colmap.via != null) put('via', '—');
  const formatted = `| ${parts.slice(1).join(' | ')} |`;
  const separator = lines.findIndex(line => /^\|\s*:?-+/.test(line));
  if (separator < 0) throw new Error('applications tracker table separator was not found');
  lines.splice(separator + 1, 0, formatted);
  return lines.join('\n');
}

export async function importHandoff(payload, options = {}) {
  const validated = validateHandoff(payload, options);
  const rootDir = validated.rootDir;
  const trackerPath = options.trackerPath || resolveTrackerPath(rootDir);
  const reportsDir = resolve(options.reportsDir || join(rootDir, 'reports'));
  const history = loadApplicationHistory(trackerPath);
  const prior = matchPriorApplication({
    company: payload.job.company,
    title: payload.job.title,
    url: payload.job.url,
    requisitionId: validated.requisitionId,
    description: payload.job.jd_text,
  }, history);
  if (prior.kind !== 'none') {
    throw new HandoffValidationError([priorApplicationMessage(prior)]);
  }

  const reservation = await reserveReportNumbers(1, { rootDir, reportsDir, trackerPath });
  const num = reservation[0];
  const formattedNum = formatReportNumber(num);
  const reportName = `${formattedNum}-${slug(payload.job.company)}-${payload.source.evaluated_at}.md`;
  const reportPath = join(reportsDir, reportName);
  const jdHash = createHash('sha256').update(payload.job.jd_text).digest('hex');
  const report = buildHandoffReport(payload, { ...validated, jdHash });
  const status = payload.requested_actions.tracker_status || 'Evaluated';
  mkdirSync(reportsDir, { recursive: true });
  let reportWritten = false;
  try {
    writeFileSync(reportPath, report, { encoding: 'utf-8', flag: 'wx' });
    reportWritten = true;
    const transaction = await openTrackerTransaction(trackerPath);
    try {
      const current = transaction.read();
      const updated = insertTrackerRow(current, {
        num, date: payload.source.evaluated_at, company: payload.job.company,
        role: payload.job.title, score: `${payload.evaluation.score}/5`, status,
        pdf: '❌', report: `[${formattedNum}](../reports/${reportName})`,
        location: payload.job.location,
        notes: `Imported from trusted ChatGPT handoff v${payload.schema_version}; locally validated; not rescored; application materials not generated; not submitted.${validated.requisitionId ? ` Job ID: ${validated.requisitionId}.` : ''} Job URL: ${payload.job.url}; JD fingerprint: ${jdHash.slice(0, 16)}.`,
      });
      transaction.replace(updated);
    } finally {
      transaction.close();
    }
  } catch (error) {
    if (reportWritten) unlinkSync(reportPath);
    throw error;
  } finally {
    await releaseReportNumbers(reservation, { rootDir, reportsDir, trackerPath });
  }
  return {
    report: reportPath, reportNumber: formattedNum, tracker: trackerPath,
    status, tier: payload.evaluation.tier, score: payload.evaluation.score,
  };
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--file' && argv[i + 1]) args.file = argv[++i];
    else if (!argv[i].startsWith('--') && !args.file) args.file = argv[i];
    else throw new Error(`unknown or incomplete argument: ${argv[i]}`);
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`handoff: ${error.message}\n`);
    return 1;
  }
  if (!args.file) {
    process.stderr.write('Usage: node handoff.mjs --file <handoff.yml|handoff.json> [--dry-run]\n');
    return 1;
  }
  try {
    const input = readFileSync(resolve(args.file), 'utf-8');
    const payload = /\.json$/i.test(args.file) ? JSON.parse(input) : yaml.load(input);
    if (args.dryRun) {
      const validated = validateHandoff(payload);
      const history = loadApplicationHistory(resolveTrackerPath(validated.rootDir));
      const prior = matchPriorApplication({
        company: payload.job.company, title: payload.job.title, url: payload.job.url,
        requisitionId: validated.requisitionId, description: payload.job.jd_text,
      }, history);
      if (prior.kind !== 'none') throw new HandoffValidationError([priorApplicationMessage(prior)]);
      process.stdout.write(`${JSON.stringify({ valid: true, dryRun: true, tier: payload.evaluation.tier, score: payload.evaluation.score }, null, 2)}\n`);
      return 0;
    }
    const result = await importHandoff(payload);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`handoff: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
