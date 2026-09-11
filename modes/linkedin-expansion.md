# Mode: linkedin-expansion — one authenticated LinkedIn search expansion

Use this mode for exactly one pending `career-ops-linkedin-search` task. It is an agent-mediated discovery step, not an application workflow and not a trusted final-role handoff.

## Safety boundary

- The Codex agent uses the authenticated built-in browser; repository Node code cannot invoke that browser directly.
- Never request, copy, export, or persist LinkedIn passwords, cookies, tokens, or browser profiles.
- Never click Apply, Easy Apply, Save, Follow, Message, recruiter/contact actions, or any application control.
- Ben personally handles login, CAPTCHA, identity verification, and security challenges.
- Do not modify GitHub Issues. Do not submit applications.
- Preserve unrelated dirty worktree changes.

## Exact workflow

Run the deterministic selector from the repository root:

```bash
node application-session.mjs linkedin-expansion-next
```

The selector runs the existing receiver, considers returned tasks in GitHub Issue-number order, skips only tasks whose expansion state is `completed`, and returns the next immutable task. `blocked_*` tasks remain retryable. If the result is `idle`, stop. If it is `github_error`, report the receiver error and stop.

Before browser work, report the selected `task_id`, Issue identity when available, exact URL, search metadata, and current state. Open only the exact `task.linkedin_search.url` in the authenticated built-in browser. Do not reconstruct filters or silently substitute another search URL.

## Browser extraction — two passes

Pass 1 inspects no more than 25 result cards by default. Use a smaller/larger configured limit only when explicitly supplied to the repository contract with `--max-jobs N`. Normalize and deduplicate by numeric LinkedIn job ID before enrichment. Then Pass 2 must attempt detail enrichment for every unique discovered job within that limit; do not stop after collecting enough cards or a few JDs.

For each job in Pass 2:

1. Open/select the detail pane or page.
2. Verify that the detail matches the expected LinkedIn job ID, title, and company.
3. Wait for rendered detail content to load.
4. Expand “Show more” or an equivalent description control when present and safe.
5. Extract the fullest authoritative rendered JD text available.
6. Preserve posting age/date, work arrangement, and salary when shown.
7. Record exactly one JD retrieval disposition, then continue to the next job.

Capture rendered values only:

- numeric LinkedIn job ID and authoritative `/jobs/view/{id}/` URL;
- title, company, and location;
- posting age/date, work arrangement, and salary when shown;
- complete rendered job description when available;
- `jd_retrieval_status`: `complete`, `partial`, `unavailable`, `dead_or_stale`, `access_blocked`, or `not_attempted`;
- `jd_retrieval_reason` for every non-`complete` disposition.

`complete` requires the fullest rendered JD and nontrivial text. `partial` requires some rendered JD text but is not evaluation-ready by default. `unavailable`, `dead_or_stale`, `access_blocked`, and `not_attempted` use empty `jd_text` and an explicit reason. Never silently leave `jd_text` empty. Do not summarize or invent text. If one job cannot be enriched, record its disposition and continue unless the browser/session itself is blocked.

If the browser shows login, CAPTCHA, security/identity verification, access denied, an unavailable search, or an unexpected LinkedIn page, stop extraction. Create a blocked artifact with no jobs, stage it through the repository contract, tell Ben exactly what he must complete personally, and stop. Never bypass the blocker.

## Artifact and processing handoff

Preserve the immutable discovery artifact at `data/linkedin-search-runtime/agent-artifacts/<task_id>.json`. Write a deterministic derived enrichment artifact at `data/linkedin-search-runtime/jd-enrichment/<task_id>.json` (create the directory if needed), containing every unique discovered job and the exact SHA-256 of the source artifact. Validate and stage it:

```bash
node application-session.mjs process-linkedin-expansion data/linkedin-search-runtime/agent-artifacts/<task_id>.json --max-jobs 25
node application-session.mjs process-linkedin-jd-enrichment data/linkedin-search-runtime/jd-enrichment/<task_id>.json --source-artifact data/linkedin-search-runtime/agent-artifacts/<task_id>.json --max-jobs 25
```

The discovery artifact must continue using the schema in `linkedin-expansion-artifact.mjs` and preserve the exact stored search URL. The derived artifact uses `linkedin-jd-enrichment.mjs`; it must account for every source job. Its `evaluation_ready` selector includes only `complete` jobs. A session-level stop records `not_attempted` for jobs not reached, rather than pretending they were unavailable.

The Codex host may call the exported `processLinkedInExpansionArtifact()` function with the normal Career Ops evaluation adapter. Do not reproduce evaluation logic in this mode. Existing Career Ops code remains responsible for history deduplication, hard gates, interview credibility, liveness, reports, tracker updates, and queue construction.

## Required result report

Report the task, originating Issue, exact URL, cards inspected, unique jobs extracted, complete JDs extracted, duplicate cards suppressed, downstream outcomes, queued jobs, artifact path, task state, blockers, and final `git status --short`. Then stop.
