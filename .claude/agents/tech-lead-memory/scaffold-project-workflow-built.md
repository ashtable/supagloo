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

> **UPDATE 2026-07-25 (task 62, design-delta §11): this workflow's e2e now runs against
> REAL github.com, and doing so exposed a real product bug in the idempotency path
> described just below.** `findOpenPrByHead` queried `?head=…&state=open`. On a
> retry/replay AFTER the base PR had been opened **and merged**, real GitHub 422s the
> re-open, the `state=open` lookup then finds nothing (a merged PR is `closed`), and
> `openPullRequest` re-throws it as a **PERMANENT** `GithubRestError` — killing a workflow
> that was in fact recoverable. Fixed: renamed `findPrByHead`, widened to **`state=all`**,
> pinned by 5 new unit tests. The stub never emitted 422, which is exactly why the path
> was believed production-only. **The same rule binds test code**: assertion reads always
> pass `state: "all"`, or a successfully-scaffolded repo reports zero PRs and the
> non-duplication assertion becomes a green lie. See [[real-github-e2e-harness]].

**At-least-once side effects.** Push = re-push same SHA ⇒ "up-to-date". Merge = 405 on
double-merge ⇒ treated as idempotent already-merged. **PR-open was NOT idempotent vs the
task-9 github stub** (no "get PR by head" route; always 201s a new PR) — production is
saved by GitHub's 422-already-exists, whose handler resolves the existing PR via a
`state=all` GET (see the update above; that lookup was `state=open` and permanently
broken until task 62). So the crash test crashes at a step BOUNDARY before the push step
so it runs exactly once.

**Crash/replay test pattern (in-process, deterministic):** a module-level DI seam
`__setBoundaryHook` (undefined in prod = no-op) that the workflow BODY awaits before
each step. Test: set the hook to park at the boundary before `pushOpenMergeBasePr`
(after commit checkpoints); enqueue; on "reached" → `DBOS.cancelWorkflow(jobId)`
(preempts at the next DBOS call ⇒ push never runs), `rm -rf` the workspace (simulate a
fresh worker), release the barrier, await the cancelled terminal state; then clear the
hook and `DBOS.resumeWorkflow(jobId).getResult()`. **Assertions since task 62 (the stub
counters are gone):** `countStepExecutions(client, jobId, "mintInstallationToken") === 1`
and `… "pushOpenMergeBasePr" === 1` (durability, from the DBOS system DB — one StepInfo
row per functionID, so an internal retry or a replayed resume cannot inflate it), PLUS
`listPulls({state:"all"})` returning exactly one PR with `merged_at !== null`
(non-duplication, read off real github.com). The pre-resume assertion is now the same
`listPulls({state:"all"})` returning `[]` — strictly stronger than the old
`pullsOpened===0`, because it observes the absence on the host that would actually hold
the side effect. The `reached` gate + that pre-resume read make it a REAL crash proof,
not a false positive. (DBOS 4.x: `cancelWorkflow` preempts at next DBOS call;
`resumeWorkflow` restarts from last completed step — both worked in-process.)

**git flow (verified against real GitHub since task 62):** precondition repo has `main` +
initial commit — the e2e's fixture repos are created with `auto_init: true` for exactly
this reason, and **the product's own create-new-repo path does NOT do this**, which is
plan row 63 (a real defect: `base: "main"` 422s on an unborn ref).
clone→scaffold→`checkout -b v0.0.0`+commit→push v0.0.0→REST open PR(head=v0.0.0,
base=main)→REST squash-merge→`checkout -b v0.0.1 v0.0.0`+push. We do NOT push `main`
ourselves (real GitHub's API merge already moved it; the stub's merge is REST-only
bookkeeping — task-9 deferred wiring it to the backing repo). v0.0.1 is cut from the
LOCAL base tree (content-identical to merged main) so it works even though stub-main
never moves.

**Decisions worth remembering.**
- `ensureRepoAccessible` uses `GET /installation/repositories` (auth: minted `ghs_`
  token) + Link pagination, finding `owner/repo`; absent ⇒ typed non-retryable
  `RepoUnreachableError`. **Because absence is PERMANENT, the e2e MUST gate on
  `waitForInstallationVisibility` before enqueueing** — a just-created real repo is
  visible to the installation but not instantly, and losing that race produces a
  non-retryable scaffold failure (task 62).
- New env var `GITHUB_GIT_BASE_URL` (`https://github.com`) — DBOS-only (the API never
  clones). It defaults to the real host and, since task 62, **nothing overrides it in any
  lane**; it used to point at the git-server in test. Plus `GITHUB_API_BASE_URL` +
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

**Post-review hardening (2026-07-19, applied to task-17 before merge — reuse for every
git-ops workflow 18-22):**
- **Credential redaction in the git wrapper.** Node's `execFile` rejection puts the
  full command line (incl. the `x-access-token:<token>@` clone/push URL) verbatim into
  `.message`/`.cmd`/`.stack` — a plaintext-token leak straight into DBOS's checkpointed
  error record + logs. Fix in `git.ts`: `git()` catches, runs `redactUrlCredentials()`
  (generic `/(:\/\/)([^/@\s]*)@/g` → keeps username, `:***@`; bare userinfo → `***@`;
  redacts EVERY occurrence, not keyed to the literal token) over message+stderr, and
  WRAPS into a fresh `GitCommandError` (NO `cause` — a cause would re-leak the raw
  stack). Tested hermetically with REAL git: `git clone <cred-url> <non-empty-dir>`
  fails BEFORE any network (destination-exists check) yet still carries the token in
  Node's error → asserts redacted.
- **Typed retry classification (the plan's promised `shouldRetry=false` on permanent
  failures).** `GithubRestError{status}` + `isPermanentHttpStatus` (4xx≠429 permanent;
  5xx/429 transient) thrown at the REST failure sites (422-already-exists /
  405-already-merged idempotent paths LEFT intact — not failures). `GitCommandError`
  carries a `permanent` flag from a conservative `isPermanentGitFailure` stderr matcher
  (auth failed / invalid creds / repo-not-found / permission denied / HTTP 401·403·404
  → permanent; DNS/connect/RPC/timeout → transient/retry). Composed predicate
  `retryUnlessPermanent` lives in the standalone `scaffold-project/retry.ts` (imports
  only the error types — cheap to unit-test WITHOUT importing the DBOS workflow module)
  and is wired into all 4 network/git steps (`ensureRepoAccessible` unified onto it too;
  its old inline `!(e instanceof RepoUnreachableError)` is a strict subset). Default for
  unknown/plain errors = transient, so nothing is marked permanent by accident.
