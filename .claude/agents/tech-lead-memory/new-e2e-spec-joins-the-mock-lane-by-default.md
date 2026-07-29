---
name: new-e2e-spec-joins-the-mock-lane-by-default
description: nextjs's mock e2e lane includes tests/e2e/**/*.e2e.ts and excludes real-lane specs BY NAME, so a new real-stack spec silently joins the Docker-free lane — registering it takes two edits, not one
metadata:
  type: convention
---

In `supagloo-nextjs`, adding a `tests/e2e/*.e2e.ts` needs **two** config edits, not one:

- `vitest.e2e.real.config.ts` — add to `include`;
- `vitest.e2e.config.ts` — add to `exclude`.

The reason is asymmetric configuration. The mock lane's `include` is the broad glob
`tests/e2e/**/*.e2e.ts` and it names the real/render specs one by one in `exclude`. So a
new spec is **claimed by the mock lane by default** — it does not become an orphan.

That matters because the failure mode is the opposite of the one you brace for. Plan
row 41's guard (`tests/unit/e2e-lane-coverage.test.ts`) was written expecting a new spec
to belong to ZERO lanes; what actually happens is that a real-stack spec quietly joins
the **Docker-free, secret-free** lane, where `npm run test:e2e` would run it on every
machine and it would fail for an infrastructure reason in the one lane that must stay
green everywhere. Confirmed 2026-07-26 by `tests/e2e/gallery-watch.e2e.ts`: the guard
went red on *the mock lane holds exactly the Docker-free specs* (`9` vs `8`), not on the
orphan assertion.

The guard catches both, which is why it exists — but read its failure message before
assuming which edit is missing.

## No mock-lane spec can EVER reach an AI control (measured 2026-07-29)

Before planning a mock-lane spec, check whether the surface is behind `aiEnabled`.

`scene-inspector.tsx` computes `const aiEnabled = Boolean(project.manifest)`, and the mock
catalogue deliberately has **no manifest** — `lib/studio/project.ts` says so in a comment:
*"the manifest's PRESENCE is the studio's real-vs-mock mode signal"*, and
`app/studio/[id]/page.tsx` hands `findStudioProject(id)` straight to `<StudioApp>` on the
demo path. So `generate-scene-video`, `visual-card`, `narration-card`, the scripture picker
and every other AI testid **do not exist in the mock lane at all**.

This killed a planned `studio-video-warning.e2e.ts` (mock lane, 20b's confirmation dialog):
its very first act — click `▶ Generate video` — has nothing to click, and no amount of
seeding fixes it, because the absent manifest *is* the mock lane. The zero-egress guarantee
and the byte-exact 13b inspector assertions both depend on that gate staying shut.

The right home for "this dialog opens and nothing is spent" is a **jsdom mount test** under
`tests/unit/` with a real-project fixture (`tests/unit/studio-lock.test.tsx` does exactly
this for both 20a and 20b) — same zero egress, and it can drive the state a mock e2e cannot
construct. See [[nextjs-unit-lane-component-rendering]].
