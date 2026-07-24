import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "pg";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { PG, S3, API, PROVIDERS, makeS3Client } from "../support/dev-config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The stack services the e2e suite needs healthy: Postgres + MinIO (infra), the
 * Task #8 one-shot `migrate` + Fastify `api`, and the surviving stub harness
 * (the GitHub REST stub + the local git smart-HTTP server). Task 34-E8
 * (design-delta §10.7) removed the openrouter/gloo/youversion stubs — those
 * providers are exercised for real by the backend e2e suites. `nextjs`/`dbos`
 * are later tasks.
 */
const INFRA_SERVICES = [
  "postgres",
  "minio",
  "minio-init",
  "migrate",
  "api",
  "github-stub",
  "git-server",
];

/**
 * Compose file list. Always the base + the Task #9 test overlay (which defines
 * the stub services). Passing explicit `-f` disables Docker's auto-merge of
 * `docker-compose.override.yml`, so re-add it explicitly when the Task #8
 * standalone-api build bridge is present (it's gitignored — absent on CI).
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

/** Both surviving stubs answer their `/__stub/health` introspection route. */
async function stubsReady(): Promise<boolean> {
  const bases = [PROVIDERS.githubBaseUrl, PROVIDERS.gitServerBaseUrl];
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/__stub/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Ready = both logical databases accept connections (proves the pg-init script
 * ran), the `supagloo-dev` bucket exists (proves minio-init ran), the API
 * answers `GET /healthz` (proves `migrate` applied and `api` started), AND the
 * two surviving stubs (github-stub + git-server) answer `/__stub/health` (proves
 * the test overlay is up).
 */
async function infraReady(): Promise<boolean> {
  return (
    (await pgReachable(PG.appUrl)) &&
    (await pgReachable(PG.dbosUrl)) &&
    (await bucketReachable()) &&
    (await apiHealthy()) &&
    (await stubsReady())
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reuse an already-running healthy infra stack; otherwise bring up the full
 * stack (infra + api + the github-stub + git-server, via the base + test-overlay
 * compose files), wait until ready, and tear it down on teardown. Mirrors the
 * supagloo-nextjs e2e reuse-or-spawn pattern, applied to Compose.
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
    "Compose stack (infra + api + github-stub + git-server) did not become ready within 150s",
  );
}
