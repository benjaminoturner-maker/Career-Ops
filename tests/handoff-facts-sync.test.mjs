import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkHandoffFacts, sourceFingerprint } from '../handoff-facts-sync.mjs';

test('handoff fact freshness check detects an intentionally changed source fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-handoff-facts-'));
  try {
    mkdirSync(join(root, 'config'), { recursive: true });
    mkdirSync(join(root, 'modes'), { recursive: true });
    const original = '# CV\n\nLed asset evaluations.\n';
    const profile = '# Profile\n\nTechnical-commercial operator.\n';
    writeFileSync(join(root, 'cv.md'), original);
    writeFileSync(join(root, 'modes/_profile.md'), profile);
    writeFileSync(join(root, 'config/handoff-facts.md'), `---\nhandoff_facts_schema: 1\nsource_fingerprint_algorithm: sha256-redacted-source-v1\nsource_fingerprints:\n  cv.md: ${sourceFingerprint(original)}\n  modes/_profile.md: ${sourceFingerprint(profile)}\n---\n\n- Led asset evaluations.\n`);
    assert.equal(checkHandoffFacts({ rootDir: root }).status, 'fresh');
    writeFileSync(join(root, 'cv.md'), `${original}- Added a materially new leadership fact.\n`);
    const changed = checkHandoffFacts({ rootDir: root });
    assert.equal(changed.status, 'stale');
    assert.equal(changed.stale, true);
    assert.match(changed.mismatches[0], /authoritative source changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
