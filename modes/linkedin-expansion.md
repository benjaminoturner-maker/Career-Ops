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

## Browser extraction

Inspect no more than 25 result cards by default. Use a smaller/larger configured limit only when explicitly supplied to the repository contract with `--max-jobs N`. Deduplicate by numeric LinkedIn job ID. For each distinct result, capture rendered values only:

- numeric LinkedIn job ID and authoritative `/jobs/view/{id}/` URL;
- title, company, and location;
- posting age/date, work arrangement, and salary when shown;
- complete rendered job description when available.

Open job detail panes/pages as needed, but do not summarize or invent `jd_text`. Missing optional fields remain empty/missing. Handle lazy loading conservatively and stop at the explicit limit.

If the browser shows login, CAPTCHA, security/identity verification, access denied, an unavailable search, or an unexpected LinkedIn page, stop extraction. Create a blocked artifact with no jobs, stage it through the repository contract, tell Ben exactly what he must complete personally, and stop. Never bypass the blocker.

## Artifact and processing handoff

Write a deterministic artifact named `data/linkedin-search-runtime/agent-artifacts/<task_id>.json` (create the directory if needed), then validate and stage it:

```bash
node application-session.mjs process-linkedin-expansion data/linkedin-search-runtime/agent-artifacts/<task_id>.json --max-jobs 25
```

The artifact must use the schema in `linkedin-expansion-artifact.mjs`, preserve the exact stored search URL, and include `expansion_status: completed` only when browser extraction actually completed. Blockers use `blocked_*` and an empty jobs array.

The Codex host may call the exported `processLinkedInExpansionArtifact()` function with the normal Career Ops evaluation adapter. Do not reproduce evaluation logic in this mode. Existing Career Ops code remains responsible for history deduplication, hard gates, interview credibility, liveness, reports, tracker updates, and queue construction.

## Required result report

Report the task, originating Issue, exact URL, cards inspected, unique jobs extracted, complete JDs extracted, duplicate cards suppressed, downstream outcomes, queued jobs, artifact path, task state, blockers, and final `git status --short`. Then stop.
