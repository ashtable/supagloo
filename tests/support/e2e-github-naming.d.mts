/**
 * Type contract for `e2e-github-naming.mjs` (design-delta §11 / D1).
 *
 * The implementation is deliberately plain, zero-dependency, un-built ESM so that root,
 * api, dbos and nextjs can all dynamic-import the SAME file at runtime. This declaration
 * file exists so TypeScript consumers get real types without a build step — and it
 * doubles as the published contract for the three peer adapters.
 */

/** The one and only throwaway-repo name prefix. Trailing separator included. */
export const E2E_REPO_PREFIX: string;

/** GitHub's hard limit on a repository name (100). */
export const MAX_REPO_NAME_LENGTH: number;

/** One run id per PROCESS, so a run's repos group together and cannot collide. */
export const E2E_RUN_ID: string;

/** Lowercase + collapse illegal runs to `-` + trim. Returns "" if nothing survives. */
export function sanitizeSegment(segment: unknown): string;

/**
 * `${E2E_REPO_PREFIX}${slug}-${runId}`, sanitised and capped at 100 chars (truncation
 * eats the slug, never the runId). Throws rather than emitting a malformed name.
 */
export function buildE2eRepoName(slug: string, runId?: string): string;

/**
 * THE HARD GATE: exact-prefix, case-SENSITIVE, non-empty suffix, legal GitHub repo name.
 * Re-checked at the cleanup script's mutation site.
 */
export function isE2eRepoName(name: unknown): boolean;

/** The stamped `description` every fixture repo carries. */
export function buildE2eRepoDescription(spec: string, runId?: string): string;
