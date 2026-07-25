import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { E2E_REPO_PREFIX } from "../support/e2e-github-naming.mjs";

// Task 62 / §11 (D1) — THE ANTI-DRIFT GUARD.
//
// The throwaway-repo name prefix must exist as a VALUE in exactly ONE authored code
// file across all four checkouts: `tests/support/e2e-github-naming.mjs` in THIS repo.
// api, dbos and nextjs dynamic-import it through the `SUPAGLOO_ROOT_DIR ?? ../supagloo`
// seam; `scripts/cleanup-e2e-repos.mjs` imports `isE2eRepoName` from it.
//
// Why a grep test and not a code-review convention: the cleanup script ARCHIVES what
// that prefix matches, in a personal account that also holds the user's REAL repos. A
// spec that created repos under a re-typed, subtly different prefix would silently stop
// being matched by cleanup (leaking repos forever) — or worse, a re-typed `supagloo-`
// would make the gate match `supagloo-nextjs`. The gate must be reviewed code with ONE
// source.
//
// COMMENTS ARE NOT DRIFT. A header comment that names the convention so a reader knows
// what to look for in the GitHub UI is documentation: nothing executes it, and it cannot
// diverge in a way that changes behaviour. The guard therefore classifies each hit by
// whether its LINE is a comment line, and only flags occurrences that could be values.
// A smuggled `const p = "…"; // looks innocent` is still flagged, because that line does
// not START with a comment marker.
//
// This file greps for the IMPORTED constant, so the guard's own source contains no
// literal of its own.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SIBLINGS = resolve(ROOT, "..");

/** The four Code Locations, by their CANONICAL checkout paths (never the submodule copies). */
const CHECKOUTS: Array<{ label: string; dir: string }> = [
  { label: "root (supagloo)", dir: ROOT },
  { label: "nextjs", dir: resolve(SIBLINGS, "supagloo-nextjs") },
  { label: "api", dir: resolve(SIBLINGS, "supagloo-nodejs-api") },
  { label: "dbos", dir: resolve(SIBLINGS, "supagloo-nodejs-dbos") },
];

/** The ONE authored code file permitted to contain the literal as a value (root repo only). */
const SINGLE_SOURCE = "tests/support/e2e-github-naming.mjs";

/** Documentation files may name the prefix freely — nothing executes them. */
function isDocumentation(path: string): boolean {
  return (
    path === ".env.example" ||
    path.startsWith("docs/") ||
    path.startsWith(".claude/") ||
    path.endsWith(".md")
  );
}

/** A line whose first non-space characters open a comment carries prose, not a value. */
function isCommentLine(text: string): boolean {
  return /^\s*(\/\/|\/\*|\*|#|<!--)/.test(text);
}

interface Hit {
  path: string;
  line: number;
  text: string;
}
interface GrepResult {
  label: string;
  dir: string;
  /** undefined => not a git checkout (absent / submodule not initialised). */
  hits?: Hit[];
}

function grepCheckout({ label, dir }: { label: string; dir: string }): GrepResult {
  if (!existsSync(dir) || !existsSync(resolve(dir, ".git"))) {
    return { label, dir };
  }
  let stdout = "";
  try {
    // -F: fixed string (today's prefix has no regex metacharacters, but a future one
    // must not become a pattern). -I: skip binaries. Case-SENSITIVE, like the gate
    // itself. `git grep` does not recurse into submodules, so the vendored copies under
    // the root repo are never double-counted.
    //
    // `--untracked` is LOAD-BEARING, not a nicety. Without it `git grep` sees only
    // COMMITTED files, so every brand-new helper — and the three peer `github-e2e.ts`
    // adapters are exactly that, the files likeliest to re-type the prefix — would be
    // invisible until someone remembered to `git add` it. That is a guard whose green is
    // strongest precisely when the risk is lowest, which is backwards. `--untracked` still
    // honours `.gitignore`, so `node_modules/`, build output and `scratch/` stay excluded.
    stdout = execFileSync(
      "git",
      ["-C", dir, "grep", "-I", "-n", "-F", "--untracked", "-e", E2E_REPO_PREFIX],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (err) {
    // git grep exits 1 with no output when there is no match — that is a clean zero.
    const status = (err as { status?: number }).status;
    if (status !== 1) throw err;
  }
  const hits: Hit[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw.trim()) continue;
    const m = /^([^:]+):(\d+):(.*)$/.exec(raw);
    if (!m) continue;
    hits.push({ path: m[1], line: Number(m[2]), text: m[3] });
  }
  return { label, dir, hits };
}

const results = CHECKOUTS.map(grepCheckout);

describe("the e2e repo-name prefix has ONE source (D1)", () => {
  it("finds all four checkouts (missing/uninitialised is reported DISTINCTLY from drift)", () => {
    // Reported separately on purpose: "I could not look" and "the literal drifted" are
    // different failures with different fixes, and collapsing them would let a missing
    // checkout masquerade as a passing guard.
    const unavailable = results.filter((r) => r.hits === undefined);
    expect(
      unavailable.map(
        (r) => `${r.label}: checkout not present / not a git checkout at ${r.dir}`,
      ),
    ).toEqual([]);
  });

  it("uses the literal as a VALUE in exactly one authored code file, in the root repo", () => {
    const drifted: string[] = [];
    for (const { label, dir, hits } of results) {
      for (const hit of hits ?? []) {
        if (isDocumentation(hit.path)) continue;
        if (isCommentLine(hit.text)) continue;
        if (dir === ROOT && hit.path === SINGLE_SOURCE) continue;
        drifted.push(`${label}: ${hit.path}:${hit.line}`);
      }
    }
    expect(drifted).toEqual([]);
  });

  it("the single source actually exists and is where the guard says it is", () => {
    expect(existsSync(resolve(ROOT, SINGLE_SOURCE))).toBe(true);
    const rootValueHits = (results.find((r) => r.dir === ROOT)?.hits ?? []).filter(
      (h) => !isCommentLine(h.text),
    );
    expect(rootValueHits.map((h) => h.path)).toContain(SINGLE_SOURCE);
  });

  it("no peer checkout uses the literal as a value at all — they import it", () => {
    const peerValues = results
      .filter((r) => r.dir !== ROOT)
      .flatMap((r) =>
        (r.hits ?? [])
          .filter((h) => !isDocumentation(h.path) && !isCommentLine(h.text))
          .map((h) => `${r.label}: ${h.path}:${h.line}`),
      );
    expect(peerValues).toEqual([]);
  });
});
