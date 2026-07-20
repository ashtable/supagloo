---
name: bff-foundation-nextjs-built
description: Task 23 built the first BFF layer in supagloo-nextjs — app/api/** route handlers, httpOnly session cookie, generic bearer proxy, server-driven onboarding gate, and the extended ?seed= Stagehand seam
metadata:
  type: convention
---

Built 2026-07-20 (plan task 23). First-EVER `app/api/**/route.ts` handlers in
`supagloo-nextjs`. TDD plan: `scratch/task-23-bff-foundation-nextjs.md`.

**Adds a server session layer ON TOP of the unchanged YouVersion OAuth.** Routes:
`POST/DELETE /api/auth/session` (exchange YV access token → API
`POST /v1/auth/youversion` → set httpOnly cookie; DELETE = best-effort
`/v1/auth/signout` + clear cookie), `GET /api/me`, `PATCH /api/me/onboarding`,
`POST /api/test/seed` (the seam). All built on ONE generic
`forwardToApi({path,method,token,body,fetchImpl})` in `lib/api/proxy.ts` — forwards
the cookie's raw token as `Authorization: Bearer` to `${SUPAGLOO_API_URL}/v1/<path>`,
passes status+body+errors through, and returns `{status:502,body:{error:"upstream_unreachable"}}`
on a dead upstream (NEVER throws). Tasks 24/25 reuse this proxy verbatim.

**db-lib is NOT imported here** — this repo's db-lib submodule is pinned at the
Task #7 SHA (`a01557a`), which PREDATES the auth DTOs, so `AuthUserSchema` etc.
don't exist in this checkout. Wire shapes are HAND-ROLLED in `lib/api/contracts.ts`
(verified live against the running API). Rationale: bumping the submodule is a
separate orchestration step AND would drag a full Prisma client into a Next.js BFF
(wrong altitude). If a future task needs shared DTOs, bump the submodule first.
`zod` moved devDeps → deps (runtime use in route handlers).

**Cookie** (`lib/api/cookies.ts`): name `supagloo_session`, value = RAW opaque
bearer token, `httpOnly`, `sameSite:lax`, `path:/`, `secure` ONLY in production,
`maxAge=2592000` (30d, mirrors the API's sliding session TTL). Verified live:
`set-cookie: supagloo_session=…; Max-Age=2592000; HttpOnly; SameSite=lax`.

**Onboarding is now SERVER-DRIVEN** (retired the localStorage `hasOnboarded`
stopgap). `lib/session/session-model.ts` `resolveSession` now takes `serverUser`
(not `onboardedRaw`); `hasOnboardedFromServer(user)` = `onboardingCompletedAt !== null`.
Precedence: `?mock=` override → serverUser → YV-authed-pre-exchange → signed out.
Removed `onboardingStorageKey`/`hasOnboardedFromRaw`.

**Two session modes in `SessionProvider`** (the "extend, don't replace" rule):
- **mock mode** (`?mock=` + `NEXT_PUBLIC_SUPAGLOO_DEMO=1`) = pure client, ZERO
  network, in-memory onboarding — UNCHANGED so all pre-existing pure-UI e2e specs
  stay green.
- **real/seed mode** = bootstrap effect hits the BFF: `?seed=` → `POST /api/test/seed`
  → `GET /api/me`; YV-authed → `POST /api/auth/session`; else probe `GET /api/me`.
  `markOnboarded()` → `PATCH /api/me/onboarding`. Failures degrade to signed-out
  (never throw), so signed-out pages are unaffected by API state. Wizard-flash
  guard: `firstSignIn = computeFirstSignIn(session) && (mockMode || serverUser!=null)`.

**Extended Stagehand seam = NEW `?seed=<scenario>` param** (distinct from `?mock=`
so mock stays pure). `POST /api/test/seed` is double-gated `testSeedEnabled`
(`NODE_ENV!=='production' && SUPAGLOO_ENABLE_TEST_SEED==='1'`) → hard-404 otherwise,
mirroring the API. It maps scenario → deterministic `TestSeedRequest` (distinct
identities, e.g. authed-fresh = "Grace Hopper"/onboardingCompleted:false + a fresh
random sessionToken) and sets the real cookie. **Verified API seed UPDATE
semantics** (auth-service.ts): `onboardingCompleted:false`/omitted PRESERVES an
existing `onboardingCompletedAt` — this is what lets onboarding persist across a
fresh browser context. **e2e-repeatability GOTCHA:** a FIXED seed id accumulates
onboarding across runs, breaking the "first-time wizard" assertion on re-run — so
`buildTestSeedRequest` takes an optional `nonce` that suffixes the youversionUserId;
`tests/e2e/bff-session.e2e.ts` generates one `RUN_ID` per run, SHARED by both
browser contexts (context A = fresh user does the wizard; context B = new Stagehand
instance re-seeds the SAME user and sees NO wizard = server-side persistence).

**New env (both in gitignored `.env.local`; repo has no `.env.example`):**
`SUPAGLOO_API_URL` (server-only, default `http://localhost:4000`),
`SUPAGLOO_ENABLE_TEST_SEED` (mirrors the API gate).

**Running the real-stack e2e locally:** compose Postgres is already migrated;
run the PRE-BUILT API via `node dist/server.js` from `~/code/supagloo-nodejs-api`
with DATABASE_URL→compose PG, DBOS_DATABASE_URL→supagloo_dbos,
SUPAGLOO_ENABLE_TEST_SEED=1, + dummy github/s3/secrets env (all fail-fast-validated).
The seed path does NOT touch the YouVersion stub (seed upserts directly). See
[[auth-and-sessions-built]] for the API contracts consumed.
