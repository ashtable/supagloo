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
