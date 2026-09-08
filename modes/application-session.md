# Mode: application-session — 30-minute application queue

Use this mode when Ben asks to start a 30-minute application session or prepare one or more explicitly approved applications. This mode orchestrates existing Career Ops components; it does not replace evaluation, PDF, apply/browser, tracker, answer-persistence, or follow-up logic.

## Safety boundary

- `data/applications.md` remains the only authoritative application history.
- Never infer submission from generated files or an open/filled form.
- Never click final Submit, Send, or Apply.
- Only run `confirm-submitted --confirmed-by-ben` after Ben explicitly says the application was submitted.
- Legal, work-authorization, sponsorship, relocation, compensation, demographic, and other sensitive answers remain Ben-confirmation gates unless already explicit in the approved source files.
- A bare unapproved URL stays in the normal evaluation workflow.

## Start a session

Build a small queue JSON from approved URLs, trusted imported handoffs, or existing evaluated reports. Before marking a queue item ready, reuse existing checks and record their results instead of reimplementing them:

- application history through the existing tracker matcher;
- liveness through the existing liveness checker;
- company blacklist;
- existing report/handoff hard-gate analysis;
- factual résumé validation;
- unresolved candidate facts;
- observed or expected form friction.

Queue item fields:

```json
{
  "id": "stable-item-id",
  "company": "Example Co",
  "title": "Director, Strategy",
  "url": "https://example.com/jobs/123",
  "approved": true,
  "priority": false,
  "lane": "fast",
  "liveness": "active",
  "factual_integrity": "passed",
  "friction": "low",
  "hard_blocker": "",
  "required_facts": [],
  "tracker_number": 15,
  "report_number": "015",
  "report_path": "reports/015-example-2026-09-08.md"
}
```

Start with:

```bash
node application-session.mjs start --queue queue.json --minutes 30
```

The durable state is written under `data/application-sessions/`. Use the printed state path for later commands.

## Processing loop

The controller skips authoritative prior applications and dead postings, defers possible reposts, unconfirmed liveness, blacklisted companies, unresolved gates/facts, and high-friction forms, then continues until it finds the next viable item.

For `ready_for_preparation`:

1. Reuse the existing report or trusted imported handoff.
2. Generate/select the truthful résumé and cover letter through the existing PDF workflow.
3. Use the existing apply mode/browser primitives to extract and fill supported fields.
4. Leave sensitive/unresolved fields for Ben.
5. Put the form in front of Ben without submitting.
6. Record the handoff:

```bash
node application-session.mjs prepared --state <state-path>
```

After Ben reviews and personally submits, record the explicit confirmation. This runs the canonical status and follow-up adapters, safely persists structured answers when supplied, and automatically advances to the next viable queue item:

```bash
node application-session.mjs confirm-submitted --state <state-path> --confirmed-by-ben --date YYYY-MM-DD --provenance "Ben-confirmed" --attention-minutes N
```

If the current form becomes disproportionate, defer it and continue immediately:

```bash
node application-session.mjs defer --state <state-path> --reason "captcha loop" --attention-minutes N
```

## Lanes and time

- **Fast:** approved, live, low friction, no unresolved gate, truthful materials available. A sub-4.0 score does not block an approved item.
- **Priority:** explicitly priority/referral/exceptional opportunity. Allow more tailoring without diminishing-return rewrites.
- **Defer:** login/CAPTCHA/assessment/essay/long Workday flow, technical blocker, unresolved legal or eligibility answer, or disproportionate remaining effort.

Ben-attention minutes are recorded explicitly; unattended model/render/browser time does not consume that field. When five or fewer attention minutes remain, the controller prefers a later fast-lane item over a priority/high-friction item. It finishes any prepared application safely before stopping.

## GitHub receiver result

The receiver may return aggregate `blocked` and a nonzero exit while still receiving later valid Issues. Inspect its per-Issue `results` or the inbox. Only successfully received inbox files may proceed to `handoff-runner.mjs`; GitHub content never bypasses runner validation/import.

Keep session output operational and compact. Do not insert strategy commentary between items.
