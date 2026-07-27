---
name: gallery-making-of-snapshot
description: "Turn 16a's `GalleryItem.makingOf` — why the manifest is snapshotted ONCE at publish instead of read on the public watch page, what the snapshot deliberately does NOT carry, and the duplicated jsonb text rule"
metadata:
  type: decision
---

Built 2026-07-26 in `supagloo-database-lib` (branch `v0.0.34`), plan slice C1, migration
`20260727002708_gallery_making_of` — one statement,
`ALTER TABLE "GalleryItem" ADD COLUMN "makingOf" JSONB;`.

## The decision

The watch page's "HOW IT WAS MADE" section is fed by a **publish-time snapshot** of the
project's `supagloo.project.json`, stored on the row, **not** by reading the manifest when
the page is viewed.

**Why:**
1. A public, anonymous, crawlable route must not hold, mint or imply a GitHub installation
   token. The snapshot is written by the **authenticated owner**, who already has one.
2. Re-reading per view would show **today's** manifest under a video rendered from an
   older one — the subtler of the two lies.
3. The publish path's REQUIRED fields still come only from the request body; the snapshot
   is the one optional extra.

**Trade-offs:** publish gains a bounded GitHub round trip (so it is **best effort** — a
failed/missing/corrupt read leaves the column NULL and still returns 201), and the api's
zero-egress `gallery.e2e.ts` had to split so a real-GitHub spec owns the happy path. This
knowingly amends `gallery-service.ts`'s existing docblock, which argued *against* reading
the manifest at publish: two of its three objections do not apply to an optional snapshot
that joins **all** scenes rather than picking one of N.

## Shape, and the two deliberate absences

`GalleryMakingOfSchema` = `{ version: literal 1, capturedAt: ISO, scriptureText: string|null
(≤20 000), narratorVoiceLabel: string|null (≤120), musicStyle: string|null (≤120),
captionsOn: boolean, scenes: [{index ≥1, name ≤120, durationSeconds > 0}] (≤64) }`.

- **No visual-style field.** The design draws a `Cosmic visuals` chip; nothing in the
  manifest backs it (scenes carry a per-scene `visualPrompt`, which is a prompt, not a
  style). Chips render conditionally and that one is simply never emitted.
- **No per-scene image.** The design's scene tiles are deterministic gradients, so there
  is no asset key to snapshot and no presign-per-scene on a public page.

`version: z.literal(1)` **rejects** anything else, on purpose: without it a v2 snapshot is
half-read by a v1 reader (known fields parse, unknown ones strip) and the page renders a
confident lie. Rejecting is what lets a reader degrade to `null`.

**NULLABLE with no default** is load-bearing twice over: best-effort capture, and every
item published before the column existed. `null` means "we do not have this" permanently;
a `{}` default would erase that into "captured, and empty".

Bounds are **enforcement, not documentation** — the input is user-authored text from the
user's own repo. The builder (api slice C3) must **truncate** to fit (64 scenes, 120-char
labels); a snapshot that cannot satisfy the schema is dropped to `null`, never stored.

## The jsonb text rule, and why it is duplicated

`jsonbSafeText()` (private to `src/schemas.ts`) refuses C0 + DEL less tab/LF/CR, and
unpaired surrogates. **MEASURED** against Compose Postgres 17, 2026-07-26:
`SELECT ('{"a":"x' || E'\u0000' || 'y"}')::jsonb` →
`ERROR: unsupported Unicode escape sequence`. So an ungated NUL is a **failed publish
INSERT**, not a cosmetic problem.

It deliberately **duplicates** the api's `src/postgres-text.ts` class rather than importing
it: db-lib cannot import from a consumer, the api's module gates *request*-derived strings
at Fastify boundaries with 400 contracts, and this value is server-built from a repo file
and never crosses a request boundary. Both places enumerate the class in tests, so a change
to one is visible in the other. Contrast [[github-app-pem-normalization]], where three
undocumented copies of one rule was the defect.

## Consumer notes

- `GalleryItemDetailDtoSchema` = `GalleryItemDtoSchema` + `makingOf` (required-but-nullable)
  + `owner.publicVideoCount`. The **list** DTO is untouched — `publicVideoCount` is a
  `COUNT(*)`, and 24 cards would be 24 of them per page.
- `GalleryOwnerSchema` was extracted from the inline `owner` object so both DTOs provably
  share a base. No behaviour change.
- `Json?` makes the Prisma model KEY required and the VALUE nullable, so every row literal
  must state `makingOf: null` (this broke `tests/typecheck/models.type-assert.ts` until
  updated — which is the point: "no snapshot" is a decision, not a forgettable field).
- `GalleryItem` is now a **17**-column table; `src/schema.test.ts` pins that count.

## The api half (slice C3, `supagloo-nodejs-api`, 2026-07-26)

`src/gallery/making-of.ts` — pure `buildMakingOfSnapshot(manifest, now)`. Three steps in a
fixed order, and the order IS the design: **sanitize → truncate → validate**.

- `ProjectManifest` guarantees SHAPE and almost nothing about CONTENT — every display
  string is `z.string().min(1)`, so a scene name may be a lone NUL and `scriptText` may be
  a megabyte. Sanitize/truncate are the mechanism; the closing `safeParse → null` is the
  backstop. A builder that only degraded to `null` would satisfy "never writes an invalid
  snapshot" while deleting the section for anyone with a stray byte.
- **Truncating can CREATE the violation it is fixing:** `slice(0, 20000)` counts UTF-16
  code units, so a cut between the halves of an astral pair leaves a lone high surrogate
  that `jsonbSafeText` rejects. Sweep unpaired surrogates AGAIN after the cut.
- `index` is the tile number the design PRINTS, so an unusable scene leaves a GAP
  (1, 2, 4) rather than renumbering — the same rule the listing's `rank` follows.
- `captionsOn` = `scenes.length > 0 && every(...)`. `[].every()` is `true`, which would put
  a "captions on" chip under a video with no scenes.

**`Prisma.DbNull`, never a bare `null` and never `Prisma.JsonNull`.** A nullable `Json`
field rejects a bare `null` at the type level. `JsonNull` writes the jsonb SCALAR `null`
— indistinguishable from SQL NULL through the client, so only a test that asserts the
SENTINEL catches it — and it makes `WHERE "makingOf" IS NULL` skip the row, splitting "we
could not capture one" from "published before the column existed" into two stored values
of one fact.

**`getItem` returns the DETAIL DTO, so the vote routes pay a `COUNT(*)` too.** Accepted on
purpose: ONE read path means the detail response and the post-vote response cannot disagree
about an item. Their response schema is still `GalleryItemResponseSchema`, which STRIPS the
two extra fields — so a client must MERGE a vote response into a watch page's state, never
replace it. `U-GR14` pins the strip.

**`Promise.race` already attaches a reaction to every entrant**, so an abandoned read that
rejects late is a HANDLED rejection. The earlier claim that the pre-race `.catch` prevents
an `unhandledRejection` was wrong and a mutation test refuted it. The hazard belongs to the
OTHER shape — fire off `read().then(...)` and sleep — and `U-GS-MO3b` is a fence against
that shape, verified by rewriting the method fire-and-forget.

## The e2e split, and what each half may claim

- `tests/e2e/gallery.e2e.ts` stays **zero-egress / zero-credential** and owns the
  best-effort **null** branch (`E-G22`). It keeps that property because no fixture has a
  `GithubConnection`, so `ManifestService` raises before a socket opens — and its
  ManifestService is wired with a **throwing `getFileContents`**, so reaching GitHub would
  be a named failure rather than a silent call. (Same idiom as its throwing YouVersion
  verifier, one layer in.)
- `tests/e2e/gallery-making-of.e2e.ts` owns the real-GitHub happy path on task-62's
  fixture-repo harness. Four branches: `valid`, `other`, `mutable`, `badschema`. **No
  MinIO** — publish reads no S3 and every URL is signed offline.
- The sharp one is `E-MO2`: publish from `mutable`, then push a REAL second commit to that
  branch, then re-read. A recompute-per-view implementation returns the new text; the
  snapshot design returns the old. Two identical GETs would have proven nothing.
- Both publishing specs delete by **tracked id** (`id: { in: [...] }`), and the id is
  pushed BEFORE the first assertion so a failing expectation still cleans up. Proven by
  `galleryItem.count() === 0` after the runs, not by "the next run didn't complain".

Related: [[gallery-backend-built]], [[bound-is-not-safe-postgres-value-gates]],
[[one-rule-one-module-many-boundaries]], [[prisma-migrate-dev-blocked-by-dbos-table]],
[[a-spec-that-writes-to-a-global-surface-owes-teardown]],
[[real-github-e2e-harness]], [[manifest-read-built]].
