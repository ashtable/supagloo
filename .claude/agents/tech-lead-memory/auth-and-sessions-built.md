---
name: auth-and-sessions-built
description: Task 10 (M2) built auth & sessions in supagloo-nodejs-api — opaque DB-backed sessions, SHA-256 token hash, sliding expiry, bearer plugin, the /v1 prefix, the invented YouVersion userinfo contract, and the flag-gated hard-404 seed endpoint
metadata:
  type: convention
---

Built 2026-07-18 (plan task 10). First auth surface + first `/v1` routes in
`supagloo-nodejs-api`. TDD plan: `scratch/auth-and-sessions.md`.

**Session model = opaque, DB-backed (design-delta §9-Q6, NOT JWT).** Raw bearer
token = `randomBytes(32).toString("base64url")` (returned once); DB stores only
`Session.tokenHash = SHA-256 hex`. **Sliding expiry**: every authenticated use
bumps `lastUsedAt` + `expiresAt = now + SESSION_TTL_MS` (30d). Signout
**deletes** the row (synchronous revocation — the whole reason it's not a JWT).
Primitives in `src/auth/tokens.ts` (`generateSessionToken`/`hashToken`/
`slidingExpiry`/`isExpired`), pure + unit-tested.

**`firstSignIn` via findUnique-then-branch, NOT Prisma `upsert`** — `upsert`
can't report created-vs-updated, which is exactly what the transient `firstSignIn`
flag needs. `signIn`: verify → `user.findUnique({youversionUserId})` → create
(set `firstSignInAt=now`, `firstSignIn=true`) or update (`firstSignIn=false`).
The create is wrapped to catch a duck-typed **P2002** (`err.code==="P2002"`, no
Prisma error-class import — the query-compiler client shapes it differently) and
fall back to update, so a concurrent first-signin race degrades gracefully.

**All auth logic is in one `AuthService`** (`src/auth/auth-service.ts`,
constructed with `{prisma, verifyToken, clock?, sessionTtlMs?}`): `signIn`,
`authenticate` (hash→findUnique(include user)→expiry check→bump), `signOut`,
`completeOnboarding`, `seed`. Injectable clock + verifier + a fake-`PrismaClient`
(cast `as unknown as PrismaClient`) make every branch unit-testable with zero DB.

**Bearer plugin** (`src/auth/bearer-auth.ts`): `fastify-plugin`-wrapped so its
`requireAuth` preHandler decorator is visible to sibling route registrations;
decorates `request.authUser`/`authSession`; 401s missing/malformed/garbage/
expired. Protected routes add `{preHandler: app.requireAuth}`.

**The `/v1` prefix is established here** (design-delta §8): `buildApp({auth})`
registers an encapsulated plugin at `prefix:"/v1"` that registers the bearer
plugin then the routes. `buildApp()` with no `auth` stays health-only (keeps the
task-8 health tests working). server.ts builds the real Prisma-backed
`AuthService` + `makeYouVersionVerifier` and passes `auth`. Routes:
`POST /v1/auth/youversion` (public), `GET /v1/me`, `PATCH /v1/me/onboarding`,
`POST /v1/auth/signout` (bearer), `POST /v1/test/seed` (gated).

**Seed endpoint hard-404 (§9-Q9)** = **not registering the route** when the gate
fails (`NODE_ENV!=="production" && SUPAGLOO_ENABLE_TEST_SEED==="1"`), so Fastify's
own not-found handler answers — a true 404, never a 401/403 that would leak the
route. New env var `SUPAGLOO_ENABLE_TEST_SEED` is a **raw string** (not coerced),
enforced as `=== "1"`. seed upserts user (by youversionUserId) + session (by
tokenHash) idempotently; the caller-supplied `sessionToken` bearer-auths
immediately — the deterministic-session seam every later e2e uses.

**Wire DTOs live in `database-lib/src/schemas.ts`** (first request/response DTOs
there; all prior are domain/content). Naming: `*Schema` const + bare inferred
type, auto-exported by `export * from "./schemas"`. **The wire user is `AuthUser`,
NOT `User`** — the Prisma `User`/`Session` model *types* are re-exported via
`export * from generated/prisma`, so a `User` wire type would collide. Dates are
ISO strings on the wire; `src/auth/dto.ts` `toAuthUser()` maps Prisma row→wire.

**Invented YouVersion userinfo contract** (design-delta §6a left it open — the
only place it's written down is `scratch/auth-and-sessions.md §0`):
`GET {YOUVERSION_BASE_URL}/auth/v1/userinfo` with the forwarded access token as
`Authorization: Bearer`; 200 `{id, first_name, last_name, email, avatar_url}`,
401 `{error:"invalid_token"}`. API maps id→youversionUserId, names→displayName +
`avatarInitials`. The Task-9 youversion stub (`tests/stubs/src/youversion-stub.ts`)
implements it deterministically: fixtures (`yv-access-ada`→id `yv-user-1001`),
an invalid set (`yv-access-invalid`/`-expired`→401), and a fallback that DERIVES
a stable user from any other token (`id="yv_"+slug`) so tests drive
create-vs-update without fixtures. See [[in-flight-dblib-e2e-constraint]] for why
the auth e2e runs in-process, not against the containerized API.
