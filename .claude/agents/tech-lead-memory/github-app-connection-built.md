---
name: github-app-connection-built
description: Task 11 (M2) built the GitHub App connection surface — install-url/callback/disconnect/repos routes, shared signAppJwt + mintInstallationToken in db-lib, App-JWT-enforcing stub + repo-listing route
metadata:
  type: convention
---

Built 2026-07-18 (plan task 11). First GitHub code in the system. TDD plan:
`scratch/task-11-github-app-connection.md`. Realizes
[[github-app-installation-tokens]]. Depends on [[auth-and-sessions-built]] (bearer
`requireAuth`, `/v1` scope, seed seam) + [[provider-stub-harness]] (github-stub).

**Shared GitHub App primitives live in `database-lib/src/github.ts`** (exported
from `src/index.ts` alongside `secrets.ts`), NOT the API — same "one impl for API
+ DBOS" precedent as `encryptSecret`. Two pure/injectable, env-free functions:
`signAppJwt({appId, privateKey, now?, skewSeconds?, ttlSeconds?})` and
`mintInstallationToken({appId, privateKey, installationId, apiBaseUrl, fetchImpl?,
now?})` → `{token, expiresAt}` (NEVER persisted; fresh exchange every call). Plus
`GithubAppError` (machine-readable `code`, mirrors `SecretCryptoError`). db-lib's
FIRST outbound-HTTP surface — fetch is injectable so unit tests stay network-free.

**App JWT is hand-rolled RS256 on `node:crypto`** (no jsonwebtoken/jose — house
style). `createSign("RSA-SHA256").sign(pkcs1Pem)` == RS256; GitHub App keys are
PKCS#1 PEM. Claims = GitHub's documented pattern: `iat = floor(now/1000) − 60`
(skew), `exp = floor(now/1000) + 600` (10-min max), `iss = GITHUB_APP_ID`; header
`{alg:"RS256",typ:"JWT"}`. base64url(header)+"."+base64url(claims)+"."+sig.

**Wire-type collision trap (extends the `AuthUser`-not-`User` rule):** the wire
connection DTO is **`GithubConnectionStatus(Schema)`**, NOT `GithubConnection` —
Prisma's `generated/prisma/client.ts` exports `type GithubConnection`, and a
same-named `export type` in `schemas.ts` is silently DROPPED from the barrel by the
ambiguous `export *`. Rule for every future task adding a wire DTO whose name
matches a Prisma model: suffix it (`*Status`, `Auth*`). New Task-11 DTOs (all in
`schemas.ts`): `GithubInstallUrlResponse`, `GithubCallbackRequest`
(installationId accepts string|number → String), `GithubConnectionStatus`,
`GithubConnectionResponse`, `GithubDisconnectResponse`, `GithubRepo`,
`GithubRepoListResponse`, `GithubRepoFilter` (closed `empty|all` enum).

**API layering** (`src/connections/`): `makeGithubAppClient({apiBaseUrl, appId,
privateKey, fetchImpl?})` → `{verifyInstallation, listInstallationRepos}` (wraps
db-lib primitives, mirrors `youversion.ts` injectable-fetch; normalizes escaped
`\n` in the PEM at this boundary). `GithubConnectionService` injected with
`{prisma, verifyInstallation, listInstallationRepos, oauthBaseUrl, appSlug,
clock?}` — the raw `mintInstallationToken` is encapsulated INSIDE
`listInstallationRepos`, so the service never touches JWT/HTTP and the
"mint-fresh-per-call, never store" invariant lives in one method. `filterRepos`
(`repo-filter.ts`) is a pure fn: `filter=empty` keeps `empty===true` (derived from
GitHub `size===0`), `q=` is case-insensitive substring over name+fullName — done
IN-PROCESS because `GET /installation/repositories` has no server-side search.

**Endpoints** (all `{preHandler: app.requireAuth}`, registered in the same
`buildApp` `/v1` bearer block when a new `github` dep is passed):
`GET /v1/connections/github/install-url` (→ `{oauthBase}/apps/{slug}/installations/new`,
no network) · `POST /v1/connections/github/callback {installationId}` (App-JWT
verify → upsert, verify-fail → 400 `InstallationVerificationError`) ·
`DELETE /v1/connections/github` (idempotent `deleteMany`) ·
`GET /v1/github/repos?filter=empty|all&q=` (mints a token per call; **409
`GithubNotConnectedError`** if no connection). NOTE: Fastify validates body BEFORE
the `requireAuth` preHandler, so an unauthenticated callback with a bad body 400s
(not 401) — standard ordering; auth-guard tests must send a valid body.

**GithubConnection Prisma model matched the design field-for-field — no migration.**
Stores ONLY `userId, githubLogin, installationId, repositorySelection, status,
connectedAt`. **No token column** (e2e asserts the persisted row's keys are exactly
those 6, none matching /token|ciphertext|secret/).

**New REQUIRED env vars** (`src/config/env.ts`): `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, and **`GITHUB_APP_SLUG`** (the brief named only the first
two — the hosted install URL is addressed by the app's *slug*, which can't be
derived from the numeric id, so a third var was necessary). App-level, NOT per-user
→ bypass §2.10 encryption. Making them required forced `env.test.ts` onto a
`validEnv()` base helper. Escaped-`\n` PEM normalized at the client, not in env/db-lib.

**Stub changes** (`tests/stubs/src/github-stub.ts`): (1) `GET
/app/installations/:id` now ENFORCES a present App-JWT (`hasAppJwt`, 401 otherwise
— presence/shape only, no signature check: the stub has no public key, RS256
correctness is the db-lib unit test's job) — so the callback e2e proves the API
signs one. (2) NEW `GET /installation/repositories` requires a `ghs_` installation
token, returns a deterministic mixed-`size` fixture set (acme/{empty-one,empty-two}
size 0; {psalms-video,genesis-app} >0), increments `state.reposListed`. The e2e
proves mint-per-call via `state.installationTokensIssued===2` after two `/repos`
calls (stub reset first).

**e2e ran IN-PROCESS** (`tests/e2e/github-connection.e2e.ts`, real Postgres + real
containerized github-stub, App JWT signed with a keypair generated in `beforeAll`)
per [[in-flight-dblib-e2e-constraint]] — global-setup extended to also spawn
`github-stub` with a route-presence probe (`GET /installation/repositories` → 401
on current image, 404 on stale). Root `stub-github.e2e.ts` + containerized-API
full-stack e2e DEFERRED to the submodule bump; covered meanwhile by root unit +
in-process API e2e. Final: db-lib 139 unit, API 83 unit + 10 e2e, root 63 unit.

**OUT OF SCOPE (built later):** create-new-repo JIT zero-storage user-token hop
(§2.3/§6b) — structurally different (user-auth code exchange, single-use); the
stub's `/login/oauth/access_token` + `/user/repos` routes exist from task 9 but the
API side is a future task. NOT folded into `mintInstallationToken`.
