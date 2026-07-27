---
name: a-publishing-e2e-frees-its-own-render
description: How the 16b e2e gets a publishable render with zero seed-helper change, and why a leaked published row does not merely survive teardown — it rolls the whole teardown back
metadata:
  type: convention
---

`gallery-watch.e2e.ts`'s `publish to the gallery` block (slice C8) publishes for real. Two
mechanics worth reusing.

**Getting a publishable render without touching the root seed helper.** Every seeded
`RenderJob` already has a `GalleryItem`, and `GalleryItem.renderJobId` is `@unique`, so
none of them is publishable as seeded. Instead of teaching
`tests/support/gallery-e2e-seed.mjs` to emit a spare, the spec frees one through the
shipped product: `DELETE /v1/gallery/:id` as the owner releases the unique slot and
explicitly does **not** reclaim the S3 objects. That is exactly the un-publish →
re-publish cycle the api's own `already_published` docblock documents, so the spec
exercises a real product path rather than a fixture shortcut.

Pick a **filler** item, never one of the four anchors — the anchors are what make the
three sorts produce three different leaders (`ANCHORS` in the seed helper).

Sign in as a fixture **author** (`fixtures.users[0].sessionToken` planted as the session
cookie), never the `?seed=authed-returning` viewer: the viewer owns votes, not projects.

**A leaked published row does not merely survive teardown — it BREAKS teardown.** The new
item carries a server-minted cuid, which `clearGalleryFixtures()` cannot recognise. Worse,
its `renderJobId` FKs the fixture `RenderJob` that teardown is about to delete, so one
leftover row makes the delete transaction violate the FK and **roll back — nothing is
cleaned up at all**, and the next run's `assertNoForeignGalleryItems()` throws about
something unrelated.

So: track every published id in a module-scope `Set` **the instant the watch-page URL is
known, before any further assertion**, and drain it in the FILE-level `afterAll` (not the
describe's, so a failure anywhere still tears down) **before** `clearGalleryFixtures()`.
Delete through the product's owner-scoped `DELETE /api/gallery/:id`, called from **Node**
with a `cookie:` header rather than in-page — teardown must not depend on a browser that
may already be gone.

**Proof, not intent:** run the spec twice back to back. Done 2026-07-26 — both runs
19/19, and afterwards `GalleryItem` = 0 rows, `GalleryUpvote` = 0, and zero
`e2e-gallery-%` rows in `RenderJob`/`Project`.

**Manufacturing a FAILED listing (E-GU15).** Stagehand v3 is a CDP understudy: no
Playwright `route()`, and no way to remove an init script once added. So the error-state
case installs a `context.addInitScript` `window.fetch` shim that fails exactly **one**
`/api/gallery` request per page load — which also makes `Try again` a real recovery rather
than a second red — and it must be the **last describe in the file**, because the shim
cannot be uninstalled.

Related: [[a-spec-that-writes-to-a-global-surface-owes-teardown]],
[[gallery-e2e-seed-helper]], [[documented-gate-must-be-the-gate-that-runs]].
