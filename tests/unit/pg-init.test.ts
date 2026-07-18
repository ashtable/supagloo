import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INIT_SQL = resolve(ROOT, "infra/pg-init/01-create-databases.sql");

/**
 * The Postgres init script mounted at `/docker-entrypoint-initdb.d` is the
 * single source of truth for the two logical databases. `POSTGRES_DB` is pinned
 * to `postgres` in compose so the image does NOT auto-create either db — both
 * must be created here, unconditionally.
 */
describe("pg-init: create-databases.sql", () => {
  const sql = readFileSync(INIT_SQL, "utf8");

  /** Every `CREATE DATABASE <name>;` in the script, lowercased db names. */
  function createdDatabases(source: string): string[] {
    const names: string[] = [];
    const re = /create\s+database\s+("?)(\w+)\1\s*;/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      names.push(m[2].toLowerCase());
    }
    return names;
  }

  it("emits a CREATE DATABASE for the app db `supagloo`", () => {
    expect(createdDatabases(sql)).toContain("supagloo");
  });

  it("emits a CREATE DATABASE for the DBOS system db `supagloo_dbos`", () => {
    expect(createdDatabases(sql)).toContain("supagloo_dbos");
  });

  it("creates exactly those two databases (no more, no fewer)", () => {
    // Sort so order in the file doesn't matter; the `\w+ ;` boundary guarantees
    // the `supagloo` match does not bleed into the `supagloo_dbos` line.
    expect([...createdDatabases(sql)].sort()).toEqual([
      "supagloo",
      "supagloo_dbos",
    ]);
  });
});
