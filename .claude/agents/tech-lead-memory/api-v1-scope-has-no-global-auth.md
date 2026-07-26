---
name: api-v1-scope-has-no-global-auth
description: The api's /v1 Fastify scope does NOT globally require auth — bearerAuthPlugin only decorates, so a public route inside /v1 needs no new plumbing (just omit preHandler). Corrects a common misreading of current-design §2.5.
metadata:
  type: constraint
---

Verified 2026-07-25 by reading `/Users/ash/code/supagloo-nodejs-api/src/app.ts:195-243`
and `src/auth/bearer-auth.ts`.

`bearerAuthPlugin` is wrapped in `fastify-plugin` and its body does **three things only**:

```ts
app.decorateRequest("authUser", null);
app.decorateRequest("authSession", null);
app.decorate("requireAuth", requireAuth);   // a preHandler, NOT a hook
```

It registers **no `onRequest`/`preHandler` hook on the instance**. Auth is opt-in
**per route** via `preHandler: app.requireAuth`. Two shipping public-inside-`/v1`
precedents prove it: `POST /v1/auth/youversion` (`src/routes/auth.ts`) and
`POST /v1/test/seed` (`src/routes/test-seed.ts`), both registered with `schema` only.

**Consequence:** a genuinely public `/v1` route (e.g. the public gallery listing,
design-delta §8's one carve-out from bearer auth besides `/healthz`) needs **no new
mechanism, no second scope, and no unversioned registration** — just omit `preHandler`.
`current-design.md` §2.5's route inventory records only "bearer-authed `/v1` routes +
`/healthz`", which reads like a structural guarantee; it is not one.

**`optionalAuth` NOW EXISTS — shipped 2026-07-26 (task 39).** Until then `requireAuth` was
the only decorator and it 401s on a missing token, so "resolve the viewer if a token is
present, otherwise continue anonymously" had no seam. It was added as a second decorator on
the **same** plugin (a second plugin would re-run `decorateRequest("authUser", …)`, which
Fastify throws on, and would duplicate `parseBearer`). Its contract is
resolve-if-present/never-401: no header and a malformed header both continue anonymously
**without a session lookup**, a valid token sets `authUser`/`authSession`, and a
present-but-invalid token **degrades to anonymous rather than 401-ing** — the BFF forwards
whatever cookie is present, so 401-ing a stale one would hand an error page to exactly the
population most likely to hold one. `GET /api/me` is the session-truth endpoint; a public
route is not.

Note when adding it: `authService.authenticate()` also performs the sliding-expiry bump,
so it fires for signed-in viewers of public routes too (correct — the viewer is active),
and handlers must read `req.authUser?.id ?? null`, never the `!` assertion the authed
routes use.

**TDD TRAP, observed red-phase on 2026-07-26 — an `optionalAuth` test suite goes GREEN
against a plugin that never grew the decorator.** Fastify treats
`{ preHandler: undefined }` as *no preHandler at all*, so `preHandler: app.optionalAuth`
on a missing decorator silently registers an unhooked route — and an unhooked route
produces exactly the anonymous outcome the "no header" / "malformed header" /
"present-but-invalid token" cases assert. Three of four cases passed with zero
implementation; only "valid token resolves the user" failed. Any test builder that wires
`app.optionalAuth` must first assert `typeof app.optionalAuth === "function"` and throw,
or the red phase proves nothing. The same hazard applies to **any** future decorated
preHandler seam in this repo, and to the structural per-route auth check
(`src/routes/gallery.test.ts`'s `U-GR11b`), which distinguishes `none` from `optional`
only by identity comparison against the decorator.

See [[auth-and-sessions-built]] for the session/token model itself.
