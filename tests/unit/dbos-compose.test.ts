import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Asserts the COMMITTED compose shape for the Task #15 dbos worker service. The
// build context is the submodule path `./supagloo-nodejs-dbos` (production form —
// correct once the submodule pointer is bumped). A local, gitignored
// docker-compose.override.yml redirects that context to the standalone checkout
// for running against in-flight code; this test validates the base file.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMPOSE = resolve(ROOT, "docker-compose.yml");

interface ComposeService {
  build?: unknown;
  command?: unknown;
  ports?: unknown;
  environment?: unknown;
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

/** Read an environment value from either map-form ({KEY: val}) or list-form ("KEY=val"). */
function envValue(environment: unknown, key: string): string | undefined {
  if (Array.isArray(environment)) {
    const hit = environment
      .map(String)
      .find((entry) => entry.startsWith(`${key}=`));
    return hit ? hit.slice(key.length + 1) : undefined;
  }
  if (environment && typeof environment === "object") {
    const val = (environment as Record<string, unknown>)[key];
    return val === undefined ? undefined : String(val);
  }
  return undefined;
}

describe("docker-compose.yml — Task #15 dbos worker service", () => {
  const compose = parse(readFileSync(COMPOSE, "utf8")) as ComposeFile;
  const services = compose.services ?? {};

  it("defines a dbos service that builds from the dbos submodule", () => {
    expect(services.dbos).toBeDefined();
    expect(buildContext(services.dbos.build)).toBe("./supagloo-nodejs-dbos");
  });

  it("waits for the one-shot migrate to complete before starting", () => {
    // dbos has NO migrate service of its own (only the API runs prisma migrate
    // deploy); it depends on the API's migrate finishing so the app schema exists.
    expect(dependsOnNames(services.dbos.depends_on)).toContain("migrate");
  });

  it("wires the app db and the DBOS system db as separate URLs", () => {
    const appUrl = envValue(services.dbos.environment, "DATABASE_URL");
    const systemUrl = envValue(services.dbos.environment, "DBOS_DATABASE_URL");
    expect(appUrl).toBeDefined();
    expect(systemUrl).toBeDefined();
    expect(appUrl).toMatch(/\/supagloo$/);
    expect(systemUrl).toMatch(/\/supagloo_dbos$/);
  });

  it("publishes no host ports (the worker has no public HTTP surface)", () => {
    expect(hostPorts(services.dbos.ports)).toHaveLength(0);
  });
});
