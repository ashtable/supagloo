---
name: openrouter-gloo-connections-built
description: Task 12 (M2, LAST task) built the OpenRouter + Gloo connection surface + merged GET /v1/connections — encrypt-at-rest, keyLast4, live credits proxy, Gloo verify-then-store, three-table merge
metadata:
  type: convention
---

Built 2026-07-18 (plan task 12) — **closes M2 "API core: auth + real connections"**.
TDD plan: `scratch/task-12-openrouter-gloo-connections.md`. Direct template was
[[github-app-connection-built]] (task 11). Depends on [[auth-and-sessions-built]]
(`requireAuth`, `/v1`, seed) + [[provider-stub-harness]] (openrouter-stub :4802,
gloo-stub :4803) + task-6 secret-crypto + [[in-flight-dblib-e2e-constraint]] (e2e
in-process).

**Consumes the task-6 secrets primitive; never re-implements crypto.** New REQUIRED
env `SECRETS_ENCRYPTION_KEY` (64-hex, validated by a `SECRETS_KEY_HEX` regex in
`src/config/env.ts` mirroring db-lib's `KEY_HEX`) is threaded into the two services,
which call db-lib `encryptSecret`/`decryptSecret` DIRECTLY (pure fns → unit tests
pass a real `randomBytes(32).toString("hex")` key and assert round-trips, no fakes
for crypto). Added to `.env.example` + root `docker-compose.test.yml` api.env
(all-zero 64-hex test key). Making it required forced nothing new — `env.test.ts`
already had a `validEnv()` base (task 11); just added the key there.

**Endpoint asymmetry is DELIBERATE (design-delta §8) — do not "fix":** OpenRouter
`POST /v1/connections/openrouter {key}` (browser already did PKCE, NO server-side
callback route) vs Gloo `PUT /v1/connections/gloo {clientId,clientSecret}`
(verify-then-store). Full set (all `preHandler: app.requireAuth`, owner =
`req.authUser!.id`): `GET /connections` (merged) · `POST /connections/openrouter` ·
`GET /connections/openrouter/credits` · `DELETE /connections/openrouter` ·
`PUT /connections/gloo` · `DELETE /connections/gloo`.

**`keyLast4` = `key.slice(-4)` computed BEFORE encryption**, stored plaintext beside
the ciphertext. API returns raw `keyLast4` (task-11 "raw display fields" rule); UI
composes `sk-or-••••••{keyLast4}`. Gloo has NO plaintext-secret fragment (only
`clientId` is plaintext) → no Gloo `keyLast4` analog.

**Credits proxy reshapes, never stores:** stub `GET /api/v1/credits` →
`{data:{total_credits,total_usage}}`; service returns
`{totalCredits, totalUsage, remaining: totalCredits−totalUsage}`. The client
forwards the DECRYPTED key as `Bearer` (unit test asserts the decrypted, not the
ciphertext, is what's sent).

**Gloo verify-then-store (the headline invariant):** `GlooConnectionService.connect`
calls the injected `verifyClientCredentials` (client-credentials test mint) FIRST;
on false → throws `GlooVerificationError` (400) and **touches no DB** (unit +
e2e assert `upsert` not called / `findUnique` null). The minted token is discarded —
only `lastVerifiedAt` is persisted.

**Layering mirrors task 11 exactly** (`src/connections/`): thin injectable-fetch
clients `makeOpenRouterClient({apiBaseUrl,fetchImpl?})` → `getCredits(key)` and
`makeGlooClient(...)` → `verifyClientCredentials({clientId,clientSecret})` (2xx→true,
**4xx→false** (expected bad-cred rejection), 5xx→throw). Services injected with
`{prisma, <outbound closure>, encryptionKey, clock?}`, own their prisma upsert/
deleteMany (idempotent). Errors (`src/connections/errors.ts`, extended):
`+GlooVerificationError(400)`, `+OpenRouterNotConnectedError(409, credits-when-
disconnected)`. Did NOT add `GlooNotConnectedError` (disconnect is idempotent →
no caller; YAGNI).

**Merged `GET /v1/connections` = a dedicated pure reader `ConnectionsService({prisma})
.readAll(userId)`** that `Promise.all`s `findUnique` across all THREE tables
(`githubConnection`/`openRouterConnection`/`glooConnection`) → `{github, openrouter,
gloo}` rows-or-null. Independent of the three mutation services (reads the github
table directly, so it works whether or not the `github` dep is wired). Route maps
rows→DTOs. Wire shape `ConnectionsResponseSchema = {github, openrouter, gloo}` each
`<Status>|null`.

**Wire-name collision rule (task-11 rule, reconfirmed):** new db-lib DTOs are
`OpenRouterConnectionStatus` / `GlooConnectionStatus` (suffixed) — the bare
`OpenRouterConnection`/`GlooConnection` are re-exported Prisma model types and a
same-named wire type is silently dropped from the `export *` barrel. New DTOs (all
`src/schemas.ts`): `OpenRouterConnectRequest`, `OpenRouterConnectionStatus`,
`OpenRouterCreditsResponse`, `OpenRouterConnectionResponse`,
`OpenRouterDisconnectResponse`, `GlooConnectRequest`, `GlooConnectionStatus`,
`GlooConnectionResponse`, `GlooDisconnectResponse`, `ConnectionsResponse`. Barrel
collision guarded by `src/connection-schemas.test.ts` (`import * as DbLib`).

**Data model already migrated (task 4) — NO migration.** `OpenRouterConnection`
{userId@id, apiKeyCiphertext, keyLast4, status, connectedAt} · `GlooConnection`
{userId@id, clientId, clientSecretCiphertext, status, connectedAt, lastVerifiedAt}.
e2e reads the raw rows and asserts ciphertext ≠ plaintext + decrypt round-trips +
exact column set.

**Gloo stub gained a verify-FAILURE seam (root repo `tests/stubs/src/gloo-stub.ts`):**
reserved sentinel clientId `gloo-invalid` → `401 {error:"invalid_client"}` (rejected
before minting, `tokensIssued` unchanged), mirroring the youversion invalid-token
fixtures — the ONLY way well-formed input can fail verify (the stub otherwise
accepts any Basic creds). Needed because the API always sends well-formed Basic +
`client_credentials`. **OpenRouter stub UNCHANGED** (its `/api/v1/credits` has
existed since task 9). `global-setup.ts` extended: spawn+probe openrouter-stub
(health only) + gloo-stub (health + sentinel-401 STALENESS probe so a pre-task-12
image is rebuilt), both added to the reuse gate + `compose up --build` list.

**e2e ran IN-PROCESS** (`tests/e2e/connections.e2e.ts`, real Postgres + real
containerized openrouter/gloo stubs, real 64-hex key generated in the test) per
[[in-flight-dblib-e2e-constraint]]. Root `stub-*.e2e.ts` sentinel + containerized
full-stack DEFERRED to the db-lib submodule bump; covered meanwhile by the root
`tests/unit/stub-gloo.test.ts` sentinel case + the in-process API e2e.

**Final green:** db-lib 151 unit (+12) + typecheck; API 122 unit / 121 pass (+38,
6 new files + 4 env tests) + 8 e2e (18 full suite) + typecheck; root 65 unit (+1).
**Pre-existing RED (NOT ours):**
`src/dockerfile-database-lib-pin.test.ts` fails on committed v0.0.13 — Dockerfile
`ARG DATABASE_LIB_REF=5a1766d2…` vs submodule gitlink `684d14bb…`. Confirmed via
`git status` we touched neither; it's the in-flight ARG↔submodule drift the release
"bump submodule + update ARG" step reconciles (see [[in-flight-dblib-e2e-constraint]]
/ [[nodejs-api-bootstrap]] guardrail). Left uncommitted (later step bumps + pushes).
