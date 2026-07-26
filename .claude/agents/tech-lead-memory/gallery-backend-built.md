---
name: gallery-backend-built
description: Tasks 39+40 built the gallery surface in supagloo-nodejs-api — the FIRST $queryRaw, the FIRST optionalAuth route, the FIRST ownership-free presign, and the keyset-cursor/trending-epoch/upvote-transaction decisions behind them.
metadata:
  type: context
---

Built 2026-07-26 in `/Users/ash/code/supagloo-nodejs-api` (branch `v0.0.38`). Seven routes,
five new modules under `src/gallery/`, one route file, four modified files. Green: typecheck 0,
unit 49 files / 603 tests, `tests/e2e/gallery.e2e.ts` 25/25 against real Postgres + real MinIO
with **zero provider credentials**.

## Four firsts, each with a decision attached

**1. The first `$queryRaw` in the api** (`src/gallery/gallery-query.ts`). ONE builder covers all
three sorts, because the cursor is a KEYSET predicate `(sortKey, id) < ($k, $i)` and Prisma's
`orderBy` + `cursor` cannot express that over a computed expression — two code paths would mean
two cursor implementations. Safety rules that must not erode: `sort` is a closed Zod enum and the
ORDER BY key comes from a fixed `Record<GallerySort, (epoch: Date) => Prisma.Sql>` map (a
deliberate deviation from the plan's bare `Record<GallerySort, Prisma.Sql>` — trending must BIND
a per-request instant, which a pre-built fragment cannot carry); every value is a bound
parameter; `Prisma.raw` touches only the three numeric trending constants. Raw SQL returns
**ids + sort keys only** — row→DTO mapping stays on the typed client, so ordering/pagination and
mapping never fight.

**2. The first `optionalAuth` route.** See [[api-v1-scope-has-no-global-auth]] — the decorator
now exists, in the same `bearerAuthPlugin`.

**3. The first ownership-free presign**: `FilesService.presignPublicKey(key, ttl?)`. NOT a flag on
`presignDownload` and NOT a visibility clause inside `assertOwnership`: publication is a different
authorization fact from ownership, and folding them would make one function answer two questions
and risk the gallery rule leaking onto `GET /v1/files/presign-download`. It still runs
`parseS3Key` and still uses the `S3Role="presign"` client, so the "API is the only S3 URL signer"
invariant holds with exactly ONE signer in the process. The gallery reaches it through an injected
`presignPublic` seam, never by importing `FilesService`.

**4. The first pagination convention in the codebase.** Opaque base64url cursor
`{s,k,i,n,t?}` — sort, last key, last id, last ordinal, and (trending only) the frozen epoch.
Fetch `pageSize+1`, return `pageSize`, mint a cursor ONLY if the probe row existed, so
`nextCursor === null` means *genuinely exhausted* and the UI can hide "Load more" honestly. No
`hasMore` (a second field that can disagree) and no `total` (a `COUNT(*)` on every public listing
for a number nothing renders).

## Gotchas worth the ink

- **A forged cursor must be validated PER SORT, or it is a 500 not a 400.** The keyset key is
  bound with the cast its sort needs (`::integer` / `::timestamptz` / `::double precision`), so a
  `newest` cursor carrying `42` reaches `'42'::timestamptz` — a Postgres error. The codec
  therefore type-checks `k` against `s` (finite number / int4 range / parseable timestamp) rather
  than accepting any `number | string`. Measured aside: the casts themselves are NOT load-bearing
  today — Prisma leaves these parameters' types unspecified and Postgres infers from the column,
  proven by deleting the cast and re-running the real-Postgres walk. They stay as intent.
- **`newest` is the one sort whose cursor key is not a number** — it leaves Postgres as a `Date`
  and travels as an ISO string, so the service normalizes `sortKey` before minting. Its
  pagination needs its own e2e (`E-G8b`); construction-only unit tests cannot see type
  resolution.
- **`ORDER BY` reuses the SELECT's output alias `"sortKey"`**, so trending's expression is written
  once per clause that genuinely needs it. WHERE cannot use an alias, hence the predicate still
  carries the full expression.
- **The trending epoch is the whole reason trending paginates at all.** Freezing `now` as the
  cursor's `t` makes the age term constant across a run, so only `upvoteCount` can move a key —
  trending degrades exactly to `popular`'s (documented, accepted) mutable-key behaviour instead of
  drifting every second, unboundedly.
- **`rank` is server-side, popular-only, and continuous across pages** (the cursor's `n` supplies
  the starting ordinal). A client computing `index + 1` would badge the 25th item "#1"; the
  `rank <= 3` threshold and trophy-at-1 rule are presentation and live in the UI.
- **`escapeLike` is not decoration.** Without it a `q` of `%` matches everything and `_` matches
  any character. Blank/whitespace `q` emits NO predicate at all, never `%%`.
- **The upvote transaction never raises.** `createMany({ skipDuplicates })` →
  `INSERT … ON CONFLICT DO NOTHING`, `deleteMany` for the unvote, `{ increment: 1 }` /
  `{ decrement: 1 }` with a `upvoteCount: { gt: 0 }` floor guard. A P2002 caught INSIDE a Postgres
  transaction does not save you (25P02, and Prisma issues no SAVEPOINT), and a read-then-write
  loses updates under READ COMMITTED. Proven end-to-end: 8 concurrent distinct voters ⇒ exactly 8;
  8 parallel same-user votes ⇒ 1 row, no 5xx.
- **`isUniqueViolation` duck-types `code === "P2002"`**, not `instanceof
  PrismaClientKnownRequestError`, so the narrow guard stays assertable without constructing a real
  Prisma error.
- **Publish 409s vs download 404s for the same not-ready render, and that is the rule working**:
  409 is a state conflict on a MUTATION, a GET for a thing that does not exist yet is a 404.
- **A publish that cannot derive a book is a 422 with ZERO writes.** The column is NOT NULL, an
  `UNKNOWN` sentinel would be junk, and Zod cannot express a lookup.
- **The listing presigns every poster itself and degrades a signing failure to `null`.** An
  anonymous grid cannot use the auth-scoped presign route, and must not 500 because one poster
  failed. It is cheap because `getSignedUrl` signs LOCALLY.
- **`unlisted` is invisible in the listing even to its owner** — the listing is ONE public
  projection; making it viewer-dependent would make the cursor, the ranks and any future caching
  viewer-dependent. It stays readable and streamable by link.

## Scope, so it is not re-added

There is **NO book filter** — no `book=` param, no predicate, no facet endpoint. See
[[gallery-not-filterable-by-book]]. `scriptureBook` is still populated on publish and still on the
DTO; nothing queries it. `videoAssetKey`, `ownerId` and `viewCount` are deliberately OFF the DTO
(guessable sibling keys / gratuitous internal id / a field that would always be 0).

Related: [[render-api-and-ui-built]] (the RenderJob this publishes),
[[s3-file-presign-service-built]] (the signer it borrows),
[[scripture-book-reference-shape-rule]] (the deriver publish depends on).
