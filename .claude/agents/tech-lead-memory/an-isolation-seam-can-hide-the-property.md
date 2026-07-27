---
name: an-isolation-seam-can-hide-the-property
description: The gallery e2e isolated its fixtures with `?q=<nonce>` — so every listing it ever inspected was a FILTERED one, and its four `rank` assertions measured a position among search hits while three JSDocs promised a global ordinal; a property that is only true of the WHOLE population cannot be tested through the seam that narrows it.
metadata:
  type: constraint
---

Found and closed 2026-07-26 in `/Users/ash/code/supagloo-nodejs-api` (branch `v0.0.38`,
revision W2), on the third review pass of the gallery surface.

## The shape

`GET /v1/gallery` is the ONE endpoint in the system that is not scoped to a user, so
`tests/e2e/gallery.e2e.ts` scopes every deterministic assertion with a per-test
`?q=<nonce>` token baked into its fixtures' text. That is a good seam — it isolates a
global listing AND exercises the real free-text predicate at the same time.

It also meant **every listing the spec ever looked at was a filtered one.** All four of its
`rank` assertions (`[1]`, `[1..6]`, `[1..5]`, `[1,2,3]`) ran against a `q`-scoped listing.
The listing is ONE statement — the `q` ILIKE predicate sits in the same `WHERE` as the
`ORDER BY` and the `LIMIT` — so `startOrdinal + index + 1` is a position **among the hits**.
The tests passed *because* the population was narrowed, while three JSDocs and the UI's
trophy badge claimed a position in the global ordering. Typing anything into the gallery
search box badged the top match "#1".

The unit layer agreed with the e2e layer and neither agreed with the claim: U-GV10's fake
Prisma returns its `rawRows` verbatim, so it **cannot express filtering at all**.

## The rule

**A property that is only true of the whole population cannot be tested through the seam
that narrows the population.** When a spec has an isolation mechanism — a nonce, a tenant
id, a `q`, a per-run prefix — list the claims that are about the UNSCOPED thing, and give
them their own case that reads the unscoped thing.

Such a case cannot assert an exact page, so assert properties that survive foreign rows:

- compute each item's TRUE position with an INDEPENDENT query (`COUNT(*)` of the rows the
  same `ORDER BY` puts ahead of it) and compare the response's ordinal to that — never
  re-derive the expectation from the response being checked;
- seed a decoy that guarantees the inequality you care about (900 000 upvotes ⇒ the group's
  top hit is provably not #1 globally), then state the inequality as a MEASURED comparison
  rather than as an index;
- walk a page boundary on the unscoped listing to prove continuity there rather than across
  five search hits.

`E-G6b` in `tests/e2e/gallery.e2e.ts` is the worked example; it passes unchanged with 28
foreign public rows seeded by another repo's harness, which is the point.

## The fix, so it is not re-litigated

`rank` is now non-null only when `sort === "popular"` **and** the PARSED search term is
`undefined`. Parsed, not raw: a blank `q=` emits no predicate at all, and the nextjs model
always appends `q=`, so gating on the raw parameter would have dropped every badge in the
product. See [[gallery-backend-built]] and [[tests-that-hold-invariants-vs-shapes]].
