import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * RX-9 — ROOT'S *COMMITTED* CONFIGURATION IS UNPROVEN, AND SAYING SO IS THIS FILE'S JOB.
 *
 * Root's e2e suite is green. It was obtained **only** with the gitignored
 * `docker-compose.override.yml`, which redirects all four build contexts (`migrate`, `api`,
 * `dbos`, `nextjs`) from root's SUBMODULE paths to the sibling `~/code/*` checkouts. That
 * override is legitimate — root's gitlinks are deliberately a later step's job, and Step 8
 * confirmed this is NOT a `feedback-never-fake-submodule-resolution` violation, because
 * db-lib went through a real release chain. But it means nobody has ever run
 * `boot-hardening.e2e.ts` against the trees `docker-compose.yml` actually names, and
 * "releasing on an unproven committed configuration" is the shape that memory forbids
 * trusting.
 *
 * Two ways to handle that. The bad one is a comment in a doc, which nothing reads. This is
 * the other one: an executable gate that
 *
 *   1. requires the procedure to exist, in `docs/release-gate.md`, in order;
 *   2. requires that document's verification claim to be either "not yet verified" or a
 *      list of the EXACT gitlink shas it was verified at — and, if it names shas, requires
 *      them to equal root's gitlinks RIGHT NOW. So the instant a submodule pointer moves, a
 *      stale "verified" claim goes red and has to be re-earned. That is the property; the
 *      rest is bookkeeping;
 *   3. requires, while the claim is "not yet verified", that the override's effect is
 *      disclosed next to root's e2e suite rather than left for a reader to discover.
 *
 * It does NOT try to run the rebuild. That costs four `--no-cache` image builds on the
 * user's machine, it must happen after item 8's fix, and it is explicitly Step 13's work
 * (D8). The gate's job is to make sure Step 13 cannot quietly skip it.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE_DOC = resolve(ROOT, "docs/release-gate.md");
const SUBMODULES = ["supagloo-nextjs", "supagloo-nodejs-api", "supagloo-nodejs-dbos"] as const;

/** Root's committed gitlink for each code submodule, from the index — not from the checkout. */
function committedGitlinks(): Record<string, string> {
  const out = execFileSync("git", ["ls-tree", "HEAD", ...SUBMODULES], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const map: Record<string, string> = {};
  for (const line of out.trim().split("\n")) {
    const m = /^\d+ commit ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (m) map[m[2]] = m[1];
  }
  return map;
}

describe("RX-9 — the committed-configuration gate exists and is written down", () => {
  it("docs/release-gate.md exists", () => {
    expect(existsSync(GATE_DOC) ? "" : GATE_DOC).toBe("");
  });

  const doc = () => readFileSync(GATE_DOC, "utf8");

  it("names every step of the procedure, in order", () => {
    // Scoped to §2. §1 legitimately mentions E-BH8 earlier, while explaining WHY the
    // rebuild has to happen after item 8 — an ordering rule over the whole file would ban
    // the explanation, the same self-defeating-guard shape db-lib's U-CON-DOC hit.
    const whole = doc();
    const from = whole.indexOf("## 2. The procedure");
    const to = whole.indexOf("## 3. The record");
    expect(from, "docs/release-gate.md has no `## 2. The procedure`").toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const d = whole.slice(from, to);
    const steps = [
      /move\s+`?docker-compose\.override\.yml`?\s+aside/i,
      /--no-cache/,
      /npm run test:e2e/,
      /E-BH8/,
    ];
    let cursor = -1;
    for (const step of steps) {
      const idx = d.search(step);
      expect(idx, `docs/release-gate.md is missing or misorders ${step}`).toBeGreaterThan(
        cursor,
      );
      cursor = idx;
    }
  });

  it("names all four services that must be rebuilt from the committed contexts", () => {
    const d = doc();
    for (const service of ["migrate", "api", "dbos", "nextjs"]) {
      expect(d, `release-gate.md does not name the ${service} service`).toContain(service);
    }
  });

  it("says WHY, naming the override and root's gitlinks", () => {
    expect(doc()).toContain("docker-compose.override.yml");
    expect(doc()).toMatch(/gitlink/i);
    expect(doc()).toMatch(/feedback-never-fake-submodule-resolution/);
  });
});

describe("RX-9 — the verification claim cannot go stale silently", () => {
  const MARKER = /^COMMITTED-CONFIG VERIFIED AT:[ \t]*(.+)$/m;

  it("carries exactly one parseable verification marker", () => {
    const matches = readFileSync(GATE_DOC, "utf8").match(
      /^COMMITTED-CONFIG VERIFIED AT:.*$/gm,
    );
    expect(matches, "docs/release-gate.md has no COMMITTED-CONFIG VERIFIED AT: line").not
      .toBeNull();
    expect(matches!.length).toBe(1);
  });

  it("either says not-yet, or names shas equal to root's CURRENT gitlinks", () => {
    const claim = MARKER.exec(readFileSync(GATE_DOC, "utf8"))![1].trim();
    if (/^not-yet$/i.test(claim)) {
      // The honest state before Step 13. Nothing further to check here; the disclosure case
      // below is what keeps this from being a free pass.
      return;
    }
    const claimed = claim.split(/[\s,]+/).filter(Boolean);
    const actual = committedGitlinks();
    expect(
      claimed.length,
      `expected one sha per submodule (${SUBMODULES.length}), got "${claim}"`,
    ).toBe(SUBMODULES.length);
    // Order-insensitive: what matters is that the claim is about THESE trees.
    expect([...claimed].sort()).toEqual([...Object.values(actual)].sort());
  });

  it("while unverified, discloses the override's effect where root's e2e green is claimed", () => {
    const claim = MARKER.exec(readFileSync(GATE_DOC, "utf8"))![1].trim();
    if (!/^not-yet$/i.test(claim)) return;
    // The disclosure has to sit in the suite whose green is qualified, not only in a doc a
    // release step might not open.
    const spec = readFileSync(resolve(ROOT, "tests/e2e/boot-hardening.e2e.ts"), "utf8");
    expect(spec).toContain("docker-compose.override.yml");
    expect(spec).toContain("docs/release-gate.md");
  });
});

describe("RX-9 — the committed build contexts really are the submodules", () => {
  it("docker-compose.yml names the in-repo submodule path for all four services", () => {
    // If this ever drifted to `../`, the gate above would be guarding nothing: root's
    // committed configuration would BE the sibling checkouts.
    const compose = readFileSync(resolve(ROOT, "docker-compose.yml"), "utf8");
    for (const ctx of [
      "./supagloo-nodejs-api",
      "./supagloo-nodejs-dbos",
      "./supagloo-nextjs",
    ]) {
      expect(compose).toContain(`context: ${ctx}`);
    }
    expect(compose).not.toMatch(/context:\s*\.\.\//);
  });

  it("the override is gitignored, so it can never become the committed configuration", () => {
    const ignored = execFileSync(
      "git",
      ["check-ignore", "-q", "docker-compose.override.yml"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(ignored).toBe("");
  });
});
