import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE DBOS CLIENT/WORKER SDK PIN — plan row 45, widened in Step 11 by RX-3.
 *
 * Three processes speak DBOS's wire protocol against ONE `supagloo_dbos` system database:
 * the containerised WORKER (which created and migrated the schema), the API (which
 * ENQUEUES into it on `POST /v1/projects` — the production, user-facing path), and root's
 * `scripts/render-load.mjs` load harness. They are not three independent dependencies that
 * happen to share a name; they are three halves of one wire protocol plus one table layout,
 * and the table layout is versioned by whichever side ran its migrations first.
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
 * RX-3, and why this file no longer checks only root. As authored, it compared ROOT's
 * declared spec against the DBOS CHECKOUT'S LOCKFILE, so neither consumer's own declared
 * spec was pinned or checked — and both were `^4.23.6`. That guarded the load harness (one
 * laptop, occasionally) while leaving the api's production enqueue path free to re-resolve
 * the caret on the next `npm install <anything>` and reproduce the measured break on a real
 * user request, with all of api's unit tests green (they mock the client) and this file
 * green (it never looked at api).
 *
 * So: every one of the three DECLARED specs must be exact, and all three must be equal.
 * A declared spec is the thing an `npm install` re-resolves, which is the thing that broke.
 *
 * R45-2 CORRECTION to this file's own earlier reasoning. It used to say the dbos lockfile
 * "is literally what the running container was built from". That is not something this repo
 * can know: the gitignored `docker-compose.override.yml` decides whether the image is built
 * from the SUBMODULE (`./supagloo-nodejs-dbos`) or from the SIBLING checkout
 * (`../supagloo-nodejs-dbos`), and Step 8's M13 confirmed the two trees DIFFERED. The
 * lockfile check below is therefore a genuine but SECONDARY drift check over whichever
 * sibling checkout is present; the declared-spec equality above is the property that does
 * not depend on which tree was built. (`scripts/render-load.mjs` reads the RUNNING queue
 * configuration out of the built image for exactly this reason.)
 *
 * This lives in the root repo for the same reason `e2e-prefix-single-source.test.ts` and
 * `dbos-lane-isolation-drift.test.ts` do: root is the only checkout that can see all sides.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SIBLINGS = resolve(ROOT, "..");
const DBOS_CHECKOUT = resolve(SIBLINGS, "supagloo-nodejs-dbos");

const PACKAGE = "@dbos-inc/dbos-sdk";
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
interface PackageLock {
  packages?: Record<string, { version?: string }>;
}

/** The three declarers, each described by WHAT IT DOES with the SDK — that is the reason
 *  each one has to be pinned, and it is what a future reader needs in the failure message. */
const DECLARERS = [
  {
    label: "root",
    dir: ROOT,
    role: "enqueues from scripts/render-load.mjs into the worker-owned `dbos` schema",
  },
  {
    label: "api",
    dir: resolve(SIBLINGS, "supagloo-nodejs-api"),
    role: "enqueues on POST /v1/projects — the PRODUCTION path, a user request (RX-3)",
  },
  {
    label: "dbos",
    dir: DBOS_CHECKOUT,
    role: "the worker: it CREATED and migrated the schema the other two write into",
  },
] as const;

function declaredSpec(dir: string): string | undefined {
  const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as PackageJson;
  return pkg.devDependencies?.[PACKAGE] ?? pkg.dependencies?.[PACKAGE];
}

describe(`all three ${PACKAGE} declarers are pinned to ONE exact version`, () => {
  it.each(DECLARERS)("$label finds its checkout (absent is DISTINCT from drift)", ({ dir }) => {
    // "I could not look" and "they diverged" are different failures with different fixes.
    const pkg = resolve(dir, "package.json");
    expect(existsSync(pkg) ? "" : pkg).toBe("");
  });

  it.each(DECLARERS)("$label declares the package at all", ({ dir, role }) => {
    expect(declaredSpec(dir), `${PACKAGE} is missing — this checkout ${role}`).toBeDefined();
  });

  it.each(DECLARERS)("$label declares an EXACT version, never a range", ({ dir, role }) => {
    // A caret is what produced the measured failure above: `npm install` months apart
    // yields two different clients against one unchanged worker.
    const spec = declaredSpec(dir);
    expect(spec, `declared as "${spec}" — this checkout ${role}`).toMatch(EXACT_SEMVER);
  });

  it("all three declare the SAME version", () => {
    const specs = DECLARERS.map(({ label, dir }) => `${label}=${declaredSpec(dir)}`);
    const distinct = new Set(DECLARERS.map(({ dir }) => declaredSpec(dir)));
    expect(distinct.size, `declared specs disagree: ${specs.join(" ")}`).toBe(1);
  });
});

describe(`${PACKAGE} — secondary drift checks`, () => {
  it("finds the dbos checkout's lockfile (absent is reported DISTINCTLY from drift)", () => {
    const lock = resolve(DBOS_CHECKOUT, "package-lock.json");
    expect(existsSync(lock) ? "" : lock).toBe("");
  });

  it("matches the version the dbos checkout's lockfile resolves", () => {
    // SECONDARY (see the R45-2 note in the header): this is the sibling checkout's lock,
    // which is what `docker compose build dbos` installs from ONLY while
    // docker-compose.override.yml redirects the build context there. It is still worth
    // asserting — a declared spec that no lockfile resolves is a spec nothing installs.
    const lock = JSON.parse(
      readFileSync(resolve(DBOS_CHECKOUT, "package-lock.json"), "utf8"),
    ) as PackageLock;
    const entry = lock.packages?.[`node_modules/${PACKAGE}`];
    expect(entry?.version, `${PACKAGE} not found in the dbos lockfile`).toBeDefined();
    expect(declaredSpec(ROOT)).toBe(entry!.version);
  });

  it("has that exact version INSTALLED in root, so the harness runs what it declares", () => {
    const installed = JSON.parse(
      readFileSync(resolve(ROOT, "node_modules", PACKAGE, "package.json"), "utf8"),
    ) as { version: string };
    expect(installed.version).toBe(declaredSpec(ROOT));
  });
});
