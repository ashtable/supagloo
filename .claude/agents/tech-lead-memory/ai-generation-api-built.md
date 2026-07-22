---
name: ai-generation-api-built
description: Task 31 built the AI-generation API surface in supagloo-nodejs-api — POST /v1/ai/generations (matrix-422 + unwired-501 + kind-specific input), GET /:id, GET /v1/projects/:id/generations, POST /:id/cancel — plus the shared db-lib compatibility matrix + wire DTOs
metadata:
  type: reference
---

Built 2026-07-22 (plan task 31, M5). Plan doc:
`supagloo/scratch/task-31-ai-generation-api.md`. Depends on [[projects-versions-read-crud-built]]
(task 14 ownership-scoping template) + [[generate-script-workflow-built]] (task 30 db-lib
AI contracts + the only wired generation workflow) + [[api-job-creation-polling-built]]
(the src/jobs/ module this mirrors) + [[dbos-static-workflows-and-enqueue-pattern]]. All
GREEN against the real, released, submodule-pinned db-lib (`7cc5748`).

**Scope = 4 routes** on the bearer `/v1` scope, new `src/ai/` module mirroring `src/jobs/`:
`POST /ai/generations` (create+enqueue), `GET /ai/generations/:id`,
`GET /projects/:id/generations`, `POST /ai/generations/:id/cancel`. `AiGeneration.id` =
DBOS workflow id; enqueue payload is the existing `GenerateScriptPayloadSchema`
(`{generationId}`); `workflowID = generationId`. The 409 git-ops guard does NOT apply
(multiple concurrent generations per project are allowed by design).

**db-lib additions** (`~/code/supagloo-database-lib`, released as PR #23 → main `7cc5748`,
next branch `v0.0.23`): `workflows.ts` — `AI_PROVIDERS_BY_KIND` (the kind→provider
compatibility matrix, a COMPLETE `Record<AiGenerationKind, readonly AiProvider[]>`:
storyboard/script → both providers, image/narration/music/video → openrouter ONLY per
§9-Q2) + `isProviderCompatible(kind,provider)`. `schemas.ts` — `CreateAiGenerationRequestSchema`
(a `z.discriminatedUnion("kind", …6 variants)`; text kinds carry the real
`GenerateScriptInputSchema`, media kinds carry `MediaGenerationInputSchema` =
`z.object({}).passthrough()` placeholder), `AiGenerationDtoSchema`, response/list/param
schemas. +21 db-lib unit tests (301 total).

**THREE distinct POST failure gates, distinct codes, ALL before row creation** (the key
design work — resolved the 3 open questions):
- **400** structural — the discriminated-union body schema validates kind + kind-specific
  `input` at the Fastify/Zod boundary automatically (unknown kind / malformed input / bad
  provider). No service branching.
- **422 `kind_provider_incompatible`** — SEMANTIC matrix check in the service
  (`isProviderCompatible` false, e.g. image+gloo). Deliberately NOT folded into the union,
  so it keeps its own status code. Permanent client error.
- **501 `generation_kind_unsupported`** — matrix-VALID but the kind's workflow isn't
  registered yet (image/narration/music/video today; only generateScript wired). A
  REACHABLE server-capability gap → 501 Not Implemented, deliberately DIVERGING from the
  git-ops `UnsupportedJobKindError`'s 500 (which is truly-unreachable because all git-ops
  kinds are wired). `resolveAiGenerationWorkflow(kind)` (src/ai/workflow-lookup.ts) throws
  `UnsupportedGenerationKindError` (501). Matrix (422) is checked BEFORE workflow-resolve
  (501) so image+gloo → 422 regardless of build state.

**Kind-specific input for the 4 unbuilt kinds = passthrough placeholder** (§Q4 decision):
inventing their real input contracts now would just force a rewrite in #32-34, and the
POST 501s them before their input is consumed anyway. #32-34 replace the placeholder
variants with real schemas.

**Ownership scoping** (§Q1): `GET /:id` scopes DIRECTLY on `row.userId === caller`
(AiGeneration has a userId column + nullable projectId, so project-scoping can't cover
project-less generations) → `AiGenerationNotFoundError` (404). `GET /projects/:id/generations`
scopes VIA the project (owner-checked, like listVersions) → 404, then lists ordered
`createdAt` DESC (id desc tiebreak; AiGeneration HAS createdAt, unlike ProjectVersion —
no semver sort), UNPAGINATED (consistent with listVersions). **POST with a projectId
verifies the caller owns it (404) BEFORE the matrix** — else a generation could be
attached to a foreign project and leak into that owner's list.

**Cancel semantics — API is AUTHORITATIVE for the row transition** (§Q2; no precedent
existed). generateScriptWorkflow deliberately does NOT write the row on cancel (task-30),
so if the API didn't flip it the row would stay running/queued forever. Flow: resolve
owner-scoped (404) → if TERMINAL (succeeded/failed/canceled) → **409
`generation_not_cancelable`** (uniform for all 3; chose 409-state-conflict over idempotent
no-op-200 — more informative) → else `cancel(id)` (DBOSClient.cancelWorkflow) FIRST, then a
CONDITIONAL `updateMany({where:{id,status:{in:["queued","running"]}}, data:{canceled}})`.
The conditional guard closes the cancel-vs-complete race (workflow wrote succeeded in the
window → update matches 0 rows → NO clobber); cancel-first-then-flip so a failed
cancelWorkflow can't leave a canceled row behind a live workflow. Re-read → return the
honest final state. **`makeDbosEnqueuer` gained a `cancel(workflowID)` method** (→
`client.cancelWorkflow`, confirmed in the installed SDK); the service takes injected
enqueue+cancel seams (recorders in unit tests).

**resultAssetKey surfaced as the RAW key** (nullable) on the DTO; the client presigns via
the EXISTING `GET /v1/files/presign-download?key=` (which ownership-scopes it). Keeps the
service a pure DB reader with ZERO S3 coupling (like ProjectJobsService). Always null for
anything this task can exercise (generateScript writes resultJson, not an asset). DTO omits
userId/providerJobId/input (lean status+result view like ProjectJobDto); resultJson +
tokenUsage are `z.unknown().nullable()` pass-through (verified they round-trip through the
fastify-zod v7 serializer).

**BLAST RADIUS of the submodule bump (important recurring gotcha):** the api submodule was
pinned at `ce2f0d3` (task 26), PREDATING task-30's §9-Q10 `TranslationSchema` broadening
(enum KJV/BSB → `z.string().min(1)`). Bumping to `7cc5748` pulled that in for the first
time, which flipped 2 pre-existing api jobs-module tests that asserted "NIV is rejected"
(`project-jobs-service.test.ts` boundary-reject + `project-jobs.test.ts` Zod-400). Fixed by
switching the invalid case to an EMPTY translation (`""` still fails `min(1)`), preserving
each test's intent. Lesson: a submodule bump can surface db-lib contract changes made in an
EARLIER task that never bumped this consumer — grep the consumer for now-stale assertions
(here `NIV`/`non-KJV`) after any bump.

**e2e** (`tests/e2e/ai-generations.e2e.ts`, 10 tests): reuses the barrier-gated in-process
stand-in-worker pattern from [[api-job-creation-polling-built]] — a STAND-IN `generateScript`
on the `AI_GENERATION_QUEUE_NAME` flips the AiGeneration row queued→running→succeeded +
writes resultJson/tokenUsage (real generateScript LLM behaviour stays proven by the dbos
repo's generate-script.e2e.ts). Cancel test: POST → hold at gate A (row stays queued) →
POST /:id/cancel → 200 canceled → GET canceled → re-cancel → 409; cancelWorkflow while the
stand-in is parked at a raw-promise gate works because the row flip is API-side (the parked
workflow throws DBOSWorkflowCancelledError at its next runStep on release). 422/501/404
tests assert NO row is created (count before/after). Project-less generations avoid needing
a GitHub connection (unlike scaffold); `seedProject` writes a Project row directly for the
project-scoped tests.

**api files:** `src/ai/{errors,workflow-lookup,dto,ai-generations-service}.ts` +
`src/routes/ai-generations.ts` (+ their unit tests + the e2e); `src/jobs/enqueuer.ts`
(+cancel); `src/app.ts` (`AiGenerationsDeps` + `aiGenerations?` option, registered in the
`/v1` block) + `src/server.ts` (build the service with `jobEnqueuer.enqueue`/`.cancel`).
**No new env vars, no new npm deps, no migration** (AiGeneration model already migrated).

**Final green:** db-lib 301 unit + typecheck + build; api 303 unit (+35 new, +2 rewritten
NIV) + typecheck + 56 e2e (10 files, +1 new). Dockerfile-pin guardrail green (submodule
gitlink `7cc5748` ↔ ARG in sync). NOT committed in the api repo (Step 7); db-lib released.
