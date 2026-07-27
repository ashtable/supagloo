import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE LANE-SCHEMA DDL-SAFETY DRIFT GUARD.
 *
 * `src/testing/dbos-lane-isolation.ts` exists TWICE — once in `supagloo-nodejs-api`, once
 * in `supagloo-nodejs-dbos` — and that duplication is deliberate: routing it through this
 * root checkout would make specs that need no root checkout depend on one.
 *
 * The two files are NOT byte-identical, and must not be. Their headers describe different
 * spec populations and their error strings name different call sites (`makeDbosEnqueuer`
 * vs `DBOSClient`). Prose was never the risk.
 *
 * The risk is the DDL SAFETY LOGIC. `resetLaneSchema` runs
 *
 *     DROP SCHEMA IF EXISTS "<schema>" CASCADE
 *
 * with the schema name INTERPOLATED, and the only thing keeping that statement away from
 * the production `"dbos"` schema — and away from a quote, a semicolon or a silently
 * truncated 64-byte identifier that would re-share one lane's schema with another — is
 * `assertLaneSchemaName` plus the three constants it reads. A copy whose regex was
 * loosened, or whose byte cap was raised past Postgres's real limit, would look exactly
 * like its sibling and would still pass its own repo's unit suite, because each repo only
 * ever tests its own copy. Nothing else in either checkout compares them.
 *
 * So this guard fences exactly that region, delimited by markers in both files, and
 * nothing else. It lives in the ROOT repo because root is the only checkout that can see
 * both siblings — the same reason `e2e-prefix-single-source.test.ts` lives here — and
 * beside the other Compose-level guards for the same reason.
 *
 * Proven by MUTATION rather than by having been red: with
 * `MAX_PG_IDENTIFIER_BYTES` changed from 63 to 62 in ONE copy, this file fails.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SIBLINGS = resolve(ROOT, "..");

const RELATIVE_PATH = "src/testing/dbos-lane-isolation.ts";

const COPIES = [
  { label: "api", dir: resolve(SIBLINGS, "supagloo-nodejs-api") },
  { label: "dbos", dir: resolve(SIBLINGS, "supagloo-nodejs-dbos") },
] as const;

const BEGIN =
  "// --- BEGIN SHARED DDL SAFETY (byte-identical across api + dbos; drift-guarded) ---";
const END = "// --- END SHARED DDL SAFETY ---";

/** Every identifier the fenced region MUST still define. Naming them here is what stops
 *  the guard from being satisfied by an empty or gutted region. */
const REQUIRED_IDENTIFIERS = [
  "DBOS_DEFAULT_SYSTEM_SCHEMA",
  "LANE_SCHEMA_PREFIX",
  "LANE_SCHEMA_SUFFIX_ENV",
  "MAX_PG_IDENTIFIER_BYTES",
  "LANE_SCHEMA_RE",
  "assertLaneSchemaName",
  "laneSystemSchema",
] as const;

interface Copy {
  label: string;
  path: string;
  /** undefined => the checkout or the file is absent. */
  source?: string;
}

const copies: Copy[] = COPIES.map(({ label, dir }) => {
  const path = resolve(dir, RELATIVE_PATH);
  return existsSync(path)
    ? { label, path, source: readFileSync(path, "utf8") }
    : { label, path };
});

/** The text BETWEEN the markers, markers included. Throws with a specific reason rather
 *  than returning something empty that would quietly compare equal. */
function fencedRegion(copy: Copy): string {
  const source = copy.source;
  if (source === undefined) throw new Error(`${copy.label}: no source read`);

  const begins = source.split(BEGIN).length - 1;
  const ends = source.split(END).length - 1;
  if (begins !== 1) {
    throw new Error(
      `${copy.path} has ${begins} BEGIN markers (expected exactly 1). The drift guard ` +
        `cannot fence a region it cannot delimit.`,
    );
  }
  if (ends !== 1) {
    throw new Error(
      `${copy.path} has ${ends} END markers (expected exactly 1).`,
    );
  }
  const from = source.indexOf(BEGIN);
  const to = source.indexOf(END);
  if (to < from) {
    throw new Error(`${copy.path}: the END marker precedes the BEGIN marker.`);
  }
  return source.slice(from, to + END.length);
}

describe("the DBOS lane-schema DDL safety rule is ONE rule in two repos", () => {
  it("finds both sibling checkouts (absent is reported DISTINCTLY from drift)", () => {
    // Separate assertion on purpose: "I could not look" and "they diverged" are different
    // failures with different fixes, and collapsing them lets a missing checkout wear a
    // passing guard's clothes.
    expect(
      copies.filter((c) => c.source === undefined).map((c) => `${c.label}: ${c.path}`),
    ).toEqual([]);
  });

  it("both copies delimit the region with exactly one marker pair", () => {
    for (const copy of copies) {
      expect(() => fencedRegion(copy), copy.path).not.toThrow();
    }
  });

  it("the fenced regions are BYTE-IDENTICAL", () => {
    const [api, dbos] = copies.map(fencedRegion);
    // Compared as text, not as a hash: a failure must SHOW the diverging line, because the
    // fix is always "make one match the other", never "update the expected digest".
    expect(dbos).toBe(api);
  });

  it("the fenced region actually contains the safety rule (an empty fence proves nothing)", () => {
    for (const copy of copies) {
      const region = fencedRegion(copy);
      for (const identifier of REQUIRED_IDENTIFIERS) {
        expect(region, `${copy.path} :: ${identifier}`).toContain(identifier);
      }
      // The live values, spelled out here so that loosening either one in BOTH copies at
      // once — which byte-equality alone would happily accept — still fails.
      expect(region).toContain('export const LANE_SCHEMA_PREFIX = "dbos_e2e_";');
      expect(region).toContain("const MAX_PG_IDENTIFIER_BYTES = 63;");
      expect(region).toContain(
        "const LANE_SCHEMA_RE = new RegExp(`^${LANE_SCHEMA_PREFIX}[a-z0-9_]+$`);",
      );
      expect(region).toContain('export const DBOS_DEFAULT_SYSTEM_SCHEMA = "dbos";');
    }
  });

  it("the interpolated DROP SCHEMA is still gated by that rule in both copies", () => {
    // The region is only worth fencing while it remains the gate. If `resetLaneSchema`
    // ever stops calling `assertLaneSchemaName`, byte-equality would keep passing while
    // the property it protects was gone.
    const STATEMENT =
      'await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);';
    for (const copy of copies) {
      const source = copy.source!;
      expect(source, copy.path).toContain(STATEMENT);
      // The EXECUTABLE statement, not the prose that quotes it in the docblock above.
      const drop = source.indexOf(STATEMENT);
      const gate = source.lastIndexOf("assertLaneSchemaName(schema);", drop);
      expect(
        gate,
        `${copy.path}: no assertLaneSchemaName(schema) call precedes the interpolated DROP SCHEMA`,
      ).toBeGreaterThan(-1);
    }
  });
});
