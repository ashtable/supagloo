import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE DBOS CLIENT/WORKER SDK PIN — plan row 45.
 *
 * `scripts/render-load.mjs` enqueues with `DBOSClient` from THIS repo's `node_modules`,
 * into the same `supagloo_dbos` system database the CONTAINERISED worker owns. The worker
 * created that schema; the client only writes into it. So the two are not independent
 * dependencies that merely happen to share a name — they are two halves of one wire
 * protocol plus one table layout, and the table layout is versioned by whichever side ran
 * its migrations first.
 *
 * MEASURED, and the reason this file exists. Root first declared `^4.23.6`, which resolved
 * to 4.24.16 while the worker image was built from 4.23.6. The enqueue failed with:
 *
 *     column "debounce_deadline_epoch_ms" of relation "workflow_status" does not exist
 *
 * i.e. the newer client wrote a column the older worker's schema had never created. That
 * is a benign-looking caret away from a much worse outcome — a version pair that differs
 * only in a nullable column would ACCEPT the enqueue and then behave subtly differently.
 *
 * The fix is a pin, and a pin without a guard is a comment. Root's declared version must be
 * EXACT (no `^`, no `~`, no range) and must equal the version in the dbos checkout's
 * `package-lock.json` — the lock is the authority because the dbos `Dockerfile` installs
 * with `npm ci`, so the lock is literally what the running container was built from.
 *
 * This lives in the root repo for the same reason `e2e-prefix-single-source.test.ts` and
 * `dbos-lane-isolation-drift.test.ts` do: root is the only checkout that can see both
 * sides.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DBOS_CHECKOUT = resolve(ROOT, "..", "supagloo-nodejs-dbos");

const PACKAGE = "@dbos-inc/dbos-sdk";
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
interface PackageLock {
  packages?: Record<string, { version?: string }>;
}

const rootPkg = JSON.parse(
  readFileSync(resolve(ROOT, "package.json"), "utf8"),
) as PackageJson;

const rootSpec =
  rootPkg.devDependencies?.[PACKAGE] ?? rootPkg.dependencies?.[PACKAGE];

describe(`root pins ${PACKAGE} to the worker's exact version`, () => {
  it("declares the package at all (the load harness cannot enqueue without it)", () => {
    expect(rootSpec).toBeDefined();
  });

  it("declares an EXACT version, never a range", () => {
    // A caret is what produced the measured failure above: `npm install` months apart
    // yields two different clients against one unchanged worker.
    expect(rootSpec, `${PACKAGE} is declared as "${rootSpec}"`).toMatch(EXACT_SEMVER);
  });

  it("finds the dbos checkout's lockfile (absent is reported DISTINCTLY from drift)", () => {
    // "I could not look" and "they diverged" are different failures with different fixes.
    const lock = resolve(DBOS_CHECKOUT, "package-lock.json");
    expect(existsSync(lock) ? "" : lock).toBe("");
  });

  it("matches the version the dbos container was built from", () => {
    const lock = JSON.parse(
      readFileSync(resolve(DBOS_CHECKOUT, "package-lock.json"), "utf8"),
    ) as PackageLock;
    const entry = lock.packages?.[`node_modules/${PACKAGE}`];
    expect(entry?.version, `${PACKAGE} not found in the dbos lockfile`).toBeDefined();
    expect(rootSpec).toBe(entry!.version);
  });

  it("has that exact version INSTALLED here, so the harness runs what it declares", () => {
    const installed = JSON.parse(
      readFileSync(resolve(ROOT, "node_modules", PACKAGE, "package.json"), "utf8"),
    ) as { version: string };
    expect(installed.version).toBe(rootSpec);
  });
});
