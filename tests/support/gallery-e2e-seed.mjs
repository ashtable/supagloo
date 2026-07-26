import { createHash } from "node:crypto";

import { E2E_RUN_ID } from "./e2e-github-naming.mjs";

/**
 * THE GALLERY E2E SEEDING SEAM.
 * =============================
 *
 * Plan row 41 / `scratch/tasks-39-40-41-gallery.md` §5.6. A populated PUBLIC gallery has
 * to exist in Postgres + MinIO *before* the browser loads `/gallery`, and none of the
 * shipping seams can produce one:
 *
 *   - `POST /v1/test/seed` is deliberately capped at **users + sessions** (§9-Q9 round-2).
 *     Teaching it about renders and gallery items would grow a production-registered,
 *     flag-gated endpoint to satisfy one browser spec.
 *   - `POST /v1/renders/:id/gallery` (the real publish route) needs a *completed*
 *     `RenderJob`, and driving a real render moves the spec into the minutes-long render
 *     lane for fixtures that have nothing to do with rendering.
 *   - nextjs has **no db-lib, no Prisma and no `pg`** — verified in its `package.json` —
 *     so it cannot write these rows itself.
 *
 * So this file writes them, from the ROOT repo, over plain SQL. That is the EXISTING
 * pattern rather than a new one: root already owns `e2e-github-api.mjs` + `.d.mts`, which
 * api / dbos / nextjs dynamic-import through
 * `process.env.SUPAGLOO_ROOT_DIR ?? ../supagloo` (see
 * `supagloo-nextjs/tests/e2e/github-e2e.ts`). Bare specifiers (`pg`,
 * `@aws-sdk/client-s3`) resolve against the IMPORTING MODULE's location, i.e. root's
 * `node_modules`, which is why a nextjs worker can use them without gaining a dependency.
 *
 * WHO USES THIS: nextjs's `tests/e2e/gallery.e2e.ts` only. The api's own
 * `tests/e2e/gallery.e2e.ts` keeps writing its fixtures through Prisma (it has db-lib) and
 * publishing through the real route — that spec is where the publish path is under test,
 * and this helper must never become its shortcut.
 *
 * THE TRADE-OFF, STATED: this is a second place that knows the gallery table shape. It is
 * kept INSERT-only, over columns `supagloo-database-lib/src/schema.test.ts` already pins,
 * and it derives every S3 key from the same layout db-lib's `s3-keys.ts` documents. If a
 * gallery column is ever added NOT NULL without a default, this file is the thing that
 * breaks — loudly, on the next real-lane run.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THIS ONE HAS TEARDOWN WHEN `e2e-github-api.mjs` DELIBERATELY HAS NONE
 * ---------------------------------------------------------------------------------------
 * The GitHub harness never tears down (task 62 D6): it mutates a personal account holding
 * the user's real repos, and per-run repo NAMES isolate one run from the next.
 *
 * Gallery rows have no such isolation. `GET /v1/gallery` is the one endpoint in the system
 * that is **not** scoped to a user — every run's fixtures land in the SAME public listing.
 * Leave them behind and the second run's "the top card is 🏆 #1", "exactly one card matches
 * the search" and "Load more disappears at exhaustion" assertions all decay into flakes.
 * So:
 *
 *   - {@link seedGalleryFixtures} CLEARS prior fixture rows before inserting (`reset`),
 *   - {@link clearGalleryFixtures} is exported for the spec's `afterAll`,
 *   - and both only ever touch rows whose **id passes {@link isGalleryFixtureId}**.
 *
 * That id gate is the same shape as the repo-name gate in `e2e-github-naming.mjs`: a
 * reviewed constant, re-checked AT THE MUTATION SITE, never env-derived. Nothing this
 * helper did not create can be deleted by it, so a developer's own local gallery items are
 * safe. What they are NOT is invisible — see {@link assertNoForeignGalleryItems}, which the
 * spec should call so a polluted dev DB fails loudly instead of flaking.
 *
 * Idempotency follows from the same place: every id is DERIVED from `(runId, kind, index)`,
 * every insert is `ON CONFLICT (id) DO UPDATE`, and seeding runs the clear first. Re-seeding
 * the same runId converges on the same state.
 *
 * ---------------------------------------------------------------------------------------
 * NO EGRESS, NO CREDENTIALS
 * ---------------------------------------------------------------------------------------
 * Postgres and MinIO only. No GitHub, OpenRouter, Gloo or YouVersion call, and therefore no
 * credential — the same property row 39's api spec has, and for the same reason (34-E8: do
 * not couple a gallery spec to provider creds).
 */

/* ------------------------------------------------------------------ the fixture id gate */

/**
 * THE prefix every row this helper writes carries in its primary key.
 *
 * Trailing `-` is load-bearing for the same reason the repo prefix's is: it stops a match
 * swallowing an id that merely starts with the same letters. Deliberately NOT the
 * repo-name prefix and NOT env-derived — {@link clearGalleryFixtures} DELETEs what this
 * matches, in a database that may also hold a developer's real local data.
 */
export const GALLERY_FIXTURE_ID_PREFIX = "e2e-gallery-";

/** Ids are restricted to this alphabet so a fixture id can never carry SQL/LIKE meaning. */
const FIXTURE_ID_CHARS = /^[a-z0-9-]+$/;

/**
 * THE HARD GATE. Exact-prefix, case-sensitive, non-empty suffix, and a closed alphabet.
 *
 * Re-checked immediately before every DELETE and every S3 removal, so the prefix is a code
 * invariant at the mutation site rather than a filtering side effect.
 */
export function isGalleryFixtureId(id) {
  if (typeof id !== "string") return false;
  if (!id.startsWith(GALLERY_FIXTURE_ID_PREFIX)) return false;
  if (id.length <= GALLERY_FIXTURE_ID_PREFIX.length) return false;
  return FIXTURE_ID_CHARS.test(id);
}

/**
 * The `LIKE` pattern the DELETEs use, as a BOUND parameter.
 *
 * `%` and `_` are wildcards inside `LIKE`, so a prefix containing either would silently
 * widen the gate — the same class of bug the API's `escapeLike` exists for. The prefix is a
 * reviewed constant today; this asserts it, because the cost of being wrong is deleting
 * somebody's rows.
 */
function fixtureLikePattern(prefix = GALLERY_FIXTURE_ID_PREFIX) {
  if (/[%_\\]/.test(prefix)) {
    throw new Error(
      `GALLERY_FIXTURE_ID_PREFIX ${JSON.stringify(prefix)} contains a LIKE metacharacter ` +
        "(% _ or \\). That would widen the delete gate beyond the fixtures — refusing.",
    );
  }
  return `${prefix}%`;
}

/* --------------------------------------------------------------------------- primitives */

/** `<prefix><runId>-<kind>-<suffix…>`, always inside the gate's alphabet. */
function fixtureId(runId, kind, ...parts) {
  const segments = [runId, kind, ...parts.map(String)]
    .map((s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean);
  const id = `${GALLERY_FIXTURE_ID_PREFIX}${segments.join("-")}`;
  if (!isGalleryFixtureId(id)) {
    throw new Error(
      `fixtureId produced ${JSON.stringify(id)}, which its own gate rejects — a bug here, ` +
        "not in the caller.",
    );
  }
  return id;
}

/**
 * A deterministic, high-entropy opaque session token.
 *
 * The API stores only `sha256(token)` in `Session.tokenHash` (`src/auth/tokens.ts`), so the
 * raw value is arbitrary — but deriving it from the runId rather than randomising makes the
 * whole seed replayable: re-seeding the same run hands the spec back the SAME token instead
 * of orphaning the one it already put in a cookie.
 */
function deriveToken(runId, label) {
  return createHash("sha256")
    .update(`${runId}|${label}|supagloo-gallery-e2e`)
    .digest("base64url");
}

/** `Session.tokenHash` — SHA-256 hex, byte-for-byte the API's `hashToken`. */
export function hashSessionToken(raw) {
  return createHash("sha256").update(String(raw)).digest("hex");
}

/**
 * Format a `Date` for a Prisma `DateTime` column, which is `timestamp(3) WITHOUT TIME ZONE`
 * holding UTC.
 *
 * THIS IS NOT COSMETIC. `pg` serialises a JS `Date` as local wall-clock time plus an offset
 * (`2026-07-26T06:24:00.000-07:00`); casting that to `timestamp without time zone` DISCARDS
 * the offset and stores `06:24:00`, which Prisma then reads back as 06:24 **UTC** — every
 * fixture silently shifted by the machine's offset. On a machine west of UTC that lands
 * `publishedAt` in the future, the trending expression's `GREATEST(…, 0)` clamps every row
 * to age 0, and the trending sort collapses onto the popular one. So every timestamp
 * crosses the wire as an offset-free UTC string, exactly as Prisma writes it.
 */
export function toPgTimestamp(date) {
  return new Date(date).toISOString().replace("T", " ").replace("Z", "");
}

/** The API's sliding session window (`SESSION_TTL_MS`), duplicated as a plain constant. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** db-lib `s3-keys.ts` layout. Recomputed here because the API recomputes it too — a
 *  stored key is never trusted by either side. */
const renderOutputKey = (renderJobId) => `renders/${renderJobId}/output.mp4`;
const renderThumbnailKey = (renderJobId) => `renders/${renderJobId}/thumb.jpg`;

/* ------------------------------------------------------------------------ the fixture set */

/**
 * References the cards render VERBATIM. `scriptureBook` is the code db-lib's
 * `deriveScriptureBook` produces for each — set explicitly because this helper writes the
 * column directly rather than going through publish, and the column is NOT NULL.
 * Nothing filters on it (the book filter was removed — §5.2); it exists so the fixture rows
 * are the same shape the publish route would have written.
 */
const REFERENCES = [
  { reference: "Genesis 1:1–4", book: "GEN", title: "Let There Be Light" },
  { reference: "Psalm 23", book: "PSA", title: "The Lord Is My Shepherd" },
  { reference: "John 3:16", book: "JHN", title: "So Loved The World" },
  { reference: "1 Corinthians 13:4–7", book: "1CO", title: "Love Is Patient" },
  { reference: "Isaiah 40:31", book: "ISA", title: "They Shall Mount Up" },
  { reference: "Romans 8:28", book: "ROM", title: "All Things Work Together" },
  { reference: "Matthew 5:14", book: "MAT", title: "A City On A Hill" },
  { reference: "Revelation 21:5", book: "REV", title: "Making All Things New" },
  { reference: "Proverbs 3:5–6", book: "PRO", title: "Trust With All Your Heart" },
  { reference: "Philippians 4:13", book: "PHP", title: "Strength For All Things" },
];

const TRANSLATIONS = ["KJV", "BSB"];

const AUTHORS = [
  { displayName: "Mary Kensington", initials: "MK" },
  { displayName: "Samuel Oyelaran", initials: "SO" },
  { displayName: "Priya Raghunathan", initials: "PR" },
  { displayName: "Tomas Lindqvist", initials: "TL" },
  { displayName: "Grace Abara", initials: "GA" },
  { displayName: "Noah Feldman", initials: "NF" },
  { displayName: "Ines Duarte", initials: "ID" },
  { displayName: "Kenji Watanabe", initials: "KW" },
];

/**
 * The four HAND-PLACED public items. Everything after index 3 is filler.
 *
 * These exist to make all three sorts produce a DIFFERENT leader, which is the one property
 * that proves `trending` is a genuinely third ordering rather than a rename of `popular` or
 * `newest` (plan D3's P5, end-to-end). Scores below are the shipped expression
 * `(votes + 1) / (ageHours + 2) ^ 1.5` — plan D3, `api/src/gallery/trending.ts`:
 *
 *   idx 0   age 0.25 h, 0 votes  → trending 0.296   ← NEWEST leader
 *   idx 1   age 1 h,    6 votes  → trending 1.347   ← TRENDING leader (highest, by 4.5×)
 *   idx 2   age 400 h,  8 votes  → trending 0.0011  ← POPULAR leader (most votes)
 *   idx 3   age 500 h,  5 votes  → popular #3
 *   filler  age ≥ 122 h, ≤3 votes → trending ≤ 0.003
 *
 * COUPLING, DECLARED: the three-distinct-leaders property depends on the gravity constants
 * staying at Hacker News's `{voteOffset: 1, ageOffsetHours: 2, gravity: 1.5}`. Those are
 * change-detector-tested in the api (U-TR11) precisely so changing them is a deliberate act
 * — and if they ever do change, re-derive this table. The spec should assert the PROPERTY
 * ("trending's first card is neither newest's nor popular's"), never a hardcoded score.
 */
const ANCHORS = [
  { ageHours: 0.25, upvoteCount: 0, role: "newest-leader" },
  { ageHours: 1, upvoteCount: 6, role: "trending-leader" },
  { ageHours: 400, upvoteCount: 8, role: "popular-leader" },
  { ageHours: 500, upvoteCount: 5, role: "popular-third" },
];

/**
 * The unlisted items are deliberately ADVERSARIAL: freshest-but-one and the most upvoted in
 * the whole set. If `visibility = 'public'` ever stops being applied to the listing they do
 * not merely appear — they take over the top of every sort, so the failure is unmissable.
 */
const UNLISTED = [
  { ageHours: 3, upvoteCount: 8, role: "unlisted-most-upvoted" },
  { ageHours: 4, upvoteCount: 7, role: "unlisted-runner-up" },
];

/** Rows per page in the shipped `GalleryService` (`GALLERY_PAGE_SIZE`, plan D5). Not a
 *  client parameter, so a spec that wants "Load more" needs MORE THAN this many public
 *  items — which is why `publicCount` defaults to 26 and not 6. */
export const GALLERY_PAGE_SIZE = 24;

/**
 * Build the whole fixture set as plain data. Pure: no DB, no network, no clock beyond the
 * injected `now`, so `(runId, now, options)` fully determines the output.
 *
 * @param {object} [options]
 * @param {string} [options.runId]        per-run id; also the nonce the browser seed uses
 * @param {Date}   [options.now]          the instant ages are measured back from
 * @param {number} [options.publicCount]  public items (default 26 — one full page + 2)
 * @param {number} [options.unlistedCount] unlisted items (default 2)
 * @param {number} [options.userCount]    seeded users, who are also the voters (default 8)
 * @param {string} [options.viewerYouversionUserId] the browser's identity — normally
 *        `yv-e2e-returning-<runId>`, i.e. what nextjs's `?seed=authed-returning&nonce=`
 *        produces. Left to the caller because that mapping is nextjs's convention, not root's.
 * @param {number[]} [options.viewerUpvotedIndexes] which public items the viewer has ALREADY
 *        upvoted (default `[1]`, the trending leader) — the rest stay outlined so the spec
 *        has both pill states and something to click.
 */
export function buildGalleryFixturePlan(options = {}) {
  const {
    runId = E2E_RUN_ID,
    now = new Date(),
    publicCount = 26,
    unlistedCount = 2,
    userCount = AUTHORS.length,
    viewerYouversionUserId = `yv-e2e-gallery-viewer-${runId}`,
    viewerUpvotedIndexes = [1],
  } = options;

  if (userCount < 1 || userCount > AUTHORS.length) {
    throw new Error(
      `buildGalleryFixturePlan: userCount must be 1..${AUTHORS.length} (got ${userCount}) — ` +
        "seeded users double as the voters, so the display names are a fixed roster.",
    );
  }
  if (publicCount < 1) {
    throw new Error("buildGalleryFixturePlan: publicCount must be >= 1");
  }

  /** Every fixture row's description carries this, so a spec can scope any text search to
   *  THIS run on a shared dev database. */
  const runToken = `sgrun${sanitizeToken(runId)}`;

  const users = Array.from({ length: userCount }, (_, i) => {
    const author = AUTHORS[i];
    return {
      index: i,
      id: fixtureId(runId, "user", pad(i)),
      youversionUserId: `yv-${GALLERY_FIXTURE_ID_PREFIX}${runId}-${pad(i)}`,
      displayName: author.displayName,
      email: `${author.initials.toLowerCase()}.${runId}@supagloo.test`,
      avatarInitials: author.initials,
      sessionId: fixtureId(runId, "session", pad(i)),
      sessionToken: deriveToken(runId, `user-${i}`),
    };
  });

  const viewer = {
    youversionUserId: viewerYouversionUserId,
    displayName: "Ada Lovelace",
    email: `viewer.${runId}@supagloo.test`,
    avatarInitials: "AL",
    /** Used ONLY if no user with that `youversionUserId` exists yet. */
    fallbackId: fixtureId(runId, "viewer"),
    sessionId: fixtureId(runId, "session", "viewer"),
    sessionToken: deriveToken(runId, "viewer"),
  };

  // One project + one published version per user. The gallery never renders project
  // metadata, so this is the minimum that satisfies RenderJob's two FKs honestly.
  const projects = users.map((user) => ({
    index: user.index,
    id: fixtureId(runId, "project", pad(user.index)),
    versionId: fixtureId(runId, "version", pad(user.index)),
    ownerIndex: user.index,
    ownerId: user.id,
    slug: `gallery-fixture-${pad(user.index)}-${runId}`,
    name: `${AUTHORS[user.index].displayName.split(" ")[0]}'s Scripture Set`,
    repoOwner: "supagloo-e2e",
    repoName: `gallery-fixture-${pad(user.index)}-${runId}`,
  }));

  const viewerUpvoted = new Set(viewerUpvotedIndexes);
  const specs = [];
  for (let i = 0; i < publicCount; i += 1) {
    const anchor = ANCHORS[i];
    specs.push({
      visibility: "public",
      role: anchor?.role ?? "filler",
      // Filler starts at 122 h and fans out, so no filler can out-trend the anchors.
      ageHours: anchor ? anchor.ageHours : 2 + i * 24,
      upvoteCount: anchor ? anchor.upvoteCount : i % 4,
      viewerHasUpvoted: viewerUpvoted.has(i),
    });
  }
  for (let u = 0; u < unlistedCount; u += 1) {
    const anchor = UNLISTED[u % UNLISTED.length];
    specs.push({
      visibility: "unlisted",
      role: anchor.role,
      ageHours: anchor.ageHours,
      upvoteCount: anchor.upvoteCount,
      viewerHasUpvoted: false,
    });
  }

  const fps = 12;
  const items = specs.map((spec, i) => {
    const ref = REFERENCES[i % REFERENCES.length];
    const project = projects[i % projects.length];
    const renderJobId = fixtureId(runId, "render", pad(i));
    const searchToken = `sgtok${sanitizeToken(runId)}${pad(i)}`;
    // A fixed-length token can only be a substring of another token if it IS that token, so
    // an ILIKE '%token%' search matches exactly one item. (The API escapes % and _; these
    // carry neither.)
    const durationSeconds = 24 + ((i * 17) % 200);
    const votersNeeded = spec.upvoteCount - (spec.viewerHasUpvoted ? 1 : 0);
    if (votersNeeded < 0) {
      throw new Error(
        `item ${i} declares upvoteCount ${spec.upvoteCount} but the viewer already holds a ` +
          "vote on it — a viewer-upvoted item needs upvoteCount >= 1.",
      );
    }
    if (votersNeeded > users.length) {
      throw new Error(
        `item ${i} needs ${votersNeeded} distinct voters but only ${users.length} users are ` +
          "seeded. upvoteCount is backed by REAL GalleryUpvote rows (never a fabricated " +
          "counter), so raise userCount or lower upvoteCount.",
      );
    }

    return {
      index: i,
      id: fixtureId(runId, "item", pad(i)),
      renderJobId,
      projectId: project.id,
      versionId: project.versionId,
      ownerId: project.ownerId,
      ownerIndex: project.ownerIndex,
      ownerDisplayName: users[project.ownerIndex].displayName,
      ownerAvatarInitials: users[project.ownerIndex].avatarInitials,
      role: spec.role,
      title: ref.title,
      searchToken,
      description: `${ref.title} — a Supagloo gallery fixture. ${runToken} ${searchToken}`,
      scriptureReference: ref.reference,
      scriptureBook: ref.book,
      translation: TRANSLATIONS[i % TRANSLATIONS.length],
      visibility: spec.visibility,
      ageHours: spec.ageHours,
      publishedAt: new Date(now.getTime() - spec.ageHours * 3_600_000),
      durationSeconds,
      fps,
      framesTotal: durationSeconds * fps,
      upvoteCount: spec.upvoteCount,
      viewerHasUpvoted: spec.viewerHasUpvoted,
      voterIndexes: Array.from({ length: votersNeeded }, (_, v) => v),
      videoAssetKey: renderOutputKey(renderJobId),
      thumbnailAssetKey: renderThumbnailKey(renderJobId),
    };
  });

  const publicItems = items.filter((it) => it.visibility === "public");

  return Object.freeze({
    runId,
    now,
    runToken,
    idPrefix: GALLERY_FIXTURE_ID_PREFIX,
    pageSize: GALLERY_PAGE_SIZE,
    users,
    viewer,
    projects,
    items,
    publicItems,
    unlistedItems: items.filter((it) => it.visibility === "unlisted"),
    /**
     * Pure DATA facts — derived from the fixture values, not from any scoring formula, so
     * they cannot drift from the API. `id DESC` is the API's tiebreak (plan D5).
     */
    expectedOrder: Object.freeze({
      newest: publicItems
        .slice()
        .sort((a, b) => b.publishedAt - a.publishedAt || cmpDesc(a.id, b.id))
        .map((it) => it.id),
      popular: publicItems
        .slice()
        .sort((a, b) => b.upvoteCount - a.upvoteCount || cmpDesc(a.id, b.id))
        .map((it) => it.id),
    }),
    /** The item each sort must lead with. `trending` is deliberately absent: naming it would
     *  mean re-implementing the gravity expression here. Assert the PROPERTY instead —
     *  trending's leader is neither of these two. */
    leaders: Object.freeze({
      newest: publicItems.find((it) => it.role === "newest-leader")?.id ?? null,
      popular: publicItems.find((it) => it.role === "popular-leader")?.id ?? null,
    }),
  });
}

const pad = (n) => String(n).padStart(3, "0");
const sanitizeToken = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const cmpDesc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);

/* ------------------------------------------------------------------------- connections */

/**
 * The Compose coordinates, env-overridable with the same defaults `tests/support/dev-config.ts`
 * documents.
 *
 * Duplicated rather than imported because that file is TypeScript and this module must stay
 * plain, un-built ESM a nextjs Vitest worker can `import()` at runtime — the same constraint
 * that shapes `e2e-github-api.mjs`. `SUPAGLOO_E2E_DATABASE_URL` wins over `DATABASE_URL` so
 * a repo whose `.env` points at the in-network `postgres:5432` can still run this from the
 * host.
 */
export function resolveGalleryE2eConfig(env = process.env) {
  return Object.freeze({
    connectionString:
      env.SUPAGLOO_E2E_DATABASE_URL ??
      env.DATABASE_URL ??
      "postgres://supagloo:supagloo@localhost:5432/supagloo",
    s3: Object.freeze({
      // The host-reachable endpoint: this helper runs on the host, never in a container.
      endpoint: env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000",
      bucket: env.S3_BUCKET ?? "supagloo-dev",
      accessKey: env.S3_ACCESS_KEY ?? "supagloo",
      secretKey: env.S3_SECRET_KEY ?? "supagloo-dev",
      region: env.S3_REGION ?? "us-east-1",
    }),
  });
}

async function loadPg() {
  try {
    const mod = await import("pg");
    return mod.default ?? mod;
  } catch (err) {
    throw new Error(
      "gallery-e2e-seed needs `pg`, which is a devDependency of the ROOT supagloo repo.\n" +
        "  Bare specifiers resolve against THIS file's location, so run `npm install` in the\n" +
        `  root checkout. Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Open a client, run `fn`, always close. Callers may pass their own `client` to join an
 *  existing connection instead. */
async function withClient(options, fn) {
  if (options?.client) return fn(options.client);
  const { Client } = await loadPg();
  const connectionString =
    options?.connectionString ?? resolveGalleryE2eConfig().connectionString;
  const client = new Client({ connectionString });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `gallery-e2e-seed could not connect to Postgres at ${redactUrl(connectionString)}.\n` +
        "  The gallery fixtures live in the Compose app database — bring it up with\n" +
        "  `docker compose up -d postgres minio minio-init` in the root repo, or point\n" +
        "  SUPAGLOO_E2E_DATABASE_URL at the right host.\n" +
        `  Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Never let a password reach an error message. */
function redactUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "(unparseable connection string)";
  }
}

/* ------------------------------------------------------------------------------ writing */

/**
 * Seed the whole gallery fixture set into Postgres, and (unless `media: false`) the matching
 * objects into MinIO.
 *
 * The reset AND every insert share ONE transaction, so `GET /v1/gallery` goes straight from
 * the previous run's fixtures to this run's — it is never observed half-populated, and never
 * observed empty. (The MinIO writes are outside it; S3 has no transaction, and an object
 * whose row does not exist yet is unreachable anyway.)
 *
 * @returns the plan, plus the RESOLVED viewer (its user id may pre-exist) — see the `.d.mts`.
 */
export async function seedGalleryFixtures(options = {}) {
  const plan = options.plan ?? buildGalleryFixturePlan(options);
  const { reset = true, media = true } = options;

  const viewerId = await withClient(options, async (client) => {
    await client.query("BEGIN");
    try {
      if (reset) await deleteFixtureRows(client);
      const resolvedViewerId = await upsertViewer(client, plan.viewer);
      await insertUsers(client, plan.users);
      await insertProjects(client, plan.projects, plan.now);
      await insertRenderJobs(client, plan.items, plan.now);
      await insertGalleryItems(client, plan.items);
      await insertUpvotes(client, plan, resolvedViewerId);
      await client.query("COMMIT");
      return resolvedViewerId;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  });

  if (media) await putFixtureMedia(plan.items, options);

  return Object.freeze({
    ...plan,
    viewer: Object.freeze({ ...plan.viewer, id: viewerId }),
    mediaSeeded: media,
  });
}

/**
 * Resolve the viewer to a REAL `User.id`.
 *
 * The browser's session comes from nextjs's `?seed=authed-returning&nonce=<runId>`, which
 * upserts a user BY `youversionUserId`. Whichever of the two runs first wins the id and the
 * other converges on it, so the viewer the fixtures attribute upvotes to and the viewer the
 * browser is signed in as are always the same row. Only a viewer this helper CREATED carries
 * a fixture id — a pre-existing one keeps its own and is therefore untouchable by
 * {@link clearGalleryFixtures}.
 */
async function upsertViewer(client, viewer) {
  const existing = await client.query(
    'SELECT "id" FROM "User" WHERE "youversionUserId" = $1',
    [viewer.youversionUserId],
  );
  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    await insertSession(client, viewer.sessionId, id, viewer.sessionToken);
    return id;
  }
  await insertUsers(client, [{ ...viewer, id: viewer.fallbackId }]);
  return viewer.fallbackId;
}

async function insertUsers(client, users) {
  if (users.length === 0) return;
  const now = new Date();
  await bulkInsert(
    client,
    '"User"',
    [
      "id",
      "youversionUserId",
      "displayName",
      "email",
      "avatarInitials",
      "firstSignInAt",
      "onboardingCompletedAt",
      "lastSeenAt",
      "createdAt",
      "updatedAt",
    ],
    users.map((u) => [
      u.id,
      u.youversionUserId,
      u.displayName,
      u.email,
      u.avatarInitials,
      toPgTimestamp(now),
      toPgTimestamp(now), // onboarded: the gallery is never seen mid-onboarding
      toPgTimestamp(now),
      toPgTimestamp(now),
      toPgTimestamp(now), // @updatedAt is Prisma-side; a raw INSERT must supply it
    ]),
    `"displayName" = EXCLUDED."displayName", "email" = EXCLUDED."email",
     "avatarInitials" = EXCLUDED."avatarInitials", "lastSeenAt" = EXCLUDED."lastSeenAt",
     "updatedAt" = EXCLUDED."updatedAt"`,
  );

  for (const u of users) {
    if (u.sessionId && u.sessionToken) {
      await insertSession(client, u.sessionId, u.id, u.sessionToken);
    }
  }
}

/** A LIVE session: `tokenHash = sha256(raw)` and a 30-day sliding expiry, exactly what
 *  `POST /v1/test/seed` writes — so the returned token bearer-authenticates immediately. */
async function insertSession(client, sessionId, userId, token) {
  const now = new Date();
  await client.query(
    `INSERT INTO "Session" ("id","userId","tokenHash","expiresAt","createdAt","lastUsedAt")
     VALUES ($1,$2,$3,$4::timestamp,$5::timestamp,$6::timestamp)
     ON CONFLICT ("id") DO UPDATE SET
       "userId" = EXCLUDED."userId",
       "tokenHash" = EXCLUDED."tokenHash",
       "expiresAt" = EXCLUDED."expiresAt",
       "lastUsedAt" = EXCLUDED."lastUsedAt"`,
    [
      sessionId,
      userId,
      hashSessionToken(token),
      toPgTimestamp(new Date(now.getTime() + SESSION_TTL_MS)),
      toPgTimestamp(now),
      toPgTimestamp(now),
    ],
  );
}

async function insertProjects(client, projects, now) {
  await bulkInsert(
    client,
    '"Project"',
    [
      "id",
      "slug",
      "ownerId",
      "name",
      "repoOwner",
      "repoName",
      "repoVisibility",
      "createdFrom",
      "currentBranch",
      "lastOpenedAt",
      "createdAt",
    ],
    projects.map((p) => [
      p.id,
      p.slug,
      p.ownerId,
      p.name,
      p.repoOwner,
      p.repoName,
      "private",
      "blank",
      "v0.1.0",
      toPgTimestamp(now),
      toPgTimestamp(now),
    ]),
    '"name" = EXCLUDED."name", "lastOpenedAt" = EXCLUDED."lastOpenedAt"',
  );

  await bulkInsert(
    client,
    '"ProjectVersion"',
    ["id", "projectId", "semver", "branchName", "state", "changedFiles", "publishedAt"],
    projects.map((p) => [
      p.versionId,
      p.id,
      "0.1.0",
      "v0.1.0",
      "published",
      "[]",
      toPgTimestamp(now),
    ]),
    '"state" = EXCLUDED."state"',
  );
}

/**
 * A `completed` RenderJob per item, carrying BOTH asset keys.
 *
 * `framesTotal = durationSeconds * fps` on purpose: "Your videos" renders its duration badge
 * from `framesTotal / fps` while the gallery card renders `durationSeconds` from the DTO, and
 * the two must agree or one screen quietly contradicts the other. `framesTotal` is never 0 —
 * 0 means INDETERMINATE and suppresses the badge entirely (the task-38 lesson).
 */
async function insertRenderJobs(client, items, now) {
  await bulkInsert(
    client,
    '"RenderJob"',
    [
      "id",
      "projectId",
      "versionId",
      "userId",
      "status",
      "framesDone",
      "framesTotal",
      "width",
      "height",
      "fps",
      "aspectRatio",
      "codec",
      "outputAssetKey",
      "thumbnailAssetKey",
      "runInBackground",
      "createdAt",
      "startedAt",
      "completedAt",
    ],
    items.map((it) => [
      it.renderJobId,
      it.projectId,
      it.versionId,
      it.ownerId,
      "completed",
      it.framesTotal,
      it.framesTotal,
      160,
      90,
      it.fps,
      "16:9",
      "h264",
      it.videoAssetKey,
      it.thumbnailAssetKey,
      true,
      toPgTimestamp(it.publishedAt),
      toPgTimestamp(it.publishedAt),
      toPgTimestamp(it.publishedAt),
    ]),
    `"status" = EXCLUDED."status", "framesTotal" = EXCLUDED."framesTotal",
     "framesDone" = EXCLUDED."framesDone", "outputAssetKey" = EXCLUDED."outputAssetKey",
     "thumbnailAssetKey" = EXCLUDED."thumbnailAssetKey"`,
  );
}

async function insertGalleryItems(client, items) {
  await bulkInsert(
    client,
    '"GalleryItem"',
    [
      "id",
      "renderJobId",
      "projectId",
      "ownerId",
      "title",
      "description",
      "scriptureReference",
      "translation",
      "scriptureBook",
      "durationSeconds",
      "videoAssetKey",
      "thumbnailAssetKey",
      "visibility",
      "publishedAt",
      "upvoteCount",
      "viewCount",
    ],
    items.map((it) => [
      it.id,
      it.renderJobId,
      it.projectId,
      it.ownerId,
      it.title,
      it.description,
      it.scriptureReference,
      it.translation,
      it.scriptureBook,
      it.durationSeconds,
      it.videoAssetKey,
      it.thumbnailAssetKey,
      it.visibility,
      toPgTimestamp(it.publishedAt),
      it.upvoteCount,
      0,
    ]),
    `"title" = EXCLUDED."title", "description" = EXCLUDED."description",
     "visibility" = EXCLUDED."visibility", "publishedAt" = EXCLUDED."publishedAt",
     "upvoteCount" = EXCLUDED."upvoteCount"`,
  );
}

/**
 * REAL `GalleryUpvote` rows, one per counted vote — never a fabricated `upvoteCount`.
 *
 * The counter and the rows have to agree or the product misbehaves against its own fixtures:
 * `DELETE /v1/gallery/:id/upvote` decrements only when it actually deleted a row, and
 * `viewerHasUpvoted` is resolved from the rows, not the counter. A seed that inflated the
 * counter would make un-voting look broken.
 */
async function insertUpvotes(client, plan, viewerId) {
  const rows = [];
  for (const item of plan.items) {
    for (const voterIndex of item.voterIndexes) {
      rows.push([
        fixtureId(plan.runId, "upvote", pad(item.index), pad(voterIndex)),
        plan.users[voterIndex].id,
        item.id,
        toPgTimestamp(item.publishedAt),
      ]);
    }
    if (item.viewerHasUpvoted) {
      rows.push([
        fixtureId(plan.runId, "upvote", pad(item.index), "viewer"),
        viewerId,
        item.id,
        toPgTimestamp(item.publishedAt),
      ]);
    }
  }
  if (rows.length === 0) return;
  await bulkInsert(
    client,
    '"GalleryUpvote"',
    ["id", "userId", "galleryItemId", "createdAt"],
    rows,
    '"createdAt" = EXCLUDED."createdAt"',
  );
}

/**
 * One multi-row parameterised INSERT … ON CONFLICT (id) DO UPDATE.
 *
 * Every VALUE is bound; the only interpolated text is the caller's literal column list and
 * conflict clause, both of which are authored constants in this file.
 */
async function bulkInsert(client, table, columns, rows, updateClause) {
  if (rows.length === 0) return;
  const cols = columns.map((c) => `"${c}"`).join(",");
  const values = [];
  const params = [];
  let n = 0;
  for (const row of rows) {
    if (row.length !== columns.length) {
      throw new Error(
        `bulkInsert into ${table}: row has ${row.length} values for ${columns.length} columns`,
      );
    }
    values.push(`(${row.map(() => `$${++n}`).join(",")})`);
    params.push(...row);
  }
  await client.query(
    `INSERT INTO ${table} (${cols}) VALUES ${values.join(",")} ` +
      `ON CONFLICT ("id") DO UPDATE SET ${updateClause}`,
    params,
  );
}

/* ------------------------------------------------------------------------------ clearing */

/**
 * Delete every fixture row this helper can have written, and (unless `media: false`) their
 * MinIO objects.
 *
 * Gate: each statement matches on `id LIKE '<prefix>%'` — nothing else. Deleting the users
 * alone would cascade most of this, but each table is named explicitly so the teardown does
 * not silently depend on a cascade someone later changes, and so `GalleryUpvote` rows the
 * PRODUCT created during the run (real pill clicks, cuid ids) are removed by their
 * `galleryItemId` rather than by luck.
 *
 * Deliberately does NOT delete a viewer user it did not create: a pre-existing viewer keeps
 * a non-fixture id and therefore never matches.
 */
export async function clearGalleryFixtures(options = {}) {
  const { media = true } = options;
  const removed = await withClient(options, async (client) => {
    await client.query("BEGIN");
    try {
      const renderIds = await listFixtureRenderJobIds(client);
      const counts = await deleteFixtureRows(client);
      await client.query("COMMIT");
      return { counts, renderIds };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  });

  if (media) await deleteFixtureMedia(removed.renderIds, options);

  return Object.freeze({ ...removed.counts, mediaKeys: removed.renderIds.length * 2 });
}

async function listFixtureRenderJobIds(client) {
  const { rows } = await client.query(
    'SELECT "id" FROM "RenderJob" WHERE "id" LIKE $1',
    [fixtureLikePattern()],
  );
  // The gate again, at the point of use: only ids it accepts become S3 delete keys.
  return rows.map((r) => r.id).filter(isGalleryFixtureId);
}

/**
 * The DELETEs themselves. Assumes the caller opened a transaction.
 *
 * The gate is PREFIX-WIDE, not run-scoped, and that is the point: leftovers from EARLIER
 * runs are exactly what has to go, because they share the one global public listing. The
 * corollary is that two gallery specs must not run concurrently against one database — they
 * would clear each other. Nothing does today (the real lane runs one file at a time).
 */
async function deleteFixtureRows(client) {
  const like = fixtureLikePattern();
  const counts = {};
  const run = async (label, sql, params) => {
    const res = await client.query(sql, params);
    counts[label] = res.rowCount ?? 0;
  };

  await run(
    "galleryUpvotes",
    'DELETE FROM "GalleryUpvote" WHERE "id" LIKE $1 OR "galleryItemId" LIKE $1',
    [like],
  );
  await run("galleryItems", 'DELETE FROM "GalleryItem" WHERE "id" LIKE $1', [like]);
  await run("renderJobs", 'DELETE FROM "RenderJob" WHERE "id" LIKE $1', [like]);
  await run("projectVersions", 'DELETE FROM "ProjectVersion" WHERE "id" LIKE $1', [like]);
  await run("projects", 'DELETE FROM "Project" WHERE "id" LIKE $1', [like]);
  await run("sessions", 'DELETE FROM "Session" WHERE "id" LIKE $1', [like]);
  await run("users", 'DELETE FROM "User" WHERE "id" LIKE $1', [like]);
  return counts;
}

/**
 * Fail LOUDLY if the app database already holds public gallery items this helper did not
 * write.
 *
 * `GET /v1/gallery` is global, so a stray real item silently invalidates every rank,
 * pagination and "exactly one card" assertion in the spec. A spec that calls this turns that
 * into one actionable error instead of an intermittent red three weeks later — the same
 * reasoning as the GitHub harness's five fail-fast throws (never `console.warn` + skip,
 * which the reporter swallows into a green lie).
 */
export async function assertNoForeignGalleryItems(options = {}) {
  const { rows } = await withClient(options, (client) =>
    client.query(
      `SELECT "id", "title" FROM "GalleryItem"
       WHERE "visibility" = 'public' AND "id" NOT LIKE $1
       ORDER BY "publishedAt" DESC LIMIT 5`,
      [fixtureLikePattern()],
    ),
  );
  if (rows.length === 0) return;
  throw new Error(
    `The app database holds ${rows.length}+ PUBLIC gallery items that are not e2e fixtures, ` +
      "and GET /v1/gallery is a GLOBAL listing — ranks, pagination and search counts in this " +
      "spec would be measuring somebody else's data.\n" +
      rows.map((r) => `    • ${r.id} — ${JSON.stringify(r.title)}`).join("\n") +
      "\n  Remove them (or run against a clean Compose database) before running this lane.",
  );
}

/* --------------------------------------------------------------------------------- MinIO */

/**
 * Real playable media, base64-inlined.
 *
 * WHY OBJECTS ARE NEEDED AT ALL: `presignPublicKey` signs LOCALLY, so `stream-url` returns
 * 200 whether or not the object exists — the failure only shows up when the browser fetches
 * it. A missing object means a 404 from MinIO, a `<video>` stuck at `readyState === 0` and a
 * broken poster, i.e. exactly the two things §5.6's E-GU11/E-GU14 assert.
 *
 * WHY REAL BYTES AND NOT A TEXT BLOB: `readyState > 0` means Chromium parsed a `moov` box.
 * Arbitrary bytes named `.mp4` fetch fine and still never reach `HAVE_METADATA`.
 *
 * PROVENANCE — regenerate with (ffmpeg from `@remotion/compositor-*`, or any ffmpeg):
 *   ffmpeg -loop 1 -f image2 -c:v png -i frame.png -t 1 -r 12 -c:v libx264 \
 *          -profile:v baseline -pix_fmt yuv420p -crf 45 -movflags +faststart -an out.mp4
 *   ffmpeg -i frame.png -c:v mjpeg -q:v 12 thumb.jpg
 * The shipped blobs are 1 745 B (H.264 baseline, 160×90, 12 fps, 1 s, `moov` BEFORE `mdat`
 * so metadata arrives in the first range request) and 637 B (baseline JPEG, 160×90).
 *
 * DECLARED MISMATCH: the media is 1 s long for every item, while each row declares its own
 * `durationSeconds` (24–223 s) so the `mm:ss` badges differ. The badge is DTO-driven, so
 * this is invisible to the UI — but a spec must never assert `video.duration` against the
 * row. Shipping ~30 real videos to fix that would put megabytes of binary in git for nothing.
 */
export const GALLERY_FIXTURE_MEDIA = Object.freeze({
  video: Object.freeze({
    contentType: "video/mp4",
    base64: [
        "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANEbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gA",
        "AQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAgAAAm90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEA",
        "AAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAKAAAABaAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPo",
        "AAAAAAABAAAAAAHnbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAwAAAAMABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUA",
        "AAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABkm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYA",
        "AAAAAAAAAQAAAAx1cmwgAAAAAQAAAVJzdGJsAAAAqnN0c2QAAAAAAAAAAQAAAJphdmMxAAAAAAAAAAEAAAAAAAAAAAAA",
        "AAAAAAAAAKAAWgBIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAMGF2Y0MB",
        "QsAe/+EAF2dCwB7ZAo35IQAAAwABAAADABgPFi5IAQAGaMuATSyAAAAAFGJ0cnQAAAAAAAAa6AAAGugAAAAYc3R0cwAA",
        "AAAAAAABAAAADAAABAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAADAAAAAEAAABEc3Rz",
        "egAAAAAAAAAAAAAADAAAAvAAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACQAAABRzdGNv",
        "AAAAAAAAAAEAAAN0AAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAs",
        "aWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MS43LjEwMAAAAAhmcmVlAAADZW1kYXQAAAJxBgX//23cRem9",
        "5tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0g",
        "Q29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2Fi",
        "YWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9y",
        "ZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNx",
        "bT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MyBsb29rYWhl",
        "YWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29t",
        "cGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0x",
        "MiBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9NDUu",
        "MCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAHdl",
        "iIQfxGKAAIBMYAAURkI7yak4jX8mojvEa9JqI7zcqMkSplXrVWTSqyVZNKrJU2LjFDaZNqpyb2SrVWTZKtVOSvTalRky",
        "aVWSrJpVOq9Ot6VUSptRihtMlWtEqyVazEq9qp19MqvNr6lU+vWsyr0+vWsyr16tcAAAAAZBmjg/g9gAAAAGQZpUD+D2",
        "AAAABkGaYG8HsAAAAAZBmoBvB7AAAAAGQZqgbwewAAAABkGawG8HsAAAAAZBmuBfB7AAAAAGQZsAXwewAAAABkGbIE8H",
        "sAAAAAZBm0D8HsAAAAAFQZth8Hs=",
      ].join(""),
    get bytes() {
      return Buffer.from(GALLERY_FIXTURE_MEDIA.video.base64, "base64");
    },
  }),
  thumbnail: Object.freeze({
    contentType: "image/jpeg",
    base64: [
        "/9j//gAQTGF2YzYxLjE5LjEwMAD/2wBDAAgYGBwYHCEhISEhISckJygoKCcnJycoKCgrKyszMzMrKysoKCsrMDAzMzc5",
        "NzQ0MzQ5OTw8PEhIRUVUVFdnZ3z/xABSAAEBAQEBAAAAAAAAAAAAAAACAQAFBwEBAQEBAQAAAAAAAAAAAAAAAwIFAAYQ",
        "AQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCABaAKADARIAAhIAAxIA/9oADAMBAAIRAxEAPwDy",
        "4ntwuMhlCEyEYIDIRQgMhFCAyEYIDIRQgMhlCA6EYIDIRQgMhFCAyEYIDIZQgMJlCA6EYIDIRQgMhFEAyEUIDIZQgMJl",
        "EAzlkYTWMhFCEqEUITIZRAMJlCAyEUIDIRRAMhFCEqEUITIZRAMJlCAyEUIDIRRAMhFCAyEUITIZRAMhFCAyEUIDIRRA",
        "MhFCAzlmcLWMJlCEqEUQTIRQgMhFCAyEUQDIZQgMJlCAyEUQTIRQgMhFCAyEUQDIZQgMhFCAyEUQTIRQgMhFCAyGUQDC",
        "ZQgMhFCAzlkcLWMhFEAyEUITIZQgMhFEAyEUIDIRQgMhGCAyEUITIZQgMhGCAyEUIDIRQgMhGCAyGUITCZQgMhGCAyEU",
        "IDIRQgMhGCAzlmcLWMhFCAyEUITIRggMhFCAyGUIDCZggMhFCAyEUISoRghMhFCAyGUIDCZggMhFCAyEUISoRghMhFCA",
        "yGUIDIRggMhFCAzlkcbWIhLGIqEQYiISxiIyrGIjKQYiMSxiIhLGIqEQYiISxiIyrGIjEQYiISxiIhLGIqEQYiMqxiIy",
        "rGIjEQYiISxiIhLGIr//2Q==",
      ].join(""),
    get bytes() {
      return Buffer.from(GALLERY_FIXTURE_MEDIA.thumbnail.base64, "base64");
    },
  }),
});

async function makeS3Client(options = {}) {
  let mod;
  try {
    mod = await import("@aws-sdk/client-s3");
  } catch (err) {
    throw new Error(
      "gallery-e2e-seed needs `@aws-sdk/client-s3`, a devDependency of the ROOT supagloo " +
        "repo. Run `npm install` there, or pass `media: false` to skip object seeding.\n" +
        `  Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const cfg = options.s3 ?? resolveGalleryE2eConfig().s3;
  const client = new mod.S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    // Mandatory for MinIO: there is no vhost-style bucket DNS.
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  });
  return { mod, client, cfg };
}

/**
 * PUT `renders/{renderJobId}/output.mp4` + `thumb.jpg` for every item.
 *
 * Two objects per item rather than one shared object because the API RECOMPUTES both keys
 * from `renderJobId` and never reads the stored string — there is no key to point at a
 * shared blob. At ~2.4 KB per item this is a few hundred KB of local MinIO.
 */
export async function putFixtureMedia(items, options = {}) {
  const { mod, client, cfg } = await makeS3Client(options);
  try {
    for (const item of items) {
      await client.send(
        new mod.PutObjectCommand({
          Bucket: cfg.bucket,
          Key: item.videoAssetKey,
          Body: GALLERY_FIXTURE_MEDIA.video.bytes,
          ContentType: GALLERY_FIXTURE_MEDIA.video.contentType,
        }),
      );
      await client.send(
        new mod.PutObjectCommand({
          Bucket: cfg.bucket,
          Key: item.thumbnailAssetKey,
          Body: GALLERY_FIXTURE_MEDIA.thumbnail.bytes,
          ContentType: GALLERY_FIXTURE_MEDIA.thumbnail.contentType,
        }),
      );
    }
    return items.length * 2;
  } finally {
    client.destroy();
  }
}

/**
 * Best-effort removal of the fixture objects. Never throws: a leftover 2 KB object in a local
 * dev bucket is not worth failing a teardown over, and the NEXT run overwrites the same keys
 * anyway (the render ids are derived from the run id, so keys are per-run).
 */
export async function deleteFixtureMedia(renderJobIds, options = {}) {
  const ids = renderJobIds.filter(isGalleryFixtureId);
  if (ids.length === 0) return 0;
  let mod;
  let client;
  let cfg;
  try {
    ({ mod, client, cfg } = await makeS3Client(options));
  } catch {
    return 0;
  }
  let deleted = 0;
  try {
    for (const id of ids) {
      for (const key of [renderOutputKey(id), renderThumbnailKey(id)]) {
        try {
          await client.send(new mod.DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
          deleted += 1;
        } catch {
          /* ignore — see the JSDoc */
        }
      }
    }
  } finally {
    client.destroy();
  }
  return deleted;
}

export { E2E_RUN_ID };
