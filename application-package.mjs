#!/usr/bin/env node

/** Deterministic bridge from a final Apply evaluation to reviewable materials. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const JOB_ID = /^\d+$/;
const LINKEDIN_JOB = /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/?$/;

function text(value) { return String(value ?? '').trim(); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function readJson(path) { return JSON.parse(readFileSync(resolve(path), 'utf8')); }
function atomic(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }

export function validateApplicationPackageInput({ evaluation, enrichment, jobId, candidateEvidence }) {
  if (!evaluation || evaluation.schema_version !== 1 || !Array.isArray(evaluation.jobs)) throw new Error('a schema_version 1 evaluation artifact is required');
  if (!enrichment || enrichment.schema_version !== 1 || !Array.isArray(enrichment.jobs)) throw new Error('a schema_version 1 JD enrichment artifact is required');
  if (!text(candidateEvidence)) throw new Error('authoritative candidate evidence is required');
  const job = evaluation.jobs.find(item => text(item.linkedin_job_id) === text(jobId));
  if (!job || job.classification !== 'apply' || job.processing?.approved !== true) throw new Error('only an approved final Apply evaluation can create a package');
  if (job.primary_search_eligibility && (job.primary_search_eligibility.result !== 'eligible' || job.primary_search_eligibility.eligible !== true)) throw new Error('primary-search eligibility must be eligible before creating a package');
  const enriched = enrichment.jobs.find(item => text(item.linkedin_job_id) === text(jobId));
  if (!enriched || enriched.jd_retrieval_status !== 'complete' || enriched.evaluation_ready !== true || !text(enriched.jd_text)) throw new Error('a complete authoritative JD is required');
  return { job, enriched };
}

export function buildApplicationPackage({ evaluation, enrichment, jobId, candidateEvidence, resumePath, coverLetterPath = 'not_needed', now = new Date().toISOString(), outputRoot = join(ROOT, 'data', 'linkedin-search-runtime', 'application-packages') }) {
  if (!JOB_ID.test(text(jobId))) throw new Error('jobId must be numeric');
  if (!text(candidateEvidence)) throw new Error('authoritative candidate evidence is required');
  validateApplicationPackageInput({ evaluation, enrichment, jobId, candidateEvidence });
  const job = evaluation?.jobs?.find(item => text(item.linkedin_job_id) === text(jobId));
  if (!job || job.classification !== 'apply' || job.processing?.approved !== true) throw new Error('only an approved final Apply evaluation can create a package');
  if (!LINKEDIN_JOB.test(text(job.url))) throw new Error('evaluation must contain an authoritative LinkedIn job URL');
  if (!text(resumePath) || !existsSync(resolve(resumePath))) throw new Error('a generated resume path is required');
  if (coverLetterPath !== 'not_needed' && (!text(coverLetterPath) || !existsSync(resolve(coverLetterPath)))) throw new Error('cover-letter path does not exist');
  const packageDir = join(resolve(outputRoot), text(jobId));
  const reportPath = join(packageDir, 'fit-gap-summary.md');
  const manifestPath = join(packageDir, 'package.json');
  const manifest = {
    schema_version: 1, package_id: `linkedin-${jobId}`, job_id: text(jobId), company: job.company, title: job.title, location: job.location,
    authoritative_url: job.url, source_task_id: evaluation.source?.task_id || '', source_evaluation_artifact: evaluation.source?.artifact_sha256 || '',
    classification: 'apply', fit_summary: job.fit_assessment, strongest_candidate_evidence: job.relevant_candidate_evidence,
    material_gaps: job.material_gaps, resume_path: resolve(resumePath), cover_letter_path: coverLetterPath === 'not_needed' ? 'not_needed' : resolve(coverLetterPath),
    package_status: 'package_ready', generated_at: now, submitted: false, candidate_evidence_sha256: sha256(candidateEvidence), report_path: reportPath,
  };
  const report = `# Application Package: ${job.company} — ${job.title}\n\n**Package status:** Package Ready\n**Recommended action:** Apply\n**URL:** ${job.url}\n**Location:** ${job.location}\n**LinkedIn job ID:** ${jobId}\n\n## Fit summary\n\n${text(job.fit_assessment?.rationale)}\n\n## Why Ben could get an interview\n\n${job.relevant_candidate_evidence.map(item => `- ${item}`).join('\n')}\n\n## Material concerns\n\n${job.material_gaps.length ? job.material_gaps.map(item => `- ${item}`).join('\n') : '- None recorded.'}\n\n## Materials\n\n- Resume: ${resolve(resumePath)}\n- Cover letter: ${manifest.cover_letter_path}\n\n**Application status:** Not Applied. Ben must submit manually.\n`;
  mkdirSync(packageDir, { recursive: true });
  atomic(manifestPath, manifest);
  writeFileSync(reportPath, report);
  return { status: 'package_ready', package_id: manifest.package_id, package_dir: packageDir, manifest_path: manifestPath, report_path: reportPath, resume_path: manifest.resume_path, cover_letter_path: manifest.cover_letter_path, submitted: false };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  console.error('Use application-session.mjs prepare-application-package with validated artifact inputs.');
  process.exitCode = 1;
}
