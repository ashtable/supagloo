---
name: documented-gate-must-be-the-gate-that-runs
description: A LIKE-bounded DELETE is not the same gate as a reviewed predicate — select-then-filter-then-delete-by-id makes the JSDoc executable
metadata:
  type: decision
---

`tests/support/gallery-e2e-seed.mjs` (root) claimed in two JSDoc blocks that its teardown
"only ever touch[es] rows whose id passes `isGalleryFixtureId`" and that the gate is
"re-checked immediately before every DELETE". **Both were false.** All seven DELETEs were
`WHERE "id" LIKE $1`; `isGalleryFixtureId` was called only by `fixtureId`'s self-check and
the two S3 key filters. Fixed 2026-07-26 by strengthening the CODE, not the prose.

**The shape (reusable):** read `LIKE '<prefix>%'` candidates per table → filter every id
through the reviewed predicate in JS → `DELETE … WHERE "id" = ANY($1::text[])`. No DELETE
carries a `LIKE` predicate any more. `GalleryUpvote` is the one exception and it is a real
one: a vote the *product* cast has a cuid id, so the gate is applied to its `galleryItemId`
instead — still deleted by primary key.

**Why the pattern is genuinely weaker than the predicate.** `LIKE 'e2e-gallery-%'` also
matches `e2e-gallery-Mixed`, `e2e-gallery-a_b` and the bare prefix — ids the helper cannot
mint (closed `[a-z0-9-]` alphabet, non-empty suffix, case-sensitive). Proved against real
Compose Postgres: a hand-inserted `e2e-gallery-Mixed` User row **survived** teardown while
all 145 genuine fixture rows went. Under the old code it would have been deleted.

**Trade-offs:** seven extra SELECTs against a local DB (nothing); a SELECT→DELETE race
window that cannot occur (one transaction, and concurrent gallery specs are already
forbidden because the gate is prefix-wide rather than run-scoped).

**Testing a DB helper with no DB.** `PgClientLike` is structural, and the helper takes
`options.client`, so the whole teardown runs over an in-memory recorder that answers SELECTs
from a fixture list and reports `rowCount` from the id array a DELETE was handed. That is
what makes "the gate runs at the mutation site" an assertion instead of a comment —
`tests/unit/gallery-e2e-seed.test.ts`.

**One test had to be weakened to stay true.** "EVERY deleted id passes the gate" went red on
the product-created upvote — because that blanket claim is *not* what the design says. It
was rewritten as "every id-keyed DELETE" plus a separate test for the `galleryItemId` rule.
A guard that overstates the invariant gets weakened the first time it meets a real run;
state the exception up front. See [[a-test-that-claims-a-class-must-drive-the-class]].

Related: [[gallery-e2e-seed-helper]], [[real-github-e2e-harness]],
[[tests-that-hold-invariants-vs-shapes]].
