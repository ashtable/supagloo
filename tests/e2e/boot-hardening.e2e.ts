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
 * supagloo-nextjs used NOT to be the same shape, and Step 11 (item 7 / R4344-1) closed the
 * gap. Its boot validator runs in `instrumentation.ts`'s `register()`, which Next awaits
 * inside `prepareImpl()`. A throw there DOES abort `prepare()` — but under `next start`
 * (Next 16.2.10) Next CATCHES the resulting rejection at its own top level, logs
 * `Failed to prepare server` + `unhandledRejection`, and KEEPS THE LISTENER OPEN. MEASURED
 * at the time: `✓ Ready in 67ms`, then the refusal, and the container **still `Up` after
 * 30 s**, answering HTTP 500 to every request. Row 43's "refuses to boot" was therefore
 * unmet, and E-BH5/E-BH6 as first written asserted a refusal that provably never happened.
 *
 * `register()` now calls `process.exit(1)` after the redacted line, so nextjs refuses to
 * boot in the same observable way api and dbos do, and E-BH5/E-BH6 below are one-off
 * containers asserting a real non-zero exit. RE-MEASURED against the rebuilt image:
 * `docker compose run --rm --no-deps -e YV_APP_KEY= nextjs` ⇒ **exit 1**, one
 * `[supagloo-nextjs] boot refused` line naming `YV_APP_KEY`. Note that
 * `Failed to prepare server` is NO LONGER printed and must not be asserted: the exit now
 * happens inside `register()`, i.e. BEFORE Next's own catch can run. `next build` is
 * unaffected — Next skips `register()` in `phase-production-build` (verified twice).
 *
 * ---------------------------------------------------------------------------------------
 * WHY THE ONE HEALTHY-NEXTJS CASE (E-BH8) EXISTS — RX-1 / RX-5
 * ---------------------------------------------------------------------------------------
 * Row 43's acceptance column is "refuses to boot with a clear error; **healthy boot with
 * valid env**", and the healthy half was the one case this spec never asserted for nextjs.
 * That mattered: the image baked `build-time-placeholder-not-a-real-key` into 33
 * prerendered payloads under `/app/.next` and served it to browsers regardless of the
 * container's `YV_APP_KEY`, while root's only assertion about that value
 * (`compose-config.test.ts`, "passes only a NON-SECRET placeholder as the build arg")
 * effectively certified the broken configuration. E-BH8 is the missing positive case, and it
 * was RED before item 8's fix — MEASURED against an image built from the pre-fix commit:
 * `GET /` ⇒ 200 with the placeholder present **once** and the runtime key present **zero**
 * times. Against the fixed image: 200, runtime key once, placeholder zero.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * WHAT A GREEN RUN OF THIS FILE DOES AND DOES NOT PROVE — RX-9. Read before quoting it.
 *
 * `docker-compose.override.yml` is gitignored and, when present, redirects all four build
 * contexts (`migrate`, `api`, `dbos`, `nextjs`) from root's SUBMODULES to the sibling
 * `~/code/*` checkouts. Every green run of this suite so far was obtained with it active,
 * so it is evidence about the sibling checkouts, NOT about the trees `docker-compose.yml`
 * names. Step 8's M13 confirmed the two differ in practice.
 *
 * That is not a defect in the override — root's gitlinks are bumped in a later step by
 * design — but it means the committed configuration is unproven until someone runs this
 * suite with the override absent and the gitlinks bumped. The procedure and its machine-read
 * record live in `docs/release-gate.md`, enforced by
 * `tests/unit/committed-config-gate.test.ts`.
 */

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
  /**
   * TRUE when the container was still running when the harness killed it, i.e. when there
   * was no exit code at all. It has to be reported separately, because a hang produces
   * `status: null` from `execFileSync` and `?? -1` would then satisfy `not.toBe(0)` —
   * "refused to boot" passing on "never finished booting" is exactly the green lie
   * E-BH5/E-BH6 shipped once already (a container that stays up forever).
   */
  timedOut: boolean;
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
    return { status: 0, output, timedOut: false };
  } catch (err) {
    const e = err as {
      status?: number | null;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: e.status ?? -1,
      output: `${e.stdout ?? ""}\n${e.stderr ?? ""}`,
      timedOut: e.status === null || e.status === undefined,
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
 * Start a one-off container DETACHED on an EPHEMERAL host port, hand it to `fn`, and ALWAYS
 * destroy it — including on an assertion failure.
 *
 * RX-7, and the reason there is no `--service-ports` here. `--service-ports` publishes the
 * service's declared mapping, which for `nextjs` is `"8000:3000"` — the same host port the
 * long-lived Compose service claims. It passed only because root's `global-setup.ts`
 * deliberately excludes `nextjs` from `INFRA_SERVICES` and no `nextjs` container was
 * running; but README and row 47's golden path both say `docker compose up --build`, which
 * starts it. With the stack up, `docker compose run -d --service-ports nextjs` fails with
 * `port is already allocated`, `execFileSync` throws BEFORE `detached.push(id)` — so the
 * stopped container leaks too (this is `run -d`, not `run --rm`) — and the failure blames
 * nothing useful. `-p 0:3000` lets the kernel pick; `docker port` reads it back.
 *
 * The teardown is per-case as well as per-file, so a container never outlives its own test.
 */
async function withDetached(
  service: string,
  overrides: Record<string, string>,
  fn: (ctx: { logs: () => string; baseUrl: string }) => Promise<void>,
): Promise<void> {
  const envArgs = Object.entries(overrides).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const id = execFileSync(
    "docker",
    ["compose", ...FILE_ARGS, "run", "-d", "--no-deps", "-p", "0:3000", ...envArgs, service],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
    .trim()
    .split("\n")
    .pop()!;
  detached.push(id);
  // e.g. "0.0.0.0:55000" / "[::]:55000" — take the last colon-separated field.
  const mapping = execFileSync("docker", ["port", id, "3000"], { encoding: "utf8" })
    .trim()
    .split("\n")[0];
  const port = mapping.slice(mapping.lastIndexOf(":") + 1);
  if (!/^\d+$/.test(port)) {
    throw new Error(`could not read the published port for ${service}: ${mapping || "<none>"}`);
  }
  try {
    await fn({
      baseUrl: `http://localhost:${port}`,
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
 * Retry `GET url` until it answers, and return the first status it gives.
 *
 * The retry loop is not a sampler standing in for a proof — it is waiting for a container
 * to finish starting, bounded, and the value it returns IS the assertion. `next start`
 * (Next 16.2.10) prints `✓ Ready` and binds the port before the first request completes, so
 * a single un-retried fetch races the listener.
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

describe("E-BH: nextjs refuses to BOOT on a bad env (D43.3 / §9 S4)", () => {
  it(
    "E-BH5 — an empty YV_APP_KEY exits non-zero and names the variable",
    () => {
      const { status, output, timedOut } = runOneOff("nextjs", { YV_APP_KEY: "" });
      // `timedOut` first, and separately: before item 7 this container printed the refusal
      // and then STAYED UP (measured: still `Up` after 30 s, answering 500s), which
      // `not.toBe(0)` alone would have passed on via the harness's own kill signal.
      expect(timedOut, "the container never exited — it is still the old shape").toBe(false);
      expect(status).not.toBe(0);
      expect(status).toBeGreaterThan(0);
      expect(output).toContain("YV_APP_KEY");
      expect(output).toContain("boot refused");
      // NOT `Failed to prepare server`: the exit now happens inside `register()`, before
      // Next's own top-level catch can log that. Asserting it would re-pin the old shape.
      expect(output).not.toContain("Failed to prepare server");
    },
    180_000,
  );

  it(
    "E-BH6 — a VALID secrets key is still a boot refusal: nextjs must never hold one",
    () => {
      // The S4 inversion, proved at the Compose level. plan row 43 says "all three
      // services validate SECRETS_ENCRYPTION_KEY"; nextjs has no database and no S3 access
      // and never calls encryptSecret/decryptSecret, so implementing that sentence
      // literally would hand the application secrets key to the one process the design
      // says must never hold it. The correct check is ABSENCE — and a perfectly valid key
      // is exactly the case a weaker check would wave through.
      const { status, output, timedOut } = runOneOff("nextjs", {
        YV_APP_KEY: "present-so-this-is-not-the-reason",
        SECRETS_ENCRYPTION_KEY: DEV_KEY,
      });
      expect(timedOut).toBe(false);
      expect(status).toBeGreaterThan(0);
      expect(output).toContain("SECRETS_ENCRYPTION_KEY");
      expect(output).toContain("boot refused");
      // The refusal must not be an excuse to print the key.
      expect(output).not.toContain(DEV_KEY);
    },
    180_000,
  );
});

describe("E-BH8 — a HEALTHY nextjs serves the RUNTIME key (RX-1 / RX-5)", () => {
  it(
    "serves the container's YV_APP_KEY, and no build-time placeholder",
    async () => {
      // The positive half of row 43's acceptance column, and the only test anywhere that
      // asserts a healthy nextjs. It is deliberately about the SERVED BYTES rather than
      // about the container's environment: the defect it catches is precisely a container
      // whose env is correct and whose HTML is not, because `app/layout.tsx` read the key at
      // module scope during `next build` and the value crossed a client-component boundary
      // into the prerendered RSC payload. `await connection()` in `RootLayout` (D1) makes
      // the read per-request.
      //
      // The value must not look like a credential (it lands in a log-visible HTML body) and
      // must not collide with the placeholder substring.
      const RUNTIME_KEY = "e-bh8-runtime-key-not-a-placeholder";
      await withDetached("nextjs", { YV_APP_KEY: RUNTIME_KEY }, async ({ baseUrl, logs }) => {
        const status = await probe(`${baseUrl}/`, 90_000);
        expect(status, logs()).toBe(200);
        const body = await (await fetch(`${baseUrl}/`)).text();
        expect(body).toContain(RUNTIME_KEY);
        // MEASURED against an image built from the pre-fix commit: this string was present
        // once and RUNTIME_KEY zero times, on a container given RUNTIME_KEY.
        expect(body).not.toContain("build-time-placeholder-not-a-real-key");
        expect(body).not.toContain("placeholder-not-a-real-key");
        // A healthy boot must ALSO not print a refusal — the two halves of row 43's column
        // in one case.
        expect(logs()).not.toContain("boot refused");
      });
    },
    240_000,
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
