---
name: bound-is-not-safe-postgres-value-gates
description: A bound Prisma parameter can still 500 — Date.parse is not Postgres's timestamptz parser, a NUL is not a valid text value, and an unsafe integer breaks the RESPONSE serializer; validate VALUES at the codec, and add a setErrorHandler so the leak class is closed.
metadata:
  type: constraint
---

Closed 2026-07-26 in `/Users/ash/code/supagloo-nodejs-api` (branch `v0.0.38`), after an
adversarial audit of the gallery rows 39/40 REFUTED that surface's own claim that a forged cursor
could only ever be a 400. Four defect classes, ten reproducible **unauthenticated 500s** on
`GET /v1/gallery`, each replying with the Prisma error code, the SQLSTATE and the offending
literal. Every one of them went through a **bound parameter**.

## The rule

**Parameterised ≠ safe.** A bound parameter still has to be a value the target type accepts. SQL
injection was genuinely unreachable (verified) and that told us nothing about whether Postgres
would take the value. Three separate failure surfaces, all reached by a well-formed request:

| gate | what leaked | SQLSTATE |
|---|---|---|
| `!Number.isNaN(Date.parse(k))` as a proxy for `::timestamptz` | `"2026"`, `"Jan 2000"`, `"2020-02-30T00:00:00Z"`, V8's `Date#toString`, `"-271821-04-20T…"` | 22007 / 22008 / 22009 |
| nothing rejecting control chars in a free-text `q` | `q=%00` — one query param, no cursor, no session | 22021 |
| `Number.isInteger` where a sibling check used `Number.isSafeInteger` | `n=MAX_SAFE_INTEGER` → the **response** serializer, not Postgres | `FST_ERR_RESPONSE_SERIALIZATION` |

## Never use `Date.parse` as a stand-in for a database's date parser

V8's parser is far more permissive than Postgres's. Write the GRAMMAR instead — a strict ISO-8601
instant `YYYY-MM-DDTHH:MM:SS[.f{1,6}](Z|±HH:MM)` with the calendar fields checked
**arithmetically**, because `Date.UTC(2020, 1, 30)` silently rolls over to March 1st, so a
round-trip-through-`Date` check accepts February 30th. `isStrictIsoInstant` in
`src/gallery/gallery-query.ts` is the implementation.

Then **sweep the grammar's own extremes against the real database**, because the first strict
grammar still had two holes the audit had not found:

- `0000-01-01T00:00:00Z` → **22008**. Postgres's proleptic calendar has no year zero (1 BC, not 0).
- `2026-07-26T12:00:00+16:00` → **22009** `time zone displacement out of range`. Postgres tolerates
  ±15:59; the shipped bound is the tighter ±14:00 (ISO-8601's own limit, and larger than every real
  zone — Line Islands is exactly +14:00).

A four-digit year is load-bearing twice: it rejects V8's ±six-digit expanded years, which are legal
JS instants and outside `timestamptz`'s range.

## AMENDED 2026-07-26 (same day, round 2): this pass MOVED the gap, it did not close it

The three gates above were written PER FIELD, and a fourth field of the same cursor (`i`), the
`:id` param of every route in the api, and three of the publish body's four strings were still
500s. Read [[one-rule-one-module-many-boundaries]] before touching any of this — the rule now
lives in ONE module (`src/postgres-text.ts`) and the `q` control-char check moved to BEFORE
`.trim()`, because `trim()` also strips VT/FF and `?q=%0B` was answering a 200 match-everything
listing. The table below is round 1's history; it is no longer the whole gate.

## Reject, do not repair

Stripping the control characters from `q` would make `q=%00` behave exactly like a BLANK `q` — a
match-everything listing handed back in answer to a hostile input — and truncating an over-long `q`
returns hits for a prefix of what the caller sent. Both make the response a lie about what was
searched. 400 with a distinct slug (`invalid_query`, separate from `invalid_cursor`, because they
are fixed by different client changes).

## The `setErrorHandler` this repo now has

`src/error-handler.ts`, registered on the ROOT instance in `buildApp` so every scope inherits it.
Until this date the api had NONE, which is why the leaks were verbatim. The rule:

- `err.validation`, or an explicit `statusCode` in 400…599 **except 500** ⇒ `reply.send(err)`,
  which delegates to Fastify's default handler and reproduces the existing body **byte-for-byte**
  (measured — half a dozen route suites assert those bodies).
- everything else ⇒ log the full error, reply `{error:"internal_error", message:"an unexpected
  error occurred"}`. `statusCode === 500` is included: 500 means "unclassified", so its message can
  never be a contract, and `FST_ERR_RESPONSE_SERIALIZATION` is exactly this case.

**Deliberate behaviour change, and a good one:** Fastify's default handler prefers `error.status`
over `error.statusCode`, the trap documented at length in `connections/github-app-client.ts`. The
handler ignores `status` entirely, so an uncaught provider error can no longer dictate any status.
Prisma / AWS-SDK / Node errors carry no `statusCode`, so nothing accidental survives the filter.

It is DEFENCE IN DEPTH, not the fix. The route catches by class and chooses the status; the codec
rejects the value before any SQL exists. This handler only closes the CLASS of leak.

Related: [[gallery-backend-built]], [[vite-cache-poisons-mutation-testing]].
