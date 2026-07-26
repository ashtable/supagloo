import { defineConfig } from "vitest/config";

// E2E config: drives the REAL Docker Compose stack — Postgres (both logical DBs),
// MinIO, the one-shot migrate/minio-init jobs, the Fastify api, and (since task 62 /
// §11 D23) the DBOS worker. The globalSetup reuses an already-running stack if it's
// healthy, otherwise `docker compose ... up -d --build`s those services, waits for
// readiness, and tears them down afterwards. Long timeouts (image pulls + container
// boot), one file at a time (shared containers).
//
// No stub service is involved any more: `tests/stubs/**` is deleted and every e2e lane
// reaches real github.com. Root's own specs (api-healthz / postgres / s3 / dbos-worker)
// make no GitHub egress, so there is deliberately no GitHub-credential gate here — the
// fail-fast lives in tests/support/e2e-github-api.mjs, where the egress lives.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    testTimeout: 60_000,
    // globalSetup may `docker compose up -d --build` the api image on a cold
    // machine (npm install + prisma + tsc), which can exceed 180s.
    hookTimeout: 600_000,
    fileParallelism: false,
    globalSetup: ["./tests/e2e/global-setup.ts"],
  },
});
