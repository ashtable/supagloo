/**
 * Type contract for `gallery-e2e-seed.mjs` — the gallery e2e seeding seam
 * (plan row 41 / `scratch/tasks-39-40-41-gallery.md` §5.6).
 *
 * The implementation is deliberately plain, un-built ESM so a nextjs Vitest worker can
 * `import()` it at runtime through the established `SUPAGLOO_ROOT_DIR ?? ../supagloo` seam,
 * exactly like `e2e-github-api.mjs`. This declaration file exists so those TypeScript
 * consumers get real types without a build step.
 *
 * NOTHING HERE REFERENCES `pg` OR THE AWS SDK BY TYPE, on purpose: the consumers do not
 * depend on either package, so a `import type { Client } from "pg"` would fail to resolve
 * in nextjs. The one place a client crosses the boundary ({@link ConnectionOptions.client})
 * is typed structurally instead.
 *
 * THE TWO RULES A CONSUMER MUST KNOW:
 *  1. Every row this helper writes carries {@link GALLERY_FIXTURE_ID_PREFIX} in its primary
 *     key, and {@link clearGalleryFixtures} deletes nothing else. It cannot touch a
 *     developer's real local data — and it cannot clean up rows created outside it either.
 *  2. `GET /v1/gallery` is a GLOBAL listing. Call {@link assertNoForeignGalleryItems} before
 *     asserting anything about ranks, counts or pagination, or the spec is measuring
 *     somebody else's data.
 */

/** A Postgres client, structurally. Satisfied by `pg`'s `Client` and `PoolClient`. */
export interface PgClientLike {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface S3Config {
  /** Host-reachable endpoint — this helper always runs on the host, never in a container. */
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export interface GalleryE2eConfig {
  connectionString: string;
  s3: S3Config;
}

export interface ConnectionOptions {
  /** Join an existing connection instead of opening one. Takes precedence over
   *  `connectionString`; the caller keeps ownership and must close it. */
  client?: PgClientLike;
  /** Defaults to `SUPAGLOO_E2E_DATABASE_URL ?? DATABASE_URL ?? the Compose app db`. */
  connectionString?: string;
  /** Overrides the resolved MinIO coordinates. */
  s3?: S3Config;
}

export interface GalleryFixtureOptions {
  /** Per-run id. Defaults to the shared per-process `E2E_RUN_ID`. Pass the SAME value the
   *  browser seed uses as its `?seed=…&nonce=` so ids line up across the two. */
  runId?: string;
  /** The instant every `publishedAt` is measured back from. Defaults to `new Date()`. */
  now?: Date;
  /** Public items. Default 26 — deliberately MORE than {@link GALLERY_PAGE_SIZE}, which is
   *  the only way "Load more" is reachable (the page size is not a client parameter). */
  publicCount?: number;
  /** Unlisted items. Default 2, and adversarial: they are the most-upvoted rows in the set,
   *  so a broken visibility filter takes over the top of every sort rather than hiding. */
  unlistedCount?: number;
  /** Seeded users, who double as the voters. Default 8, max 8 (fixed display-name roster).
   *  An item's `upvoteCount` is backed by REAL rows, so this caps the highest count. */
  userCount?: number;
  /** The browser's identity — normally `yv-e2e-returning-<runId>`, i.e. what nextjs's
   *  `?seed=authed-returning&nonce=` produces. Whichever of the two seeds runs first wins
   *  the `User.id`; the other converges on it. */
  viewerYouversionUserId?: string;
  /** Public items the viewer has ALREADY upvoted (default `[1]`). Everything else stays
   *  outlined, so the spec has both pill states and something to click. */
  viewerUpvotedIndexes?: number[];
}

export interface SeedOptions extends GalleryFixtureOptions, ConnectionOptions {
  /** Reuse a plan built earlier instead of rebuilding it. */
  plan?: GalleryFixturePlan;
  /** Clear prior fixture rows first. Default `true` — the listing is global, so leftovers
   *  from an earlier run corrupt rank/pagination/search assertions. */
  reset?: boolean;
  /** Also PUT the MinIO objects. Default `true`. */
  media?: boolean;
}

export interface ClearOptions extends ConnectionOptions {
  /** Also remove the fixture objects from MinIO. Default `true`. */
  media?: boolean;
}

export interface FixtureUser {
  index: number;
  id: string;
  youversionUserId: string;
  displayName: string;
  email: string;
  avatarInitials: string;
  sessionId: string;
  /** The RAW opaque bearer token. The DB holds only its SHA-256; usable verbatim as
   *  `Authorization: Bearer …` against the API, or as the app's session-cookie value. */
  sessionToken: string;
}

export interface FixtureViewer {
  /** Resolved `User.id`. Present on {@link SeededGallery}, absent on a freshly built plan. */
  id?: string;
  youversionUserId: string;
  displayName: string;
  email: string;
  avatarInitials: string;
  /** The id used ONLY if no user with that `youversionUserId` existed yet. */
  fallbackId: string;
  sessionId: string;
  sessionToken: string;
}

export interface FixtureProject {
  index: number;
  id: string;
  versionId: string;
  ownerIndex: number;
  ownerId: string;
  slug: string;
  name: string;
  repoOwner: string;
  repoName: string;
}

/** Why an item exists. `filler` rows only pad the set out past one page. */
export type FixtureRole =
  | "newest-leader"
  | "trending-leader"
  | "popular-leader"
  | "popular-third"
  | "unlisted-most-upvoted"
  | "unlisted-runner-up"
  | "filler";

export interface FixtureItem {
  index: number;
  id: string;
  renderJobId: string;
  projectId: string;
  versionId: string;
  ownerId: string;
  ownerIndex: number;
  ownerDisplayName: string;
  ownerAvatarInitials: string;
  role: FixtureRole;
  /** Rendered verbatim as the card's display title. */
  title: string;
  /** A fixed-length token unique to this item, embedded in `description`. Because every
   *  token is the same length, an `ILIKE '%token%'` search matches EXACTLY this item. */
  searchToken: string;
  description: string;
  scriptureReference: string;
  /** The USFM code `deriveScriptureBook` yields for `scriptureReference`. Written because
   *  the column is NOT NULL; nothing filters on it (the book filter was removed, §5.2). */
  scriptureBook: string;
  translation: string;
  visibility: "public" | "unlisted";
  ageHours: number;
  publishedAt: Date;
  /** What the card's `mm:ss` badge renders. The seeded MEDIA is 1 s regardless — never
   *  assert `video.duration` against this. */
  durationSeconds: number;
  fps: number;
  /** `durationSeconds * fps`, never 0 (0 means INDETERMINATE and suppresses the badge). */
  framesTotal: number;
  /** Backed by exactly this many real `GalleryUpvote` rows — never a fabricated counter. */
  upvoteCount: number;
  viewerHasUpvoted: boolean;
  voterIndexes: number[];
  videoAssetKey: string;
  thumbnailAssetKey: string;
}

export interface GalleryFixturePlan {
  runId: string;
  now: Date;
  /** A token every fixture description carries, so a spec can scope a text search to THIS
   *  run on a shared dev database. */
  runToken: string;
  idPrefix: string;
  pageSize: number;
  users: FixtureUser[];
  viewer: FixtureViewer;
  projects: FixtureProject[];
  items: FixtureItem[];
  publicItems: FixtureItem[];
  unlistedItems: FixtureItem[];
  /**
   * Expected id order under each sort, derived from the fixture DATA (not from any scoring
   * formula), with the API's `id DESC` tiebreak applied.
   *
   * `trending` is deliberately ABSENT: producing it would mean re-implementing the gravity
   * expression here, and a second copy of a formula is a drift source. Assert the PROPERTY
   * instead — trending's leader is neither `leaders.newest` nor `leaders.popular`, which is
   * exactly plan D3's P5 and needs no constants.
   */
  expectedOrder: {
    newest: string[];
    popular: string[];
  };
  leaders: {
    newest: string | null;
    popular: string | null;
  };
}

export interface SeededGallery extends GalleryFixturePlan {
  /** The viewer, now with its resolved `User.id`. */
  viewer: FixtureViewer & { id: string };
  mediaSeeded: boolean;
}

export interface ClearResult {
  galleryUpvotes: number;
  galleryItems: number;
  renderJobs: number;
  projectVersions: number;
  projects: number;
  sessions: number;
  users: number;
  /** S3 keys attempted (2 per fixture render job). Removal is best-effort. */
  mediaKeys: number;
}

export interface FixtureMediaBlob {
  contentType: string;
  base64: string;
  /** Decoded bytes. Real, playable media — see the module JSDoc for provenance. */
  readonly bytes: Buffer;
}

/** THE prefix every fixture primary key carries. Reviewed constant, never env-derived. */
export const GALLERY_FIXTURE_ID_PREFIX: string;

/** Rows per page in the shipped `GalleryService`. A spec wanting "Load more" needs more
 *  public items than this. */
export const GALLERY_PAGE_SIZE: number;

/** THE HARD GATE: exact prefix, non-empty suffix, closed `[a-z0-9-]` alphabet. Re-checked
 *  at every mutation site. */
export function isGalleryFixtureId(id: unknown): boolean;

/** SHA-256 hex of a raw token — byte-for-byte the API's `hashToken`, i.e. `Session.tokenHash`. */
export function hashSessionToken(raw: string): string;

/** UTC, offset-free, `timestamp(3)`-shaped. Passing a `Date` straight to `pg` instead would
 *  store LOCAL wall-clock time and shift every fixture by the machine's offset. */
export function toPgTimestamp(date: Date | string | number): string;

/** Compose coordinates with the documented env overrides. */
export function resolveGalleryE2eConfig(
  env?: Record<string, string | undefined>,
): GalleryE2eConfig;

/** Pure: `(runId, now, options)` fully determines the result. No DB, no network, no clock. */
export function buildGalleryFixturePlan(
  options?: GalleryFixtureOptions,
): GalleryFixturePlan;

/**
 * Clear prior fixtures (unless `reset: false`), then write users + live sessions, projects,
 * versions, completed render jobs, gallery items and real upvote rows in ONE transaction —
 * and PUT the matching MinIO objects (unless `media: false`).
 */
export function seedGalleryFixtures(options?: SeedOptions): Promise<SeededGallery>;

/** Delete every fixture row (id-gated) and its MinIO objects. Safe in `afterAll`. */
export function clearGalleryFixtures(options?: ClearOptions): Promise<ClearResult>;

/** THROWS if the database holds public gallery items this helper did not write. Never a
 *  `console.warn` + skip — that is a green lie the reporter swallows. */
export function assertNoForeignGalleryItems(
  options?: ConnectionOptions,
): Promise<void>;

/** PUT `renders/{renderJobId}/output.mp4` + `thumb.jpg` for each item. Returns objects written. */
export function putFixtureMedia(
  items: Pick<FixtureItem, "videoAssetKey" | "thumbnailAssetKey">[],
  options?: ConnectionOptions,
): Promise<number>;

/** Best-effort removal. Never throws; ignores ids outside the gate. */
export function deleteFixtureMedia(
  renderJobIds: string[],
  options?: ConnectionOptions,
): Promise<number>;

/**
 * The bytes every fixture render's objects carry: a 1 745 B H.264/AVC MP4 (160×90, 12 fps,
 * 1 s, `moov` before `mdat`) and a 637 B baseline JPEG.
 *
 * They are REAL media because `presignPublicKey` signs locally — `stream-url` returns 200
 * whether or not the object exists, so a missing or bogus object only shows up as a
 * `<video>` stuck at `readyState === 0` and a broken poster in the browser.
 */
export const GALLERY_FIXTURE_MEDIA: {
  video: FixtureMediaBlob;
  thumbnail: FixtureMediaBlob;
};

export { E2E_RUN_ID } from "./e2e-github-naming.mjs";
