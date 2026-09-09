#!/usr/bin/env node

/** Read-only freshness check for the committed, remote-safe handoff fact snapshot. */
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const SOURCE_FILES = ['cv.md', 'modes/_profile.md'];

function redactNonCareerIdentifiers(value) {
  return String(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email-redacted]')
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g, '[phone-redacted]')
    .replace(/^.*\b(?:home address|street address)\b.*$/gim, '[address-redacted]')
    .replace(/\r\n/g, '\n')
    .split('\n').map(line => line.trimEnd()).join('\n').trim();
}

export function sourceFingerprint(value) {
  return createHash('sha256').update(redactNonCareerIdentifiers(value)).digest('hex');
}

export function readSnapshotMetadata(snapshotText) {
  const match = String(snapshotText).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('config/handoff-facts.md must begin with YAML front matter');
  const metadata = yaml.load(match[1]);
  if (metadata?.handoff_facts_schema !== 1) throw new Error('handoff_facts_schema must be 1');
  if (metadata?.source_fingerprint_algorithm !== 'sha256-redacted-source-v1') throw new Error('unsupported source_fingerprint_algorithm');
  return metadata;
}

export function checkHandoffFacts({ rootDir = ROOT, snapshotPath } = {}) {
  const root = resolve(rootDir);
  const target = resolve(snapshotPath || join(root, 'config', 'handoff-facts.md'));
  if (!existsSync(target)) return { status: 'missing_snapshot', snapshot: target, stale: true, mismatches: ['config/handoff-facts.md is missing'] };
  const metadata = readSnapshotMetadata(readFileSync(target, 'utf8'));
  const expected = metadata.source_fingerprints || {};
  const missingSources = [];
  const mismatches = [];
  const observed = {};
  for (const relativePath of SOURCE_FILES) {
    const sourcePath = join(root, relativePath);
    if (!existsSync(sourcePath)) { missingSources.push(relativePath); continue; }
    observed[relativePath] = sourceFingerprint(readFileSync(sourcePath, 'utf8'));
    if (!expected[relativePath]) mismatches.push(`${relativePath}: stored fingerprint missing`);
    else if (expected[relativePath] !== observed[relativePath]) mismatches.push(`${relativePath}: authoritative source changed`);
  }
  if (missingSources.length) return { status: 'unverifiable_remote', stale: false, snapshot: target, missing_sources: missingSources, mismatches, observed };
  return { status: mismatches.length ? 'stale' : 'fresh', stale: mismatches.length > 0, snapshot: target, missing_sources: [], mismatches, observed };
}

function main(argv) {
  const result = checkHandoffFacts();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (argv.includes('--check') && result.stale) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
