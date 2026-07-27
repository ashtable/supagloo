import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { PG } from "../support/dev-config";

/**
 * E2E: the CONTAINERIZED dbos worker booted against THIS Compose stack.
 *
 * Task 62 / §11 (D23) closes F1/F4's root-level blind spot: until now nothing at the
 * root level proved the `dbos` service ran at all. Every git-ops and render workflow
 * the nextjs real-stack specs depend on is dispatched by that worker, so "the stack is
 * up" without it is a green lie — a crash-looping worker (bad GITHUB_APP_PRIVATE_KEY,
 * missing SECRETS_ENCRYPTION_KEY) leaves the api healthy and every enqueue hanging
 * until a multi-minute UI timeout, four layers from the cause.
 *
 * The proof is deliberately the cheapest honest one available to root (whose only db
 * dependency is `pg`): `launchDbos` idempotently creates the self-managed `noop_proof`
 * table in the APP db before it starts polling queues
 * (supagloo-nodejs-dbos/src/db/app-db.ts `ensureNoopProofTable`, called from
 * `src/dbos/runtime.ts`). The table is NOT part of db-lib's Prisma schema and no
 * migration creates it, so its presence can only mean the worker's launch path ran.
 *
 * Scope limit, stated: this proves the worker BOOTED, not that its queues are
 * draining. Queue-drain proof belongs to the dbos repo's own e2e suites, which assert
 * against the DBOS system db.
 */
describe("Compose dbos worker: launched against this stack", () => {
  const clients: Client[] = [];

  async function connect(connectionString: string): Promise<Client> {
    const client = new Client({ connectionString });
    await client.connect();
    clients.push(client);
    return client;
  }

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
  });

  it("created the self-managed `noop_proof` table in the app db", async () => {
    const app = await connect(PG.appUrl);
    const { rows } = await app.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'noop_proof'`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(["noop_proof"]);
  });

  /**
   * The SDK's DEFAULT system schema — the one the CONTAINER's runtime uses, because
   * nothing in the Compose stack sets `DBOS_SYSTEM_DATABASE_SCHEMA`. Every e2e LANE
   * schema (`dbos_e2e_*`) is deliberately NOT this one; see the discrimination test.
   */
  const DBOS_SYSTEM_SCHEMA = "dbos";

  /**
   * Registered queues in `<schema>.queues`.
   *
   * `tableExists` and `names` are reported separately because they answer different
   * questions with different fixes: no table means the SDK's system migrations never
   * ran at all, an empty table means they ran but no runtime launched on top of them.
   */
  async function registeredQueues(
    db: Client,
    schema: string,
  ): Promise<{ tableExists: boolean; names: string[] }> {
    const reg = await db.query<{ reg: string | null }>(
      "SELECT to_regclass($1)::text AS reg",
      [`"${schema}".queues`],
    );
    if (reg.rows[0]?.reg == null) return { tableExists: false, names: [] };
    const { rows } = await db.query<{ name: string }>(
      `SELECT name FROM "${schema}".queues ORDER BY name`,
    );
    return { tableExists: true, names: rows.map((r) => r.name) };
  }

  /**
   * The predicate this guard USED to run, kept as a named function for exactly one
   * purpose: the discrimination test measures it, so its inadequacy is a recorded
   * measurement rather than a claim in a comment.
   */
  async function legacyTableExistencePredicate(db: Client): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
        WHERE table_name LIKE 'workflow%' OR table_schema = 'dbos'`,
    );
    return Number(rows[0].count);
  }

  /**
   * The worker's runtime LAUNCHED — not merely "some DBOS-shaped tables exist".
   *
   * WHY THE PREDICATE IS ROW-BASED AND SCHEMA-SCOPED, replacing a table-existence one.
   * This guard used to count `information_schema.tables` matching
   * `table_name LIKE 'workflow%' OR table_schema = 'dbos'` across the WHOLE
   * `supagloo_dbos` database. Per-lane DBOS system-schema isolation (api and dbos
   * `src/testing/dbos-lane-isolation.ts`) made that predicate self-satisfying: the
   * fourteen PERMANENT `dbos_e2e_*` lane schemas each carry six `workflow*` relations,
   * so the old count is well over eighty before the container is even considered. It
   * therefore stayed green with the worker crash-looping — the precise failure it was
   * written to catch. Lane schemas are residue of OTHER repos' test lanes and must be
   * excluded on purpose, not by accident, which is why the schema is named here.
   *
   * `queues` ROWS are the discriminating signal:
   *   - the SDK's system migrations CREATE `<schema>.queues` empty (no seed rows) —
   *     `@dbos-inc/dbos-sdk` `sysdb_migrations/internal/migrations.js`;
   *   - rows appear only through `upsertQueue`, whose sole caller in this stack is
   *     `DBOS.registerQueue` — and that call begins with `ensureDBOSIsLaunched`, so a
   *     row cannot exist unless a runtime reached the far side of `DBOS.launch()`.
   * The api never registers a queue (it is enqueue-only, via `DBOSClient`), so the rows
   * in the SHARED schema can only have come from the containerised worker's
   * `src/dbos/runtime.ts`.
   *
   * Scope limit, unchanged: this proves the worker LAUNCHED and persisted its static
   * queue table. It does not prove those queues are draining.
   */
  it("registered its static queues in the shared DBOS system schema", async () => {
    const dbos = await connect(PG.dbosUrl);
    const { tableExists, names } = await registeredQueues(
      dbos,
      DBOS_SYSTEM_SCHEMA,
    );

    expect(
      tableExists,
      `"${DBOS_SYSTEM_SCHEMA}".queues does not exist, so the SDK's system migrations ` +
        `never ran against ${PG.dbosDb}.`,
    ).toBe(true);
    expect(
      names.length,
      `"${DBOS_SYSTEM_SCHEMA}".queues is EMPTY. Migrations create that table but only a ` +
        `launched runtime's DBOS.registerQueue() writes rows, so the Compose \`dbos\` ` +
        `worker did not get past DBOS.launch() (check \`docker compose logs dbos\` for a ` +
        `crash loop: GITHUB_APP_PRIVATE_KEY, SECRETS_ENCRYPTION_KEY, DBOS_DATABASE_URL).`,
    ).toBeGreaterThan(0);
  });

  /**
   * THE GUARD'S OWN GUARD. Both halves are measured against the live database:
   *
   *   1. the RETIRED predicate is satisfied by lane-schema residue ALONE — counted with
   *      the `dbos` schema excluded, so the number is residue and nothing else. That is
   *      the bug, as a number, not as an argument;
   *   2. the CURRENT predicate is 0 against a schema in the exact state a dead worker
   *      leaves behind: migrated, never launched.
   *
   * The probe schema is built from `dbos`'s own tables (`LIKE … INCLUDING ALL`) so it
   * cannot drift from what the SDK's migrations actually create, and the whole thing
   * runs inside a transaction that is ALWAYS rolled back — Postgres DDL is
   * transactional, so nothing survives this test even if an assertion throws or the
   * process dies mid-way. No sampling, no timers, no touching the running container.
   */
  it("DISCRIMINATES a launched runtime from migration residue (which the retired predicate could not)", async () => {
    const dbos = await connect(PG.dbosUrl);
    await dbos.query("BEGIN");
    try {
      const residue = await dbos.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.tables
          WHERE (table_name LIKE 'workflow%' OR table_schema = 'dbos')
            AND table_schema <> 'dbos'`,
      );
      expect(
        Number(residue.rows[0].count),
        "the retired predicate is only worth replacing if residue really does satisfy it",
      ).toBeGreaterThan(0);

      // A schema in the migrated-but-never-launched state.
      await dbos.query(`CREATE SCHEMA "dbos_guard_probe"`);
      await dbos.query(
        `CREATE TABLE "dbos_guard_probe".queues (LIKE "${DBOS_SYSTEM_SCHEMA}".queues INCLUDING ALL)`,
      );
      await dbos.query(
        `CREATE TABLE "dbos_guard_probe".workflow_status (LIKE "${DBOS_SYSTEM_SCHEMA}".workflow_status INCLUDING ALL)`,
      );

      // The retired predicate cannot tell that state from a live worker...
      expect(await legacyTableExistencePredicate(dbos)).toBeGreaterThan(0);
      // ...and neither residue nor a freshly migrated schema registers a queue.
      const probe = await registeredQueues(dbos, "dbos_guard_probe");
      expect(probe.tableExists).toBe(true);
      expect(probe.names).toEqual([]);
    } finally {
      await dbos.query("ROLLBACK");
    }
  });
});
