---
name: e2e-secrets-gloo-naming-collision
description: task 34-E2 — the e2e provider-secrets .env.example story across root/api/dbos/nextjs + the nextjs Gloo naming-collision fix (GLOO_CONNECT_* for the app-under-test) + how §10.8's "fail fast" splits across dependents
metadata:
  type: decision
---

Task 34-E2 (design-delta §10.8) built the e2e provider-secrets documentation +
resolved the nextjs Gloo env naming collision. Done 2026-07-23.

**The nextjs collision, resolved.** In `supagloo-nextjs`, `GLOO_CLIENT_ID`/
`GLOO_CLIENT_SECRET` (+ `GLOO_STAGEHAND_MODEL`) configure **Stagehand's OWN LLM**
(the harness AI — `lib/gloo/llm-client.ts:10,46`). The **app-under-test's** Gloo
connect credentials (typed into the "Connect Gloo" form → `PUT /api/connect/gloo`)
now use the DISTINCT **`GLOO_CONNECT_CLIENT_ID`/`GLOO_CONNECT_CLIENT_SECRET`**.
Chosen because the feature is the Gloo *connect* flow; rejected `GLOO_APP_*`
(ambiguous), `GLOO_E2E_*`/`GLOO_TEST_*` (both sides are e2e-time). This is a
**nextjs-only** disambiguation — in api/dbos the app-under-test's Gloo creds are
just `GLOO_CLIENT_ID`/`GLOO_CLIENT_SECRET` (no Stagehand to collide with).
Consumed by task 35 / 34-E8 ("app-under-test Gloo creds use the distinct var names
from 34-E2"). See [[e2e-test-infra-conventions]].

**Resolution module.** `supagloo-nextjs/lib/gloo/harness-creds.ts` — pure
injectable env accessors (mirrors `lib/api/config.ts`): `resolveStagehandLlmCreds`
(reads `GLOO_CLIENT_*`+model), `resolveAppUnderTestGlooCreds` (reads
`GLOO_CONNECT_*`), each fail-fast on a missing var naming it. Exports the two
var-name constant arrays (`STAGEHAND_LLM_ENV_VARS`,
`APP_UNDER_TEST_GLOO_ENV_VARS`) as the single source of truth the `.env.example`
consistency unit test asserts against. `llm-client.ts` was NOT refactored onto it
(kept blast radius small; brief said leave it as-is). Tests:
`tests/unit/env-harness-creds.test.ts` (13 tests; nextjs `tests/unit/` had to be
created — it did not exist).

**Scope split of §10.8's "fail fast" requirement** (important — don't re-do in the
wrong task): 34-E2 = **docs + naming only**. The actual fail-fast wiring is
distributed across dependents — **34-E3/34-E4** do seeding-helper fail-fast (missing
secret → actionable error, injected fetch); **34-E8** makes api/dbos
`tests/e2e/global-setup.ts` stop defaulting provider vars to stub ports and fail
fast. 34-E2 does NOT edit any `global-setup.ts`. Distinct from task 43 (boot-time
`src/config/env.ts` Zod validation) — these four secrets are e2e-setup-time, NOT
app-boot config (Gloo/OpenRouter creds are per-user encrypted DB rows in prod).

**`.env.example` coverage** (each fail-fast-required except the optional token):
`OPENROUTER_E2E_TEST_API_KEY` (dedicated low-balance key, §10.3/§10.9),
`GLOO_CLIENT_ID`/`SECRET` (live-verifiable), `YOUVERSION_APP_KEY`, and the ONE
deliberately-optional `YOUVERSION_E2E_ACCESS_TOKEN` (§10.4b, loud-skip). Gaps fixed:
api was missing `YOUVERSION_APP_KEY`; all three backends missing
`YOUVERSION_E2E_ACCESS_TOKEN`; nextjs had **no `.env.example`** at all.

**nextjs `.gitignore` gap (fixed).** Its `.env*` glob had NO `!.env.example`
negation (api/dbos both did), so a new template would be silently ignored. Added
`!.env.example` at `.gitignore:39`. Verify committability with `git check-ignore
<file>` (exit 1 = not ignored) or `git status --porcelain` (`??`) — NOT
`git check-ignore -v`, whose printed negation line + exit code misleads.
