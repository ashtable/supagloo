import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Declarative assertions on the Task #9 TEST-ONLY overlay. This is a SEPARATE
// file from docker-compose.yml — it must NOT be `docker-compose.override.yml`
// (gitignored, auto-merged, already claimed by Task 8), so it never auto-applies
// to a plain `docker compose up` and never ships in a production image. Same
// yaml-parse approach as compose-config.test.ts / api-compose.test.ts.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OVERLAY = resolve(ROOT, "docker-compose.test.yml");

interface ComposeService {
  build?: unknown;
  environment?: unknown;
  ports?: unknown;
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

/** Env from either map form ({K: v}) or list form (["K=v"]). */
function envMap(environment: unknown): Record<string, string> {
  if (Array.isArray(environment)) {
    const out: Record<string, string> = {};
    for (const entry of environment) {
      if (typeof entry === "string") {
        const [k, ...rest] = entry.split("=");
        out[k] = rest.join("=");
      }
    }
    return out;
  }
  if (environment && typeof environment === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(environment as Record<string, unknown>)) {
      out[k] = String(v);
    }
    return out;
  }
  return {};
}

describe("docker-compose.test.yml — provider-stub overlay", () => {
  const overlay = parse(readFileSync(OVERLAY, "utf8")) as ComposeFile;
  const services = overlay.services ?? {};

  const stubs: Array<[string, string, string]> = [
    // [service, STUB_KIND, host port]
    ["github-stub", "github", "4801"],
    ["openrouter-stub", "openrouter", "4802"],
    ["gloo-stub", "gloo", "4803"],
    ["youversion-stub", "youversion", "4804"],
    ["git-server", "git", "4805"],
  ];

  for (const [name, kind, port] of stubs) {
    describe(`${name} service`, () => {
      it("builds from the shared ./tests/stubs image", () => {
        expect(services[name]).toBeDefined();
        expect(buildContext(services[name].build)).toBe("./tests/stubs");
      });

      it(`runs STUB_KIND=${kind}`, () => {
        expect(envMap(services[name].environment).STUB_KIND).toBe(kind);
      });

      it(`publishes host port ${port}`, () => {
        expect(hostPorts(services[name].ports)).toContain(port);
      });
    });
  }

  describe("api provider base-URL overrides", () => {
    it("points the API at the internal stub URLs", () => {
      const env = envMap(services.api?.environment);
      expect(env.GITHUB_API_BASE_URL).toBe("http://github-stub:8080");
      expect(env.GITHUB_OAUTH_BASE_URL).toBe("http://github-stub:8080");
      expect(env.OPENROUTER_BASE_URL).toBe("http://openrouter-stub:8080");
      expect(env.GLOO_BASE_URL).toBe("http://gloo-stub:8080");
      expect(env.YOUVERSION_BASE_URL).toBe("http://youversion-stub:8080");
    });
  });
});
