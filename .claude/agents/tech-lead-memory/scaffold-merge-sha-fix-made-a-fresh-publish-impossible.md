---
name: scaffold-merge-sha-fix-made-a-fresh-publish-impossible
description: dbos de745d2 (2026-07-27) cut v0.0.1 AT pr.mergeSha, so a freshly-scaffolded project has ZERO commits ahead of main — publishing one now 422s, which silently turned two real-lane e2e specs red
metadata:
  type: context
---

dbos commit **`de745d2` (2026-07-27)** — *"fix(scaffold): cut v0.0.1 from the merged base
tip, not the local v0.0.0"* — is correct and load-bearing (it fixed the divergence that made
every publish PR born `mergeable_state: "dirty"`). It also has a consequence nothing
recorded at the time:

> **A freshly-scaffolded project has NOTHING to publish.** `v0.0.1` is created at
> `pr.mergeSha`, byte-identical to `main`, and publish makes no commit of its own
> (`capturePublishHead` is a pure head-capture — `publish-version/workspace.ts:73-82`). So
> `openPullRequest` gets GitHub's **422 "No commits between main and v0.0.1"**.

Reproduced live on 2026-07-28 (`ProjectJob(publish)` in Postgres):

```
status = failed
error  = "open pull request failed: 422 — Validation Failed — No commits between main and v0.0.1"
```

Note the job DOES reach `failed` (it is not stuck at `running`), so the wizard shows an
error rather than spinning forever — the half of plan row 50(2) about publish is in better
shape than the row claims.

## The blast radius nobody noticed

Two real-stack e2e specs create a project and click Publish **immediately**:

- `supagloo-nextjs/tests/e2e/studio-publish-real.e2e.ts` `E-PUBR1` — its docblock still
  says "this lane RUNS and is GREEN — 21/21 … 2026-07-25", which PREDATES `de745d2`.
  **Rewritten 2026-07-28** to assert the truth (Publish disabled with the honest tooltip),
  then to seed one real commit through the app's own BFF routes and publish for real.
- `supagloo-nextjs/tests/e2e/studio-render-real.e2e.ts` (lane 3, heavy render) —
  `publishThenStartRender()` has the same shape and the same pre-existing failure.
  **Still open.**

## Why the fix is not "just commit first"

A freshly-scaffolded manifest has `scenes: []`, so the studio renders `<StudioEmpty />` and
there is **no `script-input` to dirty** — `studio-hydration.e2e.ts` already documents that
exact gap as its own skip reason. The way through is to seed one commit through the app's
OWN real BFF routes with the browser's session cookie (`GET /manifest` → add a scene →
`POST /commit` → poll the ProjectJob), the same "seed through the real routes" idiom
[[api-e2e-real-provider-connection-seeding]] uses. Not a stub: same api, same DBOS git-ops
worker, same github.com.

Related: [[head-commit-sha-ahead-of-main-is-not-an-invariant]],
[[publish-version-workflow-built]], [[scaffold-project-workflow-built]].
