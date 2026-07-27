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

  // -------------------------------------------------------------------------------
  // PART V invariant 7 — plan row 43 / D43.1(2): "distinct per ENVIRONMENT".
  //
  // The row asks all three services to enforce "distinct-per-env expectations". Two of
  // its three halves are NOT enforceable in a service's own process:
  //
  //   * "identical across api and dbos WITHIN an environment" is invariant 5 above, and
  //     it is a Compose-level property because no single service can see the other's key.
  //   * "distinct ACROSS environments" is likewise invisible from inside one process —
  //     a container cannot know what some other deployment's key is.
  //
  // The naive in-process gate (reject the well-known dev key when NODE_ENV ===
  // "production") is the WRONG gate and would refuse to boot the shipped stack:
  // docker-compose.yml pins `NODE_ENV: production` on BOTH api and dbos while
  // hardcoding that very key, and docker-compose.test.yml flips only api to
  // `development` (load-bearing for the test-seed double gate — see
  // compose-test-overlay.test.ts). So the in-process half of row 43 is the ALL-ZEROS
  // rejection (api/dbos `src/config/env.ts`), and the "distinct per environment" half
  // is enforced HERE, structurally, over the tracked files that actually carry keys.
  // -------------------------------------------------------------------------------
  describe("PART V invariant 7 — the dev secrets key is confined and labelled (D43.1)", () => {
    const DEV_KEY = "0123456789abcdef".repeat(4);
    /** Every tracked root file that may legitimately contain the literal, and why. */
    const PERMITTED = new Map([
      ["docker-compose.yml", "the shipped dev stack pins it on api + dbos"],
      [".env.example", "it documents the dev default and how to replace it"],
    ]);
    const CANDIDATES = [
      "docker-compose.yml",
      "docker-compose.test.yml",
      ".env.example",
      "README.md",
    ] as const;

    it("appears ONLY in the files permitted to carry it — never in the test overlay", () => {
      // design-delta §11.7:2309-2318 records the real incident: the test overlay
      // overrode SECRETS_ENCRYPTION_KEY, so the api encrypted with a key dbos could not
      // decrypt with. An overlay is exactly where a second, drifting copy reappears.
      const offenders = CANDIDATES.filter(
        (name) =>
          !PERMITTED.has(name) &&
          readFileSync(resolve(ROOT, name), "utf8").includes(DEV_KEY),
      );
      expect(offenders).toEqual([]);
    });

    it("every occurrence in docker-compose.yml is labelled dev-only", () => {
      // A copied-forward key is the failure this prevents. Each occurrence must sit
      // within a few lines of prose that says not to ship it.
      const lines = readFileSync(COMPOSE, "utf8").split("\n");
      const hits = lines
        .map((line, i) => (line.includes(DEV_KEY) ? i : -1))
        .filter((i) => i >= 0);
      expect(hits.length).toBeGreaterThan(0);
      for (const i of hits) {
        const window = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
        expect(
          /dev-only|never use this in prod|never use it in prod/i.test(window),
          `docker-compose.yml:${i + 1} carries the dev key with no dev-only label nearby`,
        ).toBe(true);
      }
    });

    it(".env.example tells an operator how to mint a DISTINCT production key", () => {
      // This sentence IS the mechanical content of "distinct per environment": the same
      // recipe both services' boot errors already recommend.
      const envExample = readFileSync(resolve(ROOT, ".env.example"), "utf8");
      expect(envExample).toContain("openssl rand -hex 32");
    });

    it("exactly the api and dbos services carry SECRETS_ENCRYPTION_KEY", () => {
      // §9 S4 at the Compose layer. nextjs has no DB and no S3 access and never calls
      // encryptSecret/decryptSecret; its own boot validator now REJECTS the variable's
      // presence, so adding it here would make the container refuse to boot.
      const carriers = Object.keys(services).filter(
        (name) =>
          envValue(services[name]!.environment, "SECRETS_ENCRYPTION_KEY") !== undefined,
      );
      expect(carriers.sort()).toEqual(["api", "dbos"]);
    });
  });

  // -------------------------------------------------------------------------------
  // Row 43 / D43.3 — the nextjs service's credential wiring.
  //
  // As shipped before this row the `nextjs` service had NO `environment:` block and NO
  // build `args:`, while supagloo-nextjs/Dockerfile takes YV_APP_KEY as a build ARG. The
  // key therefore reached neither the build nor the container, and row 43's "refuses to
  // boot without it" case was not executable for nextjs at all.
  // -------------------------------------------------------------------------------
  describe("row 43 / D43.3 — nextjs gets YV_APP_KEY at RUNTIME", () => {
    it("substitutes YV_APP_KEY from the root .env's YOUVERSION_APP_KEY", () => {
      expect(envValue(services.nextjs?.environment, "YV_APP_KEY")).toBe(
        "${YOUVERSION_APP_KEY}",
      );
    });

    it("does NOT give nextjs the application secrets key", () => {
      expect(
        envValue(services.nextjs?.environment, "SECRETS_ENCRYPTION_KEY"),
      ).toBeUndefined();
    });

    it("passes only a NON-SECRET placeholder as the build arg", () => {
      // WHAT THIS ASSERTS, precisely: the REAL credential is never a build arg. A build arg
      // is baked into every image layer and into `docker history`, so a secret there is
      // published. That is the whole content of this case.
      //
      // WHAT IT DOES NOT ASSERT — reworded after RX-5, because the old comment read as a
      // certificate of runtime behaviour and was for a while the ONLY assertion anywhere
      // about this value, which meant root's suite certified a broken configuration. This
      // is a static read of a YAML file. It cannot see that the image once baked this exact
      // placeholder into 33 prerendered payloads under `/app/.next` and served it to
      // browsers regardless of the container's `YV_APP_KEY`. Only a running container can,
      // and that is `tests/e2e/boot-hardening.e2e.ts`'s E-BH8 — pinned below so this file
      // can never again be the only thing looking at it.
      //
      // (The arg is also no longer load-bearing for the build: since item 8's fix
      // `app/layout.tsx` reads the key per request behind `await connection()`, and a
      // `next build` with YV_APP_KEY entirely unset exits 0. It stays declared because an
      // undeclared build arg is a warning, and because the placeholder is what makes a
      // container started WITHOUT the runtime bridge refuse to boot.)
      const build = services.nextjs?.build as
        | { args?: Record<string, string> }
        | undefined;
      const arg = build?.args?.YV_APP_KEY;
      expect(arg, "nextjs build args must set YV_APP_KEY").toBeDefined();
      expect(arg).not.toContain("${");
      expect(arg).toMatch(/placeholder/i);
    });

    it("is NOT the only assertion about that value — E-BH8 asserts the served bytes", () => {
      // RX-5. The defect this pins is a coverage shape, not a config value: a suite in which
      // the placeholder is asserted as an invariant and no test ever asserts a HEALTHY
      // nextjs. Keyed to the runtime key reaching the response body, because that is the
      // property the placeholder defeated.
      const spec = readFileSync(resolve(ROOT, "tests/e2e/boot-hardening.e2e.ts"), "utf8");
      expect(spec).toContain("E-BH8");
      expect(spec).toMatch(/not\.toContain\("build-time-placeholder-not-a-real-key"\)/);
      expect(spec).toMatch(/expect\(body\)\.toContain\(RUNTIME_KEY\)/);
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

  // `docker-compose.override.yml` is GITIGNORED, so its absence is a normal state — a fresh
  // clone has none, and `docs/release-gate.md` §2 explicitly instructs you to move it aside
  // before rebuilding from the committed contexts. Reading it unconditionally at module scope
  // threw during COLLECTION, which took this whole file out while vitest still reported
  // "287 passed" — 23 tests silently stopped reporting, the exact green-lie shape this suite
  // exists to prevent. A missing file is the "declares neither service" case, which the
  // per-file assertion below already treats as passing.
  const readServices = (name: string): NonNullable<ComposeFile["services"]> => {
    let raw: string;
    try {
      raw = readFileSync(resolve(ROOT, name), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    return (parse(raw) as ComposeFile).services ?? {};
  };

  const loaded = FILES.map((name) => ({ name, services: readServices(name) }));

  it("survives a missing gitignored override instead of failing collection", () => {
    // Pins the mechanism, not the outcome: if someone restores the unconditional read, this
    // file stops COLLECTING and vitest reports one failed FILE rather than one failed test —
    // so the assertion that matters is that `loaded` is fully built for every FILES entry by
    // the time any test runs at all.
    expect(loaded.map((f) => f.name)).toEqual([...FILES]);
    expect(readServices("docker-compose.definitely-not-here.yml")).toEqual({});
  });

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
