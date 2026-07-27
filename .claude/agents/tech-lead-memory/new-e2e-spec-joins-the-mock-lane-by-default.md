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
