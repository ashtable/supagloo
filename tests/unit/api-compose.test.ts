import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Asserts the COMMITTED compose shape for the Task #8 api + migrate services.
// The build context is the submodule path `./supagloo-nodejs-api` (production
// form — correct once the submodule pointer is bumped). A local, gitignored
// docker-compose.override.yml redirects that context to the standalone checkout
// for running the e2e against in-flight code; this test intentionally validates
// the base file, not the override.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMPOSE = resolve(ROOT, "docker-compose.yml");

interface ComposeService {
  build?: unknown;
  command?: unknown;
  ports?: unknown;
  depends_on?: unknown;
}
interface ComposeFile {
  services?: Record<string, ComposeService>;
}

function buildContext(build: unknown): string | undefined {
  if (typeof build === "string") return build;
  if (build && typeof build === "object" && "context" in build) {
    return (build as { context?: string }).context;
  }
  return undefined;
}

function hostPorts(ports: unknown): string[] {
  if (!Array.isArray(ports)) return [];
  return ports.map((p) => {
    if (typeof p === "number") return String(p);
    if (typeof p === "string") return p.includes(":") ? p.split(":")[0] : p;
    if (p && typeof p === "object" && "published" in p) {
      return String((p as { published: unknown }).published);
    }
    return "";
  });
}

function dependsOnNames(dep: unknown): string[] {
  if (Array.isArray(dep)) return dep.map(String);
  if (dep && typeof dep === "object") return Object.keys(dep);
  return [];
}

function commandText(cmd: unknown): string {
  if (typeof cmd === "string") return cmd;
  if (Array.isArray(cmd)) return cmd.join(" ");
  return "";
}

describe("docker-compose.yml — Task #8 migrate + api services", () => {
  const compose = parse(readFileSync(COMPOSE, "utf8")) as ComposeFile;
  const services = compose.services ?? {};

  describe("migrate one-shot service", () => {
    it("builds from the api submodule", () => {
      expect(services.migrate).toBeDefined();
      expect(buildContext(services.migrate.build)).toBe("./supagloo-nodejs-api");
    });

    it("runs `prisma migrate deploy`", () => {
      expect(commandText(services.migrate.command)).toContain(
        "prisma migrate deploy",
      );
    });

    it("waits for postgres before migrating", () => {
      expect(dependsOnNames(services.migrate.depends_on)).toContain("postgres");
    });
  });

  describe("api service", () => {
    it("builds from the api submodule", () => {
      expect(services.api).toBeDefined();
      expect(buildContext(services.api.build)).toBe("./supagloo-nodejs-api");
    });

    it("publishes host port 4000", () => {
      expect(hostPorts(services.api.ports)).toContain("4000");
    });

    it("waits for the one-shot migrate to complete", () => {
      expect(dependsOnNames(services.api.depends_on)).toContain("migrate");
    });
  });
});
