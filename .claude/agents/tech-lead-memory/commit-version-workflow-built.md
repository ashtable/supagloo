---
name: commit-version-workflow-built
description: Task 21 built commitVersionWorkflow + POST /v1/projects/:id/commit — the jobId-trailer idempotency for a non-deterministic commit
metadata:
  type: decision
---

Task 21 (M3) built the third git-ops workflow: `commitVersionWorkflow` (dbos) +
`POST /v1/projects/:id/commit { manifest, message }` (api), promoting the commit
contracts to db-lib. Persists an EDITED manifest onto the project's CURRENT working
branch and UPDATES the existing working `ProjectVersion` row IN PLACE (same semver, same
branch — NO version bump, NO branch change, NO PR; that is publish/task 22).

**THE crash-safety decision (the crux, and why this differs from scaffold/import):**
scaffold's commit is byte-DETERMINISTIC (fixed msg + fixed date ⇒ reproducible SHA ⇒
re-push is a no-op); import is read-only. Commit is NEITHER — it pushes a REAL commit
(user message + current time), so its SHA is not reproducible across re-runs. Idempotency
instead rides a **`Supagloo-Job-Id: <jobId>` trailer** embedded in the commit body — a
durable, self-describing key in git history. `cloneBranchShallow` uses **depth 2** (not 1)
so the tip's PARENT is present locally (needed for `git diff --name-status HEAD~1 HEAD` and
the replay check). Shallow single-commit fast-forward push over the git-http-backend server
works. `commitAndPush` (`commit-version/workspace.ts` → `commitBranch`) self-heals then
picks one of THREE cases: (1) HEAD already carries THIS job's trailer ⇒ a prior attempt
pushed but didn't checkpoint ⇒ no-op, changedFiles = HEAD~1..HEAD (the real set); (2)
working tree dirty ⇒ commit + push; (3) clean tree + not-our-trailer ⇒ a genuine no-change
commit ⇒ no-op, `[]` changed. Every path ⇒ at most ONE commit per job.

**Why:** cleanly separates "my own prior attempt already pushed" from "user committed an
unchanged manifest" without deterministic SHAs. NOT `baseHeadSha` optimistic concurrency
(that guards OTHER writers — DEFERRED); this guards only this workflow's own retry. The
per-project 409 git-ops guard remains the v1 serialization. See [[scaffold-project-workflow-built]].

**Trade-offs:** +1 fetched commit (depth 2); a machine trailer line in the commit message
(also aids "which job made this commit" debuggability).

Steps (stage keys = DBOS.runStep names): `mintInstallationToken → cloneBranchShallow →
applyManifest → commitAndPush → updateVersionRecord` (markJobRunning is step 0, not a
stage). Reuses task-16 `applyManifest` (full deterministic overwrite — hand-edits to
`src/scenes/*` NOT preserved), scaffold's `retryUnlessPermanent` + low-level `git()`
runner, and the generic stage helpers. `updateVersionRecord` upserts the working version
by `[projectId, semver]` and does NOT touch the Project row.

**API:** `createCommitJob(userId, projectId, req)` resolves the owner-scoped project + its
working `ProjectVersion` (on `currentBranch`) for the semver, defensively `.safeParse`s the
manifest (→ `CommitManifestInvalidError` 422; the route's Zod body schema 400s the same for
HTTP callers — non-KJV/BSB rejected at the boundary via the existing KJV/BSB-only
`ProjectManifestSchema`, NO enum expansion), then creates ONE `ProjectJob(kind=commit)` (no
txn) + enqueues `CommitVersionPayload` (carries branchName + working semver + manifest +
message). New errors: `CommitManifestInvalidError` (422), `NoWorkingVersionError` (409).
`resolveGitOpsWorkflow("commit")` now maps (only `publish` still throws).

**Replay proof split:** the hermetic `commit-version/workspace.test.ts` proves the trailer
idempotency (re-run against the advanced branch = no second commit); the e2e proves the
DBOS-level resume (park after commitAndPush → resume → still exactly one commit). See
[[in-flight-dblib-e2e-constraint]] — api/dbos ran in-process against the rsync'd local
db-lib. `authenticatedCloneUrl` is now copy #3 (scaffold/import/commit) — flagged for a
future extraction to `scaffold-project/git.ts`; not refactored here to avoid churn.

**Push-failure rollback (code-review fix, 2026-07-20):** `commitAndPush` is a
`NETWORK_RETRY` step, so a transient `pushBranch` failure makes DBOS re-invoke the SAME
step callback IN-PROCESS (plain retry loop, no crash/replay) against the SAME on-disk
workspace (`ensureCommitClone` only re-clones if the dir is GONE). The trailer idempotency
(`headCommitHasJobId` inspects only LOCAL HEAD) cannot tell "committed AND pushed" from
"committed but push failed" — so a left-behind local commit would make the retry hit Case 1
and falsely report "already pushed", writing a never-pushed SHA into `ProjectVersion` +
marking the job succeeded while the remote tip never moved (silent DB↔remote divergence,
worse than a double-commit because nothing errors). FIX (in `commitBranch`, Case 2 only):
capture `preCommitSha = revParse(HEAD)` before `commitWithMessage`, wrap ONLY the push in
try/catch, and on push failure `resetHard(path, preCommitSha)` (new helper in
`commit-version/git.ts`) before rethrowing — so the retry re-derives the dirty tree via the
idempotent `applyManifest` and correctly re-takes Case 2. Reset is scoped to push failure,
NOT commit failure (a failed `commitWithMessage` never made a commit). `commitBranch` gained
a `CommitBranchDeps { push? }` DI seam purely so the hermetic test can inject a throwing
push (no mocking lib — matches the hand-rolled-fake convention). Guard: don't "simplify" the
try/catch away.
