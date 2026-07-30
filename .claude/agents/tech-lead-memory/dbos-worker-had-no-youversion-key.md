---
name: dbos-worker-had-no-youversion-key
description: The DBOS worker could not read scripture AT ALL — root docker-compose.yml passed YOUVERSION_APP_KEY to the nextjs service and to nothing else — and the gap was invisible because every e2e fixture in every repo was a blank project with no manifest.scripture to fetch
metadata:
  type: context
---

Found and fixed **2026-07-30**, while running `supagloo-nextjs`'s new
`tests/e2e/studio-wizard-scripture-carry.e2e.ts` for the first time.

## The defect

`supagloo-nodejs-dbos` reads `YOUVERSION_APP_KEY` (`src/config/env.ts`), hands it to the
runtime (`src/dbos/runtime.ts`) and sends it as the live API's `x-yvp-app-key`
(`src/providers/youversion.ts`). Root `docker-compose.yml` **never passed it to the `dbos`
service** — only to `nextjs`, and there under the other spelling (`YV_APP_KEY:
${YOUVERSION_APP_KEY}`, plan row 43 / D43.3's "one value, two spellings").

Measured from inside the container: `GET /v1/bibles/12/passages/PSA.23` answers **401** with
no header and **200** with the key. `env.ts` declares the var `.optional()`, so the worker
booted clean and failed only at the call. The 401 is non-retryable, so the user's symptom was
**"Generation failed — try again"** with the cause three services away.

Root's `.env.example` described the variable as *"already wired — dbos sends it as a
header"*: true of the CODE, false of the WIRING. That sentence is why nobody looked.

The api needs nothing — it only lists `x-yvp-app-key` in its redaction table, it never sends
it.

## Why nothing caught it for so long

The path was **unreachable, not merely untested**. `generateScript` calls `fetchPassage` only
when the project's manifest HAS a `scripture` block, and every e2e fixture in every repo was
a `createdFrom: "blank"` project without one — because both shared acquisition helpers in
`github-e2e.ts` call `skipWizardScriptureStep` (deliberately: seeding a passage would change
eight other specs' subject under test). So the whole passage-fetch path was dead code under
test, and `studio-replan-scripture.e2e.ts` / `studio-ai-generation.e2e.ts` generated
storyboards green while never once exercising it.

The first spec to create a project WITH a chosen passage found it on its first honest run.
**A capability that no fixture can reach is not covered by the suites that pass around it.**

## The fix, and the guard

One line in root `docker-compose.yml`'s `dbos` block —
`YOUVERSION_APP_KEY: ${YOUVERSION_APP_KEY}` — plus the corrected `.env.example` comment, plus
a new assertion in root `tests/unit/dbos-compose.test.ts` that the block carries the `${VAR}`
reference. The test is what stops the comment drifting back into a claim nothing checks.

**A scratchpad compose overlay is not a way to test this.** The nextjs real-e2e lane's
`tests/e2e/global-setup.render.ts` brings the stack up from root `docker-compose.yml` itself,
so it recreated the `dbos` container and dropped an out-of-band `-f` overlay's env var
mid-run — visible as a fresh `Initializing DBOS` line timestamped at the run's start, and a
401 that came back for no apparent reason. Fix the committed file.

Related: [[wizard-passage-must-travel-as-usfm]],
[[youversion-bible-read-surface-lives-in-nextjs]], [[youversion-verse-range-is-echoable]],
[[e2e-cascade-select-needs-the-option-not-the-element]], [[real-github-e2e-harness]].
