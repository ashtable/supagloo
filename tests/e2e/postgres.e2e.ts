import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { PG } from "../support/dev-config";

/**
 * E2E: the single postgres:17 container must expose BOTH logical databases,
 * created by the mounted init script — `supagloo` (Prisma app schema) and
 * `supagloo_dbos` (DBOS system db). Runs against the live Compose stack.
 */
describe("Compose Postgres: both logical databases", () => {
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

  it("lists both `supagloo` and `supagloo_dbos` in pg_database", async () => {
    const app = await connect(PG.appUrl);
    const { rows } = await app.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname = ANY($1) ORDER BY datname",
      [[PG.appDb, PG.dbosDb]],
    );
    expect(rows.map((r) => r.datname)).toEqual([PG.appDb, PG.dbosDb]);
  });

  it("connects directly to the app db `supagloo`", async () => {
    const app = await connect(PG.appUrl);
    const { rows } = await app.query<{ db: string }>(
      "SELECT current_database() AS db",
    );
    expect(rows[0].db).toBe(PG.appDb);
  });

  it("connects directly to the DBOS system db `supagloo_dbos`", async () => {
    const dbos = await connect(PG.dbosUrl);
    const { rows } = await dbos.query<{ db: string }>(
      "SELECT current_database() AS db",
    );
    expect(rows[0].db).toBe(PG.dbosDb);
  });
});
