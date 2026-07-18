import { defineConfig } from "vitest/config";

// E2E config: drives the REAL Docker Compose stack (Postgres + MinIO). The
// globalSetup reuses an already-running infra stack if it's healthy, otherwise
// runs `docker compose up -d postgres minio minio-init`, waits for readiness,
// and tears it down afterwards. Long timeouts (image pulls + container boot),
// one file at a time (shared containers).
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
