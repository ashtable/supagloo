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

  it("has the DBOS system db provisioned with the worker's own tables", async () => {
    // DBOS creates its system schema on launch. An empty `supagloo_dbos` with no
    // dbos_* relation means the runtime never launched, even if the container is up.
    const dbos = await connect(PG.dbosUrl);
    const { rows } = await dbos.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
        WHERE table_name LIKE 'workflow%' OR table_schema = 'dbos'`,
    );
    expect(Number(rows[0].count)).toBeGreaterThan(0);
  });
});
