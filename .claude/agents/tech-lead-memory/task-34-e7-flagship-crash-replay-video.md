---
name: task-34-e7-flagship-crash-replay-video
description: 34-E7 reworked the video crash/replay e2e to be host-introspection-free (providerJobId stability + system-DB submitVideoJob count) — pure test/helper work, zero workflow-code change since task 34 already satisfied the property
metadata:
  type: decision
---

Task 34-E7 (dbos-only, design-delta §10.5) reworked `generateVideoClipWorkflow`'s crash/replay e2e
to drop the retired openrouter-stub `/__stub/calls` `videoJobsCreated` counter (§10.7) and prove the
flagship recovery property against **real OpenRouter** with two host-introspection-free assertions.

**Zero `generate-video.ts` workflow-code change.** Task 34 already implements the property: the
`submitVideoJob` step POSTs the async job AND `persistVideoProviderJobId(...)` in the SAME DBOS step,
so a completed submit is memoized and never re-issued on replay. So 34-E7's entire "Green" is the new
test + helper code — there was NO pre-existing functional gap in the workflow. The e2e's pre-task RED
was purely "the test was an `it.todo`, and the stability helper it imports didn't exist yet"; once
written + the helper created, it passes against the unchanged workflow. (Explicitly the case the task
brief anticipated: "most of the Green work is in the test/helper code itself.")

**What was built (all in `supagloo-nodejs-dbos`, branch v0.0.28, uncommitted for Step-7 release):**
- NEW `src/testing/provider-job-id-stability.ts` — pure predicate
  `isProviderJobIdStable(captured, final): boolean` (true IFF `captured` is a non-empty string AND
  `captured === final`). Chose decision (a) (a distinct unit-tested "comparison logic" module,
  mirroring `step-introspection.ts`) over (b) inline `expect`, because "stable" is NOT the tautology
  `before===after`: it must also reject a blank/missing capture (submit never committed) AND a
  DIVERGED final id (a replay re-submitted → a NEW job id, the exact §10.5 failure). Dist-excluded via
  `tsconfig.build.json` `src/testing/**`. Unit-tested in `provider-job-id-stability.test.ts` (5 cases).
- `src/testing/step-introspection.test.ts` — +1 additive test proving the helper FORWARDS
  `workflowID` to `listWorkflowSteps` (a fake keyed by workflowID), honoring plan.md's "for the
  target workflowID" wording. Helper CODE unchanged (finding: reuse `countStepExecutions` unchanged).
  Real deeper scoping is server-side in `DBOSClient.listWorkflowSteps(workflowID)` + exercised by
  every e2e using a distinct genId; decided NOT to add a heavier mock-call-verification test.
- `tests/e2e/generate-video.e2e.ts` — replaced the `it.todo` crash/replay with a real test. Follows
  the repo's in-process crash idiom VERBATIM (same as generate-script.e2e.ts, scaffold/commit/publish):
  park at the FIRST `pollVideoJob` boundary via `__setGenerateVideoBoundaryHook` (its first-ever
  consumer — after submit committed providerJobId, before completion) → `DBOS.cancelWorkflow` →
  release the hook → await the interrupted promise → `waitForStatus(jobId,["CANCELLED","ERROR"])`
  (per-file dup helper) → `DBOS.resumeWorkflow` → assert. "Kill the worker" is FIGURATIVE (no
  child_process). Assertions: (1) `row.providerJobId === capturedJobId` +
  `isProviderJobIdStable(...)` true + `result.providerJobId === capturedJobId`; (2)
  `countStepExecutions(client, genId, "submitVideoJob") === 1` both BEFORE and AFTER recovery; plus
  the clip completed into MinIO (non-empty bytes at `buildAssetKey`). A `parked` guard makes only the
  first pollVideoJob fire block (the label repeats before every poll).

**GOTCHA — the e2e test lane is NOT typechecked.** `tsconfig.json` `include` is `src/**/*.ts` only;
`npm run typecheck` never sees `tests/**`, and vitest runs via esbuild (no typecheck). A temp tsconfig
including the e2e surfaced 2 pre-existing type errors: `client.enqueue<GenerateVideoResult>` — the SDK
constrains `enqueue<T>`'s T to a workflow-FUNCTION type `(...args)=>Promise<any>`, not the result type.
This is the established codebase-wide test-lane convention (the untouched happy path line 193 + every
`generate-script.e2e.ts` enqueue do the identical thing) — NOT a 34-E7 regression, left as-is to match
precedent. My new code (`resumeWorkflow`, `isProviderJobIdStable`, `waitForStatus`, boundary hook) is
type-clean.

**Verification (2026-07-23):** full `generate-video.e2e.ts` = 2/2 green (happy path + crash/replay)
against REAL OpenRouter + Compose MinIO, 256.71s, one real ~2s clip per test (§10.9 cost, ~$1 total).
Two unit files 10/10 green; whole unit suite 344/344; src typecheck clean. `.env` must be SOURCED into
the shell to run the e2e (no dotenv in code): `set -a; . ./.env; set +a; npx vitest run --config
vitest.e2e.config.ts tests/e2e/generate-video.e2e.ts`. Compose stack reused-if-healthy by global-setup.

**ACCEPTED, not tested (task brief / §10.5):** the sub-second window between the real submit HTTP
succeeding and the step checkpoint committing is unprovable without provider introspection; the
`Idempotency-Key: genId` header is unverified defense-in-depth (not asserted). Stub cleanup
(`videoJobsCreated`, docker-compose.test.yml leftovers) is task 34-E8.

See [[task-34-e4-dbos-e2e-real-provider-generate]] (introduced `countStepExecutions` + the video happy
path this builds on), [[generate-video-workflow-built]], [[e2e-test-infra-conventions]].
