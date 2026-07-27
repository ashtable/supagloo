import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API } from "../support/dev-config";

/**
 * PLAN ROW 43 — "Compose e2e: a service with a short/missing key refuses to boot with a
 * clear error; healthy boot with valid env."
 *
 * ---------------------------------------------------------------------------------------
 * WHY EVERY NEGATIVE CASE IS A ONE-OFF CONTAINER (D43.4 — this is not a style choice)
 * ---------------------------------------------------------------------------------------
 * The obvious implementation is "restart the dbos service with a bad key and watch it
 * die". That would break ANOTHER REPO'S LANE, invisibly. `dbos/src/dbos/worker-log.ts`
 * exports `WORKER_FAILED_LOG`, and supagloo-nextjs's render-lane `globalSetup` scrapes
 * `docker compose logs --no-color dbos` and treats that string appearing in the tail as a
 * HARD failure — deliberately, so a crash-looping worker is reported as a crash rather
 * than as a timeout. A deliberately-crashed long-lived `dbos` container leaves that string
 * in the shared stream for as long as the container lives.
 *
 * `docker compose run --rm --no-deps` avoids all of it: `--rm` destroys the container the
 * instant it exits, taking its logs with it, and `--no-deps` keeps the one-off from
 * restarting `migrate` or `minio-init`. E-BH7 below then PROVES the shared stream stayed
 * clean, rather than assuming it.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT "REFUSES TO BOOT" MEANS PER SERVICE — MEASURED, NOT ASSUMED
 * ---------------------------------------------------------------------------------------
 * api and dbos are plain Node entry points: `loadEnv()` throws before anything is
 * constructed and the process exits non-zero. Asserted as such.
 *
 * supagloo-nextjs is NOT the same shape, and the difference is a real finding rather than
 * a detail. Its boot validator runs in `instrumentation.ts`'s `register()`, which Next
 * awaits inside `prepareImpl()` (`next/dist/server/next-server.js:568-573`). A throw there
 * DOES abort `prepare()` — but under `next start` (Next 16.2.10) Next catches the resulting
 * rejection at its own top level, logs `Failed to prepare server` + `unhandledRejection`,
 * and KEEPS THE LISTENER OPEN. MEASURED: the container stays up indefinitely and answers
 * **HTTP 500 to every request**, including `/api/*`.
 *
 * So for nextjs this spec asserts the two properties that are measurably true and that
 * together are the observable refusal — a clear error naming the offending variable, and a
 * server that never serves anything but 500 — and does NOT assert a non-zero exit, which
 * would be a green lie. The remaining gap (the PID survives, so an orchestrator's
 * "container running" signal is wrong) is recorded here deliberately: closing it needs a
 * change in supagloo-nextjs, not in this repo.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Same file list the global setup uses, so a one-off container sees the same config. */
const COMPOSE_FILES = ((): string[] => {
  const files = ["docker-compose.yml"];
  if (existsSync(resolve(ROOT, "docker-compose.override.yml"))) {
    files.push("docker-compose.override.yml");
  }
  files.push("docker-compose.test.yml");
  return files;
})();

const FILE_ARGS = COMPOSE_FILES.flatMap((file) => ["-f", file]);

/** A 64-hex key that PASSES the format check and is rejected on its own merits (D43.1). */
const ALL_ZEROS_KEY = "0".repeat(64);
/** The well-known dev key — valid everywhere, and still a boot refusal for nextjs (S4). */
const DEV_KEY = "0123456789abcdef".repeat(4);

interface RunResult {
  status: number;
  output: string;
}

/**
 * `docker compose run --rm --no-deps -e <overrides> <service>`, capturing BOTH streams and
 * the real exit status. Never throws on a non-zero exit — the exit code is the assertion.
 */
function runOneOff(service: string, overrides: Record<string, string>): RunResult {
  const envArgs = Object.entries(overrides).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  try {
    const output = execFileSync(
      "docker",
      ["compose", ...FILE_ARGS, "run", "--rm", "--no-deps", ...envArgs, service],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
    );
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      output: `${e.stdout ?? ""}\n${e.stderr ?? ""}`,
    };
  }
}

/** Containers this spec started detached, torn down even if an assertion throws. */
const detached: string[] = [];

afterAll(() => {
  for (const id of detached) {
    try {
      execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a one-off container DETACHED with its service ports published, hand it to `fn`,
 * and ALWAYS destroy it — including on an assertion failure. The teardown is per-case, not
 * per-file: the nextjs cases both publish host port 8000, so a container that outlived its
 * own test would make the next one fail with `port is already allocated`, i.e. an
 * infrastructure error wearing a test failure's clothes.
 */
async function withDetached(
  service: string,
  overrides: Record<string, string>,
  fn: (ctx: { logs: () => string }) => Promise<void>,
): Promise<void> {
  const envArgs = Object.entries(overrides).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const id = execFileSync(
    "docker",
    ["compose", ...FILE_ARGS, "run", "-d", "--no-deps", "--service-ports", ...envArgs, service],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
    .trim()
    .split("\n")
    .pop()!;
  detached.push(id);
  try {
    await fn({
      // BOTH streams, joined. Next writes `✓ Ready` to stdout but every line of the boot
      // refusal — `[supagloo-nextjs] boot refused`, `Failed to prepare server`,
      // `unhandledRejection` — to STDERR. Reading stdout alone (execFileSync's return
      // value) sees a server that looks like it started fine, which is the precise shape
      // of green lie this spec exists to prevent.
      logs: () => {
        const r = spawnSync("docker", ["logs", id], { encoding: "utf8" });
        return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      },
    });
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
}

/**
 * Drive one request at the nextjs container and return its status.
 *
 * MEASURED, and load-bearing for the two cases below: `next start` (Next 16.2.10) prints
 * `✓ Ready` and binds the port BEFORE running the instrumentation hook — `prepareImpl()`
 * is lazy and runs on the FIRST REQUEST. So the boot refusal is not in the log until
 * something asks for a page. Reading the log first and giving up on a timeout would report
 * "the validator never ran" when what actually happened is "nobody knocked".
 */
async function probe(url: string, ms: number): Promise<number> {
  const deadline = Date.now() + ms;
  let last = -1;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      last = res.status;
      return last;
    } catch {
      await sleep(500);
    }
  }
  return last;
}

async function waitForLog(read: () => string, needle: string, ms: number): Promise<string> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    last = read();
    if (last.includes(needle)) return last;
    await sleep(500);
  }
  return last;
}

describe("E-BH: api refuses to boot on a bad secrets key", () => {
  it("E-BH1 — a short key exits non-zero and names the variable AND the file", () => {
    const { status, output } = runOneOff("api", { SECRETS_ENCRYPTION_KEY: "short" });
    expect(status).not.toBe(0);
    expect(output).toContain("SECRETS_ENCRYPTION_KEY");
    // design-delta §8:1414-1418 / §11.3:2034-2042: the message must name the variable AND
    // the file, so a developer is not sent grepping.
    expect(output).toContain("supagloo-nodejs-api/src/config/env.ts");
  });

  it("E-BH2 — an ALL-ZEROS 64-hex key is rejected on its own merits (D43.1)", () => {
    // It passes the /^[0-9a-fA-F]{64}$/ format check, so nothing before row 43 caught it —
    // and design-delta §11.7:2309-2318 records the real incident where exactly this value
    // was in play (api encrypting with all-zeros while dbos decrypted with the dev key).
    // This is the in-process half of "distinct per environment"; the Compose half is
    // tests/unit/compose-config.test.ts PART V invariant 7.
    const { status, output } = runOneOff("api", {
      SECRETS_ENCRYPTION_KEY: ALL_ZEROS_KEY,
    });
    expect(status).not.toBe(0);
    expect(output).toContain("SECRETS_ENCRYPTION_KEY");
  });
});

describe("E-BH: dbos refuses to boot on a bad secrets key", () => {
  it("E-BH3 — a short key exits non-zero and names the variable AND the file", () => {
    const { status, output } = runOneOff("dbos", { SECRETS_ENCRYPTION_KEY: "short" });
    expect(status).not.toBe(0);
    expect(output).toContain("SECRETS_ENCRYPTION_KEY");
    expect(output).toContain("supagloo-nodejs-dbos/src/config/env.ts");
  });

  it("E-BH4 — an ALL-ZEROS 64-hex key is rejected, byte-identically to api", () => {
    const { status, output } = runOneOff("dbos", {
      SECRETS_ENCRYPTION_KEY: ALL_ZEROS_KEY,
    });
    expect(status).not.toBe(0);
    expect(output).toContain("SECRETS_ENCRYPTION_KEY");
  });
});

describe("E-BH: nextjs refuses to serve on a bad env (D43.3 / §9 S4)", () => {
  it(
    "E-BH5 — an empty YV_APP_KEY: every request 500s, with a clear error naming the variable",
    async () => {
      await withDetached("nextjs", { YV_APP_KEY: "" }, async ({ logs }) => {
        // The observable refusal. Next keeps the listener open (see the header), so the
        // property that actually protects a user is that NOTHING is ever served — not a
        // degraded page, not an API route. The request is also what TRIGGERS the lazy
        // instrumentation hook, so it has to come before the log read.
        expect(await probe("http://localhost:8000/", 60_000)).toBe(500);
        const tail = await waitForLog(logs, "boot refused", 30_000);
        expect(tail).toContain("YV_APP_KEY");
        expect(tail).toContain("Failed to prepare server");
      });
    },
    180_000,
  );

  it(
    "E-BH6 — a VALID secrets key is still a boot refusal: nextjs must never hold one",
    async () => {
      // The S4 inversion, proved at the Compose level. plan row 43 says "all three
      // services validate SECRETS_ENCRYPTION_KEY"; nextjs has no database and no S3 access
      // and never calls encryptSecret/decryptSecret, so implementing that sentence
      // literally would hand the application secrets key to the one process the design
      // says must never hold it. The correct check is ABSENCE — and a perfectly valid key
      // is exactly the case a weaker check would wave through.
      await withDetached(
        "nextjs",
        {
          YV_APP_KEY: "present-so-this-is-not-the-reason",
          SECRETS_ENCRYPTION_KEY: DEV_KEY,
        },
        async ({ logs }) => {
          expect(await probe("http://localhost:8000/", 60_000)).toBe(500);
          const tail = await waitForLog(logs, "boot refused", 30_000);
          expect(tail).toContain("SECRETS_ENCRYPTION_KEY");
          // The refusal must not be an excuse to print the key.
          expect(tail).not.toContain(DEV_KEY);
        },
      );
    },
    180_000,
  );
});

describe("E-BH7 — the healthy stack is untouched by all of the above", () => {
  it("api answers /healthz, the worker is ready, and the shared log stream is clean", async () => {
    const res = await fetch(`${API.baseUrl}/healthz`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(200);

    // Read the two cross-repo log constants from the dbos checkout so this spec cannot
    // drift from the strings supagloo-nextjs's render lane actually greps for.
    const workerLog = resolve(ROOT, "..", "supagloo-nodejs-dbos", "src/dbos/worker-log.ts");
    expect(existsSync(workerLog), workerLog).toBe(true);
    const source = execSync(`cat ${JSON.stringify(workerLog)}`, { encoding: "utf8" });
    const ready = /WORKER_READY_LOG\s*=\s*\n?\s*"([^"]+)"/.exec(source)?.[1];
    const failed = /WORKER_FAILED_LOG\s*=\s*"([^"]+)"/.exec(source)?.[1];
    expect(ready, "could not read WORKER_READY_LOG").toBeTruthy();
    expect(failed, "could not read WORKER_FAILED_LOG").toBeTruthy();

    const tail = execFileSync(
      "docker",
      ["compose", ...FILE_ARGS, "logs", "--no-color", "--tail", "200", "dbos"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(tail).toContain(ready!);
    // THE POINT OF D43.4. Four services were deliberately crash-booted above; if any of
    // them had been the long-lived `dbos` container instead of a `--rm` one-off, this
    // string would be here and supagloo-nextjs's render lane would fail at its globalSetup
    // with a message blaming the wrong thing.
    expect(tail).not.toContain(failed!);
  });
});
