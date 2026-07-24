---
name: task-34-e6-youversion-signin-e2e-rework
description: 34-E6 reworked the api YouVersion sign-in e2e to zero-egress seed mechanics + added the loud-skip live-userinfo spec; discovered the REAL sign-in is JWT-claims-based (shipped verifier's userinfo GET contract is known-wrong)
metadata:
  type: decision
---

Task 34-E6 (api-only, design-delta §10.4b) reworked the YouVersion **sign-in** e2e surface.
Pure test-surface work — **ZERO application-code changes** (task 10/34-E2 already shipped the
verifier's injectable `fetchImpl` seam, the route's `UnauthorizedError→401` map, and
AuthService's `verifyToken→null ⇒ UnauthorizedError`). Scope was sign-in/userinfo only; the
Data-Exchange/passage client is 34-E5 (dbos, done, separate).

**What was built (all in `supagloo-nodejs-api`):**
- `tests/e2e/auth.e2e.ts` reworked to **zero YouVersion egress**: deleted its
  `YOUVERSION_STUB_URL` fallback constant, the `makeYouVersionVerifier` stub wiring + import,
  and the two stub-dependent sign-in tests (the `yv_${accessToken}` magic-mapping create/update
  test and the `"yv-access-invalid"` sentinel-401 test). Now wires AuthService with a verifier
  that **THROWS if ever invoked** (structurally enforces zero egress) and tests only
  session/bearer mechanics via `/v1/test/seed` (seed → `/v1/me` → onboarding PATCH → signout →
  401-on-revoked). 2 tests, green.
- **NEW loud-skip convention** — `src/testing/youversion-live-e2e.ts`:
  `resolveYouVersionLiveGate(env)` → `{enabled, token, skipWarning}`. Mirrors
  `resolveConnectionSeedCreds` (pure, env-injectable, test-only → dist-excluded via
  `tsconfig.build.json` `src/testing/**`). Blank/whitespace token = absent. This is the FIRST
  "skip loudly" helper in the codebase (every other e2e secret THROWS/fail-fast §10.8);
  `YOUVERSION_E2E_ACCESS_TOKEN` is the SOLE §10.8-permitted skip. Unit-tested in
  `youversion-live-e2e.test.ts`.
- `tests/e2e/auth-live-youversion.e2e.ts` — the optional live spec. Boots the app in-process
  with a REAL verifier at `YOUVERSION_BASE_URL` (default real host, no stub), drives real
  `POST /v1/auth/youversion` with the token, asserts STRUCTURAL facts only (session minted,
  `/v1/me` authorizes, userinfo fields are non-empty strings — never fixed values).
  `describe.skipIf(!gate.enabled)` + a module-level `console.warn(gate.skipWarning)` → skips
  LOUDLY (verified: warning lands on stderr prefixed `stderr | …`, verbose reporter shows `↓`
  the named test). Even with the real-provider `.env` sourced it skips (that `.env` has no
  `YOUVERSION_E2E_ACCESS_TOKEN`).
- `src/auth/youversion.test.ts` +7 edge cases pinning the SHIPPED (invented) userinfo contract:
  numeric-id→String transform, no-names→displayName=email + email-derived initials,
  first-name-only→single initial, trailing-slash baseUrl normalization, missing-email→throws,
  non-JSON-200→throws, 403→throws (only 401→null). All green on first run (characterization; no
  verifier bug found).

**KEY DISCOVERY (the design's "check refresh tokens at implementation time" investigation) —
the shipped verifier's contract is KNOWN-WRONG.** Verified 2026-07-23 against
`developers.youversion.com/sign-in-apis` (updated ~2026-07): the real "Sign in with YouVersion"
is **JWT-claims-based, with NO `GET /auth/v1/userinfo` endpoint**. Token endpoint
`POST https://api.youversion.com/auth/token` → `{access_token, token_type:"Bearer",
expires_in:"3599", refresh_token, id_token, scope}`. Identity is read from **JWT claims** on the
access/id token: `yvp_id`/`sub` (user id), `email`, `name` (display), `profile_picture`
(avatar). JWKS at `/.well-known/jwks.json`. **Refresh tokens ARE issued; access tokens expire
~1h.** But `src/auth/youversion.ts` (task 10, untouched here) implements an INVENTED
`GET {base}/auth/v1/userinfo` returning `id/first_name/last_name/email/avatar_url`. Consequences,
flagged NOT fixed (out of 34-E6's test-rework scope; §10.4b explicitly accepts the contract as
unproven, and a JWT/JWKS verifier rewrite is security-sensitive, needs design sign-off, and
can't be verified without a real token):
1. Setting a real `YOUVERSION_E2E_ACCESS_TOKEN` today would make the live spec FAIL at the
   nonexistent userinfo endpoint until a follow-up rewrites the verifier to decode+verify JWT
   claims. The spec is honest about this (loud caveat comment) and skips by default.
2. The design's "prefer a stored refresh token" preference now applies concretely: the e2e
   secret should become `YOUVERSION_E2E_REFRESH_TOKEN` + a mint step in global-setup (access
   tokens live ~1h). Kept the `YOUVERSION_E2E_ACCESS_TOKEN` var for now (§10.4b/§10.8 name it;
   already in `.env.example`). → candidate for the existing **task-55** YouVersion
   production-readiness follow-up.

**Scope decision — `tests/e2e/global-setup.ts` left UNTOUCHED.** It spins up the `youversion-stub`
+ probes its `/auth/v1/userinfo` staleness route, shared by ALL api e2e; `connections.e2e.ts` +
`ai-generations.e2e.ts` still construct AuthService with `makeYouVersionVerifier({baseUrl:
YOUVERSION_STUB_URL})` (never invoked, just to satisfy the ctor). Wholesale stub teardown is
**task 34-E8**. So "delete the stub fallback" was scoped to `auth.e2e.ts` only. Confirmed no
regression: connections + ai-generations e2e still 24/24 green (secrets sourced from
`supagloo-nodejs-api/.env`, real hosts).

**Verification:** 330 unit green + typecheck clean; e2e auth 2/2 + live 1 skipped-loud +
connections/ai-generations 24/24 green. Full stack was already up (reuse-or-spawn).

See [[task-34-e5-youversion-real-api]], [[auth-and-sessions-built]],
[[e2e-test-infra-conventions]], [[e2e-secrets-gloo-naming-collision]],
[[api-e2e-real-provider-connection-seeding]].
