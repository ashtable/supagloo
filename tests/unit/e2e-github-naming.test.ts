import { describe, expect, it } from "vitest";
import {
  E2E_REPO_PREFIX,
  E2E_RUN_ID,
  MAX_REPO_NAME_LENGTH,
  buildE2eRepoName,
  isE2eRepoName,
} from "../support/e2e-github-naming.mjs";

// Task 62 / §11 (D1). `tests/support/e2e-github-naming.mjs` is the ONE authored home
// of the `supagloo-e2e-delete-me-` literal. Every fixture name in THIS file is built
// from the imported constant on purpose: re-typing the literal here would defeat
// `e2e-prefix-single-source.test.ts`, which greps all four checkouts for it.
//
// Why the gate matters more than usual: the install target is `ashtable`, a PERSONAL
// account that also holds the user's REAL repos (supagloo-nextjs, supagloo-nodejs-api,
// …). `isE2eRepoName` is re-checked at the cleanup script's MUTATION SITE, so a
// false positive here is the difference between archiving a throwaway and archiving
// something real.

describe("E2E_REPO_PREFIX", () => {
  it("ends with a separator so a prefix match cannot swallow a real repo name", () => {
    // Without the trailing `-`, `startsWith` would match e.g. a hypothetical
    // `supagloo-e2e-delete-menu` — and more importantly the prefix is what the
    // human reads in the GitHub UI before typing "yes".
    expect(E2E_REPO_PREFIX.endsWith("-")).toBe(true);
    expect(E2E_REPO_PREFIX).toBe(E2E_REPO_PREFIX.toLowerCase());
  });
});

describe("isE2eRepoName — THE HARD GATE", () => {
  it.each([
    ["the bare product name", "supagloo"],
    ["a real sibling repo", "supagloo-nextjs"],
    ["another real sibling repo", "supagloo-nodejs-api"],
    ["a TRUNCATED prefix", E2E_REPO_PREFIX.replace(/-me-$/, "")],
    ["the prefix with no suffix at all", E2E_REPO_PREFIX],
    ["a case-shifted prefix (match is case-SENSITIVE)", `${E2E_REPO_PREFIX.toUpperCase()}x`],
    ["the empty string", ""],
    ["the prefix embedded but not leading", `x-${E2E_REPO_PREFIX}y`],
    ["a whitespace-padded prefix", ` ${E2E_REPO_PREFIX}x`],
    ["a path-traversal-shaped name", `${E2E_REPO_PREFIX}a/../real-repo`],
  ])("rejects %s", (_label, name) => {
    expect(isE2eRepoName(name)).toBe(false);
  });

  it.each([undefined, null, 42, {}, [], `${E2E_REPO_PREFIX}x`.split("")])(
    "rejects the non-string %s",
    (value) => {
      expect(isE2eRepoName(value as unknown as string)).toBe(false);
    },
  );

  it("accepts a well-formed generated name", () => {
    expect(isE2eRepoName(`${E2E_REPO_PREFIX}render-abc`)).toBe(true);
  });

  it("accepts every name buildE2eRepoName can produce", () => {
    for (const slug of ["render", "manifest", "Psalm 121!", "x".repeat(200)]) {
      expect(isE2eRepoName(buildE2eRepoName(slug, "k3f9a2"))).toBe(true);
    }
  });
});

describe("buildE2eRepoName", () => {
  it("composes prefix + slug + runId", () => {
    expect(buildE2eRepoName("render", "k3f9a2")).toBe(
      `${E2E_REPO_PREFIX}render-k3f9a2`,
    );
  });

  it("sanitises a slug into a legal GitHub repo segment", () => {
    expect(buildE2eRepoName("Psalm 121!", "K3F9")).toBe(
      `${E2E_REPO_PREFIX}psalm-121-k3f9`,
    );
  });

  it("collapses runs of illegal characters instead of emitting empty segments", () => {
    expect(buildE2eRepoName("a  ///  b", "r1")).toBe(`${E2E_REPO_PREFIX}a-b-r1`);
  });

  it("respects GitHub's 100-character repo-name limit while keeping the runId intact", () => {
    // The runId is what makes concurrent runs collision-free and what groups a
    // run's repos for cleanup, so truncation must eat the SLUG, never the runId.
    const name = buildE2eRepoName("s".repeat(300), "k3f9a2");
    expect(MAX_REPO_NAME_LENGTH).toBe(100);
    expect(name.length).toBeLessThanOrEqual(MAX_REPO_NAME_LENGTH);
    expect(name.endsWith("-k3f9a2")).toBe(true);
    expect(isE2eRepoName(name)).toBe(true);
  });

  it.each([
    ["an empty slug", "", "r1"],
    ["a slug that sanitises to nothing", "///", "r1"],
    ["an empty runId", "render", ""],
    ["a runId that sanitises to nothing", "render", "!!!"],
  ])("throws on %s rather than emitting a malformed name", (_label, slug, runId) => {
    expect(() => buildE2eRepoName(slug, runId)).toThrow();
  });
});

describe("E2E_RUN_ID", () => {
  it("is a non-empty lowercase alphanumeric id", () => {
    expect(E2E_RUN_ID).toMatch(/^[a-z0-9]+$/);
    expect(E2E_RUN_ID.length).toBeGreaterThanOrEqual(8);
  });

  it("is stable within a process (module-level, so a run's repos group together)", async () => {
    const again = await import("../support/e2e-github-naming.mjs");
    expect(again.E2E_RUN_ID).toBe(E2E_RUN_ID);
  });
});
