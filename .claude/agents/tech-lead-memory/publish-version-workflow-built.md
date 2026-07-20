---
name: publish-version-workflow-built
description: Task 22 built publishVersionWorkflow + POST /v1/projects/:id/publish — merge working→main, tag release, cut next version branch; the versioning model + reuse map
metadata:
  type: decision
---

Task #22 (M3, CLOSES the four git-ops kinds) built `publishVersionWorkflow` +
`POST /v1/projects/:id/publish { message }` across db-lib, dbos, api. Fourth git-ops
workflow, queue `git-ops`. Closest template was [[commit-version-workflow-built]] (task 21).

**7 stages** (each a named `DBOS.runStep`, row-for-row with `PUBLISH_STAGES`):
`mintInstallationToken → commitPendingChanges → pushBranch → openPullRequest →
mergePullRequestAndTag → cutNextVersionBranch → finalizeRecords` (markJobRunning is a
status flip, not a stage).

**THE versioning model (Model A — non-obvious; the 14a wireframe's literal numbers are
WRONG).** The CURRENT working version (`payload.semver`, e.g. 0.0.1) IS the version being
published: merge its branch → `main`, tag `refs/tags/v0.0.1`, flip that ProjectVersion row
`working → published`. The NEXT working version = `nextPatchVersion(all existing semvers)`
= bump the PATCH of the HIGHEST existing semver → 0.0.2 (imported free-form: highest
0.2.3 → 0.2.4). `main` always holds the latest published version; the user edits one version
ahead.
**Why:** design-delta §7 workflow 4 + the consolidated-research finalize semantics both
define Model A; the 14a wireframe ("editing v0.0.1 → tag v0.0.2 → cut v0.0.3") is
illustratively inconsistent and is NOT the contract — trust §7, not the mockup's per-version
strings. `nextPatchVersion` derives the next version NUMERICALLY (0.10.0 > 0.2.0), never a
hardcoded `v0.0.(n+1)`, because imported projects carry arbitrary semver.
**Trade-offs:** publish carries NO manifest (request is `{ message }` only — the working
manifest was already committed via prior commit calls), so `commitPendingChanges` is a pure
head-capture (no commit, no jobId-trailer needed — unlike commit). `cutNextVersionBranch`
clones `main` fresh and cuts the next branch from it.

**Reuse map (no reinvention):** `openPullRequest` (422→lookup) + `mergePullRequest`
(405→already-merged) + `GithubRestError` reused AS-IS from `scaffold-project/github-rest`;
`retryUnlessPermanent` + `NETWORK_RETRY` from scaffold; `cloneBranch` from commit; low-level
`git`/`revParse`/`pushBranch`/`checkoutBranch` from scaffold. The ONE new REST helper is
`publish-version/github-rest.ts`'s `createTag` (raw fetch POST `/repos/:o/:r/git/refs`
`{ref:"refs/tags/v<semver>", sha}`, **422-already-exists → idempotent** — the github-stub's
git/refs endpoint was pre-built, increments `refsCreated`).

**Stub decoupling (same as scaffold's base-PR merge):** the github-REST-stub "merge" does
NOT update the git-server's `main`, and the tag is a REST fiction (no real git tag on the
git-server). So the e2e asserts `pullsOpened/pullsMerged/refsCreated` counters + the
workflow's returned `tag` ref + the next branch's EXISTENCE (ls-remote), NOT tag/branch
content. Crash/replay e2e parks at the `mergePullRequestAndTag` boundary (AFTER
openPullRequest checkpointed) → resume proves `pullsOpened == 1` (no duplicate PR).

**finalizeRecords:** upsert working version → `published` (set publishedAt/prNumber/prUrl/
headCommitSha; UPDATE branch does NOT clobber changedFiles/commitMessage); upsert NEW
working version at nextSemver; `Project.currentBranch = v<nextSemver>`; job succeeded + 7
stages done. All idempotent (upsert-by-[projectId,semver]).

**API:** `createPublishJob` mirrors `createCommitJob` MINUS manifest validation — same
404/409(github)/409(no-working-version)/409(in-flight) guards, reuses existing error classes
(no new ones). `PublishVersionPayload` = `CommitVersionPayload` minus `manifest`. No api
e2e (proven by dbos e2e + api service unit — matches tasks 19/21).

**db-lib additions:** `nextPatchVersion` in semver.ts; `PUBLISH_STAGES` in job-stages.ts;
`PUBLISH_VERSION_WORKFLOW_NAME` + `publish` entry in `GIT_OPS_WORKFLOW_BY_KIND`;
`PublishVersion{Request,Response,Payload}Schema`. All four git-ops kinds now wired, so
`resolveGitOpsWorkflow` throws only for a bogus/cast kind.

**Gotcha carried forward:** the `dockerfile-database-lib-pin.test.ts` in BOTH dbos and api
was ALREADY RED before this task (submodule bumped to 87fa706 for Task #21 DTOs, but the
Dockerfile `ARG DATABASE_LIB_REF` lockstep update is a RELEASE-step job, not a feature-task
job). Verified pre-existing by stashing this task's changes. Not a regression — see
[[in-flight-dblib-e2e-constraint]].
