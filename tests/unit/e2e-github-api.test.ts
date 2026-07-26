import { generateKeyPairSync, createVerify } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GITHUB_API_BASE,
  createFixtureRepo,
  discoverInstallation,
  githubFetch,
  listOwnerRepos,
  listPulls,
  normalizePemNewlines,
  parseNextLink,
  resetInstallationCache,
  resolveGithubE2eSecrets,
  signAppJwtLocal,
  waitForRepoReady,
} from "../support/e2e-github-api.mjs";

// Task 62 / §11 (D3). Unit coverage for the ONE real-GitHub e2e harness. Every test
// here injects `fetch` and env — HARD RULE 5 / §10.6: the unit lane makes NO network
// egress. The live-egress proof is the e2e lanes in api / dbos / nextjs.

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Scripted fetch. `script` is consulted in order; each entry either matches every
 * request or is filtered by a `match` predicate on the URL. Records every request so
 * a test can assert "no PATCH was issued" / "exactly two token mints".
 */
function makeFetch(
  responses: Array<{
    match?: (url: string, init: RequestInit) => boolean;
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
    repeat?: boolean;
  }>,
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const queue = [...responses];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: String(init.method ?? "GET").toUpperCase(),
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(
          ([k, v]) => [k.toLowerCase(), String(v)],
        ),
      ),
      body: typeof init.body === "string" ? init.body : undefined,
    });
    const idx = queue.findIndex((r) => !r.match || r.match(url, init));
    if (idx === -1) throw new Error(`unscripted request: ${init.method ?? "GET"} ${url}`);
    const entry = queue[idx];
    if (!entry.repeat) queue.splice(idx, 1);
    const body =
      entry.body === undefined
        ? ""
        : typeof entry.body === "string"
          ? entry.body
          : JSON.stringify(entry.body);
    return new Response(body, {
      status: entry.status ?? 200,
      headers: { "content-type": "application/json", ...(entry.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => {};

const FULL_ENV = {
  GITHUB_APP_ID: "4338011",
  GITHUB_APP_SLUG: "supagloo",
  GITHUB_APP_PRIVATE_KEY: PEM,
  GITHUB_E2E_PAT_TOKEN: "ghp_fake_for_unit_test",
};

beforeEach(() => {
  resetInstallationCache();
});

describe("resolveGithubE2eSecrets — per-var fail-fast", () => {
  it("returns the four secrets when all are present", () => {
    const secrets = resolveGithubE2eSecrets({ env: { ...FULL_ENV } });
    expect(secrets.appId).toBe("4338011");
    expect(secrets.appSlug).toBe("supagloo");
    expect(secrets.pat).toBe("ghp_fake_for_unit_test");
    expect(secrets.privateKey).toContain("BEGIN PRIVATE KEY");
  });

  it.each([
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_E2E_PAT_TOKEN",
  ])("throws naming %s, the root .env path and .env.example", (missing) => {
    const env: Record<string, string> = { ...FULL_ENV };
    delete env[missing];
    let message = "";
    try {
      resolveGithubE2eSecrets({ env });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(missing);
    expect(message).toContain(".env");
    expect(message).toContain(".env.example");
  });

  it("treats a blank/whitespace value as missing (a blank var is the common .env typo)", () => {
    expect(() =>
      resolveGithubE2eSecrets({ env: { ...FULL_ENV, GITHUB_E2E_PAT_TOKEN: "   " } }),
    ).toThrow(/GITHUB_E2E_PAT_TOKEN/);
  });

  it("never echoes a secret value into the error text", () => {
    let message = "";
    try {
      resolveGithubE2eSecrets({ env: { ...FULL_ENV, GITHUB_APP_SLUG: "" } });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain("ghp_fake_for_unit_test");
    expect(message).not.toContain("BEGIN PRIVATE KEY");
  });
});

describe("signAppJwtLocal — row 62 item (c)'s bug class", () => {
  it("produces a BYTE-IDENTICAL signature for the escaped-\\n and real-newline PEM forms", () => {
    // This is the whole of row 62 item (c): a single-line `.env` PEM arrives with
    // literal backslash-n pairs. If normalisation is not byte-exact, GitHub 401s the
    // App JWT and the failure surfaces four layers away.
    const escaped = PEM.replace(/\n/g, "\\n");
    const now = 1_800_000_000;
    const a = signAppJwtLocal({ appId: "4338011", privateKey: PEM, now });
    const b = signAppJwtLocal({ appId: "4338011", privateKey: escaped, now });
    expect(b).toBe(a);
  });

  it("survives surrounding quotes and CRLF line endings", () => {
    const now = 1_800_000_000;
    const a = signAppJwtLocal({ appId: "4338011", privateKey: PEM, now });
    expect(
      signAppJwtLocal({ appId: "4338011", privateKey: `"${PEM}"`, now }),
    ).toBe(a);
    expect(
      signAppJwtLocal({
        appId: "4338011",
        privateKey: PEM.replace(/\n/g, "\r\n"),
        now,
      }),
    ).toBe(a);
  });

  it("emits a verifiable RS256 JWT whose claims match GitHub's App-JWT contract", () => {
    const now = 1_800_000_000;
    const jwt = signAppJwtLocal({ appId: "4338011", privateKey: PEM, now });
    const [h, p, s] = jwt.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(header).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe("4338011");
    // GitHub rejects an `iat` in its future; the documented guard is to backdate.
    expect(payload.iat).toBeLessThan(now);
    expect(payload.exp).toBeGreaterThan(now);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    expect(verifier.verify(PUBLIC_PEM, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("normalizePemNewlines is idempotent", () => {
    const once = normalizePemNewlines(PEM.replace(/\n/g, "\\n"));
    expect(normalizePemNewlines(once)).toBe(once);
    expect(once).toBe(PEM);
  });
});

describe("githubFetch — rate-limit handling (D7)", () => {
  it("retries a 403 + Retry-After within the cap and then succeeds", async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 403, headers: { "retry-after": "1" }, body: { message: "slow down" } },
      { status: 200, body: { ok: true } },
    ]);
    const res = await githubFetch(`${GITHUB_API_BASE}/user`, {
      token: "t",
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("retries a 429 and honours x-ratelimit-reset when Retry-After is absent", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 429,
        headers: { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1) },
        body: { message: "rate limited" },
      },
      { status: 200, body: { ok: true } },
    ]);
    const res = await githubFetch(`${GITHUB_API_BASE}/user`, {
      token: "t",
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("gives up after a BOUNDED number of attempts and surfaces Retry-After verbatim", async () => {
    // D7: the header value is surfaced in the message and NEVER asserted on by a
    // product test — a suite that asserts on GitHub's throttling is a flake factory.
    const { fetchImpl, calls } = makeFetch([
      {
        status: 403,
        headers: { "retry-after": "17" },
        body: { message: "abuse detection" },
        repeat: true,
      },
    ]);
    let message = "";
    try {
      await githubFetch(`${GITHUB_API_BASE}/user`, {
        token: "t",
        fetchImpl,
        sleepImpl: noSleep,
        maxAttempts: 3,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(calls).toHaveLength(3);
    expect(message).toContain("Retry-After: 17");
    expect(message).toContain("abuse detection");
  });

  it("does NOT retry a deterministic 4xx (a 422 name collision is a bug, not a blip)", async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 422, body: { message: "name already exists on this account" }, repeat: true },
    ]);
    await expect(
      githubFetch(`${GITHUB_API_BASE}/user/repos`, {
        method: "POST",
        token: "t",
        body: { name: "x" },
        fetchImpl,
        sleepImpl: noSleep,
      }),
    ).rejects.toThrow(/422/);
    expect(calls).toHaveLength(1);
  });
});

describe("discoverInstallation — the five fail-fast throws (D5)", () => {
  const base = { appId: "4338011", appSlug: "supagloo", privateKey: PEM };

  it("adopts the single installation when exactly one exists and no owner var is set", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: [
          {
            // A DELIBERATELY FAKE installation id. The live one is discovered at
            // runtime and changes on every reinstall, so writing it here would look
            // like a configured value and would age badly the first time the App is
            // reinstalled. What this asserts is the `String(chosen.id)` coercion of a
            // JSON NUMBER, which any id proves. (dbos's adapter test uses a fake id for
            // the same reason — keeping both fake means a repo-wide grep for the real
            // id stays empty, which is the invariant.)
            id: 77_700_099,
            account: { login: "ashtable", type: "User" },
            repository_selection: "all",
          },
        ],
      },
    ]);
    const found = await discoverInstallation({
      ...base,
      env: {},
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(found.installationId).toBe("77700099");
    expect(found.ownerLogin).toBe("ashtable");
    expect(found.repositorySelection).toBe("all");
    expect(calls[0].url).toContain("/app/installations");
    expect(calls[0].headers.authorization).toMatch(/^Bearer /);
  });

  it("matches account.login case-insensitively when SUPAGLOO_E2E_GITHUB_OWNER is set", async () => {
    const { fetchImpl } = makeFetch([
      {
        status: 200,
        body: [
          { id: 1, account: { login: "someone-else", type: "User" } },
          { id: 2, account: { login: "AshTable", type: "User" } },
        ],
      },
    ]);
    const found = await discoverInstallation({
      ...base,
      env: { SUPAGLOO_E2E_GITHUB_OWNER: "ashtable" },
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(found.installationId).toBe("2");
    expect(found.ownerLogin).toBe("AshTable");
  });

  it("throw #2: a 401 blames the App-id/PEM pairing, not the network", async () => {
    const { fetchImpl } = makeFetch([
      { status: 401, body: { message: "A JSON web token could not be decoded" } },
    ]);
    await expect(
      discoverInstallation({ ...base, env: {}, fetchImpl, sleepImpl: noSleep }),
    ).rejects.toThrow(/GITHUB_APP_ID/);
  });

  it("throw #3: zero installations names the install URL for THIS app slug", async () => {
    const { fetchImpl } = makeFetch([{ status: 200, body: [] }]);
    await expect(
      discoverInstallation({ ...base, env: {}, fetchImpl, sleepImpl: noSleep }),
    ).rejects.toThrow("https://github.com/apps/supagloo/installations/new");
  });

  it("throw #4: owner not found lists the logins that WERE found, plus the install URL", async () => {
    const { fetchImpl } = makeFetch([
      {
        status: 200,
        body: [
          { id: 1, account: { login: "octocat", type: "User" } },
          { id: 2, account: { login: "some-org", type: "Organization" } },
        ],
      },
    ]);
    let message = "";
    try {
      await discoverInstallation({
        ...base,
        env: { SUPAGLOO_E2E_GITHUB_OWNER: "ashtable" },
        fetchImpl,
        sleepImpl: noSleep,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("octocat");
    expect(message).toContain("some-org");
    expect(message).toContain("https://github.com/apps/supagloo/installations/new");
  });

  it("throw #5: >1 installation with no owner var names the var and the logins", async () => {
    const { fetchImpl } = makeFetch([
      {
        status: 200,
        body: [
          { id: 1, account: { login: "octocat", type: "User" } },
          { id: 2, account: { login: "ashtable", type: "User" } },
        ],
      },
    ]);
    let message = "";
    try {
      await discoverInstallation({ ...base, env: {}, fetchImpl, sleepImpl: noSleep });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("SUPAGLOO_E2E_GITHUB_OWNER");
    expect(message).toContain("octocat");
    expect(message).toContain("ashtable");
  });

  it("memoises per process — one JWT + one /app/installations call per owner", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: [{ id: 7, account: { login: "ashtable", type: "User" } }],
        repeat: true,
      },
    ]);
    const opts = { ...base, env: {}, fetchImpl, sleepImpl: noSleep };
    const a = await discoverInstallation(opts);
    const b = await discoverInstallation(opts);
    expect(b).toEqual(a);
    expect(calls).toHaveLength(1);
  });

  it("uses an INJECTED signJwt when given (api/dbos pass db-lib's product signer)", async () => {
    // D3: the harness must exercise the PRODUCT signer in api/dbos, so a broken
    // product signer fails loudly instead of being masked by a second implementation.
    const { fetchImpl, calls } = makeFetch([
      { status: 200, body: [{ id: 9, account: { login: "ashtable", type: "User" } }] },
    ]);
    let signerCalledWith: unknown;
    await discoverInstallation({
      ...base,
      env: {},
      fetchImpl,
      sleepImpl: noSleep,
      signJwt: (args: unknown) => {
        signerCalledWith = args;
        return "product.signed.jwt";
      },
    });
    expect(signerCalledWith).toMatchObject({ appId: "4338011" });
    expect(calls[0].headers.authorization).toBe("Bearer product.signed.jwt");
  });
});

// ---------------------------------------------------------------------- plan row 63
// Row 63's e2e acceptance needs a fixture repo with NO initial commit — the case the
// product's own create-new path produces today and that 422s. The harness could not
// make one: `auto_init: true` was hardcoded. The change is strictly ADDITIVE — the
// DEFAULT stays `true`, because four lanes (scaffold, commit, publish, render) depend
// on the fixture having a real `main` from the first byte.
describe("createFixtureRepo — autoInit (row 63, additive)", () => {
  it("defaults to auto_init:true", async () => {
    // GUARD, not a red test: this pins the default that scaffold/commit/publish/render
    // all rely on. If it ever goes red, someone flipped the default and took down four
    // lanes at once.
    const { fetchImpl, calls } = makeFetch([{ status: 201, body: { name: "r" } }]);
    await createFixtureRepo({
      pat: "p",
      slug: "scaffold-happy",
      runId: "runid42",
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(JSON.parse(calls[0].body!).auto_init).toBe(true);
  });

  it("sends auto_init:false when autoInit:false is passed", async () => {
    const { fetchImpl, calls } = makeFetch([{ status: 201, body: { name: "r" } }]);
    await createFixtureRepo({
      pat: "p",
      slug: "scaffold-unborn",
      runId: "runid42",
      autoInit: false,
      fetchImpl,
      sleepImpl: noSleep,
    });
    const body = JSON.parse(calls[0].body!);
    expect(body.auto_init).toBe(false);
    // Everything else about the create is unchanged — private, and the named repo.
    expect(body.private).toBe(true);
  });
});

describe("waitForRepoReady — branch gate (row 63, additive)", () => {
  it("resolves on the repo record alone when requireBranch:false, issuing no /branches/* request", async () => {
    // A commit-less repo has no `main`, so the default gate would burn its full 20 s
    // budget and then throw a message blaming the caller for omitting `auto_init`.
    const { fetchImpl, calls } = makeFetch([
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), status: 200, body: { size: 0 } },
    ]);
    await expect(
      waitForRepoReady({
        pat: "p",
        owner: "o",
        repo: "r",
        requireBranch: false,
        fetchImpl,
        sleepImpl: noSleep,
        timeoutMs: 5_000,
      }),
    ).resolves.toBeTruthy();
    expect(calls.filter((c) => c.url.includes("/branches/"))).toEqual([]);
  });
});

describe("waitForRepoReady — bounded, named give-up", () => {
  it("resolves once the repo AND its default branch answer", async () => {
    const { fetchImpl } = makeFetch([
      { match: (u) => u.endsWith("/branches/main"), status: 200, body: { name: "main" } },
      { match: (u) => /\/repos\/[^/]+\/[^/]+$/.test(u), status: 200, body: { size: 0 } },
    ]);
    await expect(
      waitForRepoReady({
        pat: "p",
        owner: "o",
        repo: "r",
        fetchImpl,
        sleepImpl: noSleep,
        timeoutMs: 5_000,
      }),
    ).resolves.toBeTruthy();
  });

  it("gives up with an error naming owner/repo and the budget it exhausted", async () => {
    const { fetchImpl } = makeFetch([
      { status: 404, body: { message: "Not Found" }, repeat: true },
    ]);
    let message = "";
    try {
      await waitForRepoReady({
        pat: "p",
        owner: "ashtable",
        repo: "some-fixture",
        fetchImpl,
        sleepImpl: noSleep,
        timeoutMs: 0,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("ashtable/some-fixture");
    expect(message).toMatch(/\b0\s?ms\b|within/);
  });
});

describe("pagination", () => {
  it("parseNextLink extracts only rel=next", () => {
    const header =
      '<https://api.github.com/user/repos?page=2>; rel="next", ' +
      '<https://api.github.com/user/repos?page=5>; rel="last"';
    expect(parseNextLink(header)).toBe("https://api.github.com/user/repos?page=2");
    expect(parseNextLink('<https://x>; rel="prev"')).toBeUndefined();
    expect(parseNextLink(null)).toBeUndefined();
  });

  it("listOwnerRepos follows Link rel=next to the end", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) => !u.includes("page=2"),
        status: 200,
        body: [{ name: "a" }],
        headers: {
          link: '<https://api.github.com/user/repos?affiliation=owner&per_page=100&page=2>; rel="next"',
        },
      },
      { match: (u) => u.includes("page=2"), status: 200, body: [{ name: "b" }] },
    ]);
    const repos = await listOwnerRepos({ pat: "p", fetchImpl, sleepImpl: noSleep });
    expect(repos.map((r: { name: string }) => r.name)).toEqual(["a", "b"]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("affiliation=owner");
  });
});

describe("assertion readers", () => {
  it("listPulls defaults to state=all (D9 — a merged PR is CLOSED)", async () => {
    // `state=open` is exactly the product bug D18-1 fixes; the harness must not
    // repeat it, or a merged-PR assertion silently observes an empty list.
    const { fetchImpl, calls } = makeFetch([{ status: 200, body: [] }]);
    await listPulls({ token: "t", owner: "o", repo: "r", fetchImpl, sleepImpl: noSleep });
    expect(calls[0].url).toContain("state=all");
    expect(calls[0].url).not.toContain("state=open");
  });

  it("listPulls reads with the INSTALLATION token, never the PAT (D6)", async () => {
    // A PAT is a STRONGER credential than production ever holds; reading with it
    // could green-light a permission the product does not actually have.
    const { fetchImpl, calls } = makeFetch([{ status: 200, body: [] }]);
    await listPulls({
      token: "ghs_installation",
      owner: "o",
      repo: "r",
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(calls[0].headers.authorization).toBe("Bearer ghs_installation");
  });
});
