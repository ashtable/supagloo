import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "pg";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { PG, S3, API, makeS3Client } from "../support/dev-config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The stack services the e2e suite needs healthy: Postgres + MinIO (infra) plus
 * the Task #8 one-shot `migrate` and the Fastify `api`. `nextjs`/`dbos` are
 * later tasks.
 */
const INFRA_SERVICES = ["postgres", "minio", "minio-init", "migrate", "api"];

function compose(args: string[]): void {
  execFileSync("docker", ["compose", ...args], {
    cwd: ROOT,
    stdio: "inherit",
  });
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
 * Ready = both logical databases accept connections (proves the pg-init script
 * ran), the `supagloo-dev` bucket exists (proves minio-init ran), AND the API
 * answers `GET /healthz` with 200 (proves `migrate` applied and `api` started).
 */
async function infraReady(): Promise<boolean> {
  return (
    (await pgReachable(PG.appUrl)) &&
    (await pgReachable(PG.dbosUrl)) &&
    (await bucketReachable()) &&
    (await apiHealthy())
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reuse an already-running healthy infra stack; otherwise bring up
 * postgres+minio+minio-init, wait until ready, and tear it down on teardown.
 * Mirrors the supagloo-nextjs e2e reuse-or-spawn pattern, applied to Compose.
 */
export default async function setup() {
  if (await infraReady()) {
    // Reuse — leave the developer's running stack exactly as it was.
    return;
  }

  // `--build` so the `migrate`/`api` images reflect the current api code (infra
  // images are pulled, not built). The reuse path above skips this entirely when
  // a healthy stack is already running.
  compose(["up", "-d", "--build", ...INFRA_SERVICES]);

  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    if (await infraReady()) {
      return async () => {
        compose(["down"]);
      };
    }
    await sleep(2000);
  }

  compose(["down"]);
  throw new Error(
    "Compose infra (postgres + minio + minio-init) did not become ready within 150s",
  );
}
