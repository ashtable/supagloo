---
name: scaffold-project-workflow-built
description: Task 17 built scaffoldProjectWorkflow (first real git-ops DBOS workflow) — 8 self-healing steps, deterministic-commit crash-safety, cancel+resume crash test; the pattern the other git-ops workflows (18-22) follow
metadata:
  type: reference
---

Built 2026-07-19 (plan task 17). First REAL git-ops workflow after the noop proof
([[nodejs-dbos-bootstrap]]). All in canonical `supagloo-nodejs-dbos` only — db-lib,
api, and the root stubs were NOT touched. Plan doc:
`scratch/task-17-scaffold-project-workflow.md`.

**Shape.** `src/workflows/scaffold-project.ts` registers `scaffoldProject` (queue
`git-ops`) with 8 named `DBOS.runStep`s row-for-row with the job-stage log:
mintInstallationToken → ensureRepoAccessible → cloneToWorkspace →
writeRemotionScaffold → commitBaseVersion(v0.0.0) → pushOpenMergeBasePr →
cutWorkingBranch(v0.0.1) → finalizeRecords. Helpers under
`src/workflows/scaffold-project/`: `git.ts` (execFile git CLI — house style, zero
git npm deps), `workspace.ts` (self-healing clone/scaffold/commit/branch),
`github-rest.ts` (fetch — reachability/PR open/merge), `stages.ts` (stage catalogue
+ pure `mergeStage` + `markStageDone`), `finalize.ts` (Prisma upserts), `config.ts`
(app-level GitHub config holder, injected at launch like `app-db.ts`). workflowID =
`ProjectJob.id`; everything else rides the payload (installationId is per-user, the
scaffold manifest is generated — neither is in the DB).

**THE crash-safety gotcha (reusable for every git-ops/render workflow):** the local
clone lives in an EPHEMERAL temp dir that does NOT survive a worker restart, but
DBOS checkpoints step RESULTS — on recovery completed steps are skipped even though
their filesystem effects are gone. Fix = **self-healing + deterministic rebuild**:
every FS-touching step rebuilds exactly the local state it needs from the durable
remote (`ensureClone`/`ensureScaffold`/`materializeBaseVersion`, idempotent), and the
base commit is **byte-deterministic** (fixed identity + fixed `GIT_AUTHOR_DATE`/
`GIT_COMMITTER_DATE` + fixed message ⇒ identical SHA on re-run given the same
remote-fetched parent), so a rebuilt v0.0.0 re-pushes as a clean no-op consistent
with the SHA the checkpointed `commitBaseVersion` already recorded. Workspace path is
deterministic `os.tmpdir()/supagloo-scaffold/<workflowId>`; removed in finalize.

**At-least-once side effects.** Push = re-push same SHA ⇒ "up-to-date". Merge = stub
returns 405 on double-merge ⇒ treated as idempotent already-merged. **PR-open is NOT
idempotent vs the task-9 github stub** (no "get PR by head" route; always 201s a new
PR) — production is saved by GitHub's 422-already-exists (the helper resolves the
existing PR via GET), the stub is not. So the crash test crashes at a step BOUNDARY
before the push step so it runs exactly once.

**Crash/replay test pattern (in-process, deterministic):** a module-level DI seam
`__setBoundaryHook` (undefined in prod = no-op) that the workflow BODY awaits before
each step. Test: set the hook to park at the boundary before `pushOpenMergeBasePr`
(after commit checkpoints); enqueue; on "reached" → `DBOS.cancelWorkflow(jobId)`
(preempts at the next DBOS call ⇒ push never runs), `rm -rf` the workspace (simulate a
fresh worker), release the barrier, await the cancelled terminal state; then clear the
hook and `DBOS.resumeWorkflow(jobId).getResult()`. Asserts `pullsOpened==1`,
`pullsMerged==1`, `installationTokensIssued==1` (completed mint not re-run). The
`reached` gate + a `pullsOpened===0` pre-resume assertion make it a REAL crash proof,
not a false positive. (DBOS 4.x: `cancelWorkflow` preempts at next DBOS call;
`resumeWorkflow` restarts from last completed step — both worked in-process.)

**git flow (correct vs BOTH stub and real GitHub):** precondition repo has `main` +
initial commit (real GitHub `auto_init`; e2e seeds the git-server repo the same way).
clone→scaffold→`checkout -b v0.0.0`+commit→push v0.0.0→REST open PR(head=v0.0.0,
base=main)→REST squash-merge→`checkout -b v0.0.1 v0.0.0`+push. We do NOT push `main`
ourselves (real GitHub's API merge already moved it; the stub's merge is REST-only
bookkeeping — task-9 deferred wiring it to the backing repo). v0.0.1 is cut from the
LOCAL base tree (content-identical to merged main) so it works even though stub-main
never moves.

**Decisions worth remembering.**
- `ensureRepoAccessible` reuses the EXISTING stub `GET /installation/repositories`
  (auth: minted `ghs_` token) + Link pagination, finding `owner/repo`; absent ⇒ typed
  non-retryable `RepoUnreachableError`. Rejected adding `GET /repos/:owner/:repo` to
  the stub (cleaner real-GitHub check but edits the ROOT repo — out of task-17 scope).
- New env var `GITHUB_GIT_BASE_URL` (prod `https://github.com`, stub the git-server) —
  DBOS-only (the API never clones); `GITHUB_OAUTH_BASE_URL` can't double as it because
  in test it points at the REST stub, not the git-server. Plus `GITHUB_API_BASE_URL` +
  required `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` (verbatim api names). Making the
  App vars required broke the noop e2e's `loadEnv` — the worker's env contract grew, so
  every e2e that calls `launchDbos` must now supply them.
- **`ProjectJob.stages` shape + Zod schema kept LOCAL in dbos** (not promoted to
  db-lib) — task 17 is dbos-only and the API-side seeding (task 18 enqueue) doesn't
  exist yet. **TODO task 18: promote the stage catalogue to db-lib as the shared
  API↔DBOS contract.** ([[in-flight-dblib-e2e-constraint]] avoided by keeping it local
  + running the e2e in-process against the `file:` db-lib.)
- Dockerfile RUNNER stage needed `git` added (was only in the `deps` stage) — the
  workflow shells out to `git` at runtime.
- `Prisma.InputJsonValue` won't accept `JobStage[]` (no index signature) — cast via a
  `toJson()` helper (`as unknown as Prisma.InputJsonValue`).
