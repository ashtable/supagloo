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

  it("waits for minio-init so the render bucket exists before a workflow uploads", () => {
    // Task 62 / §11 (D18-3). `renderWorkflow` uploads output.mp4 + thumb.jpg to the
    // `supagloo-dev` bucket, but only the `api` service waited for the one-shot
    // bucket creation — so a cold `docker compose up` could start the worker before
    // the bucket existed. depends_on must carry the completion CONDITION, not just
    // the name (minio-init exits 0 and stays exited).
    const dep = services.dbos.depends_on as
      | Record<string, { condition?: string }>
      | undefined;
    expect(dependsOnNames(services.dbos.depends_on)).toContain("minio-init");
    expect(dep?.["minio-init"]?.condition).toBe("service_completed_successfully");
  });

  describe("real-by-default GitHub wiring (task 62 / §11, F1)", () => {
    // F1's permanent blind spot: nothing ever asserted that the WORKER was
    // real-by-default. It always was (the base compose sets only the App id + PEM
    // and lets the zod schema default the base URLs to github.com) — but nothing
    // stopped a future overlay-style override landing here. Now something does.
    it.each([
      "GITHUB_API_BASE_URL",
      "GITHUB_OAUTH_BASE_URL",
      "GITHUB_GIT_BASE_URL",
    ])("does not override %s (the zod default is github.com)", (key) => {
      expect(envValue(services.dbos.environment, key)).toBeUndefined();
    });

    it("takes the real App id + PEM from the root .env by ${VAR} substitution", () => {
      expect(envValue(services.dbos.environment, "GITHUB_APP_ID")).toBe(
        "${GITHUB_APP_ID}",
      );
      expect(envValue(services.dbos.environment, "GITHUB_APP_PRIVATE_KEY")).toBe(
        "${GITHUB_APP_PRIVATE_KEY}",
      );
    });
  });

  // -------------------------------------------------------------------------------
  // 2026-07-30. The worker could not read scripture AT ALL, and nothing anywhere said so.
  //
  // `supagloo-nodejs-dbos` reads `YOUVERSION_APP_KEY` (`src/config/env.ts`), hands it to the
  // runtime (`src/dbos/runtime.ts`) and sends it as the live API's `x-yvp-app-key`
  // (`src/providers/youversion.ts`). This service block never passed it. The root
  // `.env.example` meanwhile described the variable as *"already wired — dbos sends it as a
  // header"*, which was true of the CODE and false of the WIRING.
  //
  // The consequence was invisible for as long as it was unreachable. `generateScript` only
  // calls `fetchPassage` when the project's manifest HAS a `scripture` block, and every e2e
  // fixture in every repo was a `createdFrom: "blank"` project with no such block — so the
  // whole passage-fetch path was dead code under test. The first spec to create a project
  // WITH a chosen passage (`supagloo-nextjs tests/e2e/studio-wizard-scripture-carry.e2e.ts`)
  // hit it immediately: measured from inside this container, `GET
  // /v1/bibles/12/passages/PSA.23` answers **401** with no header and **200** with the root
  // `.env` key, and the 401 is non-retryable, so the user's storyboard generation ends as
  // "Generation failed — try again" with the real cause three services away.
  //
  // A `${VAR}` reference is the assertion (never a literal), which is also what keeps the
  // secret out of this tracked file.
  it("gives the worker the YouVersion app key it sends as x-yvp-app-key", () => {
    expect(envValue(services.dbos.environment, "YOUVERSION_APP_KEY")).toBe(
      "${YOUVERSION_APP_KEY}",
    );
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

  describe("plan row 45 / D45.5 — render sizing", () => {
    it("raises shm_size so Chromium is not confined to Docker's 64MB /dev/shm", () => {
      // `renderWorkflow` drives a headless Chromium inside this container. Docker's
      // default /dev/shm is 64MB; Chromium uses shared memory for its renderer processes
      // and dies with a bare, unattributable crash when it runs out — which surfaces here
      // as a failed render with no useful error. This is a CORRECTNESS guard, not a
      // measurement artifact, which is why it ships in the base file.
      const shm = (services.dbos as { shm_size?: unknown }).shm_size;
      expect(shm).toBeDefined();
      expect(String(shm)).toMatch(/^(1gb|1g|1073741824)$/i);
    });

    it("sets NO memory ceiling on the shipped stack (D45.5)", () => {
      // A `mem_limit` / `deploy.resources` stanza here would change the stack that every
      // other e2e lane in four repos runs against, on the strength of one measurement.
      // A constrained profile belongs in an override the harness applies, not in the
      // shipped file.
      const svc = services.dbos as { mem_limit?: unknown; deploy?: unknown };
      expect(svc.mem_limit).toBeUndefined();
      expect(svc.deploy).toBeUndefined();
    });

    it("leaves RENDER_MEDIA_CONCURRENCY unset so Remotion's own default stands", () => {
      // api and dbos are not deployed to Railway (current-design §6:932-935), so any
      // recommended number is extrapolated from Compose. Shipping a guess as the default
      // would change every render's behaviour on a measurement not yet made; the variable
      // exists (dbos `src/config/env.ts`) as an operator knob and is documented in
      // `.env.example` and `docs/render-sizing.md`.
      expect(
        envValue(services.dbos.environment, "RENDER_MEDIA_CONCURRENCY"),
      ).toBeUndefined();
    });
  });
});
