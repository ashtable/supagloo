import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMPOSE = resolve(ROOT, "docker-compose.yml");

interface ComposeService {
  image?: string;
  build?: unknown;
  command?: unknown;
  ports?: unknown;
  volumes?: unknown;
  environment?: unknown;
  healthcheck?: { test?: unknown };
  depends_on?: unknown;
}
interface ComposeFile {
  services?: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}

/** Host ports from either short-form ("5432:5432" / 5432) or long-form ({published}). */
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

/** Service names in a depends_on that may be a list or a condition-map. */
function dependsOnNames(dep: unknown): string[] {
  if (Array.isArray(dep)) return dep.map(String);
  if (dep && typeof dep === "object") return Object.keys(dep);
  return [];
}

/** Mount target/source strings from either short-form or long-form volumes. */
function volumeMounts(volumes: unknown): string[] {
  if (!Array.isArray(volumes)) return [];
  return volumes.map((v) => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const { source, target } = v as { source?: string; target?: string };
      return `${source ?? ""}:${target ?? ""}`;
    }
    return "";
  });
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

function healthcheckTestText(hc: ComposeService["healthcheck"]): string {
  const t = hc?.test;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.join(" ");
  return "";
}

describe("docker-compose.yml", () => {
  const compose = parse(readFileSync(COMPOSE, "utf8")) as ComposeFile;
  const services = compose.services ?? {};

  describe("postgres service", () => {
    it("exists on the postgres:17 image", () => {
      expect(services.postgres).toBeDefined();
      expect(services.postgres.image).toMatch(/^postgres:17/);
    });

    it("has a pg_isready healthcheck", () => {
      expect(services.postgres.healthcheck).toBeDefined();
      expect(healthcheckTestText(services.postgres.healthcheck)).toContain(
        "pg_isready",
      );
    });

    it("publishes host port 5432", () => {
      expect(hostPorts(services.postgres.ports)).toContain("5432");
    });

    it("mounts the pg-init scripts and a pgdata volume", () => {
      const mounts = volumeMounts(services.postgres.volumes);
      expect(mounts).toContain(
        "./infra/pg-init:/docker-entrypoint-initdb.d",
      );
      expect(
        mounts.some((m) => m.startsWith("pgdata:")),
      ).toBe(true);
    });
  });

  describe("minio service", () => {
    it("exists and publishes the S3 API (9000) and console (9001) ports", () => {
      expect(services.minio).toBeDefined();
      const ports = hostPorts(services.minio.ports);
      expect(ports).toContain("9000");
      expect(ports).toContain("9001");
    });
  });

  describe("minio-init one-shot service", () => {
    it("exists and depends on minio", () => {
      const init = services["minio-init"];
      expect(init).toBeDefined();
      expect(dependsOnNames(init.depends_on)).toContain("minio");
    });
  });

  describe("named volumes", () => {
    it("declares pgdata and minio-data", () => {
      const volumes = compose.volumes ?? {};
      expect(Object.keys(volumes)).toContain("pgdata");
      expect(Object.keys(volumes)).toContain("minio-data");
    });
  });

  describe("PART V invariant 5 — api and dbos share ONE secrets key", () => {
    // Task 62 / §11 (D15). Previously unasserted, and the test overlay had silently
    // broken it: the api encrypted with an all-zeros override while dbos decrypted
    // with the base compose's well-known dev key, so `decryptSecret` returned
    // AUTH_FAILED for any api-written provider credential inside a workflow.
    it("pins byte-identical SECRETS_ENCRYPTION_KEY values", () => {
      const apiKey = envValue(services.api?.environment, "SECRETS_ENCRYPTION_KEY");
      const dbosKey = envValue(services.dbos?.environment, "SECRETS_ENCRYPTION_KEY");
      expect(apiKey).toBeDefined();
      expect(dbosKey).toBeDefined();
      expect(apiKey).toBe(dbosKey);
    });

    it("is not an all-zeros key (that value was the overlay bug's fingerprint)", () => {
      const apiKey = envValue(services.api?.environment, "SECRETS_ENCRYPTION_KEY");
      expect(apiKey).not.toMatch(/^0+$/);
    });
  });

  describe("existing nextjs service is preserved", () => {
    it("still builds from ./supagloo-nextjs and maps 8000:3000", () => {
      expect(services.nextjs).toBeDefined();
      const build = services.nextjs.build as { context?: string } | string;
      const context = typeof build === "string" ? build : build?.context;
      expect(context).toBe("./supagloo-nextjs");
      expect(hostPorts(services.nextjs.ports)).toContain("8000");
    });
  });
});

// ---------------------------------------------------------------------------------
// PART V invariant 6 — api and dbos must AGREE on DBOS_SYSTEM_DATABASE_SCHEMA.
//
// `DBOS_SYSTEM_DATABASE_SCHEMA` (added 2026-07-26) names the SCHEMA inside the DBOS
// system database that holds DBOS's checkpoint + queue tables; unset, the SDK's default
// `dbos` stands. It is the designed fallback for a platform that exposes only one
// Postgres database (design-delta §4 / §9-Q7), and it is a genuine footgun: the api
// ENQUEUES into that schema and the dbos worker POLLS it. Set it on one service only and
// the api writes where nothing reads — jobs are accepted, persisted, and sit queued
// forever with no error anywhere. Nothing in the SDK or either env loader can catch that,
// because each service's config is individually valid.
//
// This lives at the COMPOSE layer because that is the only layer that sees both services
// at once. It is a regression fence: today the key is set nowhere, so both branches are
// vacuously satisfied. That is the point — the day someone sets it, this decides whether
// they set it correctly. It is proven by mutation (set it on `api` only ⇒ RED), not by
// having ever been red on its own.
//
// The check runs per-file AND on the merged result, because `docker compose -f a -f b`
// merges service environments key-by-key: a base file could pair them and an overlay
// could then override just one half.
describe("PART V invariant 6 — DBOS_SYSTEM_DATABASE_SCHEMA parity across api and dbos", () => {
  const KEY = "DBOS_SYSTEM_DATABASE_SCHEMA";
  const FILES = [
    "docker-compose.yml",
    "docker-compose.override.yml",
    "docker-compose.test.yml",
  ] as const;

  const loaded = FILES.map((name) => ({
    name,
    services:
      (parse(readFileSync(resolve(ROOT, name), "utf8")) as ComposeFile).services ??
      {},
  }));

  it.each(FILES)(
    "%s gives api and dbos the SAME value for the key (or sets it on neither)",
    (name) => {
      const services = loaded.find((f) => f.name === name)!.services;
      // A file that declares neither service cannot break the pairing.
      const api = services.api ? envValue(services.api.environment, KEY) : undefined;
      const dbos = services.dbos ? envValue(services.dbos.environment, KEY) : undefined;
      // ONE assertion covers both failure shapes — set on one service only, and set on
      // both but differently — because they have the same consequence: the api enqueues
      // into a schema the worker never polls, and every job sits queued forever with no
      // error anywhere. `undefined === undefined` is the (current) passing case.
      expect(
        dbos,
        `${name}: api has ${KEY}=${api ?? "<unset>"} but dbos has ${dbos ?? "<unset>"}`,
      ).toBe(api);
    },
  );

  it("the MERGED api+dbos stack resolves the key to the same value on both services", () => {
    // Compose merge semantics for `environment`: later `-f` files win per key.
    const resolveFor = (svc: "api" | "dbos") => {
      let value: string | undefined;
      for (const { services } of loaded) {
        const found = services[svc]
          ? envValue(services[svc]!.environment, KEY)
          : undefined;
        if (found !== undefined) value = found;
      }
      return value;
    };
    expect(resolveFor("api")).toBe(resolveFor("dbos"));
  });

  it("is UNSET everywhere today, so the SDK default 'dbos' is the shipped configuration", () => {
    // Pins the CURRENT deployment shape, separately from the parity rule above: a paired
    // value on both services would satisfy parity while still silently repartitioning
    // every developer's stack. Changing this line must be a deliberate act.
    for (const { name, services } of loaded) {
      for (const svc of Object.keys(services)) {
        expect(
          envValue(services[svc]!.environment, KEY),
          `${name} → ${svc} sets ${KEY}`,
        ).toBeUndefined();
      }
    }
  });
});
