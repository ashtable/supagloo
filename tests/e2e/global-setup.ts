import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "pg";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { PG, S3, API, makeS3Client } from "../support/dev-config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The stack services the root e2e suite needs healthy: Postgres + MinIO (infra), the
 * Task #8 one-shot `migrate` + Fastify `api`, and the Task #15 `dbos` worker.
 *
 * Task 62 / §11 (D20, D23) changed both ends of this list:
 *  - `github-stub` and `git-server` are GONE. `tests/stubs/**` is deleted and every e2e
 *    lane reaches real github.com. Accepted, unmitigated cost (recorded in §11.9): the
 *    git-ops e2e lanes no longer run offline. §10.9 forbids all three of the obvious
 *    mitigations — reintroducing stubs, marking the lane optional, adding a "fast mode".
 *  - `dbos` is ADDED, closing F1/F4's root-level blind spot: nothing here ever proved the
 *    worker ran, yet every git-ops and render workflow the nextjs real-stack specs depend
 *    on is dispatched by it. `tests/e2e/dbos-worker.e2e.ts` is the assertion.
 */
const INFRA_SERVICES = [
  "postgres",
  "minio",
  "minio-init",
  "migrate",
  "api",
  "dbos",
];

/**
 * Compose file list. Always the base + the task-62 TEST-ENABLEMENT overlay (which no
 * longer defines any stub service, but does carry the `POST /v1/test/seed` double-gate
 * and the api's MinIO wiring). Passing explicit `-f` disables Docker's auto-merge of
 * `docker-compose.override.yml`, so re-add it explicitly when the Task #8
 * standalone-build bridge is present (it's gitignored — absent on CI).
 */
const COMPOSE_FILES = ((): string[] => {
  const files = ["docker-compose.yml"];
  if (existsSync(resolve(ROOT, "docker-compose.override.yml"))) {
    files.push("docker-compose.override.yml");
  }
  files.push("docker-compose.test.yml");
  return files;
})();

function compose(args: string[]): void {
  const fileArgs = COMPOSE_FILES.flatMap((file) => ["-f", file]);
  execFileSync("docker", ["compose", ...fileArgs, ...args], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

function composeCapture(args: string[]): string {
  const fileArgs = COMPOSE_FILES.flatMap((file) => ["-f", file]);
  try {
    return execFileSync("docker", ["compose", ...fileArgs, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

async function pgReachable(connectionString: string): Promise<boolean> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function bucketReachable(): Promise<boolean> {
  const s3 = makeS3Client(S3.publicEndpoint);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3.bucket }));
    return true;
  } catch {
    return false;
  } finally {
    s3.destroy();
  }
}

async function apiHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${API.baseUrl}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The dbos worker LAUNCHED against this stack (D23).
 *
 * `launchDbos` idempotently creates the self-managed `noop_proof` table in the APP db
 * before it starts polling queues (dbos `src/db/app-db.ts` `ensureNoopProofTable`, called
 * from `src/dbos/runtime.ts`). No migration creates that table and it is not in db-lib's
 * Prisma schema, so its presence can only mean the worker's launch path ran.
 *
 * Why this and not `docker compose ps`: a container reported as `running` can be
 * crash-LOOPING on a bad `GITHUB_APP_PRIVATE_KEY` or a missing `SECRETS_ENCRYPTION_KEY`,
 * which is the actual failure mode — the api stays healthy and every enqueue hangs until
 * a multi-minute UI timeout, four layers from the cause. A table that only the successful
 * launch path creates is a much cheaper and much more honest signal, and root's only db
 * dependency (`pg`) already covers it.
 */
async function dbosWorkerLaunched(): Promise<boolean> {
  const client = new Client({
    connectionString: PG.appUrl,
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    const { rows } = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'noop_proof'
       ) AS present`,
    );
    return rows[0]?.present === true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Ready = both logical databases accept connections (proves the pg-init script ran), the
 * `supagloo-dev` bucket exists (proves minio-init ran), the API answers `GET /healthz`
 * (proves `migrate` applied and `api` started), AND the dbos worker has launched.
 *
 * Deliberately NO GitHub-credential gate here. Root's surviving e2e specs
 * (`api-healthz`, `postgres`, `s3`, `dbos-worker`) touch no GitHub, and the 34-E8 key
 * decision is not to over-couple specs to infrastructure they never use. The real-GitHub
 * fail-fast lives where the egress lives: `resolveGithubE2eSecrets()` /
 * `discoverInstallation()` in `tests/support/e2e-github-api.mjs`, called by the api, dbos
 * and nextjs harnesses.
 */
async function infraReady(): Promise<boolean> {
  return (
    (await pgReachable(PG.appUrl)) &&
    (await pgReachable(PG.dbosUrl)) &&
    (await bucketReachable()) &&
    (await apiHealthy()) &&
    (await dbosWorkerLaunched())
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reuse an already-running healthy stack; otherwise bring it up (infra + migrate + api +
 * the dbos worker, via the base + test-enablement compose files), wait until ready, and
 * tear it down on teardown. Mirrors the supagloo-nextjs e2e reuse-or-spawn pattern,
 * applied to Compose.
 */
export default async function setup() {
  if (await infraReady()) {
    // Reuse — leave the developer's running stack exactly as it was.
    return;
  }

  // `--build` so the `migrate`/`api`/`dbos` images reflect the current submodule code
  // (infra images are pulled, not built). The reuse path above skips this entirely when a
  // healthy stack is already running.
  compose(["up", "-d", "--build", ...INFRA_SERVICES]);

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await infraReady()) {
      return async () => {
        compose(["down"]);
      };
    }
    await sleep(2000);
  }

  // Attach the worker's own log tail: the overwhelmingly common cause of a stack that
  // never becomes ready is `dbos` crash-looping at boot on a credential problem, and
  // without the tail that is invisible from here.
  const dbosLogs = composeCapture(["logs", "--no-color", "--tail", "40", "dbos"]);
  compose(["down"]);
  throw new Error(
    "Compose stack (postgres + minio + migrate + api + dbos) did not become ready within 180s.\n" +
      `  Reproduce with: docker compose ${COMPOSE_FILES.map((f) => `-f ${f}`).join(" ")} up -d --build ${INFRA_SERVICES.join(" ")}\n` +
      "  Then inspect the worker: docker compose ... logs dbos\n" +
      (dbosLogs ? `  Last dbos log lines:\n${dbosLogs}` : "  (no dbos logs were available)"),
  );
}
