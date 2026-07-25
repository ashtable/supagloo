---
name: render-workflow-gotchas
description: Two verified gotchas from task 36 — DBOSWorkflowCancelledError never sets .name (so name-matching silently misses every cancel), and memoized steps + an ephemeral workspace require 4-level self-healing; plus the stale git-server fixture trap when the Remotion template changes
metadata:
  type: constraint
---

Verified 2026-07-24 against `@dbos-inc/dbos-sdk@4.23.6` and Remotion 4.0.490. Both were
found by the task-36 render e2e failing, not by reasoning.

## 1. DBOS cancellation errors do NOT set `.name`

`DBOSError` (the base class) never assigns `this.name`, so a real
`DBOSWorkflowCancelledError` arrives with `name === "Error"`. Matching a cancellation by
`err.name` therefore misses **every** real cancel — the symptom was a `RenderJob` row
stranded at `bundling` instead of flipping to `canceled`.

The reliable identity is the numeric `dbosErrorCode`: **24** = `WorkFlowCancelled`,
**27** = `TargetWorkflowCancelled`. Neither class is exported from the SDK's package
entry (only `DBOSWorkflowConflictError` is) and deep paths are blocked by `exports`, so
`instanceof` is not available — match structurally on `dbosErrorCode`, with
`constructor.name` / `name` as secondary signals.

Related: `DBOS.cancelWorkflow` **preempts only at the beginning of the NEXT step** — the
current step runs to completion. For a long step (a render, a big upload) that means
cancellation does nothing until the step finishes, so a long step must ALSO poll
`DBOS.getWorkflowStatus(id)` and abort cooperatively. And once the workflow is
`CANCELLED`, **no further `DBOS.runStep` can execute**, so a terminal "canceled" row write
must be a direct (non-checkpointed), idempotent, conditional DB write from the workflow
body.

## 2. Memoized steps + an ephemeral workspace ⇒ self-heal at every level

DBOS resumes at the first INCOMPLETE step, so a completed step's on-disk artifacts may be
gone while the step itself is never re-run. For `renderWorkflow` that meant
`bundleComposition` was memoized but its bundle directory had been deleted, and
`renderMedia` failed with Remotion's *"Tried to serve the Webpack bundle … index.html does
not exist"*.

The fix is a LEVELLED `ensure*` ladder, each level idempotent and rebuilt from durable
sources (git / registry / S3 / checkpointed manifest):
`ensureClonedWorkspace → ensureWorkspaceSources → ensureBundledWorkspace →
ensureRenderedOutputs`. `uploadOutputs` needs the top level — a crash between
`generateThumbnail` and the upload otherwise leaves nothing to read.

Accepted limitation, documented in the workflow: a genuine crash mid-`renderMedia`
re-executes the WHOLE encode. Remotion does not checkpoint partial frames and an encode
cannot be resumed.

## 3. Changing the Remotion template invalidates existing `v0.0.0` branches

`scaffoldProjectWorkflow`'s base commit is byte-deterministic. Changing any generated file
changes that SHA, so a git-server that still holds a repo scaffolded by the OLD template
rejects the new push as non-fast-forward. The scaffold e2e uses FIXED repo names
(`acme/empty-one`/`empty-two`), so it fails on a reused stack until the git-server is
recreated (`docker compose ... up -d --force-recreate git-server`). Production is
unaffected (scaffold runs once per repo, guarded by the task-18 dedup) — but expect it
whenever `src/remotion/templates.ts` changes.
