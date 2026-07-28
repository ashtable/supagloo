---
name: head-commit-sha-ahead-of-main-is-not-an-invariant
description: "workingRow.headCommitSha === (highest published ?? base).headCommitSha ⟺ nothing to publish" is sound after scaffold, an OBSERVATION after publish, and undefined for imports — so the Publish gate is three-valued and fails open
metadata:
  type: constraint
---

Task item 7 (2026-07-27) needed "are there commits ahead of `main`?" client-side. No server
field answers it; `ProjectVersionDto.headCommitSha` makes it *derivable*. Before building on
the derivation I read every writer of that column. **As a biconditional it is UNSOUND.**

| Case | Verdict |
|---|---|
| after **scaffold** | **sound by construction** — `scaffold-project/workspace.ts:262-271` cuts `v0.0.1` AT `pr.mergeSha` and `finalize.ts:43-82` writes that same value to the base row and the working row |
| across a normal **commit** | sound — `commit-version/finalize.ts:32-52` rewrites the working row's sha in place |
| after **publish** | **an observation, not an invariant.** `publish-version/workspace.ts:97-111` calls `checkoutBranch(path, nextBranch)` with **no start-ref** — the new working row gets whatever `main` pointed at when its depth-1 clone ran; `merge.mergeSha` is never passed in. Scaffold passes its ref, publish does not: that asymmetry IS the gap. A push to `main` in between, or a crash between step 5 and step 6, breaks the equality |
| **imported** projects | **no comparand at all** — `import-project/finalize.ts:39-60` creates exactly ONE row (`state:"working"`); no base row, no published row |
| both shas null | the column and the DTO are nullable; `null === null` would read as "nothing to publish" |
| stale DB | a commit whose push landed but whose row write exhausted its retries, or any push made outside supagloo (it is the user's own repo), reports a **false "nothing to publish"** — the dangerous direction |

## What that forces on the consumer

`lib/studio/top-bar-gates.ts#hasUnpublishedCommits` returns **`true | false | null`** and
the gate **fails open** on `null`. A Publish button a user cannot un-stick is worse than a
publish that reaches the server and gets the honest 422 it already gets. The one
wrong-blocking case left is escapable and the tooltip names the escape — *"Nothing new to
publish — commit a change first"* — because a commit rewrites `headCommitSha`.

Two details that are easy to get wrong:

- **Select the working row by BRANCH NAME, not by `state`.** The api resolves a publish
  target with `branchName === project.currentBranch` and **no state filter**
  (`project-jobs-service.ts:504-506`), and `studio-data.ts:192` seeds the studio's
  `versionBranch` from `ProjectDto.currentBranch`. A half-finalized publish leaves the row
  on the current branch marked `published`, and the server would still publish it. No
  `state === "working"` fallback: a list with no row for the editor's branch is the case
  where you know LEAST, so it must answer `null`.
- **Take the first `published` row in WIRE ORDER.** `listVersions` sorts by real
  `compareSemver` descending (`projects-service.ts:97-108`). Re-sorting lexically ranks
  `0.9.0` above `0.10.0`.

## The fix I deliberately did NOT make

The minimal way to make it a true invariant is to pass `merge.mergeSha` into `cutNextBranch`
the way scaffold passes `mergedBaseSha` into `cutWorkingBranchLocal`. **Rejected:** cutting
the next working branch from a possibly-stale merge sha would silently DROP a commit that
landed on `main` in between, whereas branching from `main`'s actual tip is correct git
semantics. Reshaping a git workflow to make a UI predicate exact is the wrong trade — the
server stays the authority, the button is a front door, and it says so.

Related: [[scaffold-merge-sha-fix-made-a-fresh-publish-impossible]],
[[publish-version-workflow-built]], [[commit-version-workflow-built]].
