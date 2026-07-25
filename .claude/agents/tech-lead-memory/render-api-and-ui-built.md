---
name: render-api-and-ui-built
description: Tasks 37+38 built the render API (5 endpoints, api + db-lib DTOs) and wired the 14c overlay to real polling — the 12 recorded decisions, the stage-order design deviation, and the mock-path-preserved pattern
metadata:
  type: context
---

Tasks **#37 (render API)** and **#38 (render UI wiring)** were built together in one
Step-6 pass on 2026-07-24. Plan doc: `scratch/task-37-38-render-api-and-ui.md`.

## What shipped

**db-lib** (`src/schemas.ts`, released to `main` @ `c8c9880`) — seven render wire DTOs:
`CreateRenderRequestSchema`, `CreateRenderResponseSchema`, `RenderJobDtoSchema`,
`RenderJobResponseSchema`, `RenderJobListResponseSchema`, `RenderIdParamSchema`,
`RenderListQuerySchema`. No migration (RenderJob shipped with task 36's schema); no
`workflows.ts` change (`RENDER_WORKFLOW_TARGET` already existed — there is deliberately
**no kind→target map** for render, so the API imports the single constant directly).

**api** — new `src/renders/` module (`errors.ts`, `dto.ts`, `renders-service.ts`) +
`src/routes/renders.ts`, wired through `app.ts` (`RendersDeps`) and `server.ts`. Five
routes. `RendersService` takes four injected seams: `enqueue`, `cancel`,
`presignDownload`, plus `now`/`generateId`.

**nextjs** — `lib/api/contracts.ts` mirrors, `lib/studio/render-data.ts`, an extended
`lib/studio/render-model.ts`, six new reducer actions + `renderOutcome`, four BFF route
handlers, and a rebuilt `render-overlay.tsx` with two invented terminal states.

## The decisions worth remembering (full rationale in the plan doc)

- **`framesTotal` is created at 0, never estimated.** The API has no composition
  knowledge (the manifest lives in GitHub); the worker writes the real total at
  `bundleComposition`. The UI reads `framesTotal === 0` as INDETERMINATE. This forced
  fixing `renderPercent()`, which used to return **100** for a zero total.
- **`outputSpec` is re-nested on the wire.** The five columns stay flat in Postgres
  (design §2.7) but request and response both carry one `RenderOutputSpecSchema` object,
  so they cannot drift — the same argument task 36 made for the row columns.
- **`?mine=1` is a REQUIRED `z.literal("1")`.** There is no cross-user render listing, so
  a bare `GET /v1/renders` 400s rather than quietly returning the caller's own rows under
  a URL that reads like "all renders".
- **Download is a thin wrapper, not a second signer.** `GET /v1/renders/:id/download`
  delegates to the same `FilesService.presignDownload` as `/v1/files/presign-download`
  (which already ownership-scopes `renders/{id}/…` to `RenderJob.userId`). A render whose
  output is not ready → **404**, not 409: 409 is reserved for state conflicts on a
  *mutation* (cancel); a GET for a nonexistent object is a 404.
- **Cancel: DBOS `cancelWorkflow` FIRST, then a conditional `updateMany`** whose `where`
  excludes the three terminal statuses — the exact guard dbos's `markRenderCanceled`
  docstring was written for, so both writers are safe and a cancel racing a completion
  loses.
- **No render concurrency 409.** design-delta §8:1175 scopes the in-flight guard to the
  four git-ops endpoints; renders ride their own 1-worker queue.

## The design deviation: the 14c stage order is wrong in the wireframe

Wireframe 14c **and** the old `RENDER_STAGE_ROWS` said *bundle → synth*. The shipped
worker, design-delta §6c and `dbos/src/workflows/render.order.test.ts` all say
**synth → bundle** (Remotion snapshots `public/` assets at bundle time). The checklist
rows were **reordered to match the implementation**, keeping the designed copy verbatim —
a checklist that reports a false order is worse than a two-row wireframe deviation.
`renderStageRows(status, lastPhase?)` maps status onto a monotonic rank; a failure marks
the row it died in with `✕` (which is why `RenderState` carries `lastPhase`).

## Patterns worth reusing

- **The mock path was PRESERVED, not replaced** — same as tasks 27/28/35.
  `NEXT_PUBLIC_SUPAGLOO_DEMO=1` is on in `.env.local` and `studio-publish.e2e.ts`
  (E-RND1..4) drives the demo catalog through the fake ticker. `RenderState` gained a
  flat `mode: "mock" | "real"` discriminant; the ticker `useEffect` in `studio-app.tsx`
  now no-ops unless `mode === "mock"`. **Deleting the ticker tests would have deleted
  coverage of live, reachable behaviour** — so they were kept and the polled-fixture
  tests added alongside (a recorded deviation from the plan row's "replaces" wording).
- **The poll driver lives in `StudioProvider`, not `StudioFrame`.** The provider sits
  above the overlay and stays mounted, so "Run in background" (which only hides the
  overlay) cannot interrupt polling. This is the `confirmPublish` idiom, and it is a
  better altitude than the mock ticker's.
- **The api render e2e uses a STAND-IN render workflow** registered under the real
  `RENDER_WORKFLOW_NAME` on the real `render` queue at `workerConcurrency: 1`, driving
  the same row transitions and PUT-ing real bytes to MinIO. 7 specs in ~9 s, zero
  provider egress. The real Remotion render stays proven by dbos's
  `render.render.e2e.ts`. Reproducing a real render in the api repo would cost ~10 min
  for zero new information.
- **Two undesigned UI states were invented**: render-complete and render-failed, both on
  14a step-3's published-card bones (6 px gradient rule, Anton headline, Zilla body, 2-up
  outline+gradient row) — **with no green-check medallion**. The progress bar the user
  watched stays on screen frozen at 100 % as the receipt, and the four ✓ checklist rows
  already carry the success signal.
- **A completed render un-backgrounds itself** (`applyRenderJob`). The download CTA has
  nowhere else to live until task 41 ships "Your videos", and the 14c footer literally
  promises a notification that no designed surface provides.

## Step-11 review revisions (2026-07-24, same branch pass)

Four defects found in review and fixed on the same branches:

- **A `state`-read in-flight guard is ALWAYS wrong in a provider callback.**
  `startRender` opened with `if (state.render) return`. `startRender` is a function
  object created during a React render, closed over THAT render's immutable `state`
  snapshot; `onClose()`/`cancelRender()` only DISPATCH, so they can never clear it for
  the closure that reads it next. The failure card's `Try again ▸` (the only
  failure-recovery path) was therefore dead. **`flushSync`/unbatching would not fix
  this — it is closure capture, not batching.** Fix: a `RenderRunGate` in a `useRef`
  (`lib/studio/render-model.ts`, unit-tested U-RM20..23 — the nextjs unit config is
  `environment: "node"` with no jsdom, so the provider itself is not
  component-testable). Rules that are easy to get wrong: `finishRenderRun` must be
  CONDITIONAL on the run token (a late `finally` from an abandoned driver must not clear
  a newer render's gate), and `cancelRender`/`closeRender` must ALSO release — a
  cancelled poll loop lives for the full 30-minute budget, so a gate held there just
  trades one dead button for another. The run token also fences `renderOutcome` /
  `RENDER_DOWNLOAD_READY`, which (unlike `RENDER_POLLED`) carry no reducer id guard.
- **Ordering assertions need ONE shared timeline.** `renders-service.test.ts` recorded
  Prisma ops into `calls` but enqueue/cancel into private arrays, so neither
  write-before-enqueue nor cancel-before-write was actually observable; both "ordering"
  tests passed with the order inverted. The recorders now push `dbos.enqueue` /
  `dbos.cancel` / `s3.presignDownload` onto `calls`, and `at(calls, op)` THROWS on a
  missing op (`findIndex` → -1 makes `toBeLessThan` pass vacuously). Verified by
  actually inverting the implementation three ways.
- **`expect(x).not.toEqual(expect.arrayContaining([a,b,c]))` is not "contains none of".**
  `arrayContaining` requires ALL members, so the negation passes when ANY one is absent —
  the cancel race-guard test would have let `completed` leak into the cancelable set.
  Use an exact sorted-set comparison (and `CANCELABLE_RENDER_STATUSES` is now exported
  for that).
- **`studio-render-real.e2e.ts`'s zero-egress claim was false.** It said the manifest
  carries cached audio refs; every test there creates a FRESH project, so the manifest is
  `buildBlankManifest()` (`scenes: []`, no `narratorVoice.assetKey`, no `music`). Egress
  is zero because dbos `render/audio.ts` `planAudioTrack` resolves BOTH plans to
  `skipped` on a blank manifest. Flip side, now documented in the spec: a zero-scene
  manifest generates `durationInFrames={1}`, so the spec proves the plumbing (clone →
  install → bundle → encode → upload → presign) over an empty frame and never exercises
  the `cached` audio branch.

See [[render-workflow-built]] and [[render-workflow-gotchas]] for the task-36 worker this
API enqueues into, and [[in-flight-dblib-e2e-constraint]] for the pin discipline that
unblocked the api repo here.
