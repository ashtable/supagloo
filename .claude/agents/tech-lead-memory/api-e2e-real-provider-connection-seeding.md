---
name: api-e2e-real-provider-connection-seeding
description: Task 34-E3 reworked api connections.e2e.ts to seed provider connections through its OWN real routes against LIVE OpenRouter/Gloo — the seeding-helper location, the fail-fast split, and the live-behavior facts
metadata:
  type: convention
---

Task 34-E3 (design-delta §10.2/§10.3) done 2026-07-23. Reworked
`supagloo-nodejs-api/tests/e2e/connections.e2e.ts` from stub-coupled to
**real-provider**: it seeds through the app's OWN connect routes with real env
creds, so no fabricated ciphertext/dummy key survives. Plan:
`scratch/task-34-e3-api-e2e-credential-seeding.md`. Builds on
[[openrouter-gloo-connections-built]] (task 12 routes, unchanged) +
[[e2e-secrets-gloo-naming-collision]] (34-E2 .env story) + [[e2e-test-infra-conventions]].

**Seeding helper `src/testing/seed-connections.ts`** (+ co-located
`seed-connections.test.ts`). MUST live under `src/` so its unit test runs in the
docker-free unit lane (`vitest.config.ts` includes `src/**/*.test.ts`, excludes
`tests/e2e/**`); `tests/e2e/helpers/` would NOT work (a unit test there is picked
up by neither lane). Added `src/testing/**` to `tsconfig.build.json` exclude so the
test-only helper is not shipped in `dist/` (typecheck via tsconfig.json still covers
it; vitest/tsx transpile on the fly). Exports: `resolveConnectionSeedCreds(env)`
(pure, fail-fast, names the missing var; empty/whitespace = missing),
`seedOpenRouterConnection`/`seedGlooConnection` (throw/abort on non-2xx),
`seedConnections` (resolve creds → OpenRouter → Gloo, abort on Gloo fail),
`CONNECTION_SEED_ENV_VARS`. `fetchImpl`+`env` injectable → the two required unit
failure modes (missing-secret pre-network; Gloo-verify-fail aborts, no swallow) test
with zero network.

**Fail-fast is in the HELPER, not global-setup.ts** (the 34-E2 split:
34-E3/E4 = seeding-helper fail-fast; **34-E8** = global-setup stops defaulting
provider vars to stub ports + its own fail-fast). e2e `beforeAll` calls
`resolveConnectionSeedCreds()` → a missing secret fails THAT suite loudly (8 tests
skipped + suite FAILED, never a silent green). **Deliberately did NOT touch
global-setup.ts** even though the Step-5 note said to repoint its L31-33: those
constants feed only the `openrouterStubReady`/`glooStubReady` probes; repointing at
real hosts breaks the reuse-or-spawn gate — that teardown is 34-E8's. Only the
SPEC's own base-URL constants were repointed:
`OPENROUTER_BASE_URL ?? "https://openrouter.ai"` /
`GLOO_BASE_URL ?? "https://platform.ai.gloo.com"` (drop the `*_STUB_URL` fallback).
Transitional: the compose stack still spins up the now-unused openrouter/gloo stubs
until 34-E8.

**Live-behavior facts (real creds, 2026-07-23):** `GET openrouter.ai/api/v1/credits`
→ `{data:{total_credits,total_usage}}` (matches the task-12 Zod parse). Gloo token
mint `POST platform.ai.gloo.com/oauth2/token` (client_credentials + Basic): valid →
**200**; real clientId + last-char-flipped secret → **400**
`{error:"invalid_client",error_description:"invalid_client_secret"}` (a clean 4xx →
`gloo-client` false → route 400). So the verify-failure test = real registered
`GLOO_CLIENT_ID` + mangled `GLOO_CLIENT_SECRET`, NOT the retired `gloo-invalid`
stub sentinel. Credits assertion is STRUCTURAL (numbers + `remaining ===
totalCredits − totalUsage`), never fixed balances.

**GOTCHA — vitest does NOT auto-load `.env`.** The api e2e reads real secrets from
`process.env`; run real-provider e2e as `set -a; . ./.env; set +a; npm run test:e2e`.
`DATABASE_URL` is NOT in `.env` (falls back to the compose default).

**Green (2026-07-23):** api unit 319/319 (10 new helper tests), typecheck + build
clean (dist/testing absent), full e2e 62/62 (connections 8 live). Only edits:
`connections.e2e.ts`, `tsconfig.build.json`, new `src/testing/`.
