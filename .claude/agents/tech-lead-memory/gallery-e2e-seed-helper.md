---
name: gallery-e2e-seed-helper
description: Root's gallery e2e seeding seam — why it has teardown when the GitHub harness has none, the id gate, the pg timestamp trap, and the real-MP4 requirement
metadata:
  type: decision
---

`/Users/ash/code/supagloo/tests/support/gallery-e2e-seed.mjs` (+ `.d.mts`) writes gallery
fixtures directly into Compose Postgres + MinIO for **nextjs's** row-41 Stagehand spec only.
The api's own `tests/e2e/gallery.e2e.ts` keeps using Prisma + the real publish route — this
helper must never become its shortcut.

**Why root and not nextjs:** nextjs has no db-lib, no Prisma and no `pg`; `/v1/test/seed`
stays users+sessions (§9-Q9); driving a real render would move the spec into the render lane.
Bare specifiers (`pg`, `@aws-sdk/client-s3`) resolve against the IMPORTING MODULE's location,
so root's `node_modules` serves a nextjs Vitest worker through the existing
`SUPAGLOO_ROOT_DIR ?? ../supagloo` dynamic-import seam. Same shape as [[real-github-e2e-harness]].

**Why it HAS teardown when `e2e-github-api.mjs` deliberately has none.** The GitHub harness
mutates the user's personal account and per-run repo NAMES isolate runs. Gallery rows have no
such isolation: `GET /v1/gallery` is the one endpoint not scoped to a user, so every run's
fixtures land in the SAME listing and leftovers rot the rank / pagination / search assertions.
Hence `seedGalleryFixtures` clears first (same transaction as the inserts) and
`clearGalleryFixtures` is exported for `afterAll`. Both are gated on
`GALLERY_FIXTURE_ID_PREFIX = "e2e-gallery-"` **in the primary key**, re-checked at the mutation
site — the same discipline as `isE2eRepoName`. The gate is prefix-wide, NOT run-scoped (prior
runs are what must go), so two gallery specs must never run concurrently against one database.

**Trade-offs:** a second place that knows the gallery table shape (mitigated: INSERT-only over
columns db-lib's `schema.test.ts` pins); the fixture cannot clean up a developer's real local
gallery rows, so `assertNoForeignGalleryItems()` exists to fail LOUDLY instead of flaking.

**Three traps this file encodes:**

1. **`pg` + `timestamp(3) WITHOUT TIME ZONE` shifts every date.** `pg` serialises a JS `Date`
   as local wall-clock + offset; the cast discards the offset, so Prisma reads it back as that
   wall time in **UTC**. West of UTC that lands `publishedAt` in the FUTURE, the trending
   expression's `GREATEST(…, 0)` clamps every row to age 0 and the trending sort collapses onto
   popular. Every timestamp crosses as an offset-free UTC string (`toPgTimestamp`).
2. **`upvoteCount` is backed by REAL `GalleryUpvote` rows, never a fabricated counter** — the
   product decrements only when it actually deleted a row, and `viewerHasUpvoted` reads the
   rows. An inflated counter makes un-voting look broken. This caps an item's votes at
   `userCount`.
3. **The MinIO objects must be real playable media.** `presignPublicKey` signs LOCALLY, so
   `stream-url` returns 200 whether or not the object exists — a missing/bogus object only
   surfaces as a `<video>` stuck at `readyState === 0`. A 1 745 B H.264 MP4 (moov before mdat)
   and a 637 B JPEG are base64-inlined; regeneration commands are in the file's JSDoc.

**Fixture shape:** 26 public + 2 unlisted items (public > `GALLERY_PAGE_SIZE` 24, the only way
"Load more" is reachable — page size is not a client parameter). Four hand-placed anchors make
`newest`, `popular` and `trending` produce three DIFFERENT leaders (D3's P5, end-to-end); the
two unlisted rows are adversarial (most-upvoted in the set) so a broken visibility filter takes
over the page instead of hiding. `expectedOrder` exposes only newest/popular — both pure data
facts — because naming a trending leader would mean re-implementing the gravity expression here.

Related: [[gallery-backend-built]], [[e2e-test-infra-conventions]], [[compose-infra-and-root-test-harness]].
