---
name: a-silent-return-is-a-green-test-that-never-ran
description: E-SH2 guarded its whole body on `if (!process.env.X) return;` and vitest counted it green for three recorded 21/21 runs — plus the structural reason NO env-var project-slug fixture can ever work in these specs
metadata:
  type: context
---

Found 2026-07-30 in `supagloo-nextjs/tests/e2e/studio-hydration.e2e.ts`.

## The shape

```ts
const slug = process.env.SUPAGLOO_E2E_STUDIO_SLUG;
if (!slug) return;   // "documented skip"
```

A bare `return` is **not** a skip. Vitest reports it as a **pass**, so the lane's recorded
"21/21, reproduced independently three times" included a test that had never executed once.
The spec's own header claimed the lane proved "a committed edit survives a fresh re-open";
nothing had. Use `test.skip` / `test.todo` if you mean skipped — those are visible in the
summary; a `return` is indistinguishable from success.

The comment justifying it invoked "the release harness seeds/imports a populated-manifest
project". **No such harness has ever existed.** A precondition sourced from an imaginary
component is the tell: when a skip's justification names infrastructure, go look for it.

## Why NO cross-run project fixture can work in this repo's e2e

Structural, not a bug to fix:

- every api project read is owner-scoped — `where: { id, ownerId: userId }`;
- each spec seeds its user via `?seed=authed-returning&nonce=<RUN_ID>` with `RUN_ID` minted
  **at module load**.

So a project seeded by any earlier run belongs to a different owner *by construction*.
Measured: pointing the var at a real 5-scene fixture 404s, and because the 404 is the
deliberate ambiguous one ([[owner-scoped-404-is-ambiguous]]) it surfaces only as
`"script-input never appeared within 60000ms"` — no attribution at all.

**Consequence:** "reuse a pre-seeded project to save time" is unimplementable here. A spec
that needs a populated project must BUILD one in-run.

## The path that actually works

Three specs already do it, and it is the one to copy — `studio-model-cost` /
`studio-ai-generation` `openStudioWithScenes()`, `studio-replan-scripture` E-RS1:

1. `createProjectViaExistingEmptyRepo` (see [[real-github-e2e-harness]]);
2. `waitForTestId("studio-frame")` → click `generate-storyboard` → `script-input` (240 s);
3. **commit before doing anything else** — a generation writes into the WORKING manifest, so
   a just-generated storyboard leaves the project dirty. Skip this and any later
   `data-dirty === "true"` assertion passes vacuously on the storyboard's dirt.

It needs `connectOpenRouterViaProfile` in `beforeAll` (the `?seed=` user has no provider
connections; without it the worker throws `OpenRouterNotConnectedError` and the browser shows
only a 240 s `script-input` timeout). No Gloo unless the spec generates an image. Budget
900 s for create + generate + commit + a second commit + re-open.

**Sequel:** once it ran, E-SH2 failed — and the failure was its own, not the app's. See
[[two-entry-points-disagree-about-the-opening-scene]]. A test that has never executed has
also never had its assumptions checked, so budget for a second round after un-skipping one.

Cost is real — one throwaway GitHub repo and one live generation per run — so say it in the
comment rather than absorbing it, and do **not** reuse a sibling test's project to dodge it:
that couples two tests through a mutation the second one's body cannot see and turns any
flake in the first into an unattributable failure in the second.
