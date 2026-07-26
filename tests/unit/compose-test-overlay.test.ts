import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Declarative assertions on the TEST-ENABLEMENT overlay (`docker-compose.test.yml`).
//
// This file was born as the Task #9 "provider-stub overlay" test. Task 62 /
// design-delta §11 (D8, D20) retired the LAST two stubs (`github-stub` +
// `git-server`): every e2e lane now reaches real github.com / api.github.com, so the
// overlay's only surviving reason to exist is TEST ENABLEMENT — the two seed gates
// (`NODE_ENV: development` + `SUPAGLOO_ENABLE_TEST_SEED=1`) plus the S3/MinIO wiring
// that must NEVER merge into a plain `docker compose up`.
//
// The stub assertions are therefore INVERTED into a permanent NO-STUB GUARD: this
// suite now fails if anyone reintroduces a stub service or re-pins a GitHub base
// URL / App identity var on any service. §10.9 (1663-1666) forbids all three of the
// obvious "just put the stub back" mitigations, so the guard is the enforcement.
//
// Same yaml-parse approach as compose-config.test.ts / api-compose.test.ts.
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

describe("docker-compose.test.yml — test-enablement overlay", () => {
  const overlay = parse(readFileSync(OVERLAY, "utf8")) as ComposeFile;
  const services = overlay.services ?? {};
  const serviceNames = Object.keys(services);

  describe("NO-STUB GUARD (task 62 / §11, D20)", () => {
    it("defines no service at all that builds from ./tests/stubs", () => {
      // `tests/stubs/**` is DELETED. A build context pointing at it cannot even
      // build any more — but the assertion is about intent, not buildability.
      const offenders = serviceNames.filter((name) => {
        const ctx = buildContext(services[name].build);
        return typeof ctx === "string" && ctx.includes("tests/stubs");
      });
      expect(offenders).toEqual([]);
    });

    it.each([
      "github-stub",
      "git-server",
      "openrouter-stub",
      "gloo-stub",
      "youversion-stub",
    ])("does not define the %s service", (name) => {
      expect(services[name]).toBeUndefined();
    });

    it("declares no STUB_KIND anywhere", () => {
      const offenders = serviceNames.filter(
        (name) => envMap(services[name].environment).STUB_KIND !== undefined,
      );
      expect(offenders).toEqual([]);
    });
  });

  describe("real-by-default: no GitHub override survives on ANY service", () => {
    // D8: docker-compose.yml already substitutes the five real GITHUB_APP_* from the
    // untracked root .env. Overriding any of them here is what broke row 62 items
    // (b), (d) and (e). GITHUB_OAUTH_BASE_URL in particular is BOTH a server-side
    // token-exchange target and a BROWSER redirect target, so a Compose-internal
    // hostname can only ever satisfy one of the two (item (e)'s
    // DNS_PROBE_FINISHED_NXDOMAIN). Real GitHub satisfies both.
    const forbidden = [
      "GITHUB_API_BASE_URL",
      "GITHUB_OAUTH_BASE_URL",
      "GITHUB_GIT_BASE_URL",
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_CLIENT_ID",
      "GITHUB_APP_CLIENT_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
    ];

    it.each(forbidden)("no service overrides %s", (key) => {
      const offenders = serviceNames.filter(
        (name) => envMap(services[name].environment)[key] !== undefined,
      );
      expect(offenders).toEqual([]);
    });

    it("mentions no *-stub hostname or 480x stub port anywhere in the file", () => {
      // Textual backstop: catches a stub URL smuggled in via a service this test
      // does not know the name of, or via a comment-driven copy/paste revival.
      const text = readFileSync(OVERLAY, "utf8");
      expect(text).not.toMatch(/github-stub/);
      expect(text).not.toMatch(/git-server/);
      expect(text).not.toMatch(/:480\d/);
    });
  });

  describe("no SECRETS_ENCRYPTION_KEY override (D15)", () => {
    it("leaves every service on the base compose value", () => {
      // The overlay used to pin the api to an all-zeros key while dbos kept the
      // base compose's well-known dev key — so anything the api ENCRYPTED failed
      // to DECRYPT in a dbos workflow (AUTH_FAILED). PART V invariant 5 requires
      // parity; the parity itself is asserted in compose-config.test.ts.
      const offenders = serviceNames.filter(
        (name) =>
          envMap(services[name].environment).SECRETS_ENCRYPTION_KEY !== undefined,
      );
      expect(offenders).toEqual([]);
    });
  });

  describe("the overlay's surviving reason to exist", () => {
    it("double-gates the test-seed route on the api (row 62 item (a))", () => {
      // The base compose pins NODE_ENV: production and the Dockerfile bakes
      // ENV NODE_ENV=production, so POST /v1/test/seed hard-404s without BOTH of
      // these. Every nextjs real-stack Stagehand spec gets its session that way.
      // DELETING THIS BLOCK RE-BREAKS ROW 62 ITEM (a).
      const env = envMap(services.api?.environment);
      expect(env.NODE_ENV).toBe("development");
      expect(env.SUPAGLOO_ENABLE_TEST_SEED).toBe("1");
    });

    it.each([
      ["S3_ENDPOINT", "http://minio:9000"],
      ["S3_PUBLIC_ENDPOINT", "http://localhost:9000"],
      ["S3_BUCKET", "supagloo-dev"],
      ["S3_ACCESS_KEY", "supagloo"],
      ["S3_SECRET_KEY", "supagloo-dev"],
      ["S3_REGION", "us-east-1"],
    ])("keeps the api's %s wiring", (key, value) => {
      // S3_PUBLIC_ENDPOINT is load-bearing for E-RR3: the render spec's presigned
      // download runs IN THE BROWSER, which cannot resolve `minio`.
      expect(envMap(services.api?.environment)[key]).toBe(value);
    });
  });
});
