---
name: a-spec-that-writes-to-a-global-surface-owes-teardown
description: gallery.e2e.ts published dozens of real public items and deleted no rows — measured at 47 items / 46 matching the nextjs guard's exact predicate per run — which took down all 21 UI tests in another repo; user-scoped specs may leak, a spec that writes to an unscoped projection may not.
metadata:
  type: convention
---

Closed 2026-07-26 in `/Users/ash/code/supagloo-nodejs-api` (branch `v0.0.38`, revision W4).

## Why this one spec is different

Every other e2e surface in the api is scoped to a user, so a leftover row is invisible to
everybody else and the suites deliberately have **no** in-suite teardown (see
[[real-github-e2e-harness]] — that is a considered decision, not laziness).
`GET /v1/gallery` is not scoped: it is a GLOBAL projection of `visibility='public'`.

`tests/e2e/gallery.e2e.ts` creates its items by calling the REAL publish route, and its only
`afterAll` deleted S3 objects and closed the apps — **zero** row deletes. Measured by running
it with the new teardown disabled: **47 `GalleryItem` rows and 12 `GalleryUpvote` rows left
per run, 46 of them matching `visibility='public' AND id NOT LIKE 'e2e-gallery-%'`** — which
is character-for-character the predicate `assertNoForeignGalleryItems()` throws on in the
nextjs UI spec's `beforeAll`. One api run therefore took down all 21 UI tests in another
repo, with a message that read like the developer's own database was dirty.

**Fix the producer, not the guard.** The guard is correct and stays loud.

## The teardown rules that matter

- **Delete by TRACKED ID, never by pattern.** A pattern eventually matches somebody else's
  row, and a spec must not be able to delete data it did not create. Proven: seed the root
  harness's 28 `e2e-gallery-` fixtures, run the spec, and all 28 survive
  (`publicNonHarness = 0`, spec 31/31 green).
- **Match gallery items by their PARENT ids** (`renderJobId` / `projectId` / `ownerId` in
  the tracked sets), not by a list of item ids: items are created by the real route from
  several call sites, and a hand-kept item-id list is one forgotten `push` away from
  leaking again.
- **Every step is independently try/caught.** Teardown that stops at the first failure
  leaves a PARTIAL delete, which is the exact broken state it exists to prevent.
- Explicit child→parent order (`GalleryUpvote → GalleryItem → RenderJob → ProjectVersion →
  Project → Session → User`) even though every FK in the schema is `onDelete: Cascade` —
  it deletes only what the spec is accountable for and does not depend on a schema property
  a migration could relax.
- **The acceptance test is running the spec TWICE back to back in one stack**, with no
  manual reset between. Both runs green + zero rows after is the proof.

Related: [[gallery-e2e-seed-helper]] (the root harness's own teardown, and why IT has one),
[[an-isolation-seam-can-hide-the-property]] (the other consequence of the listing being
global), [[gallery-backend-built]].
