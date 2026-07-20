---
name: api-job-creation-polling-built
description: Task 18 built the API job-creation + polling surface — POST /v1/projects (create + scaffold enqueue) + GET job polling, the static kind→workflow lookup, the reusable 409 git-ops guard, and the API↔DBOS contract promoted to db-lib
metadata:
  type: reference
---

Built 2026-07-19 (plan task 18). Plan doc:
`scratch/api-job-creation-and-polling.md`. Depends on [[projects-versions-read-crud-built]]
(task 14 read/mutate surface) + [[scaffold-project-workflow-built]] (task 17 workflow)
+ [[dbos-static-workflows-and-enqueue-pattern]]. First task where the API ENQUEUES a
DBOS workflow. All GREEN: db-lib 218 unit (+23), dbos 94 unit + 4 e2e, api 199 unit
(+21) + 34 e2e (7 files). Not committed (later step).

**Scope = two routes only** on the `/v1` bearer scope: `POST /v1/projects` (create
Project + scaffold ProjectJob → enqueue) and `GET /v1/projects/:id/jobs/:jobId` (stage
polling). Only `scaffold` is wired to a real workflow; import/commit/publish endpoints
are tasks 19/21/22.

**The API↔DBOS contract was PROMOTED to db-lib** (the API has NO source dep on the dbos
repo, so a shared home is the only way to keep them in lockstep — this is what makes the
"shared fixture" real). New db-lib modules:
- `src/workflows.ts`: `SCAFFOLD_PROJECT_WORKFLOW_NAME="scaffoldProject"`,
  `GIT_OPS_QUEUE_NAME="git-ops"`, `GIT_OPS_WORKFLOW_BY_KIND` (partial `kind→{workflowName,
  queueName}`, only `scaffold`; type extensible to the other 3 kinds).
- `src/job-stages.ts`: `STAGE_STATES`/`JobStage`/`JobStageSchema`/`JobStagesSchema`,
  `SCAFFOLD_STAGES` catalogue, `buildInitialStages(catalogue)` — promoted FROM the
  task-17 dbos-local home (the task-17 TODO). The DBOS-runtime-only helpers
  (`mergeStage`/`markStageDone`/`toJson`/`markJobRunning`) STAY in dbos `stages.ts`,
  which now re-exports the db-lib contract so task-17 import sites are unchanged.
- `src/manifest-defaults.ts`: `buildBlankManifest()` — production blank manifest,
  **default 1080×1920@30 9:16 (vertical short-form)** + "Calm, measured narrator", fresh
  object per call. FLAGGED: aspect/copy are product judgment calls (the dbos
  `emptyManifest` fixture is 16:9 — independent).
- `schemas.ts`: `CreateProjectRequestSchema` (`{name?, repoOwner, repoName, visibility,
  createdFrom}` — decomposes §6b's `repo`; name defaults to repoName),
  `CreateProjectResponseSchema` (`{projectId, jobId}`), `ProjectJobDtoSchema`,
  `ProjectJobParamsSchema`, and `ScaffoldProjectPayloadSchema` (the exact enqueue arg —
  dbos `scaffold-project.ts` now imports this type from db-lib instead of a local
  interface, re-exporting it so its e2e import is unchanged).

**dbos edits (in-scope, standalone repo):** `registry.ts` imports the two name
constants from db-lib (`WORKFLOW_NAMES.scaffoldProject`/`WORKFLOW_QUEUE.scaffoldProject`
sourced from them; the existing `satisfies` gives the cross-check for free); `stages.ts`
gained `markJobRunning(prisma, jobId)` (status-only flip to `"running"`);
`scaffold-project.ts` gained a `markJobRunning` `DBOS.runStep` as STEP 0 (before
mintInstallationToken) so polling observes queued→running before any stage completes —
NOT a stage entry (`SCAFFOLD_STAGES` stays 8). Crash/replay e2e unaffected (step 0
checkpoints; the boundary hook ignores the new `"markJobRunning"` label).

**Create-path design (documented judgment calls):**
- **One repo ↔ one project**, dedup keyed on `(ownerId, repoOwner, repoName)` NON-deleted
  (NOT slug — two repos can slugify equal). Slug = `slugify(repoName)` with `-2/-3`
  suffixing only for the rare cross-repo slug collision (checked against ALL owner slugs
  incl. soft-deleted — the unique constraint ignores `deletedAt`).
- **THREE distinct 409s, distinct wire `error` codes** (the research's explicit warning):
  no GitHub connection → `github_not_connected` (reuses `GithubNotConnectedError`);
  existing project with a `queued`/`running` job → `git_ops_in_flight`
  (`assertNoInFlightGitOps` — the REUSABLE guard tasks 19/21/22 call with their `:id`);
  existing terminal-only project → `project_exists`. The latter two together give
  "duplicate POST doesn't double-enqueue" at the HTTP layer.
- `createdFrom=import` → 400 `unsupported_created_from` (import uses task-19
  import_verify, not scaffold — scaffolding would overwrite the imported repo). For
  task 18 all scaffold-eligible createdFrom seed the BLANK manifest (content generation
  is later).
- **Transaction + enqueue-after-commit**: `Project.create` + `ProjectJob.create` in one
  `prisma.$transaction`; `enqueue` AFTER commit. KNOWN GAP (documented, not compensated):
  if enqueue throws post-commit the job is stuck `queued` — a re-enqueue with the same
  `workflowID=jobId` is idempotent (DBOS attaches), so a sweeper/manual retry is safe.

**api files:** `src/config/env.ts` (+required `DBOS_DATABASE_URL`, postgres URL),
`package.json` (+`@dbos-inc/dbos-sdk@^4.23.6` — caret to match the dbos repo, NOT the
exact-pin rule which is Prisma-only), `src/jobs/{errors,workflow-lookup,slug,dto,enqueuer,
project-jobs-service}.ts`, `src/routes/project-jobs.ts` (`POST /projects` returns **201**;
coexists with task-14 `projects.ts` — different methods/paths under `/projects`),
`app.ts`+`server.ts` wiring. `makeDbosEnqueuer({systemDatabaseUrl})` = enqueue-only
`DBOSClient`, **client created LAZILY on first enqueue** (buildApp wiring never opens a
system-DB connection at import), `close()` on shutdown. The service takes an injected
`enqueue` seam (recorder in unit tests). Root `docker-compose.yml` api block gained
`DBOS_DATABASE_URL` (→ `supagloo_dbos`); test.yml api override inherits it.

**e2e pattern (reusable for tasks 19/21/22):** the API repo CANNOT import the dbos
workflow module and the containerized worker can't see uncommitted db-lib
([[in-flight-dblib-e2e-constraint]]), so `tests/e2e/project-jobs.e2e.ts` launches a
**minimal in-process DBOS worker registering a STAND-IN `scaffoldProject` on git-ops**
(`DBOS.launch()` is TEST-ONLY — production API never launches) alongside a real
`DBOSClient` enqueuer against the Compose `supagloo_dbos`. The stand-in flips the app-DB
ProjectJob row queued→running→succeeded via a two-gate barrier (module-level, like the
task-17 crash-test boundary hook) so all three states are observed deterministically and
a job can be HELD in-flight to fire the 409. `updateMany` (not `update`) so a synthetic
jobId with no row no-ops (used by the workflowID-idempotency probe). ASSUMES the root
Compose `dbos` container is NOT running (global-setup never starts it) — same assumption
the dbos repo's own e2e makes; a competing git-ops worker would break it. The REAL
scaffold workflow's git behaviour stays proven by the dbos repo's scaffold e2e.
GOTCHA: the GET response is the `{ job }` envelope (`{project}`/`{versions}` convention) —
the e2e helper must unwrap `.job`.
