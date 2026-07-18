import { defineConfig } from "vitest/config";

// Unit config: pure-logic tests only — parse the compose file / init scripts.
// No live infra, no docker. Fast. E2E (real stack) lives under tests/e2e/*.e2e.ts
// and runs via vitest.e2e.config.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["node_modules", "dist", "tests/e2e/**"],
  },
});
