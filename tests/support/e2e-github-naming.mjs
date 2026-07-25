import { randomBytes } from "node:crypto";

/**
 * THE SINGLE SOURCE OF TRUTH for e2e GitHub fixture-repo naming.
 * ==============================================================
 *
 * Task 62 / design-delta §11 (D1). This file is the ONLY authored place in ANY of the
 * four Code Locations (root, api, dbos, nextjs) that spells out the throwaway-repo
 * prefix. api / dbos / nextjs reach it by dynamic-importing this exact path through the
 * established root-resolution seam:
 *
 *   const rootDir = process.env.SUPAGLOO_ROOT_DIR ?? resolve(<repoRoot>, "..", "supagloo");
 *   const naming  = await import(pathToFileURL(join(rootDir, "tests/support/e2e-github-naming.mjs")).href);
 *
 * and `scripts/cleanup-e2e-repos.mjs` imports `isE2eRepoName` from here.
 *
 * WHY IT IS A CONSTANT AND NOT AN ENV VAR
 * ---------------------------------------
 * The install target is `ashtable` — a PERSONAL GitHub account that also holds the
 * user's REAL repos (supagloo-nextjs, supagloo-nodejs-api, supagloo-nodejs-dbos,
 * supagloo-database-lib). The cleanup script ARCHIVES what this prefix matches. A
 * mistyped `SUPAGLOO_E2E_REPO_PREFIX=supagloo-` in someone's `.env` would make the gate
 * match `supagloo-nextjs`. The gate must therefore be reviewed code, never env-derived.
 *
 * Zero dependencies, plain ESM, no build step — that is what makes it still work from a
 * TypeScript test, a `.mjs` script and three sibling repos at once, in six months.
 *
 * `tests/unit/e2e-prefix-single-source.test.ts` greps all four checkouts and fails if
 * this literal ever appears in a second code file.
 */

/** THE prefix. Trailing `-` is load-bearing: it stops a match swallowing a real name. */
export const E2E_REPO_PREFIX = "supagloo-e2e-delete-me-";

/** GitHub's hard limit on a repository name. */
export const MAX_REPO_NAME_LENGTH = 100;

/** Characters GitHub accepts in a repository name (it silently rewrites anything else). */
const LEGAL_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * One run id per PROCESS: `<base36 ms><8 random hex>`.
 *
 * The timestamp makes a run's repos sort together and be human-datable in the GitHub UI;
 * the random half means two vitest workers starting in the same millisecond cannot
 * collide (real GitHub 422s a duplicate repo name — the retired stub did not).
 *
 * D7: repo names MUST be per-run. The scaffold workflow's v0.0.0 base commit is
 * byte-deterministic by design, so a REUSED fixture repo rejects a second run's push.
 * Any "cache the fixture repo" optimisation silently reintroduces that failure.
 */
export const E2E_RUN_ID = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

/**
 * Lowercase, collapse every illegal run to a single `-`, trim stray separators.
 * Returns "" when nothing legal survives — callers must treat that as an error.
 */
export function sanitizeSegment(segment) {
  if (typeof segment !== "string") return "";
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `${E2E_REPO_PREFIX}${slug}-${runId}`, sanitised and capped at 100 chars.
 *
 * Truncation eats the SLUG, never the runId: the runId is what keeps concurrent runs
 * collision-free and what groups a run's repos for cleanup.
 *
 * Throws rather than emitting a malformed name — a repo-name 422 from real GitHub is
 * FATAL and never retried (D6), so producing a bad name here must fail loudly at the
 * call site instead of 20 lines later inside an HTTP error.
 */
export function buildE2eRepoName(slug, runId = E2E_RUN_ID) {
  const cleanSlug = sanitizeSegment(slug);
  const cleanRun = sanitizeSegment(runId);
  if (!cleanSlug) {
    throw new Error(
      `buildE2eRepoName: slug ${JSON.stringify(slug)} sanitises to nothing — ` +
        "pass a spec-identifying slug such as \"render\" or \"manifest\".",
    );
  }
  if (!cleanRun) {
    throw new Error(
      `buildE2eRepoName: runId ${JSON.stringify(runId)} sanitises to nothing — ` +
        "pass E2E_RUN_ID (the default) or another alphanumeric id.",
    );
  }

  const suffix = `-${cleanRun}`;
  const budget = MAX_REPO_NAME_LENGTH - E2E_REPO_PREFIX.length - suffix.length;
  if (budget < 1) {
    throw new Error(
      `buildE2eRepoName: runId ${JSON.stringify(cleanRun)} leaves no room for a slug ` +
        `inside GitHub's ${MAX_REPO_NAME_LENGTH}-character repo-name limit.`,
    );
  }
  const name = `${E2E_REPO_PREFIX}${cleanSlug.slice(0, budget).replace(/-+$/, "")}${suffix}`;

  // Belt and braces: the generator can never emit something the gate would reject,
  // because a name the gate rejects is a repo cleanup can never reclaim.
  if (!isE2eRepoName(name)) {
    throw new Error(
      `buildE2eRepoName produced ${JSON.stringify(name)}, which its own gate rejects — ` +
        "this is a bug in e2e-github-naming.mjs, not in the caller.",
    );
  }
  return name;
}

/**
 * THE HARD GATE.
 *
 * Exact-prefix, CASE-SENSITIVE, requires a non-empty suffix, and requires the whole
 * name to be a legal GitHub repo name (so no slash, no `..`, no whitespace can ride
 * through into a `PATCH /repos/:owner/:repo` path).
 *
 * Re-checked at the cleanup script's MUTATION SITE, immediately before the PATCH — the
 * point being that the prefix is a code invariant there, not a filtering side effect.
 * A name that fails this is NEVER actioned, even if the user typed "yes".
 */
export function isE2eRepoName(name) {
  if (typeof name !== "string") return false;
  if (!name.startsWith(E2E_REPO_PREFIX)) return false;
  if (name.length <= E2E_REPO_PREFIX.length) return false;
  if (name.length > MAX_REPO_NAME_LENGTH) return false;
  return LEGAL_NAME.test(name);
}

/**
 * The stamped description every fixture repo carries, so a human scanning the account
 * (or the cleanup script's listing) can tell at a glance what made it and when.
 */
export function buildE2eRepoDescription(spec, runId = E2E_RUN_ID) {
  return `Supagloo e2e throwaway · run ${runId} · ${spec} · ${new Date().toISOString()} · safe to archive`;
}
