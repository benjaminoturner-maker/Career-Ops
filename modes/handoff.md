# Mode: handoff — Trusted ChatGPT Evaluation Import

Use this mode when ChatGPT/Atlas has already completed discovery, authoritative-source verification, calibrated evaluation, recommendation, and application strategy. Career Ops/Codex validates and persists that work; it does not rerun the full A–G evaluation.

Run `node handoff.mjs --file path/to/handoff.yml --dry-run` first. If it succeeds and import was requested, run `node handoff.mjs --file path/to/handoff.yml`, then `node verify-pipeline.mjs`.

ChatGPT is trusted as primary evaluator only when every required field is present. Career Ops remains authoritative for candidate facts and `data/applications.md` for application history. Never mechanically rescore a valid import. Stop without writing on a fact, history, identity, requisition, JD, requirement-coverage, or interview-credibility conflict. Generic transferable-skills reasoning is not a sufficient Tier 1/2 bridge.

Handoff v1 creates only a concise report and an `Evaluated` or `Preparing` tracker row. It does not generate application materials, open a browser, start an application, answer questions, or submit anything. Those remain explicit downstream actions.

Routine imports run schema, identity, history, fact-evidence, interview-credibility, and pipeline checks. Broad repository/provider/portal/update tests are development checks, not routine handoff steps.
