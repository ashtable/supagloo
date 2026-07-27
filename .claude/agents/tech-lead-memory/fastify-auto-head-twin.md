---
name: fastify-auto-head-twin
description: Fastify auto-registers a HEAD twin for every GET, and it fires the onRoute hook — so any route-inventory test that asserts an exact set of routes must filter HEAD or it asserts Fastify's defaults.
metadata:
  type: convention
---

Observed 2026-07-26 while writing `src/routes/gallery.test.ts`'s registration contract.

Fastify's `exposeHeadRoutes` defaults to **true**, so every `r.get(...)` silently registers a
second route: `HEAD <same url>`. The twin is a COPY of the GET's options — same `schema`, same
`preHandler` — and it **fires the `onRoute` hook like any other route**.

Consequence for the route-inventory idiom in this repo (capture routes via
`app.addHook("onRoute", …)`, then assert the exact set of `METHOD url` keys and each route's
`response` map): a suite that expects N routes for N declarations will see N + (number of GETs)
and fail with phantom `HEAD /…` entries. The gallery suite expected 7 and saw 10.

**The fix is in the capture, not the app**: skip `HEAD` in the hook. Do NOT reach for
`exposeHeadRoutes: false` — the twin is standard, harmless, carries the same authorization as its
GET, and is true of every other route in this service, so disabling it for one module would make
that module inconsistent to buy nothing.

```ts
const method = Array.isArray(r.method) ? r.method.join(",") : String(r.method);
if (method === "HEAD") return;   // Fastify's auto twin — same schema, same preHandler
```

Note the twin also means a no-auth GET has a no-auth HEAD. That is fine (identical
authorization), but worth stating explicitly when the GET is deliberately public — e.g.
`GET /v1/gallery/:id/stream-url` also answers HEAD, unauthenticated.

See [[gallery-backend-built]] for the suite this surfaced in.
