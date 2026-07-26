import { createSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  E2E_RUN_ID,
  buildE2eRepoDescription,
  buildE2eRepoName,
} from "./e2e-github-naming.mjs";

/**
 * THE SINGLE REAL-GITHUB E2E HARNESS.
 * ===================================
 *
 * Task 62 / design-delta §11 (D3). One implementation of every real-github.com
 * interaction the e2e lanes need, dynamic-imported by all four Code Locations (root,
 * api, dbos, nextjs) plus `scripts/cleanup-e2e-repos.mjs`. Zero dependencies, plain
 * ESM, no build step.
 *
 * CREDENTIAL SPLIT (D6) — this is the part that is easy to get subtly wrong:
 *
 *   | operation                                   | credential            |
 *   |---------------------------------------------|-----------------------|
 *   | GET /app/installations (discovery)          | App JWT               |
 *   | POST /user/repos (create a fixture repo)    | PAT                   |
 *   | PATCH /repos/:o/:r (archive)                | PAT                   |
 *   | branch + file seeding                       | installation token    |
 *   | everything UNDER TEST (clone/push/PR/merge) | product's own token   |
 *   | ASSERTION READS (/pulls, /refs, /commits)   | installation token    |
 *
 * The installation grants `contents:write`, `pull_requests:write`, `metadata:read` and
 * NOT `administration` (live-verified), so it cannot create or archive a repo — and
 * `POST /user/repos` is user-scoped regardless. Hence the PAT for lifecycle only.
 *
 * Assertion reads deliberately use the INSTALLATION token, never the PAT: a PAT is a
 * STRONGER credential than production ever holds, so reading with it could green-light
 * a permission the product does not actually have. A read that succeeds is itself a
 * scoping proof.
 *
 * NO TEARDOWN LIVES HERE, BY DESIGN. No auto-archive, no auto-delete, not even on
 * success (D6): the user mandated per-repo interactive confirmation, you almost always
 * need the repo to debug a red run, and an automated mutation in an account holding the
 * user's real repos is unacceptable. `scripts/cleanup-e2e-repos.mjs` is the ONLY
 * lifecycle-ending path.
 *
 * Unit-tested with an injected `fetch` in `tests/unit/e2e-github-api.test.ts` — the
 * unit lane makes no network egress (HARD RULE 5).
 */

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_WEB_BASE = "https://github.com";

const API_VERSION = "2022-11-28";
const USER_AGENT = "supagloo-e2e-harness";

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ env + secrets */

/** The root repo directory, resolved from this file's own location. */
export function rootDirPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** `<root>/.env` — the untracked file that holds every real credential. */
export function rootEnvPath(rootDir = rootDirPath()) {
  return resolve(rootDir, ".env");
}

/**
 * Load the root `.env` into `process.env`.
 *
 * `process.loadEnvFile` (Node >= 20.12; this repo runs Node 24) does NOT override an
 * already-set variable, so `GITHUB_APP_ID=… npm run test:e2e` still wins. Deliberately
 * swallows a missing file: the actionable message belongs to
 * `resolveGithubE2eSecrets()`'s per-var fail-fast, not to a generic ENOENT.
 *
 * D24: vitest runs globalSetup in the main process and specs in WORKERS, so this must
 * be called from a `setupFiles` entry too — env set in globalSetup never reaches a spec.
 */
export function loadRootEnv({ envFile, rootDir } = {}) {
  const path = envFile ?? rootEnvPath(rootDir);
  try {
    process.loadEnvFile(path);
    return path;
  } catch {
    return undefined;
  }
}

const SECRET_VARS = [
  ["appId", "GITHUB_APP_ID", "the numeric GitHub App id (Settings → Developer settings → GitHub Apps)"],
  ["appSlug", "GITHUB_APP_SLUG", "the App's URL slug, used to build its installation URL"],
  ["privateKey", "GITHUB_APP_PRIVATE_KEY", "the App's PEM private key (single-line escaped-\\n form is fine)"],
  [
    "pat",
    "GITHUB_E2E_PAT_TOKEN",
    "a classic PAT with the `repo` scope — needed because the App installation grants no `administration`, so an installation token can never CREATE or ARCHIVE a repo",
  ],
];

/**
 * `{ appId, appSlug, privateKey, pat }` or a throw naming the offending variable, the
 * root `.env` path and `.env.example`.
 *
 * D5 throw #1. Every failure in this module THROWS — never `console.warn` + skip.
 * plan row 56 item (2): vitest's default reporter collapses a skipped file's console
 * output, so a "loud skip" is invisible under `npm run test:e2e` — a green lie.
 *
 * Never includes a secret VALUE in an error message.
 */
export function resolveGithubE2eSecrets({ env = process.env, rootDir } = {}) {
  const out = {};
  for (const [key, varName, why] of SECRET_VARS) {
    const raw = env[varName];
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(
        `Real-GitHub e2e is not configured: ${varName} is missing or blank.\n` +
          `  What it is: ${why}.\n` +
          `  Set it in ${rootEnvPath(rootDir)} (untracked).\n` +
          "  The variable is documented, names-only, in .env.example.\n" +
          "  Every e2e lane reaches real github.com since task 62 — there is no stub fallback.",
      );
    }
    out[key] = key === "privateKey" ? normalizePemNewlines(raw) : raw.trim();
  }
  return out;
}

/* --------------------------------------------------------------------- App JWT */

/**
 * Normalise every `.env`-mangled PEM form to real newlines.
 *
 * This IS row 62 item (c)'s bug class: a `.env` file cannot hold a literal newline, so
 * the PEM arrives as one line with backslash-n pairs (and sometimes wrapped in quotes,
 * and sometimes CRLF from a Windows editor). Get this wrong and GitHub 401s the App JWT,
 * four layers away from the cause.
 *
 * Idempotent. `tests/unit/e2e-github-api.test.ts` fences it with the property that
 * actually matters: both forms must produce a BYTE-IDENTICAL signature.
 *
 * Residual risk, stated openly (D3): PEM normalisation now exists here, in db-lib's
 * `normalizePemNewlines`, and in the api's local `normalizePrivateKey`. This copy exists
 * because root and nextjs deliberately do not depend on db-lib; api and dbos pass
 * db-lib's own signer in via `signJwt` so the harness exercises the PRODUCT signer.
 */
export function normalizePemNewlines(raw) {
  let out = String(raw).trim();
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    out = out.slice(1, -1);
  }
  out = out
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  return `${out}\n`;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/**
 * RS256 App JWT, per GitHub's documented contract.
 *
 * `iat` is backdated 60s because GitHub rejects an `iat` in its own future (clock skew
 * between the runner and github.com is the classic cause of an inexplicable 401), and
 * `exp` stays inside GitHub's 10-minute maximum.
 *
 * root and nextjs use this. api and dbos pass db-lib's `signAppJwt` into
 * `discoverInstallation({ signJwt })` instead — see D3.
 */
export function signAppJwtLocal({ appId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: now - 60, exp: now + 480, iss: String(appId) }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(normalizePemNewlines(privateKey)).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/* ------------------------------------------------------------------- transport */

export function parseNextLink(linkHeader) {
  if (!linkHeader) return undefined;
  for (const part of String(linkHeader).split(",")) {
    const m = /^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/.exec(part);
    if (m) return m[1];
  }
  return undefined;
}

function retryDelayMs(headers, attempt) {
  const retryAfter = headers.get("retry-after");
  if (retryAfter && Number.isFinite(Number(retryAfter))) {
    return Math.min(Number(retryAfter) * 1000, 60_000);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset && Number.isFinite(Number(reset))) {
    const delta = Number(reset) * 1000 - Date.now();
    if (delta > 0) return Math.min(delta, 60_000);
  }
  return Math.min(500 * 2 ** (attempt - 1), 30_000);
}

/**
 * Is this status worth another attempt?
 *
 * D7: repo create/archive fall under GitHub's SECONDARY (abuse) limits, which are
 * account-scoped and far tighter than the verified 12500/hr core limit — those arrive as
 * `403 + Retry-After`. A bare `403` with no rate-limit signal is a PERMISSION problem and
 * must fail immediately, and a `422` is a genuine conflict (a duplicate repo name means a
 * bug, and a retry loop would mask it — D6).
 *
 * **Plan row 64 landed the product half (was deferred as "row N2").** The same semantics
 * now live in `supagloo-database-lib/src/github-retry.ts` (`isRetryableGithubStatus` /
 * `githubRetryDelayMs` / `withGithubRetry`) and back all four product GitHub callers:
 * db-lib's own `mintInstallationToken`, the API's App client, the DBOS git-ops REST
 * client, and `publish-version`'s tag creator (design-delta §11.7 "one implementation,
 * four consumers").
 *
 * This harness copy STAYS — it is test code, and the product must never depend on it (nor
 * this on the product). The two are kept semantically IDENTICAL on purpose: the 60s cap on
 * header-derived delays, the 30s cap on the blind exponential fallback, `maxAttempts = 4`,
 * and the verbatim-header exhaustion message all match `github-retry.ts` byte for byte in
 * behaviour. **If they ever diverge, the harness and the product are honouring GitHub
 * differently, which is a bug in whichever one moved.**
 */
function isRetryable(status, headers) {
  if (status === 429) return true;
  if (status >= 500) return true;
  if (status === 403) {
    return (
      headers.get("retry-after") !== null ||
      headers.get("x-ratelimit-remaining") === "0"
    );
  }
  return false;
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeBody(body) {
  if (body === undefined) return "";
  if (typeof body === "string") return body.slice(0, 400);
  if (body && typeof body === "object" && typeof body.message === "string") {
    const extra = Array.isArray(body.errors) ? ` ${JSON.stringify(body.errors)}` : "";
    return `${body.message}${extra}`;
  }
  return JSON.stringify(body).slice(0, 400);
}

/**
 * The one HTTP door to GitHub. Honours `Retry-After` / `x-ratelimit-reset` with capped
 * backoff and a BOUNDED attempt count, and surfaces the header value verbatim in the
 * final error text (never asserted on — D7).
 *
 * Throws on any status outside 2xx unless it is listed in `allowStatuses`; the token is
 * never included in an error message.
 */
export async function githubFetch(
  url,
  {
    method = "GET",
    token,
    body,
    headers = {},
    fetchImpl = globalThis.fetch,
    sleepImpl = realSleep,
    maxAttempts = 4,
    allowStatuses = [],
    label,
  } = {},
) {
  const init = {
    method,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": API_VERSION,
      "user-agent": USER_AGENT,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };

  let lastStatus;
  let lastHeaders;
  let lastBody;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetchImpl(url, init);
    const parsed = await readBody(res);
    lastStatus = res.status;
    lastHeaders = res.headers;
    lastBody = parsed;

    if (res.ok || allowStatuses.includes(res.status)) {
      return {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        body: parsed,
        next: parseNextLink(res.headers.get("link")),
      };
    }
    if (attempt < maxAttempts && isRetryable(res.status, res.headers)) {
      await sleepImpl(retryDelayMs(res.headers, attempt));
      continue;
    }
    break;
  }

  const retryAfter = lastHeaders?.get("retry-after");
  const reset = lastHeaders?.get("x-ratelimit-reset");
  throw new Error(
    `GitHub ${method} ${label ?? url} failed: HTTP ${lastStatus}` +
      (retryAfter ? ` (Retry-After: ${retryAfter})` : "") +
      (reset ? ` (x-ratelimit-reset: ${reset})` : "") +
      ` after ${maxAttempts} attempt(s) — ${describeBody(lastBody)}`,
  );
}

/** Walk `Link: rel="next"` to the end, concatenating array pages. */
async function paginate(firstUrl, opts) {
  const out = [];
  let url = firstUrl;
  let guard = 0;
  while (url) {
    if (++guard > 50) throw new Error(`pagination guard tripped walking ${firstUrl}`);
    const res = await githubFetch(url, opts);
    if (Array.isArray(res.body)) out.push(...res.body);
    else if (res.body && Array.isArray(res.body.repositories)) out.push(...res.body.repositories);
    url = res.next;
  }
  return out;
}

/**
 * Bounded retry for a real-host READ. GitHub's pulls/refs indexes are near-real-time but
 * not transactional, so an assertion firing microseconds after a merge can legitimately
 * observe the pre-merge state once (D9).
 */
export async function retryRead(read, { attempts = 6, delayMs = 1000, sleepImpl = realSleep } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const value = await read();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts) await sleepImpl(delayMs);
  }
  if (lastErr) throw lastErr;
  return undefined;
}

/* -------------------------------------------------------- installation discovery */

const installationCache = new Map();

/** Test-only: drop the per-process memo so a unit test can script a fresh discovery. */
export function resetInstallationCache() {
  installationCache.clear();
}

/**
 * Discover the App's installation at RUNTIME. D5, and the whole of row 62 item (d).
 *
 * Item (d) was never a stub bug: the dbos worker was always on real GitHub, 404ing on a
 * FABRICATED installation id (`42`) that the overlay's `GITHUB_APP_ID: "123456"` made
 * look plausible. So no id and no owner login is a literal anywhere in this codebase —
 * both are discovered here, memoised per process (one JWT, ~200 ms).
 *
 * Owner resolution: `SUPAGLOO_E2E_GITHUB_OWNER` when set; else "exactly one installation
 * ⇒ adopt it" (keeps the suite runnable with zero new config); else throw asking for the
 * variable.
 *
 * `signJwt` is optional: api and dbos pass db-lib's own `signAppJwt`, so the harness
 * exercises the PRODUCT signer and a broken product signer fails loudly here instead of
 * being masked by this module's second implementation (D3).
 */
export async function discoverInstallation({
  appId,
  appSlug = "supagloo",
  privateKey,
  ownerLogin,
  signJwt,
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
} = {}) {
  const wantedOwner = ownerLogin ?? env.SUPAGLOO_E2E_GITHUB_OWNER ?? undefined;
  const cacheKey = `${appId}|${wantedOwner ?? ""}`;
  if (installationCache.has(cacheKey)) return installationCache.get(cacheKey);

  const installUrl = `${GITHUB_WEB_BASE}/apps/${appSlug}/installations/new`;
  const promise = (async () => {
    const jwt = signJwt
      ? await signJwt({ appId, privateKey })
      : signAppJwtLocal({ appId, privateKey });

    const res = await githubFetch(`${GITHUB_API_BASE}/app/installations?per_page=100`, {
      token: jwt,
      fetchImpl,
      sleepImpl,
      allowStatuses: [401],
      label: "/app/installations",
    });

    // Throw #2 — blame the pairing, not the network. A 401 here means the JWT itself was
    // rejected, which in practice is either a wrong GITHUB_APP_ID for this PEM or a PEM
    // that survived .env mangling in a form the signer did not normalise.
    if (res.status === 401) {
      throw new Error(
        "GitHub rejected the App JWT (HTTP 401) from GET /app/installations.\n" +
          "  Does GITHUB_APP_ID match the key in GITHUB_APP_PRIVATE_KEY? They must be from the SAME App.\n" +
          "  A single-line escaped-\\n PEM is fine (it is normalised), but a truncated or re-wrapped PEM is not.\n" +
          `  Both live in ${rootEnvPath()}.`,
      );
    }

    const installations = Array.isArray(res.body) ? res.body : [];
    const logins = installations.map((i) => i?.account?.login).filter(Boolean);

    // Throw #3 — no installation at all. This was the LIVE finding behind row 62 item (d).
    if (installations.length === 0) {
      throw new Error(
        "The GitHub App has ZERO installations, so no e2e lane can mint an installation token.\n" +
          `  Install it here: ${installUrl}\n` +
          "  Grant it access to the account that should host the throwaway fixture repos.",
      );
    }

    let chosen;
    if (wantedOwner) {
      chosen = installations.find(
        (i) => String(i?.account?.login ?? "").toLowerCase() === wantedOwner.toLowerCase(),
      );
      // Throw #4 — installations exist, but not for the requested owner.
      if (!chosen) {
        throw new Error(
          `No GitHub App installation found for owner "${wantedOwner}".\n` +
            `  Installations that DO exist: ${logins.join(", ")}\n` +
            `  Either fix SUPAGLOO_E2E_GITHUB_OWNER, or install the App for that account: ${installUrl}`,
        );
      }
    } else if (installations.length === 1) {
      chosen = installations[0];
    } else {
      // Throw #5 — ambiguous. Never guess: the wrong choice creates throwaway repos in
      // someone else's account.
      throw new Error(
        `The GitHub App has ${installations.length} installations, so the e2e owner is ambiguous.\n` +
          `  Set SUPAGLOO_E2E_GITHUB_OWNER to one of: ${logins.join(", ")}\n` +
          `  (in ${rootEnvPath()}; the variable is documented in .env.example).`,
      );
    }

    return Object.freeze({
      installationId: String(chosen.id),
      ownerLogin: String(chosen.account.login),
      accountType: String(chosen.account.type ?? "User"),
      repositorySelection: chosen.repository_selection ?? undefined,
    });
  })();

  installationCache.set(cacheKey, promise);
  try {
    const value = await promise;
    installationCache.set(cacheKey, value);
    return value;
  } catch (err) {
    // Never cache a failure — the fix is usually "install the App", and the next call
    // should observe the new reality rather than replay a stale throw.
    installationCache.delete(cacheKey);
    throw err;
  }
}

/**
 * Mint an installation token with a locally-signed App JWT. root and nextjs use this;
 * api and dbos use db-lib's `mintInstallationToken` (the product path).
 */
export async function mintInstallationTokenLocal({
  appId,
  privateKey,
  installationId,
  signJwt,
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
}) {
  const jwt = signJwt
    ? await signJwt({ appId, privateKey })
    : signAppJwtLocal({ appId, privateKey });
  const res = await githubFetch(
    `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
    { method: "POST", token: jwt, fetchImpl, sleepImpl, label: "mint installation token" },
  );
  return res.body.token;
}

/* ---------------------------------------------------------- fixture-repo lifecycle */

// D7: repo CREATE falls under GitHub's secondary/abuse limits, which are account-scoped
// and much tighter than the core limit. Funnel every create through one module-level
// chain with ~1s spacing so a parallel-ish suite cannot trip them.
let createChain = Promise.resolve();
let lastCreateAt = 0;

function serializeCreate(fn, { sleepImpl = realSleep, spacingMs = 1000 } = {}) {
  const run = createChain.then(async () => {
    const wait = lastCreateAt + spacingMs - Date.now();
    if (wait > 0) await sleepImpl(wait);
    lastCreateAt = Date.now();
    return fn();
  });
  createChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Create ONE throwaway private repo for a spec run: `POST /user/repos` with the PAT.
 *
 * `auto_init: true` IS THE LOAD-BEARING DEFAULT, NOT COSMETIC (D6). `scaffold-project.ts`
 * opens its base PR with `base: "main"`; a commit-less repo has no `main` at all and
 * real GitHub 422s. This is exactly what the retired git-server fixture did with
 * `POST /__admin/repos {seed:true, defaultBranch:"main"}`. Anyone flipping the DEFAULT
 * to `false` breaks scaffold, commit, publish and the whole render lane at once.
 *
 * `autoInit: false` is an explicit, ADDITIVE opt-out added by plan row 63, whose e2e
 * acceptance needs a fixture with NO initial commit — that is the shape wireframe 13a's
 * "Empty · created just now" existing repo has, and (before row 63) the shape the
 * product's own create-new path produced. It is used by exactly ONE spec today:
 * `supagloo-nodejs-dbos/tests/e2e/scaffold-project.e2e.ts`'s commit-less case, reached
 * through `provisionFixtureRepo(slug, deps, { autoInit: false })`. Since row 63 the
 * workflow BOOTSTRAPS an unborn base ref itself, so that spec now scaffolds to
 * `succeeded` — but every other lane still relies on the default.
 *
 * Pair `autoInit: false` with `waitForRepoReady({ requireBranch: false })`: a
 * commit-less repo has no branch for that gate to observe.
 *
 * A 422 is FATAL and never retried: with per-run ids a name collision means a bug.
 */
export async function createFixtureRepo({
  pat,
  slug,
  runId = E2E_RUN_ID,
  spec = slug,
  autoInit = true,
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
}) {
  const name = buildE2eRepoName(slug, runId);
  return serializeCreate(
    async () => {
      const res = await githubFetch(`${GITHUB_API_BASE}/user/repos`, {
        method: "POST",
        token: pat,
        body: {
          name,
          private: true,
          auto_init: autoInit,
          description: buildE2eRepoDescription(spec, runId),
        },
        fetchImpl,
        sleepImpl,
        label: `create fixture repo ${name}`,
      });
      return res.body;
    },
    { sleepImpl },
  );
}

/**
 * Gate #1 before any workflow enqueue: a just-created repo can 404 briefly, and its
 * default branch appears a moment after the repo record does.
 *
 * `requireBranch: false` (plan row 63) waits on the repo RECORD only and never issues
 * the `…/branches/<branch>` GET. It exists for the deliberately commit-less fixture
 * (`createFixtureRepo({ autoInit: false })`), which has no branch at all: with the
 * default gate that case would burn the entire 20 s budget and then throw. Only pass it
 * where the repo is MEANT to have no branch.
 */
export async function waitForRepoReady({
  pat,
  owner,
  repo,
  branch = "main",
  requireBranch = true,
  timeoutMs = 20_000,
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
  nowImpl = Date.now,
}) {
  const deadline = nowImpl() + timeoutMs;
  let delay = 500;
  let lastStatus;
  for (;;) {
    const repoRes = await githubFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, {
      token: pat,
      fetchImpl,
      sleepImpl,
      allowStatuses: [404],
      label: `GET /repos/${owner}/${repo}`,
    });
    lastStatus = repoRes.status;
    if (repoRes.ok) {
      if (!requireBranch) return repoRes.body;
      const branchRes = await githubFetch(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/branches/${branch}`,
        {
          token: pat,
          fetchImpl,
          sleepImpl,
          allowStatuses: [404],
          label: `GET /repos/${owner}/${repo}/branches/${branch}`,
        },
      );
      if (branchRes.ok) return repoRes.body;
      lastStatus = branchRes.status;
    }
    if (nowImpl() >= deadline) break;
    await sleepImpl(delay);
    delay = Math.min(delay * 2, 2000);
  }
  throw new Error(
    `Fixture repo ${owner}/${repo} did not become ready within ${timeoutMs}ms ` +
      `(last status ${lastStatus}; expected the repo` +
      (requireBranch ? ` AND its "${branch}" branch` : "") +
      " to answer).\n" +
      (requireBranch
        ? "  If the repo exists but has no branch, the create call probably omitted auto_init:true — " +
          "that is the load-bearing DEFAULT (see D6). If the repo is MEANT to be commit-less " +
          "(createFixtureRepo({ autoInit: false }), plan row 63), pass requireBranch:false instead."
        : "  requireBranch:false was set, so only the repo record was awaited — this is a create/visibility " +
          "failure, not a missing branch."),
  );
}

/**
 * Gate #2 before any workflow enqueue: under `repository_selection: all` a brand-new
 * repo IS covered by the installation, but not instantly.
 *
 * Why this gate is mandatory rather than nice-to-have: dbos's `ensureRepoReachable`
 * (`scaffold-project/github-rest.ts`) treats absence as a PERMANENT
 * `RepoUnreachableError`, so a missing gate means non-retryable scaffold failures that
 * look like a product bug.
 */
export async function waitForInstallationVisibility({
  token,
  fullName,
  timeoutMs = 60_000,
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
  nowImpl = Date.now,
}) {
  const wanted = String(fullName).toLowerCase();
  const deadline = nowImpl() + timeoutMs;
  let delay = 1000;
  for (;;) {
    const repos = await paginate(
      `${GITHUB_API_BASE}/installation/repositories?per_page=100`,
      { token, fetchImpl, sleepImpl, label: "/installation/repositories" },
    );
    if (repos.some((r) => String(r?.full_name ?? "").toLowerCase() === wanted)) return true;
    if (nowImpl() >= deadline) break;
    await sleepImpl(delay);
    delay = Math.min(delay * 2, 5000);
  }
  throw new Error(
    `The App installation does not list ${fullName} within ${timeoutMs}ms.\n` +
      "  Under repository_selection:all a new repo becomes visible within seconds; if it never does, " +
      "the installation may be scoped to `selected` repositories instead.",
  );
}

/** Archive (never delete). PAT-only — the installation grants no `administration`. */
export async function archiveRepo({
  pat,
  owner,
  repo,
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
}) {
  const res = await githubFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, {
    method: "PATCH",
    token: pat,
    body: { archived: true },
    fetchImpl,
    sleepImpl,
    label: `archive ${owner}/${repo}`,
  });
  return res.body;
}

/** Every repo the PAT's user OWNS, following `Link: rel=next`. */
export async function listOwnerRepos({
  pat,
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
}) {
  return paginate(
    `${GITHUB_API_BASE}/user/repos?affiliation=owner&per_page=100&sort=created`,
    { token: pat, fetchImpl, sleepImpl, label: "/user/repos" },
  );
}

/* ------------------------------------------------- installation-token seeding + reads */

/** Cut a real branch from another branch's tip. Installation token — exercises contents:write. */
export async function createRef({
  token,
  owner,
  repo,
  branch,
  fromBranch = "main",
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
}) {
  const head = await githubFetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`,
    { token, fetchImpl, sleepImpl, label: `read ${fromBranch} tip` },
  );
  const res = await githubFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    token,
    body: { ref: `refs/heads/${branch}`, sha: head.body.object.sha },
    fetchImpl,
    sleepImpl,
    label: `create branch ${branch}`,
  });
  return res.body;
}

/**
 * Commit a file (creating or updating it) on a branch via the Contents API.
 *
 * Newly in play now that this is real (record in §11): the Contents API's 1 MB inline
 * cap and its representation switch above that, plus multi-segment paths — the retired
 * stub only ever handled a single path segment. Every fixture we commit is far under the
 * cap.
 */
export async function putContents({
  token,
  owner,
  repo,
  branch,
  path,
  content,
  message = `e2e fixture: ${path}`,
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
}) {
  const encodedPath = String(path)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodedPath}`;
  const existing = await githubFetch(`${url}?ref=${encodeURIComponent(branch)}`, {
    token,
    fetchImpl,
    sleepImpl,
    allowStatuses: [404],
    label: `probe ${path}`,
  });
  const res = await githubFetch(url, {
    method: "PUT",
    token,
    body: {
      message,
      branch,
      content: Buffer.from(String(content), "utf8").toString("base64"),
      ...(existing.ok && existing.body?.sha ? { sha: existing.body.sha } : {}),
    },
    fetchImpl,
    sleepImpl,
    label: `commit ${path} on ${branch}`,
  });
  return res.body;
}

/**
 * List pull requests. `state` defaults to "all" ON PURPOSE.
 *
 * D9/D18-1: a MERGED pr is CLOSED, so `state=open` silently observes an empty list. That
 * exact mistake is the product bug D18-1 fixes in dbos's `findOpenPrByHead`; the harness
 * must not repeat it.
 */
export async function listPulls({
  token,
  owner,
  repo,
  state = "all",
  head,
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
}) {
  const qs = new URLSearchParams({ state, per_page: "100" });
  if (head) qs.set("head", head);
  return paginate(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls?${qs.toString()}`,
    { token, fetchImpl, sleepImpl, label: `list pulls ${owner}/${repo}` },
  );
}

/** `refs/tags/*` on the real host. 404 means "no tags yet", which is an empty list. */
export async function listTagRefs({
  token,
  owner,
  repo,
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
}) {
  const res = await githubFetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/refs/tags`,
    { token, fetchImpl, sleepImpl, allowStatuses: [404], label: `list tags ${owner}/${repo}` },
  );
  if (!res.ok || !Array.isArray(res.body)) return [];
  return res.body;
}

export async function listBranches({
  token,
  owner,
  repo,
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
}) {
  return paginate(`${GITHUB_API_BASE}/repos/${owner}/${repo}/branches?per_page=100`, {
    token,
    fetchImpl,
    sleepImpl,
    label: `list branches ${owner}/${repo}`,
  });
}

/** Commit count on a branch. A 409 is real GitHub's "Git Repository is empty" ⇒ 0. */
export async function countCommitsOnBranch({
  token,
  owner,
  repo,
  branch = "main",
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
}) {
  let url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=100`;
  let count = 0;
  let guard = 0;
  while (url) {
    if (++guard > 50) throw new Error("commit pagination guard tripped");
    const res = await githubFetch(url, {
      token,
      fetchImpl,
      sleepImpl,
      allowStatuses: [409, 404],
      label: `count commits ${owner}/${repo}@${branch}`,
    });
    if (!res.ok) return 0;
    count += Array.isArray(res.body) ? res.body.length : 0;
    url = res.next;
  }
  return count;
}

export { E2E_RUN_ID, buildE2eRepoName, buildE2eRepoDescription };
