---
name: generate-video-workflow-built
description: task-34 built generateVideo — the async submit/durable-poll/download workflow + the flagship crash-replay proof; wired the LAST AI kind
metadata:
  type: context
---

Task #34 (Step 6) built `generateVideoClipWorkflow` — the FIRST async-job / `DBOS.sleep`
durable-poll / crash-replay media workflow, and wired `video` (the LAST unwired AI-generation
kind — `AI_GENERATION_WORKFLOW_BY_KIND` is now complete over all six kinds). Design-delta §7
workflow 8. Builds on [[generate-image-workflow-built]] (media-workflow template + boundary hooks
+ bytes-never-checkpoint fold), [[generate-audio-workflow-built]] (kind wiring + companion
layout), [[provider-call-layer-built]] (the already-built `submitVideoJob`/`getVideoJob`/
`getVideoContentUrls`/`downloadBytes` primitives).

**5 DBOS steps** (`generate-video.ts`): loadRequestAndCredentials → **submitVideoJob** (persists
`providerJobId` in the SAME step + `Idempotency-Key: genId` header — the replay-safety crux) →
**pollVideoJob** (bounded durable-sleep loop) → **downloadAndUploadVideo** (folds
download+upload; MP4 bytes never checkpointed) → persistResult. Writes ONLY the `AiGeneration`
row (status + `providerJobId` col + `resultAssetKey` + `resultJson {kind:"video",providerJobId}`).

**The durable-sleep poll loop** (net-new; `grep DBOS.sleep src` was empty before this):
- Extracted PURE as `generate-video/poll.ts` `pollUntilComplete(deps)` with injected
  `poll`/`sleep`/`onBeforePoll` — the workflow passes `DBOS.runStep(getVideoJob…)`, `DBOS.sleep`,
  and its boundary hook. The tested logic IS the prod logic. Calling `DBOS.runStep`/`DBOS.sleep`
  from an awaited helper on the workflow's call stack is VALID (workflow context, ALS propagates).
- `DBOS.sleep(ms)` takes MILLISECONDS (not seconds), is durable/checkpointed. Loop is
  deterministic (sequence `[poll,sleep,…,poll]` driven by checkpointed poll results).
- `classifyVideoStatus`: completed/succeeded→done; failed/error/cancelled→fail-fast; everything
  else incl. UNKNOWN→keep polling (bounded). Terminal errors `VideoJobFailedError` /
  `VideoJobTimedOutError` (both PERMANENT → mark row failed), thrown from the workflow BODY.
- **Bound (design pinned none — my judgment call, like task-30's "max 3"): default 40 attempts ×
  30s = 20-min ceiling.** Both env-overridable: `VIDEO_POLL_INTERVAL_SECONDS` (default 30) +
  `VIDEO_MAX_POLL_ATTEMPTS` (default 40), injected via a dedicated `generate-video/config.ts`
  singleton (one-singleton-per-concern discipline). The e2e drops the interval to 0.05s.

**Crash/replay (flagship):** the submit STEP is memoized on replay, so `submitVideoJob` HTTP is
NOT re-issued → the stub `videoJobsCreated` counter stays 1. Idempotency-Key is defense-in-depth
for the crash-MID-step case (stub returns same job for a repeated key without incrementing).
`generate-video.e2e.ts` parks the `__setGenerateVideoBoundaryHook` at the FIRST `"pollVideoJob"`
label, `DBOS.cancelWorkflow` → `DBOS.resumeWorkflow`, asserts `videoJobsCreated===1` after replay.
Adapts `scaffold-project.e2e.ts` lines 239–308.

**db-lib:** `GENERATE_VIDEO_WORKFLOW_NAME="generateVideo"` + `video` map entry;
`GenerateVideoInputSchema` (camelCase domain: `prompt` required + optional durationSeconds/
resolution/aspectRatio/frameImages/generateAudio/seed, `.passthrough()`) — a pure
`generate-video/submit.ts` `buildVideoSubmitInput` maps camelCase→OpenRouter snake_case at the
wire (mirrors audio's buildSpeechArgs); `GenerateVideoPayloadSchema`. **Removed
`MediaGenerationInputSchema`** (video was the last placeholder — grep-confirmed no consumer).

**API:** kind-agnostic src (no change) — only TEST flips + a stand-in `generateVideo` worker. Every
real kind is now wired, so the service-level 501 path is unreachable via a real kind — the
`UnsupportedGenerationKindError` guard is now covered by `workflow-lookup.test.ts` with a SYNTHETIC
kind cast (`"hologram" as AiGenerationKind`).

**Red→Green split** (the standard [[in-flight-dblib-e2e-constraint]] window; task prompt deferred
the release + submodule bump): db-lib FULLY green in-sibling (323 tests) + builds. dbos/api: pure
units green NOW (poll/submit/errors 17 tests); the tests importing the NEW db-lib exports
(`request.test.ts`, `registry.test.ts`; api `workflow-lookup`/`service` video-wired) are RED purely
on the missing nested-submodule export until the (later) release+bump. `tsc` in dbos shows EXACTLY
5 errors, all the missing exports — no logic errors. NO regressions. Left uncommitted.

Scratch plan: `scratch/task-34-generate-video-clip-workflow.md`.
