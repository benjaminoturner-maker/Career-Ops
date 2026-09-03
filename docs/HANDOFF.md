# ChatGPT → Career Ops handoff

The `handoff` path avoids paying twice for the same job-market judgment while preserving Career Ops' local safeguards.

## Responsibility split

- **ChatGPT/Atlas:** discovery, authoritative posting verification, primary calibrated evaluation, recommendation, and application strategy.
- **Career Ops/Codex:** local schema and identity validation, application-history protection, candidate-fact validation, interview-credibility enforcement, durable reports/tracking, and later document/application execution.

Career Ops retains its normal full `auto-pipeline` and `oferta` paths when no trusted handoff exists.

## Invocation

```bash
node handoff.mjs --file handoff.yml --dry-run
node handoff.mjs --file handoff.yml
```

The first command validates without writing. The second creates a concise report and an `Evaluated` or `Preparing` tracker row. It never creates application materials or starts/submits an application.

## Compact version 1 schema

```yaml
schema_version: 1
source:
  evaluator: ChatGPT
  evaluated_at: 2026-09-02
  authoritative_posting_verified: true
job:
  company: Example Industrial Co.
  title: Director, Corporate Development
  url: https://jobs.example.com/job/123
  requisition_id: "123"
  location: Denver, Colorado
  work_arrangement: Hybrid
  compensation: "$160,000-$190,000"
  posting_status: live
  jd_text: |
    Director, Corporate Development
    Full authoritative job description of at least 200 characters...
evaluation:
  tier: Tier 2
  score: 4.1
  recommended_action: Apply
  archetype: Industrial Corporate Development
  specialist_or_generalist: Generalist with industrial transaction judgment
  candidate_pool_disadvantage: Conventional corp-dev candidates have more company-level M&A repetitions.
  why_ben: The posting explicitly values technical and operating judgment that Ben can evidence.
  role_specific_bridge_evidence: The JD accepts engineering and operating backgrounds for technical diligence.
  material_requirements_complete: true
  candidate_claims_complete: true
  requirements:
    - requirement: Lead cross-functional technical due diligence
      strength: strong preference
      status: met
      evidence: The JD asks the leader to coordinate technical and commercial diligence.
      classification_rationale: The posting accepts adjacent operating evidence.
  strongest_fit:
    - Technical-commercial asset evaluation and executive recommendations
  material_concerns:
    - No conventional investment-banking career
  positioning_strategy: Lead with operator judgment and disciplined acquisition evaluation.
  likely_questions:
    - Why move from operating leadership into this role?
candidate_claims:
  - claim: Ben has led acquisition and divestiture evaluation.
    source: cv.md
    evidence: Exact supporting phrase copied from cv.md
requested_actions:
  create_report: true
  update_tracker: true
  tracker_status: Evaluated
```

`requisition_id` and `compensation` may be `null` when the authoritative posting exposes neither. Every factual candidate premise must have a `candidate_claims` entry whose evidence appears in its named authoritative source. Allowed sources are `cv.md`, `article-digest.md`, `config/profile.yml`, `config/cv-facts.json`, `modes/_profile.md`, `interview-prep.md`, and `voice-dna.md`.

Requirement evidence must appear in the supplied authoritative JD, and `classification_rationale` explains why its strength is contextual rather than inferred from one keyword. `candidate_claims_complete: true` attests that every factual candidate premise used by the evaluation appears in the source-backed claim list.

The importer pauses on prior applications and possible reposts, identity/JD conflicts, unsupported evidence, incomplete material-requirement analysis, unmet hard gates, or a Tier 1/2 result without a concrete Why Ben rationale and posting-supported bridge. It reports the conflict instead of silently rescoring.

Routine imports run only handoff validation and `verify-pipeline.mjs`. Résumé creation separately runs CV synchronization, factual validation, PDF rendering, and visual QA. Full suites, provider checks, portal validation, and update-system coverage belong to development work when the corresponding code or configuration changes.
