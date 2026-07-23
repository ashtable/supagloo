---
name: failure-injection-unit-reclassification-pattern
description: How simulated-provider-failure cases are unit-tested (task 34-E1 / design-delta §10.6) — injected-fetch at the call-function level, NOT DBOS-in-process; where each reproduction lives
metadata:
  type: decision
---

Task 34-E1 (2026-07-23) reclassified the three stub-driven deterministic-failure
e2e cases to injected-`fetch` UNIT tests and deleted the e2e cases (design-delta
§10.6: simulated provider behavior is definitionally not end-to-end). See
[[e2e-test-infra-conventions]] for the broader §10 posture.

**Decision — reproduce at the call-function level, do NOT launch DBOS to re-prove
retry.** A DBOS `runStep` retry is modeled by invoking the provider call function
TWICE over a *sequenced* injected fetch (shift-per-call + a call counter): call 1
consumes the bad response and throws; the classifier
(`retryUnlessPermanent`) says transient; call 2 consumes the good response and
returns cleanly — exactly the sequence `runStep` drives (invoke → transient throw →
`shouldRetry` → re-invoke). This is the whole app-owned seam.

**Why:** the deleted e2e uniquely proved the *"then-succeeds"* half (a re-invocation
after a classified-transient failure returns cleanly); the classification half was
already unit-covered. The `runStep` retry ENGINE (count/backoff execution) is the
DBOS SDK's own responsibility, covered by DBOS's tests — re-proving it in-process
needs `DBOS.launch()` + real Postgres (the exact e2e weight §10.6 removes). The retry
CONFIG values are pinned by `errors.test.ts` (`LLM_STRUCTURED_RETRY` maxAttempts 5;
`MEDIA_RETRY` maxAttempts 4).

**Trade-offs:** does not bit-for-bit re-prove the SDK's backoff mechanics — accepted;
that's DBOS's job, not this codebase's. Sufficient reproduction = classifier decision
+ constant values + sequenced-fetch call-function success-after-transient.

**Where the reproductions live (dbos repo `src/`, all GREEN — zero prod-behavior
delta; this was a test move):**
- 503-then-200 LLM retry (was generateScript e2e): `providers/generate-object.test.ts`.
- 503-then-200 speech retry (was generateAudio e2e): `providers/media-client.test.ts`
  (`requestSpeech`) + `providers/errors.test.ts` (`MEDIA_RETRY` constant).
- malformed→valid repair incl. exhaustion (was generateScript e2e): the pure loop is
  in `workflows/generate-script/repair.test.ts`; 34-E1 added an injected-fetch stitch
  there driving the REAL `callLlmStructured` through `runStructuredWithRepair` (attempt
  adapter mirrors the workflow: `NoObjectGeneratedError` → `{ok:false}`).
- controlled-timing video poll (already unit-covered via callback): pure loop in
  `workflows/generate-video/poll.test.ts`; 34-E1 added an injected-fetch block binding
  the real `getVideoJob` HTTP parse to `pollUntilComplete` (pending→in_progress→
  completed, terminal `failed`, bounded timeout).

**Sequencing helper convention:** each test file keeps its own tiny local closure
(shift over `Array<() => Response>` + counter); no shared cross-file helper. Mirrors
the repo's `fetchImpl?: typeof fetch` DI convention.

**e2e that REMAINS per workflow:** real happy path + crash/replay durability. The
generate-script crash/replay test still scripts a malformed→valid chat sequence via
`/__admin/chat-script` to reach a successful repair before parking at `persistResult`
— that is a durability proof, NOT failure injection; left as-is (34-E4 reworks it).
`global-setup.ts`'s `/__admin/chat-script`+`/__admin/speech-script` staleness probes
are NOT response programming — they die in 34-E8, not 34-E1.

**api repo: no failure-injection tests at all.** Provider-call retry/repair/poll is
dbos-workflow logic; the api repo only enqueues generations and its
`ai-generations.e2e.ts` drives stand-in workflows. 34-E1 needed zero api changes.
</content>
